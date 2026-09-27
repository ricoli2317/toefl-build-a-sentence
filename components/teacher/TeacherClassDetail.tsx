"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ClipboardList,
  ClipboardPenLine,
  Pencil,
  Plus,
  UserRound,
  UsersRound
} from "lucide-react";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import {
  TEACHER_CLASS_DETAIL_CACHE_PREFIX,
  TEACHER_CLASS_STUDENTS_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import { TeacherSubjectFieldset } from "@/components/teacher/TeacherSubjectFieldset";
import {
  TeacherClassMemberEditor,
  applyDuplicateMemberIssues,
  type ClassMemberDraft
} from "@/components/teacher/TeacherClassMemberEditor";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { SubjectChip } from "@/components/teacher/TeacherStudentOverview";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import {
  classCompletionPercent,
  classIncludesWriting,
  formatClassCompletion,
  type ClassStudentCandidate,
  type TeacherClassDetail as TeacherClassDetailData,
  type TeacherClassMember
} from "@/lib/teacherClasses";

type DetailPayload = { detail: TeacherClassDetailData };
type ClassMutationPayload = {
  class?: TeacherClassDetailData["class"];
  detail?: TeacherClassDetailData;
  error?: string;
  code?: string;
  memberIndex?: number;
  members?: Array<{
    member_index: number;
    student_name: string;
    candidates: Array<{ id: string; displayName: string; email: string }>;
  }>;
};

type DialogState = "none" | "name" | "subjects" | "add" | "remove";

/**
 * 班级首页 / 详情: class header (rename + subjects), member list with the
 * class-scoped completion rate, member management and the 作业管理 / 写作批改
 * entries. Reuses the shared cards, buttons, subject selector, member editor
 * and ModalShell.
 */
export function TeacherClassDetail({ classId }: { classId: string }) {
  const cache = useTeacherDataCache();
  const cacheKey = `${TEACHER_CLASS_DETAIL_CACHE_PREFIX}:${classId}`;
  const { data, error, loading } = useTeacherCachedData<DetailPayload>(cacheKey, () =>
    teacherApiFetch(`/api/teacher/classes/${encodeURIComponent(classId)}`)
  );
  const candidatesState = useTeacherCachedData<{ students: ClassStudentCandidate[] }>(
    TEACHER_CLASS_STUDENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes/students")
  );
  const detail = data?.detail ?? null;

  const [dialog, setDialog] = useState<DialogState>("none");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [subjectsDraft, setSubjectsDraft] = useState<StudentBindingDomain[]>([]);
  const [writingDecision, setWritingDecision] = useState<"keep" | "remove" | null>(null);
  const [addDrafts, setAddDrafts] = useState<ClassMemberDraft[]>([]);
  const [removeTarget, setRemoveTarget] = useState<TeacherClassMember | null>(null);

  function closeDialog() {
    setDialog("none");
    setBusy(false);
    setDialogError("");
    setRemoveTarget(null);
  }

  function openNameDialog() {
    if (!detail) return;
    setNameDraft(detail.class.name);
    setDialogError("");
    setDialog("name");
  }

  function openSubjectsDialog() {
    if (!detail) return;
    setSubjectsDraft(detail.class.subjects);
    setWritingDecision(null);
    setDialogError("");
    setDialog("subjects");
  }

  function openAddDialog() {
    setAddDrafts([]);
    setDialogError("");
    setDialog("add");
  }

  function openRemoveDialog(member: TeacherClassMember) {
    if (!detail) return;
    // Reading-only classes remove the membership directly, without a
    // writing-style confirmation.
    if (!classIncludesWriting(detail.class.subjects)) {
      void removeMember(member, null);
      return;
    }
    setRemoveTarget(member);
    setDialogError("");
    setDialog("remove");
  }

  function applyDetail(payload: ClassMutationPayload, options?: { bindingsChanged?: boolean }) {
    if (!payload.detail) return;
    cache.set<DetailPayload>(cacheKey, { detail: payload.detail });
    publishCacheInvalidation({ type: "CLASS_UPDATED" });
    if (options?.bindingsChanged) {
      publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
    }
  }

  async function saveName() {
    if (!detail) return;
    const name = nameDraft.trim();
    if (!name) return setDialogError("请填写班级名称。");
    setBusy(true);
    setDialogError("");
    try {
      const payload = await teacherApiFetch<ClassMutationPayload>(
        `/api/teacher/classes/${encodeURIComponent(classId)}`,
        { method: "PATCH", body: JSON.stringify({ name }) }
      );
      applyDetail(payload);
      closeDialog();
    } catch (mutation) {
      setDialogError(localizeClassError(mutation, "保存失败，请稍后重试。"));
      setBusy(false);
    }
  }

  async function saveSubjects() {
    if (!detail) return;
    if (subjectsDraft.length === 0) return setDialogError("请至少选择一个授课科目。");
    const needsDecision =
      classIncludesWriting(detail.class.subjects) && !classIncludesWriting(subjectsDraft);
    if (needsDecision && !writingDecision) {
      return setDialogError("请选择是否继续接收这些学生的写作练习。");
    }
    setBusy(true);
    setDialogError("");
    try {
      const payload = await teacherApiFetch<ClassMutationPayload>(
        `/api/teacher/classes/${encodeURIComponent(classId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            subjects: subjectsDraft,
            ...(needsDecision ? { writingDecision } : {})
          })
        }
      );
      applyDetail(payload, { bindingsChanged: true });
      closeDialog();
    } catch (mutation) {
      setDialogError(localizeClassError(mutation, "保存失败，请稍后重试。"));
      setBusy(false);
    }
  }

  async function saveAddedMembers() {
    if (addDrafts.length === 0) return setDialogError("请至少添加一名学生。");
    for (const draft of addDrafts) {
      if (draft.kind !== "new") continue;
      if (!draft.student_name.trim()) return setDialogError("请填写新学生的姓名。");
      if (!draft.account.trim()) return setDialogError("请填写新学生的账号。");
    }
    setBusy(true);
    setDialogError("");
    try {
      const payload = await teacherApiFetch<ClassMutationPayload>(
        `/api/teacher/classes/${encodeURIComponent(classId)}/members`,
        {
          method: "POST",
          body: JSON.stringify({
            members: addDrafts.map((draft) =>
              draft.kind === "existing"
                ? { kind: "existing", student_id: draft.student_id }
                : {
                    kind: "new",
                    student_name: draft.student_name.trim(),
                    account: draft.account.trim(),
                    account_edited: draft.account_edited,
                    confirm_duplicate_name: draft.confirmed_new === true
                  }
            )
          })
        }
      );
      applyDetail(payload, { bindingsChanged: true });
      closeDialog();
    } catch (mutation) {
      const payload = extractErrorPayload(mutation);
      if (payload?.code === "DUPLICATE_MEMBERS" && (payload.members?.length ?? 0) > 0) {
        setAddDrafts((current) => applyDuplicateMemberIssues(current, payload.members ?? []));
        setDialogError("已存在同名学生，请选择“绑定已有学生”或“继续新增”。");
      } else {
        setDialogError(localizeClassError(mutation, "添加学生失败，请稍后重试。"));
      }
      setBusy(false);
    }
  }

  async function removeMember(member: TeacherClassMember, decision: "keep" | "remove" | null) {
    setBusy(true);
    setDialogError("");
    try {
      const query = decision ? `?writingDecision=${decision}` : "";
      const payload = await teacherApiFetch<ClassMutationPayload>(
        `/api/teacher/classes/${encodeURIComponent(classId)}/members/${encodeURIComponent(member.student_id)}${query}`,
        { method: "DELETE" }
      );
      applyDetail(payload, { bindingsChanged: decision !== null });
      closeDialog();
    } catch (mutation) {
      if (decision !== null) {
        setDialogError(localizeClassError(mutation, "移除学生失败，请稍后重试。"));
        setBusy(false);
      }
    }
  }

  if (loading) {
    return (
      <div className="grid gap-5">
        <TeacherLoadingRegion label="正在加载班级信息" />
        <TeacherCard className="p-6 sm:p-7">
          <TeacherSkeleton className="h-9 w-56" />
          <TeacherSkeleton className="mt-4 h-6 w-40" />
        </TeacherCard>
        <TeacherCard className="p-6"><TeacherSkeleton className="h-32 w-full" /></TeacherCard>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <TeacherCard className="p-6">
        <TeacherDataError
          text={error ? localizeClassError(error, "班级信息加载失败，请稍后重试。") : "班级不存在或已被移除。"}
        />
      </TeacherCard>
    );
  }

  const { class: classInfo, members } = detail;
  const writingClass = classIncludesWriting(classInfo.subjects);
  const needsWritingDecision =
    classIncludesWriting(classInfo.subjects) && !classIncludesWriting(subjectsDraft);

  return (
    <div className="grid gap-5">
      <TeacherCard className="p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-student-primary-soft text-student-primary">
                <TeacherClassIcon aria-hidden="true" size={26} strokeWidth={1.9} />
              </span>
              <h2 className="text-xl font-bold text-student-text">{classInfo.name}</h2>
              <button
                aria-label={`修改 ${classInfo.name} 的班级名称`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-student-muted transition hover:bg-student-primary-soft hover:text-student-primary"
                onClick={openNameDialog}
                title="修改班级名称"
                type="button"
              >
                <Pencil aria-hidden="true" size={15} strokeWidth={2} />
              </button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm text-student-muted">
              <span className="flex flex-wrap gap-1.5">
                {classInfo.subjects.map((domain) => <SubjectChip domain={domain} key={domain} />)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <UsersRound aria-hidden="true" size={16} strokeWidth={1.9} />
                {classInfo.member_count} 名学生
              </span>
              <button className="teacher-button-secondary" onClick={openSubjectsDialog} type="button">
                修改授课科目
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="teacher-button-primary" onClick={openAddDialog} type="button">
              <Plus aria-hidden="true" size={17} strokeWidth={2} />
              添加学生
            </button>
            <Link
              className="teacher-button-secondary"
              href={`/teacher/writing/assignments?view=class&classId=${encodeURIComponent(classInfo.class_id)}`}
            >
              <ClipboardList aria-hidden="true" size={16} strokeWidth={2} />
              作业管理
            </Link>
            {writingClass ? (
              <Link
                className="teacher-button-secondary"
                href={`/teacher/writing/reviews?tab=class&classId=${encodeURIComponent(classInfo.class_id)}`}
              >
                <ClipboardPenLine aria-hidden="true" size={16} strokeWidth={2} />
                写作批改
              </Link>
            ) : null}
          </div>
        </div>
      </TeacherCard>

      <TeacherCard className="p-0">
        <div className="px-6 pt-6">
          <TeacherSectionTitle>班级成员</TeacherSectionTitle>
        </div>
        <div className="overflow-x-auto px-6 pb-6 pt-4">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-student-border text-student-muted">
                <th className="px-3 py-3 font-medium">学生</th>
                <th className="px-3 py-3 font-medium">班级作业完成率</th>
                <th className="w-px whitespace-nowrap px-3 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-student-muted" colSpan={3}>
                    班级还没有学生。点击右上角“添加学生”添加。
                  </td>
                </tr>
              ) : (
                members.map((member) => {
                  const counts = {
                    completed: member.completed_count,
                    total: member.total_count
                  };
                  const percent = classCompletionPercent(counts);
                  return (
                    <tr
                      className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45"
                      key={member.student_id}
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                            <UserRound aria-hidden="true" size={20} strokeWidth={1.9} />
                          </span>
                          <span className="font-semibold text-student-text">{member.student_name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 tabular-nums text-student-text">
                        {formatClassCompletion(counts)}
                        {percent !== null ? (
                          <span className="ml-2 text-student-muted">（{percent}%）</span>
                        ) : null}
                      </td>
                      <td className="w-px whitespace-nowrap px-3 py-3 text-right">
                        <div className="flex flex-nowrap items-center justify-end gap-2">
                          <Link
                            className="teacher-button-secondary"
                            href={`/teacher/students/${encodeURIComponent(member.student_id)}`}
                          >
                            查看详情
                          </Link>
                          <button
                            className="teacher-button-secondary text-student-error"
                            onClick={() => openRemoveDialog(member)}
                            type="button"
                          >
                            移除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </TeacherCard>

      <ModalShell open={dialog === "name"} onClose={closeDialog}>
        <p className="text-base font-bold text-student-text">修改班级名称</p>
        <input
          aria-label="班级名称"
          className="teacher-input mt-4 w-full"
          maxLength={60}
          onChange={(event) => setNameDraft(event.target.value)}
          value={nameDraft}
        />
        {dialogError ? <p className="teacher-error mt-3">{dialogError}</p> : null}
        <div className="mt-6 flex justify-end gap-3">
          <button className="teacher-button-secondary" disabled={busy} onClick={closeDialog} type="button">取消</button>
          <button className="teacher-button-primary" disabled={busy} onClick={() => void saveName()} type="button">
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </ModalShell>

      <ModalShell open={dialog === "subjects"} onClose={closeDialog} size="wide">
        <p className="text-base font-bold text-student-text">修改授课科目</p>
        <div className="mt-4">
          <TeacherSubjectFieldset
            helpText="可同时选择阅读和写作；移除写作时会询问是否继续接收这些学生的写作练习。"
            onChange={(next) => {
              setSubjectsDraft(next);
              setWritingDecision(null);
            }}
            value={subjectsDraft}
          />
        </div>
        {needsWritingDecision ? (
          <div className="mt-4 rounded-xl border border-student-primary-border bg-student-primary-soft/40 p-4">
            <p className="text-sm font-bold text-student-text">是否继续接收这些学生的写作练习？</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                aria-pressed={writingDecision === "keep"}
                className={writingDecision === "keep" ? "teacher-button-primary" : "teacher-button-secondary"}
                onClick={() => setWritingDecision("keep")}
                type="button"
              >
                继续接收
              </button>
              <button
                aria-pressed={writingDecision === "remove"}
                className={writingDecision === "remove" ? "teacher-button-primary" : "teacher-button-secondary"}
                onClick={() => setWritingDecision("remove")}
                type="button"
              >
                不再接收
              </button>
            </div>
          </div>
        ) : null}
        {dialogError ? <p className="teacher-error mt-3">{dialogError}</p> : null}
        <div className="mt-6 flex justify-end gap-3">
          <button className="teacher-button-secondary" disabled={busy} onClick={closeDialog} type="button">取消</button>
          <button className="teacher-button-primary" disabled={busy} onClick={() => void saveSubjects()} type="button">
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </ModalShell>

      <ModalShell open={dialog === "add"} onClose={closeDialog} size="wide">
        <p className="text-base font-bold text-student-text">添加学生</p>
        <p className="mt-2 text-sm text-student-muted">
          可以添加新学生，也可以选择已经绑定的学生；需要时会自动补齐班级科目的访问权限。
        </p>
        <div className="mt-4">
          <TeacherClassMemberEditor
            candidates={candidatesState.data?.students ?? []}
            candidatesError={
              candidatesState.error ? localizeClassError(candidatesState.error, "学生列表加载失败。") : ""
            }
            candidatesLoading={candidatesState.loading}
            disabled={busy}
            drafts={addDrafts}
            excludedStudentIds={members.map((member) => member.student_id)}
            onChange={setAddDrafts}
          />
        </div>
        {dialogError ? <p className="teacher-error mt-3">{dialogError}</p> : null}
        <div className="mt-6 flex justify-end gap-3">
          <button className="teacher-button-secondary" disabled={busy} onClick={closeDialog} type="button">取消</button>
          <button className="teacher-button-primary" disabled={busy} onClick={() => void saveAddedMembers()} type="button">
            {busy ? "添加中…" : "添加"}
          </button>
        </div>
      </ModalShell>

      <ModalShell open={dialog === "remove" && removeTarget !== null} onClose={closeDialog}>
        <p className="text-base font-bold text-student-text">移除学生</p>
        <p className="mt-3 text-sm text-student-muted">
          将「{removeTarget?.student_name ?? ""}」移出「{classInfo.name}」后，是否继续接收他的写作练习？
        </p>
        {dialogError ? <p className="teacher-error mt-3">{dialogError}</p> : null}
        <div className="mt-6 grid gap-3">
          <button
            className="teacher-button-primary"
            disabled={busy}
            onClick={() => removeTarget && void removeMember(removeTarget, "keep")}
            type="button"
          >
            继续接收
          </button>
          <button
            className="teacher-button-secondary"
            disabled={busy}
            onClick={() => removeTarget && void removeMember(removeTarget, "remove")}
            type="button"
          >
            不再接收
          </button>
          <button className="text-sm font-medium text-student-muted hover:text-student-text" onClick={closeDialog} type="button">
            取消
          </button>
        </div>
      </ModalShell>
    </div>
  );
}

function extractErrorPayload(error: unknown) {
  if (!(error instanceof Error)) return null;
  return ((error as Error & { payload?: ClassMutationPayload }).payload ?? null);
}

function localizeClassError(error: unknown, fallback: string) {
  const message =
    error instanceof Error
      ? (error as Error & { payload?: ClassMutationPayload }).payload?.error ?? error.message
      : "";
  if (!message) return fallback;
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : fallback;
}
