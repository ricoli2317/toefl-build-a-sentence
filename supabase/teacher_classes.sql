-- Teacher Classes (班级) — minimal class layer on top of the existing
-- teacher_student_bindings teaching model.
--
-- Run this file once in the Supabase SQL Editor AFTER:
--   * supabase/teacher_student_bindings.sql
--   * supabase/writing_assignment_groups.sql
--   * supabase/writing_assignment_group_titles.sql
--
-- What it adds (additive only, no existing table data is rewritten):
--   1. public.teacher_classes  — one row per teacher-owned class.
--   2. public.class_members    — one row per class + student membership.
--   3. writing_assignment_groups.class_id — the permanent class association of
--      a class-assigned Assignment Group (nullable; direct student assignments
--      keep class_id = null and behave exactly as before).
--   4. Class RPCs (service_role only):
--        sync_class_members, update_class_subjects, remove_class_member
--   5. A class-aware 6-argument create_writing_assignment_group overload. The
--      existing 5-argument overload is kept untouched, so the currently
--      deployed student-mode creation keeps working during rollout.
--
-- Class subjects reuse the existing reading/writing domain representation
-- (text values 'reading' | 'writing', canonical order reading, writing).
-- Teacher access to a student's learning data stays on teacher_student_bindings;
-- a class never replaces or bypasses bindings.
--
-- Re-running this file is safe: every statement is idempotent and no legacy
-- function is dropped.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Teacher classes
-- ---------------------------------------------------------------------------

create table if not exists public.teacher_classes (
  class_id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  name text not null
    constraint teacher_classes_name_check
    check (char_length(btrim(name)) between 1 and 60),
  subjects text[] not null
    constraint teacher_classes_subjects_check
    check (
      array_length(subjects, 1) between 1 and 2
      and subjects <@ array['reading', 'writing']::text[]
      and array_position(subjects, null) is null
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teacher_classes_teacher_created_idx
  on public.teacher_classes(teacher_id, created_at desc);

drop trigger if exists teacher_classes_set_updated_at on public.teacher_classes;
create trigger teacher_classes_set_updated_at
before update on public.teacher_classes
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Class members
-- ---------------------------------------------------------------------------

create table if not exists public.class_members (
  class_id uuid not null
    references public.teacher_classes(class_id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, student_id)
);

create index if not exists class_members_student_idx
  on public.class_members(student_id);

-- Classes are configured only through the protected service-role APIs; direct
-- anon/authenticated access is denied by RLS with no client policies (same
-- rule as teacher_student_bindings).
alter table public.teacher_classes enable row level security;
alter table public.class_members enable row level security;

revoke all on public.teacher_classes from anon, authenticated;
revoke all on public.class_members from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Permanent Assignment Group -> Class association
-- ---------------------------------------------------------------------------

alter table public.writing_assignment_groups
  add column if not exists class_id uuid null
    references public.teacher_classes(class_id) on delete restrict;

create index if not exists writing_assignment_groups_class_idx
  on public.writing_assignment_groups(class_id)
  where class_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Class member / subject RPCs
-- ---------------------------------------------------------------------------

-- Adds students to a class: ensures the teacher_student_bindings rows the
-- class subjects require and inserts the memberships in one transaction.
-- Existing memberships and bindings are left untouched.
create or replace function public.sync_class_members(
  p_teacher_id uuid,
  p_class_id uuid,
  p_student_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_subjects text[];
  requested_count integer;
  valid_count integer;
  related_count integer;
  inserted_count integer;
  member_count integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  select subjects into class_subjects
  from public.teacher_classes
  where class_id = p_class_id and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  select count(*) into requested_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_count < 1 then
    raise exception 'STUDENT_REQUIRED';
  end if;

  select count(*) into valid_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true;
  if valid_count <> requested_count then
    raise exception 'INVALID_STUDENT';
  end if;

  -- Every member must already have a teaching relation with this teacher (the
  -- API checks visibility, and new accounts are created with the class
  -- subjects). A class never introduces a teacher/student relation from an
  -- arbitrary student id. A student may hold BOTH domains, so count distinct
  -- students rather than binding rows.
  select count(distinct students.id) into related_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id;
  if related_count <> requested_count then
    raise exception 'INVALID_STUDENT';
  end if;

  -- Reading/writing relations the class requires. The existing bindings
  -- trigger still enforces the active teacher/student roles.
  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select p_teacher_id, students.id, subject.domain
  from (select distinct unnest(p_student_ids) as id) students
  cross join unnest(class_subjects) as subject(domain)
  on conflict (teacher_id, student_id, domain) do nothing;

  insert into public.class_members (class_id, student_id)
  select p_class_id, students.id
  from (select distinct unnest(p_student_ids) as id) students
  on conflict (class_id, student_id) do nothing;
  get diagnostics inserted_count = row_count;

  select count(*) into member_count
  from public.class_members where class_id = p_class_id;

  return jsonb_build_object(
    'class_id', p_class_id,
    'added_count', inserted_count,
    'member_count', member_count
  );
end;
$$;

-- Updates the class subjects and keeps member bindings consistent:
--   * every member gains the bindings the new subjects require;
--   * when Writing is removed, the teacher decides (p_remove_writing) whether
--     the members' writing relations are released too. Reading relations are
--     never removed by this RPC.
create or replace function public.update_class_subjects(
  p_teacher_id uuid,
  p_class_id uuid,
  p_subjects text[],
  p_remove_writing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_row public.teacher_classes%rowtype;
  had_writing boolean;
  removed_writing_count integer := 0;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  if array_length(coalesce(p_subjects, array[]::text[]), 1) is null
    or not (coalesce(p_subjects, array[]::text[]) <@ array['reading', 'writing']::text[])
    or array_position(p_subjects, null) is not null then
    raise exception 'INVALID_SUBJECTS';
  end if;

  select * into class_row
  from public.teacher_classes
  where class_id = p_class_id and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  had_writing := 'writing' = any(class_row.subjects);

  update public.teacher_classes
  set subjects = p_subjects
  where class_id = p_class_id and teacher_id = p_teacher_id;

  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select p_teacher_id, member.student_id, subject.domain
  from public.class_members member
  cross join unnest(p_subjects) as subject(domain)
  where member.class_id = p_class_id
  on conflict (teacher_id, student_id, domain) do nothing;

  -- Writing was removed from the class and the teacher chose not to keep
  -- receiving those students' writing practice.
  if had_writing
    and not ('writing' = any(p_subjects))
    and coalesce(p_remove_writing, false) then
    delete from public.teacher_student_bindings binding
    using public.class_members member
    where member.class_id = p_class_id
      and binding.teacher_id = p_teacher_id
      and binding.student_id = member.student_id
      and binding.domain = 'writing';
    get diagnostics removed_writing_count = row_count;
  end if;

  return jsonb_build_object(
    'class_id', p_class_id,
    'subjects', to_jsonb(p_subjects),
    'removed_writing_count', removed_writing_count
  );
end;
$$;

-- Removes one membership; when the class includes Writing the teacher decides
-- (p_remove_writing) whether the writing relation is released as well.
-- Historical assignments, submissions and reviews are never touched.
create or replace function public.remove_class_member(
  p_teacher_id uuid,
  p_class_id uuid,
  p_student_id uuid,
  p_remove_writing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_subjects text[];
  removed_writing_count integer := 0;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  select subjects into class_subjects
  from public.teacher_classes
  where class_id = p_class_id and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  delete from public.class_members
  where class_id = p_class_id and student_id = p_student_id;
  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if 'writing' = any(class_subjects) and coalesce(p_remove_writing, false) then
    delete from public.teacher_student_bindings
    where teacher_id = p_teacher_id
      and student_id = p_student_id
      and domain = 'writing';
    get diagnostics removed_writing_count = row_count;
  end if;

  return jsonb_build_object(
    'class_id', p_class_id,
    'student_id', p_student_id,
    'removed_writing_count', removed_writing_count
  );
end;
$$;

revoke all on function public.sync_class_members(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.sync_class_members(uuid, uuid, uuid[]) to service_role;
revoke all on function public.update_class_subjects(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.update_class_subjects(uuid, uuid, text[], boolean) to service_role;
revoke all on function public.remove_class_member(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.remove_class_member(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Class-aware Assignment Group creation (6-argument overload)
-- ---------------------------------------------------------------------------
--
-- Same atomic transaction as the 5-argument version:
--   * p_class_id is null  -> identical student-mode behavior (p_student_ids).
--   * p_class_id is set   -> the class must belong to the teacher and include
--     Writing; recipients are READ FROM class_members at creation time (the
--     client-provided p_student_ids is ignored), so the member snapshot is
--     authoritative and later membership changes never rewrite history.
-- The persisted group keeps the class association; child assignments and
-- recipients stay exactly the same shape the student side already consumes.

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean,
  p_class_id uuid
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
  class_row public.teacher_classes%rowtype;
  member_ids uuid[];
  base_title text;
  final_title text;
  base_title_taken boolean := false;
  max_sequence integer := 0;
  next_sequence integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Invalid teacher';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 50 then
    raise exception 'Assignments must contain between 1 and 50 items';
  end if;

  if p_class_id is not null then
    select * into class_row
    from public.teacher_classes
    where class_id = p_class_id and teacher_id = p_teacher_id
    for update;
    if not found then
      raise exception 'CLASS_NOT_FOUND';
    end if;
    if not ('writing' = any(class_row.subjects)) then
      raise exception 'CLASS_NOT_WRITING_CLASS';
    end if;

    select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
      into member_ids
    from public.class_members member
    where member.class_id = p_class_id;

    requested_student_count := coalesce(array_length(member_ids, 1), 0);
    if requested_student_count < 1 then
      raise exception 'CLASS_HAS_NO_MEMBERS';
    end if;
  else
    select count(*) into requested_student_count
    from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
    if requested_student_count < 1 then
      raise exception 'At least one student is required';
    end if;
  end if;

  -- Recipients are active Students bound to this Teacher for the writing
  -- domain. Legacy profiles.owner_id is never used as an assignment fallback.
  if p_class_id is not null then
    select count(*) into valid_student_count
    from (select distinct unnest(member_ids) as id) students
    join public.profiles student
      on student.id = students.id
     and student.role = 'student'
     and student.is_active = true
    join public.teacher_student_bindings binding
      on binding.teacher_id = p_teacher_id
     and binding.student_id = students.id
     and binding.domain = 'writing';
  else
    select count(*) into valid_student_count
    from (select distinct unnest(p_student_ids) as id) students
    join public.profiles student
      on student.id = students.id
     and student.role = 'student'
     and student.is_active = true
    join public.teacher_student_bindings binding
      on binding.teacher_id = p_teacher_id
     and binding.student_id = students.id
     and binding.domain = 'writing';
  end if;
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

  base_title := nullif(btrim(coalesce(p_title, '')), '');
  if base_title is not null and char_length(base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  -- Automatic titles are numbered per teacher and base title. The advisory
  -- lock serializes concurrent creates with the same base so both cannot pick
  -- the same free sequence. Teacher-written titles skip this block entirely.
  if base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || base_title, 0)
    );

    select
      coalesce(bool_or(group_row.title = base_title), false),
      coalesce(max(
        case
          when group_row.title = base_title then 1
          else nullif(substring(group_row.title from ' \((\d+)\)$'), '')::integer
        end
      ), 0)
    into base_title_taken, max_sequence
    from public.writing_assignment_groups group_row
    where group_row.teacher_id = p_teacher_id
      and group_row.title is not null
      and left(group_row.title, char_length(base_title)) = base_title
      and (group_row.title = base_title
        or substring(group_row.title from ' \((\d+)\)$') is not null)
      and exists (
        select 1 from public.writing_assignments item
        where item.group_id = group_row.group_id
          and item.deleted_at is null
      );

    if not base_title_taken then
      final_title := base_title;
    else
      select free.sequence into next_sequence
      from generate_series(2, greatest(max_sequence, 1) + 1) as free(sequence)
      where not exists (
        select 1 from public.writing_assignment_groups taken
        where taken.teacher_id = p_teacher_id
          and taken.title = base_title || ' (' || free.sequence || ')'
          and exists (
            select 1 from public.writing_assignments item
            where item.group_id = taken.group_id
              and item.deleted_at is null
          )
      )
      order by free.sequence
      limit 1;
      final_title := base_title || ' (' || next_sequence || ')';
    end if;

    if char_length(final_title) > 120 then
      raise exception 'Assignment title is too long';
    end if;
  else
    final_title := base_title;
  end if;

  -- Group, title, class association, items and recipients are all inserted in
  -- this one transaction. Any failure rolls the whole creation back.
  insert into public.writing_assignment_groups (teacher_id, title, class_id)
  values (p_teacher_id, final_title, p_class_id)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, created_group_id, position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    if p_class_id is not null then
      -- Class mode: the creation-time member snapshot, ordered by joined_at.
      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select created_assignment_id, ordered.id, ordered.position
      from (
        select id, ordinality::integer as position
        from unnest(member_ids) with ordinality as ordered(id, ordinality)
      ) ordered;
    else
      -- Student mode: the teacher's selection order; the first occurrence
      -- wins when a student id is repeated in the payload.
      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select created_assignment_id, selected.id, selected.position
      from (
        select id, min(ordinality)::integer as position
        from unnest(p_student_ids) with ordinality as ordered(id, ordinality)
        group by id
      ) selected;
    end if;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'title', final_title,
    'class_id', p_class_id
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, uuid)
  to service_role;
