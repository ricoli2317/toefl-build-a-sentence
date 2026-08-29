"use client";

import { Save, Send } from "lucide-react";

export function WritingPracticeActions({
  compact = false,
  disabled,
  onSave,
  onSubmit,
  submitLabel = "Submit"
}: {
  compact?: boolean;
  disabled: boolean;
  onSave?: () => void;
  onSubmit: () => void;
  submitLabel?: string;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-end gap-3 ${
        compact ? "px-0 py-1" : "px-4 py-4 sm:px-5"
      }`}
    >
      {onSave ? (
        <button className="writing-action-secondary" disabled={disabled} onClick={onSave} type="button">
          <Save aria-hidden="true" size={19} />
          Save Draft
        </button>
      ) : null}
      <button className="writing-action-primary" disabled={disabled} onClick={onSubmit} type="button">
        <Send aria-hidden="true" size={19} />
        {submitLabel}
      </button>
    </div>
  );
}
