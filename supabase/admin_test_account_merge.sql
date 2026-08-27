-- REVIEWED ACCOUNT MERGE PLAN. Run only after account_roles_and_ownership.sql.
-- Final Admin Auth UID: student@test.com (keeps all student learning history in place).
-- Old Teacher Auth UID: teacher@test.com (Auth row/profile are retained and not changed here).
-- No attempts, answers, writing attempts, assignments, reviews, profiles, or Auth users are deleted.
-- Complete live-schema UID audit covered:
-- profiles.id; attempts.student_id; attempt_answers.student_id;
-- writing_attempts.user_id; writing_assignments.teacher_id;
-- writing_assignment_students.student_id; writing_assignment_groups.teacher_id;
-- student_writing_mode_settings.student_id / updated_by; question_sets.created_by.
-- writing_reviews has no teacher/reviewer UID column; it links only through attempt_id.

-- PRE-MIGRATION AUDIT. Expected old-teacher counts from the 2026-08-27 read-only audit:
-- writing_assignments.teacher_id=21, writing_assignment_groups.teacher_id=5,
-- question_sets.created_by=120; every other profile/UID reference below=0.
select 'old_teacher.attempts.student_id' as reference, count(*) as row_count from public.attempts where student_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.attempt_answers.student_id', count(*) from public.attempt_answers where student_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.writing_attempts.user_id', count(*) from public.writing_attempts where user_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.writing_assignments.teacher_id', count(*) from public.writing_assignments where teacher_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.writing_assignment_students.student_id', count(*) from public.writing_assignment_students where student_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.writing_assignment_groups.teacher_id', count(*) from public.writing_assignment_groups where teacher_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.student_writing_mode_settings.student_id', count(*) from public.student_writing_mode_settings where student_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.student_writing_mode_settings.updated_by', count(*) from public.student_writing_mode_settings where updated_by = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all select 'old_teacher.question_sets.created_by', count(*) from public.question_sets where created_by = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da';

do $$
declare
  final_admin_id constant uuid := '6f333422-384a-44fb-8a83-e9c1aadb0caf';
  retired_teacher_id constant uuid := 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da';
begin
  if not exists (select 1 from public.profiles where id = final_admin_id) then
    raise exception 'Expected student@test.com profile was not found';
  end if;
  if not exists (select 1 from public.profiles where id = retired_teacher_id) then
    raise exception 'Expected teacher@test.com profile was not found';
  end if;

  -- Promote the final UID before assigning legacy students to it. The ownership
  -- trigger accepts Teacher/Admin owners and must never accept a Student owner.
  update public.profiles
  set role = 'admin', owner_id = null, is_active = true
  where id = final_admin_id;

  -- Existing legacy students become Admin-owned. Admin-owned students do not consume quota.
  update public.profiles
  set owner_id = final_admin_id
  where role = 'student' and owner_id is null and id <> final_admin_id;

  update public.writing_assignments
  set teacher_id = final_admin_id
  where teacher_id = retired_teacher_id;

  update public.writing_assignment_groups
  set teacher_id = final_admin_id
  where teacher_id = retired_teacher_id;

  update public.question_sets
  set created_by = final_admin_id
  where created_by = retired_teacher_id;

  -- Intentionally do not change or delete the old Teacher Auth user/profile.
  -- Retirement is a separate decision after this migration's verification.
end;
$$;

-- POST-MIGRATION AUDIT: all old-teacher business references must be zero.
select 'retired_teacher_assignments' as check_name, count(*) as remaining
from public.writing_assignments where teacher_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all
select 'retired_teacher_groups', count(*)
from public.writing_assignment_groups where teacher_id = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all
select 'retired_teacher_question_sets', count(*)
from public.question_sets where created_by = 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'
union all
select 'unowned_students', count(*)
from public.profiles where role = 'student' and is_active = true and owner_id is null;

-- Final Admin continuity audit. Counts can be higher if new activity occurred after
-- the read-only audit, but must never be lower than the audited baselines.
select 'final_admin.attempts.student_id' as check_name, count(*) as row_count, 84 as audited_minimum
from public.attempts where student_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.attempt_answers.student_id', count(*), 558
from public.attempt_answers where student_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.writing_attempts.user_id', count(*), 31
from public.writing_attempts where user_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.writing_assignment_students.student_id', count(*), 5
from public.writing_assignment_students where student_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.writing_assignments.teacher_id', count(*), 21
from public.writing_assignments where teacher_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.writing_assignment_groups.teacher_id', count(*), 5
from public.writing_assignment_groups where teacher_id = '6f333422-384a-44fb-8a83-e9c1aadb0caf'
union all select 'final_admin.question_sets.created_by', count(*), 120
from public.question_sets where created_by = '6f333422-384a-44fb-8a83-e9c1aadb0caf';
