// Shared with practice history: local calendar days, exclusive next-day UTC
// boundaries (setDate, not +24h, so DST is respected).
export function startOfLocalDay(date = new Date()) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}
export function addDays(day: Date, amount: number) {
  const next = startOfLocalDay(day);
  next.setDate(next.getDate() + amount);
  return next;
}
export function localDayRange(day: Date) {
  const start = startOfLocalDay(day);
  return { startAt: start.toISOString(), endAt: addDays(start, 1).toISOString() };
}
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"; }
  catch { return "Asia/Shanghai"; }
}
export function formatDateInputValue(day: Date) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}
export function parseDateInputValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) || formatDateInputValue(day) !== value ? null : day;
}
export function normalizeDateDraft(draft: { start: string; end: string }, fallback: string) {
  let start = draft.start || fallback;
  let end = draft.end || start;
  if (end < start) [start, end] = [end, start];
  return { start, end };
}

// Opt-in validation; practice history retains normalizeDateDraft's old behavior.
export type StudentDateBounds = { min: string; max: string };
export function boundedDateDraft(draft: { start: string; end: string }, bounds: StudentDateBounds) {
  const start = draft.start, end = draft.end || start;
  return !parseDateInputValue(start) || !parseDateInputValue(end) || start < bounds.min
    || end > bounds.max || end < start ? null : { start, end };
}
export function boundedCalendarMonth(month: Date, bounds: StudentDateBounds) {
  const key = formatDateInputValue(month).slice(0, 7);
  const min = bounds.min.slice(0, 7), max = bounds.max.slice(0, 7);
  return parseDateInputValue(`${key < min ? min : key > max ? max : key}-01`)!;
}
