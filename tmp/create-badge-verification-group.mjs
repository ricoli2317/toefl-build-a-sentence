import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: teacher, error: teacherError } = await supabase
  .from("profiles")
  .select("id")
  .eq("email", "like@bas.com")
  .maybeSingle();
if (teacherError) throw new Error(teacherError.message);
const teacherId = teacher.id;

const { data: adminAssignment, error: adminError } = await supabase
  .from("writing_assignments")
  .select("assignment_id")
  .eq("group_id", "4acbaf65-3136-49ce-a1b5-69a479466577")
  .maybeSingle();
if (adminError) throw new Error(adminError.message);
const { data: adminMember, error: memberError } = await supabase
  .from("writing_assignment_students")
  .select("student_id")
  .eq("assignment_id", adminAssignment.assignment_id)
  .maybeSingle();
if (memberError) throw new Error(memberError.message);
const studentId = adminMember.student_id;

const emailQuestionId = "EMAIL-202609-0908-A";
const adQuestionId = "AD-202608-0826-B";
const { data: snapshots, error: snapshotError } = await supabase
  .from("writing_assignments")
  .select("question_id,question_snapshot")
  .in("question_id", [emailQuestionId, adQuestionId]);
if (snapshotError) throw new Error(snapshotError.message);
const snapshotByQuestion = new Map(
  (snapshots ?? []).map((row) => [row.question_id, row.question_snapshot])
);

const { data: group, error: groupError } = await supabase
  .from("writing_assignment_groups")
  .insert({ teacher_id: teacherId })
  .select("group_id")
  .single();
if (groupError) throw new Error(groupError.message);

const rows = [
  { task: "email", questionId: emailQuestionId, position: 1 },
  { task: "academic_discussion", questionId: adQuestionId, position: 2 }
];
const createdIds = [];
for (const row of rows) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .insert({
      teacher_id: teacherId,
      group_id: group.group_id,
      group_position: row.position,
      task_type: row.task,
      question_source: "question_bank",
      question_id: row.questionId,
      question_snapshot: snapshotByQuestion.get(row.questionId) ?? { set_title: "验证" }
    })
    .select("assignment_id")
    .single();
  if (error) throw new Error(error.message);
  createdIds.push(data.assignment_id);
  const { error: memberInsertError } = await supabase
    .from("writing_assignment_students")
    .insert({ assignment_id: data.assignment_id, student_id: studentId });
  if (memberInsertError) throw new Error(memberInsertError.message);
}

console.log(JSON.stringify({ group_id: group.group_id, assignmentIds: createdIds, studentId }));
