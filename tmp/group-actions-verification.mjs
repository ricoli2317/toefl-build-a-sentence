import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const appUrl = process.env.APP_URL ?? "http://localhost:3001";
const mode = process.argv[2];
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const MANIFEST = "tmp/group-actions-verification.json";

async function firstQuestion(taskType) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .select("question_id,question_snapshot")
    .eq("task_type", taskType)
    .not("question_id", "is", null)
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`no ${taskType} snapshot`);
  return data[0];
}

async function createGroup(teacherId, snapshotByQuestion, title, items, students) {
  const { data: group, error: groupError } = await supabase
    .from("writing_assignment_groups")
    .insert({ teacher_id: teacherId })
    .select("group_id")
    .single();
  if (groupError) throw new Error(groupError.message);
  if (title) {
    const { error } = await supabase
      .from("writing_assignment_groups")
      .update({ title })
      .eq("group_id", group.group_id);
    if (error) throw new Error(error.message);
  }
  const assignmentIds = [];
  let position = 0;
  for (const item of items) {
    position += 1;
    const { data, error } = await supabase
      .from("writing_assignments")
      .insert({
        teacher_id: teacherId,
        group_id: group.group_id,
        group_position: position,
        task_type: item.taskType,
        question_source: "question_bank",
        question_id: item.questionId,
        question_snapshot: snapshotByQuestion.get(item.questionId),
        status: "withdrawn",
        due_at: item.dueAt ?? null
      })
      .select("assignment_id")
      .single();
    if (error) throw new Error(error.message);
    assignmentIds.push(data.assignment_id);
    let order = 0;
    for (const studentId of students) {
      order += 1;
      const { error: memberError } = await supabase
        .from("writing_assignment_students")
        .insert({ assignment_id: data.assignment_id, student_id: studentId, sort_order: order });
      if (memberError) throw new Error(memberError.message);
    }
  }
  return { group_id: group.group_id, assignmentIds };
}

async function teacherToken() {
  const creds = Object.fromEntries(
    readFileSync(".codex/tps-test-accounts.local", "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      })
  );
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: `${creds.TEACHER_EMAIL}@bas.com`,
        password: creds.TEACHER_PASSWORD
      })
    }
  );
  const payload = await response.json();
  if (!payload.access_token) throw new Error("teacher login failed");
  return payload.access_token;
}

async function patch(assignmentId, action, token) {
  const response = await fetch(
    `${appUrl}/api/teacher/writing/assignments/${assignmentId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    }
  );
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

async function statuses(assignmentIds) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .select("assignment_id,status,deleted_at")
    .in("assignment_id", assignmentIds);
  if (error) throw new Error(error.message);
  return data;
}

async function run() {
  const { data: teacher, error: teacherError } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", "like@bas.com")
    .maybeSingle();
  if (teacherError) throw new Error(teacherError.message);
  const { data: students, error: studentError } = await supabase
    .from("profiles")
    .select("id,full_name")
    .in("full_name", ["彭钰杰", "冉阳"]);
  if (studentError) throw new Error(studentError.message);
  const peng = students.find((student) => student.full_name === "彭钰杰");
  const ran = students.find((student) => student.full_name === "冉阳");
  const email = await firstQuestion("email");
  const ad = await firstQuestion("academic_discussion");
  const snapshotByQuestion = new Map([
    [email.question_id, email.question_snapshot],
    [ad.question_id, ad.question_snapshot]
  ]);

  if (mode === "create") {
    const emailGroup = await createGroup(
      teacher.id, snapshotByQuestion, "验证-单Email组",
      [
        { taskType: "email", questionId: email.question_id },
        { taskType: "email", questionId: email.question_id }
      ],
      [peng.id]
    );
    const adGroup = await createGroup(
      teacher.id, snapshotByQuestion, "验证-单AD组",
      [
        { taskType: "academic_discussion", questionId: ad.question_id },
        { taskType: "academic_discussion", questionId: ad.question_id }
      ],
      [peng.id]
    );
    const mixedGroup = await createGroup(
      teacher.id, snapshotByQuestion, "验证-混合多学生组",
      [
        { taskType: "email", questionId: email.question_id, dueAt: "2026-10-01T12:00:00+08:00" },
        { taskType: "academic_discussion", questionId: ad.question_id, dueAt: "2026-10-01T12:00:00+08:00" }
      ],
      [peng.id, ran.id]
    );
    // Legacy assignment without a group keeps the original single edit path.
    const { data: legacy, error: legacyError } = await supabase
      .from("writing_assignments")
      .insert({
        teacher_id: teacher.id,
        task_type: "email",
        question_source: "question_bank",
        question_id: email.question_id,
        question_snapshot: email.question_snapshot,
        status: "withdrawn"
      })
      .select("assignment_id")
      .single();
    if (legacyError) throw new Error(legacyError.message);
    const { error: legacyMemberError } = await supabase
      .from("writing_assignment_students")
      .insert({ assignment_id: legacy.assignment_id, student_id: peng.id, sort_order: 1 });
    if (legacyMemberError) throw new Error(legacyMemberError.message);

    const manifest = {
      emailGroup, adGroup, mixedGroup,
      legacy: { assignmentIds: [legacy.assignment_id] },
      peng: peng.id, ran: ran.id
    };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  if (mode === "check") {
    for (const [name, group] of Object.entries({ ...manifest, peng: undefined, ran: undefined })) {
      if (!group?.assignmentIds) continue;
      console.log(name, await statuses(group.assignmentIds));
    }
    return;
  }

  if (mode === "reactivate") {
    const token = await teacherToken();
    console.log("reactivate:", JSON.stringify(await patch(manifest.emailGroup.assignmentIds[0], "reactivate", token)));
    console.log(await statuses(manifest.emailGroup.assignmentIds));
    return;
  }

  if (mode === "delete") {
    const token = await teacherToken();
    console.log("soft_delete:", JSON.stringify(await patch(manifest.adGroup.assignmentIds[0], "soft_delete", token)));
    console.log(await statuses(manifest.adGroup.assignmentIds));
    return;
  }

  if (mode === "cleanup") {
    const ids = [
      ...manifest.emailGroup.assignmentIds,
      ...manifest.adGroup.assignmentIds,
      ...manifest.mixedGroup.assignmentIds,
      ...manifest.legacy.assignmentIds
    ];
    let error = (await supabase.from("writing_attempts").delete().in("assignment_id", ids)).error;
    if (error) throw new Error(error.message);
    error = (await supabase.from("writing_assignment_students").delete().in("assignment_id", ids)).error;
    if (error) throw new Error(error.message);
    error = (await supabase.from("writing_assignments").delete().in("assignment_id", ids)).error;
    if (error) throw new Error(error.message);
    for (const group of [manifest.emailGroup, manifest.adGroup, manifest.mixedGroup]) {
      error = (await supabase.from("writing_assignment_groups").delete().eq("group_id", group.group_id)).error;
      if (error) throw new Error(error.message);
    }
    console.log("cleanup done");
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

await run();
