# Daily Tracker — working notes for Claude

An installable PWA (`index.html` + `sw.js` + `manifest.webmanifest` + `icons/`) hosted
on GitHub Pages, plus a Cloudflare Worker (`worker/`) that proxies an AI coach to the
Anthropic Messages API. See `README.md` for deploy steps.

## ⚠️ Shared surfaces — multiple sessions, split roles

`index.html` and `sw.js` are edited by more than one Claude session (the coach UI,
the Today dashboard, and the PWA shell all live in `index.html`). Uncommitted changes
to these files are how work gets silently lost or clobbered between sessions.

**Role split — stay in your lane:**
- **Claude Code sessions** own **all app code** — `index.html`, `sw.js`, `worker/`,
  icons, manifest, skills/hooks. Any change to how the app looks or behaves goes
  through here.
- The **Cowork session** writes **only the `Today` data** — nothing else. It must
  never edit `index.html` or `sw.js`. Once the Worker/KV path is live it writes the
  data to KV (`wrangler kv key put --binding TODAY_KV today "$(cat today.json)"`),
  not to files in this repo.

**Every session MUST:**
1. **Before** touching `index.html` or `sw.js`: run `git status` and commit (or
   confirm a clean tree). Never start editing on top of another session's
   uncommitted work.
2. **After** editing them: commit immediately, before ending the turn. Do not leave
   `index.html` / `sw.js` dirty between sessions.

## `today.json` content rules
`today.json` (the committed copy) is served publicly by GitHub Pages, so it **must
not contain links or anything private**:
- **No URLs** — no Google Doc/Drive/Calendar links, no email/message URLs. Titles and
  labels (task text, file names, event names) are fine; `tasksUrl` and every
  `files[].url` / `inbox[].url` stay `"#"` in the committed copy.
- Full links belong **only in the KV copy** served by the CORS-locked Worker route
  `GET /today` (see `worker/src/index.js`), which the app fetches first and prefers.
- The app fetch order is: Worker `/today` (KV, private) → `./today.json` (this
  public, link-stripped copy — a transition fallback) → last cache → baked-in
  snapshot. Once KV is confirmed serving `/today`, delete `today.json` from the repo.

## PWA cache version
When you change `index.html` or `sw.js`, bump `CACHE_VERSION` in `sw.js`
(`const CACHE_VERSION = 'daily-tracker-vN'`) so installed clients re-cache the app
shell instead of serving the stale one. A PostToolUse hook
(`.claude/hooks/cache-version-guard.sh`) reminds you if you forget.

## Secrets
The Anthropic API key lives ONLY in the Worker secret
(`wrangler secret put ANTHROPIC_API_KEY`) or the gitignored `worker/.dev.vars` —
never in `index.html`, the Worker source, or any tracked file. A PreToolUse hook
(`.claude/hooks/secret-guard.sh`) blocks edits that would write an `sk-ant-…` key.

## Deploy & verify
- `/deploy` — bump cache version → commit & push (GitHub Pages) → `wrangler deploy`.
- `/coach-smoke-test` — hit the deployed Worker and confirm a live coach reply.

## Data / keys (do not rename)
Existing localStorage keys: `habit_vis_v3`, `habit_order_v1`, `habit_done_v3_<0-6>`,
`chk_state_v3_<0-6>`, `week_kcal_v3`, `plans_data_v1`. Coach keys: `coach_chat_v1`,
`coach_archive_v1`, `coach_commitments_v1`. The Today dashboard reads `today.json`
(served with the site) into `window.__todayData`, which the coach injects as
`today_agenda`.
