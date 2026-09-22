-- Phase A of a two-phase deployment (run this file first, in the Supabase SQL
-- Editor, AFTER supabase/writing_assignment_groups.sql).
--
-- Adds the persisted Assignment Group title used by both the teacher 作业管理
-- cards and the student 我的作业 cards, plus the recipient order used by the
-- teacher card's "第一位学生" and its 更多 list.
--
-- The new 5-argument create RPC writes the group row, the title, the assignment
-- items and the recipients (with their selection order) in one transaction.
-- When p_title_is_automatic is true the RPC also resolves the same-teacher
-- same-base-title sequence itself: the base title is sequence 1 and the next
-- free `(n)` is appended, serialized with a transaction-scoped advisory lock.
-- There is no post-create patch step: if the title or the recipient order
-- cannot be written, the whole creation fails and no group is created.
--
-- Phase A is forward compatible and re-runnable. It never drops a legacy
-- overload, so every deployed code version keeps working while the 5-argument
-- code is being rolled out:
--   * original code -> create_writing_assignment_group(uuid, jsonb, uuid[])
--   * previous Phase A code -> create_writing_assignment_group(uuid, jsonb, uuid[], text)
--   * new code -> create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean)
--
-- This file already covers the production state where a previous Phase A was
-- applied, so title/sort_order, their constraints, the 3-argument RPC and the
-- 4-argument RPC may already exist. Every schema statement is idempotent, and
-- the existing 3-argument and 4-argument overloads are only re-granted, never
-- revoked or dropped, so running this file a second time is safe.
--
-- Both legacy overloads are removed later by
-- supabase/writing_assignment_group_titles_cleanup.sql (Phase B), only after
-- the new code is live and verified.
--
-- Historical groups keep a null title and a null recipient order; they keep
-- falling back to the resolved question display name and to the previous
-- assigned_at/student_id ordering until the separate title backfill is
-- reviewed and run manually.

alter table public.writing_assignment_groups
  add column if not exists title text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_assignment_groups_title_check'
      and conrelid = 'public.writing_assignment_groups'::regclass
  ) then
    alter table public.writing_assignment_groups
      add constraint writing_assignment_groups_title_check
      check (title is null or char_length(title) between 1 and 120);
  end if;
end $$;

alter table public.writing_assignment_students
  add column if not exists sort_order integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_assignment_students_sort_order_check'
      and conrelid = 'public.writing_assignment_students'::regclass
  ) then
    alter table public.writing_assignment_students
      add constraint writing_assignment_students_sort_order_check
      check (sort_order is null or sort_order > 0);
  end if;
end $$;

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean
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

  base_title := nullif(btrim(coalesce(p_title, '')), '');
  if base_title is not null and char_length(base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'At least one student is required';
  end if;

  -- Recipients are active Students bound to this Teacher for the writing
  -- domain. Legacy profiles.owner_id is never used as an assignment fallback.
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

  -- Automatic titles are numbered per teacher and base title. The advisory
  -- lock serializes concurrent creates with the same base so both cannot pick
  -- the same free sequence. Teacher-written titles skip this block entirely.
  if base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || base_title, 0)
    );

    -- Only visible groups count: a group whose items are all soft-deleted has
    -- no card and must not occupy a number. The base title is sequence 1 and
    -- `base (n)` is sequence n; unrelated teacher titles are never parsed as
    -- numbers.
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
      -- Smallest free sequence, not max + 1, so gaps left by deleted groups
      -- are reused without duplicating an existing number.
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

  -- Group, title, items and recipients are all inserted in this one
  -- transaction. Any failure rolls the whole creation back.
  insert into public.writing_assignment_groups (teacher_id, title)
  values (p_teacher_id, final_title)
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

    -- sort_order keeps the teacher's recipient selection order; the first
    -- occurrence wins when a student id is repeated in the payload.
    insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
    select created_assignment_id, selected.id, selected.position
    from (
      select id, min(ordinality)::integer as position
      from unnest(p_student_ids) with ordinality as ordered(id, ordinality)
      group by id
    ) selected;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'title', final_title
  );
end;
$$;

-- Grants for every overload stay service_role-only. The legacy 3-argument and
-- 4-argument overloads are only re-granted (guarded so a database that never
-- ran the previous Phase A still works), never revoked or dropped, so the
-- currently deployed code keeps working during the transition window.
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  to service_role;

do $$
begin
  if to_regprocedure(
    'public.create_writing_assignment_group(uuid, jsonb, uuid[], text)'
  ) is not null then
    execute 'grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text) to service_role';
  end if;
end $$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean)
  to service_role;
