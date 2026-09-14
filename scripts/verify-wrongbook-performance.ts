type DbMetric = {
  dependsOn?: string[];
  durationMs: number;
  error: boolean;
  operation: string;
  query?: string;
  rows: number;
  selectedColumns?: string;
  startedAtMs?: number;
  table?: string;
};

type StageMetric = {
  dependsOn: string[];
  durationMs: number;
  rows: number | null;
  stage: string;
  startedAtMs: number;
};

type HttpMetric = {
  db: DbMetric[];
  durationMs: number;
  method: string;
  path: string;
  payloadBytes: number;
  stages: StageMetric[];
  status: number;
};

type WrongbookGroup = {
  correctionHref: string | null;
  groupId: string;
  pendingCount: number;
  taskType: "build_sentence" | "ctw" | "rdl" | "rap" | "full_set";
};

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log(`Usage:
  WRONGBOOK_VERIFY_TOKEN=<local access token> pnpm verify:wrongbook-performance
  WRONGBOOK_VERIFY_TOKEN=<local access token> pnpm verify:wrongbook-performance -- --include-correction-start

The default run is read-only and measures the homepage plus one BAS entry.
--include-correction-start also resumes/creates isolated Reading correction drafts
and measures CTW, RDL, RAP, and Full Set first-screen loading.
Only localhost and 127.0.0.1 targets are accepted.`);
  process.exit(0);
}

const baseUrl = new URL(process.env.WRONGBOOK_VERIFY_BASE_URL ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
  throw new Error("WRONGBOOK_VERIFY_BASE_URL must use localhost or 127.0.0.1.");
}
const token = process.env.WRONGBOOK_VERIFY_TOKEN?.trim();
if (!token) throw new Error("Missing WRONGBOOK_VERIFY_TOKEN. Run with --help for usage.");

const includeCorrectionStart = args.has("--include-correction-start");

async function main() {
const report: Record<string, unknown> = {};
const day = localDayRange();
const overviewQuery = new URLSearchParams({
  todayEnd: day.end,
  todayStart: day.start,
  view: "overview"
});
const overview = await measuredRequest(`/api/wrong-questions?${overviewQuery}`);
const overviewPayload = parseJson(overview.body) as {
  groups?: WrongbookGroup[];
  stats?: unknown;
};
report.homepage = scenarioReport([overview.metric], {
  groups: overviewPayload.groups?.length ?? 0,
  rowsByModule: overviewRowsByModule(overview.metric.db),
  stats: overviewPayload.stats ?? null
});

const baseline = await measuredRequest("/api/wrong-questions?performanceBaseline=1");
report.supabase_round_trip_baseline = scenarioReport([baseline.metric], {
  samples: baseline.metric.db.filter((metric) => metric.query?.startsWith("round_trip_baseline_"))
});

const groups = overviewPayload.groups ?? [];
const bas = firstPending(groups, "build_sentence");
if (bas) {
  const query = new URLSearchParams({
    groupId: bas.groupId,
    scope: "entry",
    todayEnd: day.end,
    todayStart: day.start
  });
  const result = await measuredRequest(`/api/wrong-questions?${query}`);
  const payload = parseJson(result.body) as { count?: number; stats?: unknown } | null;
  report.bas = scenarioReport([result.metric], {
    count: payload?.count ?? null,
    stats: payload?.stats ?? null
  });
} else {
  report.bas = { status: "no_pending_group" };
}

for (const taskType of ["ctw", "rdl", "rap"] as const) {
  const group = firstPending(groups, taskType);
  if (!group) {
    report[taskType] = { status: "no_pending_group" };
    continue;
  }
  if (!includeCorrectionStart) {
    report[taskType] = { status: "skipped_without_--include-correction-start" };
    continue;
  }
  const body = {
    itemId: group.groupId,
    scope: correctionScope(group),
    taskType,
    todayEnd: day.end,
    todayStart: day.start
  };
  const [practice, attempt] = await Promise.all([
    measuredRequest(`/api/reading/practice/${encodeURIComponent(group.groupId)}`),
    measuredRequest("/api/reading/wrongbook-attempts", { body, method: "POST" })
  ]);
  report[taskType] = {
    ...scenarioReport([practice.metric, attempt.metric]),
    firstRenderReadyMs: Math.max(practice.metric.durationMs, attempt.metric.durationMs),
    requestRelationship: "parallel"
  };
}

const fullSet = firstPending(groups, "full_set");
if (!fullSet) {
  report.full_set = { status: "no_pending_group" };
} else if (!includeCorrectionStart) {
  report.full_set = { status: "skipped_without_--include-correction-start" };
} else {
  const bootstrap = await measuredRequest("/api/reading/wrongbook-attempts", {
    body: {
      scope: correctionScope(fullSet),
      sourceAttemptId: fullSet.groupId,
      taskType: "full_set",
      todayEnd: day.end,
      todayStart: day.start
    },
    method: "POST"
  });
  const payload = parseJson(bootstrap.body) as {
    item?: { targets?: Array<{ logicalItemId?: string }> };
  };
  const logicalItemId = payload.item?.targets?.find((target) => target.logicalItemId)?.logicalItemId;
  const metrics = [bootstrap.metric];
  if (logicalItemId) {
    metrics.push((await measuredRequest(
      `/api/reading/practice/${encodeURIComponent(logicalItemId)}`
    )).metric);
  }
  report.full_set = {
    ...scenarioReport(metrics, { firstLogicalItemIdFound: Boolean(logicalItemId) }),
    firstRenderReadyMs: metrics.reduce((sum, metric) => sum + metric.durationMs, 0),
    requestRelationship: "bootstrap_then_practice_GET"
  };
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: includeCorrectionStart ? "correction-first-screen" : "read-only",
  report
}, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function firstPending(groups: WrongbookGroup[], taskType: WrongbookGroup["taskType"]) {
  return groups.find((group) =>
    group.taskType === taskType && group.pendingCount > 0 && group.correctionHref
  );
}

function correctionScope(group: WrongbookGroup) {
  if (!group.correctionHref) return "history";
  const url = new URL(group.correctionHref, baseUrl);
  return url.pathname.includes("/today/") ? "today" : "history";
}

function scenarioReport(http: HttpMetric[], payload?: unknown) {
  const db = http.flatMap((request) => request.db);
  return {
    browserHttpCount: http.length,
    browserDurationMs: Math.round(http.reduce((sum, request) => sum + request.durationMs, 0) * 10) / 10,
    dbQueryCount: db.length,
    dbRows: db.reduce((sum, query) => sum + query.rows, 0),
    dbDurationMs: Math.round(db.reduce((sum, query) => sum + query.durationMs, 0) * 10) / 10,
    http,
    payload: payload ?? null,
    payloadBytes: http.reduce((sum, request) => sum + request.payloadBytes, 0)
  };
}

function overviewRowsByModule(metrics: DbMetric[]) {
  const sum = (predicate: (query: string) => boolean) => metrics
    .filter((metric) => predicate(metric.query ?? ""))
    .reduce((total, metric) => total + metric.rows, 0);
  return {
    bas: sum((query) => query.startsWith("overview_bas_")),
    fullSet: sum((query) => query.startsWith("overview_full_set_")),
    reading: sum((query) => query.startsWith("reading_"))
  };
}

async function measuredRequest(
  path: string,
  options: { body?: unknown; method?: "GET" | "POST" } = {}
) {
  const method = options.method ?? "GET";
  const startedAt = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-TPS-Performance-Debug": "1"
    },
    method
  });
  const body = await response.text();
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const metric: HttpMetric = {
    db: decodeDbMetrics(response.headers.get("x-tps-db-metrics")),
    durationMs,
    method,
    path,
    payloadBytes: new TextEncoder().encode(body).length,
    stages: decodeHeader<StageMetric[]>(response.headers.get("x-tps-stage-metrics"), []),
    status: response.status
  };
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${safeError(body)}`);
  }
  return { body, metric };
}

function decodeDbMetrics(value: string | null): DbMetric[] {
  return decodeHeader<DbMetric[]>(value, []);
}

function decodeHeader<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return fallback;
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function safeError(body: string) {
  const parsed = parseJson(body) as { error?: unknown } | null;
  return typeof parsed?.error === "string" ? parsed.error : "request failed";
}

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
}
