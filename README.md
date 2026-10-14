# assetliving-app

Main AssetLiving web apps: `index.html` (LeaseAI — AI reads lease contracts, saves to Notion), `agent.html` (public room listing), `booking.html` (Agoda/Airbnb booking inbox), plus `server.js` (Express backend proxying Claude, Notion, Google Calendar, and Gmail).

## Deployment

- **Hosted on Render**, live at: https://assetliving-app.onrender.com
- Render account: **maildy.cn@gmail.com** ("My Workspace", Ungrouped Services — same account as leasai-bot's `check-rent-due` cron, fortune-app)
- **Git source: GitLab** (`gitlab.com/maildy.cn/assetliving-app`), branch `main`. Deploys automatically on push via Render's "Public Git Repository" source. A `github.com/maildycn/assetliving-app` remote is also pushed to in parallel for historical continuity, but it is **not** what Render deploys from.

## Required environment variables

Set in the Render service's Environment tab:

- `ANTHROPIC_KEY` — Claude API, used by `/api/claude` and the booking-sync email extractor
- `NOTION_TOKEN` — Notion integration token
- `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` — Google **service account** (Calendar only, `/api/gcal`). Does not work for Gmail (personal Gmail accounts can't grant service-account access to an inbox).
- `GOOGLE_GMAIL_CLIENT_ID` / `GOOGLE_GMAIL_CLIENT_SECRET` / `GOOGLE_GMAIL_REFRESH_TOKEN` — Gmail API **OAuth user credentials** (separate Google Cloud project "My First Project", OAuth client "booking-sync-gmail"), authorized once as maildy.cn@gmail.com, scope `gmail.readonly`. Used only by booking-sync to read forwarded Agoda/Airbnb emails.
- `NOTION_BOOKING_DB_ID` — the "📅 Booking" Notion database (`7f61034f5370431ba56002b25ed7c886`), under the same "🏠 LeaseAI — ระบบจัดการสัญญาเช่า" page as the Contract DB.
- `BOOKING_CRON_SECRET` — random string. Required to call `/cron/sync-bookings?key=<BOOKING_CRON_SECRET>` (returns 403 otherwise).

## Booking sync (Agoda/Airbnb → Notion → booking.html)

Agoda and Airbnb don't offer API access to individual hosts, so this reads booking confirmation emails instead:

1. A Gmail filter on **imonoonan2@gmail.com** (`from:(agoda.com OR airbnb.com)`) auto-forwards matching new mail to **maildy.cn@gmail.com**. Gmail forwarding only applies to mail that arrives *after* the filter is created — it cannot backfill older emails (a Gmail platform limitation, confirmed 2026-10-14).
2. `GET /cron/sync-bookings?key=<BOOKING_CRON_SECRET>` polls maildy.cn@gmail.com via the Gmail API (`from:(agoda.com OR airbnb.com) newer_than:14d`), skips messages already recorded (matched by Gmail Message ID), and for each new one sends the email body to Claude to extract guest name, phone, dates, room, status, booking ID, and **base rate** (room rate before tax/fees — not the net total). Results are written to the Notion Booking DB. Accepts an optional `?q=` override to run a custom Gmail search (useful for one-off backfills/tests — e.g. a manually forwarded email, which loses its original `From` header, so platform is detected from the subject/body as a fallback).
3. **Scheduler: Render Cron Job** (`booking-sync`, `curlimages/curl` image, same "My Workspace" Render account), runs every 15 minutes, executing `curl -sf https://assetliving-app.onrender.com/cron/sync-bookings?key=$BOOKING_CRON_SECRET`.
4. `booking.html` (password-gated, same password as `index.html`) lists bookings from `GET /api/bookings`, polls every 30s, and shows an unread-count badge + toast when new bookings appear. `POST /api/bookings/:id/read` marks one read. Each booking has a free-text **หมายเหตุ (notes)** field, editable in the UI and saved via `POST /api/bookings/:id/notes` — for anything the AI extraction doesn't cover.

Verified end-to-end 2026-10-14: forwarded a real Agoda confirmation email, synced it, and Claude correctly extracted guest name, phone, room, dates, and amount into Notion.

## Related services (separate repos/hosts, not this one)

- `leasai-bot` — LINE bot for rent-payment slips + daily rent-due reminders. GitLab: `maildy.cn/leasai-bot`. Hosted on Render at `leasai-bot.onrender.com`.
- `personal-expense-bot` / the still-untraced `line-expense-bot.onrender.com` — unrelated personal (non-rental) expense bots. See project memory, not this repo.
