# IRIS personal workspace

The workspace adds Today, Projects, Health, Coach, and Settings without replacing
existing workout logs, health records, or conversations. Tasks support list/board
views, status, project, due date, priority, notes, Today selection, search, trash,
and undo. Projects can be created, renamed, archived, restored, and linked to Docs.
Events and habits have editors. Today has a horizontal weekly calendar, Morning/Midday/Night habit columns, and dashboard cards that can be hidden, reordered, moved, and resized. Layouts persist with the workspace. The sidebar and full-session preference persist on the device. Health shows workout plan, session, then Log/Progress; habits remain on Today.

## Storage and migration

`workspace.js`, `workspace.css`, and `workspace-model.mjs` contain the new UI and
model. The first visit imports the merged Today snapshot and existing habit
preferences. It does not delete the old stores. The workspace then becomes the
source of truth for tasks/projects. Gmail and Slack remain read-only snapshots.
The existing `/task-add` integration writes to the workspace after migration.

Local edits are immediately saved in `iris_workspace_v1`; a pending flag survives
reloads and offline use. Settings → Export creates a recoverable JSON backup.
Export before importing another backup or resolving a conflict. Undo covers the
most recent change in the current session; task trash persists across sessions.
Removing a calendar event from IRIS does **not** delete the Google event.

The new authenticated `/workspace` route uses a single Durable Object named
`personal`. Both reads and writes require the existing `EDIT_TOKEN`. Serialized
requests and a revision check prevent concurrent devices overwriting one another.
Do not rename/remove the existing KV bindings or secrets. The legacy `/today`
read route remains CORS-only; CORS is not authentication. This change does not
claim to fix the older dashboard's public-data exposure.

## Google connection (required before live sync)

The deployed Worker currently has the existing coach/edit/refresh secrets but
no Google OAuth secrets. Configure a Google OAuth application with the Docs and
Calendar APIs enabled, authorize the owner with offline access and these scopes:

- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

Store these **only as Worker secrets**, never in a tracked file or browser source:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

Optionally configure `GOOGLE_CALENDAR_ID` (default: `primary`). Deploy the Worker
with its new `WORKSPACE` binding and `workspace-v1` SQLite migration before the
static frontend. Enter the existing edit token in Settings → Connections.
Use an owner-controlled test Doc and test Calendar event for the first live test.
No live Google writes were performed during development; provider behavior is
covered by mock tests, not verified against an authorized Google account.

## Google Docs behavior

In a project's editor, set a valid Google Doc URL and enable sync. IRIS appends a
section bounded by `IRIS TASKS START <project-id>` and `IRIS TASKS END <project-id>`.
Existing document text is preserved; it is not treated as a replacement target.
Each task uses an editable checkbox/title line and an `IRIS` metadata line. Keep
metadata IDs and the section boundaries intact. Notes, due date, priority, and
status live in the metadata line; use IRIS's editor for easier changes.

Sync compares both the local task fingerprint and the last known managed section.
Google-only edits are imported, IRIS-only edits update the section, and simultaneous
changes pause that project. The project editor displays “Keep IRIS version” and
“Use Google version.” Writes use `requiredRevisionId`, so a concurrent Google
edit cannot silently be overwritten. Malformed sections stop without replacing
unrelated document content. Multi-tab Docs are not explicitly supported: the
first document body is used. Keep the managed section in that body.

## Google Calendar behavior

Today → Refresh calendars imports all calendars (including hidden calendars with at least reader access) from every configured Google account. The window is 30 days back and 180 days ahead; pagination is handled. All-day and overnight events are supported. Times are shown in America/Vancouver. Imported events are not write-enabled automatically, and reader calendars remain read-only. Event identity includes account, calendar, and event IDs. Refresh updates clean local copies, preserves unsynced edits, and removes disappeared clean copies within the window from IRIS only.

For additional accounts, store `GOOGLE_ACCOUNTS_JSON` as a Worker secret containing an array of `{id,label,refreshToken,clientId?,clientSecret?}`. Use unique stable IDs, excluding reserved `default`; credentials default to the shared client secrets. The existing `GOOGLE_REFRESH_TOKEN` remains the default account for Docs and newly created events. If it is absent, the first configured account is the default. Linked events write back through their original account and calendar. Keep tokens out of tracked files and client storage.

Phone/iCloud and UVic/Outlook are **not connected or implemented** in this revision. Their provider details and authorization are required. Google account authorization is also still pending; no live provider test has occurred. CalendarList API reference: https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list

Calendar updates use PATCH and `If-Match`, preserve unedited fields, and use
`sendUpdates=none`; IRIS does not send invitations. New event IDs are deterministic
to prevent duplicate creation on retries. Google-only changes are imported;
simultaneous changes require choosing a version in the editor. Sync runs after
workspace saves, manually via Sync now, and when returning to the app after a
minute. It does not run while the app is closed.

## Verification

From the repository root:

```sh
node --test tests/workspace.test.mjs
WRANGLER_LOG_PATH=/private/tmp/iris-wrangler.log worker/node_modules/.bin/wrangler deploy --config worker/wrangler.toml --dry-run --outdir /private/tmp/iris-worker-build
python3 -m http.server 8731 --bind 127.0.0.1
```

Browser QA: quick capture → edit status/notes → board; global search; remove →
undo → reload; Today at 390px and board at 1440px; Health initialization and Coach
navigation. The local preview saves test edits only in its own browser origin.
The service worker bypasses local preview requests to avoid stale test assets.
