import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const appUrl = process.env.APP_URL ?? "http://localhost:3001";
const mode = process.argv[2];
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const EMAIL_QUESTION = process.env.EMAIL_QUESTION ?? "";
const AD_QUESTION = process.env.AD_QUESTION ?? "";
const GROUP_IDS_FILE = "tmp/withdraw-verification-groups.json";

async function firstQuestion(taskType, questionId) {
  const query = supabase
    .from("writing_assignments")
    .select("question_id,question_snapshot")
    .eq("task_type", taskType)
    .not("question_id", "is", null)
    .limit(1);
  const { data, error } = questionId
    ? await query.eq("question_id", questionId)
    : await query;
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`no ${taskType} question snapshot available`);
  return data[0];
}

async function loadFixture() {
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
  const emailQuestion = await firstQuestion("email", EMAIL_QUESTION);
  const adQuestion = await firstQuestion("academic_discussion", AD_QUESTION);
  const snapshotByQuestion = new Map([
    [emailQuestion.question_id, emailQuestion.question_snapshot],
    [adQuestion.question_id, adQuestion.question_snapshot]
  ]);
  return {
    teacherId: teacher.id,
    students,
    snapshotByQuestion,
    emailQuestionId: emailQuestion.question_id,
    adQuestionId: adQuestion.question_id
  };
}

async function createGroup(teacherId, snapshotByQuestion, items, studentIds) {
  const { data: group, error: groupError } = await supabase
    .from("writing_assignment_groups")
    .insert({ teacher_id: teacherId })
    .select("group_id")
    .single();
  if (groupError) throw new Error(groupError.message);
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
        question_snapshot: snapshotByQuestion.get(item.questionId)
      })
      .select("assignment_id")
      .single();
    if (error) throw new Error(error.message);
    assignmentIds.push(data.assignment_id);
    for (const studentId of studentIds) {
      const { error: memberError } = await supabase
        .from("writing_assignment_students")
        .insert({ assignment_id: data.assignment_id, student_id: studentId });
      if (memberError) throw new Error(memberError.message);
    }
  }
  return { group_id: group.group_id, assignmentIds };
}

async function statuses(assignmentIds) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .select("assignment_id,status")
    .in("assignment_id", assignmentIds);
  if (error) throw new Error(error.message);
  return data;
}

async function run() {
  const fixture = await loadFixture();
  const peng = fixture.students.find((student) => student.full_name === "彭钰杰");
  const ran = fixture.students.find((student) => student.full_name === "冉阳");

  if (mode === "create") {
    const singleType = await createGroup(
      fixture.teacherId,
      fixture.snapshotByQuestion,
      [
        { taskType: "email", questionId: fixture.emailQuestionId },
        { taskType: "email", questionId: fixture.emailQuestionId }
      ],
      [peng.id]
    );
    const mixed = await createGroup(
      fixture.teacherId,
      fixture.snapshotByQuestion,
      [
        { taskType: "email", questionId: fixture.emailQuestionId },
        { taskType: "academic_discussion", questionId: fixture.adQuestionId }
      ],
      [peng.id, ran.id]
    );
    const singleItem = await createGroup(
      fixture.teacherId,
      fixture.snapshotByQuestion,
      [{ taskType: "email", questionId: fixture.emailQuestionId }],
      [peng.id]
    );
    const blocked = await createGroup(
      fixture.teacherId,
      fixture.snapshotByQuestion,
      [
        { taskType: "email", questionId: fixture.emailQuestionId },
        { taskType: "academic_discussion", questionId: fixture.adQuestionId }
      ],
      [peng.id]
    );
    // A started draft mirrors "已有学生开始作答" for the whole group.
    const blockedSnapshot = fixture.snapshotByQuestion.get(fixture.emailQuestionId);
    const { error: attemptError } = await supabase.from("writing_attempts").insert({
      user_id: peng.id,
      task_type: "email",
      question_id: blockedSnapshot.question_id,
      set_id: blockedSnapshot.set_id,
      response_text: "",
      word_count: 0,
      status: "draft",
      time_limit_seconds: 420,
      remaining_seconds: 420,
      assignment_id: blocked.assignmentIds[0]
    });
    if (attemptError) throw new Error(attemptError.message);

    const manifest = { singleType, mixed, singleItem, blocked, peng: peng.id, ran: ran.id };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(GROUP_IDS_FILE, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const manifest = JSON.parse(readFileSync(GROUP_IDS_FILE, "utf8"));

  if (mode === "check") {
    for (const [name, group] of Object.entries({
      singleType: manifest.singleType,
      mixed: manifest.mixed,
      singleItem: manifest.singleItem,
      blocked: manifest.blocked
    })) {
      console.log(name, await statuses(group.assignmentIds));
    }
    return;
  }

  if (mode === "cleanup") {
    const ids = [
      ...manifest.singleType.assignmentIds,
      ...manifest.mixed.assignmentIds,
      ...manifest.singleItem.assignmentIds,
      ...manifest.blocked.assignmentIds
    ];
    let attempts = await supabase.from("writing_attempts").delete().in("assignment_id", ids);
    if (attempts.error) throw new Error(attempts.error.message);
    let members = await supabase.from("writing_assignment_students").delete().in("assignment_id", ids);
    if (members.error) throw new Error(members.error.message);
    let assignments = await supabase.from("writing_assignments").delete().in("assignment_id", ids);
    if (assignments.error) throw new Error(assignments.error.message);
    for (const group of [manifest.singleType, manifest.mixed, manifest.singleItem, manifest.blocked]) {
      const { error } = await supabase
        .from("writing_assignment_groups")
        .delete()
        .eq("group_id", group.group_id);
      if (error) throw new Error(error.message);
    }
    console.log("cleanup done");
    return;
  }

  if (mode === "withdraw") {
    const creds = Object.fromEntries(
      readFileSync(".codex/tps-test-accounts.local", "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
    );
    const tokenResponse = await fetch(
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
    const accessToken = (await tokenResponse.json()).access_token;
    if (!accessToken) throw new Error("teacher login failed");

    const targets = [
      ["singleType", manifest.singleType.assignmentIds[0]],
      ["mixed", manifest.mixed.assignmentIds[0]],
      ["singleItem", manifest.singleItem.assignmentIds[0]],
      ["blocked", manifest.blocked.assignmentIds[0]]
    ];
    for (const [name, assignmentId] of targets) {
      const response = await fetch(
        `${appUrl}/api/teacher/writing/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ action: "withdraw" })
        }
      );
      const payload = await response.json().catch(() => ({}));
      console.log(name, "http", response.status, JSON.stringify(payload));
    }
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

await run();
