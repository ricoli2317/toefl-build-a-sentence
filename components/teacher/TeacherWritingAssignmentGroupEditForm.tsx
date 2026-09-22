"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, UserRound } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { WritingAssignmentQuestionPreview } from "@/components/teacher/WritingAssignmentQuestionPreview";
import {
  CustomQuestionFields,
  EMAIL_CUSTOM_FIELDS,
  DISCUSSION_CUSTOM_FIELDS,
  AVATAR_FIELD_BY_NAME,
  ChoiceButton,
  QuestionResults,
  customFieldsFromSnapshot,
  defaultAcademicDiscussionAvatarFields,
  formatLocalDateTime,
  type QuestionSearchPayload
} from "@/components/teacher/TeacherWritingAssignmentForm";
import {
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank
} from "@/lib/studentSearch";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { WRITING_TASK_CONFIG, type WritingQuestion, type WritingTaskType } from "@/lib/writing";
import {
  buildCustomWritingQuestionSnapshot,
  normalizeEmailRequirementsInput,
  parseEmailRequirements,
  suggestAcademicDiscussionAvatarType,
  type WritingAssignmentCollectionDetail,
  type WritingAssignmentDetail,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";
import { formatAccountForDisplay, formatManagedAccountName } from "@/lib/accountIdentifier";

type StudentOption = { id: string; displayName: string; email: string };

type GroupEditItemState = {
  assignmentId: string;
  bankQuestion: WritingQuestion | null;
  customFields: Record<string, string>;
  locked: boolean;
  manuallySelectedAvatars: string[];
  searchError: string;
  searchQuery: string;
  searchResults: QuestionSearchPayload | null;
  searching: boolean;
  showSearch: boolean;
  source: WritingAssignmentQuestionSource;
  taskType: WritingTaskType;
};

const AVATAR_FIELDS = Object.values(AVATAR_FIELD_BY_NAME);

/**
 * Whole-group edit for a withdrawn Assignment Group. Every item of the group is
 * loaded and submitted together (Email and Academic Discussion included), and
 * recipients are re-applied to every item in the saved order. Legacy single
 * assignments keep using the single edit form.
 */
export function TeacherWritingAssignmentGroupEditForm({ batchId }: { batchId: string }) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const cacheKey = `${TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX}:collection:${batchId}`;
  const state = useTeacherCachedData<{ collection: WritingAssignmentCollectionDetail }>(
    cacheKey,
    () => teacherApiFetch(`/api/teacher/writing/assignments/batches/${encodeURIComponent(batchId)}`),
    { refreshOnMount: true }
  );
  const studentsState = useTeacherCachedData<{ students: StudentOption[] }>(
    TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments/students")
  );
  const [items, setItems] = useState<GroupEditItemState[]>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [lockedStudentIds, setLockedStudentIds] = useState<Set<string>>(new Set());
  const [hasDueAt, setHasDueAt] = useState(false);
  const [dueAt, setDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const initializedRef = useRef(false);

  const orderedAssignments = useMemo(
    () => (state.data?.collection.assignments ?? [])
      .slice()
      .sort((left, right) =>
        (left.group_position ?? Number.MAX_SAFE_INTEGER) -
          (right.group_position ?? Number.MAX_SAFE_INTEGER) ||
        left.assignment_id.localeCompare(right.assignment_id)
      ),
    [state.data]
  );

  useEffect(() => {
    if (!state.data || initializedRef.current || orderedAssignments.length < 2) return;
    initializedRef.current = true;
    setGroupTitle(state.data.collection.title?.trim() || "");
    setItems(orderedAssignments.map((assignment) => itemStateFromAssignment(assignment)));
    const first = orderedAssignments[0];
    setSelectedStudents(first.students.map((student) => student.student_id));
    const locked = new Set<string>();
    for (const assignment of orderedAssignments) {
      for (const student of assignment.students) {
        if (student.has_attempt) locked.add(student.student_id);
      }
    }
    setLockedStudentIds(locked);
    const firstDue = orderedAssignments.find((assignment) => assignment.due_at)?.due_at ?? null;
    setHasDueAt(Boolean(firstDue));
    setDueAt(firstDue ? formatLocalDateTime(firstDue) : "");
  }, [orderedAssignments, state.data]);

  const studentEntries = useMemo(() => (studentsState.data?.students ?? []).map((student) => ({
    ...createStudentSearchMetadata(student.displayName),
    displayName: student.displayName,
    id: student.id,
    student
  })), [studentsState.data]);
  const filteredStudents = useMemo(() => studentEntries
    .map((entry) => {
      const nameRank = studentSearchRank(entry, entry.displayName, studentQuery);
      const emailRank = studentQuery.trim()
        && entry.student.email.toLocaleLowerCase().includes(studentQuery.trim().toLocaleLowerCase())
        ? 6
        : Number.POSITIVE_INFINITY;
      return { entry, rank: Math.min(nameRank, emailRank) };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || compareStudentSearchMetadata(left.entry, right.entry))
    .map(({ entry }) => entry.student), [studentEntries, studentQuery]);

  function updateItem(assignmentId: string, updater: (item: GroupEditItemState) => GroupEditItemState) {
    setItems((current) => current.map((item) => item.assignmentId === assignmentId ? updater(item) : item));
  }

  function chooseItemTaskType(item: GroupEditItemState, next: WritingTaskType) {
    if (item.locked || item.taskType === next) return;
    updateItem(item.assignmentId, (current) => ({
      ...current,
      bankQuestion: null,
      customFields: current.source === "custom" && next === "academic_discussion"
        ? defaultAcademicDiscussionAvatarFields()
        : {},
      searchError: "",
      searchResults: null,
      searchQuery: "",
      taskType: next
    }));
  }

  function chooseItemSource(item: GroupEditItemState, next: WritingAssignmentQuestionSource) {
    if (item.locked || item.source === next) return;
    updateItem(item.assignmentId, (current) => ({
      ...current,
      bankQuestion: next === "question_bank" ? current.bankQuestion : null,
      customFields: next === "custom"
        ? (current.taskType === "academic_discussion" ? defaultAcademicDiscussionAvatarFields() : {})
        : {},
      searchError: "",
      searchResults: null,
      searchQuery: "",
      source: next
    }));
  }

  async function searchItemQuestions(item: GroupEditItemState, page = 1) {
    setSubmitError("");
    updateItem(item.assignmentId, (current) => ({ ...current, searchError: "", searching: true }));
    try {
      const params = new URLSearchParams({
        taskType: item.taskType,
        query: item.searchQuery,
        page: String(page),
        pageSize: "10"
      });
      const payload = await teacherApiFetch<QuestionSearchPayload>(
        `/api/teacher/writing/assignments/questions?${params}`
      );
      updateItem(item.assignmentId, (current) => ({ ...current, searchResults: payload }));
    } catch (error) {
      updateItem(item.assignmentId, (current) => ({
        ...current,
        searchError: error instanceof Error ? error.message : "题库搜索失败。"
      }));
    } finally {
      updateItem(item.assignmentId, (current) => ({ ...current, searching: false }));
    }
  }

  function selectItemBankQuestion(
    item: GroupEditItemState,
    question: WritingQuestion
  ) {
    updateItem(item.assignmentId, (current) => ({
      ...current,
      bankQuestion: question,
      searchError: "",
      searchResults: null,
      showSearch: false
    }));
  }

  function updateItemCustomField(item: GroupEditItemState, field: string, value: string) {
    updateItem(item.assignmentId, (current) => {
      const fields = { ...current.customFields, [field]: value };
      const avatarField = AVATAR_FIELD_BY_NAME[field as keyof typeof AVATAR_FIELD_BY_NAME];
      if (avatarField && !current.manuallySelectedAvatars.includes(avatarField)) {
        fields[avatarField] = avatarField === "professor_avatar_type"
          ? suggestAcademicDiscussionAvatarType(value, "professor", "male_professor")
          : suggestAcademicDiscussionAvatarType(
              value,
              "student",
              avatarField === "student_2_avatar_type" ? "female_student" : "male_student"
            );
      }
      return { ...current, customFields: fields };
    });
  }

  function chooseItemAvatar(item: GroupEditItemState, field: string, value: string) {
    updateItem(item.assignmentId, (current) => ({
      ...current,
      customFields: { ...current.customFields, [field]: value },
      manuallySelectedAvatars: Array.from(new Set([...current.manuallySelectedAvatars, field]))
    }));
  }

  function normalizeItemCustomField(item: GroupEditItemState, field: string) {
    if (field !== "requirements") return;
    updateItem(item.assignmentId, (current) => ({
      ...current,
      customFields: {
        ...current.customFields,
        requirements: normalizeEmailRequirementsInput(current.customFields.requirements ?? "")
      }
    }));
  }

  function toggleStudent(studentId: string) {
    if (selectedStudents.includes(studentId) && lockedStudentIds.has(studentId)) return;
    setSelectedStudents((current) => current.includes(studentId)
      ? current.filter((id) => id !== studentId)
      : [...current, studentId]);
  }

  async function submit(reactivate: boolean) {
    setSubmitError("");
    if (items.length < 2) return setSubmitError("这组作业无法编辑。");
    for (const item of items) {
      if (item.source === "question_bank") {
        if (!item.bankQuestion) return setSubmitError("每篇题库题目都需要选择一道题。");
        continue;
      }
      try {
        buildCustomWritingQuestionSnapshot({
          taskType: item.taskType,
          fields: item.customFields,
          id: "validation"
        });
        if (item.taskType === "email") {
          parseEmailRequirements(item.customFields.requirements ?? "");
        }
      } catch (error) {
        return setSubmitError(error instanceof Error ? error.message : "请完整填写每道自定义题。");
      }
    }
    if (!selectedStudents.length) return setSubmitError("请至少选择一名学生。");
    if (hasDueAt && (!dueAt || Number.isNaN(new Date(dueAt).getTime()))) {
      return setSubmitError("请选择有效的截止时间。");
    }
    setSubmitting(true);
    try {
      await teacherApiFetch(`/api/teacher/writing/assignments/batches/${encodeURIComponent(batchId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          action: "edit",
          reactivate,
          items: items.map((item) => item.source === "question_bank"
            ? {
                assignmentId: item.assignmentId,
                taskType: item.taskType,
                questionSource: "question_bank",
                questionId: item.bankQuestion?.question_id ?? null
              }
            : {
                assignmentId: item.assignmentId,
                taskType: item.taskType,
                questionSource: "custom",
                customQuestion: item.customFields
              }),
          studentIds: selectedStudents,
          dueAt: hasDueAt ? new Date(dueAt).toISOString() : null
        })
      });
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      publishCacheInvalidation({
        type: "ASSIGNMENT_UPDATED",
        assignmentId: items[0].assignmentId,
        assignmentQuestionSource: items[0].source
      });
      router.push(`/teacher/writing/assignments/batches/${batchId}`);
      router.refresh();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "作业更新失败。");
      setSubmitting(false);
    }
  }

  if (state.loading) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <TeacherLoadingRegion label="正在加载作业组" />
        <TeacherSkeleton className="h-40 w-full rounded-2xl" />
        <TeacherSkeleton className="h-80 w-full rounded-2xl" />
      </div>
    );
  }
  if (state.error || !state.data || orderedAssignments.length < 2) {
    return <TeacherDataError text={state.error || "未找到这项写作作业。"} />;
  }

  return (
    <div className="grid gap-5">
      <TeacherCard className="grid gap-2 p-5">
        <TeacherSectionTitle>作业标题</TeacherSectionTitle>
        <p className="text-sm font-semibold text-student-text">{groupTitle || "未命名作业"}</p>
        <p className="text-xs text-student-muted">
          作业标题在布置时确定，本页编辑题目、学生与截止时间；保存会对整个作业组生效。
        </p>
      </TeacherCard>

      {items.map((item, index) => (
        <TeacherCard className="grid gap-4 p-5" key={item.assignmentId}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TeacherSectionTitle>
              第 {index + 1} 篇 · {WRITING_TASK_CONFIG[item.taskType].label}
            </TeacherSectionTitle>
            {item.locked ? (
              <span className="text-xs text-student-muted">已有学生提交，题型和题目内容已锁定。</span>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["email", "academic_discussion"] as const).map((type) => (
              <ChoiceButton
                active={item.taskType === type}
                disabled={item.locked}
                key={type}
                label={WRITING_TASK_CONFIG[type].label}
                onClick={() => chooseItemTaskType(item, type)}
              />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceButton
              active={item.source === "question_bank"}
              disabled={item.locked}
              label="从题库选择"
              onClick={() => chooseItemSource(item, "question_bank")}
            />
            <ChoiceButton
              active={item.source === "custom"}
              disabled={item.locked}
              label="自定义题目"
              onClick={() => chooseItemSource(item, "custom")}
            />
          </div>

          {item.source === "question_bank" ? (
            <div className="grid gap-3">
              {item.bankQuestion ? (
                <WritingAssignmentQuestionPreview
                  question={item.bankQuestion}
                  questionSource="question_bank"
                  taskType={item.taskType}
                />
              ) : (
                <p className="text-sm font-medium text-student-error">请选择一道题库题目。</p>
              )}
              {!item.locked ? (
                <button
                  className="teacher-button-secondary justify-self-start"
                  onClick={() => updateItem(item.assignmentId, (current) => ({
                    ...current,
                    showSearch: !current.showSearch
                  }))}
                  type="button"
                >
                  <Search aria-hidden="true" size={16} />
                  {item.showSearch ? "收起搜索" : item.bankQuestion ? "更换题目" : "搜索题目"}
                </button>
              ) : null}
              {item.showSearch && !item.locked ? (
                <div className="grid gap-3">
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void searchItemQuestions(item, 1);
                    }}
                  >
                    <input
                      className="teacher-input min-w-0 flex-1"
                      onChange={(event) => updateItem(item.assignmentId, (current) => ({
                        ...current,
                        searchQuery: event.target.value
                      }))}
                      placeholder="搜索套题名称或题目关键词"
                      value={item.searchQuery}
                    />
                    <button className="teacher-button-primary" disabled={item.searching} type="submit">
                      <Search aria-hidden="true" size={16} />{item.searching ? "搜索中" : "搜索题目"}
                    </button>
                  </form>
                  {item.searchError ? <TeacherDataError text={item.searchError} /> : null}
                  {item.searchResults ? (
                    <QuestionResults
                      onPage={(page) => void searchItemQuestions(item, page)}
                      onSelect={(question) => selectItemBankQuestion(item, question)}
                      payload={item.searchResults}
                      selectedId={item.bankQuestion?.question_id ?? null}
                      taskType={item.taskType}
                    />
                  ) : (
                    <p className="text-xs text-student-muted">输入关键词后搜索；留空可分页浏览当前题型题库。</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3">
              <CustomQuestionFields
                disabled={item.locked}
                fields={item.taskType === "email" ? EMAIL_CUSTOM_FIELDS : DISCUSSION_CUSTOM_FIELDS}
                onAvatarChange={(field, value) => chooseItemAvatar(item, field, value)}
                onBlur={(field) => normalizeItemCustomField(item, field)}
                onChange={(field, value) => updateItemCustomField(item, field, value)}
                values={item.customFields}
              />
              <CustomItemPreview item={item} />
            </div>
          )}
        </TeacherCard>
      ))}

      <TeacherCard className="grid gap-3 p-5">
        <TeacherSectionTitle>选择学生</TeacherSectionTitle>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[240px] flex-1">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} />
            <input
              className="teacher-input w-full pl-9"
              onChange={(event) => setStudentQuery(event.target.value)}
              placeholder="搜索中文姓名、拼音或账号"
              value={studentQuery}
            />
          </div>
          <span className="text-sm font-bold text-student-primary">已选择 {selectedStudents.length} 人</span>
        </div>
        {studentsState.loading ? (
          <TeacherSkeleton className="h-40 w-full rounded-xl" />
        ) : studentsState.error ? (
          <TeacherDataError text={studentsState.error} />
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-xl border border-student-border">
            <div className="grid gap-px bg-student-border">
              {filteredStudents.map((student) => {
                const active = selectedStudents.includes(student.id);
                const removalLocked = active && lockedStudentIds.has(student.id);
                return (
                  <button
                    aria-disabled={removalLocked}
                    className={`flex items-center gap-3 bg-white px-4 py-3 text-left transition hover:bg-student-bg ${active ? "!bg-student-primary-soft" : ""} ${removalLocked ? "cursor-not-allowed" : ""}`}
                    key={student.id}
                    onClick={() => toggleStudent(student.id)}
                    title={removalLocked ? "该学生已有草稿或提交记录，不能移除" : undefined}
                    type="button"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-student-primary">
                      <UserRound aria-hidden="true" size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-student-text">
                        {formatManagedAccountName(student.displayName, student.email)}
                      </span>
                      <span className="block truncate text-xs text-student-muted">
                        账号：{formatAccountForDisplay(student.email)}
                      </span>
                    </span>
                    {removalLocked ? <span className="text-xs font-semibold text-student-muted">已有作答</span> : null}
                  </button>
                );
              })}
              {!filteredStudents.length ? (
                <p className="bg-white px-4 py-8 text-center text-sm text-student-muted">没有匹配的学生。</p>
              ) : null}
            </div>
          </div>
        )}
      </TeacherCard>

      <TeacherCard className="grid gap-3 p-5">
        <TeacherSectionTitle>截止时间</TeacherSectionTitle>
        <label className="flex items-center gap-2 text-sm font-semibold text-student-text">
          <input checked={!hasDueAt} name="group-due-mode" onChange={() => setHasDueAt(false)} type="radio" />不设置截止时间
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-student-text">
          <input checked={hasDueAt} name="group-due-mode" onChange={() => setHasDueAt(true)} type="radio" />设置截止时间
        </label>
        {hasDueAt ? (
          <input
            className="teacher-input max-w-sm"
            onChange={(event) => setDueAt(event.target.value)}
            type="datetime-local"
            value={dueAt}
          />
        ) : null}
        <p className="text-xs text-student-muted">截止时间仅用于完成状态判断，不会禁止提交；保存后对整个作业组统一生效。</p>
      </TeacherCard>

      <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="font-bold text-student-text">保存作业修改</p>
          <p className="mt-1 text-sm text-student-muted">保存后可继续保持撤回，或立即重新布置整组作业。</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {submitError ? <p className="text-sm font-medium text-student-error">{submitError}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button className="teacher-button-secondary" disabled={submitting} onClick={() => void submit(false)} type="button">
              {submitting ? "正在保存…" : "保存修改"}
            </button>
            <button className="teacher-button-primary" disabled={submitting} onClick={() => void submit(true)} type="button">
              {submitting ? "正在保存…" : "保存并重新布置"}
            </button>
          </div>
        </div>
      </TeacherCard>
    </div>
  );
}

function itemStateFromAssignment(assignment: WritingAssignmentDetail): GroupEditItemState {
  return {
    assignmentId: assignment.assignment_id,
    bankQuestion: assignment.question_source === "question_bank" ? assignment.question_snapshot : null,
    customFields: assignment.question_source === "custom"
      ? customFieldsFromSnapshot(assignment.question_snapshot)
      : {},
    locked: Boolean(assignment.has_submitted_attempts),
    manuallySelectedAvatars: assignment.question_source === "custom"
      && assignment.task_type === "academic_discussion"
      ? AVATAR_FIELDS
      : [],
    searchError: "",
    searchQuery: "",
    searchResults: null,
    searching: false,
    showSearch: false,
    source: assignment.question_source,
    taskType: assignment.task_type
  };
}

function CustomItemPreview({ item }: { item: GroupEditItemState }) {
  const question = useMemo(() => {
    try {
      return buildCustomWritingQuestionSnapshot({
        taskType: item.taskType,
        fields: item.customFields,
        id: `preview-${item.assignmentId}`
      });
    } catch {
      return null;
    }
  }, [item.assignmentId, item.customFields, item.taskType]);
  if (!question) {
    return <p className="text-xs text-student-muted">填写完整后这里会显示学生看到的题目预览。</p>;
  }
  return <WritingAssignmentQuestionPreview question={question} questionSource="custom" taskType={item.taskType} />;
}
