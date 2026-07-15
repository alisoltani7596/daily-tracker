---
name: deploy
description: Deploy the Daily Tracker — bump the PWA cache version, commit and push to GitHub Pages, and deploy the Cloudflare Worker. Use when the user says /deploy or asks to ship/publish the tracker.
disable-model-invocation: true
---

# Deploy the Daily Tracker

Deploy has **two independent targets**. Do them in this order and confirm each.
Run from the repo root (the directory containing `index.html` and `worker/`).

## 0. Pre-flight
- Confirm you are in the daily-tracker git repo: `git rev-parse --show-toplevel`.
- Show `git status --short`. If there are unrelated uncommitted changes, ask the
  user whether to include them before continuing.

## 1. Bump the PWA cache version (only if the shell changed)
The service worker precaches `index.html` cache-first, so installed clients keep
serving the old shell until `CACHE_VERSION` changes.
- Check whether `index.html` or `sw.js` changed since the last deploy:
  `git diff --quiet HEAD -- index.html sw.js` (non-zero exit = they changed).
- If they changed, bump the version in `sw.js` — increment the trailing number,
  e.g. `const CACHE_VERSION = 'daily-tracker-v3';` → `'daily-tracker-v4';`.
- If they did NOT change, skip this step (no bump needed).

## 2. Ship the static site → GitHub Pages
Pushing to the Pages branch is the deploy — GitHub rebuilds automatically.
```bash
git add -A
git commit -m "Deploy: <one-line summary of what changed>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```
- **Pushing is outward-facing** — confirm the commit summary with the user before
  pushing, unless they already said "just deploy".
- Reminder: `today.json` is committed and served publicly by the site. If the user
  didn't intend its contents (Google Doc links, task text) to be public, flag it
  before pushing.

## 3. Deploy the Cloudflare Worker (only if `worker/` changed)
```bash
cd worker
npx wrangler deploy
```
- First-time only, ensure the user has run `npx wrangler login` and
  `npx wrangler secret put ANTHROPIC_API_KEY`, that `ALLOWED_ORIGINS` in
  `wrangler.toml` includes their GitHub Pages origin, and that the KV namespace
  exists with its real id pasted into `wrangler.toml` (deploy fails on the
  `REPLACE_WITH_KV_NAMESPACE_ID` placeholder):
  `npx wrangler kv namespace create TODAY_KV` → paste the printed id.
  The Today data is written to KV (not the repo) via:
  `npx wrangler kv key put --binding TODAY_KV today "$(cat ../today.json)"`.
- `wrangler deploy` prints the Worker URL. If it changed, remind the user to update
  `COACH_WORKER_URL` at the top of the coach module in `index.html` (then redeploy
  the static site).

## 4. Verify
- Tell the user the Pages URL and (if deployed) the Worker URL.
- Suggest running `/coach-smoke-test` to confirm the live coach reply end-to-end.
