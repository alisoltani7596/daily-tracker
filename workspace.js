import { STATUSES, STATUS_LABELS, COLORS, clone, uid, dateKey, emptyState, seedState, visibleTasks, validateState } from "./workspace-model.mjs?v=62";
const KEY = "iris_workspace_v1", QUEUE = "iris_workspace_pending_v1";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const read = (k, f) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? f;
  } catch {
    return f;
  }
};
let envelope = read(KEY, null);
try {
  if (envelope)
    validateState(envelope.state);
} catch {
  envelope = null;
}
let state = envelope?.state || emptyState(), revision = envelope?.revision || 0;
let dirty = read(QUEUE, false), busy = false, generation = 0, saveTimer, undoState = null, status = "Saved on this device", cloudReady = false, googleReady = false, cloudConflict = false;
let route = "today", view = localStorage.getItem("iris_workspace_view") || "list", filter = "open", project = "all", query = "", customize = false, showTrash = false;
const root = document.createElement("main");
root.id = "workspace";
root.setAttribute("aria-label", "Personal workspace");
const side = document.createElement("aside");
side.className = "ws-sidebar";
side.setAttribute("aria-label", "Main navigation");
const dialog = document.createElement("dialog");
dialog.className = "ws-dialog";
dialog.setAttribute("aria-labelledby", "ws-dialog-title");
document.body.append(side, root, dialog);
document.body.classList.add("ws-on");
const base = () => typeof todayWorkerBase === "function" ? todayWorkerBase() : "";
const token = () => localStorage.getItem("today_edit_token") || "";
const icon = { today: "\u25F7", projects: "\u25A4", tracker: "\u2661", coach: "\u25CC", settings: "\u2699" };
const names = { today: "Today", projects: "Projects", tracker: "Health", coach: "Coach", settings: "Settings" };
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ state, revision }));
    localStorage.setItem(QUEUE, JSON.stringify(dirty));
    return true;
  } catch {
    status = "Storage full \u2014 export a backup before closing";
    return false;
  }
}
function toast(message, undo = false) {
  document.querySelector(".ws-toast")?.remove();
  const el = document.createElement("div");
  el.className = "ws-toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? "<button data-undo>Undo</button>" : ""}`;
  el.querySelector("button")?.addEventListener("click", doUndo);
  document.body.append(el);
  setTimeout(() => el.remove(), 6500);
}
function doUndo() {
  if (!undoState)
    return;
  const previous = undoState;
  undoState = null;
  state = previous;
  changed("Undid last change", false);
  toast("Change undone");
}
function changed(label, record = true) {
  generation++;
  dirty = true;
  if (record) {
    state.history.unshift({ id: uid(), label, at: (/* @__PURE__ */ new Date()).toISOString() });
    state.history = state.history.slice(0, 80);
  }
  persist();
  status = navigator.onLine ? "Saved on this device" : "Offline \xB7 saved on this device";
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCloud, 800);
}
function mutate(label, fn) {
  undoState = clone(state);
  fn();
  changed(label);
  toast(label, true);
}
function navigate(next) {
  route = names[next] ? next : "today";
  setTab(route);
  root.hidden = ["tracker", "coach"].includes(route);
  query = "";
  showTrash = false;
  render();
  if (route === "tracker")
    addHealthTools();
  if (route === "coach")
    addCoachTools();
  if (cloudReady && !dirty && !busy)
    loadCloud();
}
function addHealthTools() {
  if (document.getElementById("ws-health-header"))
    return;
  const heading = document.createElement("div");
  heading.id = "ws-health-header";
  heading.className = "ws-top";
  heading.style.order = "-1";
  heading.innerHTML = '<div><div class="ws-eyebrow">YOUR WELLBEING</div><h1>Health</h1><p>Your training, daily habits, and progress.</p></div><button class="ws-btn" id="ws-health-settings">Manage habits & goals</button>';
  document.querySelector(".page")?.prepend(heading);
  heading.querySelector("button").onclick = () => navigate("settings");
}
function addCoachTools() {
  if (document.getElementById("ws-coach-starters"))
    return;
  const starters = document.createElement("div");
  starters.id = "ws-coach-starters";
  starters.className = "ws-toolbar";
  starters.style.cssText = "padding:12px 18px;margin:0;";
  for (const [label, prompt] of [["Plan my day", "Help me organize today using my current IRIS tasks and schedule."], ["I\u2019m stuck", "Help me break down the task I am avoiding. Ask me one question at a time."], ["Review my week", "Help me review my progress and organize next week."]]) {
    const b = document.createElement("button");
    b.className = "ws-btn small";
    b.textContent = label;
    b.onclick = () => {
      const input2 = document.getElementById("coach-input");
      input2.value = prompt;
      input2.focus();
    };
    starters.append(b);
  }
  document.getElementById("coach-seg")?.after(starters);
}
function renderSide() {
  side.innerHTML = `<div class="ws-brand">IRIS<small>Your personal workspace</small></div><nav class="ws-nav">${Object.keys(names).map((k) => `<button data-nav="${k}" ${route === k ? 'aria-current="page"' : ""}><span aria-hidden="true" class="ws-nav-icon">${icon[k]}</span>${names[k]}</button>`).join("")}</nav><div class="ws-sidebar-bottom"><span>Everything in its place.</span><div class="ws-sync ${/error|conflict|failed|full/i.test(status) ? "error" : ""}" role="status">${esc(status)}</div><button class="ws-btn small" data-sync ${busy ? "disabled" : ""}>${busy ? "Saving\u2026" : "Sync now"}</button></div>`;
}
function header(title, subtitle, actions = "") {
  return `<div class="ws-top"><div><div class="ws-eyebrow">${esc((/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="ws-top-actions"><label class="ws-search"><span aria-hidden="true">\u2315</span><input aria-label="Search workspace" id="ws-search" placeholder="Search everything" value="${esc(query)}"></label>${actions}</div></div>`;
}
const button = (label, action, cls = "") => `<button class="ws-btn ${cls}" data-action="${action}">${label}</button>`;
function panel(title, body, action = "", sub = "") {
  return `<section class="ws-panel"><div class="ws-panel-head"><div><h2>${title}</h2>${sub ? `<div class="ws-subtitle">${sub}</div>` : ""}</div>${action}</div><div class="ws-panel-body">${body}</div></section>`;
}
function empty(title, detail = "") {
  return `<div class="ws-empty"><strong>${title}</strong>${detail}</div>`;
}
function taskRow(t) {
  const p = state.projects.find((p2) => p2.id === t.projectId);
  return `<article class="ws-task ${t.status === "done" ? "done" : ""}" draggable="${view === "board"}" data-task-id="${t.id}"><input class="ws-check" type="checkbox" aria-label="Complete ${esc(t.title)}" data-check="${t.id}" ${t.status === "done" ? "checked" : ""}><div class="ws-task-content"><button class="ws-task-title" data-edit-task="${t.id}">${esc(t.title)}</button><div class="ws-task-meta">${p ? `<span><i class="ws-dot" style="--project-color:${esc(p.color)}"></i>${esc(p.name)}</span>` : "<span>Inbox</span>"}${t.priority === "high" ? '<span class="ws-priority">High priority</span>' : ""}${t.due ? `<span class="${t.due < dateKey() && t.status !== "done" ? "ws-overdue" : ""}">${esc(t.due)}</span>` : ""}${t.today ? "<span>Today</span>" : ""}${view !== "board" ? `<span>${STATUS_LABELS[t.status]}</span>` : ""}</div></div><button class="ws-task-edit" aria-label="Edit ${esc(t.title)}" data-edit-task="${t.id}">\u22EF</button></article>`;
}
function capture() {
  return '<form id="ws-capture" class="ws-capture"><input class="ws-field" name="title" aria-label="Quick capture task" placeholder="Add a task or capture a thought\u2026" maxlength="1000" required><button class="ws-btn primary" type="submit">Add</button></form>';
}
function render() {
  bridgeHabits();
  renderSide();
  if (root.hidden)
    return;
  const searchFocus = document.activeElement?.id === "ws-search";
  const caret = searchFocus ? document.activeElement.selectionStart : 0;
  root.innerHTML = (cloudConflict ? `<div class="ws-notice"><p>Another device has newer changes. Your local edits are safe. Export them before loading the server version.</p>${button("Export local backup", "export")}${button("Load server version", "load-server")}</div>` : "") + (query ? renderSearch() : route === "projects" ? renderProjects() : route === "settings" ? renderSettings() : renderTodayView());
  if (searchFocus) {
    const el = document.getElementById("ws-search");
    el?.focus();
    el?.setSelectionRange(caret, caret);
  }
}
function renderTodayView() {
  const active = visibleTasks(state, { filter: "open" }), today = active.filter((t) => t.today || t.due === dateKey()), overdue = active.filter((t) => t.due && t.due < dateKey());
  const events = state.events.filter((e) => !e.deletedAt && e.date === dateKey()).sort((a, b) => a.start.localeCompare(b.start));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Vancouver", hour: "2-digit", minute: "2-digit" }).format(/* @__PURE__ */ new Date());
  const next = events.find((e) => e.end > time)?.id;
  const schedule = events.map((e) => `<div class="ws-event ${e.end <= time ? "past" : ""} ${e.id === next ? "next" : ""}"><time>${esc(e.start)}</time><div class="ws-task-content"><button class="ws-task-title" data-edit-event="${e.id}">${esc(e.title)}</button><div class="ws-task-meta">${esc(e.end)}${e.syncEnabled ? " \xB7 Google Calendar" : " \xB7 IRIS only"}</div></div>${e.id === next ? '<span class="ws-tag">NEXT</span>' : ""}</div>`).join("") || empty("Room in your day", "Add an event or connect Google Calendar.");
  const deadlines = active.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5);
  const habits = state.habits.filter((h) => !h.deletedAt && !h.hidden).map((h) => `<div class="ws-task"><input type="checkbox" class="ws-check" data-habit="${h.id}" aria-label="${esc(h.title)}" ${habitDone(h) ? "checked" : ""}><button class="ws-task-title" data-edit-habit="${h.id}">${esc(h.title)}</button></div>`).join("") || empty("Make room for a routine", "Add a habit you want to keep.");
  const data = window.__todayData || {};
  const messages = (items, kind) => items?.length ? items.slice(0, 4).map((m) => {
    let url = "";
    try {
      const u = new URL(m.url);
      if (u.protocol === "https:")
        url = u.href;
    } catch {
    }
    return `<${url ? "a" : "div"} class="ws-message" ${url ? `href="${esc(url)}" target="_blank" rel="noopener"` : ""}>${esc(m.from || m.who || "Message")}<small>${esc(m.subject || m.text || "")}</small></${url ? "a" : "div"}>`;
  }).join("") : empty(`No ${kind} to review`);
  const cards = { tasks: panel("Your focus", capture() + (today.length ? today.map(taskRow).join("") : empty("What matters today?", "Choose tasks from Projects or add one above.")), button("All tasks", "all-tasks", "small"), `${today.length} open \xB7 choose what belongs in today`), schedule: panel("Schedule", schedule, button("Manage", "events", "small"), "America/Vancouver"), deadlines: panel("Coming up", deadlines.length ? deadlines.map(taskRow).join("") : empty("No deadlines yet"), button("+ Deadline", "add-deadline", "small")), habits: panel("Daily habits", habits, button("+ Habit", "add-habit", "small")), inbox: panel("Inbox", messages(data.inbox, "emails"), "", "Latest dashboard snapshot"), slack: panel("Messages", messages(data.slack, "messages"), "", "Latest dashboard snapshot") };
  const order = [.../* @__PURE__ */ new Set([...state.settings.cardOrder, ...Object.keys(cards)])];
  return header("A little more organized.", "Your day, with space to focus.", button(customize ? "Done" : "Customize", "customize")) + `<div class="ws-summary"><div><b>${today.length}</b><span>For today</span></div><div><b>${active.length}</b><span>Open tasks</span></div><div><b>${overdue.length}</b><span>Past due</span></div><div><b>${state.projects.filter((p) => !p.archived).length}</b><span>Projects</span></div></div>${customize ? panel("Make this space yours", cardControls(), "", "Show, hide, and reorder your dashboard cards.") : ""}<div class="ws-grid" style="${customize ? "margin-top:22px" : ""}">${order.filter((id) => cards[id] && !state.settings.hiddenCards.includes(id)).map((id) => cards[id]).join("")}</div>`;
}
function renderProjects() {
  const tasks = visibleTasks(state, { project, filter });
  const current = state.projects.find((p) => p.id === project);
  return header(current?.name || "Projects & tasks", "One place for everything you\u2019re working on.", button("+ Task", "add-task", "primary")) + `<div class="ws-project-strip"><button class="ws-project-chip ${project === "all" ? "selected" : ""}" data-project="all">All tasks</button><button class="ws-project-chip ${project === "" ? "selected" : ""}" data-project="">Inbox</button>${state.projects.filter((p) => !p.archived).map((p) => `<button class="ws-project-chip ${project === p.id ? "selected" : ""}" data-project="${p.id}"><i class="ws-dot" style="--project-color:${esc(p.color)}"></i>${esc(p.name)}<small>${state.tasks.filter((t) => t.projectId === p.id && !t.deletedAt && t.status !== "done").length}</small></button>`).join("")}${button("+ Project", "add-project", "small")}</div><div class="ws-toolbar"><div class="ws-segment" aria-label="Task view"><button data-view="list" aria-pressed="${view === "list"}">List</button><button data-view="board" aria-pressed="${view === "board"}">Board</button></div><select class="ws-input" id="ws-filter" aria-label="Filter tasks">${Object.entries({ open: "Open tasks", all: "All tasks", today: "Today", upcoming: "Upcoming", overdue: "Past due", waiting: "Waiting", completed: "Completed" }).map(([k, v]) => `<option value="${k}" ${filter === k ? "selected" : ""}>${v}</option>`).join("")}</select><span class="ws-note">${tasks.length} tasks</span>${current ? `<button class="ws-btn small" data-edit-project="${current.id}">Edit project</button>` : ""}${button(showTrash ? "Hide trash" : "Trash", "trash", "small")}</div>${current?.notes ? `<p class="ws-project-note">${esc(current.notes)}</p>` : ""}${current?.syncEnabled ? `<div class="ws-notice"><p>Linked to Google Docs \xB7 ${esc(current.syncError || (current.lastSynced ? "Last sync: " + new Date(current.lastSynced).toLocaleString() : "Waiting for first sync"))}</p></div>` : ""}${showTrash ? renderTrash() : ""}${view === "board" ? `<div class="ws-board">${STATUSES.map((s) => `<section class="ws-column" data-drop-status="${s}" aria-label="${STATUS_LABELS[s]}"><div class="ws-column-head"><span>${STATUS_LABELS[s]}</span><span class="ws-count">${tasks.filter((t) => t.status === s).length}</span></div>${tasks.filter((t) => t.status === s).map(taskRow).join("") || '<div class="ws-empty">No tasks</div>'}<button class="ws-link" data-add-status="${s}">+ Add task</button></section>`).join("")}</div>` : panel("Tasks", capture() + (tasks.length ? tasks.map(taskRow).join("") : empty("All clear", "Add a task or choose a different filter.")))}`;
}
function renderTrash() {
  return panel("Recently removed", state.tasks.filter((t) => t.deletedAt).map((t) => `<div class="ws-setting-row"><span>${esc(t.title)}</span><button class="ws-btn small" data-restore-task="${t.id}">Restore</button></div>`).join("") || empty("Trash is empty"));
}
function renderSearch() {
  const q = query.toLowerCase(), tasks = visibleTasks(state, { query }), projects = state.projects.filter((p) => !p.archived && [p.name, p.notes].join(" ").toLowerCase().includes(q)), events = state.events.filter((e) => !e.deletedAt && [e.title, e.notes].join(" ").toLowerCase().includes(q)), habits = state.habits.filter((h) => !h.deletedAt && h.title.toLowerCase().includes(q));
  return header("Search", "Tasks, project notes, events, and habits.") + panel("Tasks", tasks.map(taskRow).join("") || empty("No matching tasks")) + `<div class="ws-grid" style="margin-top:22px">${panel("Projects", projects.map((p) => `<button class="ws-message ws-link" data-edit-project="${p.id}">${esc(p.name)}</button>`).join("") || empty("No matching projects"))}${panel("Events & habits", events.map((e) => `<button class="ws-message ws-link" data-edit-event="${e.id}">${esc(e.title)}<small>${e.date} \xB7 ${e.start}</small></button>`).join("") + habits.map((h) => `<button class="ws-message ws-link" data-edit-habit="${h.id}">${esc(h.title)}</button>`).join("") || empty("No matching events or habits"))}</div>`;
}
function cardControls() {
  return state.settings.cardOrder.map((id, i) => `<div class="ws-setting-row"><label><input type="checkbox" data-card-toggle="${id}" ${state.settings.hiddenCards.includes(id) ? "" : "checked"}>${{ tasks: "Your focus", schedule: "Schedule", deadlines: "Coming up", habits: "Daily habits", inbox: "Inbox", slack: "Messages" }[id]}</label><span><button class="ws-btn small" data-card-up="${id}" ${i === 0 ? "disabled" : ""} aria-label="Move ${id} up">\u2191</button> <button class="ws-btn small" data-card-down="${id}" ${i === state.settings.cardOrder.length - 1 ? "disabled" : ""} aria-label="Move ${id} down">\u2193</button></span></div>`).join("");
}
function renderSettings() {
  return header("Make IRIS yours.", "Your workspace, your preferences.") + `<div class="ws-settings-grid">${panel("Connections", `<p class="ws-note">${esc(status)}</p><label>Workspace access token<input type="password" autocomplete="off" class="ws-input" id="ws-token" placeholder="${token() ? "Token saved on this device" : "Enter your existing edit token"}"></label>${button("Save connection", "connect")}<p class="ws-note">Google Calendar & Docs: ${googleReady ? "connected" : "not connected to the new sync service yet"}. ${googleReady ? "Linked items sync automatically after edits." : "Connect your Google account to enable syncing. Your edits remain saved in IRIS."}</p>${button("Sync now", "sync")}${button("Import upcoming calendar events", "import-calendar")}<p class="ws-note">Project documents keep their existing content. Only the labeled IRIS section is synchronized. Calendar edits apply only to events you explicitly link.</p>`)}${panel("Appearance & goals", `<label>Appearance<select class="ws-input" id="ws-theme">${["light", "dark", "iris", "dusk"].map((t) => `<option ${document.documentElement.dataset.theme === t ? "selected" : ""}>${t}</option>`).join("")}</select></label><label>Daily steps goal<input class="ws-input" id="ws-steps" type="number" min="1" max="100000" value="${state.settings.stepsGoal}"></label>${button("Save goal", "save-goal")}<label>Coach voice<select class="ws-input" id="ws-coach-voice">${Array.from(document.getElementById("coach-voice-select")?.options || []).map((o) => `<option value="${esc(o.value)}" ${o.selected ? "selected" : ""}>${esc(o.text)}</option>`).join("")}</select></label><p class="ws-note">Workout plans can have separate session targets. This is your everyday goal.</p>`)}${panel("Dashboard", cardControls())}${panel("Habits & projects", `${state.habits.filter((h) => !h.deletedAt).map((h) => `<button class="ws-link" data-edit-habit="${h.id}">${esc(h.title)}</button>`).join("")}${button("+ Habit", "add-habit")}<p class="ws-note">Archived projects</p>${state.projects.filter((p) => p.archived).map((p) => `<div class="ws-setting-row"><span>${esc(p.name)}</span><button class="ws-btn small" data-restore-project="${p.id}">Restore</button></div>`).join("") || '<p class="ws-note">None archived.</p>'}`)}${panel("Backup & recovery", `${button("Export workspace backup", "export")}<label>Restore a workspace backup<input class="ws-input" type="file" accept="application/json,.json" id="ws-import"></label><p class="ws-note">Restoring replaces this workspace. Export first to keep a copy. Removed tasks can also be restored from Projects \u2192 Trash.</p>${button("Undo last change", "undo")}`)}${panel("Recent changes", `<ul class="ws-history">${state.history.slice(0, 12).map((h) => `<li>${esc(h.label)}<small>${esc(new Date(h.at).toLocaleString())}</small></li>`).join("") || "<li>No edits yet.</li>"}</ul>`)}</div>`;
}
function input(label, name, value = "", type = "text", extra = "") {
  return `<label>${label}<input class="ws-input" name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function select(label, name, options, value) {
  return `<label>${label}<select aria-label="${esc(label)}" class="ws-input" name="${name}">${Object.entries(options).map(([k, v]) => `<option value="${esc(k)}" ${k === value ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
}
function modal(title, fields, onSave, onDelete) {
  dialog.innerHTML = `<div class="ws-dialog-head"><h2 id="ws-dialog-title">${title}</h2><button class="ws-btn small" data-close aria-label="Close editor">\xD7</button></div><form>${fields}<div class="ws-form-error" role="alert"></div><div class="ws-dialog-footer"><span>${onDelete ? '<button type="button" class="ws-btn danger" data-delete>Move to trash</button>' : ""}</span><span><button type="button" class="ws-btn" data-close>Cancel</button> <button class="ws-btn primary" type="submit">Save changes</button></span></div></form>`;
  dialog.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => dialog.close());
  dialog.querySelector("[data-delete]")?.addEventListener("click", () => {
    onDelete();
    dialog.close();
  });
  dialog.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    try {
      onSave(Object.fromEntries(new FormData(e.target)));
      dialog.close();
    } catch (error) {
      dialog.querySelector(".ws-form-error").textContent = error.message;
    }
  };
  dialog.showModal();
}
function editTask(id = "", initial = {}) {
  const item = state.tasks.find((t2) => t2.id === id);
  const t = item || { id: uid(), title: "", projectId: project === "all" ? "" : project, status: "todo", priority: "normal", due: "", notes: "", today: route === "today", ...initial };
  modal(item ? "Edit task" : "Add task", input("Task", "title", t.title, "text", 'required maxlength="1000"') + `<div class="ws-form-row">${select("Project", "projectId", { "": "Inbox", ...Object.fromEntries(state.projects.filter((p) => !p.archived).map((p) => [p.id, p.name])) }, t.projectId)}${select("Status", "status", STATUS_LABELS, t.status)}</div><div class="ws-form-row">${input("Due date", "due", t.due, "date")}${select("Priority", "priority", { normal: "Normal", high: "High" }, t.priority)}</div><label>Notes<textarea class="ws-input" name="notes">${esc(t.notes)}</textarea></label><label class="inline"><input type="checkbox" name="today" ${t.today ? "checked" : ""}>Show in Today</label>`, (f) => {
    if (!f.title.trim())
      throw Error("Give this task a name.");
    mutate(item ? "Updated task" : "Added task", () => {
      const next = { ...t, ...f, title: f.title.trim(), today: !!f.today };
      if (item)
        Object.assign(item, next);
      else
        state.tasks.push(next);
    });
  }, item ? () => mutate("Moved task to trash", () => item.deletedAt = (/* @__PURE__ */ new Date()).toISOString()) : null);
}
function editProject(id = "") {
  const p = state.projects.find((p2) => p2.id === id) || { id: uid(), name: "", notes: "", color: COLORS[state.projects.length % COLORS.length], docUrl: "", syncEnabled: false };
  const existing = state.projects.includes(p);
  modal(existing ? "Edit project" : "New project", input("Project name", "name", p.name, "text", 'required maxlength="200"') + input("Project color", "color", p.color, "color") + `<label>Notes<textarea class="ws-input" name="notes">${esc(p.notes)}</textarea></label>` + input("Google Doc link", "docUrl", p.docUrl, "url") + `<label class="inline"><input type="checkbox" name="syncEnabled" ${p.syncEnabled ? "checked" : ""}>Sync this project with Google Docs</label><small>IRIS adds a clearly labeled task section. Other document content stays intact. Unlink before changing documents.</small>`, (f) => {
    const next = { ...p, ...f, name: f.name.trim(), syncEnabled: !!f.syncEnabled };
    if (next.syncEnabled && !next.docUrl)
      throw Error("Add a Google Doc link to enable sync.");
    if (p.docBase != null && next.docUrl !== p.docUrl)
      throw Error("Turn off sync and save before changing the document link.");
    validateState({ ...state, projects: existing ? state.projects.map((x) => x.id === p.id ? next : x) : [...state.projects, next] });
    mutate(existing ? "Updated project" : "Created project", () => {
      if (!next.syncEnabled) {
        delete next.docBase;
        delete next.localBase;
      }
      if (existing)
        Object.assign(p, next);
      else
        state.projects.push(next);
      project = p.id;
    });
  }, existing ? () => mutate("Archived project", () => p.archived = true) : null);
  if (existing)
    dialog.querySelector("[data-delete]").textContent = "Archive project";
  appendResolution("project", p);
}
function editEvent(id = "") {
  const existing = state.events.find((e2) => e2.id === id);
  const e = existing || { id: uid(), title: "", date: dateKey(), start: "09:00", end: "09:30", notes: "", syncEnabled: false };
  modal(existing ? "Edit event" : "Add event", input("Event name", "title", e.title, "text", "required") + input("Date", "date", e.date, "date", "required") + `<div class="ws-form-row">${input("Start \xB7 Vancouver", "start", e.start, "time", "required")}${input("End \xB7 Vancouver", "end", e.end, "time", "required")}</div><label>Notes<textarea class="ws-input" name="notes">${esc(e.notes)}</textarea></label><label class="inline"><input type="checkbox" name="syncEnabled" ${e.syncEnabled ? "checked" : ""}>Sync with Google Calendar</label><small>${e.source === "snapshot" ? "This is a dashboard snapshot without a Google event ID. Enabling sync creates a new event; import your calendar first to edit the original." : "New events are created in your configured Google calendar. Invitations are not sent."}</small>`, (f) => {
    const next = { ...e, ...f, syncEnabled: !!f.syncEnabled };
    validateState({ ...state, events: existing ? state.events.map((x) => x.id === e.id ? next : x) : [...state.events, next] });
    mutate(existing ? "Updated event" : "Added event", () => existing ? Object.assign(e, next) : state.events.push(next));
  }, existing ? () => mutate("Removed event from workspace", () => {
    e.deletedAt = (/* @__PURE__ */ new Date()).toISOString();
    e.syncEnabled = false;
  }) : null);
  if (existing)
    dialog.querySelector("[data-delete]").textContent = "Remove from IRIS";
  appendResolution("event", e);
}
function habitDone(h) {
  return typeof recHabits === "function" ? !!recHabits(dateKey())[h.legacyId || h.id] : !!h.days?.[dateKey()];
}
function bridgeHabits() {
  try { localStorage.setItem('steps_goal_v1', String(state.settings.stepsGoal)); } catch {}
  if (typeof HABITS === "undefined")
    return;
  for (const h of state.habits) {
    let old = HABITS.find((x) => x.id === (h.legacyId || h.id));
    if (!old) {
      old = { id: h.id, icon: "", label: h.title, sub: "", group: "routine", private: false };
      HABITS.push(old);
    }
    old.label = h.title;
    if (typeof vis !== "undefined")
      vis[old.id] = !h.deletedAt && !h.hidden;
  }
  if (typeof buildHabits === "function" && route === "tracker")
    buildHabits();
}
function editHabit(id = "") {
  const h = state.habits.find((h2) => h2.id === id) || { id: uid(), title: "", days: {} };
  const exists = state.habits.includes(h);
  modal(exists ? "Edit habit" : "Add habit", input("Habit name", "title", h.title, "text", "required") + `<label class="inline"><input type="checkbox" name="visible" ${!h.hidden ? "checked" : ""}>Show in Today and Health</label>`, (f) => {
    if (!f.title.trim())
      throw Error("Give the habit a name.");
    mutate(exists ? "Updated habit" : "Added habit", () => {
      h.title = f.title.trim();
      h.hidden = !f.visible;
      if (!exists)
        state.habits.push(h);
    });
  }, exists ? () => mutate("Removed habit", () => h.deletedAt = (/* @__PURE__ */ new Date()).toISOString()) : null);
}
function appendResolution(kind, item) {
  if (!item.syncError)
    return;
  const el = document.createElement("div");
  el.className = "ws-notice";
  el.innerHTML = `<p>${esc(item.syncError)}</p><button type="button" class="ws-btn small" data-resolve-kind="${kind}" data-resolve-id="${item.id}" data-resolve-choice="iris">Keep IRIS version</button><button type="button" class="ws-btn small" data-resolve-kind="${kind}" data-resolve-id="${item.id}" data-resolve-choice="google">Use Google version</button>`;
  dialog.querySelector("form").prepend(el);
}
function showEvents() {
  modal("Your schedule", `<p>Upcoming and past events. All times are Vancouver time.</p><div style="margin:14px 0">${button("+ Event", "add-event", "small")} ${button("Import from Google", "import-calendar", "small")}</div>${state.events.filter((e) => !e.deletedAt).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((e) => `<button type="button" class="ws-message ws-link" data-edit-event="${e.id}">${esc(e.title)}<small>${e.date} \xB7 ${e.start}\u2013${e.end}${e.syncError ? " \xB7 Sync needs attention" : ""}</small></button>`).join("") || empty("No events yet")}`, () => {
  });
  dialog.querySelectorAll("[data-edit-event],[data-action]").forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    dialog.close();
    clicks(e);
  });
  dialog.querySelector(".ws-dialog-footer").remove();
}
function exportBackup() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, state }, null, 2)], { type: "application/json" }));
  a.download = `iris-backup-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
}
async function request(path, options = {}) {
  const response = await fetch(base() + path, { ...options, signal: AbortSignal.timeout(45e3), headers: { "content-type": "application/json", "x-edit-token": token(), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = Error(body.error || (response.status === 404 ? "Workspace service needs deployment" : "Connection failed"));
    e.status = response.status;
    throw e;
  }
  return body;
}
async function loadCloud(force = false) {
  if (!base() || !token()) {
    status = "Saved on this device \xB7 connect in Settings";
    render();
    return;
  }
  try {
    const r = await request("/workspace");
    cloudReady = true;
    googleReady = !!r.googleConfigured;
    if (r.state) {
      if (force || !envelope && generation === 0 || !dirty) {
        undoState = clone(state);
        state = r.state;
        revision = r.revision;
        dirty = false;
        envelope = { state, revision };
        persist();
      } else if (r.revision !== revision) {
        cloudConflict = true;
        status = "Sync conflict \xB7 review changes";
        render();
        return;
      }
    } else
      revision = r.revision || 0;
    cloudConflict = false;
    status = dirty ? "Changes waiting to sync" : "Saved to IRIS";
    render();
    if (dirty || !r.state)
      saveCloud();
  } catch (e) {
    status = e.status === 403 ? "Access token rejected \xB7 open Settings" : e.message;
    render();
  }
}
async function saveCloud(options = {}) {
  if (busy || cloudConflict)
    return;
  if (!base() || !token()) {
    status = "Saved on this device \xB7 connect in Settings";
    renderSide();
    return;
  }
  if (!navigator.onLine) {
    status = "Offline \xB7 saved on this device";
    renderSide();
    return;
  }
  busy = true;
  root.inert = true;
  dialog.inert = true;
  const sentGeneration = generation;
  status = "Saving\u2026";
  renderSide();
  try {
    const result = await request("/workspace", { method: "POST", body: JSON.stringify({ revision, state, ...options }) });
    revision = result.revision;
    cloudReady = true;
    googleReady = !!result.googleConfigured;
    if (generation === sentGeneration) {
      state = result.state;
      dirty = false;
    }
    persist();
    status = result.syncErrors?.length ? "Google sync needs attention" : googleReady ? "Saved to IRIS \xB7 Google checked" : "Saved to IRIS \xB7 Google not connected";
    if (result.syncErrors?.length)
      toast(result.syncErrors[0]);
  } catch (e) {
    if (e.status === 409)
      cloudConflict = true;
    status = e.status === 409 ? "Sync conflict \xB7 review changes" : e.status === 403 ? "Access token rejected \xB7 open Settings" : `Sync failed \xB7 ${e.message}`;
    persist();
  } finally {
    busy = false;
    root.inert = false;
    dialog.inert = false;
    render();
    if (dirty && !cloudConflict && generation !== sentGeneration) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveCloud, 900);
    }
  }
}
root.addEventListener("input", (e) => {
  if (e.target.id === "ws-search") {
    query = e.target.value;
    render();
  }
});
root.addEventListener("submit", (e) => {
  if (e.target.id !== "ws-capture")
    return;
  e.preventDefault();
  const title = new FormData(e.target).get("title").trim();
  if (!title)
    return;
  mutate("Captured task", () => state.tasks.push({ id: uid(), title, projectId: project === "all" ? "" : project, status: "todo", priority: "normal", due: "", notes: "", today: route === "today" }));
  root.querySelector('[name="title"]')?.focus();
});
root.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.check)
    mutate(t.checked ? "Completed task" : "Reopened task", () => state.tasks.find((x) => x.id === t.dataset.check).status = t.checked ? "done" : "todo");
  if (t.dataset.habit)
    mutate("Updated habit check-in", () => {
      const h = state.habits.find((h2) => h2.id === t.dataset.habit);
      h.days ||= {};
      h.days[dateKey()] = t.checked;
      if (typeof recSetHabit === "function")
        recSetHabit(dateKey(), h.legacyId || h.id, t.checked);
    });
  if (t.id === "ws-coach-voice") {
    const voice = document.getElementById("coach-voice-select");
    if (voice) {
      voice.value = t.value;
      voiceSelectChange();
    }
  }
  if (t.id === "ws-filter") {
    filter = t.value;
    render();
  }
  if (t.dataset.cardToggle)
    mutate("Updated dashboard", () => {
      state.settings.hiddenCards = state.settings.hiddenCards.filter((x) => x !== t.dataset.cardToggle);
      if (!t.checked)
        state.settings.hiddenCards.push(t.dataset.cardToggle);
    });
  if (t.id === "ws-theme") {
    document.querySelector(`#s2-pop [data-theme="${CSS.escape(t.value)}"]`)?.click();
    render();
  }
  if (t.id === "ws-import" && t.files[0]) {
    try {
      const restored = JSON.parse(await t.files[0].text());
      validateState(restored.state);
      modal("Restore backup?", `<p>This will replace your current workspace with ${restored.state.tasks.length} tasks and ${restored.state.projects.length} projects. Export your current workspace first if you want to keep it.</p>`, () => mutate("Restored workspace backup", () => state = clone(restored.state)));
    } catch (error) {
      toast(error.message);
    }
  }
});
function clicks(e) {
  const b = e.target.closest("button");
  if (!b)
    return;
  if (b.dataset.nav)
    return navigate(b.dataset.nav);
  if (b.hasAttribute("data-sync"))
    return saveCloud();
  if (b.dataset.resolveKind) {
    const kind = b.dataset.resolveKind, id = b.dataset.resolveId, choice = b.dataset.resolveChoice;
    modal("Resolve Google conflict", `<p>Use the ${choice === "iris" ? "IRIS" : "Google"} version for this ${kind}? The other version\u2019s synchronized fields will be replaced. Export a backup first if needed.</p>`, () => saveCloud({ resolve: { kind, id, choice } }));
    return;
  }
  if (b.dataset.editTask)
    return editTask(b.dataset.editTask);
  if (b.dataset.editProject)
    return editProject(b.dataset.editProject);
  if (b.dataset.editEvent)
    return editEvent(b.dataset.editEvent);
  if (b.dataset.editHabit)
    return editHabit(b.dataset.editHabit);
  if (b.hasAttribute("data-project")) {
    project = b.dataset.project;
    render();
    return;
  }
  if (b.dataset.view) {
    view = b.dataset.view;
    localStorage.setItem("iris_workspace_view", view);
    render();
    return;
  }
  if (b.dataset.addStatus)
    return editTask("", { status: b.dataset.addStatus });
  if (b.dataset.restoreTask)
    return mutate("Restored task", () => delete state.tasks.find((t) => t.id === b.dataset.restoreTask).deletedAt);
  if (b.dataset.restoreProject)
    return mutate("Restored project", () => state.projects.find((p) => p.id === b.dataset.restoreProject).archived = false);
  if (b.dataset.cardUp || b.dataset.cardDown)
    return mutate("Reordered dashboard", () => {
      const id = b.dataset.cardUp || b.dataset.cardDown, a = state.settings.cardOrder, i = a.indexOf(id), j = i + (b.dataset.cardUp ? -1 : 1);
      if (j >= 0 && j < a.length)
        [a[i], a[j]] = [a[j], a[i]];
    });
  const act = b.dataset.action;
  if (act === "add-task")
    editTask();
  if (act === "add-project")
    editProject();
  if (act === "add-event")
    editEvent();
  if (act === "add-habit")
    editHabit();
  if (act === "add-deadline")
    editTask("", { kind: "deadline", due: dateKey(), today: false });
  if (act === "customize") {
    customize = !customize;
    render();
  }
  if (act === "all-tasks") {
    project = "all";
    filter = "open";
    navigate("projects");
  }
  if (act === "trash") {
    showTrash = !showTrash;
    render();
  }
  if (act === "undo")
    doUndo();
  if (act === "export")
    exportBackup();
  if (act === "sync")
    saveCloud();
  if (act === "import-calendar")
    saveCloud({ action: "import-calendar" });
  if (act === "events")
    showEvents();
  if (act === "load-server")
    modal("Load server version?", `<p>Your unsynced local edits will be replaced. Use \u201CExport local backup\u201D first to keep them.</p>`, () => loadCloud(true));
  if (act === "connect") {
    const value = document.getElementById("ws-token").value.trim();
    if (value)
      localStorage.setItem("today_edit_token", value);
    loadCloud();
  }
  if (act === "save-goal") {
    const value = Number(document.getElementById("ws-steps").value);
    if (!Number.isInteger(value) || value < 1 || value > 1e5)
      return toast("Choose a steps goal between 1 and 100,000.");
    mutate("Updated daily goal", () => {
      state.settings.stepsGoal = value;
      const habit = state.habits.find((h) => h.legacyId === "steps");
      if (habit)
        habit.title = `Hit ${value.toLocaleString()} steps`;
      localStorage.setItem("steps_goal_v1", String(value));
    });
  }
}
root.addEventListener("click", clicks);
side.addEventListener("click", clicks);
dialog.addEventListener("click", (e) => {
  if (e.target.closest("[data-resolve-kind]")) {
    dialog.close();
    clicks(e);
  }
});
let dragged = "";
root.addEventListener("dragstart", (e) => {
  const row = e.target.closest("[data-task-id]");
  if (!row)
    return;
  dragged = row.dataset.taskId;
  e.dataTransfer.setData("text/plain", dragged);
  e.dataTransfer.effectAllowed = "move";
});
root.addEventListener("dragover", (e) => {
  const col = e.target.closest("[data-drop-status]");
  if (!col)
    return;
  e.preventDefault();
  col.classList.add("drag-over");
});
root.addEventListener("dragleave", (e) => e.target.closest("[data-drop-status]")?.classList.remove("drag-over"));
root.addEventListener("drop", (e) => {
  const col = e.target.closest("[data-drop-status]");
  if (!col)
    return;
  e.preventDefault();
  const t = state.tasks.find((t2) => t2.id === dragged);
  if (t)
    mutate("Moved task to " + STATUS_LABELS[col.dataset.dropStatus], () => {
      t.status = col.dataset.dropStatus;
      const target = e.target.closest("[data-task-id]");
      if (target && target.dataset.taskId !== t.id) {
        state.tasks = state.tasks.filter((x) => x.id !== t.id);
        state.tasks.splice(state.tasks.findIndex((x) => x.id === target.dataset.taskId), 0, t);
      }
    });
  dragged = "";
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (root.hidden)
      navigate("today");
    document.getElementById("ws-search")?.focus();
  }
});
let lastRefresh = 0;
window.addEventListener("focus", () => {
  if (!busy && !dirty && token() && Date.now() - lastRefresh > 6e4) {
    lastRefresh = Date.now();
    loadCloud().then(() => {
      if (googleReady && !cloudConflict)
        saveCloud();
    });
  }
});
window.addEventListener("online", () => dirty ? saveCloud() : loadCloud());
window.addEventListener("storage", (e) => {
  if (e.key === KEY && !dirty && !busy) {
    const next = read(KEY, null);
    if (next?.state) {
      state = next.state;
      revision = next.revision;
      render();
    }
  }
});
for (const contextName of ["coachBuildContext", "plannerBuildContext"]) {
  const legacyBuildContext = window[contextName];
  if (typeof legacyBuildContext === "function")
    window[contextName] = function(...args) {
      const c = legacyBuildContext(...args);
      const context = { tasks: state.tasks.filter((t) => !t.deletedAt), projects: state.projects.filter((p) => !p.archived), events: state.events.filter((e) => !e.deletedAt) };
      return typeof c === "string" ? c + "\nCurrent IRIS workspace (use these tasks and events instead of older dashboard snapshots):\n" + JSON.stringify(context) : { ...c, workspace: context };
    };
}
window.openModal = () => navigate("settings");
async function boot() {
  root.inert = true;
  render();
  if (!envelope) {
    await Promise.race([window.todayReady || Promise.resolve(), new Promise((r) => setTimeout(r, 4500))]);
    const data = window.__todayData || {};
    state = seedState(data);
    state.settings.stepsGoal = Number(localStorage.getItem("steps_goal_v1")) || 6e3;
    dirty = true;
    persist();
  }
  if (!state.settings.habitsMigrated && typeof HABITS !== "undefined") {
    const records = typeof dayRecords === "function" ? dayRecords() : {};
    for (const h of HABITS) {
      if (state.habits.some((x) => x.legacyId === h.id))
        continue;
      const days = {};
      for (const [date, record] of Object.entries(records))
        if (record.habits?.[h.id] != null)
          days[date] = record.habits[h.id];
      state.habits.push({ id: uid(), legacyId: h.id, title: h.id === "steps" ? `Hit ${state.settings.stepsGoal.toLocaleString()} steps` : h.label, hidden: typeof vis !== "undefined" ? !vis[h.id] : !!h.private, days });
    }
    state.settings.habitsMigrated = true;
    dirty = true;
    persist();
  }
  root.inert = false;
  navigate(["projects", "settings", "tracker", "coach"].includes(document.body.dataset.tab) ? document.body.dataset.tab : "today");
  await loadCloud();
}
boot();

// Advance the schedule without interrupting an editor or an unfinished capture.
setInterval(() => {
  if (route === 'today' && !document.hidden && !busy && !dialog.open &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) render();
}, 60000);
