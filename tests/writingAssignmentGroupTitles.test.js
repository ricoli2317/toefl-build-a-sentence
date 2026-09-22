const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  collectWritingAssignmentRecipients,
  filterWritingAssignmentsByStudent,
  groupTeacherWritingAssignments,
  nextWritingAssignmentAutoTitle,
  studentWritingAssignmentTitle,
  writingAssignmentAutoTitleSequence,
  writingAssignmentQuestionDisplayTitle,
  writingAssignmentTaskTypeBadges
} = require("../lib/writingAssignments.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("shared task type badges follow the exact count rules on both ends", () => {
  assert.deepEqual(writingAssignmentTaskTypeBadges(["email"]), ["Write an Email"]);
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["academic_discussion"]),
    ["Academic Discussion"]
  );
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["email", "email"]),
    ["Write an Email ×2"]
  );
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["academic_discussion", "academic_discussion", "academic_discussion"]),
    ["Academic Discussion ×3"]
  );
  // A mixed group is two independent badges, never one concatenated label.
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["email", "academic_discussion"]),
    ["Write an Email", "Academic Discussion"]
  );
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["email", "email", "academic_discussion"]),
    ["Write an Email ×2", "Academic Discussion"]
  );
  assert.deepEqual(writingAssignmentTaskTypeBadges([]), []);
});

test("task type badges never invent mixed or umbrella labels", () => {
  const badges = writingAssignmentTaskTypeBadges([
    "email",
    "email",
    "academic_discussion"
  ]);
  assert.equal(badges.length, 2);
  for (const badge of badges) {
    assert.doesNotMatch(badge, /Mixed|Writing|×1/);
  }
});

test("teacher and student cards share the task type badge helper", () => {
  for (const relativePath of [
    "components/teacher/TeacherWritingAssignmentList.tsx",
    "components/teacher/TeacherWritingAssignmentCollectionDetailView.tsx",
    "components/student/StudentWritingAssignments.tsx"
  ]) {
    assert.match(source(relativePath), /writingAssignmentTaskTypeBadges/);
    assert.doesNotMatch(source(relativePath), /writingAssignmentTaskTypeLabels/);
  }
});

test("mixed groups render one badge per task type instead of one joined badge", () => {
  for (const relativePath of [
    "components/teacher/TeacherWritingAssignmentList.tsx",
    "components/teacher/TeacherWritingAssignmentCollectionDetailView.tsx",
    "components/student/StudentWritingAssignments.tsx"
  ]) {
    const ui = source(relativePath);
    assert.match(ui, /writingAssignmentTaskTypeBadges\([\s\S]{0,120}?\.map\(/);
    assert.doesNotMatch(ui, /writingAssignmentTaskTypeLabels/);
  }
});

test("recipient collection and local student filtering keep every recipient", () => {
  const assignments = [
    {
      assignment_id: "a",
      recipients: [
        { student_id: "s1", student_name: "张三" },
        { student_id: "s2", student_name: "李四" }
      ]
    },
    {
      assignment_id: "b",
      recipients: [
        { student_id: "s2", student_name: "李四" },
        { student_id: "s3", student_name: "王五" }
      ]
    },
    { assignment_id: "c", recipients: [] }
  ];
  assert.deepEqual(
    collectWritingAssignmentRecipients(assignments).map((item) => item.student_id),
    ["s1", "s2", "s3"]
  );
  assert.deepEqual(
    filterWritingAssignmentsByStudent(assignments, "s2").map((item) => item.assignment_id),
    ["a", "b"]
  );
  assert.deepEqual(
    filterWritingAssignmentsByStudent(assignments, "s3").map((item) => item.assignment_id),
    ["b"]
  );
  assert.equal(filterWritingAssignmentsByStudent(assignments, "s9").length, 0);
  assert.equal(filterWritingAssignmentsByStudent(assignments, "").length, 3);
});

test("student assignment titles prefer the persisted group title while items keep question titles", () => {
  const assignment = {
    display_name: "题目048 Technology Impact on Education",
    group_title: "张三 2026-09-22",
    group_id: "batch-1",
    question_snapshot: { set_title: "Business Trip Recommendations" }
  };
  assert.equal(studentWritingAssignmentTitle(assignment), "张三 2026-09-22");
  assert.equal(
    writingAssignmentQuestionDisplayTitle(assignment),
    "题目048 Technology Impact on Education"
  );
  assert.equal(
    studentWritingAssignmentTitle({ ...assignment, group_title: null }),
    "题目048 Technology Impact on Education"
  );
});

test("teacher grouping exposes the group title and the union of recipients", () => {
  const common = {
    group_id: "batch-1",
    assigned_count: 2,
    created_at: "2026-08-20T00:00:00Z",
    has_overdue_students: false
  };
  const entries = groupTeacherWritingAssignments([
    {
      ...common,
      assignment_id: "first",
      group_position: 1,
      group_title: "张三等 2026-08-20",
      completed_count: 2,
      published_count: 1,
      recipients: [
        { student_id: "s1", student_name: "张三" },
        { student_id: "s2", student_name: "李四" }
      ],
      task_type: "email"
    },
    {
      ...common,
      assignment_id: "second",
      group_position: 2,
      group_title: "张三等 2026-08-20",
      completed_count: 1,
      published_count: 0,
      recipients: [{ student_id: "s1", student_name: "张三" }],
      task_type: "academic_discussion"
    }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "collection");
  assert.equal(entries[0].title, "张三等 2026-08-20");
  assert.deepEqual(
    entries[0].recipients.map((item) => item.student_id),
    ["s1", "s2"]
  );
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(entries[0].assignments.map((item) => item.task_type)),
    ["Write an Email", "Academic Discussion"]
  );
});

test("teacher list page loads once and filters students locally without a new API request", () => {
  const pageClient = source("components/teacher/TeacherWritingAssignmentsPageClient.tsx");
  const list = source("components/teacher/TeacherWritingAssignmentList.tsx");
  assert.match(pageClient, /TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY/);
  assert.match(pageClient, /filterWritingAssignmentsByStudent/);
  assert.match(pageClient, /teacherApiFetch\("\/api\/teacher\/writing\/assignments"\)/);
  assert.doesNotMatch(pageClient, /studentId=\$\{encodeURIComponent\(filterStudentId\)\}`\)/);
  assert.doesNotMatch(pageClient, /useState\(true\)/);
  assert.match(list, /AssignmentRecipientNames/);
  assert.match(list, /TeacherPopover/);
  assert.match(list, /更多/);
  assert.match(list, /group_title/);
});

test("teacher list API returns recipients and group titles and never filters by studentId", () => {
  const route = source("app/api/teacher/writing/assignments/route.ts");
  assert.match(route, /loadWritingAssignmentGroupTitles/);
  assert.match(route, /recipients: recipientRows\.get/);
  assert.match(route, /getPreferredUserDisplayName/);
  assert.doesNotMatch(route, /searchParams\.get\("studentId"\)/);
  assert.match(route, /normalizeAssignmentGroupTitle\(body\.title\)/);
});

test("creation form keeps per-task-type selections and sends one titled group payload", () => {
  const form = source("components/teacher/TeacherWritingAssignmentForm.tsx");
  const createForm = form.match(
    /function TeacherWritingAssignmentCreateForm[\s\S]*?(?=function TeacherWritingAssignmentEditForm)/
  )?.[0] ?? "";
  assert.match(createForm, /selectedQuestionsByType/);
  assert.match(createForm, /Record<WritingTaskType, Map<string, LogicalWritingQuestionSearchResult>>/);
  assert.match(createForm, /作业标题/);
  assert.match(createForm, /setAssignmentTitleManuallyEdited\(true\)/);
  assert.match(createForm, /assignmentTitleManuallyEdited/);
  assert.match(createForm, /studentIds: selectedStudents, title/);
  assert.match(createForm, /taskType: entryTaskType/);
  assert.match(createForm, /draft\.taskType/);
  const chooseTaskType = createForm.match(
    /function chooseTaskType[\s\S]*?(?=function chooseSource)/
  )?.[0] ?? "";
  assert.doesNotMatch(chooseTaskType, /setSelectedQuestionsByType/);
  assert.doesNotMatch(chooseTaskType, /setCustomQuestions/);
  const chooseSource = createForm.match(
    /function chooseSource[\s\S]*?(?=async function searchQuestions)/
  )?.[0] ?? "";
  assert.doesNotMatch(chooseSource, /setSelectedQuestionsByType/);
  assert.doesNotMatch(chooseSource, /setCustomQuestions/);
});

test("phase A migration is additive, keeps the legacy RPCs and moves title and order into the new transaction", () => {
  const sql = source("supabase/writing_assignment_group_titles.sql");
  assert.match(sql, /alter table public\.writing_assignment_groups/);
  assert.match(sql, /add column if not exists title text/);
  assert.match(sql, /writing_assignment_groups_title_check/);
  assert.match(sql, /add column if not exists sort_order integer/);
  assert.match(sql, /writing_assignment_students_sort_order_check/);
  // Re-running Phase A on a production state that already applied the previous
  // Phase A (columns, constraints, 3-arg RPC and 4-arg RPC exist) must stay
  // safe: no drops and no revokes of either legacy overload.
  assert.doesNotMatch(sql, /drop function/i);
  assert.doesNotMatch(sql, /revoke all on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\]\)/);
  assert.doesNotMatch(sql, /revoke all on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\)/);
  assert.match(sql, /grant execute on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\]\)[\s\S]{0,40}to service_role/);
  // The previous Phase A 4-arg overload is re-granted only when it exists.
  assert.match(sql, /to_regprocedure\([\s\S]{0,20}'public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\)'/);
  assert.match(sql, /grant execute on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\) to service_role/);
  // The new RPC takes the base title, resolves the automatic sequence itself
  // and writes the final title with the group row.
  assert.match(sql, /create or replace function public\.create_writing_assignment_group\(\s*\n\s*p_teacher_id uuid,\s*\n\s*p_assignments jsonb,\s*\n\s*p_student_ids uuid\[\],\s*\n\s*p_title text,\s*\n\s*p_title_is_automatic boolean/);
  assert.match(sql, /insert into public\.writing_assignment_groups \(teacher_id, title\)/);
  assert.match(sql, /values \(p_teacher_id, final_title\)/);
  // Automatic numbering runs in the same transaction, keyed by teacher + base
  // title, and is serialized so concurrent creates cannot share a number.
  assert.match(sql, /coalesce\(p_title_is_automatic, false\)/);
  assert.match(sql, /pg_advisory_xact_lock\(/);
  assert.match(sql, /hashtextextended\(p_teacher_id::text \|\| '\|' \|\| base_title, 0\)/);
  assert.match(sql, /bool_or\(group_row\.title = base_title\)/);
  assert.match(sql, /substring\(group_row\.title from ' \\\(\(\\d\+\)\\\)\$'\)/);
  assert.match(sql, /generate_series\(2, greatest\(max_sequence, 1\) \+ 1\)/);
  assert.match(sql, /item\.deleted_at is null/);
  assert.match(sql, /'title', final_title/);
  // Recipient order is written in the same transaction from the payload order.
  assert.match(sql, /insert into public\.writing_assignment_students \(assignment_id, student_id, sort_order\)/);
  assert.match(sql, /unnest\(p_student_ids\) with ordinality/);
  assert.match(sql, /grant execute on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean\)[\s\S]{0,40}to service_role/);
});

test("phase B cleanup drops both legacy overloads after verifying the new one", () => {
  const cleanup = source("supabase/writing_assignment_group_titles_cleanup.sql");
  const phaseA = source("supabase/writing_assignment_group_titles.sql");
  // Both the original 3-argument and the previous Phase A 4-argument overload
  // are removed; only the 5-argument version survives.
  assert.match(cleanup, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\]\);/);
  assert.match(cleanup, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\);/);
  assert.doesNotMatch(cleanup, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean\)/);
  // Execute privileges of both legacy overloads are explicitly cleared.
  assert.match(cleanup, /revoke all on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\]\) from public, anon, authenticated, service_role/);
  assert.match(cleanup, /revoke all on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\) from public, anon, authenticated, service_role/);
  // The cleanup must first require the Phase A 5-argument function and then
  // confirm only that overload remains.
  assert.match(cleanup, /pronargs = 5/);
  assert.match(cleanup, /five_arg_count <> 1/);
  assert.match(cleanup, /to_regprocedure\(/);
  assert.match(cleanup, /grant execute on function public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean\)[\s\S]{0,40}to service_role/);
  // The two phases are separate files, not one transaction.
  assert.ok(cleanup !== phaseA);
});

test("creation route sends p_title and has no post-create title or order patch", () => {
  const route = source("app/api/teacher/writing/assignments/route.ts");
  assert.match(route, /p_title: groupTitle/);
  assert.match(route, /p_title_is_automatic: titleIsAutomatic/);
  assert.match(route, /body\.titleIsAutomatic === true/);
  assert.match(route, /typeof data\.title === "string"/);
  assert.match(route, /if \(!groupTitle\) return invalid\("请填写作业标题。"\)/);
  assert.match(route, /"Assignment title is too long": "作业标题不能超过 120 个字。"/);
  assert.doesNotMatch(route, /group_title_update_failed/);
  assert.doesNotMatch(route, /recipient_order_update_failed/);
  assert.doesNotMatch(route, /\.update\(\{ title: groupTitle \}\)/);
  assert.doesNotMatch(route, /\.upsert\(memberRows/);
});

test("separate creation actions never merge into one group, even for the same question", () => {
  const route = source("app/api/teacher/writing/assignments/route.ts");
  const sql = source("supabase/writing_assignment_groups.sql");
  const lib = source("lib/writingAssignments.ts");
  // Every POST creates a fresh group through the RPC; nothing looks up or
  // reuses an existing group by question.
  assert.match(route, /\.rpc\("create_writing_assignment_group"/);
  assert.match(sql, /insert into public\.writing_assignment_groups \(teacher_id\)/);
  assert.doesNotMatch(sql, /from public\.writing_assignment_groups[\s\S]{0,120}where/);
  // Both ends collapse cards only by group_id, never by question_id.
  const grouping = lib.slice(
    lib.indexOf("function groupAssignmentsByCollection"),
    lib.indexOf("return grouped;", lib.indexOf("function groupAssignmentsByCollection"))
  );
  assert.ok(grouping.length > 0);
  assert.match(grouping, /assignment\.group_id/);
  assert.doesNotMatch(grouping, /question_id/);
  const teacherGrouping = lib.slice(
    lib.indexOf("export function groupTeacherWritingAssignments"),
    lib.indexOf("return entries;", lib.indexOf("export function groupTeacherWritingAssignments"))
  );
  const studentGrouping = lib.slice(
    lib.indexOf("export function groupStudentWritingAssignments"),
    lib.indexOf("return entries;", lib.indexOf("export function groupStudentWritingAssignments"))
  );
  assert.ok(teacherGrouping.length > 0);
  assert.ok(studentGrouping.length > 0);
  assert.doesNotMatch(teacherGrouping, /question_id/);
  assert.doesNotMatch(studentGrouping, /question_id/);
});

test("one-time multi-student creation keeps the selected recipient order", () => {
  const route = source("app/api/teacher/writing/assignments/route.ts");
  const sql = source("supabase/writing_assignment_group_titles.sql");
  // The RPC stores the payload order, and the list only reads it back for the
  // card's first recipient.
  assert.match(sql, /min\(ordinality\)::integer as position/);
  assert.match(route, /loadWritingAssignmentRecipientOrders/);
  assert.match(route, /recipientOrders\.get\(/);
});

test("upgrade path from a production state that already ran the previous Phase A", () => {
  const phaseA = source("supabase/writing_assignment_group_titles.sql");
  const cleanup = source("supabase/writing_assignment_group_titles_cleanup.sql");
  // Re-running Phase A must not touch the existing 3-arg and 4-arg overloads.
  assert.doesNotMatch(phaseA, /drop function/i);
  assert.match(phaseA, /to_regprocedure\(\s*\n?\s*'public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\)'/);
  // Groups created while the 4-argument RPC was live stored the bare base
  // title, so numbering continues at (2) once the 5-argument code is live.
  assert.equal(
    nextWritingAssignmentAutoTitle("张三 2026-09-22", ["张三 2026-09-22"]),
    "张三 2026-09-22 (2)"
  );
  // Phase B removes the 4-argument intermediate overload as well.
  assert.match(cleanup, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text\);/);
  assert.match(cleanup, /pronargs = 5/);
  assert.match(cleanup, /total_count <> 1 or five_arg_count <> 1/);
});

test("backfill verification SQL is read-only and mirrors the applied plan", () => {
  const verify = source("supabase/writing_assignment_group_title_backfill_verify.sql");
  const apply = source("supabase/writing_assignment_group_title_backfill_apply.sql");
  // Read-only: no write keyword may appear outside a SQL line comment.
  const stripped = verify.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\b(update|delete|drop|alter|insert|truncate|grant|revoke)\b/i);
  assert.match(verify, /^with writing_assignment_group_title_expected/m);
  assert.match(verify, /select check_name, status, detail\s*\nfrom checks/);
  // VALUES literals infer text, so the ids must be cast before joining or
  // comparing with writing_assignment_groups.group_id uuid.
  assert.match(verify, /expected_groups as \(/);
  assert.match(verify, /expected\.group_id::uuid as group_id_uuid/);
  assert.match(verify, /join live on live\.group_id = expected_groups\.group_id_uuid/);
  // The expected plan is copied verbatim from the confirmed apply SQL.
  const applyValues = apply
    .split("\n")
    .filter((line) => /^  \('/.test(line))
    .map((line) => line.replace(/;\s*$/, ""));
  const verifyValues = verify.split("\n").filter((line) => /^  \('/.test(line));
  assert.equal(verifyValues.length, 25);
  assert.deepEqual(verifyValues, applyValues);
  // The three untouched groups and the pre-Phase-B RPC state are checked.
  for (const groupId of [
    "4acbaf65-3136-49ce-a1b5-69a479466577",
    "456e91b2-1e29-4c7f-9763-64e64c06c87f",
    "913f7fc7-ca4d-4562-b901-90b0a44e845f"
  ]) {
    assert.match(verify, new RegExp(groupId));
  }
  assert.match(verify, /pronargs = 3/);
  assert.match(verify, /pronargs = 4/);
  assert.match(verify, /pronargs = 5/);
});

test("student day list renders one collection card for a mixed group and keeps item question titles", () => {
  const ui = source("components/student/StudentWritingAssignments.tsx");
  assert.match(ui, /groupStudentWritingAssignments/);
  assert.match(ui, /<StudentWritingAssignmentGroupCard/);
  assert.match(ui, /questionTitleOnly/);
  assert.match(ui, /writingAssignmentQuestionDisplayTitle/);
  assert.match(ui, /writingAssignmentTaskTypeBadges/);
  assert.doesNotMatch(ui, /writingAssignmentTaskTypeLabels/);
  const batchSection = ui.match(
    /export function StudentWritingAssignmentCollectionDetail[\s\S]*?function StudentWritingAssignmentGroupCard/
  )?.[0] ?? "";
  assert.match(batchSection, /questionTitleOnly/);
});

test("auto title sequence parser only accepts the base title and `(n)` suffixes", () => {
  const base = "张三 2026-09-22";
  assert.equal(writingAssignmentAutoTitleSequence(base, base), 1);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (2)", base), 2);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (12)", base), 12);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 补充", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (自定义)", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (2) extra", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (1)", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-22 (0)", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("张三 2026-09-23", base), null);
  assert.equal(writingAssignmentAutoTitleSequence("李四 2026-09-22", base), null);
});

test("next auto title appends the smallest free sequence and reuses gaps", () => {
  const base = "张三 2026-09-22";
  assert.equal(nextWritingAssignmentAutoTitle(base, []), base);
  assert.equal(nextWritingAssignmentAutoTitle(base, [null, undefined, ""]), base);
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base]),
    "张三 2026-09-22 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base, "张三 2026-09-22 (2)"]),
    "张三 2026-09-22 (3)"
  );
  // A gap from a deleted middle assignment is reused, never skipped.
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base, "张三 2026-09-22 (3)"]),
    "张三 2026-09-22 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [
      base,
      "张三 2026-09-22 (2)",
      "张三 2026-09-22 (3)"
    ]),
    "张三 2026-09-22 (4)"
  );
  // Similar teacher-written titles never occupy an auto sequence.
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base, "张三 2026-09-22 补充"]),
    "张三 2026-09-22 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle(base, ["张三 2026-09-22 (2) 备注"]),
    base
  );
});

test("multi-student auto titles number their own base independently", () => {
  assert.equal(
    nextWritingAssignmentAutoTitle("张三等 2026-09-22", ["张三等 2026-09-22"]),
    "张三等 2026-09-22 (2)"
  );
  // Changing the first selected student changes the base and starts over.
  assert.equal(
    nextWritingAssignmentAutoTitle("李四等 2026-09-22", ["张三等 2026-09-22"]),
    "李四等 2026-09-22"
  );
});

test("a mixed Email + AD group occupies exactly one auto sequence", () => {
  const base = "彭钰杰等 2026-09-22";
  // The list carries one row per item, so the same group title appears twice.
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base, base, base]),
    "彭钰杰等 2026-09-22 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle(base, [base, base, `${base} (2)`, `${base} (2)`]),
    "彭钰杰等 2026-09-22 (3)"
  );
});

test("manual titles bypass automatic numbering entirely", () => {
  const form = source("components/teacher/TeacherWritingAssignmentForm.tsx");
  const createForm = form.match(
    /function TeacherWritingAssignmentCreateForm[\s\S]*?(?=function TeacherWritingAssignmentEditForm)/
  )?.[0] ?? "";
  assert.match(
    createForm,
    /assignmentTitleManuallyEdited\s*\n?\s*\?\s*assignmentTitle\s*\n?\s*:\s*nextWritingAssignmentAutoTitle/
  );
  // The route only numbers when the client explicitly marks the title as auto.
  const route = source("app/api/teacher/writing/assignments/route.ts");
  assert.match(route, /const titleIsAutomatic = body\.titleIsAutomatic === true/);
});

test("the form previews the numbered candidate but submits the base title", () => {
  const form = source("components/teacher/TeacherWritingAssignmentForm.tsx");
  const createForm = form.match(
    /function TeacherWritingAssignmentCreateForm[\s\S]*?(?=function TeacherWritingAssignmentEditForm)/
  )?.[0] ?? "";
  assert.match(createForm, /nextWritingAssignmentAutoTitle/);
  assert.match(createForm, /TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY/);
  assert.match(createForm, /assignment\.group_title/);
  assert.match(createForm, /value=\{candidateAssignmentTitle\}/);
  // Manual editing flips the explicit payload flag; the title itself is never
  // patched after creation.
  assert.match(createForm, /titleIsAutomatic: !assignmentTitleManuallyEdited/);
  assert.match(createForm, /setAssignmentTitleManuallyEdited\(true\)/);
});

test("the historical dry-run numbers safe groups by creation time inside each teacher", () => {
  const sql = source("supabase/writing_assignment_group_title_backfill_dry_run.sql");
  assert.match(sql, /base_auto_title text/);
  assert.match(sql, /auto_title_sequence integer/);
  assert.match(sql, /row_number\(\) over \(/);
  assert.match(sql, /partition by teacher_id, base_auto_title/);
  assert.match(sql, /order by created_at, group_id/);
  assert.match(sql, /where can_auto_update/);
  assert.match(sql, /plan\.base_auto_title \|\| ' \(' \|\| numbered\.sequence \|\| '\)'/);
  // Unsafe rows keep a null base title and never enter the numbering window.
  assert.match(sql, /'456e91b2-1e29-4c7f-9763-64e64c06c87f'[^)]*null, '蒋卓成'/);
  assert.match(sql, /'4acbaf65-3136-49ce-a1b5-69a479466577'[^)]*null, 'admin'/);
});
