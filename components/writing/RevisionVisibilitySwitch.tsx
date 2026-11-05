"use client";

export function RevisionVisibilitySwitch({ checked, onChange, onPointerDown, compact = false, className = "" }: {
  checked: boolean; onChange: (checked: boolean) => void; onPointerDown?: () => void;
  compact?: boolean; className?: string;
}) {
  return <label onPointerDown={onPointerDown} className={`inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap text-student-muted ${compact ? "gap-1.5 text-[11px]" : "gap-2 text-xs"} ${className}`}>
    <span data-switch-label>显示修订痕迹</span>
    <input aria-label="显示修订痕迹" role="switch" type="checkbox" checked={checked}
      className="peer sr-only" onChange={event => onChange(event.target.checked)} />
    <span aria-hidden="true" className={`relative shrink-0 rounded-full bg-slate-300 transition-colors peer-checked:bg-student-primary peer-focus-visible:ring-2 peer-focus-visible:ring-student-primary peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform ${compact ? "h-[18px] w-8 after:h-3.5 after:w-3.5 peer-checked:after:translate-x-3.5" : "h-6 w-10 after:h-5 after:w-5 peer-checked:after:translate-x-4"}`} />
  </label>;
}
