// Arbox (Peach and Power) auto-booker
//
// GitHub's free scheduled-cron trigger is "best effort" — it does NOT
// reliably fire every N minutes, especially for tightly-spaced schedules.
// So instead of relying on GitHub to wake this script up at the exact
// right second, the design is:
//   - Cron runs hourly (reliable enough at that cadence).
//   - Each run checks: is any configured class's registration window
//     opening within the next ~5.5 hours? If not, exit immediately.
//   - If yes, THIS run internally sleeps (via the script's own clock,
//     not GitHub's scheduler) until the exact opening moment, then
//     hammers the booking endpoint every ~1.5s until it succeeds.
//
// This means timing precision comes from code we fully control, not from
// GitHub's queue — an hourly check just needs to catch each class once,
// at any point up to ~5.5h before it opens, to lock in a precise wait.

import { DateTime } from "luxon";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMEZONE = "Asia/Jerusalem";
const API_BASE = "https://apiappv2.arboxapp.com/api/v2";

// How far ahead we'll commit to a long internal sleep-and-wait for a
// window in a single run. Must comfortably fit under the GitHub Actions
// hosted-runner hard limit of 6h (360min) once setup/retry time is
// accounted for, and must be wider than the cron interval (hourly) so
// nothing can fall through the gap between two runs.
const LOOKAHEAD_MINUTES = 330; // 5.5 hours
const CATCHUP_MINUTES = 15; // handle windows that opened shortly before this run started

// How long/hard to retry once we're at (or past) the opening moment.
const RETRY_WINDOW_MS = 90_000;
const RETRY_INTERVAL_MS = 1_500;

function getEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function loadConfig() {
  const path = join(__dirname, "..", "config", "classes.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "accesstoken": getEnv("ARBOX_ACCESS_TOKEN"),
    "refreshtoken": getEnv("ARBOX_REFRESH_TOKEN"),
    "whitelabel": "PeachAndPower",
    "referername": "app",
  };
}

// Turn a recurring {weekday, time, className} entry into the next concrete
// calendar date that class falls on (today included, if its time hasn't
// passed yet).
function nextDateForWeekday(weekdayName, time) {
  const weekdays = [
    "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
  ];
  const targetIdx = weekdays.indexOf(weekdayName.toLowerCase());
  if (targetIdx === -1) {
    throw new Error(`Invalid weekday in config: ${weekdayName}`);
  }
  const now = DateTime.now().setZone(TIMEZONE);
  // Luxon: Monday=1 ... Sunday=7
  let diff = (targetIdx + 1) - now.weekday;
  if (diff < 0) diff += 7;

  let candidate = now.plus({ days: diff });

  // If today IS the target weekday but that class's time has already
  // passed today, this week's occurrence is over — roll to next week
  // instead of pointlessly targeting a class that already happened.
  if (diff === 0 && time) {
    const [h, m] = time.split(":").map(Number);
    const todayClassTime = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (now > todayClassTime) {
      candidate = candidate.plus({ days: 7 });
    }
  }

  return candidate.toFormat("yyyy-MM-dd");
}

// Resolve every config entry (recurring + one-off) into a concrete
// {date, time, className} for this run.
function resolveTargets(config) {
  const targets = [];
  for (const r of config.recurring ?? []) {
    targets.push({
      date: nextDateForWeekday(r.weekday, r.time),
      time: r.time,
      className: r.className,
      label: `recurring ${r.weekday} ${r.time} "${r.className}"`,
    });
  }
  for (const o of config.oneOff ?? []) {
    targets.push({
      date: o.date,
      time: o.time,
      className: o.className,
      label: `one-off ${o.date} ${o.time} "${o.className}"`,
    });
  }
  return targets;
}

async function fetchScheduleForDate(config, dateStr) {
  const res = await fetch(`${API_BASE}/schedule/betweenDates`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      from: dateStr,
      to: dateStr,
      locations_box_id: config.locationsBoxId,
      boxes_id: config.boxId,
    }),
  });
  if (!res.ok) {
    throw new Error(`betweenDates failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

function findMatch(schedule, target) {
  const wantName = target.className.trim().toLowerCase();
  return schedule.find((entry) => {
    const catName = (entry.box_categories?.name ?? "").toLowerCase();
    return (
      entry.date === target.date &&
      entry.time === target.time &&
      catName.includes(wantName)
    );
  });
}

async function attemptBooking(scheduleId) {
  if (process.env.DRY_RUN === "true") {
    console.log(`  [DRY RUN] Would send booking request for schedule_id ${scheduleId} now (not actually sent).`);
    return { success: true, dryRun: true };
  }

  const res = await fetch(`${API_BASE}/scheduleUser/insert`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      schedule_id: scheduleId,
      membership_user_id: Number(getEnv("ARBOX_MEMBERSHIP_USER_ID")),
      extras: { spot: null, invited_by: null },
    }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response, leave body null
  }

  if (res.ok) {
    return { success: true, body };
  }

  const tooEarly = body?.error?.messageToUser?.some(
    (m) => m.name === "registerScheduleDisabled"
  );

  return { success: false, tooEarly, status: res.status, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleTarget(config, target) {
  console.log(`Checking ${target.label} on ${target.date}...`);

  const schedule = await fetchScheduleForDate(config, target.date);
  const match = findMatch(schedule, target);

  if (!match) {
    console.log(
      `  No matching class found yet for ${target.label} (schedule may not be published far enough out). Skipping this run.`
    );
    return;
  }

  if (match.user_booked) {
    console.log(`  Already booked (schedule_id ${match.id}). Nothing to do.`);
    return;
  }

  // The class object itself carries its own registration-window length
  // (in hours). Trust this over any hardcoded assumption, since Arbox
  // does allow different windows per category.
  const registrationHours = match.enable_registration_time ?? 75;

  const classStart = DateTime.fromFormat(
    `${match.date} ${match.time}`,
    "yyyy-MM-dd HH:mm",
    { zone: TIMEZONE }
  );
  const opensAt = classStart.minus({ hours: registrationHours });
  const now = DateTime.now().setZone(TIMEZONE);

  if (now > classStart) {
    console.log(`  This occurrence (${classStart.toISO()}) has already happened. Skipping.`);
    return;
  }

  const minutesUntilOpen = opensAt.diff(now, "minutes").minutes;

  console.log(
    `  Matched schedule_id ${match.id}. Registration opens ${opensAt.toISO()} (in ${minutesUntilOpen.toFixed(
      1
    )} min).`
  );

  if (minutesUntilOpen > LOOKAHEAD_MINUTES) {
    console.log("  Not opening soon enough to act on this run. Skipping.");
    return;
  }
  if (minutesUntilOpen < -CATCHUP_MINUTES) {
    console.log("  Window opened a while ago and it's still unbooked — trying once as a catch-up attempt.");
  }

  if (minutesUntilOpen > 0) {
    const waitMs = opensAt.diff(DateTime.now().setZone(TIMEZONE)).as("milliseconds");
    console.log(`  Waiting ${(waitMs / 1000).toFixed(1)}s until the window opens...`);
    await sleep(Math.max(0, waitMs));
  }

  const deadline = Date.now() + RETRY_WINDOW_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const result = await attemptBooking(match.id);
    if (result.success) {
      console.log(
        result.dryRun
          ? `  ✅ [DRY RUN] Would have booked on attempt ${attempt} (schedule_id ${match.id}). No real request sent.`
          : `  ✅ Booked on attempt ${attempt}! schedule_id ${match.id}.`
      );
      return;
    }
    if (!result.tooEarly) {
      console.log(
        `  ❌ Booking failed (not a "too early" error) on attempt ${attempt}: HTTP ${result.status} ${JSON.stringify(
          result.body
        )}`
      );
      return;
    }
    console.log(`  Attempt ${attempt}: window not open yet, retrying...`);
    await sleep(RETRY_INTERVAL_MS);
  }
  console.log(`  ⏱️ Gave up after ${attempt} attempts — window never opened within the retry period.`);
}

async function main() {
  const config = loadConfig();
  const targets = resolveTargets(config);
  const results = await Promise.allSettled(
    targets.map((target) => handleTarget(config, target))
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`Error handling ${targets[i].label}:`, r.reason);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
