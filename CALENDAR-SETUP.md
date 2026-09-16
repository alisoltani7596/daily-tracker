# Calendar sync — setup

IRIS shows your calendar on the **Today** tab. There are two independent paths;
you can use either or both (duplicates are de-duped in the app by title+date+time).

## 1. Device sync — iCloud + UVic + Google, everything on your Mac/iPhone

Your Apple **Calendar** app already merges every account (all Google accounts,
iCloud, UVic). A Shortcut reads them all and pushes them to IRIS. This is the
only practical way to include iCloud and UVic (no clean server API for those).

**Backend (already built):**
- `POST /calendar-push` — token-gated (`x-edit-token: <EDIT_TOKEN>`). Replaces the
  whole device event set. Body: `{ "tz":"America/Vancouver", "events":[{title,start,end,allDay,calendar}] }`
  (`start`/`end` ISO 8601). Stored read-only in KV `calendar:device`.
- `GET /calendar-device` — CORS-locked read; the app overlays these on the calendar.

**One-time setup:**
1. Import the **“Sync Calendar to IRIS”** Shortcut (file provided separately).
2. Open it and replace `PASTE_YOUR_IRIS_TOKEN` in the first Text action with your
   IRIS edit token (the same token you enter in Settings → Connections / used for
   Today & meals edits).
3. Run it once — events appear on Today within a few seconds.
4. Add an automation so it stays fresh: Shortcuts → Automation → e.g. *Time of Day*
   every hour, and/or *When I open IRIS*. Run “Sync Calendar to IRIS”.

Events show read-only, colored per calendar, labeled by account. Removing/editing
them must be done in the Calendar app; IRIS never writes back to device calendars.

## 2. Live Google (optional) — server-side, updates without the Shortcut

The workspace already has server-side Google Calendar import code; it just needs
OAuth secrets. This makes Google calendars sync live via **Refresh calendars**
(the Shortcut still handles iCloud + UVic).

1. Google Cloud Console → new project → enable **Google Calendar API** (and Docs
   API if you want project↔Doc sync).
2. Create an **OAuth client** (Desktop app is simplest). Note the client ID/secret.
3. Authorize your account **offline** for these scopes and capture the refresh token
   (OAuth Playground at https://developers.google.com/oauthplayground works — set
   your own client id/secret in its settings gear, “offline access”):
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/documents` (optional, Docs sync)
4. Set Worker secrets (never commit these):
   ```sh
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GOOGLE_REFRESH_TOKEN
   # optional extra Google accounts:
   npx wrangler secret put GOOGLE_ACCOUNTS_JSON   # [{"id":"work","label":"UVic Gmail","refreshToken":"..."}]
   ```
5. Redeploy the Worker, then in IRIS: Settings → Connections → **Refresh all Google
   calendars**. Import window is 30 days back / 180 ahead.

## Deploy

```sh
cd worker && npx wrangler deploy        # Worker (calendar routes + workspace DO)
# frontend: commit + push main → GitHub Pages
```
