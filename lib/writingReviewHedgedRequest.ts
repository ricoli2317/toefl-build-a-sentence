export const WRITING_REVIEW_HEDGE_DELAY_MS = 60_000;
export const WRITING_REVIEW_HEDGE_DEADLINE_MS = 240_000;

export type WritingReviewHedgeRequestLabel = "primary" | "hedge";
export type WritingReviewHedgeLoserStatus =
  | "aborted_due_to_winner"
  | "terminal_failure"
  | "timeout"
  | null;

type TimerHandle = ReturnType<typeof setTimeout>;

export type WritingReviewHedgeBranch<T> = {
  request: WritingReviewHedgeRequestLabel;
  started_at_ms: number;
  finished_at_ms: number;
  elapsed_ms: number;
  result: string;
  outcome: T | null;
};

export type WritingReviewHedgeRun<T> = {
  hedge_triggered: boolean;
  requests_started: 1 | 2;
  winner: WritingReviewHedgeRequestLabel | null;
  winner_outcome: T | null;
  final_outcome: T | null;
  timed_out: boolean;
  end_to_end_elapsed_ms: number;
  primary: WritingReviewHedgeBranch<T>;
  hedge: WritingReviewHedgeBranch<T> | null;
  loser_status: WritingReviewHedgeLoserStatus;
};

export type WritingReviewHedgeOptions<T> = {
  hedgeDelayMs?: number;
  overallDeadlineMs?: number;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
  request(
    request: WritingReviewHedgeRequestLabel,
    signal: AbortSignal
  ): Promise<T>;
  isSuccess(outcome: T): boolean;
  resultOf(outcome: T): string;
};

type RequestEvent<T> = {
  kind: "request";
  request: WritingReviewHedgeRequestLabel;
  outcome: T;
  finishedAt: number;
};

export async function runWritingReviewHedgedRequest<T>(
  options: WritingReviewHedgeOptions<T>
): Promise<WritingReviewHedgeRun<T>> {
  const hedgeDelayMs =
    options.hedgeDelayMs ?? WRITING_REVIEW_HEDGE_DELAY_MS;
  const overallDeadlineMs =
    options.overallDeadlineMs ?? WRITING_REVIEW_HEDGE_DEADLINE_MS;
  if (hedgeDelayMs < 0 || overallDeadlineMs <= hedgeDelayMs) {
    throw new Error("Invalid writing-review hedge timing configuration.");
  }
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeoutImpl ?? setTimeout;
  const cancel = options.clearTimeoutImpl ?? clearTimeout;
  const startedAt = now();
  const primaryController = new AbortController();
  const primaryStartedAt = elapsed(startedAt, now);
  const primaryEvent = startRequest(
    "primary",
    primaryController.signal,
    startedAt,
    options,
    now
  );
  const hedgeTimer = createTimer(
    "hedge_timer",
    Math.max(0, hedgeDelayMs - elapsed(startedAt, now)),
    schedule
  );
  const deadlineTimer = createTimer(
    "deadline",
    Math.max(0, overallDeadlineMs - elapsed(startedAt, now)),
    schedule
  );

  const first = await Promise.race([
    primaryEvent,
    hedgeTimer.promise,
    deadlineTimer.promise
  ]);
  if (first.kind === "request") {
    cancel(hedgeTimer.handle);
    cancel(deadlineTimer.handle);
    const primary = completedBranch(
      "primary",
      primaryStartedAt,
      first,
      options
    );
    const success = options.isSuccess(first.outcome);
    return {
      hedge_triggered: false,
      requests_started: 1,
      winner: success ? "primary" : null,
      winner_outcome: success ? first.outcome : null,
      final_outcome: first.outcome,
      timed_out: false,
      end_to_end_elapsed_ms: elapsed(startedAt, now),
      primary,
      hedge: null,
      loser_status: null
    };
  }
  if (first.kind === "deadline") {
    cancel(hedgeTimer.handle);
    primaryController.abort();
    const finishedAt = elapsed(startedAt, now);
    return {
      hedge_triggered: false,
      requests_started: 1,
      winner: null,
      winner_outcome: null,
      final_outcome: null,
      timed_out: true,
      end_to_end_elapsed_ms: finishedAt,
      primary: syntheticBranch(
        "primary",
        primaryStartedAt,
        finishedAt,
        "timeout"
      ),
      hedge: null,
      loser_status: "timeout"
    };
  }

  const hedgeController = new AbortController();
  const hedgeStartedAt = elapsed(startedAt, now);
  const hedgeEvent = startRequest(
    "hedge",
    hedgeController.signal,
    startedAt,
    options,
    now
  );
  let primaryPending = true;
  let hedgePending = true;
  let primary: WritingReviewHedgeBranch<T> | null = null;
  let hedge: WritingReviewHedgeBranch<T> | null = null;
  let finalOutcome: T | null = null;

  while (primaryPending || hedgePending) {
    const candidates: Array<
      Promise<RequestEvent<T> | { kind: "deadline" }>
    > = [deadlineTimer.promise];
    if (primaryPending) candidates.push(primaryEvent);
    if (hedgePending) candidates.push(hedgeEvent);
    const event = await Promise.race(candidates);

    if (event.kind === "deadline") {
      if (primaryPending) primaryController.abort();
      if (hedgePending) hedgeController.abort();
      const finishedAt = elapsed(startedAt, now);
      primary ??= syntheticBranch(
        "primary",
        primaryStartedAt,
        finishedAt,
        "timeout"
      );
      hedge ??= syntheticBranch(
        "hedge",
        hedgeStartedAt,
        finishedAt,
        "timeout"
      );
      return {
        hedge_triggered: true,
        requests_started: 2,
        winner: null,
        winner_outcome: null,
        final_outcome: finalOutcome,
        timed_out: true,
        end_to_end_elapsed_ms: finishedAt,
        primary,
        hedge,
        loser_status: "timeout"
      };
    }

    const branch = completedBranch(
      event.request,
      event.request === "primary" ? primaryStartedAt : hedgeStartedAt,
      event,
      options
    );
    if (event.request === "primary") {
      primaryPending = false;
      primary = branch;
    } else {
      hedgePending = false;
      hedge = branch;
    }
    finalOutcome = event.outcome;

    if (options.isSuccess(event.outcome)) {
      const otherPending =
        event.request === "primary" ? hedgePending : primaryPending;
      if (otherPending) {
        if (event.request === "primary") hedgeController.abort();
        else primaryController.abort();
        const finishedAt = elapsed(startedAt, now);
        if (event.request === "primary") {
          hedge = syntheticBranch(
            "hedge",
            hedgeStartedAt,
            finishedAt,
            "aborted_due_to_winner"
          );
        } else {
          primary = syntheticBranch(
            "primary",
            primaryStartedAt,
            finishedAt,
            "aborted_due_to_winner"
          );
        }
      }
      cancel(deadlineTimer.handle);
      return {
        hedge_triggered: true,
        requests_started: 2,
        winner: event.request,
        winner_outcome: event.outcome,
        final_outcome: event.outcome,
        timed_out: false,
        end_to_end_elapsed_ms: elapsed(startedAt, now),
        primary: requiredBranch(primary),
        hedge: requiredBranch(hedge),
        loser_status: otherPending
          ? "aborted_due_to_winner"
          : "terminal_failure"
      };
    }

    if (!primaryPending && !hedgePending) {
      cancel(deadlineTimer.handle);
      return {
        hedge_triggered: true,
        requests_started: 2,
        winner: null,
        winner_outcome: null,
        final_outcome: finalOutcome,
        timed_out: false,
        end_to_end_elapsed_ms: elapsed(startedAt, now),
        primary: requiredBranch(primary),
        hedge: requiredBranch(hedge),
        loser_status: "terminal_failure"
      };
    }
  }
  throw new Error("Writing-review hedge reached an impossible state.");
}

function startRequest<T>(
  request: WritingReviewHedgeRequestLabel,
  signal: AbortSignal,
  startedAt: number,
  options: WritingReviewHedgeOptions<T>,
  now: () => number
): Promise<RequestEvent<T>> {
  return options.request(request, signal).then((outcome) => ({
    kind: "request" as const,
    request,
    outcome,
    finishedAt: elapsed(startedAt, now)
  }));
}

function completedBranch<T>(
  request: WritingReviewHedgeRequestLabel,
  startedAt: number,
  event: RequestEvent<T>,
  options: WritingReviewHedgeOptions<T>
): WritingReviewHedgeBranch<T> {
  return {
    request,
    started_at_ms: startedAt,
    finished_at_ms: event.finishedAt,
    elapsed_ms: Math.max(0, event.finishedAt - startedAt),
    result: options.resultOf(event.outcome),
    outcome: event.outcome
  };
}

function syntheticBranch<T>(
  request: WritingReviewHedgeRequestLabel,
  startedAt: number,
  finishedAt: number,
  result: "timeout" | "aborted_due_to_winner"
): WritingReviewHedgeBranch<T> {
  return {
    request,
    started_at_ms: startedAt,
    finished_at_ms: finishedAt,
    elapsed_ms: Math.max(0, finishedAt - startedAt),
    result,
    outcome: null
  };
}

function createTimer<const T extends "hedge_timer" | "deadline">(
  kind: T,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => TimerHandle
) {
  let handle: TimerHandle;
  const promise = new Promise<{ kind: T }>((resolve) => {
    handle = schedule(() => resolve({ kind }), delayMs);
  });
  return { promise, handle: handle! };
}

function requiredBranch<T>(value: WritingReviewHedgeBranch<T> | null) {
  if (!value) throw new Error("Missing writing-review hedge branch.");
  return value;
}

function elapsed(startedAt: number, now: () => number) {
  return Math.max(0, now() - startedAt);
}
