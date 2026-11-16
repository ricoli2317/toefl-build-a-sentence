const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const PREFLIGHT = readManual("preflight_phase6.sql");
const VERIFY_DATA = readManual("verify_phase6_data.sql");
const ENABLE = readManual("enable_practice_entitlements.sql");
const DISABLE = readManual("disable_practice_entitlements.sql");
const VERIFY_SWITCH = readManual("verify_phase6_switch.sql");
const phase6SqlTest = (name, fn) => test(name, {
  skip: PREFLIGHT && VERIFY_DATA && ENABLE && DISABLE && VERIFY_SWITCH
    ? false
    : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);

const PHASE6_FIXTURE = `
  create table public.practice_entitlement_runtime_config (
    singleton boolean primary key,
    enforcement_enabled boolean not null default false,
    updated_at timestamptz not null default clock_timestamp()
  );
  insert into public.practice_entitlement_runtime_config(singleton, enforcement_enabled)
  values (true, false);
  create table public.practice_entitlement_defaults (
    entitlement_kind text primary key,
    default_remaining integer not null
  );
  insert into public.practice_entitlement_defaults values
    ('build_sentence', 5), ('email', 5), ('academic_discussion', 5),
    ('ctw', 5), ('rdl', 5), ('rap', 5), ('bas_category', 3), ('rap_category', 3);
  create table public.student_practice_entitlements (
    student_id uuid not null,
    entitlement_kind text not null,
    remaining integer not null,
    primary key (student_id, entitlement_kind)
  );
  create table public.student_practice_unlocks (
    student_id uuid not null,
    task_type text not null,
    item_id text not null,
    primary key (student_id, task_type, item_id)
  );
  create table public.reading_full_set_attempts (
    attempt_id uuid primary key,
    student_id uuid not null,
    full_set_id text not null,
    status text not null,
    completed_at timestamptz
  );
  create table public.bas_grammar_practice_sessions (
    session_id uuid primary key,
    status text not null,
    origin text not null
  );
  create table public.reading_question_category_sessions (
    session_id uuid primary key,
    status text not null,
    origin text not null
  );
  create table public.writing_assignments (
    assignment_id uuid primary key,
    task_type text not null
  );
  create function public.practice_entitlement_enforcement_enabled()
  returns boolean language sql stable set search_path = '' as $$
    select coalesce((
      select config.enforcement_enabled
      from public.practice_entitlement_runtime_config config
      where config.singleton = true
    ), false);
  $$;
`;

phase6SqlTest("phase 6 manual preflight, data verification and switch scripts execute", async () => {
  const db = new PGlite();
  try {
    await db.exec(PHASE6_FIXTURE);
    await db.exec(PREFLIGHT);
    await db.exec(VERIFY_DATA);
    await db.exec(VERIFY_SWITCH);
    await db.exec(ENABLE);
    assert.equal((await db.query(
      "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
    )).rows[0].enforcement_enabled, true);
    await db.exec(DISABLE);
    assert.equal((await db.query(
      "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
    )).rows[0].enforcement_enabled, false);
  } finally {
    await db.close();
  }
});


const {
  canStartOrdinaryPractice,
  parsePracticeEntitlementBulkValue,
  practiceQuotaExhausted,
  PRACTICE_ENTITLEMENT_KINDS
} = require("../lib/practiceEntitlements.ts");
const {
  loadStudentPracticeUnlockItemIds
} = require("../lib/practiceEntitlements.server.ts");

test("phase 6 uses the existing authority and does not add a V6 schema migration", () => {
  assert.equal(PRACTICE_ENTITLEMENT_KINDS.length, 8);
  assert.equal(fs.existsSync(path.join(ROOT, "supabase/student_practice_entitlements_v6_20261115.sql")), false);
  for (const file of [
    "supabase/student_practice_entitlements_v1_20261114.sql",
    "supabase/student_practice_entitlements_v2_20261114.sql",
    "supabase/student_practice_entitlements_v3_20261114.sql",
    "supabase/student_practice_entitlements_v4_20261115.sql",
    "supabase/student_practice_entitlements_v5_20261115.sql"
  ]) {
    const source = read(file);
    assert.match(source, /begin;/);
    assert.match(source, /commit;/);
  }
});

test("admin bulk setting accepts 0 and positive integers without writing the database", () => {
  assert.deepEqual(parsePracticeEntitlementBulkValue("0"), {
    ok: true,
    text: "0",
    value: 0
  });
  assert.deepEqual(parsePracticeEntitlementBulkValue(" 12 "), {
    ok: true,
    text: "12",
    value: 12
  });
  for (const invalid of ["", "-1", "1.5", "abc", String(2147483648)]) {
    assert.equal(parsePracticeEntitlementBulkValue(invalid).ok, false, invalid);
  }

  const panel = read("components/admin/StudentPracticeEntitlementsPanel.tsx");
  assert.match(panel, /统一设置：/);
  assert.match(panel, /应用到全部/);
  assert.match(panel, /parsePracticeEntitlementBulkValue/);
  assert.match(panel, /PRACTICE_ENTITLEMENT_SHORT_LABELS\[kind\]/);
  assert.doesNotMatch(panel, /八项额度互相独立/);
  assert.doesNotMatch(panel, /使用默认值/);
  assert.doesNotMatch(panel, /PRACTICE_ENTITLEMENT_LABELS\[kind\]\}<\/span>/);
  // Bulk apply only rewrites the local draft; the only PATCH stays in save().
  assert.equal((panel.match(/method: "PATCH"/g) ?? []).length, 1);
});

test("one batched, service-role-only unlock read answers a whole catalog", async () => {
  const db = createMockSupabase({
    student_practice_unlocks: [
      { item_id: "item-a", student_id: "student-1", task_type: "build_sentence" },
      { item_id: "item-b", student_id: "student-1", task_type: "build_sentence" },
      { item_id: "item-c", student_id: "student-2", task_type: "build_sentence" },
      { item_id: "reading-1", student_id: "student-1", task_type: "rap" }
    ]
  });
  const bas = await loadStudentPracticeUnlockItemIds(db, {
    studentId: "student-1",
    taskType: "build_sentence"
  });
  assert.deepEqual([...bas].sort(), ["item-a", "item-b"]);
  const rap = await loadStudentPracticeUnlockItemIds(db, {
    studentId: "student-1",
    taskType: "rap"
  });
  assert.deepEqual([...rap], ["reading-1"]);
});

test("ordinary start gating distinguishes unlocked, available and exhausted", () => {
  const base = { status: "unstarted", viewerRole: "student" };
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: false,
    remaining: 0,
    unlocked: false
  }), true, "switch OFF must preserve old free entry");
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: true,
    remaining: 0,
    unlocked: false
  }), false);
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: true,
    remaining: 0,
    unlocked: true
  }), true, "unlocked item is never quota-blocked");
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: true,
    remaining: 0,
    status: "in_progress",
    unlocked: false
  }), true, "Resume is not a new Start");
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: true,
    remaining: 0,
    status: "completed",
    unlocked: false
  }), true, "Retake remains available");
  assert.equal(canStartOrdinaryPractice({
    ...base,
    enforcementEnabled: true,
    remaining: 0,
    unlocked: false,
    viewerRole: "teacher"
  }), true, "Teacher/Admin student-mode testing is exempt");
  assert.equal(practiceQuotaExhausted({
    enforcementEnabled: true,
    remaining: null,
    viewerRole: "student"
  }), false, "unknown balance must not disable before load");
});

test("catalog APIs attach canonical unlocks in one batch, not per card", () => {
  const logical = read("app/api/practice-catalog/route.ts");
  const reading = read("app/api/reading/catalog/route.ts");
  for (const [route, kindSource] of [
    [logical, "loadStudentPracticeUnlockItemIds"],
    [reading, "loadStudentPracticeUnlockItemIds"]
  ]) {
    assert.match(route, /loadStudentPracticeUnlockItemIds/);
    assert.match(route, /loadPracticeEntitlementEnforcementEnabled/);
    assert.match(route, /viewerRole/);
    assert.match(route, /items: .*map\(\(item\) => \(\{/s);
    assert.match(route, /unlocked:/);
    assert.equal((route.match(/student_practice_unlocks/g) ?? []).length, 0);
  }
  assert.match(logical, /loadStudentPracticeItemStates/);
  assert.match(reading, /loadStudentPracticeItemStates/);
});

test("six ordinary catalogs show quota and unlock state and gate only new starts", () => {
  const logical = read("components/LogicalPracticeCatalog.tsx");
  const reading = read("components/reading/ReadingCatalog.tsx");
  for (const source of [logical, reading]) {
    assert.match(source, /StudentEntitlementNotice/);
    assert.match(source, /StudentUnlockBadge/);
    assert.match(source, /canStartOrdinaryPractice/);
    assert.match(source, /额度已用完/);
  }
  assert.match(logical, /!startAllowed/);
  assert.match(logical, /disabled=\{disabled\}/);
  assert.match(reading, /disabled=\{!canStart\}/);
  assert.match(logical, /item\.student_state\.status === "unstarted"/);
  assert.match(logical, /status === "in_progress"/);
  assert.match(logical, /"retake"/);
  assert.match(reading, /item\.status === "unstarted"/);
  assert.match(reading, /item\.status === "in_progress"/);
  assert.match(reading, /ReadingRetakeButton/);
});

test("category pages show shared self-practice quota and hide Student all-practice only when enforced", () => {
  const grammar = read("components/GrammarPractice.tsx");
  const rap = read("components/reading/QuestionCategoryPracticeHome.tsx");
  assert.match(grammar, /StudentEntitlementNotice kind="bas_category"/);
  assert.match(grammar, /entitlements\.exhausted\("bas_category"\)/);
  assert.match(grammar, /showAllPractice/);
  assert.match(grammar, /StudentEntitlementNotice/);
  assert.match(grammar, /disabled=\{disabled\}/);
  assert.match(grammar, /自主练习次数已用完/);
  assert.match(rap, /StudentEntitlementNotice kind="rap_category"/);
  assert.match(rap, /entitlements\.exhausted\("rap_category"\)/);
  assert.match(rap, /disabled=\{state\.loading \|\| Boolean\(state\.error\) \|\| exhausted\}/);
  assert.match(rap, /专项练习/);
});

test("Full Set Student entry follows the authoritative switch and keeps history/retake", () => {
  const catalog = read("components/reading/ReadingFullSetCatalog.tsx");
  const detail = read("components/reading/ReadingFullSetDetail.tsx");
  const api = read("app/api/reading/full-sets/route.ts");
  const detailApi = read("app/api/reading/full-sets/[fullSetId]/route.ts");
  assert.match(api, /canStartUnassigned/);
  assert.match(api, /loadPracticeEntitlementEnforcementEnabled/);
  assert.match(detailApi, /canStartUnassigned/);
  assert.match(catalog, /需教师布置/);
  assert.match(catalog, /in_progress/);
  assert.match(catalog, /ReadingFullSetRetakeButton/);
  assert.match(detail, /actionBlocked/);
  assert.match(detail, /需教师布置/);
  assert.match(detail, /ReadingFullSetRetakeButton/);
  assert.match(detail, /完整阅读套题只能从有效教师作业开始/);
});

test("start and completion paths invalidate quota/unlock catalogs and Admin changes notify students", () => {
  const practiceSession = read("components/PracticeSession.tsx");
  const writing = read("components/writing/WritingPractice.tsx");
  const reading = read("components/reading/ReadingPractice.tsx");
  const grammar = read("components/GrammarPractice.tsx");
  const category = read("components/reading/QuestionCategoryPractice.tsx");
  const fullSet = read("components/reading/ReadingFullSetRunner.tsx");
  const adminPanel = read("components/admin/StudentPracticeEntitlementsPanel.tsx");
  const cache = read("components/StudentDataCache.tsx");
  const invalidation = read("lib/cacheInvalidation.ts");
  const entitlementUi = read("components/student/StudentPracticeEntitlements.tsx");

  for (const source of [practiceSession, writing, reading, grammar, category]) {
    assert.match(source, /STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY/);
  }
  assert.match(practiceSession, /STUDENT_LOGICAL_CATALOG_CACHE_PREFIX/);
  assert.match(writing, /STUDENT_LOGICAL_CATALOG_CACHE_PREFIX/);
  assert.match(reading, /studentReadingCatalogCacheKey/);
  assert.match(fullSet, /STUDENT_READING_CATALOG_CACHE_PREFIX/);
  assert.match(fullSet, /STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY/);
  assert.match(adminPanel, /PRACTICE_ENTITLEMENT_CHANGED/);
  assert.match(invalidation, /PRACTICE_ENTITLEMENT_CHANGED/);
  assert.match(cache, /STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY/);
  assert.match(entitlementUi, /refreshOnMount: studentViewer/);
  assert.match(entitlementUi, /每次开始新的分类练习消耗 1 次/);
  assert.match(entitlementUi, /首次练习未解锁题目消耗 1 次/);
});

test("the same database switch is read by every enforcement layer and no second switch exists", () => {
  for (const file of [
    "supabase/student_practice_entitlements_v2_20261114.sql",
    "supabase/student_practice_entitlements_v3_20261114.sql",
    "supabase/student_practice_entitlements_v4_20261115.sql",
    "supabase/student_practice_entitlements_v5_20261115.sql"
  ]) {
    assert.match(read(file), /practice_entitlement_enforcement_enabled/);
  }
  const allSql = [
    "supabase/student_practice_entitlements_v1_20261114.sql",
    "supabase/student_practice_entitlements_v2_20261114.sql",
    "supabase/student_practice_entitlements_v3_20261114.sql",
    "supabase/student_practice_entitlements_v4_20261115.sql",
    "supabase/student_practice_entitlements_v5_20261115.sql"
  ].map(read).join("\n");
  assert.equal((allSql.match(/create table[^;]*enforcement_enabled/gi) ?? []).length, 1);
  assert.doesNotMatch(read("app/api/grammar-practice/route.ts"), /enforcement_enabled\s*=\s*(true|false)/);
});
