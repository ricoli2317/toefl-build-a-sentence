"use client";

import { KeyRound } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY,
  isCategoryPracticeEntitlementKind,
  practiceEntitlementRemainingMap,
  type PracticeEntitlementKind,
  type StudentPracticeEntitlementsPayload
} from "@/lib/practiceEntitlements";
import {
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { useCurrentAccount } from "@/components/RoleGate";

export type StudentEntitlementViewerRole = "student" | "teacher" | "admin" | null;

function normalizeViewerRole(value: unknown): StudentEntitlementViewerRole {
  return value === "student" || value === "teacher" || value === "admin" ? value : null;
}

async function loadStudentEntitlements(
  session: StudentCacheSession
): Promise<StudentPracticeEntitlementsPayload> {
  const response = await fetch("/api/student/practice-entitlements", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json().catch(() => ({}))) as {
    entitlements?: unknown;
    enforcementEnabled?: unknown;
    viewerRole?: unknown;
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? "练习额度加载失败，请稍后重试。");
  }
  if (!Array.isArray(payload.entitlements)) {
    throw new Error("练习额度返回数据无效。");
  }
  return {
    entitlements: payload.entitlements as StudentPracticeEntitlementsPayload["entitlements"],
    enforcementEnabled: payload.enforcementEnabled === true,
    viewerRole: normalizeViewerRole(payload.viewerRole)
  };
}

/**
 * One shared Student entitlement read for all Student catalog UIs. It is never
 * used as an authorization decision; every Start still goes through the
 * database. `refreshOnMount` makes a return to a catalog pick up an Admin
 * balance change without polling or a second feature switch.
 */
export function useStudentPracticeEntitlements() {
  const cache = useStudentDataCache();
  const account = useCurrentAccount();
  const studentViewer = account.role === "student";
  const state = useStudentCachedData<StudentPracticeEntitlementsPayload>(
    STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY,
    loadStudentEntitlements,
    { enabled: studentViewer, refreshOnMount: studentViewer }
  );
  const byKind = useMemo(
    () => practiceEntitlementRemainingMap(state.data?.entitlements ?? []),
    [state.data?.entitlements]
  );
  const viewerRole = account.role;
  const enforcementEnabled = studentViewer && state.data?.enforcementEnabled === true;
  const remaining = useCallback(
    (kind: PracticeEntitlementKind) => byKind.get(kind) ?? null,
    [byKind]
  );
  const exhausted = useCallback(
    (kind: PracticeEntitlementKind) =>
      viewerRole === "student"
      && enforcementEnabled
      && (remaining(kind) ?? 0) <= 0,
    [enforcementEnabled, remaining, viewerRole]
  );
  const invalidate = useCallback(
    () => cache.invalidate(STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY),
    [cache]
  );
  return {
    ...state,
    byKind,
    enforcementEnabled,
    exhausted,
    invalidate,
    remaining,
    viewerRole
  };
}

function ordinaryQuotaLabel(kind: PracticeEntitlementKind) {
  return kind === "build_sentence" ? "剩余新套题解锁次数" : "剩余新题解锁次数";
}

export function StudentEntitlementNotice({
  className = "",
  kind
}: {
  className?: string;
  kind: PracticeEntitlementKind;
}) {
  const state = useStudentPracticeEntitlements();
  if (state.loading || !state.data || state.viewerRole !== "student") return null;

  const remaining = state.remaining(kind);
  const category = isCategoryPracticeEntitlementKind(kind);
  const exhausted = state.enforcementEnabled && (remaining ?? 0) <= 0;
  const value = remaining === null ? "—" : String(remaining);
  const detail = !state.enforcementEnabled
    ? "当前权限限制尚未启用；历史解锁与练习记录仍然有效。"
    : exhausted
      ? category
        ? "自主练习次数已用完，已有练习仍可继续。"
        : "新题解锁次数已用完，仍可练习已解锁的题目。"
      : category
        ? "每次开始新的分类练习消耗 1 次；未完成的练习可继续。"
        : "首次练习未解锁题目消耗 1 次；已解锁题目不限次数。";

  return (
    <div
      aria-live="polite"
      className={`flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-student-primary-border bg-student-primary-soft px-3.5 py-2 text-xs leading-5 text-student-muted ${className}`}
      data-enforcement={state.enforcementEnabled ? "on" : "off"}
      data-kind={kind}
      data-remaining={value}
      data-testid="student-entitlement-notice"
    >
      <KeyRound aria-hidden="true" className="shrink-0 text-student-primary" size={17} strokeWidth={1.9} />
      <span className="font-semibold text-student-primary">
        {category ? "剩余自主练习次数" : ordinaryQuotaLabel(kind)}：{value}
      </span>
      <span>· {detail}</span>
    </div>
  );
}

export function StudentUnlockBadge({
  enforcementEnabled,
  remaining,
  status,
  unlocked,
  viewerRole
}: {
  enforcementEnabled: boolean;
  remaining: number | null;
  status: "unstarted" | "in_progress" | "completed";
  unlocked?: boolean;
  viewerRole: StudentEntitlementViewerRole;
}) {
  if (viewerRole !== "student") return null;
  if (unlocked) {
    return (
      <span
        className="inline-flex min-h-5 items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
        data-testid="student-unlock-badge"
        title="该 canonical 题目已永久解锁，不再消耗新题额度。"
      >
        已解锁
      </span>
    );
  }
  if (status !== "unstarted" || !enforcementEnabled) return null;
  if (remaining !== null && remaining <= 0) {
    return (
      <span
        className="inline-flex min-h-5 items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-student-error"
        data-testid="student-unlock-badge"
      >
        额度已用完
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-h-5 items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
      data-testid="student-unlock-badge"
      title="首次练习该题会消耗 1 次新题解锁额度。"
    >
      首次解锁
    </span>
  );
}
