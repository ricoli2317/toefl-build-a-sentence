"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import clsx from "clsx";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import {
  STUDENT_BINDING_DOMAINS,
  STUDENT_BINDING_DOMAIN_LABELS,
  emptyBindingDomain,
  type StudentBindingDomain
} from "@/lib/studentBindings";
import { studentBindingErrorMessage } from "@/lib/teacherStudentBindingClient";

/**
 * Shared 授课科目 badge surfaces.
 *
 * `SubjectChip` / `SubjectBadgeStack` are pure display (canonical order
 * reading, writing). `SubjectBindingBadges` is the quick editor used by the
 * home student list (per-student bindings) and the home class list (class
 * subjects): one active chip per held subject with a top-right ×, plus the
 * dashed empty badge to the right of a single active chip. The callbacks are
 * supplied per context, so the two mutations never mix.
 */

const READING_CHIP_CLASS =
  "shrink-0 rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2 py-0.5 text-xs font-semibold text-[#347fdc]";
const WRITING_CHIP_CLASS =
  "shrink-0 rounded-full border border-student-primary-border bg-student-primary-soft px-2 py-0.5 text-xs font-semibold text-student-primary";

export function SubjectChip({ domain }: { domain: StudentBindingDomain }) {
  return (
    <span className={domain === "reading" ? READING_CHIP_CLASS : WRITING_CHIP_CLASS}>
      {STUDENT_BINDING_DOMAIN_LABELS[domain]}
    </span>
  );
}

/** Display-only stack in the canonical order (reading first, writing second). */
export function SubjectBadgeStack({
  direction = "row",
  domains
}: {
  direction?: "row" | "column";
  domains: readonly StudentBindingDomain[];
}) {
  const active = STUDENT_BINDING_DOMAINS.filter((domain) => domains.includes(domain));
  if (active.length === 0) return null;
  return (
    <span
      className={clsx(
        direction === "column" ? "flex flex-col items-start gap-1" : "flex flex-wrap gap-1.5"
      )}
    >
      {active.map((domain) => (
        <SubjectChip domain={domain} key={domain} />
      ))}
    </span>
  );
}

export function SubjectBindingBadges({
  actionFallback = "操作失败，请稍后重试。",
  disabled = false,
  domains,
  lastRemovalWarning = "",
  onAddDomain,
  onRemoveDomain,
  removeBlockedReason,
  removeSubjectLabel = "该学生"
}: {
  actionFallback?: string;
  disabled?: boolean;
  domains: readonly StudentBindingDomain[];
  /** Extra line shown when this removal is the last active subject. */
  lastRemovalWarning?: string;
  onAddDomain: (domain: StudentBindingDomain) => Promise<void>;
  onRemoveDomain: (domain: StudentBindingDomain) => Promise<void>;
  /** Returns a blocking message when that subject cannot be removed. */
  removeBlockedReason?: (domain: StudentBindingDomain) => string | null;
  /** Flows into the confirmation copy and the × accessible name. */
  removeSubjectLabel?: string;
}) {
  const [pendingAdd, setPendingAdd] = useState<StudentBindingDomain | null>(null);
  const [pendingRemove, setPendingRemove] = useState<StudentBindingDomain | null>(null);
  const [blockedRemoval, setBlockedRemoval] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const active = STUDENT_BINDING_DOMAINS.filter((domain) => domains.includes(domain));
  const emptyDomain = emptyBindingDomain(domains);

  function openRemove(domain: StudentBindingDomain) {
    setError("");
    const blocked = removeBlockedReason?.(domain) ?? null;
    if (blocked) {
      setBlockedRemoval(blocked);
      return;
    }
    setPendingRemove(domain);
  }

  async function confirmAdd() {
    if (!pendingAdd || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAddDomain(pendingAdd);
      setPendingAdd(null);
    } catch (mutation) {
      setError(studentBindingErrorMessage(mutation, actionFallback));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRemoveDomain(pendingRemove);
      setPendingRemove(null);
    } catch (mutation) {
      setError(studentBindingErrorMessage(mutation, actionFallback));
    } finally {
      setBusy(false);
    }
  }

  const lastRemoval =
    pendingRemove !== null && active.length === 1 && lastRemovalWarning
      ? lastRemovalWarning
      : "";

  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {active.map((domain) => (
          <span className="relative inline-flex" key={domain}>
            <SubjectChip domain={domain} />
            <button
              aria-label={`取消${removeSubjectLabel.replace("该", "")}的${STUDENT_BINDING_DOMAIN_LABELS[domain]}科目`}
              className="absolute -right-1 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-student-border bg-white text-student-muted shadow-sm transition hover:border-student-error hover:text-student-error"
              disabled={disabled}
              onClick={() => openRemove(domain)}
              title="取消授课科目"
              type="button"
            >
              <X aria-hidden="true" size={10} strokeWidth={3} />
            </button>
          </span>
        ))}
        {emptyDomain ? (
          <button
            aria-label={`新增${STUDENT_BINDING_DOMAIN_LABELS[emptyDomain]}授课科目`}
            className="inline-flex min-w-[46px] cursor-pointer items-center justify-center rounded-full border border-dashed border-student-border bg-transparent px-2.5 py-0.5 text-xs font-semibold text-student-muted transition hover:border-student-primary hover:text-student-primary disabled:cursor-not-allowed"
            disabled={disabled}
            onClick={() => {
              setError("");
              setPendingAdd(emptyDomain);
            }}
            title={`新增${STUDENT_BINDING_DOMAIN_LABELS[emptyDomain]}授课科目`}
            type="button"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center">
              <Plus aria-hidden="true" size={12} strokeWidth={2.5} />
            </span>
          </button>
        ) : null}
      </span>

      <ModalShell open={pendingAdd !== null} onClose={() => (busy ? undefined : setPendingAdd(null))}>
        <p className="text-base font-bold text-student-text">新增授课科目</p>
        <p className="mt-3 text-sm text-student-muted">
          是否新增{STUDENT_BINDING_DOMAIN_LABELS[pendingAdd ?? "reading"]}授课科目？
        </p>
        {error ? <p className="teacher-error mt-3">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="teacher-button-secondary"
            disabled={busy}
            onClick={() => setPendingAdd(null)}
            type="button"
          >
            取消
          </button>
          <button
            className="teacher-button-primary"
            disabled={busy}
            onClick={() => void confirmAdd()}
            type="button"
          >
            {busy ? "处理中…" : "确认"}
          </button>
        </div>
      </ModalShell>

      <ModalShell
        open={pendingRemove !== null}
        onClose={() => (busy ? undefined : setPendingRemove(null))}
      >
        <p className="text-base font-bold text-student-text">取消授课科目</p>
        <p className="mt-3 text-sm text-student-muted">
          是否不再负责{removeSubjectLabel}的
          {STUDENT_BINDING_DOMAIN_LABELS[pendingRemove ?? "reading"]}科目？
        </p>
        {lastRemoval ? <p className="mt-2 text-sm text-student-muted">{lastRemoval}</p> : null}
        {error ? <p className="teacher-error mt-3">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="teacher-button-secondary"
            disabled={busy}
            onClick={() => setPendingRemove(null)}
            type="button"
          >
            取消
          </button>
          <button
            className="teacher-button-primary"
            disabled={busy}
            onClick={() => void confirmRemove()}
            type="button"
          >
            {busy ? "处理中…" : "确认"}
          </button>
        </div>
      </ModalShell>

      <ModalShell
        open={blockedRemoval !== ""}
        onClose={() => setBlockedRemoval("")}
      >
        <p className="text-base font-bold text-student-text">取消授课科目</p>
        <p className="mt-3 text-sm text-student-muted">{blockedRemoval}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="teacher-button-secondary"
            onClick={() => setBlockedRemoval("")}
            type="button"
          >
            关闭
          </button>
        </div>
      </ModalShell>
    </>
  );
}
