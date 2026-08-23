# Arbox Auto Booker (Peach and Power)

Automatically books classes the moment their 75-hour registration window opens,
so nobody has to wake up to grab a spot manually.

## One-time setup

1. **Add the three secrets** — repo Settings → Secrets and variables →
   Actions → New repository secret:
   - `ARBOX_ACCESS_TOKEN` — the `accesstoken` header value captured from the app
   - `ARBOX_REFRESH_TOKEN` — the `refreshtoken` header value captured from the app
   - `ARBOX_MEMBERSHIP_USER_ID` — `15262136` (her membership_user_id)

2. **Commit these files** to the repo (this whole folder), including
   `config/classes.json`.

3. **Edit `config/classes.json`** to say which classes to book:
   - `recurring`: booked every week automatically. Needs `weekday`, `time`
     (24h `HH:mm`), and `className` (matched against the class category
     name shown in the app, e.g. "Signature", "Power", "open gym" — partial,
     case-insensitive match, so "signature" matches "Signature").
   - `oneOff`: booked once, for a specific `date` (`YYYY-MM-DD`), `time`,
     and `className`. Good for weeks that don't follow the usual pattern.

   Edit this file and commit whenever the desired schedule changes — takes
   under a minute, no code involved.

## Testing before you trust it

**Do this before relying on it for a real booking:** go to the repo's
**Actions** tab → "Arbox Auto Booker" → **Run workflow** (this is the
`workflow_dispatch` trigger) to fire it manually, then check the log output.
With a class in `config/classes.json` whose window is still far off, you
should see it log that it found the class and is skipping because the
window isn't open yet — that alone confirms the login/token/matching logic
all work, with zero risk of it trying to book anything.

## Important things to know

- **GitHub disables scheduled workflows after 60 days of repo
  inactivity.** If you don't touch this repo (even a trivial commit) for
  two months, the cron trigger silently stops firing. Worth a calendar
  reminder every month or two to just re-save the config file, or make any
  small commit.
- **The access token never expires (as far as we've seen) but it's a live
  credential.** Anyone with it can act as her account. Treat the GitHub
  secrets as you would a password — don't paste them anywhere else.
- **Registration window length is read per-class, not hardcoded to 75.**
  We noticed the class data has two numbers that don't quite agree — the
  class-level field says 75 hours (matching the actual error message from
  Arbox), while a nested "series" field says 72. The script trusts the
  class-level 75, since that's what the live error message confirmed. If a
  booking attempt consistently starts a few hours later than it should,
  this is the first thing to double check.
- **The retry loop runs for 90 seconds** once a window is expected to open,
  trying every ~1.5s — this absorbs small clock differences between
  GitHub's servers and Arbox's. If Arbox is consistently slower/faster to
  open than expected, adjust `RETRY_WINDOW_MS` in `scripts/book.js`.
- **GitHub Actions free minutes:** running every 10 minutes is cheap since
  almost every run exits in under a second — this should stay well within
  free-tier minutes for a private repo, but worth knowing this is what's
  consuming them if you ever check usage.
