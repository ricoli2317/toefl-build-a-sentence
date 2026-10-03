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
    teacher_class_bindings: [{ class_id: "class-b", teacher_id: "teacher-a" }]
  };
}

function rpcBlock(sql, name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
  );
  const match = sql.match(pattern);
  assert.ok(match, `${name} must be defined in the migration`);
  return match[0];
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
    member_count: 3,
    bound: true
  });
  assert.equal(byId.get("class-b").bound, true);
  assert.equal(byId.get("class-b").member_count, 0);
  assert.equal(byId.get("class-c").bound, false);
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
  const tables = classTables();
  const db = createMockSupabase(tables, {
    rpc: (fn, args, currentTables) => {
      assert.equal(fn, "bind_teacher_to_class");
      const links = currentTables.teacher_class_bindings ?? (currentTables.teacher_class_bindings = []);
      const exists = links.some(
        (row) => row.class_id === args.p_class_id && row.teacher_id === args.p_teacher_id
      );
      if (!exists) links.push({ class_id: args.p_class_id, teacher_id: args.p_teacher_id });
      return {
        data: {
          class_id: args.p_class_id,
          linked: !exists,
          bindings_inserted: exists ? 0 : 2,
          member_count: 5,
          subjects: ["reading"]
        },
        error: null
      };
    }
  });

  const first = await bindTeacherToClass(db, "teacher-a", "class-c");
  assert.equal(first.ok, true);
  assert.equal(first.alreadyBound, false);
  assert.equal(first.createdBindingCount, 2);
  assert.equal(first.class.class_id, "class-c");
  assert.equal(first.class.member_count, 5);

  const repeated = await bindTeacherToClass(db, "teacher-a", "class-c");
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadyBound, true);
  assert.equal(repeated.createdBindingCount, 0);
  assert.equal(
    tables.teacher_class_bindings.filter(
      (row) => row.class_id === "class-c" && row.teacher_id === "teacher-a"
    ).length,
    1
  );
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
  assert.match(component, /key=\{`class:\$\{entry\.class_id\}`\}/);
  assert.match(component, /该班级已绑定。/);
  assert.match(component, /classId: selectedClass\.class_id/);
  assert.match(component, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  // Exactly one search input: no extra box, no tab switch, no new card.
  assert.equal((component.match(/id="bind-student-query"/g) ?? []).length, 1);
  assert.doesNotMatch(component, /placeholder="输入学生姓名或学生账号"/);
  assert.doesNotMatch(component, /学生\/班级.*Tab|角色切换/);
});

test("class binding API binds the session teacher and never a client teacher id", async () => {
  const route = await read("app/api/teacher/class-bindings/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /bindTeacherToClass\(createServiceSupabase\(\), auth\.userId, classId\)/);
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
