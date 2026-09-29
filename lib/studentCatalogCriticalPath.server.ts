import {
  settleParallelResult,
  STUDENT_CATALOG_TIMING_PHASES,
  type SettledResult,
  type StudentPerformanceTrace
} from "./studentPerformance.server.ts";

export type VerifiedStudentIdentity =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string };

export type StudentCatalogCriticalPathInput<TCatalog, TState> = {
  timing: StudentPerformanceTrace;
  /** JWT claims verification. Must complete before any data load starts. */
  identity: () => Promise<VerifiedStudentIdentity>;
  /**
   * Started right after identity verification and run in parallel with the
   * profile authorization and each other. `userId` is the verified `sub`.
   */
  loadCatalog: (userId: string) => Promise<TCatalog>;
  /** One sparse state read for the verified student. */
  loadState: (userId: string) => Promise<TState>;
  /**
   * Database profile role/is_active authorization, started right after
   * identity verification and read with the user's own token on every request.
   * It is the only gate for the response and runs in parallel with the data
   * loads below.
   */
  authorization: (userId: string) => Promise<
    | { ok: true }
    | { ok: false; status: 401 | 403; error: string }
  >;
  /** Runs only after the profile gate passes, with both data loads settled. */
  merge: (
    catalog: SettledResult<TCatalog>,
    state: SettledResult<TState>,
    userId: string
  ) => PromiseLike<unknown>;
};

export type StudentCatalogCriticalPathResult =
  | { forbidden: false; data: unknown }
  | { forbidden: true; status: 401 | 403; error: string };

/**
 * Shared critical-path orchestration for the three student first-screen catalog
 * APIs (/api/practice-catalog, /api/reading/catalog, /api/reading/full-sets):
 *
 *   verify JWT claims locally
 *   -> start public catalog + sparse student state + profiles authorization
 *   -> profile gate (role / is_active, database-backed, per request)
 *   -> merge cached catalog with sparse state
 *
 * The catalog/state reads are internal service-role reads that start only after
 * the token signature is verified. They are settled, never returned, until the
 * profile gate passes, so an invalid, disabled, or wrong-role account cannot
 * observe catalog/student data or a response built from it.
 *
 * Both data promises are settled here (rejections become values) so the caller
 * can rethrow the real error only after the gate, and an early authorization
 * return never leaves an unhandled rejection behind.
 */
export async function runStudentCatalogCriticalPath<TCatalog, TState>(
  input: StudentCatalogCriticalPathInput<TCatalog, TState>
): Promise<StudentCatalogCriticalPathResult> {
  const identityPhase = input.timing.startPhase(STUDENT_CATALOG_TIMING_PHASES.authClaims, "auth");
  const identity = await input.identity();
  input.timing.recordPhase(identityPhase);
  if (!identity.ok) {
    return { forbidden: true, status: identity.status, error: identity.error };
  }

  const catalogPromise = settleParallelResult(
    input.timing.phase(STUDENT_CATALOG_TIMING_PHASES.publicCatalog, () =>
      input.loadCatalog(identity.userId)
    )
  );
  const statePromise = settleParallelResult(
    input.timing.phase(STUDENT_CATALOG_TIMING_PHASES.studentState, () =>
      input.loadState(identity.userId)
    )
  );
  const authorization = await input.timing.phase(STUDENT_CATALOG_TIMING_PHASES.profile, () =>
    input.authorization(identity.userId)
  );

  if (!authorization.ok) {
    // Reject before any catalog/state data is touched. The settled preloads
    // keep running in the background without surfacing unhandled rejections.
    return { forbidden: true, status: authorization.status, error: authorization.error };
  }

  const [catalogResult, stateResult] = await Promise.all([catalogPromise, statePromise]);
  const data = await input.timing.phase(STUDENT_CATALOG_TIMING_PHASES.merge, () =>
    input.merge(catalogResult, stateResult, identity.userId)
  );
  return { forbidden: false, data };
}
