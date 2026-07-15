---
name: coach-smoke-test
description: Smoke-test the deployed AI Coach Worker end-to-end — send a real request and confirm a coach reply comes back. Use when the user says /coach-smoke-test or asks to verify the coach is live after a deploy.
disable-model-invocation: true
---

# Coach smoke test

There is no automated test suite, and the live coach reply can only be verified
against the deployed Worker. This exercises the full path: frontend origin → CORS →
Worker → Anthropic API → reply.

## 1. Read the two values from the repo
- Worker URL: the `COACH_WORKER_URL` constant in `index.html`
  ```bash
  grep -m1 'COACH_WORKER_URL' index.html
  ```
  If it still contains `YOUR-SUBDOMAIN`, stop — the frontend isn't pointed at a
  deployed Worker yet. Tell the user to deploy first.
- An allowed origin: the first entry of `ALLOWED_ORIGINS` in `worker/wrangler.toml`
  ```bash
  grep -m1 'ALLOWED_ORIGINS' worker/wrangler.toml
  ```

## 2. Send a test request
Substitute `<URL>` and `<ORIGIN>` from step 1:
```bash
curl -sS -X POST "<URL>" \
  -H "content-type: application/json" \
  -H "Origin: <ORIGIN>" \
  -d '{"messages":[{"role":"user","content":"Smoke test — reply with one short sentence to confirm you are online."}],"context":"tracker_state:\n  date: smoke-test\n  habits_done: 0 / 5\n"}' \
  -w '\n[http %{http_code}]\n' | tee /tmp/coach_smoke.json
jq -r '.text // .error' /tmp/coach_smoke.json
```

## 3. Interpret the result
- **`.text` non-empty** → coach is live. ✅ Report the reply text to the user.
- **http 403** → the `Origin` isn't in `ALLOWED_ORIGINS`. Fix `wrangler.toml` and
  `wrangler deploy` again (or test with an origin that IS allowed).
- **http 500, "missing API key"** → the secret isn't set:
  `cd worker && npx wrangler secret put ANTHROPIC_API_KEY`.
- **http 502, "Upstream API error"** → the Anthropic call failed; the `detail`
  field in the JSON has the upstream message (bad key, model name, etc.).
- **Connection error / DNS** → the Worker isn't deployed at that URL, or the URL in
  `index.html` is wrong.

## 4. (Optional) verify CORS preflight
```bash
curl -sS -X OPTIONS "<URL>" -H "Origin: <ORIGIN>" -H "Access-Control-Request-Method: POST" -D - -o /dev/null | grep -i access-control-allow-origin
```
Should echo back `<ORIGIN>`. If empty, CORS is misconfigured.
