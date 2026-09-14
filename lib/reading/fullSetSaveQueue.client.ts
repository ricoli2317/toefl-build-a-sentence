export type ReadingFullSetSaveStatus = "dirty" | "error" | "saved" | "saving";

export type ReadingFullSetSaveSnapshot<T> = {
  key: string;
  localRevision: number;
  moduleAttemptId: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  value: T;
};

export type ReadingFullSetSaveQueueEvent<T> = {
  attempt?: number;
  durationMs?: number;
  error?: unknown;
  snapshot: ReadingFullSetSaveSnapshot<T>;
  type: "enqueued" | "error" | "retry" | "started" | "success";
};

export type ReadingFullSetSaveQueueState = {
  dirty: boolean;
  latestDurableRevision: number;
  latestLocalRevision: number;
  status: ReadingFullSetSaveStatus;
};

export class ReadingFullSetSaveError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReadingFullSetSaveError";
    this.retryable = options.retryable ?? false;
  }
}

type MutableSaveState<T> = ReadingFullSetSaveQueueState & {
  error: unknown;
  inFlightPromise: Promise<void> | null;
  latestSnapshot: ReadingFullSetSaveSnapshot<T>;
};

type QueueOptions<T> = {
  maxRetries?: number;
  onEvent?: (event: ReadingFullSetSaveQueueEvent<T>) => void;
  retryDelayMs?: (attempt: number) => number;
  transport: (snapshot: ReadingFullSetSaveSnapshot<T>) => Promise<void>;
};

/**
 * Serializes a Module's optimistic-CAS writes while retaining independent
 * latest/durable state per occurrence. A newer snapshot replaces any queued
 * snapshot for the same occurrence, but never mutates the in-flight snapshot.
 */
export class ReadingFullSetSaveQueue<T> {
  private drainPromise: Promise<void> | null = null;
  private readonly maxRetries: number;
  private readonly onEvent?: QueueOptions<T>["onEvent"];
  private readonly retryDelayMs: NonNullable<QueueOptions<T>["retryDelayMs"]>;
  private readonly states = new Map<string, MutableSaveState<T>>();
  private readonly transport: QueueOptions<T>["transport"];

  constructor(options: QueueOptions<T>) {
    this.maxRetries = options.maxRetries ?? 2;
    this.onEvent = options.onEvent;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => 150 * (2 ** (attempt - 1)));
    this.transport = options.transport;
  }

  enqueue(input: Omit<ReadingFullSetSaveSnapshot<T>, "localRevision">) {
    const existing = this.states.get(input.key);
    const snapshot: ReadingFullSetSaveSnapshot<T> = {
      ...input,
      localRevision: (existing?.latestLocalRevision ?? 0) + 1
    };
    if (existing) {
      const blocksNewSaves = existing.status === "error"
        && (!(existing.error instanceof ReadingFullSetSaveError) || !existing.error.retryable);
      existing.dirty = true;
      existing.latestLocalRevision = snapshot.localRevision;
      existing.latestSnapshot = snapshot;
      if (!blocksNewSaves && existing.status !== "saving") {
        existing.error = null;
        existing.status = "dirty";
      }
    } else {
      this.states.set(input.key, {
          dirty: true,
          error: null,
          inFlightPromise: null,
          latestDurableRevision: 0,
          latestLocalRevision: snapshot.localRevision,
          latestSnapshot: snapshot,
          status: "dirty"
      });
    }
    this.onEvent?.({ snapshot, type: "enqueued" });
    void this.pump();
    return snapshot;
  }

  getState(key: string): ReadingFullSetSaveQueueState | null {
    const state = this.states.get(key);
    if (!state) return null;
    return {
      dirty: state.latestDurableRevision < state.latestLocalRevision,
      latestDurableRevision: state.latestDurableRevision,
      latestLocalRevision: state.latestLocalRevision,
      status: state.status
    };
  }

  hasPending(moduleAttemptId?: string) {
    return Array.from(this.states.values()).some((state) =>
      (!moduleAttemptId || state.latestSnapshot.moduleAttemptId === moduleAttemptId)
      && state.latestDurableRevision < state.latestLocalRevision
    );
  }

  hasErrors(moduleAttemptId?: string) {
    return Array.from(this.states.values()).some((state) =>
      (!moduleAttemptId || state.latestSnapshot.moduleAttemptId === moduleAttemptId)
      && state.status === "error"
    );
  }

  async flush(moduleAttemptId: string) {
    for (const state of Array.from(this.states.values())) {
      if (
        state.latestSnapshot.moduleAttemptId === moduleAttemptId
        && state.latestDurableRevision < state.latestLocalRevision
        && state.status === "error"
        && state.error instanceof ReadingFullSetSaveError
        && state.error.retryable
      ) {
        state.error = null;
        state.status = "dirty";
      }
    }

    while (this.hasPending(moduleAttemptId)) {
      if (this.drainPromise) {
        await this.drainPromise;
        continue;
      }
      if (this.hasRunnable(moduleAttemptId)) {
        await this.pump();
        continue;
      }
      break;
    }
    return !this.hasPending(moduleAttemptId);
  }

  clear(moduleAttemptId?: string) {
    if (!moduleAttemptId) {
      this.states.clear();
      return;
    }
    for (const [key, state] of Array.from(this.states.entries())) {
      if (state.latestSnapshot.moduleAttemptId === moduleAttemptId) this.states.delete(key);
    }
  }

  private hasRunnable(moduleAttemptId: string) {
    return Array.from(this.states.values()).some((state) =>
      state.latestSnapshot.moduleAttemptId === moduleAttemptId
      && state.latestDurableRevision < state.latestLocalRevision
      && state.status !== "error"
    );
  }

  private pump() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.nextDirtyState()) void this.pump();
    });
    return this.drainPromise;
  }

  private async drain() {
    let state = this.nextDirtyState();
    while (state) {
      await this.saveState(state);
      state = this.nextDirtyState();
    }
  }

  private nextDirtyState() {
    return Array.from(this.states.values()).find((state) => state.status === "dirty") ?? null;
  }

  private async saveState(state: MutableSaveState<T>) {
    const snapshot = state.latestSnapshot;
    state.status = "saving";
    const startedAt = now();
    const operation = (async () => {
      for (let attempt = 1; ; attempt += 1) {
        this.onEvent?.({ attempt, snapshot, type: "started" });
        try {
          await this.transport(snapshot);
          state.latestDurableRevision = Math.max(
            state.latestDurableRevision,
            snapshot.localRevision
          );
          state.dirty = state.latestDurableRevision < state.latestLocalRevision;
          state.error = null;
          state.status = state.dirty ? "dirty" : "saved";
          this.onEvent?.({
            attempt,
            durationMs: now() - startedAt,
            snapshot,
            type: "success"
          });
          return;
        } catch (error) {
          const retryable = error instanceof ReadingFullSetSaveError && error.retryable;
          if (retryable && attempt <= this.maxRetries) {
            this.onEvent?.({ attempt, error, snapshot, type: "retry" });
            await delay(this.retryDelayMs(attempt));
            continue;
          }
          state.dirty = true;
          state.error = error;
          state.status = "error";
          this.onEvent?.({
            attempt,
            durationMs: now() - startedAt,
            error,
            snapshot,
            type: "error"
          });
          return;
        }
      }
    })();
    state.inFlightPromise = operation;
    await operation;
    if (state.inFlightPromise === operation) state.inFlightPromise = null;
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
