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
      const [genStr, ovrStr] = await Promise.all([
        env.TODAY_KV.get("today"),
        env.TODAY_KV.get("today_overrides"),
      ]);
      if (genStr == null && ovrStr == null) {
        return json({ error: "not found" }, 404, corsHeaders(allowOrigin));
      }
      const payload = {
        generated: genStr ? safeParse(genStr) : null,
        overrides: ovrStr ? safeParse(ovrStr) : null,
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

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders(allowOrigin));
    }

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

    // Static coaching prompt first (cacheable), volatile per-message context after.
    const system = [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ];
    if (context) system.push({ type: "text", text: context });

    let apiResp;
    try {
      apiResp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
      });
    } catch (err) {
      return json({ error: "Could not reach the coaching service" }, 502, corsHeaders(allowOrigin));
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
  },
};

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
