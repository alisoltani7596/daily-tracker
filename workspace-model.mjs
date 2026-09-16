const STATUSES = ["todo", "doing", "waiting", "done"];
const STATUS_LABELS = { todo: "To do", doing: "In progress", waiting: "Waiting", done: "Completed" };
const COLORS = ["#497a68", "#587ca3", "#956da0", "#b17b45", "#657e8a", "#92715b"];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID().replaceAll("-", "");
function dateKey(date = /* @__PURE__ */ new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function emptyState() {
  return { version: 1, projects: [], tasks: [], events: [], habits: [], settings: { hiddenCards: [], cardOrder: ["tasks", "schedule", "deadlines", "habits", "inbox", "slack"], stepsGoal: 6e3 }, history: [] };
}
function seedState(data = {}, now = /* @__PURE__ */ new Date()) {
  const s = emptyState();
  const task = (t, projectId = "") => ({ id: uid(), title: t.n || "Untitled task", projectId, status: t.done ? "done" : "todo", priority: t.hi ? "high" : "normal", due: "", notes: "", today: !projectId, createdAt: now.toISOString() });
  for (const p of data.projects || []) {
    const id = uid();
    s.projects.push({ id, name: p.name, color: COLORS[s.projects.length % COLORS.length], notes: "", docUrl: p.url === "#" ? "" : p.url || "", syncEnabled: false });
    s.tasks.push(...(p.tasks || []).map((t) => task(t, id)));
  }
  s.tasks.push(...(data.tasks || []).map((t) => task(t)));
  for (const d of data.deadlines || []) {
    let due = "";
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(d.m).slice(0, 3).toLowerCase());
    if (month >= 0 && Number(d.d) > 0) {
      let year = new Date(data.updated || now).getFullYear();
      const candidate = new Date(year, month, Number(d.d), 12);
      if (candidate < new Date(data.updated || now))
        year++;
      due = `${year}-${String(month + 1).padStart(2, "0")}-${String(Number(d.d)).padStart(2, "0")}`;
    }
    s.tasks.push({ ...task({ n: d.n }), due, today: false, kind: "deadline" });
  }
  const base = new Date(data.updated || now);
  (data.schedule || []).forEach((day, i) => {
    const at = new Date(base);
    at.setDate(at.getDate() + i);
    const date = dateKey(at);
    for (const item of day.items || []) {
      const m = String(item.t || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!m)
        continue;
      let h = +m[1];
      if (m[3])
        h = h % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0);
      const start = `${String(h).padStart(2, "0")}:${m[2]}`;
      const endMin = Math.min(h * 60 + +m[2] + 30, 1439);
      s.events.push({ id: uid(), title: item.n, date, start, end: `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`, notes: "", syncEnabled: false, source: "snapshot" });
    }
  });
  return s;
}
function visibleTasks(state, { query = "", project = "all", filter = "all", today = dateKey() } = {}) {
  const q = query.trim().toLowerCase();
  return state.tasks.filter((t) => !t.deletedAt && !state.projects.find((p) => p.id === t.projectId)?.archived && (project === "all" || t.projectId === project) && (!q || [t.title, t.notes, state.projects.find((p) => p.id === t.projectId)?.name].join(" ").toLowerCase().includes(q)) && (filter === "all" || filter === "today" && (t.today || t.due === today) || filter === "upcoming" && t.due > today && t.status !== "done" || filter === "waiting" && t.status === "waiting" || filter === "completed" && t.status === "done" || filter === "open" && t.status !== "done" || filter === "overdue" && t.due && t.due < today && t.status !== "done"));
}
function validateState(s) {
  if (!s || s.version !== 1)
    throw new Error("Unsupported workspace version");
  for (const key of ["tasks", "projects", "events", "habits"]) {
    if (!Array.isArray(s[key]) || s[key].length > 3e3)
      throw new Error(`Invalid ${key}`);
    const ids = /* @__PURE__ */ new Set();
    for (const item of s[key]) {
      if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id))
        throw new Error(`Invalid or duplicate ${key} ID`);
      ids.add(item.id);
    }
  }
  for (const t of s.tasks)
    if (typeof t.title !== "string" || !t.title.trim() || !STATUSES.includes(t.status) || t.title.length > 1e3 || !validDate(t.due))
      throw new Error("Invalid task");
  for (const p of s.projects)
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 200 || p.color && !/^#[0-9a-f]{6}$/i.test(p.color) || p.docUrl && !docId(p.docUrl))
      throw new Error("Enter a valid Google Docs or Drive document link");
  for (const e of s.events) {
    const time = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (!e.title?.trim() || !e.date || !validDate(e.date) || !validDate(e.endDate || "") || e.endDate && e.endDate < e.date || (e.allDay ? !e.endDate || e.endDate <= e.date : !time(e.start) || !time(e.end) || (!e.endDate || e.endDate === e.date) && e.end <= e.start))
      throw new Error("Events must end after they start");
  }
  for (const h of s.habits)
    if (!h.title?.trim())
      throw new Error("Habit needs a name");
  if (!s.settings || !Array.isArray(s.settings.hiddenCards) || !Array.isArray(s.settings.cardOrder) || !Number.isFinite(+s.settings.stepsGoal) || +s.settings.stepsGoal < 1)
    throw new Error("Invalid settings");
  if (!Array.isArray(s.history) || s.history.length > 1e3)
    throw new Error("Invalid edit history");
  if (JSON.stringify(s).length > 75e4)
    throw new Error("Workspace is too large");
  return s;
}
function validDate(s) {
  return !s || /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
function docId(url) {
  try {
    const u = new URL(url);
    if (!["docs.google.com", "drive.google.com"].includes(u.hostname))
      return "";
    return u.pathname.match(/\/(?:document\/d|file\/d)\/([\w-]+)/)?.[1] || "";
  } catch {
    return "";
  }
}
function taskFingerprint(tasks) {
  return JSON.stringify(tasks.filter((t) => !t.deletedAt).map((t) => ({ id: t.id, title: t.title, status: t.status, due: t.due || "", priority: t.priority || "normal", notes: t.notes || "" })));
}
function eventFingerprint(e) {
  return JSON.stringify({ title: e.title, date: e.date, start: e.start, end: e.end, notes: e.notes || "", deletedAt: e.deletedAt || "", ...e.allDay ? { allDay: true, endDate: e.endDate } : e.endDate && e.endDate !== e.date ? { endDate: e.endDate } : {} });
}
function docText(tasks) {
  return tasks.filter((t) => !t.deletedAt).map((t) => `[${t.status === "done" ? "x" : " "}] ${t.title.replace(/[\r\n]/g, " ")}
IRIS ${JSON.stringify({ id: t.id, status: t.status, due: t.due || "", priority: t.priority || "normal", notes: t.notes || "" })}
`).join("\n");
}
function parseDocText(text, projectId) {
  const lines = text.trim().split("\n");
  if (!text.trim())
    return [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim())
      continue;
    const m = lines[i].match(/^\[([ xX])\] (.+)$/);
    if (!m || !lines[i + 1]?.startsWith("IRIS "))
      throw new Error("The IRIS section format changed. Keep each task checkbox and its IRIS metadata line together.");
    const meta = JSON.parse(lines[++i].slice(5));
    out.push({ ...meta, title: m[2], projectId, status: m[1].toLowerCase() === "x" ? "done" : meta.status === "done" ? "todo" : meta.status, today: false });
  }
  if (new Set(out.map((t) => t.id)).size !== out.length)
    throw new Error("Duplicate task IDs in Google Doc");
  return out;
}
export {
  COLORS,
  STATUSES,
  STATUS_LABELS,
  clone,
  dateKey,
  docId,
  docText,
  emptyState,
  eventFingerprint,
  parseDocText,
  seedState,
  taskFingerprint,
  uid,
  validateState,
  visibleTasks
};
