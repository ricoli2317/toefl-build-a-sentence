import type {
  BuildSentenceLogicalAttemptRow,
  WritingLogicalAttemptRow
} from "./practiceLogicalState.ts";
import type { PublicLogicalPracticeCatalogData } from "./practiceLogicalCatalog.ts";
import { isVirtualPracticeSetId } from "./studentNavigation.ts";

export type StudentDashboardDraftSummary = {
  displayName: string;
  wordCount: number;
};

export type StudentDashboardWritingAttemptRow = WritingLogicalAttemptRow & {
  word_count: number | null;
};

export type StudentDashboardSummary = {
  buildSentence: {
    completedSetCount: number;
    currentMonthSetCount: number;
    totalSetCount: number;
  };
  drafts: {
    academic_discussion: StudentDashboardDraftSummary | null;
    email: StudentDashboardDraftSummary | null;
  };
  overview: {
    currentMonthPracticeCount: number;
    learningDayCount: number;
    pendingFeedbackCount: number;
    totalPracticeCount: number;
  };
};

export function latestDashboardDraft(
  attempts: StudentDashboardWritingAttemptRow[],
  taskType: "email" | "academic_discussion"
) {
  return attempts
    .filter(
      (attempt) =>
        attempt.assignment_id === null &&
        attempt.task_type === taskType &&
        attempt.status === "draft"
    )
    .sort(
      (left, right) =>
        attemptTime(right) - attemptTime(left) ||
        right.attempt_id.localeCompare(left.attempt_id)
    )[0] ?? null;
}

export function buildStudentDashboardSummary(input: {
  buildSentenceAttempts: BuildSentenceLogicalAttemptRow[];
  buildSentenceCatalog: PublicLogicalPracticeCatalogData;
  draftDisplayNames: Partial<Record<"email" | "academic_discussion", string>>;
  now?: Date;
  pendingFeedbackCount: number;
  writingAttempts: StudentDashboardWritingAttemptRow[];
}): StudentDashboardSummary {
  const now = input.now ?? new Date();
  const currentMonthKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const itemIdBySetId = new Map<string, string>();
  const currentMonthSetIds = new Set<string>();

  for (const source of input.buildSentenceCatalog.sources) {
    const setId = source.sourceSetId?.trim() ?? "";
    if (!setId || isVirtualPracticeSetId(setId)) continue;
    itemIdBySetId.set(setId, source.itemId);
    if (setId.startsWith(currentMonthKey)) currentMonthSetIds.add(setId);
  }

  const officialBuildSentenceAttempts = input.buildSentenceAttempts.filter((attempt) =>
    itemIdBySetId.has(attempt.set_id.trim())
  );
  const completedItemIds = new Set(
    officialBuildSentenceAttempts.flatMap((attempt) => {
      const itemId = itemIdBySetId.get(attempt.set_id.trim());
      return itemId ? [itemId] : [];
    })
  );
  const submittedWritingAttempts = input.writingAttempts.filter(
    (attempt) => attempt.status === "submitted"
  );
  const practiceDates = [
    ...officialBuildSentenceAttempts.flatMap((attempt) => {
      const value = attempt.submitted_at ?? attempt.created_at;
      return value ? [new Date(value)] : [];
    }),
    ...submittedWritingAttempts.flatMap((attempt) =>
      attempt.submitted_at ? [new Date(attempt.submitted_at)] : []
    )
  ].filter((date) => !Number.isNaN(date.getTime()));
  const emailDraft = latestDashboardDraft(input.writingAttempts, "email");
  const discussionDraft = latestDashboardDraft(
    input.writingAttempts,
    "academic_discussion"
  );

  return {
    buildSentence: {
      completedSetCount: completedItemIds.size,
      currentMonthSetCount: currentMonthSetIds.size,
      totalSetCount: input.buildSentenceCatalog.catalog.items.length
    },
    drafts: {
      email: emailDraft
        ? {
            displayName: input.draftDisplayNames.email ?? emailDraft.question_id,
            wordCount: emailDraft.word_count ?? 0
          }
        : null,
      academic_discussion: discussionDraft
        ? {
            displayName:
              input.draftDisplayNames.academic_discussion ?? discussionDraft.question_id,
            wordCount: discussionDraft.word_count ?? 0
          }
        : null
    },
    overview: {
      currentMonthPracticeCount: practiceDates.filter(
        (date) =>
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth()
      ).length,
      learningDayCount: new Set(practiceDates.map(localDateKey)).size,
      pendingFeedbackCount: input.pendingFeedbackCount,
      totalPracticeCount:
        officialBuildSentenceAttempts.length + submittedWritingAttempts.length
    }
  };
}

function attemptTime(attempt: StudentDashboardWritingAttemptRow) {
  const value = attempt.updated_at ?? attempt.saved_at ?? attempt.created_at;
  const timestamp = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}
