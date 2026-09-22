"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, UserRound } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  TeacherCard,
  TeacherEmptyState,
  TeacherSectionTitle
} from "@/components/teacher/TeacherUI";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import type {
  WritingAssignmentTransferBoard,
  WritingAssignmentTransferUnit
} from "@/lib/writingAssignmentTransfer";

type TransferUnitKey = `${"assignment" | "group"}:${string}`;

const TASK_TYPE_LABELS: Record<string, string> = {
  email: "Email",
  academic_discussion: "Academic Discussion"
};

async function authorizedFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
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

function unitKey(unit: WritingAssignmentTransferUnit): TransferUnitKey {
  return `${unit.unitType}:${unit.unitId}`;
}

function unitLabel(unit: WritingAssignmentTransferUnit) {
  return unit.unitType === "group" ? `历史作业组（${unit.assignments.length} 篇）` : "历史作业";
}

function formatTransferDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function WritingAssignmentTransfer() {
  const [board, setBoard] = useState<WritingAssignmentTransferBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedUnitKey, setSelectedUnitKey] = useState<TransferUnitKey | "">("");
  const [targetTeacherId, setTargetTeacherId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authorizedFetch("/api/admin/writing-assignment-transfer");
    const data = await res.json().catch(() => ({})) as Partial<WritingAssignmentTransferBoard> & { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "历史作业转移数据加载失败。");
      return;
    }
    setError("");
    setBoard({ units: data.units ?? [], teachers: data.teachers ?? [] });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selectedUnit = useMemo(
    () => (board?.units ?? []).find((unit) => unitKey(unit) === selectedUnitKey) ?? null,
    [board, selectedUnitKey]
  );
  const selectedTeacher = useMemo(
    () => (board?.teachers ?? []).find((teacher) => teacher.id === targetTeacherId) ?? null,
    [board, targetTeacherId]
  );
  const compatibility = selectedUnit && targetTeacherId
    ? selectedUnit.compatibility[targetTeacherId] ?? null
    : null;

  function selectUnit(unit: WritingAssignmentTransferUnit) {
    setNotice("");
    setError("");
    setTargetTeacherId("");
    setSelectedUnitKey(unitKey(unit));
  }

  async function submitTransfer() {
    if (!selectedUnit || !selectedTeacher || submitting) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    const res = await authorizedFetch("/api/admin/writing-assignment-transfer", {
      method: "POST",
      body: JSON.stringify({
        unitType: selectedUnit.unitType,
        unitId: selectedUnit.unitId,
        targetTeacherId: selectedTeacher.id
      })
    });
    const data = await res.json().catch(() => ({})) as { message?: string };
    setSubmitting(false);
    if (!res.ok) {
      setError(data.message ?? "历史作业转移失败，请稍后重试。");
      return;
    }
    setNotice(`已将${unitLabel(selectedUnit)}「${selectedUnit.title}」转移给 ${selectedTeacher.displayName}。`);
    setSelectedUnitKey("");
    setTargetTeacherId("");
    await load();
    publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
  }

  if (loading) return <p className="text-sm text-student-muted">正在加载...</p>;
  if (error && !board) return <p className="teacher-error">{error}</p>;

  const units = board?.units ?? [];
  const teachers = board?.teachers ?? [];

  return (
    <div className="grid gap-6">
      {notice ? <p className="text-sm font-semibold text-student-primary">{notice}</p> : null}
      {error ? <p className="teacher-error">{error}</p> : null}

      <TeacherCard className="overflow-hidden p-0">
        <div className="px-6 pt-6">
          <TeacherSectionTitle>Admin 历史 Writing 作业</TeacherSectionTitle>
          <p className="mt-2 text-sm text-student-muted">
            仅显示当前仍由 Admin 账号拥有的历史作业与作业组。转移只变更 Assignment Owner，学生提交、批改和 AI 记录保持不变。
          </p>
        </div>
        {units.length === 0 ? (
          <div className="p-6"><TeacherEmptyState text="暂无可转移的 Admin 历史作业。" /></div>
        ) : (
          <div className="overflow-x-auto px-6 pb-6 pt-4">
            <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-student-border text-student-muted">
                  <th className="px-3 py-3 font-medium">作业</th>
                  <th className="px-3 py-3 font-medium">学生</th>
                  <th className="px-3 py-3 font-medium">类型</th>
                  <th className="px-3 py-3 font-medium">创建时间</th>
                  <th className="px-3 py-3 font-medium">完成情况</th>
                  <th className="px-3 py-3 font-medium">当前 Owner</th>
                  <th className="px-3 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {units.map((unit) => (
                  <tr className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45" key={unitKey(unit)}>
                    <td className="px-3 py-4 align-top">
                      <p className="font-semibold text-student-text">{unit.title}</p>
                      <p className="mt-1 text-xs text-student-muted">
                        {unitLabel(unit)}
                        {unit.assignments.some((assignment) => assignment.status === "withdrawn") ? " · 含已撤回" : ""}
                        {unit.assignments.some((assignment) => assignment.deleted) ? " · 含已删除" : ""}
                      </p>
                    </td>
                    <td className="px-3 py-4 align-top">
                      {unit.recipients.length === 0 ? (
                        <span className="text-student-muted">—</span>
                      ) : (
                        <ul className="grid gap-1">
                          {unit.recipients.map((recipient) => (
                            <li className="text-student-text" key={recipient.id}>
                              {recipient.displayName}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-4 align-top text-student-text">
                      {unit.taskTypes.map((taskType) => TASK_TYPE_LABELS[taskType] ?? taskType).join(" / ")}
                    </td>
                    <td className="px-3 py-4 align-top whitespace-nowrap text-student-muted">
                      {formatTransferDate(unit.createdAt)}
                    </td>
                    <td className="px-3 py-4 align-top text-student-muted">
                      {unit.hasSubmittedAttempt
                        ? `${unit.submittedAttemptCount} 次提交`
                        : "尚无提交"}
                      {unit.hasPublishedReview ? ` · ${unit.publishedReviewCount} 份已发布` : ""}
                    </td>
                    <td className="px-3 py-4 align-top">
                      <span className="font-semibold text-student-text">{unit.ownerName}</span>
                      <p className="mt-1 text-xs text-student-muted">Admin</p>
                    </td>
                    <td className="px-3 py-4 align-top">
                      <button
                        className="teacher-button-secondary"
                        disabled={teachers.length === 0}
                        onClick={() => selectUnit(unit)}
                        type="button"
                      >
                        <ArrowRightLeft aria-hidden="true" size={16} strokeWidth={2} />
                        转移
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TeacherCard>

      {selectedUnit ? (
        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>转移确认</TeacherSectionTitle>
          <p className="mt-3 text-sm text-student-text">
            已选择：{unitLabel(selectedUnit)}「{selectedUnit.title}」，共 {selectedUnit.recipients.length} 名学生。
          </p>
          <label className="mt-5 grid gap-2.5 text-sm font-semibold text-student-text">
            目标教师
            <select
              className="h-12 max-w-[360px] rounded-xl border border-student-border bg-white px-3 font-normal text-student-text"
              onChange={(event) => setTargetTeacherId(event.target.value)}
              value={targetTeacherId}
            >
              <option value="">请选择教师</option>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.displayName}（{formatAccountForDisplay(teacher.email) || teacher.email}）
                </option>
              ))}
            </select>
          </label>

          {selectedTeacher && compatibility && !compatibility.eligible ? (
            <div className="mt-5 rounded-xl border border-student-error-border bg-student-error-soft p-4 text-sm text-student-error">
              <p className="font-semibold">以下学生尚未绑定该 Writing Teacher：</p>
              <ul className="mt-2 grid gap-1">
                {compatibility.missingStudents.map((student) => (
                  <li key={student.id}>{student.displayName}</li>
                ))}
              </ul>
              <p className="mt-3">
                请先前往{" "}
                <Link className="font-semibold underline" href="/admin/student-bindings">
                  教师绑定
                </Link>{" "}
                完成配置后再转移。
              </p>
            </div>
          ) : null}

          {selectedTeacher && compatibility?.eligible ? (
            <div className="mt-5 rounded-xl border border-student-primary-border bg-student-primary-soft/55 p-4 text-sm text-student-text">
              <p className="font-semibold">
                确认将该{selectedUnit.unitType === "group" ? "历史作业组" : "历史作业"}转移给 {selectedTeacher.displayName}？
              </p>
              <ul className="mt-3 grid gap-1.5 text-student-muted">
                <li>· 学生提交、批改和 AI 记录保持不变</li>
                <li>· 目标教师将成为该作业唯一 Owner</li>
                <li>· Admin 不再通过教学工作流管理该作业</li>
              </ul>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="teacher-button-primary"
              disabled={
                !selectedTeacher ||
                !compatibility?.eligible ||
                submitting
              }
              onClick={() => void submitTransfer()}
              type="button"
            >
              <UserRound aria-hidden="true" size={16} strokeWidth={2} />
              {submitting ? "正在转移..." : "确认转移"}
            </button>
            <button
              className="teacher-button-secondary"
              onClick={() => {
                setSelectedUnitKey("");
                setTargetTeacherId("");
              }}
              type="button"
            >
              取消
            </button>
          </div>
        </TeacherCard>
      ) : null}
    </div>
  );
}
