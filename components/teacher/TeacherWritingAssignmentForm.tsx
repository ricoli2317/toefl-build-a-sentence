"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Search, Trash2, UserRound } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { WritingAssignmentQuestionPreview } from "@/components/teacher/WritingAssignmentQuestionPreview";
import {
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank
} from "@/lib/studentSearch";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { WRITING_TASK_CONFIG, type WritingQuestion, type WritingTaskType } from "@/lib/writing";
import {
  CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS,
  isProfessorAvatarType,
  isStudentAvatarType
} from "@/lib/academicDiscussionAvatars";
import {
  buildCustomWritingQuestionSnapshot,
  defaultWritingAssignmentTitle,
  normalizeAssignmentText,
  normalizeEmailRequirementsInput,
  parseCustomEmailPrompt,
  parseEmailRequirements,
  suggestAcademicDiscussionAvatarType,
  toggleWritingAssignmentQuestionSelection,
  type WritingAssignmentDetail,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";
import type { LogicalWritingQuestionSearchResult } from "@/lib/writingAssignmentLogicalSearch";

type StudentOption = { id: string; displayName: string; email: string };
type QuestionSearchPayload = { questions: LogicalWritingQuestionSearchResult[]; page: number; pageSize: number; total: number };
type CustomQuestionDraft = {
  clientId: string;
  expanded: boolean;
  fields: Record<string, string | boolean>;
  manuallySelectedAvatars: string[];
  parsedRequirementCount: number;
  rawPrompt: string;
  requirementsManuallyEdited: boolean;
  titleManuallyEdited: boolean;
  toManuallyEdited: boolean;
};

const EMAIL_CUSTOM_FIELDS = [
  ["title", "作业标题"],
  ["scenario", "Scenario"],
  ["requirements", "三个要点"],
  ["recipient", "To"],
  ["subject", "Subject"]
] as const;
const DISCUSSION_CUSTOM_FIELDS = [
  ["title", "作业标题"],
  ["professor_name", "Professor Name"],
  ["professor_prompt", "Professor Prompt"],
  ["student_1_name", "Student 1 Name"],
  ["student_1_response", "Student 1 Response"],
  ["student_2_name", "Student 2 Name"],
  ["student_2_response", "Student 2 Response"]
] as const;
const AVATAR_FIELD_BY_NAME = {
  professor_name: "professor_avatar_type",
  student_1_name: "student_1_avatar_type",
  student_2_name: "student_2_avatar_type"
} as const;

export function TeacherWritingAssignmentForm({
  initialAssignment
}: {
  initialAssignment?: WritingAssignmentDetail;
}) {
  return initialAssignment
    ? <TeacherWritingAssignmentEditForm initialAssignment={initialAssignment} />
    : <TeacherWritingAssignmentCreateForm />;
}

function TeacherWritingAssignmentCreateForm() {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const [taskType, setTaskType] = useState<WritingTaskType | null>(null);
  const [source, setSource] = useState<WritingAssignmentQuestionSource | null>(null);
  const [query, setQuery] = useState("");
  const [questionResult, setQuestionResult] = useState<QuestionSearchPayload | null>(null);
  const [selectedQuestions, setSelectedQuestions] = useState<Map<string, LogicalWritingQuestionSearchResult>>(new Map());
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [deadlineMode, setDeadlineMode] = useState<"uniform" | "individual">("uniform");
  const [uniformDueAt, setUniformDueAt] = useState("");
  const [individualDueAt, setIndividualDueAt] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const studentsState = useTeacherCachedData<{ students: StudentOption[] }>(
    TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments/students")
  );

  const studentEntries = useMemo(() => (studentsState.data?.students ?? []).map((student) => ({
    ...createStudentSearchMetadata(student.displayName),
    displayName: student.displayName,
    id: student.id,
    student
  })), [studentsState.data]);
  const filteredStudents = useMemo(() => studentEntries
    .map((entry) => {
      const nameRank = studentSearchRank(entry, entry.displayName, studentQuery);
      const emailRank = studentQuery.trim() && entry.student.email.toLocaleLowerCase().includes(studentQuery.trim().toLocaleLowerCase()) ? 6 : Number.POSITIVE_INFINITY;
      return { entry, rank: Math.min(nameRank, emailRank) };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || compareStudentSearchMetadata(left.entry, right.entry))
    .map(({ entry }) => entry.student), [studentEntries, studentQuery]);
  const generatedAssignmentTitle = useMemo(() => {
    const firstStudent = (studentsState.data?.students ?? []).find(
      (student) => student.id === selectedStudents[0]
    );
    if (!firstStudent) return "";
    return defaultWritingAssignmentTitle({
      assignedAt: new Date(),
      firstStudentName: firstStudent.displayName,
      studentCount: selectedStudents.length
    });
  }, [selectedStudents, studentsState.data]);
  const selectedBankQuestions = useMemo(() => Array.from(selectedQuestions.values()), [selectedQuestions]);
  const previewQuestions = useMemo(() => {
    if (!taskType || !source) return [];
    if (source === "question_bank") return selectedBankQuestions;
    return customQuestions.flatMap((draft) => {
      try {
        return [buildCustomWritingQuestionSnapshot({ taskType, fields: draft.fields, id: draft.clientId })];
      } catch {
        return [];
      }
    });
  }, [customQuestions, selectedBankQuestions, source, taskType]);
  const assignmentCount = source === "question_bank" ? selectedQuestions.size : customQuestions.length;

  function chooseTaskType(next: WritingTaskType) {
    if (taskType === next) return;
    setTaskType(next);
    setSelectedQuestions(new Map());
    setQuestionResult(null);
    setQuery("");
    setCustomQuestions(source === "custom" ? [createCustomQuestionDraft(next, generatedAssignmentTitle)] : []);
    setIndividualDueAt({});
    setSearchError("");
    setSubmitError("");
  }

  function chooseSource(next: WritingAssignmentQuestionSource) {
    if (!taskType || source === next) return;
    setSource(next);
    setSelectedQuestions(new Map());
    setQuestionResult(null);
    setCustomQuestions(next === "custom" ? [createCustomQuestionDraft(taskType, generatedAssignmentTitle)] : []);
    setIndividualDueAt({});
    setSearchError("");
    setSubmitError("");
  }

  async function searchQuestions(page = 1) {
    if (!taskType) return;
    setSearching(true);
    setSearchError("");
    try {
      const params = new URLSearchParams({ taskType, query, page: String(page), pageSize: "10" });
      setQuestionResult(await teacherApiFetch(`/api/teacher/writing/assignments/questions?${params}`));
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "题库搜索失败。");
    } finally {
      setSearching(false);
    }
  }

  function toggleQuestion(question: LogicalWritingQuestionSearchResult) {
    setSelectedQuestions((current) => toggleWritingAssignmentQuestionSelection(current, question));
  }

  function updateCustomQuestion(clientId: string, updater: (draft: CustomQuestionDraft) => CustomQuestionDraft) {
    setCustomQuestions((current) => current.map((draft) => draft.clientId === clientId ? updater(draft) : draft));
  }

  function updateEmailPrompt(clientId: string, rawPrompt: string) {
    const parsed = parseCustomEmailPrompt(rawPrompt);
    updateCustomQuestion(clientId, (draft) => ({
      ...draft,
      parsedRequirementCount: parsed.requirements.length,
      rawPrompt,
      requirementsManuallyEdited: false,
      fields: {
        ...draft.fields,
        parsed_email: true,
        recipient: draft.toManuallyEdited ? draft.fields.recipient : parsed.recipient,
        requirement_1: parsed.requirements[0] ?? "",
        requirement_2: parsed.requirements[1] ?? "",
        requirement_3: parsed.requirements[2] ?? "",
        scenario: parsed.scenario,
        task_instruction: parsed.taskInstruction
      }
    }));
  }

  function updateDraftField(clientId: string, field: string, value: string) {
    updateCustomQuestion(clientId, (draft) => {
      const fields = { ...draft.fields, [field]: value };
      const avatarField = AVATAR_FIELD_BY_NAME[field as keyof typeof AVATAR_FIELD_BY_NAME];
      if (avatarField && !draft.manuallySelectedAvatars.includes(avatarField)) {
        fields[avatarField] = avatarField === "professor_avatar_type"
          ? suggestAcademicDiscussionAvatarType(value, "professor", "male_professor")
          : suggestAcademicDiscussionAvatarType(value, "student", avatarField === "student_2_avatar_type" ? "female_student" : "male_student");
      }
      return {
        ...draft,
        fields,
        requirementsManuallyEdited: draft.requirementsManuallyEdited || field.startsWith("requirement_"),
        titleManuallyEdited: draft.titleManuallyEdited || field === "title",
        toManuallyEdited: draft.toManuallyEdited || field === "recipient"
      };
    });
  }

  function chooseDraftAvatar(clientId: string, field: string, value: string) {
    updateCustomQuestion(clientId, (draft) => ({
      ...draft,
      fields: { ...draft.fields, [field]: value },
      manuallySelectedAvatars: Array.from(new Set([...draft.manuallySelectedAvatars, field]))
    }));
  }

  function toggleStudent(studentId: string) {
    const nextStudents = selectedStudents.includes(studentId)
      ? selectedStudents.filter((id) => id !== studentId)
      : [...selectedStudents, studentId];
    setSelectedStudents(nextStudents);
    const firstStudent = (studentsState.data?.students ?? []).find(
      (student) => student.id === nextStudents[0]
    );
    const nextTitle = firstStudent
      ? defaultWritingAssignmentTitle({
          assignedAt: new Date(),
          firstStudentName: firstStudent.displayName,
          studentCount: nextStudents.length
        })
      : "";
    setCustomQuestions((current) => current.map((draft) => draft.titleManuallyEdited
      ? draft
      : { ...draft, fields: { ...draft.fields, title: nextTitle } }));
  }

  function dueAtFor(key: string) {
    const value = deadlineMode === "uniform" ? uniformDueAt : individualDueAt[key] ?? "";
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("请选择有效的截止时间。");
    return date.toISOString();
  }

  async function submit() {
    setSubmitError("");
    if (!taskType) return setSubmitError("请先选择题型。");
    if (!source) return setSubmitError("请选择题目来源。");
    if (assignmentCount < 1) return setSubmitError(source === "question_bank" ? "请至少选择一道题库题目。" : "请至少添加一道自定义题目。");
    if (!selectedStudents.length) return setSubmitError("请至少选择一名学生。");

    let assignments: Array<Record<string, unknown>>;
    try {
      if (source === "question_bank") {
        assignments = selectedBankQuestions.map((question) => ({
          dueAt: dueAtFor(question.question_id),
          questionId: question.question_id,
          questionSource: source,
          taskType
        }));
      } else {
        assignments = customQuestions.map((draft) => {
          if (taskType === "email" && customEmailRequirementCount(draft) !== 3) {
            throw new Error("每篇 Email 必须准确识别或补充 3 条要求。");
          }
          buildCustomWritingQuestionSnapshot({ taskType, fields: draft.fields, id: "validation" });
          return {
            customQuestion: draft.fields,
            dueAt: dueAtFor(draft.clientId),
            questionId: null,
            questionSource: source,
            taskType
          };
        });
      }
    } catch (error) {
      return setSubmitError(error instanceof Error ? error.message : "请完整填写每道题目。");
    }

    setSubmitting(true);
    try {
      const payload = await teacherApiFetch<{ assignmentId: string; assignmentIds: string[] }>(
        "/api/teacher/writing/assignments",
        { method: "POST", body: JSON.stringify({ assignments, studentIds: selectedStudents }) }
      );
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      for (const assignmentId of payload.assignmentIds) {
        publishCacheInvalidation({
          type: "ASSIGNMENT_UPDATED",
          assignmentId,
          assignmentQuestionSource: source
        });
      }
      router.push("/teacher/writing/assignments");
      router.refresh();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "作业创建失败。");
      setSubmitting(false);
    }
  }

  const assignmentKeys = source === "question_bank"
    ? selectedBankQuestions.map((question) => ({ key: question.question_id, label: question.logical_display_name }))
    : customQuestions.map((draft, index) => ({ key: draft.clientId, label: String(draft.fields.title ?? "").trim() || `第 ${index + 1} 篇` }));

  return (
    <div className="grid gap-5">
      <StepCard number="1" title="选择题型">
        <div className="grid gap-3 sm:grid-cols-2">{(["email", "academic_discussion"] as const).map((type) => <ChoiceButton active={taskType === type} key={type} label={WRITING_TASK_CONFIG[type].label} onClick={() => chooseTaskType(type)} />)}</div>
      </StepCard>

      <StepCard number="2" title="选择题目来源">
        <div className="grid gap-3 sm:grid-cols-2"><ChoiceButton active={source === "question_bank"} disabled={!taskType} label="从题库选择" onClick={() => chooseSource("question_bank")} /><ChoiceButton active={source === "custom"} disabled={!taskType} label="自定义题目" onClick={() => chooseSource("custom")} /></div>
      </StepCard>

      <StepCard number="3" title={source === "custom" ? "填写自定义题" : "选择题目"}>
        {!taskType || !source ? <p className="text-sm text-student-muted">请先选择题型和题目来源。</p> : source === "question_bank" ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm font-bold text-student-primary">已选择 {selectedQuestions.size} 篇</span>{selectedBankQuestions.length ? <div className="flex flex-wrap gap-2">{selectedBankQuestions.map((question) => <button className="rounded-full border border-student-border px-3 py-1 text-xs font-semibold text-student-text" key={question.question_id} onClick={() => toggleQuestion(question)} type="button">{question.logical_display_name} ×</button>)}</div> : null}</div>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void searchQuestions(1); }}><input className="teacher-input min-w-0 flex-1" onChange={(event) => setQuery(event.target.value)} placeholder="搜索套题名称或题目关键词" value={query} /><button className="teacher-button-primary" disabled={searching} type="submit"><Search aria-hidden="true" size={16} />{searching ? "搜索中" : "搜索题目"}</button></form>
            {searchError ? <TeacherDataError text={searchError} /> : null}
            {questionResult ? <MultiQuestionResults onPage={(page) => void searchQuestions(page)} onToggle={toggleQuestion} payload={questionResult} selectedIds={new Set(selectedQuestions.keys())} taskType={taskType} /> : <p className="text-sm text-student-muted">输入关键词后搜索；切换搜索或翻页不会清除已选题目。</p>}
          </div>
        ) : (
          <div className="grid gap-4">{customQuestions.map((draft, index) => <CustomQuestionDraftCard disabled={false} draft={draft} index={index} key={draft.clientId} onAvatarChange={(field, value) => chooseDraftAvatar(draft.clientId, field, value)} onChange={(field, value) => updateDraftField(draft.clientId, field, value)} onPromptChange={(value) => updateEmailPrompt(draft.clientId, value)} onRemove={() => setCustomQuestions((current) => current.filter((item) => item.clientId !== draft.clientId))} onToggle={() => updateCustomQuestion(draft.clientId, (current) => ({ ...current, expanded: !current.expanded }))} taskType={taskType} />)}<button className="teacher-button-secondary justify-self-start" onClick={() => setCustomQuestions((current) => [...current, createCustomQuestionDraft(taskType, generatedAssignmentTitle)])} type="button"><Plus aria-hidden="true" size={16} />添加一篇</button></div>
        )}
      </StepCard>

      <StepCard number="4" title="选择学生">
        <div className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[240px] flex-1"><Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} /><input className="teacher-input w-full pl-9" onChange={(event) => setStudentQuery(event.target.value)} placeholder="搜索中文姓名、拼音或邮箱" value={studentQuery} /></div><span className="text-sm font-bold text-student-primary">已选择 {selectedStudents.length} 人</span></div>
          {studentsState.loading ? <TeacherSkeleton className="h-40 w-full rounded-xl" /> : studentsState.error ? <TeacherDataError text={studentsState.error} /> : <div className="max-h-72 overflow-y-auto rounded-xl border border-student-border"><div className="grid gap-px bg-student-border">{filteredStudents.map((student) => { const active = selectedStudents.includes(student.id); return <button className={`flex items-center gap-3 bg-white px-4 py-3 text-left transition hover:bg-student-bg ${active ? "!bg-student-primary-soft" : ""}`} key={student.id} onClick={() => toggleStudent(student.id)} type="button"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-student-primary"><UserRound aria-hidden="true" size={18} /></span><span className="min-w-0 flex-1"><span className="block font-semibold text-student-text">{student.displayName}</span><span className="block truncate text-xs text-student-muted">{student.email}</span></span>{active ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</button>; })}{!filteredStudents.length ? <p className="bg-white px-4 py-8 text-center text-sm text-student-muted">没有匹配的学生。</p> : null}</div></div>}
        </div>
      </StepCard>

      <StepCard number="5" title="截止时间">
        <div className="grid gap-3"><div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={deadlineMode === "uniform"} name="deadline-mode" onChange={() => setDeadlineMode("uniform")} type="radio" />统一截止时间</label><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={deadlineMode === "individual"} name="deadline-mode" onChange={() => setDeadlineMode("individual")} type="radio" />分别设置</label></div>{deadlineMode === "uniform" ? <label className="grid max-w-sm gap-2 text-sm font-semibold text-student-text">截止时间（可不填）<input className="teacher-input" onChange={(event) => setUniformDueAt(event.target.value)} type="datetime-local" value={uniformDueAt} /></label> : <div className="grid gap-3">{assignmentKeys.map((item) => <label className="grid gap-2 text-sm font-semibold text-student-text sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center" key={item.key}><span className="truncate">{item.label}</span><input className="teacher-input" onChange={(event) => setIndividualDueAt((current) => ({ ...current, [item.key]: event.target.value }))} type="datetime-local" value={individualDueAt[item.key] ?? ""} /></label>)}</div>}<p className="text-xs text-student-muted">留空表示不设置截止时间；截止时间不会禁止提交。</p></div>
      </StepCard>

      <StepCard number="6" title="题目预览">
        {previewQuestions.length ? <div className="grid gap-5">{previewQuestions.map((question, index) => <div className="grid gap-2" key={question.question_id}><p className="text-sm font-bold text-student-text">第 {index + 1} 篇</p><WritingAssignmentQuestionPreview question={question} questionSource={source!} taskType={taskType!} /></div>)}</div> : <p className="text-sm text-student-muted">完成题目选择或填写后，这里会显示学生看到的完整题目。</p>}
      </StepCard>

      <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-5"><div><p className="font-bold text-student-text">确认布置</p><p className="mt-1 text-sm text-student-muted">将 {assignmentCount} 篇题目布置给已选择的 {selectedStudents.length} 名学生。</p></div><div className="flex flex-col items-end gap-2">{submitError ? <p className="text-sm font-medium text-student-error">{submitError}</p> : null}<button className="teacher-button-primary" disabled={submitting} onClick={() => void submit()} type="button">{submitting ? "正在布置…" : "布置"}</button></div></TeacherCard>
    </div>
  );
}

function TeacherWritingAssignmentEditForm({
  initialAssignment
}: {
  initialAssignment: WritingAssignmentDetail;
}) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const editing = Boolean(initialAssignment);
  const questionLocked = Boolean(initialAssignment?.has_submitted_attempts);
  const lockedStudentIds = useMemo(
    () => new Set(initialAssignment?.students.filter((student) => student.has_attempt).map((student) => student.student_id) ?? []),
    [initialAssignment]
  );
  const [taskType, setTaskType] = useState<WritingTaskType | null>(initialAssignment?.task_type ?? null);
  const [source, setSource] = useState<WritingAssignmentQuestionSource | null>(initialAssignment?.question_source ?? null);
  const [query, setQuery] = useState("");
  const [questionResult, setQuestionResult] = useState<QuestionSearchPayload | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState<WritingQuestion | null>(
    initialAssignment?.question_source === "question_bank" ? initialAssignment.question_snapshot : null
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [customFields, setCustomFields] = useState<Record<string, string>>(
    initialAssignment?.question_source === "custom"
      ? customFieldsFromSnapshot(initialAssignment.question_snapshot)
      : {}
  );
  const [customFieldError, setCustomFieldError] = useState("");
  const [manuallySelectedAvatars, setManuallySelectedAvatars] = useState<Set<string>>(
    () => new Set(initialAssignment?.question_source === "custom" && initialAssignment.task_type === "academic_discussion"
      ? Object.values(AVATAR_FIELD_BY_NAME)
      : [])
  );
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>(
    initialAssignment?.students.map((student) => student.student_id) ?? []
  );
  const [hasDueAt, setHasDueAt] = useState(Boolean(initialAssignment?.due_at));
  const [dueAt, setDueAt] = useState(
    initialAssignment?.due_at ? formatLocalDateTime(initialAssignment.due_at) : ""
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const studentsState = useTeacherCachedData<{ students: StudentOption[] }>(
    TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments/students")
  );

  const previewQuestion = useMemo(() => {
    if (!taskType || !source) return null;
    if (source === "question_bank") return selectedQuestion;
    try {
      return buildCustomWritingQuestionSnapshot({
        taskType,
        fields: customFields,
        id: "preview",
        now: new Date()
      });
    } catch {
      return null;
    }
  }, [customFields, selectedQuestion, source, taskType]);

  const studentEntries = useMemo(() => (studentsState.data?.students ?? []).map((student) => ({
    ...createStudentSearchMetadata(student.displayName),
    displayName: student.displayName,
    id: student.id,
    student
  })), [studentsState.data]);
  const filteredStudents = useMemo(() => studentEntries
    .map((entry) => {
      const nameRank = studentSearchRank(entry, entry.displayName, studentQuery);
      const emailRank = studentQuery.trim() && entry.student.email.toLocaleLowerCase().includes(studentQuery.trim().toLocaleLowerCase()) ? 6 : Number.POSITIVE_INFINITY;
      return { entry, rank: Math.min(nameRank, emailRank) };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || compareStudentSearchMetadata(left.entry, right.entry))
    .map(({ entry }) => entry.student), [studentEntries, studentQuery]);

  function chooseTaskType(next: WritingTaskType) {
    if (questionLocked) return;
    if (taskType === next) return;
    setTaskType(next);
    setSelectedQuestion(null);
    setQuestionResult(null);
    setQuery("");
    setCustomFields({});
    setManuallySelectedAvatars(new Set());
    setCustomFieldError("");
    setSearchError("");
  }

  function chooseSource(next: WritingAssignmentQuestionSource) {
    if (questionLocked) return;
    if (source === next) return;
    setSource(next);
    setSelectedQuestion(null);
    setQuestionResult(null);
    setCustomFields(next === "custom" && taskType === "academic_discussion"
      ? defaultAcademicDiscussionAvatarFields()
      : {});
    setManuallySelectedAvatars(new Set());
    setCustomFieldError("");
    setSearchError("");
  }

  async function searchQuestions(page = 1) {
    if (!taskType) return;
    setSearching(true);
    setSearchError("");
    try {
      const params = new URLSearchParams({ taskType, query, page: String(page), pageSize: "10" });
      setQuestionResult(await teacherApiFetch(`/api/teacher/writing/assignments/questions?${params}`));
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "题库搜索失败。");
    } finally {
      setSearching(false);
    }
  }

  function toggleStudent(studentId: string) {
    if (selectedStudents.includes(studentId) && lockedStudentIds.has(studentId)) return;
    setSelectedStudents((current) => current.includes(studentId)
      ? current.filter((id) => id !== studentId)
      : [...current, studentId]);
  }

  function updateCustomField(field: string, value: string) {
    setCustomFields((current) => {
      const next = { ...current, [field]: value };
      const avatarField = AVATAR_FIELD_BY_NAME[field as keyof typeof AVATAR_FIELD_BY_NAME];
      if (avatarField && !manuallySelectedAvatars.has(avatarField)) {
        if (avatarField === "professor_avatar_type") {
          next[avatarField] = suggestAcademicDiscussionAvatarType(value, "professor", "male_professor");
        } else {
          const fallback = avatarField === "student_2_avatar_type" ? "female_student" : "male_student";
          next[avatarField] = suggestAcademicDiscussionAvatarType(value, "student", fallback);
        }
      }
      return next;
    });
    if (field === "requirements") setCustomFieldError("");
  }

  function chooseCustomAvatar(field: string, value: string) {
    setCustomFields((current) => ({ ...current, [field]: value }));
    setManuallySelectedAvatars((current) => new Set(current).add(field));
  }

  function normalizeCustomField(field: string) {
    const currentValue = customFields[field] ?? "";
    const normalized = field === "requirements"
      ? normalizeEmailRequirementsInput(currentValue)
      : normalizeAssignmentText(currentValue);
    setCustomFields((current) => ({ ...current, [field]: normalized }));
    if (field === "requirements") {
      try {
        parseEmailRequirements(currentValue);
        setCustomFieldError("");
      } catch (error) {
        setCustomFieldError(error instanceof Error ? error.message : "请输入 3 个邮件要点");
      }
    }
  }

  async function submit(reactivate = false) {
    setSubmitError("");
    if (!taskType) return setSubmitError("请先选择题型。");
    if (!source) return setSubmitError("请选择题目来源。");
    if (source === "custom") {
      try {
        buildCustomWritingQuestionSnapshot({ taskType, fields: customFields, id: "validation" });
      } catch (error) {
        return setSubmitError(error instanceof Error ? error.message : "请完整填写自定义题目。");
      }
    }
    if (!previewQuestion) return setSubmitError(source === "question_bank" ? "请选择一道题库题目。" : "请完整填写自定义题目。");
    if (!selectedStudents.length) return setSubmitError("请至少选择一名学生。");
    if (hasDueAt && (!dueAt || Number.isNaN(new Date(dueAt).getTime()))) return setSubmitError("请选择有效的截止时间。");
    setSubmitting(true);
    try {
      const payload = await teacherApiFetch<{ assignmentId: string }>(editing
        ? `/api/teacher/writing/assignments/${encodeURIComponent(initialAssignment!.assignment_id)}`
        : "/api/teacher/writing/assignments", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({
          action: editing ? "edit" : undefined,
          reactivate,
          taskType,
          questionSource: source,
          questionId: source === "question_bank" ? selectedQuestion?.question_id : null,
          customQuestion: source === "custom" ? customFields : null,
          studentIds: selectedStudents,
          dueAt: hasDueAt ? new Date(dueAt).toISOString() : null
        })
      });
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      publishCacheInvalidation({
        type: "ASSIGNMENT_UPDATED",
        assignmentId: payload.assignmentId,
        assignmentQuestionSource: source
      });
      router.push(`/teacher/writing/assignments/${payload.assignmentId}`);
      router.refresh();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "作业创建失败。");
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5">
      <StepCard number="1" title="选择题型">
        <div className="grid gap-3 sm:grid-cols-2">{(["email", "academic_discussion"] as const).map((type) => <ChoiceButton active={taskType === type} disabled={questionLocked} key={type} label={WRITING_TASK_CONFIG[type].label} onClick={() => chooseTaskType(type)} />)}</div>
        {questionLocked ? <p className="text-xs text-student-muted">已有学生提交，题型和题目内容已锁定。</p> : null}
      </StepCard>

      <StepCard number="2" title="选择题目来源">
        <div className="grid gap-3 sm:grid-cols-2"><ChoiceButton active={source === "question_bank"} disabled={!taskType || questionLocked} label="从题库选择" onClick={() => chooseSource("question_bank")} /><ChoiceButton active={source === "custom"} disabled={!taskType || questionLocked} label="自定义题目" onClick={() => chooseSource("custom")} /></div>
      </StepCard>

      <StepCard number="3" title={source === "custom" ? "填写自定义题" : "选择题目"}>
        {!taskType || !source ? <p className="text-sm text-student-muted">请先选择题型和题目来源。</p> : source === "question_bank" ? questionLocked ? (
          selectedQuestion ? <WritingAssignmentQuestionPreview question={selectedQuestion} questionSource={source} taskType={taskType} /> : null
        ) : (
          <div className="grid gap-4">
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void searchQuestions(1); }}><input className="teacher-input min-w-0 flex-1" onChange={(event) => setQuery(event.target.value)} placeholder="搜索套题名称或题目关键词" value={query} /><button className="teacher-button-primary" disabled={searching} type="submit"><Search aria-hidden="true" size={16} />{searching ? "搜索中" : "搜索题目"}</button></form>
            {searchError ? <TeacherDataError text={searchError} /> : null}
            {questionResult ? <QuestionResults payload={questionResult} selectedId={selectedQuestion?.question_id ?? null} taskType={taskType} onPage={(page) => void searchQuestions(page)} onSelect={setSelectedQuestion} /> : <p className="text-sm text-student-muted">输入关键词后搜索；留空可分页浏览当前题型题库。</p>}
          </div>
        ) : <div className="grid gap-3"><CustomQuestionFields disabled={questionLocked} fields={taskType === "email" ? EMAIL_CUSTOM_FIELDS : DISCUSSION_CUSTOM_FIELDS} values={customFields} onAvatarChange={chooseCustomAvatar} onBlur={normalizeCustomField} onChange={updateCustomField} />{customFieldError ? <p className="text-sm font-semibold text-student-error">{customFieldError}</p> : null}</div>}
      </StepCard>

      <StepCard number="4" title="选择学生">
        <div className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[240px] flex-1"><Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} /><input className="teacher-input w-full pl-9" onChange={(event) => setStudentQuery(event.target.value)} placeholder="搜索中文姓名、拼音或邮箱" value={studentQuery} /></div><span className="text-sm font-bold text-student-primary">已选择 {selectedStudents.length} 人</span></div>
          {studentsState.loading ? <TeacherSkeleton className="h-40 w-full rounded-xl" /> : studentsState.error ? <TeacherDataError text={studentsState.error} /> : <div className="max-h-72 overflow-y-auto rounded-xl border border-student-border"><div className="grid gap-px bg-student-border">{filteredStudents.map((student) => { const active = selectedStudents.includes(student.id); const removalLocked = active && lockedStudentIds.has(student.id); return <button aria-disabled={removalLocked} className={`flex items-center gap-3 bg-white px-4 py-3 text-left transition hover:bg-student-bg ${active ? "!bg-student-primary-soft" : ""} ${removalLocked ? "cursor-not-allowed" : ""}`} key={student.id} onClick={() => toggleStudent(student.id)} title={removalLocked ? "该学生已有草稿或提交记录，不能移除" : undefined} type="button"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-student-primary"><UserRound aria-hidden="true" size={18} /></span><span className="min-w-0 flex-1"><span className="block font-semibold text-student-text">{student.displayName}</span><span className="block truncate text-xs text-student-muted">{student.email}</span></span>{removalLocked ? <span className="text-xs font-semibold text-student-muted">已有作答</span> : null}{active ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</button>; })}{!filteredStudents.length ? <p className="bg-white px-4 py-8 text-center text-sm text-student-muted">没有匹配的学生。</p> : null}</div></div>}
        </div>
      </StepCard>

      <StepCard number="5" title="截止时间">
        <div className="grid gap-3"><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={!hasDueAt} name="due-mode" onChange={() => setHasDueAt(false)} type="radio" />不设置截止时间</label><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={hasDueAt} name="due-mode" onChange={() => setHasDueAt(true)} type="radio" />设置截止时间</label>{hasDueAt ? <input className="teacher-input max-w-sm" onChange={(event) => setDueAt(event.target.value)} type="datetime-local" value={dueAt} /> : null}<p className="text-xs text-student-muted">截止时间仅用于完成状态判断，不会禁止提交。</p></div>
      </StepCard>

      <StepCard number="6" title="题目预览">
        {previewQuestion && taskType && source ? <WritingAssignmentQuestionPreview question={previewQuestion} questionSource={source} taskType={taskType} /> : <p className="text-sm text-student-muted">完成题目选择或填写后，这里会显示完整预览。</p>}
      </StepCard>

      <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-5"><div><p className="font-bold text-student-text">{editing ? "保存作业修改" : "确认布置"}</p><p className="mt-1 text-sm text-student-muted">{editing ? "保存后可继续保持撤回，或立即重新布置。" : `将作业布置给已选择的 ${selectedStudents.length} 名学生。`}</p></div><div className="flex flex-col items-end gap-2">{submitError ? <p className="text-sm font-medium text-student-error">{submitError}</p> : null}<div className="flex flex-wrap justify-end gap-2">{editing ? <button className="teacher-button-secondary" disabled={submitting} onClick={() => void submit(false)} type="button">{submitting ? "正在保存…" : "保存修改"}</button> : null}<button className="teacher-button-primary" disabled={submitting} onClick={() => void submit(editing)} type="button">{submitting ? (editing ? "正在保存…" : "正在布置…") : (editing ? "保存并重新布置" : "布置")}</button></div></div></TeacherCard>
    </div>
  );
}

function CustomQuestionDraftCard({
  disabled,
  draft,
  index,
  onAvatarChange,
  onChange,
  onPromptChange,
  onRemove,
  onToggle,
  taskType
}: {
  disabled?: boolean;
  draft: CustomQuestionDraft;
  index: number;
  onAvatarChange: (field: string, value: string) => void;
  onChange: (field: string, value: string) => void;
  onPromptChange: (value: string) => void;
  onRemove: () => void;
  onToggle: () => void;
  taskType: WritingTaskType;
}) {
  const values = stringDraftFields(draft.fields);
  if (taskType === "academic_discussion") {
    return <div className="grid gap-4 rounded-xl border border-student-border p-4"><div className="flex items-center justify-between gap-3"><p className="font-bold text-student-text">第 {index + 1} 篇</p><button aria-label={`删除第 ${index + 1} 篇`} className="teacher-button-secondary px-3 text-student-error" disabled={disabled} onClick={onRemove} type="button"><Trash2 aria-hidden="true" size={16} />删除</button></div><CustomQuestionFields disabled={disabled} fields={DISCUSSION_CUSTOM_FIELDS} values={values} onAvatarChange={onAvatarChange} onBlur={() => undefined} onChange={onChange} /></div>;
  }

  const requirementCount = customEmailRequirementCount(draft);
  const toMissing = !values.recipient?.trim();
  return (
    <div className="grid gap-4 rounded-xl border border-student-border p-4">
      <div className="flex items-center justify-between gap-3"><p className="font-bold text-student-text">第 {index + 1} 篇</p><button aria-label={`删除第 ${index + 1} 篇`} className="teacher-button-secondary px-3 text-student-error" disabled={disabled} onClick={onRemove} type="button"><Trash2 aria-hidden="true" size={16} />删除</button></div>
      <label className="grid gap-2 text-sm font-semibold text-student-text">作业标题<input className="teacher-input" disabled={disabled} onChange={(event) => onChange("title", event.target.value)} value={values.title ?? ""} /></label>
      <label className="grid gap-2 text-sm font-semibold text-student-text">题目<span className="text-xs font-normal text-student-muted">粘贴完整 Scenario 和三条要求；原文不会被改写。</span><textarea className="teacher-input min-h-52 resize-y" disabled={disabled} onChange={(event) => onPromptChange(event.target.value)} placeholder={"You need to...\n\nWrite an email to... In your email, do the following:\n• ...\n• ...\n• ..."} value={draft.rawPrompt} /></label>
      <label className="grid gap-2 text-sm font-semibold text-student-text">Subject<input className="teacher-input" disabled={disabled} onChange={(event) => onChange("subject", event.target.value)} value={values.subject ?? ""} /></label>
      <div className={`rounded-xl border px-4 py-3 text-sm ${toMissing || requirementCount !== 3 ? "border-student-error/40 bg-red-50" : "border-student-border bg-student-bg"}`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-x-5 gap-y-1"><span><strong>To：</strong>{values.recipient || "未识别，请补充"}</span><span><strong>已识别要求：</strong>{requirementCount} 条</span></div><button className="inline-flex items-center gap-1 font-semibold text-student-primary" onClick={onToggle} type="button">查看/修改识别结果{draft.expanded ? <ChevronUp aria-hidden="true" size={16} /> : <ChevronDown aria-hidden="true" size={16} />}</button></div>{toMissing ? <p className="mt-2 font-semibold text-student-error">未能识别收件对象，请展开后确认或补充 To。</p> : null}{requirementCount !== 3 ? <p className="mt-2 font-semibold text-student-error">必须准确识别或补充 3 条要求后才能布置。</p> : null}</div>
      {draft.expanded ? <div className="grid gap-3 rounded-xl border border-student-border bg-white p-4"><label className="grid gap-2 text-sm font-semibold text-student-text">To<input className="teacher-input" onChange={(event) => onChange("recipient", event.target.value)} value={values.recipient ?? ""} /></label><label className="grid gap-2 text-sm font-semibold text-student-text">Scenario<textarea className="teacher-input min-h-28 resize-y" onChange={(event) => onChange("scenario", event.target.value)} value={values.scenario ?? ""} /></label>{[1, 2, 3].map((number) => <label className="grid gap-2 text-sm font-semibold text-student-text" key={number}>Requirement {number}<textarea className="teacher-input min-h-20 resize-y" onChange={(event) => onChange(`requirement_${number}`, event.target.value)} value={values[`requirement_${number}`] ?? ""} /></label>)}</div> : null}
    </div>
  );
}

function MultiQuestionResults({ onPage, onToggle, payload, selectedIds, taskType }: { onPage: (page: number) => void; onToggle: (question: LogicalWritingQuestionSearchResult) => void; payload: QuestionSearchPayload; selectedIds: Set<string>; taskType: WritingTaskType }) {
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  return <div className="grid gap-3"><div className="grid gap-2">{payload.questions.map((question) => { const selected = selectedIds.has(question.question_id); return <button aria-pressed={selected} className={`rounded-xl border p-4 text-left transition ${selected ? "border-student-primary bg-student-primary-soft" : "border-student-border hover:border-student-primary-border"}`} key={question.logical_item_id} onClick={() => onToggle(question)} type="button"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[taskType].label}</p><p className="mt-1 font-bold text-student-text">{question.logical_display_name}</p></div>{selected ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</div><p className="mt-2 line-clamp-2 text-sm text-student-muted">{"scenario" in question ? `${question.scenario} ${question.requirement_1}` : `Professor ${question.professor_name}: ${question.professor_prompt}`}</p>{"professor_prompt" in question ? <p className="mt-1 line-clamp-1 text-xs text-student-muted">{question.student_1_name}: {question.student_1_response} · {question.student_2_name}: {question.student_2_response}</p> : null}</button>; })}{!payload.questions.length ? <p className="py-6 text-center text-sm text-student-muted">没有找到匹配题目。</p> : null}</div><div className="flex items-center justify-between text-sm text-student-muted"><span>共 {payload.total} 道 · 第 {payload.page}/{totalPages} 页</span><div className="flex gap-2"><button className="teacher-button-secondary h-9 px-3" disabled={payload.page <= 1} onClick={() => onPage(payload.page - 1)} type="button"><ChevronLeft aria-hidden="true" size={15} />上一页</button><button className="teacher-button-secondary h-9 px-3" disabled={payload.page >= totalPages} onClick={() => onPage(payload.page + 1)} type="button">下一页<ChevronRight aria-hidden="true" size={15} /></button></div></div></div>;
}

function createCustomQuestionDraft(
  taskType: WritingTaskType,
  assignmentTitle = ""
): CustomQuestionDraft {
  return {
    clientId: crypto.randomUUID(),
    expanded: false,
    fields: taskType === "email"
      ? { parsed_email: true, title: assignmentTitle }
      : { ...defaultAcademicDiscussionAvatarFields(), title: assignmentTitle },
    manuallySelectedAvatars: [],
    parsedRequirementCount: 0,
    rawPrompt: "",
    requirementsManuallyEdited: false,
    titleManuallyEdited: false,
    toManuallyEdited: false
  };
}

function customEmailRequirementCount(draft: CustomQuestionDraft) {
  if (!draft.requirementsManuallyEdited) return draft.parsedRequirementCount;
  const values = stringDraftFields(draft.fields);
  return [1, 2, 3].filter((number) => values[`requirement_${number}`]?.trim()).length;
}

function stringDraftFields(fields: Record<string, string | boolean>) {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function StepCard({ children, number, title }: { children: React.ReactNode; number: string; title: string }) {
  return <TeacherCard className="grid gap-4 p-5"><div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-student-primary text-sm font-bold text-white">{number}</span><TeacherSectionTitle>{title}</TeacherSectionTitle></div>{children}</TeacherCard>;
}

function ChoiceButton({ active, disabled, label, onClick }: { active: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return <button className={`flex min-h-14 items-center justify-between rounded-xl border px-4 text-left font-semibold transition ${active ? "border-student-primary bg-student-primary-soft text-student-primary" : "border-student-border bg-white text-student-text hover:border-student-primary-border"}`} disabled={disabled} onClick={onClick} type="button"><span>{label}</span>{active ? <Check aria-hidden="true" size={18} /> : null}</button>;
}

function CustomQuestionFields({ disabled, fields, onAvatarChange, onBlur, onChange, values }: { disabled?: boolean; fields: ReadonlyArray<readonly [string, string]>; onAvatarChange: (field: string, value: string) => void; onBlur: (field: string) => void; onChange: (field: string, value: string) => void; values: Record<string, string> }) {
  return <div className="grid gap-4">{fields.map(([field, label]) => {
    const avatarField = AVATAR_FIELD_BY_NAME[field as keyof typeof AVATAR_FIELD_BY_NAME];
    return <div className="grid gap-2" key={field}><label className="grid gap-2 text-sm font-semibold text-student-text">{label}{field === "requirements" ? <><span className="text-xs font-normal text-student-muted">每个要点一行</span><textarea className="teacher-input min-h-36 resize-y" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} placeholder={"Explain why...\nAsk for...\nMention..."} value={values[field] ?? ""} /></> : field.includes("name") || field === "title" || field === "recipient" || field === "subject" ? <input className="teacher-input" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} value={values[field] ?? ""} /> : <textarea className="teacher-input min-h-24 resize-y" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} value={values[field] ?? ""} />}</label>{avatarField ? <CustomAvatarPicker avatarField={avatarField} disabled={disabled} onChange={onAvatarChange} value={values[avatarField] ?? ""} /> : null}</div>;
  })}</div>;
}

function CustomAvatarPicker({ avatarField, disabled, onChange, value }: { avatarField: (typeof AVATAR_FIELD_BY_NAME)[keyof typeof AVATAR_FIELD_BY_NAME]; disabled?: boolean; onChange: (field: string, value: string) => void; value: string }) {
  const professor = avatarField === "professor_avatar_type";
  const options = professor
    ? ([
        ["male_professor", "男教授"],
        ["female_professor", "女教授"]
      ] as const)
    : ([
        ["male_student", "男学生"],
        ["female_student", "女学生"]
      ] as const);
  return <div className="flex flex-wrap gap-3" role="group" aria-label="选择头像">{options.map(([avatarType, label]) => {
    const active = value === avatarType;
    return <button aria-pressed={active} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition ${active ? "border-student-primary bg-student-primary-soft text-student-primary ring-2 ring-student-primary/15" : "border-student-border bg-white text-student-text hover:border-student-primary-border"}`} disabled={disabled} key={avatarType} onClick={() => onChange(avatarField, avatarType)} type="button"><Image alt={label} className="h-11 w-11 rounded-full object-cover" height={44} src={CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS[avatarType]} width={44} /><span>{label}</span>{active ? <Check aria-hidden="true" size={16} /> : null}</button>;
  })}</div>;
}

function QuestionResults({ onPage, onSelect, payload, selectedId, taskType }: { onPage: (page: number) => void; onSelect: (question: WritingQuestion) => void; payload: QuestionSearchPayload; selectedId: string | null; taskType: WritingTaskType }) {
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  return <div className="grid gap-3"><div className="grid gap-2">{payload.questions.map((question) => { const selected = question.question_id === selectedId; return <button className={`rounded-xl border p-4 text-left transition ${selected ? "border-student-primary bg-student-primary-soft" : "border-student-border hover:border-student-primary-border"}`} key={question.logical_item_id} onClick={() => onSelect(question)} type="button"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[taskType].label}</p><p className="mt-1 font-bold text-student-text">{question.logical_display_name}</p></div>{selected ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</div><p className="mt-2 line-clamp-2 text-sm text-student-muted">{"scenario" in question ? `${question.scenario} ${question.requirement_1}` : `Professor ${question.professor_name}: ${question.professor_prompt}`}</p>{"professor_prompt" in question ? <p className="mt-1 line-clamp-1 text-xs text-student-muted">{question.student_1_name}: {question.student_1_response} · {question.student_2_name}: {question.student_2_response}</p> : null}</button>; })}{!payload.questions.length ? <p className="py-6 text-center text-sm text-student-muted">没有找到匹配题目。</p> : null}</div><div className="flex items-center justify-between text-sm text-student-muted"><span>共 {payload.total} 道 · 第 {payload.page}/{totalPages} 页</span><div className="flex gap-2"><button className="teacher-button-secondary h-9 px-3" disabled={payload.page <= 1} onClick={() => onPage(payload.page - 1)} type="button"><ChevronLeft aria-hidden="true" size={15} />上一页</button><button className="teacher-button-secondary h-9 px-3" disabled={payload.page >= totalPages} onClick={() => onPage(payload.page + 1)} type="button">下一页<ChevronRight aria-hidden="true" size={15} /></button></div></div></div>;
}

function customFieldsFromSnapshot(question: WritingQuestion): Record<string, string> {
  if ("scenario" in question) {
    return {
      title: question.set_title,
      scenario: question.scenario,
      requirements: [question.requirement_1, question.requirement_2, question.requirement_3].join("\n"),
      recipient: question.recipient,
      subject: question.subject,
      task_instruction: question.task_instruction
    };
  }
  return {
    title: question.set_title,
    professor_name: question.professor_name,
    professor_prompt: question.professor_prompt,
    student_1_name: question.student_1_name,
    student_1_response: question.student_1_response,
    student_2_name: question.student_2_name,
    student_2_response: question.student_2_response,
    professor_avatar_type: isProfessorAvatarType(question.professor_avatar_type)
      ? question.professor_avatar_type
      : "male_professor",
    student_1_avatar_type: isStudentAvatarType(question.student_1_avatar_type)
      ? question.student_1_avatar_type
      : "male_student",
    student_2_avatar_type: isStudentAvatarType(question.student_2_avatar_type)
      ? question.student_2_avatar_type
      : "female_student"
  };
}

function defaultAcademicDiscussionAvatarFields(): Record<string, string> {
  return {
    professor_avatar_type: "male_professor",
    student_1_avatar_type: "male_student",
    student_2_avatar_type: "female_student"
  };
}

function formatLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
