"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect } from "react";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { addDays, boundedCalendarMonth, boundedDateDraft, formatDateInputValue, startOfLocalDay, type StudentDateBounds } from "@/lib/studentDates";

export const DATE_BUTTON_CLASS = "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-student-border bg-white text-student-muted transition hover:border-student-primary-border hover:text-student-primary";

// Practice history's existing form, with an OPTIONAL activity month extension.
export function StudentDateSelection({ draft, onDraftChange, onApply, onClear, hint, rangeLabel = "查看范围统计", activity, bounds, singleDay = false }: {
  draft: { start: string; end: string };
  onDraftChange: (draft: { start: string; end: string }) => void;
  onApply: (close: () => void) => void;
  onClear?: () => void;
  hint?: string;
  rangeLabel?: string;
  bounds?: StudentDateBounds;
  singleDay?: boolean;
  activity?: { month: Date; dates: string[]; onMonthChange: (month: Date) => void; error?: string; loading?: boolean; showToday?: boolean; resetMonthOnOpen?: boolean };
}) {
  const valid = !bounds || Boolean(boundedDateDraft(draft, bounds));
  return <TeacherPopover buttonClassName={DATE_BUTTON_CLASS} buttonContent={<><span className="sr-only">选择日期</span><CalendarDays aria-hidden="true" size={18} /></>}
    menuAlign={activity ? "left" : "right"} menuClassName="w-[304px] max-w-[calc(100vw-2rem)] p-4" panelRole="dialog">
    {close => <form className="grid gap-3" onSubmit={event => { event.preventDefault(); if (valid) onApply(close); }}>
      <p className="text-sm font-bold text-student-text">日期选择</p>
      {activity ? <ActivityMonth activity={activity} draft={draft} onDraftChange={onDraftChange} bounds={bounds} /> : null}
      <label className="grid gap-1.5 text-xs font-semibold text-student-muted">开始日期
        <input aria-label="开始日期" className="teacher-input w-full min-w-0" min={bounds?.min} max={bounds?.max} onChange={event => onDraftChange({ ...draft, start: event.target.value })} type="date" value={draft.start} />
      </label>
      {!singleDay ? <label className="grid gap-1.5 text-xs font-semibold text-student-muted">结束日期（可不填）
        <input aria-label="结束日期" className="teacher-input w-full min-w-0" min={bounds ? draft.start > bounds.min && draft.start <= bounds.max ? draft.start : bounds.min : undefined} max={bounds?.max} onChange={event => onDraftChange({ ...draft, end: event.target.value })} type="date" value={draft.end} />
      </label> : null}
      <p className="text-xs leading-5 text-student-muted">{hint ?? "同一天按单日详情查看；起止不同则显示范围统计。"}</p>
      {bounds && (draft.start || draft.end) && !valid ? <p role="status" className="text-xs text-student-error">请选择 {bounds.min} 至 {bounds.max} 内的有效日期，结束日期不能早于开始日期。</p> : null}
      <button className="teacher-button-primary w-full" disabled={!draft.start || !valid} type="submit">{!draft.end || draft.end === draft.start ? "查看当天" : rangeLabel}</button>
      {onClear ? <button className="student-button-secondary" type="button" onClick={() => { onClear(); close(); }}>清除日期选择</button> : null}
    </form>}
  </TeacherPopover>;
}

function ActivityMonth({ activity, draft, onDraftChange, bounds }: {
  activity: NonNullable<Parameters<typeof StudentDateSelection>[0]["activity"]>;
  draft: { start: string; end: string }; onDraftChange: (draft: { start: string; end: string }) => void;
  bounds?: StudentDateBounds;
}) {
  // Mounts only when the popover opens. This opt-in does not affect history.
  useLayoutEffect(() => {
    if (activity.resetMonthOnOpen) activity.onMonthChange(startOfLocalDay());
    // Opening, not every controlled month update, resets the month.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const month = bounds ? boundedCalendarMonth(activity.month, bounds) : activity.month;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const monthKey = formatDateInputValue(first).slice(0, 7);
  const today = formatDateInputValue(startOfLocalDay());
  const arrowClass = `${DATE_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-student-border disabled:hover:text-student-muted`;
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const marked = new Set(activity.dates);
  return <div className="grid gap-2">
    <div className="flex items-center gap-1">
      <button aria-label="上个月" disabled={Boolean(bounds && monthKey <= bounds.min.slice(0, 7))} className={arrowClass} type="button" onClick={() => activity.onMonthChange(new Date(first.getFullYear(), first.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
      <span className="min-w-0 flex-1 whitespace-nowrap text-center text-sm font-semibold">{first.getFullYear()}年{first.getMonth() + 1}月</span>
      <button aria-label="下个月" disabled={Boolean(bounds && monthKey >= bounds.max.slice(0, 7))} className={arrowClass} type="button" onClick={() => activity.onMonthChange(new Date(first.getFullYear(), first.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      {activity.showToday ? <button className="student-button-secondary !min-h-9 shrink-0 !px-2 !py-1 text-xs" type="button" onClick={() => activity.onMonthChange(startOfLocalDay())}>今天</button> : null}
    </div>
    <div className="grid grid-cols-7 gap-1 text-center text-xs">
      {["日", "一", "二", "三", "四", "五", "六"].map(day => <span className="text-student-muted" key={day}>{day}</span>)}
      {Array.from({ length: first.getDay() }, (_, i) => <span key={`blank-${i}`} />)}
      {Array.from({ length: count }, (_, i) => {
        const key = formatDateInputValue(addDays(first, i));
        const selected = key >= draft.start && key <= (draft.end || draft.start);
        const disabled = Boolean(bounds && (key < bounds.min || key > bounds.max));
        const isToday = activity.showToday && key === today;
        return <button aria-label={`${key}${marked.has(key) ? "，有收藏活动" : ""}`} aria-current={isToday ? "date" : undefined} aria-pressed={selected} disabled={disabled} key={key} type="button"
          className={`relative h-9 rounded-lg pb-1 transition hover:bg-student-primary-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${selected ? "bg-student-primary-soft" : ""} ${selected || isToday ? "text-student-primary" : "text-student-text"} ${isToday ? "ring-1 ring-inset ring-student-primary" : ""}`}
          onClick={() => onDraftChange({ start: key, end: key })}>{i + 1}
          {marked.has(key) ? <span aria-hidden="true" data-activity-dot className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-student-primary" /> : null}
        </button>;
      })}
    </div>
    <p aria-live="polite" className="text-xs text-student-muted">{activity.error ?? (activity.loading ? "正在加载活动日期…" : "圆点表示有收藏活动；范围可在下方输入。")}</p>
  </div>;
}
