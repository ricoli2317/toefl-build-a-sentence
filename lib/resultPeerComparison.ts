export type ResultPeerAttempt = {
  attemptId: string;
  studentId: string;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number;
  submittedAt: string | null;
};

export type ResultPeerComparison = {
  averageTimeSeconds: number | null;
  scorePeerCount: number;
  scorePercentile: number | null;
  timeComparison: {
    direction: "faster" | "slower" | "same";
    percent: number;
  } | null;
  timePeerCount: number;
};

export const EMPTY_RESULT_PEER_COMPARISON: ResultPeerComparison = {
  averageTimeSeconds: null,
  scorePeerCount: 0,
  scorePercentile: null,
  timeComparison: null,
  timePeerCount: 0
};

export function buildResultPeerComparison(
  currentAttempt: Omit<ResultPeerAttempt, "studentId" | "submittedAt">,
  peerAttempts: ResultPeerAttempt[]
): ResultPeerComparison {
  const latestByStudent = new Map<string, ResultPeerAttempt>();

  for (const attempt of peerAttempts) {
    if (!attempt.studentId) continue;
    const current = latestByStudent.get(attempt.studentId);
    if (!current || isLaterAttempt(attempt, current)) {
      latestByStudent.set(attempt.studentId, attempt);
    }
  }

  const representativeAttempts = Array.from(latestByStudent.values());
  const scorePeers = representativeAttempts.filter((attempt) => attempt.totalQuestions > 0);
  const currentAccuracy = ratio(currentAttempt.correctCount, currentAttempt.totalQuestions);
  const lowerScoreCount = scorePeers.filter(
    (attempt) => ratio(attempt.correctCount, attempt.totalQuestions) < currentAccuracy
  ).length;
  const validTimePeers = representativeAttempts.filter(
    (attempt) => Number.isFinite(attempt.timeSpentSeconds) && attempt.timeSpentSeconds > 0
  );
  const averageTimeSeconds = validTimePeers.length
    ? validTimePeers.reduce((sum, attempt) => sum + attempt.timeSpentSeconds, 0) /
      validTimePeers.length
    : null;

  return {
    averageTimeSeconds,
    scorePeerCount: scorePeers.length,
    scorePercentile:
      scorePeers.length > 0 ? Math.round((lowerScoreCount / scorePeers.length) * 100) : null,
    timeComparison: buildTimeComparison(
      currentAttempt.timeSpentSeconds,
      averageTimeSeconds
    ),
    timePeerCount: validTimePeers.length
  };
}

function buildTimeComparison(
  currentTimeSeconds: number,
  averageTimeSeconds: number | null
): ResultPeerComparison["timeComparison"] {
  if (
    averageTimeSeconds === null ||
    averageTimeSeconds <= 0 ||
    !Number.isFinite(currentTimeSeconds) ||
    currentTimeSeconds <= 0
  ) {
    return null;
  }

  const differencePercent =
    ((averageTimeSeconds - currentTimeSeconds) / averageTimeSeconds) * 100;
  if (Math.abs(differencePercent) < 1) {
    return { direction: "same", percent: 0 };
  }

  return {
    direction: differencePercent > 0 ? "faster" : "slower",
    percent: Math.round(Math.abs(differencePercent))
  };
}

function isLaterAttempt(candidate: ResultPeerAttempt, current: ResultPeerAttempt) {
  const timeDifference = timestamp(candidate.submittedAt) - timestamp(current.submittedAt);
  return timeDifference > 0 || (timeDifference === 0 && candidate.attemptId > current.attemptId);
}

function timestamp(value: string | null) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

function ratio(correctCount: number, totalQuestions: number) {
  return totalQuestions > 0 ? correctCount / totalQuestions : 0;
}
