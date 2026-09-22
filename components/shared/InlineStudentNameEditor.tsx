"use client";

import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { MAX_STUDENT_FULL_NAME_LENGTH } from "@/lib/studentProfileName";

/**
 * Shared inline student-name editor used by both the Teacher student list and
 * the Admin student account list. Saving is delegated to the caller so each
 * surface re-checks permissions server-side and refreshes its own data.
 */
export function InlineStudentNameEditor({
  displayName,
  onSave,
  renderName
}: {
  displayName: string;
  onSave: (fullName: string) => Promise<string | void>;
  renderName?: (name: string) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);

  useEffect(() => {
    setSavedName(null);
  }, [displayName]);

  const shownName = savedName ?? displayName;

  function startEditing() {
    setValue(shownName);
    setError("");
    setEditing(true);
  }

  function cancel() {
    if (saving) return;
    setError("");
    setEditing(false);
  }

  async function submit() {
    if (saving) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError("姓名不能为空。");
      return;
    }
    if (trimmed === shownName.trim()) {
      cancel();
      return;
    }

    setSaving(true);
    setError("");
    try {
      const saved = await onSave(trimmed);
      setSavedName(typeof saved === "string" && saved.trim() ? saved.trim() : trimmed);
      setEditing(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "姓名更新失败，请稍后重试。"
      );
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        {renderName ? (
          renderName(shownName)
        ) : (
          <span className="min-w-0 truncate font-semibold text-student-text">{shownName}</span>
        )}
        <button
          aria-label={`修改 ${shownName} 的姓名`}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-student-muted transition hover:bg-student-primary-soft hover:text-student-primary"
          onClick={startEditing}
          title="修改姓名"
          type="button"
        >
          <Pencil aria-hidden="true" size={15} strokeWidth={2} />
        </button>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        aria-label="学生姓名"
        autoFocus
        className="h-9 w-40 min-w-0 rounded-lg border border-student-border bg-white px-3 text-sm font-semibold text-student-text focus:border-student-primary disabled:opacity-60"
        disabled={saving}
        maxLength={MAX_STUDENT_FULL_NAME_LENGTH}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        value={value}
      />
      <button
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-student-primary px-3 text-sm font-semibold text-white transition hover:bg-student-primary-hover disabled:opacity-50"
        disabled={saving}
        onClick={() => void submit()}
        type="button"
      >
        <Check aria-hidden="true" size={15} strokeWidth={2.2} />
        {saving ? "保存中…" : "确定"}
      </button>
      <button
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-student-border bg-white px-3 text-sm font-semibold text-student-muted transition hover:border-student-primary hover:text-student-primary disabled:opacity-50"
        disabled={saving}
        onClick={cancel}
        type="button"
      >
        <X aria-hidden="true" size={15} strokeWidth={2.2} />
        取消
      </button>
      {error ? (
        <span className="text-xs font-semibold text-student-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
