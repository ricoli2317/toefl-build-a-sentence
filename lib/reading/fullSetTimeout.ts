export class ReadingFullSetTimeoutError extends Error {
  readonly code: "BOOTSTRAP_TIMEOUT" | "ACTIVATION_FAILED";

  constructor(code: "BOOTSTRAP_TIMEOUT" | "ACTIVATION_FAILED") {
    super(code);
    this.name = "ReadingFullSetTimeoutError";
    this.code = code;
  }
}

export async function withReadingFullSetTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  code: ReadingFullSetTimeoutError["code"]
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ReadingFullSetTimeoutError(code)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
