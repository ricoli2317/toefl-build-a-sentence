export type DuplicatePreviewFields = {
  fields: Array<{ label: string; value: string }>;
};

export function DuplicateComparisonCard({
  preview,
  title
}: {
  preview: DuplicatePreviewFields | null;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-student-border bg-student-primary-soft/20 p-4">
      <h3 className="text-sm font-bold text-student-primary">{title}</h3>
      {!preview ? (
        <p className="mt-3 text-sm text-student-muted">题目详情不可用。</p>
      ) : (
        <div className="mt-3 grid gap-3 text-sm">
          {preview.fields.map((field, index) => (
            <div key={`${field.label}-${index}`}>
              <div className="font-bold text-student-muted">{field.label}</div>
              <div className="mt-0.5 whitespace-pre-wrap text-student-text">{field.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
