"use client";

import { useCallback, useEffect, useState } from "react";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  MAX_PRACTICE_ENTITLEMENT_REMAINING,
  PRACTICE_ENTITLEMENT_GROUPS,
  PRACTICE_ENTITLEMENT_KINDS,
  PRACTICE_ENTITLEMENT_LABELS,
  PRACTICE_ENTITLEMENT_SHORT_LABELS,
  isPracticeEntitlementKind,
  isValidPracticeEntitlementRemaining,
  parsePracticeEntitlementBulkValue,
  validatePracticeEntitlementFormValues,
  type PracticeEntitlementKind,
  type PracticeEntitlementSnapshotItem
} from "@/lib/practiceEntitlements";

type Draft = Record<PracticeEntitlementKind, string>;

type EntitlementsPayload = {
  entitlements?: PracticeEntitlementSnapshotItem[];
  message?: string;
  error?: string;
};

function emptyDraft(): Draft {
  return Object.fromEntries(
    PRACTICE_ENTITLEMENT_KINDS.map((kind) => [kind, ""])
  ) as Draft;
}

function draftFromRows(rows: PracticeEntitlementSnapshotItem[]): Draft {
  return Object.fromEntries(
    PRACTICE_ENTITLEMENT_KINDS.map((kind) => [
      kind,
      String(rows.find((row) => row.kind === kind)?.remaining ?? 0)
    ])
  ) as Draft;
}

function validSnapshotRows(value: unknown): value is PracticeEntitlementSnapshotItem[] {
  if (!Array.isArray(value) || value.length !== PRACTICE_ENTITLEMENT_KINDS.length) {
    return false;
  }
  const seen = new Set<PracticeEntitlementKind>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (!isPracticeEntitlementKind(row.kind) || seen.has(row.kind)) return false;
    if (
      !isValidPracticeEntitlementRemaining(row.remaining) ||
      !isValidPracticeEntitlementRemaining(row.defaultRemaining) ||
      typeof row.isExplicit !== "boolean"
    ) {
      return false;
    }
    seen.add(row.kind);
  }
  return PRACTICE_ENTITLEMENT_KINDS.every((kind) => seen.has(kind));
}

async function authorizedFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  return fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      ...init?.headers
    },
    cache: "no-store"
  });
}

/**
 * On-demand Admin entitlement panel for exactly one student.
 *
 * The Admin Students list never preloads entitlement data. Mounting this panel
 * sends one GET; saving sends one PATCH. The database returns the authoritative
 * eight values after every successful save, so the panel never derives balances
 * from attempts or stale client cache.
 */
export function StudentPracticeEntitlementsPanel({
  open,
  studentId,
  studentName,
  onClose
}: {
  open: boolean;
  studentId: string;
  studentName: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PracticeEntitlementSnapshotItem[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [bulkValue, setBulkValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setSaveError("");
    setSavedMessage("");
    try {
      const response = await authorizedFetch(
        `/api/admin/students/${encodeURIComponent(studentId)}/practice-entitlements`
      );
      const payload = (await response.json().catch(() => ({}))) as EntitlementsPayload;
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? "练习额度加载失败，请稍后重试。");
      }
      if (!validSnapshotRows(payload.entitlements)) {
        throw new Error("练习额度数据不完整，请重新打开面板。");
      }
      setRows(payload.entitlements);
      setDraft(draftFromRows(payload.entitlements));
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "练习额度加载失败，请稍后重试。"
      );
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateDraft(kind: PracticeEntitlementKind, value: string) {
    setDraft((current) => ({ ...current, [kind]: value }));
    setSaveError("");
    setSavedMessage("");
  }

  /**
   * Form-only bulk action: it never calls the API. The eight values are still
   * saved together by 保存额度, and any field can be changed afterwards.
   */
  function applyBulkValue() {
    setSaveError("");
    setSavedMessage("");
    const parsed = parsePracticeEntitlementBulkValue(bulkValue);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }
    setDraft(
      Object.fromEntries(
        PRACTICE_ENTITLEMENT_KINDS.map((kind) => [kind, parsed.text])
      ) as Draft
    );
    setBulkValue(parsed.text);
  }

  async function save() {
    if (saving) return;
    const validated = validatePracticeEntitlementFormValues(draft);
    if (!validated.ok) {
      setSaveError(validated.error);
      return;
    }

    setSaving(true);
    setSaveError("");
    setSavedMessage("");
    try {
      const response = await authorizedFetch(
        `/api/admin/students/${encodeURIComponent(studentId)}/practice-entitlements`,
        {
          method: "PATCH",
          body: JSON.stringify({ entitlements: validated.values })
        }
      );
      const payload = (await response.json().catch(() => ({}))) as EntitlementsPayload;
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? "练习额度保存失败，请稍后重试。");
      }
      if (!validSnapshotRows(payload.entitlements)) {
        throw new Error("保存结果未确认，请重新打开面板读取最新额度。");
      }
      // Only a confirmed database snapshot replaces the displayed values. On
      // failure the previous valid rows and draft remain untouched.
      setRows(payload.entitlements);
      setDraft(draftFromRows(payload.entitlements));
      setSavedMessage("已保存，显示数据库返回的最新额度。");
      publishCacheInvalidation({
        type: "PRACTICE_ENTITLEMENT_CHANGED",
        studentId
      });
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "练习额度保存失败，请稍后重试。"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="wide"
      containFocus
      label="练习权限"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-student-primary">学生练习权限</p>
          <h3 className="mt-1 truncate text-lg font-bold text-student-text">
            {studentName}
          </h3>
        </div>
        <button
          className="teacher-button-secondary min-h-9 shrink-0 px-3 py-1.5 text-sm"
          disabled={saving}
          onClick={onClose}
          type="button"
        >
          关闭
        </button>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-student-muted">正在读取数据库最新额度...</p>
      ) : loadError ? (
        <div className="mt-6">
          <p className="text-sm font-semibold text-student-error" role="alert">
            {loadError}
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button className="teacher-button-secondary" onClick={onClose} type="button">
              关闭
            </button>
            <button className="teacher-button-primary" onClick={() => void load()} type="button">
              重试
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-student-border bg-student-bg/60 px-4 py-3">
            <span className="text-sm font-bold text-student-text">统一设置：</span>
            <input
              aria-label="统一额度"
              className="h-10 w-28 rounded-lg border border-student-border bg-white px-3 text-right text-sm font-bold text-student-text focus:border-student-primary disabled:opacity-60"
              disabled={saving || rows.length === 0}
              inputMode="numeric"
              max={MAX_PRACTICE_ENTITLEMENT_REMAINING}
              min={0}
              onChange={(event) => {
                setBulkValue(event.target.value);
                setSaveError("");
                setSavedMessage("");
              }}
              step={1}
              type="number"
              value={bulkValue}
            />
            <button
              className="teacher-button-secondary min-h-10"
              disabled={saving || rows.length === 0}
              onClick={applyBulkValue}
              type="button"
            >
              应用到全部
            </button>
          </div>

          <div className="mt-5 grid gap-5">
            {PRACTICE_ENTITLEMENT_GROUPS.map((group) => (
              <section key={group.title}>
                <h4 className="text-sm font-bold text-student-text">{group.title}</h4>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {group.kinds.map((kind) => {
                    const label = PRACTICE_ENTITLEMENT_LABELS[kind];
                    return (
                      <label
                        className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-student-border bg-white px-4 py-3"
                        key={kind}
                      >
                        <span className="shrink-0 whitespace-nowrap rounded-md bg-student-primary-soft px-2 py-0.5 text-[11px] font-bold text-student-primary">
                          {PRACTICE_ENTITLEMENT_SHORT_LABELS[kind]}
                        </span>
                        <input
                          aria-label={`${label}剩余次数`}
                          className="h-10 w-24 shrink-0 rounded-lg border border-student-border bg-white px-3 text-right text-sm font-bold text-student-text focus:border-student-primary disabled:opacity-60"
                          disabled={saving}
                          inputMode="numeric"
                          max={MAX_PRACTICE_ENTITLEMENT_REMAINING}
                          min={0}
                          onChange={(event) => updateDraft(kind, event.target.value)}
                          step={1}
                          type="number"
                          value={draft[kind] ?? ""}
                        />
                      </label>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          {saveError ? (
            <p className="mt-4 text-sm font-semibold text-student-error" role="alert">
              {saveError}
            </p>
          ) : null}
          {savedMessage ? (
            <p className="mt-4 text-sm font-semibold text-student-primary" role="status">
              {savedMessage}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              className="teacher-button-secondary"
              disabled={saving}
              onClick={onClose}
              type="button"
            >
              取消
            </button>
            <button
              className="teacher-button-primary"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "保存中…" : "保存额度"}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
