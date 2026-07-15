# Daily Tracker — Installable PWA + AI Coach

A single-file workout / habit / kcal tracker, upgraded to an installable PWA with
an offline app shell and an ICF-style AI accountability coach.

```
daily-tracker/
├── index.html              ← the tracker (PWA + coach UI live here)
├── manifest.webmanifest    ← installability metadata
├── sw.js                   ← service worker (offline app shell + font cache)
├── icons/                  ← 192 / 512 / 512-maskable app icons
├── assets/                 ← YouTube thumbnails (served locally)
└── worker/                 ← Cloudflare Worker that proxies the coach to Anthropic
    ├── src/index.js
    ├── wrangler.toml
    ├── package.json
    └── .dev.vars.example   ← copy to .dev.vars for local dev (gitignored)
```

All existing `localStorage` keys are unchanged (`habit_*_v3`, `chk_state_v3_*`,
`week_kcal_v3`, `plans_data_v1`), so your data survives the upgrade. The coach adds
three new keys: `coach_chat_v1`, `coach_archive_v1`, `coach_commitments_v1`.

---

## Phase 1 — Host the PWA (GitHub Pages)

1. Create a repo and push the contents of `daily-tracker/` to it.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick
   `main` / root, save.
3. Open `https://<your-username>.github.io/<repo>/`.
   - **Install:** Chrome/Edge desktop → "Install app" in the address bar; Android
     Chrome → "Add to Home screen"; iOS Safari → Share → "Add to Home Screen".
   - Works fully offline after the first load (app shell + fonts + thumbnails are cached).

> After any change to `index.html` / `sw.js`, bump `CACHE_VERSION` in `sw.js`
> (currently `daily-tracker-v2`) so clients re-cache instead of serving the old shell.

---

## Phase 2 — Deploy the AI Coach Worker

The Anthropic API key lives **only** in the Worker as a secret — never in the
frontend or the repo.

```bash
cd worker
npm install          # installs wrangler locally (or use `npx wrangler …`)

# 1. Authenticate with Cloudflare (opens a browser)
npx wrangler login

# 2. Store your Anthropic API key as a secret (paste it when prompted)
npx wrangler secret put ANTHROPIC_API_KEY

# 3. Restrict CORS to your site: edit wrangler.toml → ALLOWED_ORIGINS,
#    replacing https://USERNAME.github.io with your GitHub Pages origin.

# 4. Deploy
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://daily-tracker-coach.<your-subdomain>.workers.dev`.

### Point the frontend at the Worker

Open `index.html`, find the coach module (search for `COACH_WORKER_URL`, a single
constant at the top of the coach `<script>`), and paste your Worker URL:

```js
const COACH_WORKER_URL = "https://daily-tracker-coach.<your-subdomain>.workers.dev";
```

Commit and push. Reload the PWA, tap **Coach** in the header, and start a session.

### Local development (optional)

```bash
cd worker
cp .dev.vars.example .dev.vars     # then paste your key into .dev.vars
npx wrangler dev                   # serves the Worker at http://localhost:8787
```

`ALLOWED_ORIGINS` in `wrangler.toml` already whitelists `localhost:8731` /
`127.0.0.1:8731` — serve the tracker with `python3 -m http.server 8731` and point
`COACH_WORKER_URL` at `http://localhost:8787` while testing.

---

## Notes

- **Model:** the Worker uses `claude-sonnet-4-6` (`MODEL` constant in
  `worker/src/index.js`, `max_tokens: 1024`). To move to the newer tier, change it to
  `claude-sonnet-5`.
- **Coach behavior:** the system prompt (ICF-grounded coaching instructions) lives in
  the Worker. On every message the frontend injects a `tracker_state` block (today's
  date/day-type, habits done, workout %, kcal, streaks), the last 2 session summaries,
  and all open commitments. The coach emits commitments in a `<commitments>` JSON block
  that the frontend parses, hides from the chat, and shows as a card with done/missed
  toggles — that status feeds the next session's context.
- **Never commit** `worker/.dev.vars` (already gitignored).
