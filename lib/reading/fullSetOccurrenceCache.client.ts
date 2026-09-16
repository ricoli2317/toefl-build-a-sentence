"use client";

export type ReadingFullSetCacheSource = "hit" | "miss" | "wait";

type LoadingEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  status: "loading";
};

type ReadyEntry<T> = {
  payload: T;
  status: "ready";
  timestamp: number;
};

type ErrorEntry = {
  error: unknown;
  status: "error";
  timestamp: number;
};

type CacheEntry<T> = LoadingEntry<T> | ReadyEntry<T> | ErrorEntry;

export type ReadingFullSetCacheAcquisition<T> = {
  promise: Promise<T>;
  source: ReadingFullSetCacheSource;
};

export class ReadingFullSetOccurrenceCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  status(key: string): "error" | "idle" | "loading" | "ready" {
    return this.entries.get(key)?.status ?? "idle";
  }

  acquire(
    key: string,
    loader: (signal: AbortSignal) => Promise<T>,
    options: { retryError?: boolean; timeoutMs?: number } = {}
  ): ReadingFullSetCacheAcquisition<T> {
    const existing = this.entries.get(key);
    if (existing?.status === "ready") {
      return { promise: Promise.resolve(existing.payload), source: "hit" };
    }
    if (existing?.status === "loading") {
      return { promise: existing.promise, source: "wait" };
    }
    if (existing?.status === "error" && !options.retryError) {
      return { promise: Promise.reject(existing.error), source: "wait" };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const promise = Promise.resolve().then(() => {
      if (options.timeoutMs) {
        timeout = setTimeout(() => controller.abort("timeout"), options.timeoutMs);
      }
      return loader(controller.signal);
    }).then((payload) => {
      const current = this.entries.get(key);
      if (current?.status === "loading" && current.promise === promise) {
        this.entries.set(key, { payload, status: "ready", timestamp: Date.now() });
      }
      return payload;
    }).catch((error) => {
      const current = this.entries.get(key);
      if (current?.status === "loading" && current.promise === promise) {
        this.entries.set(key, { error, status: "error", timestamp: Date.now() });
      }
      throw error;
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    this.entries.set(key, { controller, promise, status: "loading" });
    return { promise, source: "miss" };
  }

  prime(key: string, payload: T) {
    const existing = this.entries.get(key);
    if (existing?.status === "loading") existing.controller.abort("primed");
    this.entries.set(key, { payload, status: "ready", timestamp: Date.now() });
  }

  clear() {
    this.entries.forEach((entry) => {
      if (entry.status === "loading") entry.controller.abort("cache_cleared");
    });
    this.entries.clear();
  }
}

type ImagePreloadEntry = {
  controller: AbortController;
  promise: Promise<void>;
  status: "loading" | "ready";
};

export class ReadingFullSetImagePreloadCache {
  private readonly entries = new Map<string, ImagePreloadEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 24) {
    this.maxEntries = maxEntries;
  }

  acquire(url: string): { promise: Promise<void>; source: "hit" | "miss" } {
    const existing = this.entries.get(url);
    if (existing) {
      this.entries.delete(url);
      this.entries.set(url, existing);
      return { promise: existing.promise, source: "hit" };
    }

    while (this.entries.size >= this.maxEntries) {
      const oldestUrl = this.entries.keys().next().value as string | undefined;
      if (!oldestUrl) break;
      const oldest = this.entries.get(oldestUrl);
      if (oldest?.status === "loading") oldest.controller.abort("cache_evicted");
      this.entries.delete(oldestUrl);
    }

    const controller = new AbortController();
    const promise = preloadAndDecodeImage(url, controller.signal).then(() => {
      const current = this.entries.get(url);
      if (current?.promise === promise) current.status = "ready";
    }).catch((error) => {
      const current = this.entries.get(url);
      if (current?.promise === promise) this.entries.delete(url);
      throw error;
    });
    this.entries.set(url, { controller, promise, status: "loading" });
    return { promise, source: "miss" };
  }

  clear() {
    this.entries.forEach((entry) => entry.controller.abort("cache_cleared"));
    this.entries.clear();
  }
}

// One bounded cache survives Runner -> Result -> readonly component unmounts,
// so an RDL image already decoded in this tab remains immediately reusable.
export const readingFullSetSessionImagePreloadCache = new ReadingFullSetImagePreloadCache();

export function readingFullSetOccurrenceCacheKey(input: {
  attemptId: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
}) {
  return `${input.attemptId}:${input.moduleNumber}:${input.occurrenceId}`;
}

function preloadAndDecodeImage(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      image.src = "";
      finish(() => reject(new DOMException("Image preload aborted", "AbortError")));
    };
    image.onload = () => {
      void (async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
          finish(resolve);
        } catch (error) {
          finish(() => reject(error));
        }
      })();
    };
    image.onerror = () => finish(() => reject(new Error("RDL material image preload failed")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else image.src = url;
  });
}
