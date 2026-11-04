"use client";

export function RevisionVisibilitySwitch({ checked, onChange, onPointerDown }: {
  checked: boolean; onChange: (checked: boolean) => void; onPointerDown?: () => void;
}) {
  return <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs text-student-muted">
    <span>显示修订痕迹</span>
    <input aria-label="显示修订痕迹" role="switch" type="checkbox" checked={checked}
      className="peer sr-only" onPointerDown={onPointerDown} onChange={event => onChange(event.target.checked)} />
    <span aria-hidden="true" className="relative h-6 w-10 rounded-full bg-slate-300 transition-colors peer-checked:bg-student-primary peer-focus-visible:ring-2 peer-focus-visible:ring-student-primary peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4" />
  </label>;
}
