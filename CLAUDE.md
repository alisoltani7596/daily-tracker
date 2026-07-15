# Daily Tracker — working notes for Claude

An installable PWA (`index.html` + `sw.js` + `manifest.webmanifest` + `icons/`) hosted
on GitHub Pages, plus a Cloudflare Worker (`worker/`) that proxies an AI coach to the
Anthropic Messages API. See `README.md` for deploy steps.

## ⚠️ Shared surfaces — multiple sessions edit this repo

`index.html` and `sw.js` are edited by more than one Claude session (e.g. the coach
UI, the Today dashboard, and the PWA shell all live in `index.html`). Uncommitted
changes to these files are how work gets silently lost or clobbered between sessions.

**Every session MUST:**
1. **Before** touching `index.html` or `sw.js`: run `git status` and commit (or
   confirm a clean tree). Never start editing on top of another session's
   uncommitted work.
2. **After** editing them: commit immediately, before ending the turn. Do not leave
   `index.html` / `sw.js` dirty between sessions.

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
