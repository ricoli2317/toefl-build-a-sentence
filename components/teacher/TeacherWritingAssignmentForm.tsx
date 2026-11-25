"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Search, Trash2, UserRound } from "lucide-react";
import {
  TEACHER_CLASSES_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  TEACHER_WRITING_ASSIGNMENT_TITLES_CACHE_KEY,
  teacherAssignmentStudentsCacheKey,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { TeacherAssignmentCatalogPicker } from "@/components/teacher/TeacherAssignmentCatalogPicker";
import { useAssignmentPracticeStatus } from "@/components/teacher/useAssignmentPracticeStatus";
import {
  TeacherCategoryAssignmentConfig,
  type CategoryAssignmentOption
} from "@/components/teacher/TeacherCategoryAssignmentConfig";
import {
  defaultAssignmentPickerState,
  readAssignmentDraft,
  selectAssignmentPickerItemType,
  writeAssignmentDraft,
  type AssignmentPickerState
} from "@/lib/assignmentPickerState";
import { TeacherAssignmentSelectionPreview } from "@/components/teacher/TeacherAssignmentSelectionPreview";
import { WritingAssignmentQuestionPreview } from "@/components/teacher/WritingAssignmentQuestionPreview";
import {
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank
} from "@/lib/studentSearch";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  teacherAssignmentBatchDetailHref,
  teacherAssignmentDetailHref,
  teacherReturnToHref
} from "@/lib/teacherNavigation";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { WRITING_TASK_CONFIG, type WritingQuestion, type WritingTaskType } from "@/lib/writing";
import {
  ASSIGNMENT_SUBJECTS,
  ASSIGNMENT_SUBJECT_LABELS,
  assignmentCatalogEntryFromAssignment,
  assignmentCatalogEntryKey,
  assignmentItemSubject,
  assignmentItemTypeLabel,
  categoryAssignmentItemTypeForSubject,
  isCategoryAssignmentItemType,
  type AssignmentCatalogEntry,
  type AssignmentCatalogSelection,
  type AssignmentSubject
} from "@/lib/assignmentCatalog";
import {
  categoryAssignmentConfigFromManifest,
  categoryAssignmentSummary,
  categoryAssignmentTotalQuestions,
  validateCategoryAssignmentConfig,
  type CategoryAssignmentConfigRow,
  type CategoryAssignmentItemType
} from "@/lib/categoryAssignment";
import { writingAssignmentCategoryManifest } from "@/lib/writingAssignments";
import {
  CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS,
  isProfessorAvatarType,
  isStudentAvatarType
} from "@/lib/academicDiscussionAvatars";
import {
  buildCustomWritingQuestionSnapshot,
  defaultWritingAssignmentTitle,
  isWritingReviewItemType,
  nextWritingAssignmentAutoTitle,
  normalizeAssignmentText,
  normalizeEmailRequirementsInput,
  parseCustomEmailPrompt,
  parseEmailRequirements,
  suggestAcademicDiscussionAvatarType,
  writingAssignmentTitle,
  type WritingAssignmentCollectionDetail,
  type WritingAssignmentDetail,
  type WritingAssignmentQuestionSource,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";
import type { LogicalWritingQuestionSearchResult } from "@/lib/writingAssignmentLogicalSearch";
import { formatAccountForDisplay, formatManagedAccountName } from "@/lib/accountIdentifier";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import {
  classAssignmentTitleBase,
  classSubjectsLabel,
  filterClassSummariesByName,
  isAutomaticWritingAssignmentTitle,
  seededAssignmentTitleBase,
  assignmentSubjectsForClassSubjects,
  assignmentSubjectsForStudents,
  NO_COMMON_ASSIGNMENT_SUBJECT_MESSAGE,
  type TeacherClassSummary
} from "@/lib/teacherClasses";
import type { StudentBindingDomain } from "@/lib/studentBindings";

type StudentOption = {
  id: string;
  displayName: string;
  email: string;
  domains: StudentBindingDomain[];
};
export type QuestionSearchPayload = { questions: LogicalWritingQuestionSearchResult[]; page: number; pageSize: number; total: number };
type CustomQuestionDraft = {
  /** Existing withdrawn custom item identity; absent for a new draft. */
  assignmentId?: string;
  clientId: string;
  expanded: boolean;
  fields: Record<string, string | boolean>;
  manuallySelectedAvatars: string[];
  parsedRequirementCount: number;
  rawPrompt: string;
  requirementsManuallyEdited: boolean;
  taskType: WritingTaskType;
  titleManuallyEdited: boolean;
  toManuallyEdited: boolean;
};

const EMPTY_QUESTION_SELECTION = new Map<string, LogicalWritingQuestionSearchResult>();

export const EMAIL_CUSTOM_FIELDS = [
  ["title", "作业标题"],
  ["scenario", "Scenario"],
  ["requirements", "三个要点"],
  ["recipient", "To"],
  ["subject", "Subject"]
] as const;
export const DISCUSSION_CUSTOM_FIELDS = [
  ["title", "作业标题"],
  ["professor_name", "Professor Name"],
  ["professor_prompt", "Professor Prompt"],
  ["student_1_name", "Student 1 Name"],
  ["student_1_response", "Student 1 Response"],
  ["student_2_name", "Student 2 Name"],
  ["student_2_response", "Student 2 Response"]
] as const;
export const AVATAR_FIELD_BY_NAME = {
  professor_name: "professor_avatar_type",
  student_1_name: "student_1_avatar_type",
  student_2_name: "student_2_avatar_type"
} as const;

/**
 * One shared Assignment wizard for 写作 and 阅读.
 *
 * 布置作业 -> 学生 / 班级 -> 选择科目 -> 选择作业内容 -> (写作: 题库 / 自定义题目
 * | 阅读: 直接进入题库) -> 选题 -> 标题 -> 截止时间 -> 预览 -> 布置.
 *
 * The recipient selection now comes first: the selected students' shared
 * subject bindings (or the acting teacher's subjects in the selected class)
 * decide which subjects step 2 may offer. The catalog picker marks every item
 * any selected student has already completed, so the teacher can prefer
 * untouched questions.
 *
 * A withdrawn Assignment re-enters this exact wizard seeded with the original
 * data (items, recipients, title, deadline): 撤回 already guarantees there is
 * no attempt on the whole group, so every placement element stays editable and
 * the same create/validation rules still apply.
 *
 * The catalog picker loads one lightweight catalog per subject and filters on
 * the client; the picker state (subject, active tab, one filter set per item
 * type and the cross-type selection) is kept in sessionStorage so 查看题目 and
 * back navigation never restarts the filtering. Only the picker draft is
 * stored — students, titles and deadlines stay plain component state.
 */
export function TeacherWritingAssignmentForm({
  initialAssignment,
  initialClassId,
  initialCollection,
  initialStudentId,
  returnTo
}: {
  initialAssignment?: WritingAssignmentDetail;
  initialClassId?: string;
  initialCollection?: WritingAssignmentCollectionDetail;
  initialStudentId?: string;
  returnTo?: string;
}) {
  const initialAssignments = initialCollection?.assignments
    ?? (initialAssignment ? [initialAssignment] : []);
  return (
    <TeacherAssignmentWizard
      initialAssignments={initialAssignments}
      initialClassId={
        initialClassId
        ?? initialCollection?.assignments[0]?.class_id
        ?? initialAssignment?.class_id
        ?? undefined
      }
      initialGroupId={
        initialCollection?.collection_id
        ?? initialAssignment?.group_id
        ?? null
      }
      initialGroupTitle={
        initialCollection?.title
        ?? initialAssignment?.group_title
        ?? null
      }
      initialStudentId={initialStudentId}
      returnTo={returnTo}
    />
  );
}

type WizardSeed = {
  assignmentIdsByKey: Map<string, string>;
  categoryAssignmentId: string | null;
  categoryEnabled: boolean;
  categoryRows: CategoryAssignmentConfigRow[];
  className: string | null;
  customQuestions: CustomQuestionDraft[];
  dueAt: string;
  firstStudentName: string | null;
  pickerState: AssignmentPickerState;
  selection: AssignmentCatalogSelection;
  source: WritingAssignmentQuestionSource | null;
  standardEnabled: boolean;
  studentCount: number;
  students: string[];
  subject: AssignmentSubject | null;
  title: string;
  /** The date the automatic title language uses (the persisted 布置日期). */
  titleAssignedAt: string | null;
};

function buildWizardSeed(
  assignments: WritingAssignmentDetail[],
  groupTitle: string | null
): WizardSeed {
  const selection = new Map<string, AssignmentCatalogEntry>();
  const assignmentIdsByKey = new Map<string, string>();
  const customQuestions: CustomQuestionDraft[] = [];
  const subject = assignments.length > 0
    ? assignmentItemSubject(assignments[0].task_type)
    : null;
  const categoryAssignments = assignments.filter((assignment) =>
    isCategoryAssignmentItemType(assignment.task_type)
  );
  const standardAssignments = assignments.filter(
    (assignment) => !isCategoryAssignmentItemType(assignment.task_type)
  );
  const firstCategoryAssignment = categoryAssignments[0];
  const categoryManifest = firstCategoryAssignment
    ? writingAssignmentCategoryManifest(firstCategoryAssignment.question_snapshot)
    : null;
  const categoryRows = categoryManifest
    ? categoryAssignmentConfigFromManifest(categoryManifest)
    : [];
  for (const assignment of standardAssignments) {
    if (assignment.question_source === "question_bank" && assignment.question_id) {
      const entry = assignmentCatalogEntryFromAssignment(assignment);
      const key = assignmentCatalogEntryKey(entry);
      selection.set(key, entry);
      assignmentIdsByKey.set(key, assignment.assignment_id);
      continue;
    }
    if (assignment.question_source === "custom") {
      customQuestions.push(customQuestionDraftFromAssignment(assignment));
    }
  }
  const anyBank = standardAssignments.some((assignment) => assignment.question_source === "question_bank");
  const anyCustom = standardAssignments.some((assignment) => assignment.question_source === "custom");
  const firstBankItemType = standardAssignments.find(
    (assignment) => assignment.question_source === "question_bank"
  )?.task_type;
  const defaultPickerState = defaultAssignmentPickerState(subject ?? "writing");
  const firstAssignment = assignments[0] ?? null;
  return {
    assignmentIdsByKey,
    categoryAssignmentId: firstCategoryAssignment?.assignment_id ?? null,
    categoryEnabled: categoryAssignments.length > 0,
    categoryRows,
    className: firstAssignment?.class_name?.trim() || null,
    customQuestions,
    dueAt: assignments.flatMap((assignment) => assignment.due_at ? [assignment.due_at] : [])
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .map((value) => formatLocalDateTime(value))[0] ?? "",
    firstStudentName: firstAssignment?.students[0]?.student_name?.trim() || null,
    pickerState: firstBankItemType
      && assignmentItemSubject(firstBankItemType) === (subject ?? "writing")
      ? selectAssignmentPickerItemType(defaultPickerState, firstBankItemType)
      : defaultPickerState,
    selection,
    source: standardAssignments.length > 0
      ? anyBank || !anyCustom ? "question_bank" : "custom"
      : null,
    standardEnabled: assignments.length === 0 || standardAssignments.length > 0,
    studentCount: firstAssignment?.students.length ?? 0,
    students: firstAssignment?.students.map((student) => student.student_id) ?? [],
    subject,
    title: groupTitle?.trim()
      || assignments[0]?.display_name?.trim()
      || (assignments[0] ? writingAssignmentTitle(assignments[0].question_snapshot) : ""),
    titleAssignedAt: firstAssignment?.created_at ?? null
  };
}

function customQuestionDraftFromAssignment(
  assignment: WritingAssignmentDetail
): CustomQuestionDraft {
  const taskType = isWritingReviewItemType(assignment.task_type)
    ? assignment.task_type
    : "email";
  if (taskType === "email") {
    const snapshot = assignment.question_snapshot;
    const email = "scenario" in snapshot ? snapshot : null;
    return {
      assignmentId: assignment.assignment_id,
      clientId: crypto.randomUUID(),
      expanded: false,
      fields: email
        ? {
            parsed_email: true,
            recipient: email.recipient,
            requirement_1: email.requirement_1,
            requirement_2: email.requirement_2,
            requirement_3: email.requirement_3,
            scenario: email.scenario,
            subject: email.subject,
            task_instruction: email.task_instruction,
            title: email.set_title
          }
        : {},
      manuallySelectedAvatars: [],
      parsedRequirementCount: 3,
      rawPrompt: "",
      requirementsManuallyEdited: true,
      taskType,
      titleManuallyEdited: true,
      toManuallyEdited: true
    };
  }
  return {
    assignmentId: assignment.assignment_id,
    clientId: crypto.randomUUID(),
    expanded: false,
    fields: customFieldsFromSnapshot(assignment.question_snapshot),
    manuallySelectedAvatars: Object.values(AVATAR_FIELD_BY_NAME),
    parsedRequirementCount: 3,
    rawPrompt: "",
    requirementsManuallyEdited: true,
    taskType,
    titleManuallyEdited: true,
    toManuallyEdited: true
  };
}

function TeacherAssignmentWizard({
  initialAssignments,
  initialClassId,
  initialGroupId,
  initialGroupTitle,
  initialStudentId,
  returnTo
}: {
  initialAssignments: WritingAssignmentDetail[];
  initialClassId?: string;
  initialGroupId: string | null;
  initialGroupTitle: string | null;
  initialStudentId?: string;
  returnTo?: string;
}) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const editing = initialAssignments.length > 0;
  const seed = useMemo(
    () => buildWizardSeed(initialAssignments, initialGroupTitle),
    [initialAssignments, initialGroupTitle]
  );
  const [subject, setSubject] = useState<AssignmentSubject | null>(seed.subject);
  const [standardEnabled, setStandardEnabled] = useState(seed.standardEnabled);
  const [categoryEnabled, setCategoryEnabled] = useState(seed.categoryEnabled);
  const [categoryRows, setCategoryRows] = useState<CategoryAssignmentConfigRow[]>(seed.categoryRows);
  const [seededCategoryAssignmentId] = useState<string | null>(seed.categoryAssignmentId);
  const [source, setSource] = useState<WritingAssignmentQuestionSource | null>(seed.source);
  const [selection, setSelection] = useState<AssignmentCatalogSelection>(() => seed.selection);
  const [seededAssignmentIds] = useState<Map<string, string>>(() => seed.assignmentIdsByKey);
  const [pickerState, setPickerState] = useState<AssignmentPickerState>(() => seed.pickerState);
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>(
    () => seed.customQuestions
  );
  // Custom Writing questions keep the historical WE / AD choice; the drafts of
  // the other type stay in memory and are submitted together.
  const [customTaskType, setCustomTaskType] = useState<WritingTaskType>(() =>
    seed.customQuestions[0]?.taskType ?? "email"
  );
  const [assignmentTitle, setAssignmentTitle] = useState(seed.title);
  // A withdrawn edit keeps regenerating the title only when the persisted title
  // is one the wizard itself would have generated (automatic titles carry no
  // marker, so they are recognized from the seed: 学生/班级 + 科目 + 日期 with
  // the optional (n) sequence). Any other title is the teacher's manual title
  // and is never overwritten.
  const [assignmentTitleManuallyEdited, setAssignmentTitleManuallyEdited] = useState(
    () => editing
      ? !isAutomaticWritingAssignmentTitle({
          assignedAt: seed.titleAssignedAt,
          className: seed.className,
          firstStudentName: seed.firstStudentName,
          studentCount: seed.studentCount,
          subject: seed.subject ?? "writing",
          title: seed.title
        })
      : false
  );
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>(
    () => seed.students.length > 0 ? seed.students : initialStudentId ? [initialStudentId] : []
  );
  const [deadlineMode, setDeadlineMode] = useState<"uniform" | "individual">("uniform");
  const [uniformDueAt, setUniformDueAt] = useState(seed.dueAt);
  const [individualDueAt, setIndividualDueAt] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const assignmentSubject: AssignmentSubject = subject ?? "writing";
  const activeCategoryKind: CategoryAssignmentItemType =
    categoryAssignmentItemTypeForSubject(assignmentSubject);
  const categoryValidation = useMemo(
    () => validateCategoryAssignmentConfig(categoryRows),
    [categoryRows]
  );
  const categoryOptionsState = useTeacherCachedData<{
    categories: CategoryAssignmentOption[];
    type: CategoryAssignmentItemType;
  }>(
    `teacher:category-assignment-options:${activeCategoryKind}`,
    () => teacherApiFetch(
      `/api/teacher/writing/assignments/category-options?type=${activeCategoryKind}`
    ),
    { enabled: categoryEnabled }
  );
  const categoryOptions = categoryOptionsState.data?.categories ?? [];
  const categoryTotal = categoryAssignmentTotalQuestions(categoryRows);
  const categorySummary = categoryAssignmentSummary(categoryRows);
  // The date the automatic title language uses: the assignment's own 布置日期 on
  // a withdrawn edit (so student / class / subject changes keep the same date),
  // today on a fresh create.
  const assignmentTitleDate = useMemo(
    () => (editing && seed.titleAssignedAt ? seed.titleAssignedAt : new Date()),
    [editing, seed.titleAssignedAt]
  );
  const studentsState = useTeacherCachedData<{ students: StudentOption[] }>(
    teacherAssignmentStudentsCacheKey(),
    () => teacherApiFetch("/api/teacher/writing/assignments/students")
  );
  // Step 1 works in one of two mutually exclusive modes. The class tab lists
  // every class this teacher is bound to; the class's own subject set (the
  // teacher's subjects there) decides which subjects stay offerable.
  const [selectionMode, setSelectionMode] = useState<"students" | "class">(
    initialClassId ? "class" : "students"
  );
  const [selectedClassId, setSelectedClassId] = useState(initialClassId ?? "");
  const [classQuery, setClassQuery] = useState("");
  const classesState = useTeacherCachedData<{ classes: TeacherClassSummary[] }>(
    TEACHER_CLASSES_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes")
  );
  // The picker draft survives 查看题目 round trips; it is restored after mount
  // so server and client first render identically. A withdrawn edit never
  // touches the draft: it is seeded from the persisted Assignment instead.
  useEffect(() => {
    if (editing) return;
    const draft = readAssignmentDraft();
    if (!draft) return;
    setSubject(draft.subject);
    setSource(draft.source);
    setSelection(new Map(draft.selection.map((entry) => [assignmentCatalogEntryKey(entry), entry])));
    setPickerState(draft.picker);
  }, [editing]);
  useEffect(() => {
    if (editing || !subject || !standardEnabled) return;
    writeAssignmentDraft({
      picker: pickerState,
      selection: Array.from(selection.values()),
      source,
      subject,
      version: 2
    });
  }, [editing, pickerState, selection, source, standardEnabled, subject]);
  const allClasses = useMemo(
    () => classesState.data?.classes ?? [],
    [classesState.data]
  );
  const selectedClass = useMemo(
    () => allClasses.find((entry) => entry.class_id === selectedClassId) ?? null,
    [allClasses, selectedClassId]
  );
  const filteredClasses = useMemo(
    () => filterClassSummariesByName(allClasses, classQuery),
    [allClasses, classQuery]
  );
  // Deep-linked or stale class ids are dropped as soon as the real class list
  // is known. The class list itself is never subject-filtered, so the teacher
  // always sees every bound class in step 1.
  useEffect(() => {
    if (!classesState.data) return;
    const available = allClasses.some((entry) => entry.class_id === selectedClassId);
    if (selectedClassId && !available) setSelectedClassId("");
    if (selectionMode === "class" && allClasses.length === 0) setSelectionMode("students");
  }, [allClasses, classesState.data, selectedClassId, selectionMode]);

  const studentEntries = useMemo(() => (studentsState.data?.students ?? []).map((student) => ({
    ...createStudentSearchMetadata(student.displayName),
    displayName: student.displayName,
    id: student.id,
    student
  })), [studentsState.data]);
  // The student list is the teacher's whole visible student list (any
  // subject). A stale deep-linked id that is no longer visible is dropped; the
  // server still re-validates every recipient for the submitted subject.
  useEffect(() => {
    if (!studentsState.data) return;
    const visible = new Set(studentsState.data.students.map((student) => student.id));
    setSelectedStudents((current) =>
      current.every((studentId) => visible.has(studentId))
        ? current
        : current.filter((studentId) => visible.has(studentId))
    );
  }, [studentsState.data]);
  const domainsByStudentId = useMemo(
    () => new Map(
      (studentsState.data?.students ?? []).map((student) => [student.id, student.domains])
    ),
    [studentsState.data]
  );
  // Which subjects the current recipient selection can receive. Student mode
  // is the intersection of every selected student's bound subjects; class mode
  // is the acting teacher's own subject set for the class. An empty selection
  // does not restrict yet.
  const availableSubjects = useMemo<AssignmentSubject[]>(() => {
    if (selectionMode === "class") {
      return selectedClass
        ? assignmentSubjectsForClassSubjects(selectedClass.subjects)
        : [...ASSIGNMENT_SUBJECTS];
    }
    if (!studentsState.data || selectedStudents.length === 0) {
      return [...ASSIGNMENT_SUBJECTS];
    }
    return assignmentSubjectsForStudents(
      selectedStudents.map((studentId) => ({
        domains: domainsByStudentId.get(studentId) ?? []
      }))
    );
  }, [
    domainsByStudentId,
    selectedClass,
    selectedStudents,
    selectionMode,
    studentsState.data
  ]);
  const selectionSubjectsReady = selectionMode === "class"
    ? classesState.data !== null
    : studentsState.data !== null;
  const recipientSelected = selectionMode === "class"
    ? Boolean(selectedClassId)
    : selectedStudents.length > 0;
  const currentSubjectAvailable = !subject || availableSubjects.includes(subject);
  // Data arriving after mount can reveal that a seeded / draft subject is no
  // longer valid for the selected recipients. Content is never cleared here:
  // the teacher sees a blocking message and decides. A selection change made
  // by the teacher goes through confirmSelectionChange instead.
  useEffect(() => {
    if (!selectionSubjectsReady || !subject) return;
    if (availableSubjects.includes(subject)) return;
    const hasContent = (standardEnabled && (selection.size > 0 || customQuestions.length > 0))
      || (categoryEnabled && categoryRows.length > 0);
    if (hasContent) {
      setSubmitError("当前科目对所选学生／班级不可用，请重新选择科目或调整对象。");
      return;
    }
    setSubject(null);
    setStandardEnabled(true);
    setCategoryEnabled(false);
    setCategoryRows([]);
    setSource(null);
    setSelection(new Map());
    setCustomQuestions([]);
    setPickerState(defaultAssignmentPickerState("writing"));
    setSubmitError("当前科目对所选学生／班级不可用，请重新选择科目。");
  }, [availableSubjects, categoryEnabled, categoryRows.length, customQuestions.length, selection.size, selectionSubjectsReady, standardEnabled, subject]);
  // Practice badges are only requested for the catalog the teacher is actually
  // looking at, and always after a recipient selection exists.
  const practiceStatus = useAssignmentPracticeStatus({
    classId: selectionMode === "class" ? selectedClassId : "",
    enabled: Boolean(subject)
      && currentSubjectAvailable
      && standardEnabled
      && (subject === "reading" || source === "question_bank"),
    studentIds: selectionMode === "students" ? selectedStudents : [],
    subject
  });
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
    // Step 2 (subject) now comes after the recipient selection: no automatic
    // title exists before a subject is chosen.
    if (!subject) return "";
    // A withdrawn edit keeps the assignment's own 布置日期 in the automatic
    // title; a fresh create uses today.
    const titleAssignedAt = assignmentTitleDate;
    // While the student / class lists are still loading, the seed's own name
    // part keeps the automatic title stable and lets 写作 → 阅读 update in place.
    const seedTitleBase = editing
      ? seededAssignmentTitleBase({
          assignedAt: seed.titleAssignedAt,
          className: seed.className,
          firstStudentName: seed.firstStudentName,
          studentCount: seed.studentCount,
          subject
        })
      : "";
    if (selectionMode === "class") {
      return selectedClass
        ? classAssignmentTitleBase(selectedClass.name, titleAssignedAt, subject)
        : seedTitleBase;
    }
    const firstStudent = (studentsState.data?.students ?? []).find(
      (student) => student.id === selectedStudents[0]
    );
    if (!firstStudent) return seedTitleBase;
    return defaultWritingAssignmentTitle({
      assignedAt: titleAssignedAt,
      firstStudentName: firstStudent.displayName,
      studentCount: selectedStudents.length,
      subject
    });
  }, [assignmentTitleDate, editing, seed.className, seed.firstStudentName, seed.studentCount, seed.titleAssignedAt, selectionMode, selectedClass, selectedStudents, studentsState.data, subject]);
  useEffect(() => {
    if (assignmentTitleManuallyEdited) return;
    setAssignmentTitle(generatedAssignmentTitle);
  }, [assignmentTitleManuallyEdited, generatedAssignmentTitle]);
  // Live candidate only: the titles index fed by the loaded assignment pages
  // tells us which base titles exist, without any new request. The RPC still
  // resolves the final number authoritatively at creation time. The group
  // being edited never counts against itself, so an unchanged automatic title
  // stays exactly its own base instead of gaining a new (n).
  const cachedTitlesEntry = cache.getEntry(TEACHER_WRITING_ASSIGNMENT_TITLES_CACHE_KEY);
  const cachedListEntry = cache.getEntry(TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY);
  const cachedGroups =
    cachedTitlesEntry?.status === "success" || cachedTitlesEntry?.status === "refreshing"
      ? (cachedTitlesEntry.data as { groups?: unknown }).groups
      : null;
  const existingGroupTitles = Array.isArray(cachedGroups)
    ? cachedGroups.flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const group = value as { group_id?: unknown; title?: unknown };
        if (typeof group.group_id !== "string" || typeof group.title !== "string") return [];
        if (initialGroupId && group.group_id === initialGroupId) return [];
        return [group.title];
      })
    : cachedListEntry?.status === "success" || cachedListEntry?.status === "refreshing"
      ? ((cachedListEntry.data as { assignments?: WritingAssignmentSummary[] }).assignments ?? [])
        .flatMap((assignment) => {
          if (!assignment.group_id || !assignment.group_title?.trim()) return [];
          if (initialGroupId && assignment.group_id === initialGroupId) return [];
          return [assignment.group_title];
        })
      : [];
  const candidateAssignmentTitle = assignmentTitleManuallyEdited
    ? assignmentTitle
    : nextWritingAssignmentAutoTitle(generatedAssignmentTitle, existingGroupTitles);
  const selectedBankEntries = useMemo(
    () => Array.from(selection.values()),
    [selection]
  );
  // One Assignment Group is single-subject, so everything outside the current
  // subject is never submitted (and is soft-deleted by the RPC when the group
  // switched subjects). Create mode keeps the historical single-source rule.
  const subjectBankEntries = useMemo(
    () => selectedBankEntries.filter(
      (entry) => assignmentItemSubject(entry.item_type) === assignmentSubject
    ),
    [assignmentSubject, selectedBankEntries]
  );
  const subjectCustomQuestions = useMemo(
    () => assignmentSubject === "writing"
      ? customQuestions.filter((draft) => isWritingReviewItemType(draft.taskType))
      : [],
    [assignmentSubject, customQuestions]
  );
  const submitBankEntries = useMemo(
    () => standardEnabled && (editing || assignmentSubject === "reading" || source === "question_bank")
      ? subjectBankEntries
      : [],
    [assignmentSubject, editing, source, standardEnabled, subjectBankEntries]
  );
  const submitCustomQuestions = useMemo(
    () => standardEnabled && (editing || (assignmentSubject === "writing" && source === "custom"))
      ? subjectCustomQuestions
      : [],
    [assignmentSubject, editing, source, standardEnabled, subjectCustomQuestions]
  );
  const previewItems = useMemo(() => {
    const bankItems = submitBankEntries.map((entry) => ({
      key: assignmentCatalogEntryKey(entry),
      label: entry.title
    }));
    const customItems = submitCustomQuestions.flatMap((draft) => {
      try {
        return [{
          key: draft.clientId,
          label: String(draft.fields.title ?? "").trim()
            || buildCustomWritingQuestionSnapshot({
              taskType: draft.taskType,
              fields: draft.fields,
              id: draft.clientId
            }).set_title
        }];
      } catch {
        return [];
      }
    });
    const categoryItems = categoryEnabled && categoryValidation.ok
      ? [{
          key: "category-assignment",
          label: `${activeCategoryKind === "bas_category" ? "BAS 语法分类" : "RAP 题型分类"} · ${categorySummary}（${categoryTotal}题）`
        }]
      : [];
    return [...bankItems, ...customItems, ...categoryItems];
  }, [activeCategoryKind, categoryEnabled, categorySummary, categoryTotal, categoryValidation.ok, submitBankEntries, submitCustomQuestions]);
  const customPreviewCards = useMemo(
    () => submitCustomQuestions.flatMap((draft, index) => {
      try {
        return [{
          index: submitBankEntries.length + index + 1,
          key: draft.clientId,
          question: buildCustomWritingQuestionSnapshot({
            taskType: draft.taskType,
            fields: draft.fields,
            id: draft.clientId
          }),
          taskType: draft.taskType
        }];
      } catch {
        return [];
      }
    }),
    [submitBankEntries.length, submitCustomQuestions]
  );
  const standardItemCount = submitBankEntries.length + submitCustomQuestions.length;
  const assignmentCount = standardItemCount
    + (categoryEnabled && categoryValidation.ok ? 1 : 0);
  const stepNumbers = useMemo(() => {
    const order: Array<"kind" | "source" | "items" | "title" | "due" | "preview"> = [
      "kind",
      ...(subject === "writing" && standardEnabled ? ["source" as const] : []),
      "items",
      "title",
      "due",
      "preview"
    ];
    // 1 = 学生／班级, 2 = 科目, then this order.
    return new Map(order.map((key, index) => [key, String(index + 3)]));
  }, [standardEnabled, subject]);
  const visibleCustomQuestions = useMemo(
    () => source === "custom"
      ? customQuestions.filter((draft) => draft.taskType === customTaskType)
      : [],
    [customQuestions, customTaskType, source]
  );

  function chooseSubject(next: AssignmentSubject) {
    if (subject === next) return;
    if (!availableSubjects.includes(next)) {
      setSubmitError(
        availableSubjects.length === 0
          ? NO_COMMON_ASSIGNMENT_SUBJECT_MESSAGE
          : "当前学生／班级没有该科目的授课权限，请选择其他科目。"
      );
      return;
    }
    // One Assignment Group is single-subject. Switching the subject of a
    // withdrawn group re-targets the whole group, so an existing selection must
    // be cleared first — never after the fact. Cancel keeps the subject, the
    // selection, the filters and the whole wizard state exactly as they were.
    const hasItems = hasSubjectDependentContent();
    if (hasItems) {
      const message = subject === "writing"
        ? "已选择写作题目，切换到阅读会清空已选题目。是否切换？"
        : "已选择阅读题目，切换到写作会清空已选题目。是否切换？";
      if (!window.confirm(message)) return;
    }
    setSubject(next);
    setStandardEnabled(true);
    setCategoryEnabled(false);
    setCategoryRows([]);
    setSource(next === "reading" ? "question_bank" : null);
    setSelection(new Map());
    setCustomQuestions([]);
    setPickerState(defaultAssignmentPickerState(next));
    setSubmitError("");
  }

  /**
   * 普通题目 and 分类练习 are two independent contents of one batch. Toggling
   * one never clears the other: the unselected side simply is not submitted.
   */
  function toggleAssignmentKind(next: "standard" | "category") {
    if (next === "standard") {
      setStandardEnabled((current) => !current);
    } else {
      setCategoryEnabled((current) => !current);
    }
    setSubmitError("");
  }

  function chooseSource(next: WritingAssignmentQuestionSource) {
    if (source === next) return;
    setSource(next);
    setSubmitError("");
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

  function subjectsForStudents(nextStudents: readonly string[]) {
    if (!studentsState.data || nextStudents.length === 0) return [...ASSIGNMENT_SUBJECTS];
    return assignmentSubjectsForStudents(
      nextStudents.map((studentId) => ({
        domains: domainsByStudentId.get(studentId) ?? []
      }))
    );
  }

  function subjectsForClass(classId: string) {
    const classEntry = allClasses.find((entry) => entry.class_id === classId);
    return classEntry
      ? assignmentSubjectsForClassSubjects(classEntry.subjects)
      : [...ASSIGNMENT_SUBJECTS];
  }

  function hasSubjectDependentContent() {
    return (standardEnabled && (selection.size > 0 || customQuestions.length > 0))
      || (categoryEnabled && categoryRows.length > 0);
  }

  /** The only place that clears the invalid subject and its own content. */
  function clearInvalidSubjectState() {
    setSubject(null);
    setStandardEnabled(true);
    setCategoryEnabled(false);
    setCategoryRows([]);
    setSource(null);
    setSelection(new Map());
    setCustomQuestions([]);
    setPickerState(defaultAssignmentPickerState("writing"));
    setSubmitError("当前科目对所选学生／班级不可用，请重新选择科目。");
  }

  /**
   * A student / class change that invalidates the current subject must never
   * silently discard teacher-entered content. The selection change is cancelled
   * when the teacher declines, so the wizard stays exactly as it was.
   */
  function confirmSelectionChange(nextSubjects: readonly AssignmentSubject[], label: string) {
    if (!subject || !selectionSubjectsReady) return true;
    if (nextSubjects.includes(subject)) return true;
    if (!hasSubjectDependentContent()) return true;
    return window.confirm(
      `调整${label}后，当前科目「${ASSIGNMENT_SUBJECT_LABELS[subject]}」不可用，已选题目和自定义题将被清空。是否继续？`
    );
  }

  function toggleStudent(studentId: string) {
    const nextStudents = selectedStudents.includes(studentId)
      ? selectedStudents.filter((id) => id !== studentId)
      : [...selectedStudents, studentId];
    const nextSubjects = subjectsForStudents(nextStudents);
    if (!confirmSelectionChange(nextSubjects, "学生选择")) return;
    const invalidatesSubject = Boolean(subject) && !nextSubjects.includes(subject!);
    if (invalidatesSubject) clearInvalidSubjectState();
    setSelectedStudents(nextStudents);
    if (!subject || invalidatesSubject) return;
    const firstStudent = (studentsState.data?.students ?? []).find(
      (student) => student.id === nextStudents[0]
    );
    const nextTitle = firstStudent
      ? defaultWritingAssignmentTitle({
          assignedAt: assignmentTitleDate,
          firstStudentName: firstStudent.displayName,
          studentCount: nextStudents.length,
          subject
        })
      : "";
    setCustomQuestions((current) => current.map((draft) => draft.titleManuallyEdited
      ? draft
      : { ...draft, fields: { ...draft.fields, title: nextTitle } }));
  }

  function chooseSelectionMode(next: "students" | "class") {
    if (selectionMode === next) return;
    // The new mode starts with no recipient, so the current subject stays
    // valid until a class / student makes it impossible.
    setSelectionMode(next);
    // The two modes are mutually exclusive: switching never leaves a hidden
    // selection from the other mode behind.
    if (next === "class") setSelectedStudents([]);
    else setSelectedClassId("");
    setSubmitError("");
  }

  function toggleClass(classId: string) {
    const next = selectedClassId === classId ? "" : classId;
    const nextSubjects = subjectsForClass(next);
    if (!confirmSelectionChange(nextSubjects, "班级选择")) return;
    const invalidatesSubject = Boolean(subject) && Boolean(next) && !nextSubjects.includes(subject!);
    if (invalidatesSubject) clearInvalidSubjectState();
    setSelectedClassId(next);
    if (!subject || invalidatesSubject) return;
    const classEntry = allClasses.find((entry) => entry.class_id === next);
    const nextTitle = classEntry
      ? classAssignmentTitleBase(classEntry.name, assignmentTitleDate, subject)
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

  function buildCustomDraftPatch(draft: CustomQuestionDraft) {
    if (draft.taskType === "email" && customEmailRequirementCount(draft) !== 3) {
      throw new Error("每篇 Email 必须准确识别或补充 3 条要求。");
    }
    buildCustomWritingQuestionSnapshot({
      taskType: draft.taskType,
      fields: draft.fields,
      id: "validation"
    });
    return {
      ...(draft.assignmentId ? { assignmentId: draft.assignmentId } : {}),
      customQuestion: draft.fields,
      dueAt: dueAtFor(draft.clientId),
      itemType: draft.taskType,
      questionId: null,
      questionSource: "custom" as const
    };
  }

  async function submit(reactivate = false) {
    setSubmitError("");
    if (!subject) return setSubmitError("请先选择科目。");
    if (!availableSubjects.includes(subject)) {
      return setSubmitError(
        availableSubjects.length === 0
          ? NO_COMMON_ASSIGNMENT_SUBJECT_MESSAGE
          : "当前科目对所选学生／班级不可用，请重新选择科目。"
      );
    }
    if (!standardEnabled && !categoryEnabled) {
      return setSubmitError("请至少选择普通题目或分类练习中的一种内容。");
    }
    if (categoryEnabled) {
      if (!categoryValidation.ok) return setSubmitError(categoryValidation.error);
      if (categoryOptionsState.loading) return setSubmitError("分类题库正在加载，请稍候。");
      if (categoryOptionsState.error) return setSubmitError(categoryOptionsState.error);
      const unavailable = categoryRows.find((row) => {
        const option = categoryOptions.find((item) => item.category === row.category);
        return !option || row.count > option.count;
      });
      if (unavailable) {
        const option = categoryOptions.find((item) => item.category === unavailable.category);
        return setSubmitError(
          option
            ? `分类「${unavailable.category}」题库仅有 ${option.count} 题，无法满足设置的 ${unavailable.count} 题。`
            : `分类「${unavailable.category}」当前不可用，请重新选择。`
        );
      }
    }
    if (standardEnabled) {
      if (subject === "writing" && !source) return setSubmitError("请选择题目来源。");
      if (standardItemCount < 1 && !categoryEnabled) {
        return setSubmitError("请至少选择或添加一道题目。");
      }
    }
    if (selectionMode === "class") {
      if (!selectedClassId) return setSubmitError("请选择班级。");
    } else if (!selectedStudents.length) {
      return setSubmitError("请至少选择一名学生。");
    }

    let items: Array<Record<string, unknown>>;
    try {
      items = [
        ...(standardEnabled
          ? [
              ...submitBankEntries.map((entry) => ({
                ...(seededAssignmentIds.get(assignmentCatalogEntryKey(entry))
                  ? { assignmentId: seededAssignmentIds.get(assignmentCatalogEntryKey(entry)) }
                  : {}),
                dueAt: dueAtFor(assignmentCatalogEntryKey(entry)),
                itemType: entry.item_type,
                questionId: entry.item_id,
                questionSource: "question_bank" as const
              })),
              ...submitCustomQuestions.map((draft) => buildCustomDraftPatch(draft))
            ]
          : []),
        ...(categoryEnabled
          ? [{
              ...(seededCategoryAssignmentId
                ? { assignmentId: seededCategoryAssignmentId }
                : {}),
              categories: categoryValidation.ok ? categoryValidation.rows : [],
              dueAt: dueAtFor("category-assignment"),
              itemType: activeCategoryKind
            }]
          : [])
      ];
    } catch (error) {
      return setSubmitError(error instanceof Error ? error.message : "请完整填写每道题目。");
    }

    // Automatic titles submit the base title on create (the RPC resolves the
    // final sequence); a withdrawn edit already shows the resolved candidate
    // and persists exactly it. A manual title is always submitted verbatim.
    const title = assignmentTitleManuallyEdited
      ? assignmentTitle.trim()
      : (editing ? candidateAssignmentTitle.trim() : assignmentTitle.trim() || generatedAssignmentTitle);
    if (!title) return setSubmitError("请填写作业标题。");

    setSubmitting(true);
    try {
      if (editing) {
        const first = initialAssignments[0];
        const payload = await teacherApiFetch<{ assignmentId?: string; assignmentIds?: string[] }>(
          initialGroupId
            ? `/api/teacher/writing/assignments/batches/${encodeURIComponent(initialGroupId)}`
            : `/api/teacher/writing/assignments/${encodeURIComponent(first.assignment_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              action: "edit",
              ...(selectionMode === "class"
                ? { classId: selectedClassId }
                : { studentIds: selectedStudents }),
              dueAt: uniformDueAt ? new Date(uniformDueAt).toISOString() : null,
              items,
              reactivate,
              title
            })
          }
        );
        cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
        publishCacheInvalidation({
          type: "ASSIGNMENT_UPDATED",
          assignmentId: payload.assignmentId ?? first.assignment_id,
          assignmentQuestionSource: source ?? "question_bank"
        });
        router.push(teacherReturnToHref(
          initialGroupId
            ? teacherAssignmentBatchDetailHref(initialGroupId)
            : teacherAssignmentDetailHref(first.assignment_id),
          returnTo
        ));
        router.refresh();
        return;
      }
      const payload = await teacherApiFetch<{ assignmentId: string; assignmentIds: string[]; title?: string }>(
        "/api/teacher/writing/assignments",
        {
          method: "POST",
          body: JSON.stringify(
            selectionMode === "class"
              ? {
                  assignments: items,
                  classId: selectedClassId,
                  subject,
                  title,
                  titleIsAutomatic: !assignmentTitleManuallyEdited
                }
              : {
                  assignments: items,
                  studentIds: selectedStudents,
                  subject,
                  title,
                  titleIsAutomatic: !assignmentTitleManuallyEdited
                }
          )
        }
      );
      writeAssignmentDraft(null);
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      for (const assignmentId of payload.assignmentIds) {
        publishCacheInvalidation({
          type: "ASSIGNMENT_UPDATED",
          assignmentId,
          assignmentQuestionSource: source ?? "question_bank"
        });
      }
      router.push(
        selectionMode === "class"
          ? `/teacher/writing/assignments?view=class&classId=${encodeURIComponent(selectedClassId)}`
          : "/teacher/writing/assignments"
      );
      router.refresh();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "作业创建失败。");
      setSubmitting(false);
    }
  }

  const assignmentKeys = [
    ...(standardEnabled
      ? [
          ...submitBankEntries.map((entry) => ({
            key: assignmentCatalogEntryKey(entry),
            label: entry.title
          })),
          ...submitCustomQuestions.map((draft, index) => ({
            key: draft.clientId,
            label: String(draft.fields.title ?? "").trim() || `第 ${index + 1} 篇`
          }))
        ]
      : []),
    ...(categoryEnabled
      ? [{
          key: "category-assignment",
          label: categorySummary || (activeCategoryKind === "bas_category"
            ? "BAS 语法分类作业"
            : "RAP 题型分类作业")
        }]
      : [])
  ];
  const assignmentUnit = standardEnabled && categoryEnabled
    ? "项"
    : categoryEnabled
      ? "份分类练习"
      : "篇题目";
  return (
    <div className="grid gap-5">
      <StepCard number="1" title="选择学生／班级">
        {allClasses.length > 0 ? (
          <nav aria-label="选择方式" className="mb-4 flex gap-2 border-b border-student-border">
            <button
              className={`border-b-2 px-5 py-3 text-sm font-bold ${selectionMode === "students" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
              onClick={() => chooseSelectionMode("students")}
              type="button"
            >
              学生
            </button>
            <button
              className={`border-b-2 px-5 py-3 text-sm font-bold ${selectionMode === "class" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
              onClick={() => chooseSelectionMode("class")}
              type="button"
            >
              班级
            </button>
          </nav>
        ) : null}
        {selectionMode === "class" ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative min-w-[240px] flex-1"><Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} /><input className="teacher-input w-full pl-9" onChange={(event) => setClassQuery(event.target.value)} placeholder="搜索班级名称" value={classQuery} /></div>
              <span className="text-sm font-bold text-student-primary">一次只能选择一个班级</span>
            </div>
            {classesState.loading ? <TeacherSkeleton className="h-40 w-full rounded-xl" /> : classesState.error ? <TeacherDataError text={classesState.error} /> : <div className="max-h-72 overflow-y-auto rounded-xl border border-student-border"><div className="grid gap-px bg-student-border">{filteredClasses.map((entry) => { const active = selectedClassId === entry.class_id; return <button className={`flex items-center gap-3 bg-white px-4 py-3 text-left transition hover:bg-student-bg ${active ? "!bg-student-primary-soft" : ""}`} key={entry.class_id} onClick={() => toggleClass(entry.class_id)} type="button"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-student-primary"><TeacherClassIcon aria-hidden="true" size={18} strokeWidth={1.9} /></span><span className="min-w-0 flex-1"><span className="block font-semibold text-student-text">{entry.name}</span><span className="block truncate text-xs text-student-muted">{classSubjectsLabel(entry.subjects)} · {entry.member_count} 名学生</span></span>{active ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</button>; })}{!filteredClasses.length ? <p className="bg-white px-4 py-8 text-center text-sm text-student-muted">没有匹配的班级。</p> : null}</div></div>}
            <p className="text-xs text-student-muted">班级作业按保存时的班级成员生成，之后加入的学生不会补收这次作业。</p>
          </div>
        ) : (
        <div className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[240px] flex-1"><Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} /><input className="teacher-input w-full pl-9" onChange={(event) => setStudentQuery(event.target.value)} placeholder="搜索中文姓名、拼音或账号" value={studentQuery} /></div><span className="text-sm font-bold text-student-primary">已选择 {selectedStudents.length} 人</span></div>
          {studentsState.loading ? <TeacherSkeleton className="h-40 w-full rounded-xl" /> : studentsState.error ? <TeacherDataError text={studentsState.error} /> : <div className="max-h-72 overflow-y-auto rounded-xl border border-student-border"><div className="grid gap-px bg-student-border">{filteredStudents.map((student) => { const active = selectedStudents.includes(student.id); return <button className={`flex items-center gap-3 bg-white px-4 py-3 text-left transition hover:bg-student-bg ${active ? "!bg-student-primary-soft" : ""}`} key={student.id} onClick={() => toggleStudent(student.id)} type="button"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-student-primary"><UserRound aria-hidden="true" size={18} /></span><span className="min-w-0 flex-1"><span className="block font-semibold text-student-text">{formatManagedAccountName(student.displayName, student.email)}</span><span className="block truncate text-xs text-student-muted">账号：{formatAccountForDisplay(student.email)} · 科目：{classSubjectsLabel(student.domains)}</span></span>{active ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</button>; })}{!filteredStudents.length ? <p className="bg-white px-4 py-8 text-center text-sm text-student-muted">没有匹配的学生。</p> : null}</div></div>}
        </div>
        )}
      </StepCard>

      <StepCard number="2" title="选择科目">
        {selectionMode === "students" && selectedStudents.length === 0 ? (
          <p className="text-sm text-student-muted">请先选择学生；可选科目会按所有已选学生共同拥有的授课科目限制。</p>
        ) : selectionMode === "class" && !selectedClass ? (
          <p className="text-sm text-student-muted">请先选择一个班级；可选科目会按当前教师在该班级负责的授课科目限制。</p>
        ) : null}
        {availableSubjects.length === 0 ? (
          <p className="text-sm font-medium text-student-error">{NO_COMMON_ASSIGNMENT_SUBJECT_MESSAGE}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {availableSubjects.map((entry) => (
              <ChoiceButton
                active={subject === entry}
                disabled={!recipientSelected}
                key={entry}
                label={ASSIGNMENT_SUBJECT_LABELS[entry]}
                onClick={() => chooseSubject(entry)}
              />
            ))}
          </div>
        )}
        {!currentSubjectAvailable && subject ? (
          <p className="text-sm font-medium text-student-error">
            当前科目「{ASSIGNMENT_SUBJECT_LABELS[subject]}」对所选学生／班级不可用，请重新选择科目。
          </p>
        ) : null}
      </StepCard>

      {subject ? (
        <StepCard number={stepNumbers.get("kind")!} title="选择作业内容">
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceButton active={standardEnabled} label="普通题目作业" onClick={() => toggleAssignmentKind("standard")} />
            <ChoiceButton
              active={categoryEnabled}
              label={assignmentSubject === "writing" ? "BAS 语法分类作业" : "RAP 题型分类作业"}
              onClick={() => toggleAssignmentKind("category")}
            />
          </div>
        </StepCard>
      ) : null}

      {standardEnabled && subject === "writing" ? (
        <StepCard number={stepNumbers.get("source")!} title="选择题目来源">
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceButton active={source === "question_bank"} label="从题库选择" onClick={() => chooseSource("question_bank")} />
            <ChoiceButton active={source === "custom"} label="自定义题目" onClick={() => chooseSource("custom")} />
          </div>
          {editing ? <p className="text-xs text-student-muted">编辑已撤回作业时，切换到另一种来源也不会丢弃另一边的题目。</p> : null}
          {editing && source === "question_bank" && customQuestions.length > 0 ? <p className="text-xs text-student-muted">本组还有 {customQuestions.length} 篇自定义题，切换到「自定义题目」可继续编辑；保存时会一起保留。</p> : null}
          {editing && source === "custom" && selection.size > 0 ? <p className="text-xs text-student-muted">本组还有 {selection.size} 篇题库题目，切换到「从题库选择」可继续调整；保存时会一起保留。</p> : null}
        </StepCard>
      ) : null}

      <StepCard
        number={stepNumbers.get("items")!}
        title={
          standardEnabled && categoryEnabled
            ? "选择题目与配置分类"
            : categoryEnabled
              ? "配置分类与题量"
              : source === "custom"
                ? "填写自定义题"
                : "选择题目"
        }
      >
        {!subject ? (
          <p className="text-sm text-student-muted">请先选择科目。</p>
        ) : (
          <div className="grid gap-5">
            {standardEnabled ? (
              subject === "writing" && !source ? (
                <p className="text-sm text-student-muted">请先选择题目来源。</p>
              ) : source === "custom" ? (
                <div className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">{(["email", "academic_discussion"] as const).map((type) => <ChoiceButton active={customTaskType === type} key={type} label={WRITING_TASK_CONFIG[type].label} onClick={() => setCustomTaskType(type)} />)}</div>{visibleCustomQuestions.map((draft, index) => <CustomQuestionDraftCard disabled={false} draft={draft} index={index} key={draft.clientId} onAvatarChange={(field, value) => chooseDraftAvatar(draft.clientId, field, value)} onChange={(field, value) => updateDraftField(draft.clientId, field, value)} onPromptChange={(value) => updateEmailPrompt(draft.clientId, value)} onRemove={() => setCustomQuestions((current) => current.filter((item) => item.clientId !== draft.clientId))} onToggle={() => updateCustomQuestion(draft.clientId, (current) => ({ ...current, expanded: !current.expanded }))} taskType={draft.taskType} />)}<button className="teacher-button-secondary justify-self-start" onClick={() => setCustomQuestions((current) => [...current, createCustomQuestionDraft(customTaskType, generatedAssignmentTitle)])} type="button"><Plus aria-hidden="true" size={16} />添加一篇</button></div>
              ) : (
                <TeacherAssignmentCatalogPicker
                  onSelectionChange={setSelection}
                  onStateChange={setPickerState}
                  practiceError={practiceStatus.error}
                  practiceLoading={practiceStatus.loading}
                  practiceStatuses={practiceStatus.statuses}
                  selection={selection}
                  state={pickerState}
                  subject={subject}
                />
              )
            ) : null}
            {categoryEnabled ? (
              <div className={standardEnabled ? "border-t border-student-border pt-5" : ""}>
                <p className="mb-3 text-sm font-bold text-student-text">
                  {assignmentSubject === "writing" ? "BAS 语法分类练习" : "RAP 题型分类练习"}
                </p>
                <TeacherCategoryAssignmentConfig
                  error={categoryOptionsState.error}
                  itemType={activeCategoryKind}
                  loading={categoryOptionsState.loading}
                  onChange={setCategoryRows}
                  options={categoryOptions}
                  rows={categoryRows}
                />
              </div>
            ) : null}
          </div>
        )}
      </StepCard>

      <StepCard number={stepNumbers.get("title")!} title="作业标题">
        <div className="grid gap-2"><input className="teacher-input max-w-xl" onChange={(event) => { setAssignmentTitleManuallyEdited(true); setAssignmentTitle(event.target.value); }} placeholder="选择学生并设置科目后自动生成" value={candidateAssignmentTitle} /></div>
      </StepCard>

      <StepCard number={stepNumbers.get("due")!} title="截止时间">
        {editing ? (
          <div className="grid gap-3">
            <label className="grid max-w-sm gap-2 text-sm font-semibold text-student-text">截止时间（整组统一，可不填）<input className="teacher-input" onChange={(event) => setUniformDueAt(event.target.value)} type="datetime-local" value={uniformDueAt} /></label>
            <p className="text-xs text-student-muted">留空表示不设置截止时间；修改后会应用到整组题目。</p>
          </div>
        ) : (
        <div className="grid gap-3"><div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={deadlineMode === "uniform"} name="deadline-mode" onChange={() => setDeadlineMode("uniform")} type="radio" />统一截止时间</label><label className="flex items-center gap-2 text-sm font-semibold text-student-text"><input checked={deadlineMode === "individual"} name="deadline-mode" onChange={() => setDeadlineMode("individual")} type="radio" />分别设置</label></div>{deadlineMode === "uniform" ? <label className="grid max-w-sm gap-2 text-sm font-semibold text-student-text">截止时间（可不填）<input className="teacher-input" onChange={(event) => setUniformDueAt(event.target.value)} type="datetime-local" value={uniformDueAt} /></label> : <div className="grid gap-3">{assignmentKeys.map((item) => <label className="grid gap-2 text-sm font-semibold text-student-text sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center" key={item.key}><span className="truncate">{item.label}</span><input className="teacher-input" onChange={(event) => setIndividualDueAt((current) => ({ ...current, [item.key]: event.target.value }))} type="datetime-local" value={individualDueAt[item.key] ?? ""} /></label>)}</div>}</div>
        )}
      </StepCard>

      <StepCard number={stepNumbers.get("preview")!} title="题目预览">
        {previewItems.length ? (
          <div className="grid gap-5">
            <TeacherAssignmentSelectionPreview items={previewItems} />
            {customPreviewCards.length ? (
              <div className="grid gap-4">
                <TeacherSectionTitle>自定义题预览</TeacherSectionTitle>
                {customPreviewCards.map((item) => <div className="grid gap-2" key={item.key}><p className="text-sm font-bold text-student-text">第 {item.index} 篇 · {WRITING_TASK_CONFIG[item.taskType].label}</p><WritingAssignmentQuestionPreview question={item.question} questionSource="custom" taskType={item.taskType} /></div>)}
              </div>
            ) : null}
          </div>
        ) : <p className="text-sm text-student-muted">完成题目选择或填写后，这里会显示题目列表。</p>}
      </StepCard>

      <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-5"><div><p className="font-bold text-student-text">{editing ? "保存作业修改" : "确认布置"}</p><p className="mt-1 text-sm text-student-muted">{editing ? `${selectionMode === "class" && selectedClass ? `将整组 ${assignmentCount} ${assignmentUnit}重新布置给「${selectedClass.name}」的 ${selectedClass.member_count} 名学生。` : `将整组 ${assignmentCount} ${assignmentUnit}重新布置给已选择的 ${selectedStudents.length} 名学生。`}` : selectionMode === "class" && selectedClass ? `将 ${assignmentCount} ${assignmentUnit}布置给「${selectedClass.name}」的 ${selectedClass.member_count} 名学生，并保存同一个作业组。` : `将 ${assignmentCount} ${assignmentUnit}布置给已选择的 ${selectedStudents.length} 名学生，并保存同一个作业组。`}</p></div><div className="flex flex-col items-end gap-2">{submitError ? <p className="text-sm font-medium text-student-error">{submitError}</p> : null}<div className="flex flex-wrap justify-end gap-2">{editing ? <button className="teacher-button-secondary" disabled={submitting} onClick={() => void submit(false)} type="button">{submitting ? "正在保存…" : "保存修改"}</button> : null}<button className="teacher-button-primary" disabled={submitting} onClick={() => void submit(editing)} type="button">{submitting ? (editing ? "正在保存…" : "正在布置…") : (editing ? "保存并重新布置" : "布置")}</button></div></div></TeacherCard>
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
    taskType,
    titleManuallyEdited: false,
    toManuallyEdited: false
  };
}

function customEmailRequirementCount(draft: CustomQuestionDraft) {
  if (!draft.requirementsManuallyEdited) return draft.parsedRequirementCount;
  const values = stringDraftFields(draft.fields);
  return [1, 2, 3].filter((number) => values[`requirement_${number}`]?.trim()).length;
}

export function stringDraftFields(fields: Record<string, string | boolean>) {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function StepCard({ children, number, title }: { children: React.ReactNode; number: string; title: string }) {
  return <TeacherCard className="grid gap-4 p-5"><div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-student-primary text-sm font-bold text-white">{number}</span><TeacherSectionTitle>{title}</TeacherSectionTitle></div>{children}</TeacherCard>;
}

export function ChoiceButton({ active, disabled, label, onClick }: { active: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return <button className={`flex min-h-14 items-center justify-between rounded-xl border px-4 text-left font-semibold transition ${active ? "border-student-primary bg-student-primary-soft text-student-primary" : "border-student-border bg-white text-student-text hover:border-student-primary-border"}`} disabled={disabled} onClick={onClick} type="button"><span>{label}</span>{active ? <Check aria-hidden="true" size={18} /> : null}</button>;
}

export function CustomQuestionFields({ disabled, fields, onAvatarChange, onBlur, onChange, values }: { disabled?: boolean; fields: ReadonlyArray<readonly [string, string]>; onAvatarChange: (field: string, value: string) => void; onBlur: (field: string) => void; onChange: (field: string, value: string) => void; values: Record<string, string> }) {
  return <div className="grid gap-4">{fields.map(([field, label]) => {
    const avatarField = AVATAR_FIELD_BY_NAME[field as keyof typeof AVATAR_FIELD_BY_NAME];
    return <div className="grid gap-2" key={field}><label className="grid gap-2 text-sm font-semibold text-student-text">{label}{field === "requirements" ? <><span className="text-xs font-normal text-student-muted">每个要点一行</span><textarea className="teacher-input min-h-36 resize-y" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} placeholder={"Explain why...\nAsk for...\nMention..."} value={values[field] ?? ""} /></> : field.includes("name") || field === "title" || field === "recipient" || field === "subject" ? <input className="teacher-input" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} value={values[field] ?? ""} /> : <textarea className="teacher-input min-h-24 resize-y" disabled={disabled} onBlur={() => onBlur(field)} onChange={(event) => onChange(field, event.target.value)} value={values[field] ?? ""} />}</label>{avatarField ? <CustomAvatarPicker avatarField={avatarField} disabled={disabled} onChange={onAvatarChange} value={values[avatarField] ?? ""} /> : null}</div>;
  })}</div>;
}

export function CustomAvatarPicker({ avatarField, disabled, onChange, value }: { avatarField: (typeof AVATAR_FIELD_BY_NAME)[keyof typeof AVATAR_FIELD_BY_NAME]; disabled?: boolean; onChange: (field: string, value: string) => void; value: string }) {
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

export function QuestionResults({ onPage, onSelect, payload, selectedId, taskType }: { onPage: (page: number) => void; onSelect: (question: WritingQuestion) => void; payload: QuestionSearchPayload; selectedId: string | null; taskType: WritingTaskType }) {
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  return <div className="grid gap-3"><div className="grid gap-2">{payload.questions.map((question) => { const selected = question.question_id === selectedId; return <button className={`rounded-xl border p-4 text-left transition ${selected ? "border-student-primary bg-student-primary-soft" : "border-student-border hover:border-student-primary-border"}`} key={question.logical_item_id} onClick={() => onSelect(question)} type="button"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[taskType].label}</p><p className="mt-1 font-bold text-student-text">{question.logical_display_name}</p></div>{selected ? <Check aria-hidden="true" className="text-student-primary" size={19} /> : null}</div><p className="mt-2 line-clamp-2 text-sm text-student-muted">{"scenario" in question ? `${question.scenario} ${question.requirement_1}` : `Professor ${question.professor_name}: ${question.professor_prompt}`}</p>{"professor_prompt" in question ? <p className="mt-1 line-clamp-1 text-xs text-student-muted">{question.student_1_name}: {question.student_1_response} · {question.student_2_name}: {question.student_2_response}</p> : null}</button>; })}{!payload.questions.length ? <p className="py-6 text-center text-sm text-student-muted">没有找到匹配题目。</p> : null}</div><div className="flex items-center justify-between text-sm text-student-muted"><span>共 {payload.total} 道 · 第 {payload.page}/{totalPages} 页</span><div className="flex gap-2"><button className="teacher-button-secondary h-9 px-3" disabled={payload.page <= 1} onClick={() => onPage(payload.page - 1)} type="button"><ChevronLeft aria-hidden="true" size={15} />上一页</button><button className="teacher-button-secondary h-9 px-3" disabled={payload.page >= totalPages} onClick={() => onPage(payload.page + 1)} type="button">下一页<ChevronRight aria-hidden="true" size={15} /></button></div></div></div>;
}

export function customFieldsFromSnapshot(question: WritingQuestion): Record<string, string> {
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

export function defaultAcademicDiscussionAvatarFields(): Record<string, string> {
  return {
    professor_avatar_type: "male_professor",
    student_1_avatar_type: "male_student",
    student_2_avatar_type: "female_student"
  };
}

export function formatLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
