import { clone, validateState, docId, taskFingerprint, eventFingerprint, docText, parseDocText, uid } from "../../workspace-model.mjs";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const configured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
class Workspace {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }
  async fetch(request) {
    const operation = this.queue.then(async () => {
      let saved = await this.ctx.storage.get("workspace") || { revision: 0, state: null };
      if (request.method === "GET")
        return json({ ...saved, googleConfigured: configured(this.env) });
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (new URL(request.url).pathname === "/legacy-task-add") {
        if (!saved.state)
          return json({ handled: false });
        const title = String(body.n || "").trim().slice(0, 300);
        if (!title)
          return json({ error: "Task name is required" }, 400);
        if (saved.state.tasks.some((t) => !t.deletedAt && t.title === title))
          return json({ handled: true, ok: true, dup: true });
        saved.state.tasks.push({ id: uid(), title, projectId: "", status: "todo", priority: body.hi ? "high" : "normal", due: /^\d{4}-\d{2}-\d{2}$/.test(body.due || "") ? body.due : "", notes: "", today: true });
        saved.revision++;
        await this.ctx.storage.put("workspace", saved);
        return json({ handled: true, ok: true });
      }
      if (body.revision !== saved.revision)
        return json({ error: "Workspace changed on another device. Review before replacing it." }, 409);
      let state;
      try {
        state = clone(validateState(body.state));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
      for (const p of state.projects) {
        const old = saved.state?.projects.find((x) => x.id === p.id);
        for (const key of ["docBase", "localBase", "lastSynced", "syncError"]) {
          delete p[key];
          if (old && old.docUrl === p.docUrl && p.syncEnabled && old[key] != null)
            p[key] = old[key];
        }
      }
      for (const e of state.events) {
        const old = saved.state?.events.find((x) => x.id === e.id);
        for (const key of ["googleId", "googleEtag", "googleBase", "lastSynced", "syncError"]) {
          delete e[key];
          if (old?.[key] != null)
            e[key] = old[key];
        }
      }
      let syncErrors = [];
      saved = { revision: saved.revision + 1, state };
      await this.ctx.storage.put("workspace", saved);
      if (configured(this.env)) {
        try {
          const google = await googleClient(this.env);
          if (body.action === "import-calendar")
            await importCalendar(state, google, this.env);
          if (body.resolve) {
            await resolveConflict(state, google, this.env, body.resolve);
          }
          for (const p of state.projects.filter((p2) => p2.syncEnabled && !p2.archived)) {
            try {
              await syncDocument(state, p, google);
              delete p.syncError;
            } catch (e) {
              p.syncError = e.message;
              syncErrors.push(`${p.name}: ${e.message}`);
            }
            await this.ctx.storage.put("workspace", saved);
          }
          for (const e of state.events.filter((e2) => e2.syncEnabled && !e2.deletedAt)) {
            try {
              await syncEvent(e, google, this.env);
              delete e.syncError;
            } catch (err) {
              e.syncError = err.message;
              syncErrors.push(`${e.title}: ${err.message}`);
            }
            await this.ctx.storage.put("workspace", saved);
          }
        } catch (e) {
          syncErrors.push(e.message);
        }
      } else if (body.action || body.resolve) {
        syncErrors.push("Google authorization has not been configured on the server.");
      }
      await this.ctx.storage.put("workspace", saved);
      return json({ ...saved, googleConfigured: configured(this.env), syncErrors });
    });
    this.queue = operation.catch(() => {
    });
    return operation;
  }
}
async function googleClient(env, fetcher = fetch) {
  const response = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }), signal: AbortSignal.timeout(1e4) });
  const data = await response.json();
  if (!response.ok || !data.access_token)
    throw Error("Google connection expired or was rejected. Reconnect Google on the server.");
  return async (path, options = {}) => {
    const r = await fetcher(path, { ...options, headers: { Authorization: `Bearer ${data.access_token}`, "content-type": "application/json", ...options.headers }, signal: AbortSignal.timeout(1e4) });
    if (!r.ok) {
      const e = Error(r.status === 412 || r.status === 409 ? "Google changed during sync. Retry to review the latest version." : `Google request failed (${r.status}). Check access to this item.`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? {} : r.json();
  };
}
const markers = (id) => ({ start: `IRIS TASKS START ${id}
`, end: `IRIS TASKS END ${id}
` });
function documentSection(doc, id) {
  const runs = [];
  function walk(elements) {
    for (const el of elements || []) {
      for (const item of el.paragraph?.elements || [])
        if (item.textRun)
          runs.push({ index: item.startIndex, text: item.textRun.content });
      for (const row of el.table?.tableRows || [])
        for (const cell of row.tableCells || [])
          walk(cell.content);
    }
  }
  walk(doc.body?.content);
  let text = "", positions = [];
  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++)
      positions.push(run.index + i);
    text += run.text;
  }
  const m = markers(id), a = text.indexOf(m.start), b = text.indexOf(m.end, a < 0 ? 0 : a + m.start.length);
  if (a < 0 && b < 0)
    return null;
  if (a < 0 || b < 0 || text.indexOf(m.start, a + 1) >= 0 || text.indexOf(m.end, b + 1) >= 0)
    throw Error("IRIS section markers were changed or duplicated. Restore the section markers before syncing.");
  const start = a + m.start.length;
  return { text: text.slice(start, b), startIndex: positions[start], endIndex: positions[b] };
}
async function syncDocument(state, project, google) {
  const id = docId(project.docUrl);
  if (!id)
    throw Error("Add a valid Google Doc link.");
  const path = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`;
  const doc = await google(path);
  const section = documentSection(doc, project.id);
  const tasks = state.tasks.filter((t) => t.projectId === project.id), local = taskFingerprint(tasks);
  if (section && project.docBase == null) {
    const parsed = parseDocText(section.text, project.id);
    if (taskFingerprint(parsed) !== local)
      throw Error("An existing IRIS section needs review. Choose Google or IRIS in project settings.");
  }
  if (project.docBase != null) {
    if (!section)
      throw Error("The IRIS section was removed in Google Docs. Restore it before syncing.");
    const remoteChanged = section.text !== project.docBase, localChanged = local !== project.localBase;
    if (remoteChanged && section.text === docText(tasks)) {
      project.docBase = section.text;
      project.localBase = local;
      project.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    if (remoteChanged && localChanged)
      throw Error("Both IRIS and Google Docs changed. Choose which version to keep in project settings.");
    if (remoteChanged) {
      applyRemoteTasks(state, project, parseDocText(section.text, project.id));
      project.docBase = section.text;
      project.localBase = taskFingerprint(state.tasks.filter((t) => t.projectId === project.id));
      project.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    if (!localChanged) {
      project.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
  }
  const text = docText(tasks);
  const requests = [];
  if (section) {
    if (section.endIndex > section.startIndex)
      requests.push({ deleteContentRange: { range: { startIndex: section.startIndex, endIndex: section.endIndex } } });
    if (text)
      requests.push({ insertText: { location: { index: section.startIndex }, text } });
  } else {
    const m = markers(project.id);
    requests.push({ insertText: { endOfSegmentLocation: {}, text: `
${m.start}${text}${m.end}` } });
  }
  if (requests.length)
    await google(path + ":batchUpdate", { method: "POST", body: JSON.stringify({ writeControl: { requiredRevisionId: doc.revisionId }, requests }) });
  project.docBase = text;
  project.localBase = local;
  project.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
}
function applyRemoteTasks(state, project, parsed) {
  const foreign = new Set(state.tasks.filter((t) => t.projectId !== project.id).map((t) => t.id));
  if (parsed.some((t) => foreign.has(t.id)))
    throw Error("Google section contains an ID belonging to another project.");
  validateState({ ...state, tasks: [...state.tasks.filter((t) => t.projectId !== project.id), ...parsed] });
  const ids = new Set(parsed.map((t) => t.id));
  for (const t of state.tasks.filter((t2) => t2.projectId === project.id)) {
    if (!ids.has(t.id))
      t.deletedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  for (const t of parsed) {
    const old = state.tasks.find((x) => x.id === t.id);
    if (old) {
      const today = old.today;
      Object.assign(old, t, { today });
      delete old.deletedAt;
    } else
      state.tasks.push(t);
  }
}
function eventPath(env, id = "") {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary")}/events${id ? "/" + encodeURIComponent(id) : ""}`;
}
function calendarValues(event) {
  if (!event.start?.dateTime || !event.end?.dateTime)
    throw Error("Only timed, same-day events can be edited in this version.");
  const date = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
  const time = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Vancouver", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));
  if (date(event.start.dateTime) !== date(event.end.dateTime))
    throw Error("Multi-day events stay in Google Calendar.");
  return { title: event.summary || "Untitled event", date: date(event.start.dateTime), start: time(event.start.dateTime), end: time(event.end.dateTime), notes: event.description || "" };
}
async function syncEvent(event, google, env) {
  let remote = null;
  if (event.googleId) {
    remote = await google(eventPath(env, event.googleId));
    if (remote.status === "cancelled")
      throw Error("This event was cancelled in Google Calendar. Remove it from IRIS or restore it in Calendar.");
    const remoteValues = calendarValues(remote);
    const changed = event.googleBase && eventFingerprint(event) !== event.googleBase;
    if (event.googleEtag && remote.etag !== event.googleEtag) {
      if (changed && eventFingerprint(remoteValues) !== eventFingerprint(event))
        throw Error("Both IRIS and Calendar changed. Choose a version in the event editor.");
      Object.assign(event, remoteValues);
      event.googleEtag = remote.etag;
      event.googleBase = eventFingerprint(event);
      event.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    if (event.googleBase && !changed) {
      event.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
  }
  const payload = { summary: event.title, description: event.notes || "", start: { dateTime: `${event.date}T${event.start}:00`, timeZone: "America/Vancouver" }, end: { dateTime: `${event.date}T${event.end}:00`, timeZone: "America/Vancouver" } };
  let result;
  if (event.googleId)
    result = await google(eventPath(env, event.googleId) + "?sendUpdates=none", { method: "PATCH", headers: { "If-Match": remote.etag }, body: JSON.stringify(payload) });
  else {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(event.id));
    const stable = "iris" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      result = await google(eventPath(env) + "?sendUpdates=none", { method: "POST", body: JSON.stringify({ ...payload, id: stable }) });
    } catch (e) {
      if (e.status !== 409)
        throw e;
      result = await google(eventPath(env, stable));
      if (eventFingerprint(calendarValues(result)) !== eventFingerprint(event))
        throw Error("A previous event creation exists with different content. Import Calendar to review it.");
    }
  }
  event.googleId = result.id;
  event.googleEtag = result.etag;
  event.googleBase = eventFingerprint(event);
  event.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
}
async function importCalendar(state, google, env) {
  const now = /* @__PURE__ */ new Date();
  const until = new Date(now.getTime() + 30 * 864e5);
  let page = "";
  do {
    const params = new URLSearchParams({ timeMin: now.toISOString(), timeMax: until.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    if (page)
      params.set("pageToken", page);
    const data = await google(eventPath(env) + "?" + params);
    for (const remote of data.items || []) {
      if (remote.status === "cancelled")
        continue;
      let values;
      try {
        values = calendarValues(remote);
      } catch {
        continue;
      }
      let local = state.events.find((e) => e.googleId === remote.id);
      if (local)
        continue;
      local = state.events.find((e) => !e.googleId && !e.deletedAt && e.title === values.title && e.date === values.date && e.start === values.start);
      if (!local) {
        local = { id: uid(), ...values, syncEnabled: false, source: "google" };
        state.events.push(local);
      }
      Object.assign(local, { googleId: remote.id, googleEtag: remote.etag, googleBase: eventFingerprint(values), source: "google" });
    }
    page = data.nextPageToken || "";
  } while (page);
}
async function resolveConflict(state, google, env, resolve) {
  if (!["iris", "google"].includes(resolve.choice))
    throw Error("Choose IRIS or Google.");
  if (resolve.kind === "project") {
    const p = state.projects.find((p2) => p2.id === resolve.id);
    if (!p?.syncEnabled)
      throw Error("Project is not linked.");
    const doc = await google(`https://docs.googleapis.com/v1/documents/${docId(p.docUrl)}`), section = documentSection(doc, p.id);
    if (!section)
      throw Error("Restore the IRIS section in the document first.");
    if (resolve.choice === "google")
      applyRemoteTasks(state, p, parseDocText(section.text, p.id));
    p.docBase = section.text;
    p.localBase = resolve.choice === "google" ? taskFingerprint(state.tasks.filter((t) => t.projectId === p.id)) : "explicit-local-choice";
  } else if (resolve.kind === "event") {
    const e = state.events.find((e2) => e2.id === resolve.id);
    if (!e?.googleId)
      throw Error("Event is not linked.");
    const remote = await google(eventPath(env, e.googleId));
    if (resolve.choice === "google")
      Object.assign(e, calendarValues(remote));
    e.googleEtag = remote.etag;
    e.googleBase = resolve.choice === "google" ? eventFingerprint(e) : "explicit-local-choice";
  }
}
export {
  Workspace,
  calendarValues,
  documentSection,
  googleClient,
  importCalendar,
  syncDocument,
  syncEvent
};
