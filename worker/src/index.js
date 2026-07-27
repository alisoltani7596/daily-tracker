/* Daily Tracker — AI Coach Worker
 *
 * A Cloudflare Worker that proxies the tracker's coach chat to the Anthropic
 * Messages API. The API key lives ONLY here, as a secret:
 *
 *   wrangler secret put ANTHROPIC_API_KEY
 *
 * The frontend sends { messages: [...], context: "<tracker_state + history>" }.
 * The static coaching system prompt lives in this Worker (never in the browser).
 * CORS is restricted to the origins listed in ALLOWED_ORIGINS (wrangler.toml).
 */

const MODEL = "claude-sonnet-4-6"; // valid, active model. Swap to "claude-sonnet-5" for the newer tier.
const MAX_TOKENS = 1024;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ─── Text-to-speech (Workers AI) ──────────────────────────────────────────────
// Deepgram Aura is the highest-quality English TTS in the Workers AI catalogue
// and offers multiple natural speakers; MeloTTS (@cf/myshell-ai/melotts) is the
// single-voice fallback if Aura is ever withdrawn. Aura streams MPEG audio.
const TTS_MODEL = "@cf/deepgram/aura-1";
const TTS_MAX_CHARS = 1200; // per request; the frontend chunks long text by sentence groups
const AURA_SPEAKERS = new Set([
  "angus", "asteria", "arcas", "orion", "orpheus", "athena",
  "luna", "zeus", "perseus", "helios", "hera", "stella",
]);

// ─── System prompt (verbatim coaching instructions) ──────────────────────────
const SYSTEM_PROMPT = `# Project Instructions: Personal Coach
## Role
You are my personal coach. Not an assistant, not a cheerleader — a coach. Your job is to help me make progress on my goals across health, work, money, and habits, and to hold me accountable. You work like a real human coach: you ask before you tell, you remember commitments, and you don't let things slide.
## Coaching domains
- Health & fitness (training, sleep, nutrition, energy)
- Work & career (deep work, deadlines, long-term direction)
- Money & side projects (follow-through on plans, avoiding shiny-object syndrome)
- Habits & discipline (consistency, time management, avoidance patterns)
I may bring any of these to a session. If I keep avoiding one domain for weeks, name it.
## ICF framework
Ground your practice in the International Coaching Federation (ICF) standards:
- **Definition:** Coaching is partnering with the client in a thought-provoking, creative process that inspires them to maximize their potential. The client is the expert on their own life — you facilitate, you don't prescribe.
- **Core competencies:** Demonstrate ethical practice; embody a coaching mindset; establish and maintain agreements; cultivate trust and safety; maintain presence; listen actively; evoke awareness; facilitate client growth.
- **Client owns the agenda.** Each session, establish what I want to walk away with before diving in. Check against it before closing.
- **Evoke awareness over giving answers.** Use powerful questions, silence, reflection, and reframing as your primary tools — consistent with ICF's emphasis on the client generating their own insights.
- **Coaching vs. everything else.** Stay in the coaching lane: not consulting (solving my problems for me), not mentoring (telling me what you'd do), not therapy (processing the past). If I ask for direct expertise, you may briefly step out of the coaching role — but say you're doing it, then step back in.
## How you coach
1. **Ask first.** Default to questions that make me think, not answers. Only give direct advice when I explicitly ask or when I'm clearly stuck after reflecting.
2. **One thing at a time.** If I bring five topics, make me pick the one that matters most today.
3. **Challenge me.** If I'm making excuses, rationalizing, or setting vague goals, say so plainly. "That's not a commitment, that's a wish" is a valid response.
4. **Concrete over abstract.** Every session ends with specific, measurable commitments with deadlines. Never let me leave with "I'll try to do better."
5. **No lectures.** Keep responses short — a coach talks less than the client. One question at a time.
## Session structure
**Opening (every session):** Review the open commitments provided in the context. Ask how they went — specifically, not "how's it going." If I dodged one, dig into why before moving on.
**Middle:** Work the topic I bring. Use questions to get to the real issue (the stated problem is often not the actual problem).
**Closing:** Ask me to state my commitments out loud: what, by when, how we'll know it happened. Reflect them back. Then emit them in a machine-readable block exactly like this, after your closing message:
<commitments>
[{"what": "...", "by": "YYYY-MM-DD", "measure": "..."}]
</commitments>
Only emit this block when the session is actually closing with agreed commitments.
## Weekly review
If I say "weekly review," run this: wins, misses, pattern you're noticing across sessions, one adjustment for next week. Be honest about the pattern even if it's unflattering.
## Tone
Direct, warm, zero fluff. Talk to me like a coach who respects me enough to be honest. Don't praise effort that didn't happen. Do acknowledge real wins briefly, then move forward.
## Boundaries
- You're not a therapist or doctor. If something needs professional support (mental health, medical, legal), say so directly and don't try to coach through it.
- Everything you know about me comes from the context provided with each message: the tracker state, past session summaries, open commitments, and this conversation. If you don't know something relevant, ask.
- If I try to turn a session into casual chat or research help, gently redirect: "Is this what you want to spend today's session on?"
## Live tracker data
Each message includes a tracker_state block with my real habit/workout/kcal data for today. Use it. If my checklist is at 20% at 9pm, that's fair game to bring up.`;

// ─── Planner system prompt (four-phase task planning) ────────────────────────
const PLANNER_MAX_TOKENS = 2048; // room for a full decomposition + schedule + plan block
const PLANNER_SYSTEM_PROMPT = `# Project Instructions: Task Planner
## Role
You are a rigorous planning partner. You turn a vague intention into a concrete, dated, scheduled plan the user can actually execute. You are methodical and you do not skip ahead. You run a strict four-phase workflow and never jump to a later phase before the current one is confirmed.

## Context you are given
Each message includes a context block with the user's current 3-day schedule (day-groups with timed items) and their upcoming deadlines, injected from their live dashboard, plus today's date. Treat this as ground truth for what time is already spoken for and what external due dates exist. The user tells you their weekly capacity in hours — if they haven't, ask.

## Phase 1 — Interview the task
Interview before you plan. Establish, a few questions at a time (never a wall of questions):
- The concrete outcome — what "done" looks like, observable.
- The hard deadline — and whether it is truly fixed.
- The audience / stakeholders.
- What already exists (draft, data, code, notes) vs. what starts from zero.
- Dependencies and blockers (people, approvals, inputs you are waiting on).
- Weekly hours the user can realistically give this.
Press on vague answers — "some", "soon", "a bit" are not answers; ask for specifics. When you have enough, restate the task in EXACTLY three sentences (outcome, deadline, constraints) and ask the user to confirm before proceeding. Do not decompose until they confirm.

## Phase 2 — Decompose
Break the task into verb-first subtasks, each small enough to finish in 1–2 hours (split anything bigger). For each subtask give: a verb-first name, an explicit done-criterion, and a time estimate. Order them by dependency — nothing depends on a later item. Include the easily-forgotten steps: setup, environment, reviews, buffer/revision passes, submission/upload mechanics, sign-offs. Present the list and iterate until the user approves it. Do not schedule until they approve the breakdown.

## Phase 3 — Schedule
Propose a specific calendar date for each subtask, between today and the deadline, that:
- Respects the provided 3-day schedule (don't stack work onto already-busy blocks) and the user's stated weekly capacity (don't exceed their hours).
- Front-loads risk: the hardest, most uncertain, most dependency-laden subtasks go early.
- Leaves slack before the deadline — never schedule the final subtask on the due date itself.
If the work does not fit the time available at the stated capacity, say so plainly and specifically (how many hours short, what would have to give) rather than forcing an unrealistic plan. Iterate until the user approves the dates.

## Phase 4 — Emit the machine-readable plan
ONLY after the user explicitly approves the schedule, end your message with a single machine-readable block, in exactly this format, placed after your prose:
<plan>
[{"n":"verb-first subtask — Parent Tag","date":"YYYY-MM-DD","start":"HH:MM","dur_min":90}]
</plan>
Rules for the block:
- One object per subtask. "n" MUST end with " — Parent Tag" naming the overall task, so subtasks can be grouped later.
- "date" is required (YYYY-MM-DD). "start" (24-hour HH:MM) and "dur_min" (integer minutes) are OPTIONAL — include them only for subtasks that should become a timed calendar event; omit them for ones that are just a dated to-do.
- Emit the block ONLY in Phase 4 with an approved schedule. Never emit it during phases 1–3, and never emit an empty or placeholder plan.

## Tone
Concise and concrete. One phase at a time. Ask, confirm, then proceed. Do not pad with encouragement.`;

// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = resolveAllowedOrigin(origin, env);
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // GET /today — serve the generated dashboard JSON PLUS the user's manual
    // overrides, both from KV, CORS-locked to the Pages origin. The frontend
    // merges them so manual edits survive the morning regeneration. The refresh
    // task writes only the generated copy:
    //   wrangler kv key put --binding TODAY_KV today "$(cat today.json)"
    if (request.method === "GET" && url.pathname === "/today") {
      if (!allowOrigin) return json({ error: "Origin not allowed" }, 403, {});
      if (!env.TODAY_KV) {
        return json({ error: "today store not configured" }, 500, corsHeaders(allowOrigin));
      }
      const [genStr, ovrStr, health] = await Promise.all([
        env.TODAY_KV.get("today"),
        env.TODAY_KV.get("today_overrides"),
        recentHealth(env, 2),   // last 2 days of health:<date> keys, as { date: entry }
      ]);
      if (genStr == null && ovrStr == null) {
        return json({ error: "not found" }, 404, corsHeaders(allowOrigin));
      }
      // `health` is a small per-date map of the last 2 days so the frontend can
      // read today's + yesterday's sample without an extra request.
      const payload = {
        generated: genStr ? safeParse(genStr) : null,
        overrides: ovrStr ? safeParse(ovrStr) : null,
        health: (health && Object.keys(health).length) ? health : null,
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(allowOrigin) },
      });
    }

    // POST /today-overrides — persist the user's manual Today edits to KV.
    // CORS alone is not enough for a write route (the Origin header is spoofable
    // outside a browser), so this also requires the shared EDIT_TOKEN secret in
    // the x-edit-token header. Set it with: wrangler secret put EDIT_TOKEN
    if (request.method === "POST" && url.pathname === "/today-overrides") {
      if (!allowOrigin) return json({ error: "Origin not allowed" }, 403, {});
      if (!env.TODAY_KV) {
        return json({ error: "today store not configured" }, 500, corsHeaders(allowOrigin));
      }
      if (!env.EDIT_TOKEN) {
        return json({ error: "editing not configured (missing EDIT_TOKEN secret)" }, 500, corsHeaders(allowOrigin));
      }
      const token = request.headers.get("x-edit-token") || "";
      if (!timingSafeEqual(token, env.EDIT_TOKEN)) {
        return json({ error: "invalid edit token" }, 403, corsHeaders(allowOrigin));
      }
      let overrides;
      try {
        overrides = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400, corsHeaders(allowOrigin));
      }
      if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
        return json({ error: "overrides must be an object" }, 400, corsHeaders(allowOrigin));
      }
      const serialized = JSON.stringify(overrides);
      if (serialized.length > 100000) {
        return json({ error: "overrides too large" }, 413, corsHeaders(allowOrigin));
      }
      await env.TODAY_KV.put("today_overrides", serialized);
      return json({ ok: true }, 200, corsHeaders(allowOrigin));
    }

    // POST /task-add — append a single task to the user's Today overrides (the
    // added-tasks list), exactly as the in-app "Add task" flow does. Same
    // permission class as in-app edits (EDIT_TOKEN in x-edit-token), so trusted
    // automation can add tasks via curl. Body: {"n": "task name", "hi": bool?}.
    // Dedupes by name against generated + override tasks: an existing name is a
    // no-op that returns {ok:true,dup:true}.
    if (request.method === "POST" && url.pathname === "/task-add") {
      if (!env.TODAY_KV) {
        return json({ error: "today store not configured" }, 500, corsHeaders(allowOrigin));
      }
      if (!env.EDIT_TOKEN) {
        return json({ error: "editing not configured (missing EDIT_TOKEN secret)" }, 500, corsHeaders(allowOrigin));
      }
      const token = request.headers.get("x-edit-token") || "";
      if (!timingSafeEqual(token, env.EDIT_TOKEN)) {
        return json({ error: "invalid edit token" }, 403, corsHeaders(allowOrigin));
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400, corsHeaders(allowOrigin));
      }
      const name = (payload && typeof payload.n === "string") ? payload.n.trim() : "";
      if (!name) {
        return json({ error: "`n` (non-empty task name) is required" }, 400, corsHeaders(allowOrigin));
      }
      const hi = !!(payload && payload.hi);

      const [genStr, ovrStr] = await Promise.all([
        env.TODAY_KV.get("today"),
        env.TODAY_KV.get("today_overrides"),
      ]);
      const generated = safeParse(genStr) || {};
      const overrides = safeParse(ovrStr) || {};
      if (!Array.isArray(overrides.added)) overrides.added = [];
      if (!overrides.taskState || typeof overrides.taskState !== "object") overrides.taskState = {};

      // Dedupe by name: generated task names, added task names, and renamed text.
      const existing = new Set();
      (generated.tasks || []).forEach((t) => { if (t && typeof t.n === "string") existing.add(t.n); });
      overrides.added.forEach((a) => { if (a && typeof a.n === "string") existing.add(a.n); });
      Object.values(overrides.taskState).forEach((p) => { if (p && typeof p.text === "string") existing.add(p.text); });
      if (existing.has(name)) {
        return json({ ok: true, dup: true }, 200, corsHeaders(allowOrigin));
      }

      overrides.added.push({ n: name.slice(0, 300), hi, done: false });
      await env.TODAY_KV.put("today_overrides", JSON.stringify(overrides));
      return json({ ok: true }, 200, corsHeaders(allowOrigin));
    }

    // POST /health-push — store a day's Apple Health / Garmin sample (pushed by an
    // iOS Shortcut). Server-to-server like /task-add: gated purely by the shared
    // EDIT_TOKEN in x-edit-token (same blast radius, one fewer secret), NOT CORS.
    // Body: {date (required, YYYY-MM-DD), steps, sleep_hours, sleep_score?,
    // wake_time?"HH:MM", bed_time?"HH:MM", workouts?[{type,minutes}]} — all but
    // date optional, since Health samples arrive in patchy, partial pushes.
    // Each day is its own KV key `health:<date>`, and a push MERGES field-by-field
    // into any existing key — so a later partial push (say just steps) never
    // erases fields an earlier push wrote (sleep, workouts). Idempotent per field.
    if (request.method === "POST" && url.pathname === "/health-push") {
      if (!env.TODAY_KV) {
        return json({ error: "health store not configured" }, 500, corsHeaders(allowOrigin));
      }
      if (!env.EDIT_TOKEN) {
        return json({ error: "editing not configured (missing EDIT_TOKEN secret)" }, 500, corsHeaders(allowOrigin));
      }
      const token = request.headers.get("x-edit-token") || "";
      if (!timingSafeEqual(token, env.EDIT_TOKEN)) {
        return json({ error: "invalid edit token" }, 403, corsHeaders(allowOrigin));
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400, corsHeaders(allowOrigin));
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: "body must be a JSON object" }, 400, corsHeaders(allowOrigin));
      }
      const date = (typeof payload.date === "string") ? payload.date.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: "`date` (YYYY-MM-DD) is required" }, 400, corsHeaders(allowOrigin));
      }

      // Validate every provided field strictly; a present-but-wrong-typed field is
      // a 400 (reject junk) rather than a silent drop. Absent fields are fine.
      const entry = {};
      const err = validateHealthFields(payload, entry);
      if (err) return json({ error: err }, 400, corsHeaders(allowOrigin));

      // Rich sleep: parse Apple Health's raw stage samples into sleep_hours,
      // per-stage minutes, bed_time, wake_time. Computed fields only fill slots an
      // explicit field in THIS push didn't already set (explicit wins).
      if (payload.sleep_raw !== undefined && payload.sleep_raw !== null) {
        if (typeof payload.sleep_raw !== "string") {
          return json({ error: "`sleep_raw` must be a newline-separated string" }, 400, corsHeaders(allowOrigin));
        }
        const computed = parseSleepRaw(payload.sleep_raw);
        if (computed) {
          for (const k of ["sleep_hours", "bed_time", "wake_time", "sleep_stages"]) {
            if (computed[k] !== undefined && entry[k] === undefined) entry[k] = computed[k];
          }
        }
      }

      // Merge into the existing per-date key so partial pushes accumulate.
      const key = "health:" + date;
      const existing = safeParse(await env.TODAY_KV.get(key)) || {};
      const merged = { ...existing, ...entry };

      // Iris sleep score: whenever the merged record has a sleep duration, compute
      // an Apple-rubric-modelled score (duration/consistency/interruptions) against
      // a rolling bed_time average from prior days. Stored separately from any
      // explicitly pushed sleep_score; the frontend prefers pushed > computed.
      if (typeof merged.sleep_hours === "number") {
        try {
          const priorBeds = await priorBedTimes(env, date, 14);
          merged.sleep_score_computed = computeSleepScore(merged, priorBeds);
        } catch { /* score is best-effort, never fails the push */ }
      }

      // Self-pruning: expire a day's key ~60 days out so old samples don't pile up.
      await env.TODAY_KV.put(key, JSON.stringify(merged), { expirationTtl: 60 * 24 * 3600 });
      return json({ ok: true, date, fields: Object.keys(entry), sleep_score_computed: merged.sleep_score_computed }, 200, corsHeaders(allowOrigin));
    }

    // POST /today-refresh — the Cowork scheduled task pushes the freshly generated
    // Today data into the TODAY_KV `today` key. This is a server-to-server call
    // (curl, no browser Origin), so it is gated purely by the REFRESH_TOKEN secret
    // (separate from EDIT_TOKEN) in the x-refresh-token header, NOT by CORS origin.
    //   Set it with: wrangler secret put REFRESH_TOKEN
    if (request.method === "POST" && url.pathname === "/today-refresh") {
      if (!env.TODAY_KV) {
        return json({ error: "today store not configured" }, 500, corsHeaders(allowOrigin));
      }
      if (!env.REFRESH_TOKEN) {
        return json({ error: "refresh not configured (missing REFRESH_TOKEN secret)" }, 500, corsHeaders(allowOrigin));
      }
      const token = request.headers.get("x-refresh-token") || "";
      if (!timingSafeEqual(token, env.REFRESH_TOKEN)) {
        return json({ error: "invalid refresh token" }, 403, corsHeaders(allowOrigin));
      }
      let data;
      try {
        data = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400, corsHeaders(allowOrigin));
      }
      if (!isValidTodayShape(data)) {
        return json({ error: "body is not a valid Today payload (need schedule, deadlines, tasks arrays)" }, 400, corsHeaders(allowOrigin));
      }
      const serialized = JSON.stringify(data);
      if (serialized.length > 200000) {
        return json({ error: "today payload too large" }, 413, corsHeaders(allowOrigin));
      }
      await env.TODAY_KV.put("today", serialized);
      return json({ ok: true, bytes: serialized.length }, 200, corsHeaders(allowOrigin));
    }

    // POST /tts — synthesize speech with Workers AI (Deepgram Aura). CORS-locked
    // to the same origins as the chat routes. Body: {"text": "...", "speaker"?}.
    // Returns the audio bytes (audio/mpeg) for playback in an <audio> element.
    if (request.method === "POST" && url.pathname === "/tts") {
      if (!allowOrigin) return json({ error: "Origin not allowed" }, 403, {});
      if (!env.AI) return json({ error: "TTS not configured (missing AI binding)" }, 500, corsHeaders(allowOrigin));
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, corsHeaders(allowOrigin));
      }
      const text = (body && typeof body.text === "string") ? body.text.trim() : "";
      if (!text) return json({ error: "`text` (non-empty string) is required" }, 400, corsHeaders(allowOrigin));
      if (text.length > TTS_MAX_CHARS) {
        return json({ error: "text too long", max: TTS_MAX_CHARS }, 413, corsHeaders(allowOrigin));
      }
      const input = { text };
      if (body && typeof body.speaker === "string" && AURA_SPEAKERS.has(body.speaker)) {
        input.speaker = body.speaker;
      }
      let out;
      try {
        out = await env.AI.run(TTS_MODEL, input, { returnRawResponse: true });
      } catch (err) {
        return json({ error: "TTS synthesis failed", detail: String((err && err.message) || err) }, 502, corsHeaders(allowOrigin));
      }
      // env.AI.run may honour returnRawResponse (a Response) or return a raw
      // ReadableStream of audio bytes — handle both so we always stream audio.
      if (out && typeof out === "object" && "body" in out && "headers" in out && typeof out.headers.get === "function") {
        if (out.ok === false) {
          const detail = await out.text().catch(() => "");
          return json({ error: "TTS upstream error", status: out.status, detail: String(detail).slice(0, 300) }, 502, corsHeaders(allowOrigin));
        }
        const h = new Headers(corsHeaders(allowOrigin));
        h.set("content-type", out.headers.get("content-type") || "audio/mpeg");
        h.set("cache-control", "no-store");
        return new Response(out.body, { status: 200, headers: h });
      }
      return new Response(out, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "cache-control": "no-store", ...corsHeaders(allowOrigin) },
      });
    }

    // POST /plan — planner chat. Mirrors the coach chat exactly (same model,
    // prompt caching, CORS), differing only in the system prompt and a larger
    // token budget for a full decomposition + schedule + <plan> block.
    if (request.method === "POST" && url.pathname === "/plan") {
      return handleChat(request, env, allowOrigin, PLANNER_SYSTEM_PROMPT, PLANNER_MAX_TOKENS);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders(allowOrigin));
    }

    // Default POST route: the coach chat. Inject the latest health sample so the
    // coach can reference last night's sleep and yesterday's steps.
    return handleChat(request, env, allowOrigin, SYSTEM_PROMPT, MAX_TOKENS, true);
  },
};

// ─── Shared chat proxy (coach + planner) ───────────────────────────────────────
// Proxies a { messages, context } chat turn to the Anthropic Messages API with a
// given static system prompt (cached) followed by the volatile per-message context.
async function handleChat(request, env, allowOrigin, systemPrompt, maxTokens, injectHealth) {
  // Reject cross-origin callers not on the allowlist.
  if (!allowOrigin) {
    return json({ error: "Origin not allowed" }, 403, {});
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server not configured (missing API key)" }, 500, corsHeaders(allowOrigin));
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders(allowOrigin));
  }

  const messages = body.messages;
  const context = typeof body.context === "string" ? body.context : "";
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "`messages` (non-empty array) is required" }, 400, corsHeaders(allowOrigin));
  }

  // Static prompt first (cacheable), volatile per-message context after.
  const system = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];
  if (context) system.push({ type: "text", text: context });

  // Append the latest Apple Health / Garmin sample (coach only), as a volatile
  // block after the cache breakpoint — best-effort, never fails the request.
  if (injectHealth && env.TODAY_KV) {
    try {
      const block = formatHealthForContext(await latestHealth(env));
      if (block) system.push({ type: "text", text: block });
    } catch { /* health context is optional */ }
  }

  let apiResp;
  try {
    apiResp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || MAX_TOKENS, system, messages }),
    });
  } catch (err) {
    return json({ error: "Could not reach the AI service" }, 502, corsHeaders(allowOrigin));
  }

  if (!apiResp.ok) {
    const detail = await apiResp.text().catch(() => "");
    return json({ error: "Upstream API error", status: apiResp.status, detail }, 502, corsHeaders(allowOrigin));
  }

  const data = await apiResp.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return json(
    { text, stop_reason: data.stop_reason, usage: data.usage },
    200,
    corsHeaders(allowOrigin)
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolveAllowedOrigin(origin, env) {
  const list = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : "";
}

function corsHeaders(allowOrigin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Edit-Token, X-Refresh-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowOrigin) h["Access-Control-Allow-Origin"] = allowOrigin;
  return h;
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// Validate the recognised health fields on an incoming push, copying the valid
// ones into `out`. Returns an error string on the first junk field, else "".
// Absent fields are skipped; a present field of the wrong type/shape is rejected.
function validateHealthFields(payload, out) {
  // steps, sleep_score → non-negative finite integers.
  for (const f of ["steps", "sleep_score"]) {
    if (payload[f] === undefined || payload[f] === null) continue;
    if (typeof payload[f] !== "number" || !isFinite(payload[f]) || payload[f] < 0) {
      return "`" + f + "` must be a non-negative number";
    }
    out[f] = Math.round(payload[f]);
  }
  // sleep_hours → non-negative finite number ≤ 24, one decimal.
  if (payload.sleep_hours !== undefined && payload.sleep_hours !== null) {
    const v = payload.sleep_hours;
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 24) {
      return "`sleep_hours` must be a number between 0 and 24";
    }
    out.sleep_hours = Math.round(v * 10) / 10;
  }
  // wake_time, bed_time → "HH:MM" 24-hour clock strings.
  for (const f of ["wake_time", "bed_time"]) {
    if (payload[f] === undefined || payload[f] === null) continue;
    if (typeof payload[f] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload[f])) {
      return "`" + f + "` must be a 'HH:MM' time string";
    }
    out[f] = payload[f];
  }
  // workouts → array of { type: non-empty string, minutes: non-negative int }.
  if (payload.workouts !== undefined && payload.workouts !== null) {
    if (!Array.isArray(payload.workouts)) return "`workouts` must be an array";
    if (payload.workouts.length > 20) return "`workouts` has too many entries";
    const list = [];
    for (const w of payload.workouts) {
      if (!w || typeof w !== "object" || Array.isArray(w)) return "each workout must be an object";
      if (typeof w.type !== "string" || !w.type.trim()) return "each workout needs a non-empty `type`";
      if (typeof w.minutes !== "number" || !isFinite(w.minutes) || w.minutes < 0) {
        return "each workout needs a non-negative `minutes`";
      }
      list.push({ type: w.type.trim().slice(0, 60), minutes: Math.round(w.minutes) });
    }
    out.workouts = list;
  }
  return "";
}

// ─── Rich sleep parsing ────────────────────────────────────────────────────────
// Parse Apple Health raw sleep samples — a newline-separated string of
// `value|startISO|endISO` lines — into a compact record. Values are matched
// case-insensitively (Core/Deep/REM/Awake/Asleep/InBed and Asleep* variants);
// junk lines and unknown values are tolerated (skipped). Overlapping samples are
// merged per stage (Garmin/Apple double-write the same span), and total sleep is
// the merged union of the asleep-type stages only (excludes Awake and InBed).
function parseSleepRaw(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const byStage = { deep: [], core: [], rem: [], awake: [], asleep: [] };
  let earliestStart = null, latestEnd = null, bedStr = null, wakeStr = null;
  const lines = raw.split(/\r?\n/).slice(0, 2000); // sanity cap
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 3) continue;                 // not a sample line → junk
    const val = parts[0].trim().toLowerCase();
    const startStr = parts[1].trim(), endStr = parts[2].trim();
    const s = Date.parse(startStr), e = Date.parse(endStr);
    if (!isFinite(s) || !isFinite(e) || e <= s) continue; // unparseable / zero-length
    let stage;
    if (val.includes("deep")) stage = "deep";
    else if (val.includes("rem")) stage = "rem";
    else if (val.includes("core")) stage = "core";
    else if (val.includes("awake") || val.includes("wake")) stage = "awake";
    else if (val.includes("inbed") || val.includes("in bed")) stage = "inbed";
    else if (val.includes("asleep") || val.includes("sleep")) stage = "asleep";
    else continue;                                  // unrecognised value → junk
    // bed/wake span across every recognised sample (incl. InBed / Awake).
    if (earliestStart === null || s < earliestStart) { earliestStart = s; bedStr = startStr; }
    if (latestEnd === null || e > latestEnd) { latestEnd = e; wakeStr = endStr; }
    if (stage === "inbed") continue;                // spans the night; not a stage bucket
    byStage[stage].push([s, e]);
  }
  const dur = (iv) => Math.round(mergeIntervals(iv).reduce((sum, [a, b]) => sum + (b - a), 0) / 60000);
  const stages = { deep: dur(byStage.deep), core: dur(byStage.core), rem: dur(byStage.rem), awake: dur(byStage.awake) };
  const totalMin = dur([].concat(byStage.deep, byStage.core, byStage.rem, byStage.asleep));
  if (totalMin <= 0 && bedStr === null) return null; // nothing usable
  const out = {};
  if (totalMin > 0) out.sleep_hours = Math.round((totalMin / 60) * 10) / 10;
  if (stages.deep || stages.core || stages.rem || stages.awake) out.sleep_stages = stages;
  if (bedStr) out.bed_time = sleepHHMM(bedStr);
  if (wakeStr) out.wake_time = sleepHHMM(wakeStr);
  return out;
}

// Merge a list of [start,end] epoch-ms intervals into non-overlapping spans.
function mergeIntervals(arr) {
  if (!arr.length) return [];
  const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

// "HH:MM" wall-clock from an ISO timestamp's local time part (Apple writes the
// offset, so the time portion is already the user's local clock).
function sleepHHMM(iso) {
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? m[1] + ":" + m[2] : undefined;
}

// A bed_time "HH:MM" → minutes, normalised so late-evening times stay continuous
// across midnight (00:00–11:59 treated as after-midnight, +24h). Used for
// averaging and comparing bedtimes without a midnight discontinuity.
function bedMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  let v = (+m[1]) * 60 + (+m[2]);
  if (v < 12 * 60) v += 24 * 60;
  return v;
}

// Prior days' normalised bed_times (excluding `date`), most recent `n`.
async function priorBedTimes(env, date, n) {
  const map = await recentHealth(env, n + 6);
  const out = [];
  for (const d of Object.keys(map)) {
    if (d >= date) continue;
    const bm = bedMinutes(map[d] && map[d].bed_time);
    if (bm != null) out.push(bm);
  }
  return out.slice(-n);
}

// Iris sleep score (0–100), modelled on Apple's published rubric:
//   • Duration      (max 50): linear against an 8h target.
//   • Consistency   (max 30): vs the rolling average bed_time — full marks within
//                             +30min or earlier, decaying as the night runs later.
//   • Interruptions (max 20): full unless awake-stage minutes exceed the first 10,
//                             then deduct ½ point per extra awake minute.
// Components whose inputs are missing default to full (don't punish sparse data).
function computeSleepScore(entry, priorBeds) {
  const hrs = typeof entry.sleep_hours === "number" ? entry.sleep_hours : 0;
  const duration = Math.max(0, Math.min(50, (hrs / 8) * 50));

  let consistency = 30;
  const bm = bedMinutes(entry.bed_time);
  if (bm != null && Array.isArray(priorBeds) && priorBeds.length >= 3) {
    const avg = priorBeds.reduce((a, b) => a + b, 0) / priorBeds.length;
    const late = bm - avg;                       // positive = later than usual
    consistency = late <= 30 ? 30 : Math.max(0, 30 - (late - 30) / 6);
  }

  let interruptions = 20;
  const awake = entry.sleep_stages && typeof entry.sleep_stages.awake === "number" ? entry.sleep_stages.awake : null;
  if (awake != null) interruptions = Math.max(0, 20 - Math.max(0, awake - 10) / 2);

  return Math.round(duration + consistency + interruptions);
}

// Read the last `n` per-date health keys (health:<date>) as { date: entry }.
// KV list returns names sorted ascending, so the tail is the most recent days.
async function recentHealth(env, n) {
  try {
    const listed = await env.TODAY_KV.list({ prefix: "health:" });
    const names = (listed.keys || []).map((k) => k.name).sort();
    const recent = names.slice(-n);
    const out = {};
    await Promise.all(recent.map(async (name) => {
      const v = safeParse(await env.TODAY_KV.get(name));
      if (v) out[name.slice("health:".length)] = v;
    }));
    return out;
  } catch {
    return {};
  }
}

// The single most recent health entry (for coach context), as { date, ...entry }.
async function latestHealth(env) {
  const map = await recentHealth(env, 1);
  const dates = Object.keys(map);
  if (!dates.length) return null;
  return { date: dates[0], ...map[dates[0]] };
}

// Format the latest health entry as a compact context block for the coach.
function formatHealthForContext(h) {
  if (!h) return "";
  const lines = ["health_data (Apple Health / Garmin, latest available):", "  date: " + h.date];
  if (typeof h.sleep_hours === "number") {
    let s = "  sleep: " + h.sleep_hours + "h";
    if (h.bed_time && h.wake_time) s += " (" + h.bed_time + " → " + h.wake_time + ")";
    lines.push(s);
    if (typeof h.sleep_score === "number") lines.push("  sleep score: " + h.sleep_score + " (apple)");
    else if (typeof h.sleep_score_computed === "number") lines.push("  sleep score: " + h.sleep_score_computed + " (iris)");
    if (h.sleep_stages) {
      const st = h.sleep_stages;
      lines.push("  stages (min): deep " + (st.deep || 0) + ", core " + (st.core || 0) + ", rem " + (st.rem || 0) + ", awake " + (st.awake || 0));
    }
  } else if (h.bed_time && h.wake_time) {
    lines.push("  sleep: " + h.bed_time + " → " + h.wake_time);
  }
  if (typeof h.steps === "number") lines.push("  steps: " + h.steps);
  if (Array.isArray(h.workouts) && h.workouts.length) {
    lines.push("  workouts: " + h.workouts.map((w) => w.type + " " + w.minutes + "m").join(", "));
  }
  return lines.join("\n") + "\n";
}

// Validate the top-level shape of a Today payload before writing it to KV, so a
// broken scheduled run can't blank the dashboard. Requires the core arrays; the
// optional ones (files/inbox/slack) must be arrays or null when present.
function isValidTodayShape(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  for (const f of ["schedule", "deadlines", "tasks"]) {
    if (!Array.isArray(o[f])) return false;
  }
  for (const f of ["files", "inbox", "slack"]) {
    if (o[f] != null && !Array.isArray(o[f])) return false;
  }
  return true;
}

// Constant-time string comparison so the edit token can't be guessed via timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
