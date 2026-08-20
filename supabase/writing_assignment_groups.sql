-- Run after supabase/writing_assignments.sql in the Supabase SQL Editor.
-- Existing assignments remain valid with a null group_id.

create extension if not exists pgcrypto;

create table if not exists public.writing_assignment_groups (
  group_id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.writing_assignments
  add column if not exists group_id uuid null
    references public.writing_assignment_groups(group_id) on delete restrict,
  add column if not exists group_position integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_assignments_group_position_check'
      and conrelid = 'public.writing_assignments'::regclass
  ) then
    alter table public.writing_assignments
      add constraint writing_assignments_group_position_check
      check (
        (group_id is null and group_position is null)
        or (group_id is not null and group_position > 0)
      );
  end if;
end $$;

create unique index if not exists writing_assignments_group_position_unique
  on public.writing_assignments(group_id, group_position)
  where group_id is not null;
create index if not exists writing_assignment_groups_teacher_created_idx
  on public.writing_assignment_groups(teacher_id, created_at desc);
create index if not exists writing_assignments_group_idx
  on public.writing_assignments(group_id, group_position)
  where group_id is not null;

drop trigger if exists writing_assignment_groups_set_updated_at
  on public.writing_assignment_groups;
create trigger writing_assignment_groups_set_updated_at
before update on public.writing_assignment_groups
for each row execute function public.set_updated_at();

alter table public.writing_assignment_groups enable row level security;

drop policy if exists "Teachers can read own writing assignment groups"
  on public.writing_assignment_groups;
create policy "Teachers can read own writing assignment groups"
on public.writing_assignment_groups for select
to authenticated
using (teacher_id = auth.uid());

drop policy if exists "Students can read assigned writing assignment groups"
  on public.writing_assignment_groups;
create policy "Students can read assigned writing assignment groups"
on public.writing_assignment_groups for select
to authenticated
using (
  exists (
    select 1
    from public.writing_assignments assignment
    join public.writing_assignment_students member
      on member.assignment_id = assignment.assignment_id
    where assignment.group_id = writing_assignment_groups.group_id
      and member.student_id = auth.uid()
  )
);

revoke all on public.writing_assignment_groups from anon;
grant select on public.writing_assignment_groups to authenticated;

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_data jsonb;
  assignment_ids uuid[] := array[]::uuid[];
  created_assignment_id uuid;
  created_group_id uuid;
  position integer := 0;
  requested_student_count integer;
  valid_student_count integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher'
  ) then
    raise exception 'Invalid teacher';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 50 then
    raise exception 'Assignments must contain between 1 and 50 items';
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

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    if assignment_data ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'Invalid writing task type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if jsonb_typeof(assignment_data -> 'question_snapshot') is distinct from 'object' then
      raise exception 'Question snapshot must be an object';
    end if;
    if assignment_data ->> 'question_source' = 'question_bank'
      and nullif(assignment_data ->> 'question_id', '') is null then
      raise exception 'Question bank assignment requires question_id';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and nullif(assignment_data ->> 'question_id', '') is not null then
      raise exception 'Custom assignment cannot include question_id';
    end if;
  end loop;

  insert into public.writing_assignment_groups (teacher_id)
  values (p_teacher_id)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id,
      group_id,
      group_position,
      task_type,
      question_source,
      question_id,
      question_snapshot,
      due_at
    ) values (
      p_teacher_id,
      created_group_id,
      position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    )
    returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    insert into public.writing_assignment_students (assignment_id, student_id)
    select created_assignment_id, id
    from (select distinct unnest(p_student_ids) as id) students;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids)
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  from public;
revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  from anon;
revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  from authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  to service_role;
