import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  accountBaseFromStudentName,
  studentAccountCandidates
} from "../lib/studentAccountSuggestion.ts";
import {
  isStudentAccountAvailable,
  resolveAvailableStudentAccount
} from "../lib/studentAccountAvailability.server.ts";
import { createTeacherStudentAccount } from "../lib/teacherStudentAccount.server.ts";
import { selectableClassSubjects } from "../lib/teacherClasses.ts";
import {
  bindTeacherToClass,
  listTeacherClasses,
  loadTeacherClassRow,
  searchTeacherClasses
} from "../lib/teacherClassSharing.server.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

const MISSING_ACCOUNT_RPC = {
  message: "Could not find the function public.first_available_student_account(p_base) in the schema cache"
};

function createAccountDb({ tables = {}, rpc, createUser } = {}) {
  const db = createMockSupabase(tables, rpc ? { rpc } : {});
  const createCalls = [];
  const deleteCalls = [];
  db.auth = {
    admin: {
      createUser: async (attributes) => {
        createCalls.push(attributes);
        if (createUser) return createUser(attributes, createCalls.length);
        return {
          data: {
            user: {
              id: `user-${createCalls.length}`,
              user_metadata: attributes.user_metadata
            }
          },
          error: null
        };
      },
      deleteUser: async (userId) => {
        deleteCalls.push(userId);
        return { data: {}, error: null };
      }
    }
  };
  return { db, createCalls, deleteCalls };
}

function accountTables(extraProfiles = []) {
  return {
    profiles: [
      {
        id: "teacher-a",
        role: "teacher",
        is_active: true,
        email: "teachera@bas.com",
        full_name: "栗科",
        owner_id: null,
        student_account_limit: 20
      },
      ...extraProfiles
    ],
    teacher_student_bindings: []
  };
}

function classTables() {
  return {
    profiles: [
      { id: "teacher-a", email: "teachera@bas.com", full_name: "栗科" },
      { id: "teacher-b", email: "teacherb@bas.com", full_name: "曾焱" }
    ],
    teacher_classes: [
      {
        class_id: "class-a",
        teacher_id: "teacher-a",
        name: "周六托福阅读A班",
        subjects: ["reading"],
        created_at: "2026-10-01T00:00:00.000Z",
        class_members: [{ count: 3 }]
      },
      {
        class_id: "class-b",
        teacher_id: "teacher-b",
        name: "周六托福写作B班",
        subjects: ["reading", "writing"],
        created_at: "2026-10-02T00:00:00.000Z",
        class_members: [{ count: 0 }]
      },
      {
        class_id: "class-c",
        teacher_id: "teacher-b",
        name: "周日雅思班",
        subjects: ["reading"],
        created_at: "2026-10-03T00:00:00.000Z",
        class_members: [{ count: 5 }]
      }
    ],
    teacher_class_bindings: [
      { class_id: "class-b", teacher_id: "teacher-a", subjects: ["writing"] }
    ]
  };
}

// ---------------------------------------------------------------------------
// 教师 × 班级 × 科目：共享班级 fixture + 与 SQL 语义一致的 RPC stub
// ---------------------------------------------------------------------------

/** 班级 0417 场景：A(栗科) owner 教阅读，B(曾焱) 是写作教师。 */
function sharedClassTables({ ownerSubject = "reading", memberIds = ["s1", "s2", "s3"] } = {}) {
  return {
    profiles: [
      { id: "teacher-a", role: "teacher", is_active: true, email: "a@bas.com", full_name: "栗科" },
      { id: "teacher-b", role: "teacher", is_active: true, email: "b@bas.com", full_name: "曾焱" },
      ...memberIds.map((id, index) => ({
        id,
        role: "student",
        is_active: true,
        email: `${id}@bas.com`,
        full_name: `学生${index + 1}`
      }))
    ],
    teacher_classes: [
      {
        class_id: "class-0417",
        teacher_id: "teacher-a",
        name: "TFQ0417 中级提高班",
        subjects: [ownerSubject],
        created_at: "2026-10-01T00:00:00.000Z",
        class_members: [{ count: memberIds.length }]
      }
    ],
    teacher_class_bindings: [],
    teacher_student_bindings: memberIds.map((studentId) => ({
      teacher_id: "teacher-a",
      student_id: studentId,
      domain: ownerSubject
    })),
    class_members: memberIds.map((studentId) => ({
      class_id: "class-0417",
      student_id: studentId
    }))
  };
}

/**
 * In-memory emulation of the fixed bind_teacher_to_class RPC:
 *   * non-owner link: union the caller's own subjects, insert link if new;
 *   * backfill ONLY the caller's teacher_student_bindings;
 *   * owner: union the class subjects without touching links.
 * Mirrors the migration, so the helper-level cases exercise the same rules.
 */
function bindRpcStub(calls = []) {
  return (fn, args, tables) => {
    if (fn !== "bind_teacher_to_class") {
      return { data: null, error: { message: `rpc ${fn} is not stubbed` } };
    }
    calls.push(args);
    const classRow = (tables.teacher_classes ?? []).find(
      (row) => row.class_id === args.p_class_id
    );
    if (!classRow) return { data: null, error: { message: "CLASS_NOT_FOUND" } };
    const subjects = Array.from(new Set(args.p_subjects ?? [])).sort();
    if (
      subjects.length === 0 ||
      subjects.length > 2 ||
      subjects.some((domain) => domain !== "reading" && domain !== "writing")
    ) {
      return { data: null, error: { message: "INVALID_SUBJECTS" } };
    }

    let linked = false;
    let effectiveSubjects = subjects;
    if (classRow.teacher_id === args.p_teacher_id) {
      classRow.subjects = Array.from(
        new Set([...(classRow.subjects ?? []), ...subjects])
      ).sort();
      effectiveSubjects = classRow.subjects;
    } else {
      const links =
        tables.teacher_class_bindings ?? (tables.teacher_class_bindings = []);
      const existing = links.find(
        (row) => row.class_id === args.p_class_id && row.teacher_id === args.p_teacher_id
      );
      if (existing) {
        existing.subjects = Array.from(
          new Set([...(existing.subjects ?? []), ...subjects])
        ).sort();
        effectiveSubjects = existing.subjects;
      } else {
        links.push({
          class_id: args.p_class_id,
          teacher_id: args.p_teacher_id,
          subjects
        });
        linked = true;
      }
    }

    const bindings =
      tables.teacher_student_bindings ?? (tables.teacher_student_bindings = []);
    const members = (tables.class_members ?? []).filter(
      (row) => row.class_id === args.p_class_id
    );
    let bindingsInserted = 0;
    for (const member of members) {
      for (const domain of subjects) {
        const exists = bindings.some(
          (row) =>
            row.teacher_id === args.p_teacher_id &&
            row.student_id === member.student_id &&
            row.domain === domain
        );
        if (!exists) {
          bindings.push({
            teacher_id: args.p_teacher_id,
            student_id: member.student_id,
            domain
          });
          bindingsInserted += 1;
        }
      }
    }

    return {
      data: {
        class_id: args.p_class_id,
        linked,
        bindings_inserted: bindingsInserted,
        subjects: effectiveSubjects,
        member_count: members.length
      },
      error: null
    };
  };
}

function callerBindings(tables, teacherId) {
  return (tables.teacher_student_bindings ?? [])
    .filter((row) => row.teacher_id === teacherId)
    .map((row) => `${row.student_id}:${row.domain}`)
    .sort();
}

function rpcBlock(sql, name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
  );
  const match = sql.match(pattern);
  assert.ok(match, `${name} must be defined in the migration`);
  return match[0];
}

function functionOverload(sql, name, signatureFragment) {
  const blocks =
    sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "g")) ?? [];
  const match = blocks.find((block) => signatureFragment.test(block));
  assert.ok(match, `${name} overload ${signatureFragment} must be defined`);
  return match;
}

// ---------------------------------------------------------------------------
// 新增学生：拼音账号 + 冲突后缀
// ---------------------------------------------------------------------------

test("Chinese names convert to full lowercase pinyin accounts", async () => {
  assert.equal(accountBaseFromStudentName("张三"), "zhangsan");
  assert.equal(accountBaseFromStudentName("李小明"), "lixiaoming");
  assert.equal(accountBaseFromStudentName("王一"), "wangyi");
  assert.equal(accountBaseFromStudentName("欧阳娜娜"), "ouyangnana");
  assert.equal(accountBaseFromStudentName(" 李 小明 "), "lixiaoming");
  assert.equal(accountBaseFromStudentName("Ava Chen"), "avachen");
  assert.equal(accountBaseFromStudentName("Alex"), "alex");
  assert.equal(accountBaseFromStudentName("王一2"), "wangyi2");
  const component = await read("components/TeacherCreateStudent.tsx");
  assert.match(component, /accountBaseFromStudentName\(value\)/);
});

test("account resolution prefers the SQL namespace RPC and falls back before migration", async () => {
  const viaRpc = createMockSupabase({}, {
    rpc: () => ({ data: "zhangsan3", error: null })
  });
  assert.equal(await resolveAvailableStudentAccount(viaRpc, "zhangsan"), "zhangsan3");
  assert.equal(await resolveAvailableStudentAccount(viaRpc, ""), null);

  const fallback = createMockSupabase({
    profiles: [
      { id: "s1", email: "zhangsan@bas.com" },
      { id: "s2", email: "zhangsan2@bas.com" },
      { id: "s3", email: "zhangsanabc@bas.com" }
    ]
  }, {
    rpc: () => ({ data: null, error: MISSING_ACCOUNT_RPC })
  });
  assert.equal(await resolveAvailableStudentAccount(fallback, "zhangsan"), "zhangsan3");
  assert.equal(
    await resolveAvailableStudentAccount(fallback, "zhangsan2"),
    "zhangsan22"
  );
});

test("manual accounts are checked against the real namespace for the exact account", async () => {
  const free = createMockSupabase({}, { rpc: () => ({ data: "lisi", error: null }) });
  assert.equal(await isStudentAccountAvailable(free, "LiSi"), true);

  const taken = createMockSupabase({}, { rpc: () => ({ data: "lisi2", error: null }) });
  assert.equal(await isStudentAccountAvailable(taken, "lisi"), false);
  // Invalid input is never reported as available.
  assert.equal(await isStudentAccountAvailable(taken, "学生"), false);
  assert.equal(await isStudentAccountAvailable(taken, "admin"), false);
});

test("new student accounts always use the server-side initial password 123456", async () => {
  const tables = accountTables();
  const { db, createCalls } = createAccountDb({ tables });
  const result = await createTeacherStudentAccount(db, {
    actorId: "teacher-a",
    actorRole: "teacher",
    account: "wangyi",
    studentName: "王一",
    domains: ["reading", "writing"],
    confirmDuplicateName: true,
    autoSuffix: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.student.account, "wangyi");
  assert.deepEqual(result.student.domains, ["reading", "writing"]);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].password, "123456");
  assert.equal(createCalls[0].email, "wangyi@bas.com");
  const profile = tables.profiles.find((row) => row.email === "wangyi@bas.com");
  assert.equal(profile.owner_id, "teacher-a");
  assert.deepEqual(
    tables.teacher_student_bindings.map((row) => row.domain).sort(),
    ["reading", "writing"]
  );
});

test("a taken auto-generated account receives the next free numeric suffix", async () => {
  const tables = accountTables([
    {
      id: "zhangsan-1",
      role: "student",
      is_active: true,
      email: "zhangsan@bas.com",
      full_name: "张三",
      owner_id: "teacher-a"
    }
  ]);
  const { db, createCalls } = createAccountDb({
    tables,
    rpc: () => ({ data: "zhangsan2", error: null })
  });
  const result = await createTeacherStudentAccount(db, {
    actorId: "teacher-a",
    actorRole: "teacher",
    account: "zhangsan",
    studentName: "张三",
    domains: ["reading"],
    confirmDuplicateName: true,
    autoSuffix: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.student.account, "zhangsan2");
  assert.equal(createCalls[0].email, "zhangsan2@bas.com");
});

test("consecutive conflicts increment to zhangsan3 instead of failing", async () => {
  const tables = accountTables([
    { id: "s1", role: "student", is_active: true, email: "zhangsan@bas.com", full_name: "张三", owner_id: "teacher-b" },
    { id: "s2", role: "student", is_active: true, email: "zhangsan2@bas.com", full_name: "张三", owner_id: "teacher-b" }
  ]);
  const { db, createCalls } = createAccountDb({
    tables,
    // The SQL resolver checks auth.users + profiles and returns the next free.
    rpc: () => ({ data: "zhangsan3", error: null })
  });
  const result = await createTeacherStudentAccount(db, {
    actorId: "teacher-a",
    actorRole: "teacher",
    account: "zhangsan",
    studentName: "张三",
    domains: ["writing"],
    confirmDuplicateName: true,
    autoSuffix: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.student.account, "zhangsan3");
  assert.equal(createCalls[0].email, "zhangsan3@bas.com");
});

test("a manually edited taken account keeps the explicit conflict error", async () => {
  const tables = accountTables([
    { id: "zhangsan-1", role: "student", is_active: true, email: "zhangsan@bas.com", full_name: "张三", owner_id: "teacher-b" }
  ]);
  const { db, createCalls } = createAccountDb({ tables, rpc: () => ({ data: "zhangsan2", error: null }) });
  const result = await createTeacherStudentAccount(db, {
    actorId: "teacher-a",
    actorRole: "teacher",
    account: "zhangsan",
    studentName: "张三",
    domains: ["reading"],
    confirmDuplicateName: true,
    autoSuffix: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "ACCOUNT_EXISTS_SAME_NAME");
  assert.equal(createCalls.length, 0);
});

test("a concurrent Auth conflict is retried with the next suffix from the original base", async () => {
  const tables = accountTables();
  const { db, createCalls } = createAccountDb({
    tables,
    rpc: () => ({ data: "zhangsan2", error: null }),
    createUser: (attributes, attempt) =>
      attempt === 1
        ? { data: { user: null }, error: { message: "User already registered" } }
        : {
            data: {
              user: { id: "user-2", user_metadata: attributes.user_metadata }
            },
            error: null
          }
  });
  const result = await createTeacherStudentAccount(db, {
    actorId: "teacher-a",
    actorRole: "teacher",
    account: "zhangsan",
    studentName: "张三",
    domains: ["reading"],
    confirmDuplicateName: true,
    autoSuffix: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.student.account, "zhangsan2");
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[1].email, "zhangsan2@bas.com");
});

test("admin creation keeps the same password rule without auto-suffix", async () => {
  const tables = accountTables([{ id: "admin-1", role: "admin", is_active: true, email: "student@test.com", full_name: "平台管理员", owner_id: null }]);
  const { db, createCalls } = createAccountDb({ tables });
  const result = await createTeacherStudentAccount(db, {
    actorId: "admin-1",
    actorRole: "admin",
    account: "jiazhang",
    studentName: "家长测试",
    autoSuffix: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.student.domains, []);
  assert.equal(createCalls[0].password, "123456");
  assert.equal(tables.teacher_student_bindings.length, 0);
});

test("suffix candidates stay base, base2, base3 in order", () => {
  assert.deepEqual(studentAccountCandidates("zhangsan").slice(0, 4), [
    "zhangsan",
    "zhangsan2",
    "zhangsan3",
    "zhangsan4"
  ]);
});

// ---------------------------------------------------------------------------
// 绑定学生/班级：搜索 + 绑定
// ---------------------------------------------------------------------------

test("class search matches partial names, ignores case for letters, and trims", async () => {
  const db = createMockSupabase(classTables());

  const ids = async (query) =>
    (await searchTeacherClasses(db, "teacher-a", query)).map((entry) => entry.class_id).sort();

  assert.deepEqual(await ids("周六"), ["class-a", "class-b"]);
  assert.deepEqual(await ids("托福"), ["class-a", "class-b"]);
  assert.deepEqual(await ids("阅读"), ["class-a"]);
  assert.deepEqual(await ids("A班"), ["class-a"]);
  assert.deepEqual(await ids("a班"), ["class-a"]);
  assert.deepEqual(await ids("  周六  "), ["class-a", "class-b"]);
  assert.deepEqual(await ids("雅思"), ["class-c"]);
  assert.deepEqual(await ids(""), []);
  assert.deepEqual(await ids("   "), []);
  assert.equal((await searchTeacherClasses(db, "teacher-a", "周六", 1)).length, 1);
});

test("class search reports the real class id, count, subjects and bound state", async () => {
  const db = createMockSupabase(classTables());
  const results = await searchTeacherClasses(db, "teacher-a", "class");
  assert.deepEqual(results, []);
  const all = await searchTeacherClasses(db, "teacher-a", "班");
  const byId = new Map(all.map((entry) => [entry.class_id, entry]));
  // Same-name classes are never merged: every row keeps its own class_id.
  assert.equal(all.length, 3);
  assert.deepEqual(byId.get("class-a"), {
    class_id: "class-a",
    name: "周六托福阅读A班",
    subjects: ["reading"],
    bound_subjects: ["reading"],
    teachers: [
      { teacherId: "teacher-a", teacherName: "栗科", isOwner: true, domains: ["reading"] }
    ],
    member_count: 3,
    bound: true
  });
  // class-b: teacher-a is only linked with Writing. The class-wide union stays
  // visible, while the CURRENT teacher's bound subjects are only Writing, and
  // BOTH already-bound teachers (owner 曾焱 + linked 栗科) are listed.
  assert.deepEqual(byId.get("class-b"), {
    class_id: "class-b",
    name: "周六托福写作B班",
    subjects: ["reading", "writing"],
    bound_subjects: ["writing"],
    teachers: [
      {
        teacherId: "teacher-b",
        teacherName: "曾焱",
        isOwner: true,
        domains: ["reading", "writing"]
      },
      { teacherId: "teacher-a", teacherName: "栗科", isOwner: false, domains: ["writing"] }
    ],
    member_count: 0,
    bound: true
  });
  assert.deepEqual(byId.get("class-c"), {
    class_id: "class-c",
    name: "周日雅思班",
    subjects: ["reading"],
    bound_subjects: [],
    teachers: [
      { teacherId: "teacher-b", teacherName: "曾焱", isOwner: true, domains: ["reading"] }
    ],
    member_count: 5,
    bound: false
  });
});

test("class search de-duplicates an owner that also holds a link row", async () => {
  const tables = classTables();
  // The owner gets a link row too (legacy data / direct API): the teacher must
  // still be displayed exactly once, with the union of both subject sources.
  tables.teacher_class_bindings.push({
    class_id: "class-a",
    teacher_id: "teacher-a",
    subjects: ["writing"]
  });
  const db = createMockSupabase(tables);
  const results = await searchTeacherClasses(db, "teacher-b", "阅读A班");
  assert.equal(results.length, 1);
  const [entry] = results;
  const ownerRows = entry.teachers.filter((teacher) => teacher.teacherId === "teacher-a");
  assert.equal(ownerRows.length, 1);
  assert.deepEqual(ownerRows[0], {
    teacherId: "teacher-a",
    teacherName: "栗科",
    isOwner: true,
    domains: ["reading", "writing"]
  });
});

test("displaying the bound teachers never changes which subjects the viewer can bind", async () => {
  const tables = sharedClassTables();
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  // A owns Reading. B searches: A is displayed, yet B can still choose BOTH
  // subjects (no subject is disabled just because another teacher holds it).
  await bindTeacherToClass(db, "teacher-a", "class-0417", ["reading"]);
  const [viewerB] = await searchTeacherClasses(db, "teacher-b", "0417");
  assert.deepEqual(
    viewerB.teachers.map((teacher) => `${teacher.teacherName}:${teacher.domains.join("+")}`),
    ["栗科:reading"]
  );
  assert.deepEqual(viewerB.bound_subjects, []);
  assert.deepEqual(selectableClassSubjects(viewerB.bound_subjects), ["reading", "writing"]);

  // A (Reading) + B (Writing) are both displayed to a fresh teacher C, and C
  // still has both subjects selectable.
  await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);
  const [viewerC] = await searchTeacherClasses(db, "teacher-c", "0417");
  assert.deepEqual(
    viewerC.teachers.map((teacher) => `${teacher.teacherName}:${teacher.domains.join("+")}`),
    ["栗科:reading", "曾焱:writing"]
  );
  assert.deepEqual(viewerC.bound_subjects, []);
  assert.deepEqual(selectableClassSubjects(viewerC.bound_subjects), ["reading", "writing"]);

  // The current teacher only disables what THEY already hold: B holds Writing,
  // so Writing is not selectable again while Reading stays available.
  const [viewerBAfter] = await searchTeacherClasses(db, "teacher-b", "0417");
  assert.deepEqual(viewerBAfter.bound_subjects, ["writing"]);
  assert.deepEqual(selectableClassSubjects(viewerBAfter.bound_subjects), ["reading"]);
});

test("shared classes appear in the teacher class list without disturbing owned classes", async () => {
  const db = createMockSupabase(classTables());
  const classes = await listTeacherClasses(db, "teacher-a");
  assert.deepEqual(classes.map((entry) => entry.class_id), ["class-b", "class-a"]);
  assert.equal(classes.find((entry) => entry.class_id === "class-a").member_count, 3);
  assert.equal(classes.find((entry) => entry.class_id === "class-b").member_count, 0);
});

test("loadTeacherClassRow accepts the owner and a linked teacher, nobody else", async () => {
  const db = createMockSupabase(classTables());
  assert.equal((await loadTeacherClassRow(db, "teacher-a", "class-a")).class_id, "class-a");
  assert.equal((await loadTeacherClassRow(db, "teacher-a", "class-b")).class_id, "class-b");
  assert.equal(await loadTeacherClassRow(db, "teacher-a", "class-c"), null);
  assert.equal(await loadTeacherClassRow(db, "teacher-b", "class-a"), null);
});

test("binding a class is idempotent and reports the created binding count", async () => {
  const tables = sharedClassTables();
  const calls = [];
  const db = createMockSupabase(tables, { rpc: bindRpcStub(calls) });

  const first = await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyBound, false);
  assert.equal(first.createdBindingCount, 3);
  assert.deepEqual(first.subjects, ["writing"]);
  assert.equal(first.class.class_id, "class-0417");
  assert.equal(first.class.member_count, 3);
  assert.deepEqual(calls[0].p_subjects, ["writing"]);

  const repeated = await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadyBound, true);
  assert.equal(repeated.createdBindingCount, 0);
  assert.deepEqual(repeated.subjects, ["writing"]);
  assert.deepEqual(
    tables.teacher_student_bindings.filter((row) => row.teacher_id === "teacher-b").length,
    3
  );
  assert.equal(
    tables.teacher_class_bindings.filter(
      (row) => row.class_id === "class-0417" && row.teacher_id === "teacher-b"
    ).length,
    1
  );
});

// ---------------------------------------------------------------------------
// Case 1–5：教师 × 班级 × 科目 绑定回归
// ---------------------------------------------------------------------------

test("Case 1: teacher B binds Writing on an A-Reading class without touching A", async () => {
  const tables = sharedClassTables();
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  // B searches 0417 first: the class shows Reading (owner) but B has nothing.
  const [before] = await searchTeacherClasses(db, "teacher-b", "0417");
  assert.equal(before.bound, false);
  assert.deepEqual(before.subjects, ["reading"]);
  assert.deepEqual(before.bound_subjects, []);

  const bound = await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.subjects, ["writing"]);

  // A keeps exactly Reading: no link row, no class subject change, no Writing.
  assert.equal(
    tables.teacher_class_bindings.some((row) => row.teacher_id === "teacher-a"),
    false
  );
  assert.deepEqual(tables.teacher_classes[0].subjects, ["reading"]);
  assert.deepEqual(callerBindings(tables, "teacher-a"), [
    "s1:reading",
    "s2:reading",
    "s3:reading"
  ]);
  // B holds exactly the Writing bindings for every member.
  assert.deepEqual(callerBindings(tables, "teacher-b"), [
    "s1:writing",
    "s2:writing",
    "s3:writing"
  ]);

  // After binding, B's own search shows Writing as bound, class union includes both.
  const [after] = await searchTeacherClasses(db, "teacher-b", "0417");
  assert.equal(after.bound, true);
  assert.deepEqual(after.bound_subjects, ["writing"]);
  assert.deepEqual(after.subjects, ["reading", "writing"]);
  // The owner's view never gained Writing as THEIR subject (bound); the
  // class-wide union does list both because B teaches Writing in this class.
  const [ownerView] = await searchTeacherClasses(db, "teacher-a", "0417");
  assert.deepEqual(ownerView.bound_subjects, ["reading"]);
  assert.deepEqual(ownerView.subjects, ["reading", "writing"]);
});

test("Case 2: teacher B binds Reading on an A-Writing class (roles swapped)", async () => {
  const tables = sharedClassTables({ ownerSubject: "writing" });
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  const bound = await bindTeacherToClass(db, "teacher-b", "class-0417", ["reading"]);
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.subjects, ["reading"]);
  assert.deepEqual(tables.teacher_classes[0].subjects, ["writing"]);
  assert.deepEqual(callerBindings(tables, "teacher-a"), [
    "s1:writing",
    "s2:writing",
    "s3:writing"
  ]);
  assert.deepEqual(callerBindings(tables, "teacher-b"), [
    "s1:reading",
    "s2:reading",
    "s3:reading"
  ]);
});

test("Case 3: a teacher already bound to Reading can still add Writing exactly once", async () => {
  const tables = sharedClassTables();
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  const first = await bindTeacherToClass(db, "teacher-b", "class-0417", ["reading"]);
  assert.equal(first.ok, true);
  assert.deepEqual(first.subjects, ["reading"]);

  const second = await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);
  assert.equal(second.ok, true);
  assert.deepEqual(second.subjects, ["reading", "writing"]);
  assert.equal(second.createdBindingCount, 3);

  // Re-submitting Reading neither creates a second link nor duplicate rows.
  const repeated = await bindTeacherToClass(db, "teacher-b", "class-0417", ["reading"]);
  assert.equal(repeated.alreadyBound, true);
  assert.deepEqual(repeated.subjects, ["reading", "writing"]);
  assert.equal(
    tables.teacher_class_bindings.filter((row) => row.teacher_id === "teacher-b").length,
    1
  );
  assert.deepEqual(callerBindings(tables, "teacher-b"), [
    "s1:reading",
    "s1:writing",
    "s2:reading",
    "s2:writing",
    "s3:reading",
    "s3:writing"
  ]);
});

test("Case 4: one teacher's binding state never hides or pollutes another teacher", async () => {
  const tables = sharedClassTables();
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  await bindTeacherToClass(db, "teacher-b", "class-0417", ["writing"]);

  // A still sees both subjects as selectable info, but only Reading bound.
  const [ownerView] = await searchTeacherClasses(db, "teacher-a", "0417");
  assert.deepEqual(ownerView.bound_subjects, ["reading"]);
  // A brand-new teacher C sees no bound subjects in either direction.
  const [freshView] = await searchTeacherClasses(db, "teacher-c", "0417");
  assert.deepEqual(freshView.bound_subjects, []);
  assert.equal(freshView.bound, false);
  assert.deepEqual(freshView.subjects, ["reading", "writing"]);

  // B's binding stays Writing-only; A never received Writing.
  assert.deepEqual(
    Array.from(new Set(callerBindings(tables, "teacher-b").map((row) => row.split(":")[1]))),
    ["writing"]
  );
  assert.deepEqual(
    Array.from(new Set(callerBindings(tables, "teacher-a").map((row) => row.split(":")[1]))),
    ["reading"]
  );
});

test("Case 5: repeated submissions are idempotent with no duplicate bindings", async () => {
  const tables = sharedClassTables();
  const db = createMockSupabase(tables, { rpc: bindRpcStub() });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await bindTeacherToClass(db, "teacher-b", "class-0417", [
      "reading",
      "writing"
    ]);
    assert.equal(result.ok, true);
  }

  assert.equal(
    tables.teacher_class_bindings.filter((row) => row.teacher_id === "teacher-b").length,
    1
  );
  assert.equal(
    tables.teacher_student_bindings.filter((row) => row.teacher_id === "teacher-b").length,
    6
  );
  assert.deepEqual(callerBindings(tables, "teacher-a"), [
    "s1:reading",
    "s2:reading",
    "s3:reading"
  ]);
});

test("class binding maps RPC failures to safe responses", async () => {
  const notFound = createMockSupabase({}, {
    rpc: () => ({ data: null, error: { message: "CLASS_NOT_FOUND" } })
  });
  const missing = await bindTeacherToClass(notFound, "teacher-a", "class-x");
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const invalidTeacher = createMockSupabase({}, {
    rpc: () => ({ data: null, error: { message: "INVALID_TEACHER" } })
  });
  const forbidden = await bindTeacherToClass(invalidTeacher, "teacher-a", "class-x");
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);
});

// ---------------------------------------------------------------------------
// 接口与页面约束
// ---------------------------------------------------------------------------

test("bind page exposes one search box and reuses the student result card for classes", async () => {
  const page = await read("app/teacher/students/bind/page.tsx");
  assert.match(page, /title="绑定学生\/班级"/);
  assert.match(page, /subtitle="搜索已有学生或班级并建立授课绑定"/);

  const component = await read("components/teacher/TeacherBindStudent.tsx");
  assert.match(component, /绑定已有学生\/班级/);
  assert.match(component, /输入学生姓名、账号或班级名称/);
  assert.match(component, /搜索学生或班级/);
  assert.match(component, /没有找到匹配的学生或班级。/);
  assert.match(component, /\/api\/teacher\/class-bindings/);
  assert.match(component, /formatBindingDomainList\(entry\.subjects\)/);
  // The class result now shows every bound teacher (owner + links) through the
  // same 当前绑定 block the student result uses.
  assert.match(component, /function BoundTeacherList/);
  assert.match(component, /<BoundTeacherList bindings=\{student\.bindings\} \/>/);
  assert.match(component, /<BoundTeacherList bindings=\{entry\.teachers\} \/>/);
  assert.match(component, /当前绑定：/);
  assert.match(component, /entry\.teachers/);
  assert.match(component, /selectedClass\?\.bound_subjects/);
  assert.match(component, /key=\{`class:\$\{entry\.class_id\}`\}/);
  assert.match(component, /classId: selectedClass\.class_id, subjects: domains/);
  assert.match(component, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  // The class subject picker is scoped to the CURRENT teacher: every domain is
  // rendered, the ones already bound by this teacher are disabled, and the
  // submit button depends on pending (not-yet-bound) subjects — not on
  // selectedClass.bound.
  assert.match(component, /classBoundDomains/);
  assert.match(component, /classPendingDomains/);
  assert.match(component, /disabled=\{bound \|\| submitting\}/);
  assert.match(component, /allClassDomainsBound/);
  assert.match(component, /该班级的全部授课科目都已绑定。/);
  assert.doesNotMatch(component, /disabled=\{selectedClass\.bound \|\| submitting\}/);
  assert.doesNotMatch(component, /✓ \{STUDENT_BINDING_DOMAIN_LABELS\[domain\]\}（班级授课科目）/);
  // Exactly one search input: no extra box, no tab switch, no new card.
  assert.equal((component.match(/id="bind-student-query"/g) ?? []).length, 1);
  assert.doesNotMatch(component, /placeholder="输入学生姓名或学生账号"/);
  assert.doesNotMatch(component, /学生\/班级.*Tab|角色切换/);
});

test("class binding API binds the session teacher and never a client teacher id", async () => {
  const route = await read("app/api/teacher/class-bindings/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(
    route,
    /bindTeacherToClass\(\s*createServiceSupabase\(\),\s*auth\.userId,\s*classId,\s*subjects\.subjects\s*\)/
  );
  assert.match(route, /validateClassSubjects\(body\.subjects\)/);
  assert.match(route, /alreadyBound/);
  assert.doesNotMatch(route, /body\.teacherId/);
  assert.doesNotMatch(route, /student_account_limit|owner_id/);
});

test("新增学生 form removes the password field and drives the account from the name", async () => {
  const component = await read("components/TeacherCreateStudent.tsx");
  assert.doesNotMatch(component, /type="password"|student-password|setPassword/);
  assert.doesNotMatch(component, /password:/);
  assert.match(component, /ACCOUNT_CHECK_DEBOUNCE_MS/);
  assert.match(component, /accountBaseFromStudentName\(value\)/);
  assert.match(component, /accountEditedRef\.current \? \{\} : \{ autoSuffix: true \}/);
  assert.match(component, /requestId !== suggestionSeqRef\.current/);
  assert.match(component, /studentNameRef\.current\.trim\(\) !== name\.trim\(\)/);
  assert.match(component, /accountRef\.current\.trim\(\)\.toLocaleLowerCase\(\) !== requestedValue/);
  assert.match(component, /学生初始密码统一为 123456/);
  assert.match(component, /account-suggestion\?name=/);
  assert.match(component, /account-suggestion\?account=/);
});

test("create student route and helper set the password server-side only", async () => {
  const route = await read("app/api/teacher/students/route.ts");
  assert.doesNotMatch(route, /body\.password/);
  assert.match(route, /autoSuffix: body\.autoSuffix === true/);
  assert.match(route, /createTeacherStudentAccount\(supabase, \{/);

  const helper = await read("lib/teacherStudentAccount.server.ts");
  assert.match(helper, /DEFAULT_STUDENT_PASSWORD/);
  assert.doesNotMatch(helper, /input\.password/);
  assert.match(helper, /resolveAvailableStudentAccount\(supabase, baseAccount\)/);
  const availability = await read("lib/studentAccountAvailability.server.ts");
  assert.match(availability, /first_available_student_account/);
  assert.match(availability, /isMissingFunctionError/);
  assert.match(availability, /candidates\.length === 0/);
});

test("account suggestion API checks the real namespace server-side", async () => {
  const route = await read("app/api/teacher/students/account-suggestion/route.ts");
  assert.match(route, /requireUserWithRole\(bearerToken\(request\), "teacher"\)/);
  assert.match(route, /accountBaseFromStudentName\(name\)/);
  assert.match(route, /resolveAvailableStudentAccount\(supabase, base\)/);
  assert.match(route, /isStudentAccountAvailable\(supabase, prepared\.account\)/);
  assert.match(route, /adjusted: account !== base/);
  assert.doesNotMatch(route, /password/);
  assert.doesNotMatch(route, /from\(["']auth\.users/);
});

// ---------------------------------------------------------------------------
// SQL 迁移约束
// ---------------------------------------------------------------------------

test("account namespace migration checks auth.users and profiles", async () => {
  const sql = await read("supabase/student_account_namespace_20261003.sql");
  assert.match(sql, /create or replace function public\.first_available_student_account\(p_base text\)/);
  assert.match(sql, /from auth\.users auth_user/);
  assert.match(sql, /from public\.profiles profile/);
  assert.match(sql, /grant execute on function public\.first_available_student_account\(text\)\s*\n\s*to service_role/);
  assert.match(sql, /revoke all on function public\.first_available_student_account\(text\)[\s\S]{0,80}authenticated/);
});

test("multi-teacher class migration is additive and idempotent", async () => {
  const sql = await read("supabase/teacher_class_multi_teacher_binding_20261003.sql");
  assert.match(sql, /create table if not exists public\.teacher_class_bindings/);
  assert.match(sql, /primary key \(class_id, teacher_id\)/);
  assert.match(sql, /revoke all on public\.teacher_class_bindings from anon, authenticated/);
  assert.match(sql, /create or replace function public\.is_class_teacher\(p_class_id uuid, p_teacher_id uuid\)/);
  assert.match(sql, /create or replace function public\.bind_teacher_to_class\(\s*\n\s*p_teacher_id uuid,\s*\n\s*p_class_id uuid\s*\n\)/);
  assert.match(sql, /on conflict \(class_id, teacher_id\) do nothing/);
  assert.match(sql, /on conflict \(teacher_id, student_id, domain\) do nothing/);
  // Existing data stays untouched: no class ownership rewrite, no class deletion.
  assert.doesNotMatch(sql, /update public\.teacher_classes[\s\S]{0,120}set teacher_id/);
  assert.doesNotMatch(sql, /delete from public\.teacher_classes/);
  assert.match(sql, /Verification SQL/);

  // The whole migration is one transaction: BEGIN first, COMMIT after the
  // last grant, so a failed statement can never leave partial changes.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.ok(
    sql.indexOf("begin;") < sql.indexOf("create table if not exists public.teacher_class_bindings"),
    "BEGIN must precede the first schema statement"
  );
  assert.ok(
    sql.indexOf("commit;") > sql.lastIndexOf("grant execute"),
    "COMMIT must follow every grant statement"
  );
  // Class subject / membership changes NEVER delete a student binding.
  assert.doesNotMatch(sql, /delete from public\.teacher_student_bindings/);

  const sync = rpcBlock(sql, "sync_class_members");
  assert.match(sync, /insert into public\.teacher_student_bindings[\s\S]{0,700}union[\s\S]{0,200}teacher_class_bindings/);
  const update = rpcBlock(sql, "update_class_subjects");
  // Signature compatibility kept, binding backfill kept, deletion branch gone.
  assert.match(update, /p_remove_writing boolean/);
  assert.match(update, /from public\.teacher_class_bindings link/);
  assert.match(update, /'removed_writing_count', removed_writing_count/);
  assert.doesNotMatch(update, /delete from public\.teacher_student_bindings/);
  assert.doesNotMatch(update, /had_writing/);
  const remove = rpcBlock(sql, "remove_class_member");
  assert.match(remove, /p_remove_writing boolean/);
  assert.match(remove, /delete from public\.class_members/);
  assert.match(remove, /'removed_writing_count', removed_writing_count/);
  assert.doesNotMatch(remove, /delete from public\.teacher_student_bindings/);
  assert.doesNotMatch(remove, /writing_assignments|writing_attempts|writing_reviews/);
  const assign = rpcBlock(sql, "create_writing_assignment_group");
  assert.match(assign, /and public\.is_class_teacher\(p_class_id, p_teacher_id\)/);
  assert.match(assign, /teacher_student_bindings binding/);
  // Withdrawn-edit re-targeting follows the same owner-or-bound rule.
  const editRpc = rpcBlock(sql, "update_withdrawn_writing_assignment_group");
  assert.match(editRpc, /where class_id = p_class_id\s*\n\s*and public\.is_class_teacher\(p_class_id, p_teacher_id\)/);
});

test("subject-scoped class binding migration is additive, idempotent and teacher-isolated", async () => {
  const sql = await read("supabase/teacher_class_binding_subjects_20261007.sql");

  // One transaction; no DROP and no DELETE anywhere.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.ok(
    sql.indexOf("begin;") < sql.indexOf("add column if not exists subjects"),
    "BEGIN must precede the first schema statement"
  );
  assert.ok(
    sql.indexOf("commit;") > sql.lastIndexOf("grant execute"),
    "COMMIT must follow every grant statement"
  );

  // The per-teacher subject column + constraints + backfill.
  assert.match(sql, /alter table public\.teacher_class_bindings\s*\n\s*add column if not exists subjects text\[\]/);
  assert.match(sql, /alter column subjects set not null/);
  assert.match(sql, /teacher_class_bindings_subjects_check/);
  assert.match(sql, /coalesce\(array_length\(subjects, 1\), 0\) between 1 and 2/);
  assert.match(sql, /subjects <@ array\['reading', 'writing'\]::text\[\]/);
  assert.match(sql, /update public\.teacher_class_bindings link\s*\n\s*set subjects = coalesce\(/);

  // Backward-compatible rollout: the 3-arg RPC is the official implementation
  // and takes the selected subjects, backfilling ONLY the caller. The legacy
  // 2-arg overload is NOT dropped; the compatibility wrapper is asserted in the
  // dedicated test below.
  assert.doesNotMatch(sql, /drop function[^;]*bind_teacher_to_class/i);
  assert.match(
    sql,
    /create or replace function public\.bind_teacher_to_class\(\s*\n\s*p_teacher_id uuid,\s*\n\s*p_class_id uuid,\s*\n\s*p_subjects text\[\]\s*\n\)/
  );
  const bind = functionOverload(sql, "bind_teacher_to_class", /p_subjects text\[\]/);
  assert.match(bind, /array_agg\(distinct domain order by domain\)/);
  assert.match(bind, /on conflict \(teacher_id, student_id, domain\) do nothing/);
  assert.match(bind, /where member\.class_id = p_class_id/);
  // The caller-only backfill must not join other teachers' links.
  const bindBackfill = bind.slice(bind.indexOf("insert into public.teacher_student_bindings"));
  assert.doesNotMatch(bindBackfill, /teacher_class_bindings link/);
  assert.doesNotMatch(bind, /unnest\(class_row\.subjects\) as subject/);
  assert.match(
    sql,
    /revoke all on function public\.bind_teacher_to_class\(uuid, uuid, text\[\]\)\s*\n\s*from public, anon, authenticated/
  );

  // sync_class_members backfills per teacher from that teacher's OWN subjects.
  const sync = rpcBlock(sql, "sync_class_members");
  assert.match(sync, /select link\.teacher_id, link\.subjects\s*\n\s*from public\.teacher_class_bindings link/);
  assert.match(sync, /cross join unnest\(coalesce\(class_teacher\.subjects, array\[\]::text\[\]\)\)/);
  assert.doesNotMatch(sync, /cross join unnest\(class_subjects\)/);

  // update_class_subjects only writes the ACTING teacher's own set.
  const update = rpcBlock(sql, "update_class_subjects");
  assert.match(update, /if class_row\.teacher_id = p_teacher_id then/);
  assert.match(update, /update public\.teacher_class_bindings\s*\n\s*set subjects = effective_subjects/);
  assert.match(update, /where class_id = p_class_id\s*\n\s*and teacher_id = p_teacher_id/);
  assert.doesNotMatch(update, /delete from public\.teacher_student_bindings/);
  assert.doesNotMatch(update, /class_teacher_ids/);

  // Assignment subject guards use the ACTING teacher's own subjects.
  const assign = rpcBlock(sql, "create_writing_assignment_group");
  assert.match(assign, /where class_row\.teacher_id = p_teacher_id/);
  assert.match(assign, /from public\.teacher_class_bindings link/);
  assert.doesNotMatch(assign, /if not \(p_subject = any\(class_row\.subjects\)\)/);
  const edit = rpcBlock(sql, "update_withdrawn_writing_assignment_group");
  assert.doesNotMatch(edit, /if not \(derived_subject = any\(class_row\.subjects\)\)/);
  assert.match(edit, /where acting_subject\.domain = derived_subject/);

  // Class changes still never release a member binding.
  assert.doesNotMatch(sql, /delete from public\.teacher_student_bindings/);
  assert.match(sql, /'removed_writing_count', removed_writing_count/);
  // Verification lives in its own read-only file, not in a commented block.
  assert.match(sql, /teacher_class_binding_subjects_verify_20261007\.sql/);
});

test("read-only verification SQL is a standalone file that only selects", async () => {
  const verify = await read("supabase/teacher_class_binding_subjects_verify_20261007.sql");
  const migration = await read("supabase/teacher_class_binding_subjects_20261007.sql");

  // The migration points at the standalone verification file.
  assert.match(migration, /supabase\/teacher_class_binding_subjects_verify_20261007\.sql/);

  // QUERY 1 gates both overloads, the column/constraint and the wrapper
  // delegation; the student-mode assignment overload must stay intact.
  assert.match(verify, /to_regprocedure\('public\.bind_teacher_to_class\(uuid,uuid\)'\)/);
  assert.match(verify, /to_regprocedure\('public\.bind_teacher_to_class\(uuid,uuid,text\[\]\)'\)/);
  assert.match(verify, /teacher_class_bindings_subjects_check/);
  assert.match(verify, /bind_teacher_to_class\(p_teacher_id, p_class_id, class_subjects\)/);
  assert.match(verify, /学生模式 6 参签名未被破坏/);
  assert.match(verify, /恰好两个重载/);

  // QUERY 4 must run safely before the <CLASS_ID> placeholder is replaced:
  // there is exactly one executable placeholder (single edit point) and the
  // comparison is text-based, so an unreplaced placeholder can never raise an
  // invalid-uuid cast error.
  assert.equal((verify.match(/'<CLASS_ID>'/g) ?? []).length, 1);
  assert.match(verify, /select '<CLASS_ID>'::text as class_id_text/);
  assert.match(verify, /where owner_row\.class_id::text = \(select class_id_text from target\)/);
  assert.match(verify, /where link\.class_id::text = \(select class_id_text from target\)/);
  assert.doesNotMatch(verify, /'<CLASS_ID>'::uuid/);

  // Read-only: no write or DDL keyword appears anywhere in the file.
  assert.doesNotMatch(
    verify,
    /\b(insert|update|delete|create|alter|drop|grant|revoke|truncate)\b/i
  );
});

test("执行新 migration 后，2 参数和 3 参数 bind_teacher_to_class 同时存在；旧版本仍兼容，新版本支持教师独立科目", async () => {
  const sql = await read("supabase/teacher_class_binding_subjects_20261007.sql");
  const blocks =
    sql.match(/create or replace function public\.bind_teacher_to_class\([\s\S]*?\n\$\$;/g) ?? [];
  assert.equal(blocks.length, 2, "3 参正式实现与 2 参 compatibility wrapper 必须同时存在");
  const core = blocks.find((block) => /p_subjects text\[\]/.test(block));
  const legacy = blocks.find((block) => !/p_subjects text\[\]/.test(block));
  assert.ok(core, "3 参数 bind_teacher_to_class(p_subjects text[]) 必须存在");
  assert.ok(legacy, "旧 2 参数 bind_teacher_to_class(uuid, uuid) 必须仍然可调用");

  // 旧 wrapper 保持旧调用签名与旧语义：读取班级当前科目并转交 3 参实现，
  // 但自身没有任何独立写入逻辑（不直接写 link / binding / 班级行）。
  assert.match(legacy, /p_teacher_id uuid,\s*\n\s*p_class_id uuid\s*\n\)/);
  assert.match(
    legacy,
    /select subjects into class_subjects\s*\n\s*from public\.teacher_classes\s*\n\s*where class_id = p_class_id/
  );
  assert.match(legacy, /raise exception 'CLASS_NOT_FOUND'/);
  assert.match(
    legacy,
    /return public\.bind_teacher_to_class\(p_teacher_id, p_class_id, class_subjects\)/
  );
  assert.doesNotMatch(legacy, /insert into public\.teacher_student_bindings/);
  assert.doesNotMatch(legacy, /insert into public\.teacher_class_bindings/);
  assert.doesNotMatch(legacy, /update public\.teacher_classes/);
  assert.doesNotMatch(legacy, /delete from public\./);

  // 新实现只写调用教师自己的行（不读取其他教师的 link）。
  assert.match(core, /select p_teacher_id, member\.student_id, subject\.domain/);
  assert.match(core, /cross join unnest\(effective_subjects\)/);
  assert.doesNotMatch(core, /teacher_class_bindings link/);

  // 两个重载都保留 service_role-only 授权。
  assert.match(
    sql,
    /revoke all on function public\.bind_teacher_to_class\(uuid, uuid\)\s*\n\s*from public, anon, authenticated/
  );
  assert.match(
    sql,
    /grant execute on function public\.bind_teacher_to_class\(uuid, uuid\)\s*\n\s*to service_role/
  );
  assert.match(
    sql,
    /grant execute on function public\.bind_teacher_to_class\(uuid, uuid, text\[\]\)\s*\n\s*to service_role/
  );

  // 迁移整体可重复执行：没有任何 DROP 函数语句。
  assert.doesNotMatch(sql, /drop function/i);
});

test("class RPCs never shadow a class_row variable with a class_row table alias", async () => {
  // plpgsql.variable_conflict defaults to error: when a function declares
  // `class_row public.teacher_classes%rowtype` and also aliases the table as
  // `class_row`, every qualified reference (class_row.teacher_id) becomes
  // ambiguous (SQLSTATE 42702) and the whole RPC aborts at runtime. That is
  // exactly how update_class_subjects failed with
  // "column reference \"class_row.teacher_id\" is ambiguous".
  for (const file of [
    "supabase/teacher_class_multi_teacher_binding_20261003.sql",
    "supabase/teacher_class_binding_subjects_20261007.sql",
    "supabase/teacher_classes.sql"
  ]) {
    const sql = await read(file);
    const blocks = sql.match(/create or replace function public\.\w+\([\s\S]*?\n\$\$;/g) ?? [];
    assert.ok(blocks.length > 0, `${file} must define public RPCs`);
    for (const block of blocks) {
      const name = block.match(/function public\.(\w+)/)?.[1] ?? "unknown";
      if (!/\bclass_row\s+public\.teacher_classes%rowtype/.test(block)) continue;
      assert.doesNotMatch(
        block,
        /from public\.teacher_classes class_row\b/,
        `${file}:${name} aliases teacher_classes as class_row while declaring a class_row variable`
      );
    }
  }
});
