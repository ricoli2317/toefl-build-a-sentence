"use client";

import { useState } from "react";
import { Check, ChevronDown, Plus, Search, UserRound, X } from "lucide-react";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { formatAccountForDisplay, normalizeNewAccountInput } from "@/lib/accountIdentifier";
import { accountBaseFromStudentName } from "@/lib/studentAccountSuggestion";
import { formatBindingDomainList, type StudentBindingDomain } from "@/lib/studentBindings";
import type { ClassStudentCandidate } from "@/lib/teacherClasses";

export type DuplicateMemberCandidate = {
  id: string;
  displayName: string;
  email: string;
};

export type ClassMemberDraft =
  | {
      kind: "existing";
      clientId: string;
      student_id: string;
      student_name: string;
      student_email: string;
      domains: StudentBindingDomain[];
    }
  | {
      kind: "new";
      clientId: string;
      student_name: string;
      account: string;
      account_edited: boolean;
      /** Teacher pressed 继续新增 for a same-name student. */
      confirmed_new?: boolean;
      /** Same-name candidates returned by the server; resolved inline. */
      duplicate_candidates?: DuplicateMemberCandidate[];
    };

function createClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createExistingMemberDraft(candidate: ClassStudentCandidate): ClassMemberDraft {
  return {
    kind: "existing",
    clientId: createClientId(),
    student_id: candidate.student_id,
    student_name: candidate.student_name,
    student_email: candidate.student_email,
    domains: candidate.domains
  };
}

export function createNewMemberDraft(): ClassMemberDraft {
  return {
    kind: "new",
    clientId: createClientId(),
    student_name: "",
    account: "",
    account_edited: false
  };
}

/** Applies the server's same-name issues to the matching new-student drafts. */
export function applyDuplicateMemberIssues(
  drafts: ClassMemberDraft[],
  issues: ReadonlyArray<{
    member_index: number;
    candidates: DuplicateMemberCandidate[];
  }>
): ClassMemberDraft[] {
  const byIndex = new Map(issues.map((issue) => [issue.member_index, issue.candidates]));
  return drafts.map((draft, index) => {
    const candidates = byIndex.get(index);
    if (!candidates || draft.kind !== "new") return draft;
    return { ...draft, confirmed_new: false, duplicate_candidates: candidates };
  });
}

/**
 * Shared class member editor: mixes 新建学生 accounts and 当前教师已绑定学生 in
 * one list, with the same pinyin account suggestion the class flow uses. The
 * create-class page renders it inline and the class detail page renders it
 * inside the 添加学生 dialog.
 */
export function TeacherClassMemberEditor({
  candidates,
  candidatesError,
  candidatesLoading,
  disabled = false,
  drafts,
  onChange,
  excludedStudentIds
}: {
  candidates: ClassStudentCandidate[];
  candidatesError: string;
  candidatesLoading: boolean;
  disabled?: boolean;
  drafts: ClassMemberDraft[];
  onChange: (drafts: ClassMemberDraft[]) => void;
  /** Students that must not be offered again (already in the class). */
  excludedStudentIds?: string[];
}) {
  const selectedIds = new Set(
    drafts.filter((draft) => draft.kind === "existing").map((draft) => draft.student_id)
  );

  function updateDraft(clientId: string, updater: (draft: ClassMemberDraft) => ClassMemberDraft) {
    onChange(drafts.map((draft) => (draft.clientId === clientId ? updater(draft) : draft)));
  }

  function removeDraft(clientId: string) {
    onChange(drafts.filter((draft) => draft.clientId !== clientId));
  }

  function addExistingStudent(candidate: ClassStudentCandidate) {
    if (selectedIds.has(candidate.student_id)) return;
    onChange([...drafts, createExistingMemberDraft(candidate)]);
  }

  function replaceWithExisting(clientId: string, candidate: DuplicateMemberCandidate) {
    updateDraft(clientId, () => ({
      kind: "existing",
      clientId,
      student_id: candidate.id,
      student_name: candidate.displayName,
      student_email: candidate.email,
      domains: []
    }));
  }

  return (
    <div className="grid gap-4">
      {drafts.length > 0 ? (
        <div className="grid gap-3">
          {drafts.map((draft) =>
            draft.kind === "existing" ? (
              <div
                className="flex flex-wrap items-center gap-3 rounded-xl border border-student-border bg-white px-4 py-3"
                key={draft.clientId}
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                  <UserRound aria-hidden="true" size={18} strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-student-text">{draft.student_name}</p>
                  <p className="text-xs text-student-muted">
                    账号：{formatAccountForDisplay(draft.student_email)}
                    {draft.domains.length > 0
                      ? ` · 当前科目：${formatBindingDomainList(draft.domains)}`
                      : " · 当前科目：暂无"}
                  </p>
                </div>
                <button
                  aria-label={`移除 ${draft.student_name || "学生"}`}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-student-muted transition hover:bg-student-primary-soft hover:text-student-primary disabled:opacity-50"
                  disabled={disabled}
                  onClick={() => removeDraft(draft.clientId)}
                  type="button"
                >
                  <X aria-hidden="true" size={17} strokeWidth={2} />
                </button>
              </div>
            ) : (
              <div
                className="grid gap-3 rounded-xl border border-student-border bg-white px-4 py-3"
                key={draft.clientId}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                    <Plus aria-hidden="true" size={18} strokeWidth={2} />
                  </span>
                  <label className="min-w-[180px] flex-1">
                    <span className="sr-only">学生姓名</span>
                    <input
                      aria-label="学生姓名"
                      className="teacher-input w-full"
                      disabled={disabled}
                      onChange={(event) => {
                        const studentName = event.target.value;
                        updateDraft(draft.clientId, (current) =>
                          current.kind === "new"
                            ? {
                                ...current,
                                student_name: studentName,
                                account: current.account_edited
                                  ? current.account
                                  : accountBaseFromStudentName(studentName)
                              }
                            : current
                        );
                      }}
                      placeholder="学生姓名"
                      value={draft.student_name}
                    />
                  </label>
                  <label className="min-w-[180px] flex-1">
                    <span className="sr-only">账号</span>
                    <input
                      aria-label="账号"
                      autoComplete="off"
                      className="teacher-input w-full"
                      disabled={disabled}
                      onBlur={() =>
                        updateDraft(draft.clientId, (current) =>
                          current.kind === "new"
                            ? { ...current, account: normalizeNewAccountInput(current.account) }
                            : current
                        )
                      }
                      onChange={(event) => {
                        const account = event.target.value;
                        updateDraft(draft.clientId, (current) =>
                          current.kind === "new"
                            ? { ...current, account, account_edited: true }
                            : current
                        );
                      }}
                      placeholder="账号（按姓名自动生成，可修改）"
                      type="text"
                      value={draft.account}
                    />
                  </label>
                  <button
                    aria-label={`移除 ${draft.student_name || "新学生"}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-student-muted transition hover:bg-student-primary-soft hover:text-student-primary disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => removeDraft(draft.clientId)}
                    type="button"
                  >
                    <X aria-hidden="true" size={17} strokeWidth={2} />
                  </button>
                </div>
                {draft.duplicate_candidates && draft.duplicate_candidates.length > 0 && !draft.confirmed_new ? (
                  <div className="rounded-xl border border-student-primary-border bg-student-primary-soft/40 p-4">
                    <p className="text-sm font-bold text-student-text">
                      已存在同名学生「{draft.student_name.trim()}」：
                    </p>
                    <div className="mt-3 grid gap-2">
                      {draft.duplicate_candidates.map((candidate) => (
                        <div className="flex flex-wrap items-center justify-between gap-3" key={candidate.id}>
                          <span className="text-sm text-student-text">
                            {candidate.displayName}（账号：{formatAccountForDisplay(candidate.email)}）
                          </span>
                          <button
                            className="teacher-button-secondary"
                            disabled={disabled}
                            onClick={() => replaceWithExisting(draft.clientId, candidate)}
                            type="button"
                          >
                            绑定已有学生
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      className="teacher-button-secondary mt-3"
                      disabled={disabled}
                      onClick={() =>
                        updateDraft(draft.clientId, (current) =>
                          current.kind === "new" ? { ...current, confirmed_new: true } : current
                        )
                      }
                      type="button"
                    >
                      继续新增
                    </button>
                  </div>
                ) : null}
              </div>
            )
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <TeacherPopover
          buttonClassName="teacher-button-secondary"
          buttonContent={
            <>
              <UserRound aria-hidden="true" size={17} strokeWidth={2} />
              添加已有学生
              <ChevronDown aria-hidden="true" size={15} />
            </>
          }
          menuAlign="left"
          menuClassName="min-w-[20rem]"
        >
          {() => (
            <AddExistingStudentMenu
              candidates={candidates}
              error={candidatesError}
              excludedStudentIds={excludedStudentIds ?? []}
              loading={candidatesLoading}
              onAdd={disabled ? () => undefined : addExistingStudent}
              selectedIds={selectedIds}
            />
          )}
        </TeacherPopover>
        <button
          className="teacher-button-secondary"
          disabled={disabled}
          onClick={() => onChange([...drafts, createNewMemberDraft()])}
          type="button"
        >
          <Plus aria-hidden="true" size={17} strokeWidth={2} />
          添加新学生
        </button>
      </div>
    </div>
  );
}

function AddExistingStudentMenu({
  candidates,
  error,
  excludedStudentIds,
  loading,
  onAdd,
  selectedIds
}: {
  candidates: ClassStudentCandidate[];
  error: string;
  excludedStudentIds: string[];
  loading: boolean;
  onAdd: (candidate: ClassStudentCandidate) => void;
  selectedIds: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const excluded = new Set(excludedStudentIds);
  const needle = query.trim().toLocaleLowerCase();
  const visible = candidates.filter(
    (candidate) =>
      !excluded.has(candidate.student_id)
      && (!needle || candidate.student_name.toLocaleLowerCase().includes(needle))
  );

  return (
    <div className="grid gap-2" role="none">
      <label className="relative block">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted"
          size={15}
        />
        <input
          className="teacher-input w-full pl-8"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索已绑定学生"
          value={query}
        />
      </label>
      <div className="grid max-h-64 gap-0.5 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-6 text-center text-sm text-student-muted">正在加载学生…</p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-sm text-student-error">{error}</p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-student-muted">
            {candidates.length === 0 ? "暂无可添加的学生。" : "没有匹配的学生。"}
          </p>
        ) : (
          visible.map((candidate) => {
            const selected = selectedIds.has(candidate.student_id);
            return (
              <button
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${selected ? "bg-student-primary-soft text-student-primary" : "text-student-text hover:bg-student-bg"}`}
                disabled={selected}
                key={candidate.student_id}
                onClick={() => onAdd(candidate)}
                role="menuitem"
                type="button"
              >
                <span className="min-w-0">
                  <span className="block truncate">{candidate.student_name}</span>
                  <span className="block truncate text-xs font-normal text-student-muted">
                    {formatAccountForDisplay(candidate.student_email)}
                  </span>
                </span>
                {selected ? <Check aria-hidden="true" size={15} /> : <Plus aria-hidden="true" size={15} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
