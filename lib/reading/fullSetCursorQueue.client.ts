export type ReadingFullSetCursorSnapshot = {
  cursorRevision: number;
  moduleAttemptId: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  questionIndex: number;
};

type CursorInput = Omit<ReadingFullSetCursorSnapshot, "cursorRevision">;

type CursorState = {
  durableRevision: number;
  inFlight: boolean;
  latest: ReadingFullSetCursorSnapshot | null;
  nextRevision: number;
};

type CursorQueueOptions = {
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  transport: (snapshot: ReadingFullSetCursorSnapshot) => Promise<void>;
};

/**
 * Keeps at most one normal cursor write in flight per Module. Navigation is
 * optimistic: newer positions replace the queued snapshot while the active
 * request finishes, and the server revision makes pagehide races stale-safe.
 */
export class ReadingFullSetCursorQueue {
  private readonly maxRetries: number;
  private readonly retryDelayMs: NonNullable<CursorQueueOptions["retryDelayMs"]>;
  private readonly states = new Map<string, CursorState>();
  private readonly transport: CursorQueueOptions["transport"];

  constructor(options: CursorQueueOptions) {
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => 150 * (2 ** (attempt - 1)));
    this.transport = options.transport;
  }

  prime(moduleAttemptId: string, cursorRevision: number) {
    const normalizedRevision = Number.isInteger(cursorRevision) && cursorRevision >= 0
      ? cursorRevision
      : 0;
    const state = this.states.get(moduleAttemptId);
    if (!state) {
      this.states.set(moduleAttemptId, {
        durableRevision: normalizedRevision,
        inFlight: false,
        latest: null,
        nextRevision: normalizedRevision
      });
      return;
    }
    state.durableRevision = Math.max(state.durableRevision, normalizedRevision);
    state.nextRevision = Math.max(state.nextRevision, normalizedRevision);
  }

  enqueue(input: CursorInput) {
    this.prime(input.moduleAttemptId, 0);
    const state = this.states.get(input.moduleAttemptId)!;
    const snapshot: ReadingFullSetCursorSnapshot = {
      ...input,
      cursorRevision: state.nextRevision + 1
    };
    state.nextRevision = snapshot.cursorRevision;
    state.latest = snapshot;
    void this.pump(input.moduleAttemptId);
    return snapshot;
  }

  clear(moduleAttemptId?: string) {
    if (moduleAttemptId) this.states.delete(moduleAttemptId);
    else this.states.clear();
  }

  latest(moduleAttemptId: string) {
    return this.states.get(moduleAttemptId)?.latest ?? null;
  }

  /** Best effort for pagehide; the server revision resolves any request race. */
  flushBestEffort(moduleAttemptId?: string) {
    for (const [key, state] of Array.from(this.states.entries())) {
      if (moduleAttemptId && key !== moduleAttemptId) continue;
      if (!state.latest || state.latest.cursorRevision <= state.durableRevision) continue;
      void this.transport(state.latest).catch(() => undefined);
    }
  }

  private async pump(moduleAttemptId: string) {
    const state = this.states.get(moduleAttemptId);
    if (!state || state.inFlight) return;
    state.inFlight = true;
    try {
      while (state.latest && state.latest.cursorRevision > state.durableRevision) {
        const snapshot = state.latest;
        let saved = false;
        for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
          try {
            await this.transport(snapshot);
            saved = true;
            break;
          } catch {
            if (attempt > this.maxRetries) break;
            await delay(this.retryDelayMs(attempt));
          }
        }
        if (!saved) break;
        state.durableRevision = Math.max(state.durableRevision, snapshot.cursorRevision);
      }
    } finally {
      state.inFlight = false;
    }
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
