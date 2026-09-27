"use client";

import {
  STUDENT_BINDING_DOMAINS,
  STUDENT_BINDING_DOMAIN_LABELS,
  type StudentBindingDomain
} from "@/lib/studentBindings";

/**
 * Shared 授课科目 selector (subject picker). The markup is the existing
 * 新增学生 selector verbatim; the class form reuses it so both pages keep the
 * same look and behavior.
 */
export function TeacherSubjectFieldset({
  disabled = false,
  helpText = "至少选择一个授课科目，可同时选择阅读和写作。",
  legend = "授课科目",
  onChange,
  value
}: {
  disabled?: boolean;
  helpText?: string;
  legend?: string;
  onChange: (subjects: StudentBindingDomain[]) => void;
  value: StudentBindingDomain[];
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-semibold text-student-text">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {STUDENT_BINDING_DOMAINS.map((domain) => (
          <label
            className="flex items-center gap-2.5 rounded-xl border border-student-border bg-white px-4 py-3 text-sm font-semibold text-student-text"
            key={domain}
          >
            <input
              checked={value.includes(domain)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(value);
                if (event.target.checked) next.add(domain);
                else next.delete(domain);
                onChange(STUDENT_BINDING_DOMAINS.filter((item) => next.has(item)));
              }}
              type="checkbox"
            />
            {STUDENT_BINDING_DOMAIN_LABELS[domain]}
          </label>
        ))}
      </div>
      <p className="text-sm text-student-muted">{helpText}</p>
    </fieldset>
  );
}
