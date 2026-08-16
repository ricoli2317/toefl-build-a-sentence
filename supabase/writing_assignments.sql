create extension if not exists pgcrypto;

create table if not exists public.writing_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null
    constraint writing_assignments_task_type_check
    check (task_type in ('email', 'academic_discussion')),
  question_source text not null
    constraint writing_assignments_question_source_value_check
    check (question_source in ('question_bank', 'custom')),
  question_id text null,
  question_snapshot jsonb not null
    constraint writing_assignments_question_snapshot_object_check
    check (jsonb_typeof(question_snapshot) = 'object'),
  due_at timestamptz null,
  status text not null default 'active',
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint writing_assignments_question_source_check check (
    (question_source = 'question_bank' and question_id is not null)
    or (question_source = 'custom' and question_id is null)
  )
);

alter table public.writing_assignments
  add column if not exists status text not null default 'active',
  add column if not exists deleted_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'writing_assignments_status_check'
      and conrelid = 'public.writing_assignments'::regclass
  ) then
    alter table public.writing_assignments
      add constraint writing_assignments_status_check
      check (status in ('active', 'withdrawn'));
  end if;
end $$;

create table if not exists public.writing_assignment_students (
  assignment_id uuid not null references public.writing_assignments(assignment_id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (assignment_id, student_id)
);

alter table public.writing_attempts
  add column if not exists assignment_id uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'writing_attempts_assignment_id_fkey'
      and conrelid = 'public.writing_attempts'::regclass
  ) then
    alter table public.writing_attempts
      add constraint writing_attempts_assignment_id_fkey
      foreign key (assignment_id)
      references public.writing_assignments(assignment_id)
      on delete set null;
  end if;
end $$;

create index if not exists writing_assignments_teacher_created_idx
  on public.writing_assignments(teacher_id, created_at desc);
create index if not exists writing_assignments_teacher_due_idx
  on public.writing_assignments(teacher_id, due_at)
  where due_at is not null;
create index if not exists writing_assignments_teacher_lifecycle_idx
  on public.writing_assignments(teacher_id, status, created_at desc)
  where deleted_at is null;
create index if not exists writing_assignment_students_student_idx
  on public.writing_assignment_students(student_id, assignment_id);
create index if not exists writing_attempts_assignment_student_submitted_idx
  on public.writing_attempts(assignment_id, user_id, submitted_at)
  where assignment_id is not null and status = 'submitted';

create or replace function public.enforce_active_writing_assignment_attempt()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  must_check_assignment boolean := false;
begin
  if new.assignment_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    must_check_assignment := true;
  elsif old.status = 'draft' then
    must_check_assignment := true;
  end if;
  if must_check_assignment and not exists (
    select 1
    from public.writing_assignments assignment
    where assignment.assignment_id = new.assignment_id
      and assignment.status = 'active'
      and assignment.deleted_at is null
  ) then
    raise exception 'WRITING_ASSIGNMENT_NOT_ACTIVE';
  end if;
  return new;
end;
$$;

drop trigger if exists writing_attempts_require_active_assignment on public.writing_attempts;
create trigger writing_attempts_require_active_assignment
before insert or update on public.writing_attempts
for each row execute function public.enforce_active_writing_assignment_attempt();

drop trigger if exists writing_assignments_set_updated_at on public.writing_assignments;
create trigger writing_assignments_set_updated_at
before update on public.writing_assignments
for each row execute function public.set_updated_at();

alter table public.writing_assignments enable row level security;
alter table public.writing_assignment_students enable row level security;

create or replace function public.is_assigned_writing_student(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.writing_assignment_students
    where assignment_id = p_assignment_id
      and student_id = auth.uid()
  );
$$;

revoke all on function public.is_assigned_writing_student(uuid) from public;
grant execute on function public.is_assigned_writing_student(uuid) to authenticated;

drop policy if exists "Teachers can read own writing assignments" on public.writing_assignments;
create policy "Teachers can read own writing assignments"
on public.writing_assignments for select
to authenticated
using (teacher_id = auth.uid() and public.is_teacher());

drop policy if exists "Teachers can manage own writing assignments" on public.writing_assignments;
create policy "Teachers can manage own writing assignments"
on public.writing_assignments for all
to authenticated
using (teacher_id = auth.uid() and public.is_teacher())
with check (teacher_id = auth.uid() and public.is_teacher());

drop policy if exists "Students can read assigned writing assignments" on public.writing_assignments;
create policy "Students can read assigned writing assignments"
on public.writing_assignments for select
to authenticated
using (
  public.is_assigned_writing_student(writing_assignments.assignment_id)
);

drop policy if exists "Teachers can read own assignment students" on public.writing_assignment_students;
create policy "Teachers can read own assignment students"
on public.writing_assignment_students for select
to authenticated
using (
  public.is_teacher()
  and exists (
    select 1
    from public.writing_assignments assignment
    where assignment.assignment_id = writing_assignment_students.assignment_id
      and assignment.teacher_id = auth.uid()
  )
);

drop policy if exists "Teachers can manage own assignment students" on public.writing_assignment_students;
create policy "Teachers can manage own assignment students"
on public.writing_assignment_students for all
to authenticated
using (
  public.is_teacher()
  and exists (
    select 1
    from public.writing_assignments assignment
    where assignment.assignment_id = writing_assignment_students.assignment_id
      and assignment.teacher_id = auth.uid()
  )
)
with check (
  public.is_teacher()
  and exists (
    select 1
    from public.writing_assignments assignment
    where assignment.assignment_id = writing_assignment_students.assignment_id
      and assignment.teacher_id = auth.uid()
  )
);

drop policy if exists "Students can read own assignment membership" on public.writing_assignment_students;
create policy "Students can read own assignment membership"
on public.writing_assignment_students for select
to authenticated
using (student_id = auth.uid());

revoke delete on public.writing_assignments from authenticated;
grant select, insert, update on public.writing_assignments to authenticated;
grant select, insert, update, delete on public.writing_assignment_students to authenticated;

create or replace function public.create_writing_assignment(
  p_teacher_id uuid,
  p_task_type text,
  p_question_source text,
  p_question_id text,
  p_question_snapshot jsonb,
  p_due_at timestamptz,
  p_student_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  created_assignment_id uuid;
  requested_student_count integer;
  valid_student_count integer;
begin
  if p_task_type not in ('email', 'academic_discussion') then
    raise exception 'Invalid writing task type';
  end if;
  if p_question_source not in ('question_bank', 'custom') then
    raise exception 'Invalid question source';
  end if;
  if jsonb_typeof(p_question_snapshot) is distinct from 'object' then
    raise exception 'Question snapshot must be an object';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher'
  ) then
    raise exception 'Invalid teacher';
  end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'At least one student is required';
  end if;

  select count(*) into valid_student_count
  from public.profiles
  where id in (select distinct unnest(p_student_ids)) and role = 'student';
  if valid_student_count <> requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  insert into public.writing_assignments (
    teacher_id, task_type, question_source, question_id, question_snapshot, due_at
  ) values (
    p_teacher_id, p_task_type, p_question_source, p_question_id, p_question_snapshot, p_due_at
  )
  returning assignment_id into created_assignment_id;

  insert into public.writing_assignment_students (assignment_id, student_id)
  select created_assignment_id, id
  from (select distinct unnest(p_student_ids) as id) students;

  return created_assignment_id;
end;
$$;

revoke all on function public.create_writing_assignment(uuid, text, text, text, jsonb, timestamptz, uuid[]) from public;
revoke all on function public.create_writing_assignment(uuid, text, text, text, jsonb, timestamptz, uuid[]) from anon;
revoke all on function public.create_writing_assignment(uuid, text, text, text, jsonb, timestamptz, uuid[]) from authenticated;
grant execute on function public.create_writing_assignment(uuid, text, text, text, jsonb, timestamptz, uuid[]) to service_role;

create or replace function public.update_withdrawn_writing_assignment(
  p_assignment_id uuid,
  p_teacher_id uuid,
  p_task_type text,
  p_question_source text,
  p_question_id text,
  p_question_snapshot jsonb,
  p_due_at timestamptz,
  p_student_ids uuid[],
  p_reactivate boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_assignment public.writing_assignments%rowtype;
  requested_student_count integer;
  valid_student_count integer;
  has_submitted_attempt boolean;
begin
  select * into current_assignment
  from public.writing_assignments
  where assignment_id = p_assignment_id
    and teacher_id = p_teacher_id
  for update;

  if not found or current_assignment.deleted_at is not null then
    raise exception 'ASSIGNMENT_NOT_FOUND';
  end if;
  if current_assignment.status <> 'withdrawn' then
    raise exception 'ASSIGNMENT_NOT_WITHDRAWN';
  end if;
  if p_task_type not in ('email', 'academic_discussion') then
    raise exception 'INVALID_TASK_TYPE';
  end if;
  if p_question_source not in ('question_bank', 'custom') then
    raise exception 'INVALID_QUESTION_SOURCE';
  end if;
  if jsonb_typeof(p_question_snapshot) is distinct from 'object' then
    raise exception 'INVALID_QUESTION_SNAPSHOT';
  end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'STUDENT_REQUIRED';
  end if;

  select count(*) into valid_student_count
  from public.profiles
  where id in (select distinct unnest(p_student_ids)) and role = 'student';
  if valid_student_count <> requested_student_count then
    raise exception 'INVALID_STUDENT';
  end if;

  select exists (
    select 1
    from public.writing_attempts
    where assignment_id = p_assignment_id
      and status = 'submitted'
  ) into has_submitted_attempt;

  if has_submitted_attempt and (
    current_assignment.task_type is distinct from p_task_type
    or current_assignment.question_source is distinct from p_question_source
    or current_assignment.question_id is distinct from p_question_id
    or current_assignment.question_snapshot is distinct from p_question_snapshot
  ) then
    raise exception 'QUESTION_LOCKED_AFTER_SUBMISSION';
  end if;

  if exists (
    select 1
    from public.writing_assignment_students assignment_student
    where assignment_student.assignment_id = p_assignment_id
      and not (assignment_student.student_id = any(p_student_ids))
      and exists (
        select 1
        from public.writing_attempts attempt
        where attempt.assignment_id = p_assignment_id
          and attempt.user_id = assignment_student.student_id
      )
  ) then
    raise exception 'STUDENT_HAS_ATTEMPT';
  end if;

  update public.writing_assignments
  set task_type = p_task_type,
      question_source = p_question_source,
      question_id = p_question_id,
      question_snapshot = p_question_snapshot,
      due_at = p_due_at,
      status = case when p_reactivate then 'active' else 'withdrawn' end
  where assignment_id = p_assignment_id;

  delete from public.writing_assignment_students assignment_student
  where assignment_student.assignment_id = p_assignment_id
    and not (assignment_student.student_id = any(p_student_ids));

  insert into public.writing_assignment_students (assignment_id, student_id)
  select p_assignment_id, id
  from (select distinct unnest(p_student_ids) as id) students
  on conflict (assignment_id, student_id) do nothing;
end;
$$;

revoke all on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean) from public;
revoke all on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean) from anon;
revoke all on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean) from authenticated;
grant execute on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean) to service_role;
