import test from "node:test";
import assert from "node:assert/strict";
import { emptyState, seedState, validateState, visibleTasks, docText, parseDocText, taskFingerprint, eventFingerprint } from "../workspace-model.mjs";
import { Workspace, documentSection, syncDocument, syncEvent, importCalendar } from "../worker/src/workspace.js";
const task = (extra = {}) => ({ id: "task1", title: "Write outline", status: "todo", projectId: "project1", due: "", notes: "", priority: "normal", ...extra });
const project = () => ({ id: "project1", name: "Research", docUrl: "https://docs.google.com/document/d/doc123/edit", syncEnabled: true });
const document = (text) => ({ revisionId: "r1", body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: text } }] } }] } });
const section = (text) => `Unrelated introduction
IRIS TASKS START project1
${text}IRIS TASKS END project1
Other content
`;
test("migration preserves completed tasks, projects and stable references", () => {
  const s = seedState({ tasks: [{ n: "Done", done: true }], projects: [{ name: "Research", tasks: [{ n: "Outline", hi: true }] }] });
  validateState(s);
  assert.equal(s.tasks[0].projectId, s.projects[0].id);
  assert.equal(s.tasks[1].status, "done");
  assert.equal(s.projects[0].syncEnabled, false);
});
test("yearless deadlines roll forward across a year boundary", () => {
  const s = seedState({ updated: "2026-09-15T12:00:00-07:00", deadlines: [{ n: "Conference", d: "05", m: "Mar" }] });
  assert.equal(s.tasks[0].due, "2027-03-05");
});
test("filters exclude trash and archived projects and include notes", () => {
  const s = emptyState();
  s.tasks = [task({ notes: "searchable" }), task({ id: "t2", deletedAt: "now" }), task({ id: "t3", projectId: "archive" })];
  s.projects = [{ id: "archive", name: "Old", archived: true }];
  assert.equal(visibleTasks(s).length, 1);
  assert.equal(visibleTasks(s, { query: "searchable" }).length, 1);
});
test("invalid dates, status, duplicate IDs and event times rejected", () => {
  for (const values of [{ status: "bad" }, { due: "2026-02-31" }]) {
    const s2 = emptyState();
    s2.tasks = [task(values)];
    assert.throws(() => validateState(s2));
  }
  const s = emptyState();
  s.tasks = [task(), task()];
  assert.throws(() => validateState(s));
  s.tasks = [];
  s.events = [{ id: "e", title: "Meeting", date: "2026-10-01", start: "11:00", end: "10:00" }];
  assert.throws(() => validateState(s));
});
test("Google document checkbox and notes round trip", () => {
  const original = task({ notes: "One\nTwo", status: "doing", due: "2026-10-01" });
  const text = docText([original]);
  assert.equal(taskFingerprint(parseDocText(text, "project1")), taskFingerprint([original]));
  assert.equal(parseDocText(text.replace("[ ]", "[x]"), "project1")[0].status, "done");
  assert.throws(() => parseDocText("unstructured replacement", "project1"));
});
test("document section uses indexed UTF-16 text, preserving surrounding content", () => {
  const content = section(docText([task({ title: "Read \u{1F4DA}" })]));
  const found = documentSection(document(content), "project1");
  assert.equal(content.slice(found.startIndex - 1, found.endIndex - 1), docText([task({ title: "Read \u{1F4DA}" })]));
  assert.equal(documentSection(document("Other text\n"), "project1"), null);
  assert.throws(() => documentSection(document("IRIS TASKS START project1\nMissing end"), "project1"));
});
test("first Doc sync appends managed section with revision precondition", async () => {
  const s = emptyState(), p = project();
  s.projects = [p];
  s.tasks = [task()];
  let write;
  await syncDocument(s, p, async (path, opts) => opts ? (write = JSON.parse(opts.body), {}) : document("Keep this\n"));
  assert.equal(write.writeControl.requiredRevisionId, "r1");
  assert.ok(write.requests[0].insertText.endOfSegmentLocation);
  assert.match(write.requests[0].insertText.text, /IRIS TASKS START/);
  assert.equal(p.localBase, taskFingerprint(s.tasks));
});
test("Google-only changes import without deleting other projects or local Today choice", async () => {
  const s = emptyState(), p = project();
  s.projects = [p];
  s.tasks = [task({ today: true }), task({ id: "other", projectId: "p2" })];
  p.docBase = docText([s.tasks[0]]);
  p.localBase = taskFingerprint([s.tasks[0]]);
  const remote = docText([task({ title: "Edited in Docs" })]);
  await syncDocument(s, p, async () => document(section(remote)));
  assert.equal(s.tasks[0].title, "Edited in Docs");
  assert.equal(s.tasks[0].today, true);
  assert.equal(s.tasks[1].id, "other");
});
test("simultaneous Doc edits conflict and do not write", async () => {
  const s = emptyState(), p = project();
  s.tasks = [task({ title: "Local edit" })];
  p.docBase = docText([task()]);
  p.localBase = taskFingerprint([task()]);
  let writes = 0;
  await assert.rejects(syncDocument(s, p, async (_, opts) => {
    if (opts)
      writes++;
    return document(section(docText([task({ title: "Remote edit" })])));
  }), /Both IRIS/);
  assert.equal(writes, 0);
  assert.equal(s.tasks[0].title, "Local edit");
});
test("remote deleted task goes to recoverable trash", async () => {
  const s = emptyState(), p = project();
  s.tasks = [task()];
  p.docBase = docText(s.tasks);
  p.localBase = taskFingerprint(s.tasks);
  await syncDocument(s, p, async () => document(section("")));
  assert.ok(s.tasks[0].deletedAt);
});
const event = () => ({ id: "event1", title: "Focus", date: "2026-09-16", start: "10:00", end: "11:00", notes: "", syncEnabled: true });
const remoteEvent = (extra = {}) => ({ id: "google1", etag: "etag1", summary: "Focus", start: { dateTime: "2026-09-16T10:00:00-07:00" }, end: { dateTime: "2026-09-16T11:00:00-07:00" }, ...extra });
test("Calendar update uses If-Match and PATCH, preserving attendees", async () => {
  const e = event();
  e.googleId = "google1";
  e.googleEtag = "etag1";
  e.googleBase = eventFingerprint(e);
  e.title = "New title";
  let options;
  await syncEvent(e, async (_, o) => o ? (options = o, remoteEvent({ summary: "New title", etag: "etag2" })) : remoteEvent(), {});
  assert.equal(options.method, "PATCH");
  assert.equal(options.headers["If-Match"], "etag1");
  assert.equal(JSON.parse(options.body).attendees, void 0);
  assert.equal(e.googleEtag, "etag2");
});
test("Calendar-only edits import; simultaneous edits conflict", async () => {
  const e = event();
  Object.assign(e, { googleId: "google1", googleEtag: "etag1", googleBase: eventFingerprint(e) });
  await syncEvent(e, async () => remoteEvent({ summary: "Remote title", etag: "etag2" }), {});
  assert.equal(e.title, "Remote title");
  e.title = "Local title";
  await assert.rejects(syncEvent(e, async () => remoteEvent({ summary: "Another remote edit", etag: "etag3" }), {}), /Both IRIS/);
});
test("Calendar import paginates, deduplicates snapshots, does not auto-enable writes", async () => {
  const s = emptyState();
  s.events = [event()];
  s.events[0].syncEnabled = false;
  let calls = 0;
  await importCalendar(s, async () => ++calls === 1 ? { items: [remoteEvent()], nextPageToken: "next" } : { items: [remoteEvent()] }, {});
  assert.equal(calls, 2);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].googleId, "google1");
  assert.equal(s.events[0].syncEnabled, false);
});
test("server serializes concurrent saves and rejects stale revision", async () => {
  const storage = /* @__PURE__ */ new Map();
  const ctx = { storage: { get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, structuredClone(v)) } };
  const w = new Workspace(ctx, {});
  const req = () => new Request("https://test/workspace", { method: "POST", body: JSON.stringify({ revision: 0, state: emptyState() }) });
  const results = await Promise.all([w.fetch(req()), w.fetch(req())]);
  assert.deepEqual(results.map((r) => r.status), [200, 409]);
  const saved = await (await w.fetch(new Request("https://test/workspace"))).json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.googleConfigured, false);
});
test("server retains edits when Google credentials are unavailable", async () => {
  const storage = /* @__PURE__ */ new Map();
  const w = new Workspace({ storage: { get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, structuredClone(v)) } }, {});
  const s = emptyState();
  s.tasks = [task()];
  const result = await (await w.fetch(new Request("https://test/workspace", { method: "POST", body: JSON.stringify({ revision: 0, state: s, action: "import-calendar" }) }))).json();
  assert.equal(result.state.tasks[0].title, "Write outline");
  assert.match(result.syncErrors[0], /authorization/);
});
test("legacy planner additions enter the workspace without duplicates", async () => {
  const storage = /* @__PURE__ */ new Map([["workspace", { revision: 1, state: emptyState() }]]);
  const w = new Workspace({ storage: { get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, structuredClone(v)) } }, {});
  const add = () => w.fetch(new Request("https://test/legacy-task-add", { method: "POST", body: JSON.stringify({ n: "Prepare slides", due: "2026-10-01" }) }));
  assert.equal((await (await add()).json()).handled, true);
  assert.equal((await (await add()).json()).dup, true);
  assert.equal(storage.get("workspace").state.tasks.length, 1);
  assert.equal(storage.get("workspace").state.tasks[0].due, "2026-10-01");
});
test("acknowledgement loss does not create a false Doc conflict", async () => {
  const s = emptyState(), p = project();
  s.tasks = [task({ title: "New title" })];
  p.docBase = docText([task()]);
  p.localBase = taskFingerprint([task()]);
  let writes = 0;
  await syncDocument(s, p, async (_, options) => {
    if (options)
      writes++;
    return document(section(docText(s.tasks)));
  });
  assert.equal(writes, 0);
  assert.equal(p.localBase, taskFingerprint(s.tasks));
});
test("workspace route rejects unauthenticated reads and writes", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  for (const method of ["GET", "POST"]) {
    const r = await worker.fetch(new Request("https://example/workspace", { method, headers: { origin: "https://example" } }), { ALLOWED_ORIGINS: "https://example", EDIT_TOKEN: "test-only" });
    assert.equal(r.status, 403);
  }
});

test('dashboard geometry stays in bounds and survives narrow widths', async()=>{
  const {fitFloatRect,normalizedFloatRect,habitPeriod,weekDates,eventsForDay}=await import('../workspace-layout.mjs');
  assert.deepEqual(fitFloatRect({x:2,w:2,y:-4,h:1},500),{x:0,y:0,w:500,h:190});
  assert.equal(normalizedFloatRect({x:50,y:30,w:400,h:300},1000).w,.4);
  assert.equal(habitPeriod({legacyId:'s_mag'}),'night');assert.equal(habitPeriod({period:'midday'}),'midday');
  assert.deepEqual(weekDates('2026-09-20'),['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19','2026-09-20']);
  const events=[{title:'Away',date:'2026-09-14',endDate:'2026-09-17',allDay:true}];
  assert.equal(eventsForDay(events,'2026-09-16').length,1);assert.equal(eventsForDay(events,'2026-09-17').length,0);
});
test('all calendars keep distinct event identities and refresh remote changes',async()=>{
  const {importAllCalendars,calendarValues}=await import('../worker/src/workspace.js');
  const state=emptyState();let title='Meeting';let empty=false;
  const google=async url=>url.includes('calendarList')?{items:[{id:'one',summary:'Personal',accessRole:'owner'},{id:'two',summary:'School',accessRole:'reader'}]}:{items:empty?[]:[{id:'same-id',etag:title,summary:title,start:{date:'2026-09-15'},end:{date:'2026-09-17'}}]};
  await importAllCalendars(state,google,{}, {id:'a',label:'Account A'});
  assert.equal(state.events.length,2);assert.notEqual(state.events[0].calendarKey,state.events[1].calendarKey);assert.equal(state.events[1].readOnly,true);validateState(state);
  title='Updated';await importAllCalendars(state,google,{}, {id:'a',label:'Account A'});assert.equal(state.events[0].title,'Updated');
  await importAllCalendars(state,google,{}, {id:'b',label:'Account B'});assert.equal(state.events.length,4);
  const overnight=calendarValues({summary:'Overnight',start:{dateTime:'2026-09-15T23:00:00-07:00'},end:{dateTime:'2026-09-16T01:00:00-07:00'}});assert.equal(overnight.endDate,'2026-09-16');
});
test('linked secondary calendar writes target the original calendar',async()=>{
  const e={id:'secondary',title:'Work',date:'2026-09-15',endDate:'2026-09-16',allDay:true,start:'',end:'',calendarId:'school@example.com',googleId:'ev',googleEtag:'v1'};
  let path,payload;
  await syncEvent(e,async(url,options)=>{path=url;if(options){payload=JSON.parse(options.body);return{id:'ev',etag:'v2'};}return{id:'ev',etag:'v1',summary:'Work',start:{date:e.date},end:{date:e.endDate}};},{});
  assert.match(path,/school%40example.com/);assert.deepEqual(payload.start,{date:'2026-09-15'});assert.deepEqual(payload.end,{date:'2026-09-16'});
});
