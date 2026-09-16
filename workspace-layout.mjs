const FLOAT_CARDS = ["tasks", "deadlines", "inbox", "slack"];
const HABIT_PERIODS = { morning: "Morning", midday: "Midday", night: "Night" };
function habitPeriod(habit) {
  if (HABIT_PERIODS[habit.period])
    return habit.period;
  const id = habit.legacyId || "";
  if (["sleep", "nofood", "alcohol", "garmin_bed", "s_mag"].includes(id))
    return "night";
  if (["steps", "water", "protein", "move", "s_omega", "s_creat", "sex"].includes(id))
    return "midday";
  return "morning";
}
function shiftDate(iso, days) {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekDates(iso) {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  const monday = shiftDate(iso, -((d.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i));
}
function eventsForDay(events, date) {
  return events.filter((e) => !e.deletedAt && e.date <= date && (e.allDay ? (e.endDate || shiftDate(e.date, 1)) > date : (e.endDate || e.date) >= date)).sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || (a.start || "").localeCompare(b.start || "") || a.title.localeCompare(b.title));
}
function defaultFloatLayout(order = FLOAT_CARDS) {
  return Object.fromEntries(order.map((id, i) => [id, { x: i % 2 * 0.51, y: Math.floor(i / 2) * 350, w: 0.49, h: 330 }]));
}
function fitFloatRect(rect, width) {
  const minW = Math.min(260, width);
  const w = Math.max(minW, Math.min(width, Number(rect.w) * width || minW));
  const x = Math.max(0, Math.min(width - w, Number(rect.x) * width || 0));
  return { x, y: Math.max(0, Number(rect.y) || 0), w, h: Math.max(190, Math.min(3e3, Number(rect.h) || 330)) };
}
function normalizedFloatRect(rect, width) {
  const safe = fitFloatRect({ ...rect, x: rect.x / width, w: rect.w / width }, width);
  return { x: safe.x / width, y: Math.round(safe.y), w: safe.w / width, h: Math.round(safe.h) };
}
export {
  FLOAT_CARDS,
  HABIT_PERIODS,
  defaultFloatLayout,
  eventsForDay,
  fitFloatRect,
  habitPeriod,
  normalizedFloatRect,
  shiftDate,
  weekDates
};
