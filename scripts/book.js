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
const LOOKAHEAD_MINUTES = 330; // 5.5 hours — public repo has no Actions-minutes
                                // cap, so widen this back out for more buffer
                                // against GitHub's scheduling gaps.
const CATCHUP_MINUTES = 15; // handle windows that opened shortly before this run started

// How long/hard to retry once we're at (or past) the opening moment.
const RETRY_WINDOW_MS = 120_000;

// Stay under the workflow's 350-min timeout when re-aiming mid-run.
const RUN_START = Date.now();
const RUN_BUDGET_MS = 340 * 60_000;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cloudflare (in front of Arbox) answers with 429 when it rate-limits us, and
// with 52x/50x when the origin hiccups. These are momentary — worth retrying.
// NOTE: Arbox's OWN business-rule codes look like 5xx too (514 too early,
// 516 full, 518 membership) — those are NOT transient.
function isTransient(status, body) {
  return (
    body?.cloudflare_error === true ||
    status === 408 ||
    status === 429 ||
    [500, 502, 503, 504].includes(status) ||
    (status >= 520 && status <= 526)
  );
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
  let rawText = null;
  try {
    rawText = await res.clone().text();
    body = await res.json();
  } catch {
    // non-JSON response, leave body null
  }
  if (!res.ok) {
    console.log(`  Raw response (status ${res.status}): ${rawText}`);
  }

  if (res.ok) {
    return { success: true, body };
  }

  // Defensive: don't assume Arbox always sends messageToUser as an array —
  // be tolerant of unexpected shapes instead of crashing on them.
  const messages = Array.isArray(body?.error?.messageToUser)
    ? body.error.messageToUser
    : [];
  const tooEarlyMsg = messages.find((m) => m.name === "registerScheduleDisabled");
  const tooEarly = Boolean(tooEarlyMsg);
  // The server tells us the window it ACTUALLY enforces (e.g. "73 hours").
  const serverHours = Number(tooEarlyMsg?.value?.hours) || null;
  const alreadyRegistered = messages.some((m) => m.name === "alreadyRegistered");
  const transient = isTransient(res.status, body);
  const retryAfterMs = Math.min((Number(body?.retry_after) || 0) * 1000, 30_000);

  return {
    success: false, tooEarly, serverHours, alreadyRegistered,
    transient, retryAfterMs, status: res.status, body,
  };
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

  // Starting guess for the registration window, from the class data.
  // (The server's own answer below overrides this — the two can disagree.)
  let registrationHours = match.enable_registration_time ?? 75;

  const classStart = DateTime.fromFormat(
    `${match.date} ${match.time}`,
    "yyyy-MM-dd HH:mm",
    { zone: TIMEZONE }
  );
  if (DateTime.now().setZone(TIMEZONE) > classStart) {
    console.log(`  This occurrence (${classStart.toISO()}) has already happened. Skipping.`);
    return;
  }

  const minutesUntil = (hours) =>
    classStart.minus({ hours }).diff(DateTime.now().setZone(TIMEZONE), "minutes").minutes;

  console.log(
    `  Matched schedule_id ${match.id}. Class data says registration opens ${classStart
      .minus({ hours: registrationHours })
      .toISO()} (in ${minutesUntil(registrationHours).toFixed(1)} min).`
  );

  // Ask the server once, up front. If it's already open we book right now; if
  // it's too early the rejection states the real window, which we trust over
  // the class data (seen in production: data implied 74h, server enforced 73h,
  // so the script woke an hour early and burned its retry window).
  let probe = null;
  try {
    probe = await attemptBooking(match.id);
  } catch (err) {
    console.log(`  Probe errored (continuing with class-data window): ${err.message}`);
  }
  if (probe?.success) {
    console.log(
      probe.dryRun
        ? `  ✅ [DRY RUN] Probe indicates this is bookable right now (schedule_id ${match.id}).`
        : `  ✅ Booked on the up-front probe! schedule_id ${match.id}.`
    );
    return;
  }
  if (probe?.alreadyRegistered) {
    console.log("  Server says already registered. Nothing to do.");
    return;
  }
  if (probe?.tooEarly && probe.serverHours) {
    if (probe.serverHours !== registrationHours) {
      console.log(
        `  Server enforces a ${probe.serverHours}h window (class data said ${registrationHours}h) — using the server's.`
      );
    }
    registrationHours = probe.serverHours;
  } else if (probe && !probe.tooEarly && !probe.transient) {
    const msg = `Unexpected response for ${target.label}: HTTP ${probe.status} ${JSON.stringify(probe.body)}`;
    console.log(`  ❌ ${msg}`);
    if (minutesUntil(registrationHours) <= LOOKAHEAD_MINUTES) {
      throw new Error(msg); // about to matter → red job + failure email
    }
    return; // far off: log it, don't spam alerts
  }

  let opensAt = classStart.minus({ hours: registrationHours });
  const minutesUntilOpen = minutesUntil(registrationHours);
  console.log(`  Registration opens ${opensAt.toISO()} (in ${minutesUntilOpen.toFixed(1)} min).`);

  if (minutesUntilOpen > LOOKAHEAD_MINUTES) {
    console.log("  Not opening soon enough to act on this run. Skipping.");
    return;
  }
  if (minutesUntilOpen < -CATCHUP_MINUTES) {
    console.log("  Window opened a while ago and it's still unbooked — trying as a catch-up attempt.");
  }

  if (minutesUntilOpen > 0) {
    const waitMs = opensAt.diff(DateTime.now().setZone(TIMEZONE)).as("milliseconds");
    console.log(`  Waiting ${(waitMs / 1000).toFixed(1)}s until the window opens...`);
    await sleep(Math.max(0, waitMs));
  }

  let deadline = Date.now() + RETRY_WINDOW_MS;
  let attempt = 0;
  let transientCount = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    let result;
    try {
      result = await attemptBooking(match.id);
    } catch (err) {
      console.log(`  ⚠️ Unexpected error on attempt ${attempt} (will keep retrying): ${err.message}`);
      await sleep(RETRY_INTERVAL_MS);
      continue;
    }
    if (result.success) {
      console.log(
        result.dryRun
          ? `  ✅ [DRY RUN] Would have booked on attempt ${attempt} (schedule_id ${match.id}). No real request sent.`
          : `  ✅ Booked on attempt ${attempt}! schedule_id ${match.id}.`
      );
      return;
    }
    if (result.alreadyRegistered) {
      console.log("  Already registered (another run got it). Nothing to do.");
      return;
    }
    if (result.transient) {
      // Rate-limited / origin hiccup: back off and keep trying rather than abort.
      transientCount += 1;
      if (transientCount > 6) {
        throw new Error(`Gave up after repeated rate-limit/server errors for ${target.label} (last: HTTP ${result.status})`);
      }
      const backoff = Math.max(result.retryAfterMs, Math.min(2000 * 2 ** transientCount, 30_000));
      console.log(`  Attempt ${attempt}: HTTP ${result.status} (transient) — backing off ${(backoff / 1000).toFixed(0)}s...`);
      await sleep(backoff);
      continue;
    }
    if (!result.tooEarly) {
      const msg = `Booking failed for ${target.label} on attempt ${attempt}: HTTP ${result.status} ${JSON.stringify(result.body)}`;
      console.log(`  ❌ ${msg}`);
      throw new Error(msg); // propagates as a real failure → red job + failure email
    }
    // Still "too early". If the server's window differs from what we aimed at,
    // re-aim (a later run picks it up if it would overrun this job's time limit).
    if (result.serverHours && result.serverHours !== registrationHours) {
      registrationHours = result.serverHours;
      opensAt = classStart.minus({ hours: registrationHours });
      const waitMs = opensAt.diff(DateTime.now().setZone(TIMEZONE)).as("milliseconds");
      console.log(`  Server window is ${registrationHours}h — re-aiming for ${opensAt.toISO()}.`);
      if (waitMs > 0) {
        if (Date.now() - RUN_START + waitMs + RETRY_WINDOW_MS > RUN_BUDGET_MS) {
          console.log("  Too far for this run's time limit; a later run will pick it up.");
          return;
        }
        await sleep(waitMs);
      }
      deadline = Date.now() + RETRY_WINDOW_MS;
      continue;
    }
    console.log(`  Attempt ${attempt}: window not open yet, retrying...`);
    await sleep(RETRY_INTERVAL_MS);
  }
  // Silent exit 0 here would hide a missed booking — make it loud.
  throw new Error(`Gave up on ${target.label} after ${attempt} attempts — window never opened within the retry period.`);
}

async function main() {
  const config = loadConfig();
  const targets = resolveTargets(config);
  const results = await Promise.allSettled(
    targets.map((target) => handleTarget(config, target))
  );
  let hadError = false;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      hadError = true;
      console.error(`Error handling ${targets[i].label}:`, r.reason);
    }
  });
  if (hadError) {
    process.exitCode = 1; // makes the job show red + triggers GitHub's failure email
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
