import { isVirtualPracticeSetId } from "./studentNavigation.ts";

export type OfficialAttemptStatus = {
  attempt_id: string;
  set_id: string;
  submitted_at?: string | null;
  created_at?: string | null;
  correct_count?: number | null;
  total_questions?: number | null;
  accuracy?: number | null;
};

type SetCompletionFields = {
  set_id: string;
  completed?: boolean;
  latest_attempt_id?: string | null;
  latest_correct_count?: number | null;
  latest_total_questions?: number | null;
  latest_accuracy?: number | null;
  latest_submitted_at?: string | null;
};

type SetsPayload<TSet extends SetCompletionFields> = {
  sets?: TSet[];
};

export function normalizeSetId(setId: string) {
  return setId.trim();
}

function attemptTimestamp(attempt: OfficialAttemptStatus) {
  const timestamp = Date.parse(attempt.submitted_at ?? attempt.created_at ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isLaterOfficialAttempt(
  candidate: OfficialAttemptStatus,
  current: OfficialAttemptStatus
) {
  const timeDifference = attemptTimestamp(candidate) - attemptTimestamp(current);
  return (
    timeDifference > 0 ||
    (timeDifference === 0 && candidate.attempt_id > current.attempt_id)
  );
}

export function buildLatestOfficialAttemptMap<
  TAttempt extends OfficialAttemptStatus
>(attempts: TAttempt[]) {
  const latestBySet = new Map<string, TAttempt>();

  for (const attempt of attempts) {
    const setId = normalizeSetId(attempt.set_id);
    if (!setId || isVirtualPracticeSetId(setId)) continue;

    const current = latestBySet.get(setId);
    if (!current || isLaterOfficialAttempt(attempt, current)) {
      latestBySet.set(setId, attempt);
    }
  }

  return latestBySet;
}

function completionPatch(attempt: OfficialAttemptStatus) {
  const correctCount = Number(attempt.correct_count ?? 0);
  const totalQuestions = Number(attempt.total_questions ?? 0);

  return {
    completed: true,
    latest_attempt_id: attempt.attempt_id,
    latest_correct_count: correctCount,
    latest_total_questions: totalQuestions,
    latest_submitted_at: attempt.submitted_at ?? attempt.created_at ?? null,
    latest_accuracy:
      typeof attempt.accuracy === "number"
        ? attempt.accuracy
        : totalQuestions > 0
          ? correctCount / totalQuestions
          : 0
  };
}

export function mergeOfficialAttemptIntoSetsPayload<
  TSet extends SetCompletionFields,
  TPayload extends SetsPayload<TSet>
>(payload: TPayload, attempt: OfficialAttemptStatus) {
  const attemptSetId = normalizeSetId(attempt.set_id);
  if (!attemptSetId || isVirtualPracticeSetId(attemptSetId)) {
    return { matched: false, payload };
  }

  let matched = false;
  const sets = (payload.sets ?? []).map((set) => {
    if (normalizeSetId(set.set_id) !== attemptSetId) return set;

    matched = true;
    if (
      set.latest_attempt_id &&
      isLaterOfficialAttempt(
        {
          attempt_id: set.latest_attempt_id,
          set_id: set.set_id,
          submitted_at: set.latest_submitted_at
        },
        attempt
      )
    ) {
      return set;
    }

    return {
      ...set,
      ...completionPatch(attempt)
    };
  });

  return {
    matched,
    payload: {
      ...payload,
      sets
    }
  };
}
