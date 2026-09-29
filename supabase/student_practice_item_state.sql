-- TPS unified student practice item state + public catalog revisions.
--
-- Scope:
--   * public.catalog_revisions                     (per task / cache kind revision)
--   * public.student_practice_item_state           (sparse per student+task+item state)
--   * rebuild functions + triggers for every write path
--   * one-time backfill from existing attempt history
--
-- Design notes:
--   * The state table is sparse: a student who never touched an item has NO row.
--     "No row" is the canonical `unstarted` representation.
--   * Every attempt change rebuilds only the affected (student, task, item) from
--     that item's own history; no student-wide or task-wide rescan is required.
--   * Catalog caches read `catalog_revisions`; the content tables only bump that
--     revision. This works for the importer, Admin API, and plain SQL Editor
--     writes without Next.js `revalidateTag` support inside the database.
--   * The whole file is transactional and safe to re-run: tables are created if
--     missing, functions are replaced, and triggers are dropped before creation.
--     The backfill overwrites/removes derived rows to match current history.
--
-- Apply manually. This migration never touches production attempt content.

begin;

-- ---------------------------------------------------------------------------
-- 0. Idempotent guards for columns owned by earlier migrations
-- ---------------------------------------------------------------------------
alter table public.reading_logical_items
  add column if not exists catalog_category text,
  add column if not exists catalog_search_text text not null default '';

alter table public.email_questions
  add column if not exists catalog_category text;

alter table public.academic_discussion_questions
  add column if not exists catalog_category text;

-- ---------------------------------------------------------------------------
-- 0b. Purposeful indexes for the trigger/rebuild read paths
-- ---------------------------------------------------------------------------
-- BAS attempts can carry surrounding whitespace in legacy rows; the catalog
-- always matched on the trimmed set id, so the rebuild does too.
create index if not exists attempts_trimmed_set_identity_idx
  on public.attempts (btrim(set_id))
  where set_id is not null;

-- Writing item rebuilds resolve a logical item from its raw question ids.
create index if not exists writing_attempts_question_identity_idx
  on public.writing_attempts (question_id, user_id)
  where assignment_id is null;

-- Heavy reading identity reads are covered by reading_attempts_student_item_idx
-- (student_id, logical_item_id, created_at desc) and
-- reading_full_set_attempts_student_idx (student_id, full_set_id, created_at desc).

-- ---------------------------------------------------------------------------
-- 1. Catalog cache revisions
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_revisions (
  task_type text not null check (task_type in (
    'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap', 'full_set'
  )),
  cache_kind text not null check (cache_kind in ('lightweight_catalog', 'search_index')),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (task_type, cache_kind)
);

alter table public.catalog_revisions enable row level security;

revoke all on table public.catalog_revisions from public, anon, authenticated;
grant select, insert, update, delete on table public.catalog_revisions to service_role;

-- Single-record O(1) bump. Called by triggers only; deliberately revoked from
-- clients so nobody can drive cache churn through PostgREST RPC.
create or replace function public.bump_catalog_revision(
  p_task_type text,
  p_cache_kind text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_task_type is null or p_cache_kind is null then
    return;
  end if;
  if p_cache_kind not in ('lightweight_catalog', 'search_index') then
    return;
  end if;

  insert into public.catalog_revisions as revisions (
    task_type, cache_kind, revision, updated_at
  )
  values (
    p_task_type, p_cache_kind, 1, clock_timestamp()
  )
  on conflict (task_type, cache_kind) do update
  set revision = revisions.revision + 1,
      updated_at = clock_timestamp();
end;
$$;

revoke all on function public.bump_catalog_revision(text, text) from public, anon, authenticated;
grant execute on function public.bump_catalog_revision(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Sparse student practice item state
-- ---------------------------------------------------------------------------
create table if not exists public.student_practice_item_state (
  student_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null check (task_type in (
    'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap', 'full_set'
  )),
  item_id text not null check (nullif(btrim(item_id), '') is not null),
  -- `unstarted` is never stored: row absence is the unstarted representation.
  status text not null check (status in ('unstarted', 'in_progress', 'completed')),
  -- Draft / active attempt used by "continue practice".
  resume_attempt_id uuid,
  -- Raw source identity of the resume attempt when it is not the canonical
  -- source (Writing duplicate raw questions only).
  resume_source_question_id text,
  latest_attempt_id uuid,
  latest_completed_attempt_id uuid,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  -- Display-only summary of the latest completed attempt (Reading score card).
  latest_result jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (student_id, task_type, item_id)
);

alter table public.student_practice_item_state enable row level security;

revoke all on table public.student_practice_item_state from public, anon, authenticated;
grant select, insert, update, delete on table public.student_practice_item_state to service_role;

-- ---------------------------------------------------------------------------
-- 3. Public item helpers (mirror the directory eligibility rules)
-- ---------------------------------------------------------------------------
create or replace function public.practice_item_is_public(
  p_item_id uuid,
  p_task_type text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select
      item.is_active
      and nullif(btrim(coalesce(item.display_number, '')), '') is not null
      and (
        select count(*)
        from public.practice_item_sources source
        where source.item_id = item.item_id
          and source.task_type = item.task_type
          and (
            (item.task_type = 'build_sentence'
              and source.source_set_id is not null
              and source.source_set_id <> ''
              and source.source_question_id is null)
            -- Writing formal sources only require a raw question id; the
            -- importer also stores the raw set id on the same row.
            or (item.task_type <> 'build_sentence'
              and source.source_question_id is not null
              and source.source_question_id <> '')
          )
      ) > 0
      and (
        select count(*)
        from public.practice_item_sources source
        where source.item_id = item.item_id
          and source.task_type = item.task_type
          and source.is_canonical
          and (
            (item.task_type = 'build_sentence'
              and source.source_set_id is not null
              and source.source_set_id <> ''
              and source.source_question_id is null)
            or (item.task_type <> 'build_sentence'
              and source.source_question_id is not null
              and source.source_question_id <> '')
          )
      ) = 1
      and (
        item.task_type <> 'build_sentence'
        or exists (
          select 1
          from public.practice_item_sources source
          where source.item_id = item.item_id
            and source.task_type = 'build_sentence'
            and source.is_canonical
            and source.source_set_id is not null
            and source.source_set_id <> ''
            and source.source_question_id is null
            and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
        )
      )
    from public.practice_items item
    where item.item_id = p_item_id
      and item.task_type = p_task_type
      and p_task_type in ('build_sentence', 'email', 'academic_discussion')
  ), false);
$$;

create or replace function public.writing_attempt_matches_item(
  p_question_id text,
  p_item_id uuid,
  p_task_type text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.practice_item_sources source
    where source.item_id = p_item_id
      and source.task_type = p_task_type
      and source.source_question_id is not null
      and source.source_question_id = p_question_id
  );
$$;

revoke all on function public.practice_item_is_public(uuid, text) from public, anon, authenticated;
revoke all on function public.writing_attempt_matches_item(text, uuid, text) from public, anon, authenticated;
grant execute on function public.practice_item_is_public(uuid, text) to service_role;
grant execute on function public.writing_attempt_matches_item(text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Per-item rebuild functions (the single source of truth for state)
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_student_practice_item_state_bas(
  p_student_id uuid,
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
begin
  if p_student_id is null or p_item_id is null then
    return;
  end if;

  if not public.practice_item_is_public(p_item_id, 'build_sentence') then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = 'build_sentence'
      and item_id = p_item_id::text;
    return;
  end if;

  select
    count(*),
    max(coalesce(attempt.submitted_at, attempt.created_at)),
    max(attempt.submitted_at)
  into v_count, v_last_started_at, v_last_completed_at
  from public.attempts attempt
  where attempt.student_id = p_student_id
    and btrim(attempt.set_id) in (
      select source.source_set_id
      from public.practice_item_sources source
      where source.item_id = p_item_id
        and source.task_type = 'build_sentence'
        and source.source_set_id is not null
        and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
    );

  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = 'build_sentence'
      and item_id = p_item_id::text;
    return;
  end if;

  -- BAS attempts are write-once completed records. The visible "latest attempt"
  -- is the latest event, exactly like the legacy catalog reducer.
  select attempt.attempt_id
  into v_latest
  from public.attempts attempt
  where attempt.student_id = p_student_id
    and btrim(attempt.set_id) in (
      select source.source_set_id
      from public.practice_item_sources source
      where source.item_id = p_item_id
        and source.task_type = 'build_sentence'
        and source.source_set_id is not null
        and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
    )
  order by coalesce(attempt.submitted_at, attempt.created_at) desc nulls last,
           attempt.attempt_id desc
  limit 1;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status,
    resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, 'build_sentence', p_item_id::text, 'completed',
    null, null,
    v_latest, v_latest, v_count,
    v_last_started_at, v_last_completed_at, null, clock_timestamp()
  )
  on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
      resume_attempt_id = excluded.resume_attempt_id,
      resume_source_question_id = excluded.resume_source_question_id,
      latest_attempt_id = excluded.latest_attempt_id,
      latest_completed_attempt_id = excluded.latest_completed_attempt_id,
      attempt_count = excluded.attempt_count,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      latest_result = excluded.latest_result,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.rebuild_student_practice_item_state_writing(
  p_student_id uuid,
  p_task_type text,
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
  v_resume uuid;
  v_resume_question_id text;
  v_completed uuid;
begin
  if p_student_id is null or p_item_id is null then
    return;
  end if;
  if p_task_type not in ('email', 'academic_discussion') then
    return;
  end if;

  if not public.practice_item_is_public(p_item_id, p_task_type) then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = p_task_type
      and item_id = p_item_id::text;
    return;
  end if;

  select
    count(*),
    max(coalesce(attempt.started_at, attempt.created_at)),
    max(attempt.submitted_at) filter (where attempt.status = 'submitted')
  into v_count, v_last_started_at, v_last_completed_at
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.assignment_id is null
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type);

  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = p_task_type
      and item_id = p_item_id::text;
    return;
  end if;

  select attempt.attempt_id, attempt.question_id
  into v_resume, v_resume_question_id
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.assignment_id is null
    and attempt.status = 'draft'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at) desc,
           attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id
  into v_completed
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.assignment_id is null
    and attempt.status = 'submitted'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by attempt.submitted_at desc nulls last, attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id
  into v_latest
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.assignment_id is null
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by
    (case when attempt.status = 'submitted'
      then coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at)
      else coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at)
    end) desc,
    attempt.attempt_id desc
  limit 1;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status,
    resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, p_task_type, p_item_id::text,
    case when v_resume is not null then 'in_progress' else 'completed' end,
    v_resume, case when v_resume is not null then v_resume_question_id else null end,
    v_latest, v_completed, v_count,
    v_last_started_at, v_last_completed_at, null, clock_timestamp()
  )
  on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
      resume_attempt_id = excluded.resume_attempt_id,
      resume_source_question_id = excluded.resume_source_question_id,
      latest_attempt_id = excluded.latest_attempt_id,
      latest_completed_attempt_id = excluded.latest_completed_attempt_id,
      attempt_count = excluded.attempt_count,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      latest_result = excluded.latest_result,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.rebuild_student_practice_item_state_reading(
  p_student_id uuid,
  p_task_type text,
  p_item_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
  v_resume uuid;
  v_completed uuid;
  v_latest_result jsonb;
begin
  if p_student_id is null or p_item_id is null then
    return;
  end if;
  if p_task_type not in ('ctw', 'rdl', 'rap') then
    return;
  end if;

  select
    count(*),
    max(coalesce(attempt.started_at, attempt.created_at)),
    max(attempt.submitted_at) filter (where attempt.status = 'submitted')
  into v_count, v_last_started_at, v_last_completed_at
  from public.reading_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.logical_item_id = p_item_id;

  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = p_task_type
      and item_id = p_item_id;
    return;
  end if;

  select attempt.attempt_id
  into v_resume
  from public.reading_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.logical_item_id = p_item_id
    and attempt.status = 'draft'
  order by coalesce(attempt.updated_at, attempt.created_at) desc,
           attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id, attempt.submitted_at,
         jsonb_build_object(
           'correctPoints', attempt.correct_points,
           'totalPoints', attempt.total_points,
           'elapsedSeconds', attempt.elapsed_seconds
         )
  into v_completed, v_last_completed_at, v_latest_result
  from public.reading_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.logical_item_id = p_item_id
    and attempt.status = 'submitted'
    and attempt.submitted_at is not null
  order by attempt.submitted_at desc, attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id
  into v_latest
  from public.reading_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.task_type = p_task_type
    and attempt.logical_item_id = p_item_id
  order by coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at) desc nulls last,
           attempt.attempt_id desc
  limit 1;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status,
    resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, p_task_type, p_item_id,
    case when v_resume is not null then 'in_progress' else 'completed' end,
    v_resume, null,
    v_latest, v_completed, v_count,
    v_last_started_at, v_last_completed_at, v_latest_result, clock_timestamp()
  )
  on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
      resume_attempt_id = excluded.resume_attempt_id,
      resume_source_question_id = excluded.resume_source_question_id,
      latest_attempt_id = excluded.latest_attempt_id,
      latest_completed_attempt_id = excluded.latest_completed_attempt_id,
      attempt_count = excluded.attempt_count,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      latest_result = excluded.latest_result,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.rebuild_student_practice_item_state_full_set(
  p_student_id uuid,
  p_full_set_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
  v_resume uuid;
  v_completed uuid;
begin
  if p_student_id is null or p_full_set_id is null then
    return;
  end if;

  select
    count(*),
    max(coalesce(attempt.started_at, attempt.created_at)),
    max(attempt.completed_at) filter (where attempt.status = 'completed')
  into v_count, v_last_started_at, v_last_completed_at
  from public.reading_full_set_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.full_set_id = p_full_set_id;

  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id
      and task_type = 'full_set'
      and item_id = p_full_set_id;
    return;
  end if;

  select attempt.attempt_id
  into v_resume
  from public.reading_full_set_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.full_set_id = p_full_set_id
    and attempt.status = 'in_progress'
  order by coalesce(attempt.completed_at, attempt.created_at) desc,
           attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id
  into v_completed
  from public.reading_full_set_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.full_set_id = p_full_set_id
    and attempt.status = 'completed'
    and attempt.completed_at is not null
  order by attempt.completed_at desc, attempt.attempt_id desc
  limit 1;

  select attempt.attempt_id
  into v_latest
  from public.reading_full_set_attempts attempt
  where attempt.student_id = p_student_id
    and attempt.full_set_id = p_full_set_id
  order by coalesce(attempt.completed_at, attempt.created_at) desc nulls last,
           attempt.attempt_id desc
  limit 1;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status,
    resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, 'full_set', p_full_set_id,
    case when v_resume is not null then 'in_progress' else 'completed' end,
    v_resume, null,
    v_latest, v_completed, v_count,
    v_last_started_at, v_last_completed_at, null, clock_timestamp()
  )
  on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
      resume_attempt_id = excluded.resume_attempt_id,
      resume_source_question_id = excluded.resume_source_question_id,
      latest_attempt_id = excluded.latest_attempt_id,
      latest_completed_attempt_id = excluded.latest_completed_attempt_id,
      attempt_count = excluded.attempt_count,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      latest_result = excluded.latest_result,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.rebuild_student_practice_item_state(
  p_student_id uuid,
  p_task_type text,
  p_item_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_student_id is null or p_item_id is null then
    return;
  end if;

  case p_task_type
    when 'build_sentence' then
      perform public.rebuild_student_practice_item_state_bas(p_student_id, p_item_id::uuid);
    when 'email', 'academic_discussion' then
      perform public.rebuild_student_practice_item_state_writing(p_student_id, p_task_type, p_item_id::uuid);
    when 'ctw', 'rdl', 'rap' then
      perform public.rebuild_student_practice_item_state_reading(p_student_id, p_task_type, p_item_id);
    when 'full_set' then
      perform public.rebuild_student_practice_item_state_full_set(p_student_id, p_item_id);
    else
      return;
  end case;
end;
$$;

create or replace function public.rebuild_student_practice_item_state_for_bas_set(
  p_student_id uuid,
  p_set_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if p_student_id is null or nullif(btrim(coalesce(p_set_id, '')), '') is null then
    return;
  end if;

  for v_item_id in
    select source.item_id
    from public.practice_item_sources source
    where source.task_type = 'build_sentence'
      and source.source_set_id = btrim(p_set_id)
      and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
  loop
    perform public.rebuild_student_practice_item_state_bas(p_student_id, v_item_id);
  end loop;
end;
$$;

create or replace function public.rebuild_student_practice_item_state_for_writing_question(
  p_student_id uuid,
  p_task_type text,
  p_question_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if p_student_id is null or nullif(btrim(coalesce(p_question_id, '')), '') is null then
    return;
  end if;
  if p_task_type not in ('email', 'academic_discussion') then
    return;
  end if;

  for v_item_id in
    select source.item_id
    from public.practice_item_sources source
    where source.task_type = p_task_type
      and source.source_question_id = p_question_id
  loop
    perform public.rebuild_student_practice_item_state_writing(p_student_id, p_task_type, v_item_id);
  end loop;
end;
$$;

-- Used when the item identity mapping itself changes (new duplicate source,
-- item activated/deactivated): rebuild the state of every student who has an
-- attempt on any source of this item.
create or replace function public.rebuild_student_practice_item_state_for_item(
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_type text;
  v_student_id uuid;
begin
  if p_item_id is null then
    return;
  end if;

  select item.task_type into v_task_type
  from public.practice_items item
  where item.item_id = p_item_id;

  if v_task_type is null then
    return;
  end if;

  if v_task_type = 'build_sentence' then
    for v_student_id in
      select distinct attempt.student_id
      from public.attempts attempt
      join public.practice_item_sources source
        on source.item_id = p_item_id
       and source.task_type = 'build_sentence'
       and source.source_set_id = btrim(attempt.set_id)
    loop
      perform public.rebuild_student_practice_item_state_bas(v_student_id, p_item_id);
    end loop;
    return;
  end if;

  if v_task_type in ('email', 'academic_discussion') then
    for v_student_id in
      select distinct attempt.user_id
      from public.writing_attempts attempt
      join public.practice_item_sources source
        on source.item_id = p_item_id
       and source.task_type = v_task_type
       and source.source_question_id = attempt.question_id
      where attempt.task_type = v_task_type
        and attempt.assignment_id is null
    loop
      perform public.rebuild_student_practice_item_state_writing(v_student_id, v_task_type, p_item_id);
    end loop;
  end if;
end;
$$;

revoke all on function public.rebuild_student_practice_item_state_bas(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_writing(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_reading(uuid, text, text) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_full_set(uuid, text) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state(uuid, text, text) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_for_bas_set(uuid, text) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_for_writing_question(uuid, text, text) from public, anon, authenticated;
revoke all on function public.rebuild_student_practice_item_state_for_item(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_student_practice_item_state(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Trigger entry points for state maintenance
-- ---------------------------------------------------------------------------
create or replace function public.sync_student_practice_item_state_attempts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.rebuild_student_practice_item_state_for_bas_set(old.student_id, old.set_id);
    return null;
  end if;

  if tg_op = 'UPDATE'
     and (old.student_id is distinct from new.student_id
       or old.set_id is distinct from new.set_id) then
    perform public.rebuild_student_practice_item_state_for_bas_set(old.student_id, old.set_id);
  end if;

  perform public.rebuild_student_practice_item_state_for_bas_set(new.student_id, new.set_id);
  return null;
end;
$$;

create or replace function public.sync_student_practice_item_state_writing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT'
     and old.assignment_id is null then
    perform public.rebuild_student_practice_item_state_for_writing_question(
      old.user_id, old.task_type, old.question_id
    );
  end if;

  if tg_op <> 'DELETE'
     and new.assignment_id is null
     and (tg_op = 'INSERT'
       or old.user_id is distinct from new.user_id
       or old.task_type is distinct from new.task_type
       or old.question_id is distinct from new.question_id) then
    perform public.rebuild_student_practice_item_state_for_writing_question(
      new.user_id, new.task_type, new.question_id
    );
  end if;

  return null;
end;
$$;

create or replace function public.sync_student_practice_item_state_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    perform public.rebuild_student_practice_item_state(
      old.student_id, old.task_type, old.logical_item_id
    );
  end if;

  if tg_op <> 'DELETE'
     and (tg_op = 'INSERT'
       or old.student_id is distinct from new.student_id
       or old.task_type is distinct from new.task_type
       or old.logical_item_id is distinct from new.logical_item_id) then
    perform public.rebuild_student_practice_item_state(
      new.student_id, new.task_type, new.logical_item_id
    );
  end if;

  return null;
end;
$$;

create or replace function public.sync_student_practice_item_state_full_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    perform public.rebuild_student_practice_item_state_full_set(old.student_id, old.full_set_id);
  end if;

  if tg_op <> 'DELETE'
     and (tg_op = 'INSERT'
       or old.student_id is distinct from new.student_id
       or old.full_set_id is distinct from new.full_set_id) then
    perform public.rebuild_student_practice_item_state_full_set(new.student_id, new.full_set_id);
  end if;

  return null;
end;
$$;

create or replace function public.sync_student_practice_item_state_practice_item_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'DELETE' then
    perform public.rebuild_student_practice_item_state_for_item(new.item_id);
  end if;
  if tg_op <> 'INSERT' then
    perform public.rebuild_student_practice_item_state_for_item(old.item_id);
  end if;
  return null;
end;
$$;

create or replace function public.sync_student_practice_item_state_practice_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'DELETE' then
    perform public.rebuild_student_practice_item_state_for_item(new.item_id);
  end if;
  if tg_op <> 'INSERT' then
    perform public.rebuild_student_practice_item_state_for_item(old.item_id);
  end if;
  return null;
end;
$$;

revoke all on function public.sync_student_practice_item_state_attempts() from public, anon, authenticated;
revoke all on function public.sync_student_practice_item_state_writing() from public, anon, authenticated;
revoke all on function public.sync_student_practice_item_state_reading() from public, anon, authenticated;
revoke all on function public.sync_student_practice_item_state_full_set() from public, anon, authenticated;
revoke all on function public.sync_student_practice_item_state_practice_item_source() from public, anon, authenticated;
revoke all on function public.sync_student_practice_item_state_practice_item() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Catalog revision triggers
-- ---------------------------------------------------------------------------
create or replace function public.sync_catalog_revision_practice_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_type text;
  v_search_membership_changed boolean := true;
begin
  v_task_type := coalesce(new.task_type, old.task_type);
  if v_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    -- The search index also encodes which items belong to the searchable set:
    -- active items with a public display number, scoped by task type. A pure
    -- directory update (display number value, title, first_seen date) never
    -- changes membership, and this database refreshes first_seen_date on every
    -- occurrence write, so only a membership move may invalidate the index.
    v_search_membership_changed :=
      old.task_type is distinct from new.task_type
      or old.is_active is distinct from new.is_active
      or nullif(btrim(coalesce(old.display_number, '')), '')
           is distinct from nullif(btrim(coalesce(new.display_number, '')), '');
  end if;

  perform public.bump_catalog_revision(v_task_type, 'lightweight_catalog');
  if v_search_membership_changed then
    perform public.bump_catalog_revision(v_task_type, 'search_index');
  end if;

  -- An item that moves between task types must leave the old task caches too.
  if tg_op = 'UPDATE'
     and old.task_type is distinct from new.task_type
     and old.task_type in ('build_sentence', 'email', 'academic_discussion') then
    perform public.bump_catalog_revision(old.task_type, 'lightweight_catalog');
    perform public.bump_catalog_revision(old.task_type, 'search_index');
  end if;

  return null;
end;
$$;

create or replace function public.sync_catalog_revision_practice_item_sources()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_type text;
  v_mapping_changed boolean := true;
begin
  v_task_type := coalesce(new.task_type, old.task_type);
  if v_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    return null;
  end if;

  if tg_op = 'UPDATE'
     and old.task_type = new.task_type
     and old.item_id = new.item_id
     and old.source_set_id is not distinct from new.source_set_id
     and old.source_question_id is not distinct from new.source_question_id
     and old.is_canonical = new.is_canonical then
    v_mapping_changed := false;
  end if;

  -- A source mapping change moves occurrences between logical items.
  perform public.bump_catalog_revision(v_task_type, 'lightweight_catalog');
  if v_mapping_changed then
    perform public.bump_catalog_revision(v_task_type, 'search_index');
  end if;
  return null;
end;
$$;

create or replace function public.sync_catalog_revision_practice_item_occurrences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_type text;
begin
  select source.task_type into v_task_type
  from public.practice_item_sources source
  where source.source_id = coalesce(new.source_id, old.source_id);

  if v_task_type in ('build_sentence', 'email', 'academic_discussion') then
    -- New occurrences move dates on the lightweight card only; searchable
    -- content does not change.
    perform public.bump_catalog_revision(v_task_type, 'lightweight_catalog');
  end if;
  return null;
end;
$$;

create or replace function public.sync_catalog_revision_questions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.bump_catalog_revision('build_sentence', 'lightweight_catalog');
  perform public.bump_catalog_revision('build_sentence', 'search_index');
  return null;
end;
$$;

create or replace function public.sync_catalog_revision_practice_item_question_map()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.bump_catalog_revision('build_sentence', 'lightweight_catalog');
  return null;
end;
$$;

create or replace function public.sync_catalog_revision_writing_questions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_type text;
begin
  -- One function is shared by email_questions and academic_discussion_questions;
  -- tg_table_name keeps each table on its own task type.
  v_task_type := case tg_table_name
    when 'email_questions' then 'email'
    when 'academic_discussion_questions' then 'academic_discussion'
    else null
  end;
  if v_task_type is null then
    return null;
  end if;

  -- Category and content changes share one table; bump both catalog kinds.
  perform public.bump_catalog_revision(v_task_type, 'lightweight_catalog');
  perform public.bump_catalog_revision(v_task_type, 'search_index');
  return null;
end;
$$;

create or replace function public.sync_catalog_revision_reading_logical_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module text;
  v_old_module text;
  v_lightweight_changed boolean := true;
  v_search_changed boolean := true;
begin
  v_module := coalesce(new.module, old.module);
  v_old_module := old.module;
  if v_module is null then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    v_lightweight_changed :=
      old.module is distinct from new.module
      or old.title is distinct from new.title
      or old.first_seen_date is distinct from new.first_seen_date
      or old.first_seen_source_label is distinct from new.first_seen_source_label
      or old.first_seen_source_order is distinct from new.first_seen_source_order
      or old.question_count is distinct from new.question_count
      or old.scored_item_count is distinct from new.scored_item_count
      or old.catalog_category is distinct from new.catalog_category
      or old.is_active is distinct from new.is_active;
    v_search_changed := old.catalog_search_text is distinct from new.catalog_search_text;
  end if;

  if v_lightweight_changed then
    perform public.bump_catalog_revision(v_module, 'lightweight_catalog');
    -- Full Set validity and card data depend on the logical item shape.
    perform public.bump_catalog_revision('full_set', 'lightweight_catalog');
  end if;
  if v_search_changed then
    perform public.bump_catalog_revision(v_module, 'search_index');
  end if;

  if tg_op = 'UPDATE' and v_old_module is not null and v_old_module <> v_module then
    perform public.bump_catalog_revision(v_old_module, 'lightweight_catalog');
    perform public.bump_catalog_revision(v_old_module, 'search_index');
  end if;

  if tg_op = 'DELETE' then
    perform public.bump_catalog_revision(v_module, 'lightweight_catalog');
    perform public.bump_catalog_revision(v_module, 'search_index');
    perform public.bump_catalog_revision('full_set', 'lightweight_catalog');
  end if;

  return null;
end;
$$;

create or replace function public.sync_catalog_revision_reading_source_occurrences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module text;
begin
  select item.module into v_module
  from public.reading_logical_items item
  where item.logical_item_id = coalesce(new.logical_item_id, old.logical_item_id);

  if v_module in ('ctw', 'rdl', 'rap') then
    perform public.bump_catalog_revision(v_module, 'lightweight_catalog');
  end if;
  -- Source occurrences define which dates form a valid Full Set.
  perform public.bump_catalog_revision('full_set', 'lightweight_catalog');
  return null;
end;
$$;

revoke all on function public.sync_catalog_revision_practice_items() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_practice_item_sources() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_practice_item_occurrences() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_questions() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_practice_item_question_map() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_writing_questions() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_reading_logical_items() from public, anon, authenticated;
revoke all on function public.sync_catalog_revision_reading_source_occurrences() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Atomic initialization window (lock -> backfill -> triggers -> commit)
-- ---------------------------------------------------------------------------
lock table public.attempts,
           public.writing_attempts,
           public.reading_attempts,
           public.reading_full_set_attempts,
           public.practice_item_sources,
           public.practice_items
  in share row exclusive mode;

-- Backfill: BAS logical items from every formal source of the item.
insert into public.student_practice_item_state as state (
  student_id, task_type, item_id, status,
  resume_attempt_id, resume_source_question_id,
  latest_attempt_id, latest_completed_attempt_id, attempt_count,
  last_started_at, last_completed_at, latest_result, updated_at
)
select
  grouped.student_id,
  'build_sentence',
  grouped.item_id::text,
  'completed',
  null,
  null,
  grouped.latest_attempt_id,
  grouped.latest_attempt_id,
  grouped.attempt_count,
  grouped.last_started_at,
  grouped.last_completed_at,
  null,
  clock_timestamp()
from (
  select
    candidate.student_id,
    candidate.item_id,
    count(*) as attempt_count,
    max(candidate.event_at) as last_started_at,
    max(candidate.submitted_at) as last_completed_at,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc))[1]
      as latest_attempt_id
  from (
    select
      attempt.student_id,
      source.item_id,
      attempt.attempt_id,
      coalesce(attempt.submitted_at, attempt.created_at) as event_at,
      attempt.submitted_at
    from public.attempts attempt
    join public.practice_item_sources source
      on source.task_type = 'build_sentence'
     and source.source_set_id = btrim(attempt.set_id)
     and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
    where public.practice_item_is_public(source.item_id, 'build_sentence')
  ) candidate
  group by candidate.student_id, candidate.item_id
) grouped
on conflict (student_id, task_type, item_id) do update
set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result,
    updated_at = excluded.updated_at;

-- Backfill: Writing free-practice drafts and submissions.
insert into public.student_practice_item_state as state (
  student_id, task_type, item_id, status,
  resume_attempt_id, resume_source_question_id,
  latest_attempt_id, latest_completed_attempt_id, attempt_count,
  last_started_at, last_completed_at, latest_result, updated_at
)
select
  grouped.student_id,
  grouped.task_type,
  grouped.item_id::text,
  case when grouped.resume_attempt_id is not null then 'in_progress' else 'completed' end,
  grouped.resume_attempt_id,
  grouped.resume_source_question_id,
  grouped.latest_attempt_id,
  grouped.latest_completed_attempt_id,
  grouped.attempt_count,
  grouped.last_started_at,
  grouped.last_completed_at,
  null,
  clock_timestamp()
from (
  select
    candidate.student_id,
    candidate.task_type,
    candidate.item_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    max(candidate.submitted_at) filter (where candidate.status = 'submitted') as last_completed_at,
    (array_agg(candidate.attempt_id
      order by candidate.latest_event_at desc nulls last, candidate.attempt_id desc))[1]
      as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'draft'))[1]
      as resume_attempt_id,
    (array_agg(candidate.question_id
      order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'draft'))[1]
      as resume_source_question_id,
    (array_agg(candidate.attempt_id
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted'))[1]
      as latest_completed_attempt_id
  from (
    select
      attempt.user_id as student_id,
      attempt.task_type,
      source.item_id,
      attempt.attempt_id,
      attempt.question_id,
      attempt.status,
      coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at) as draft_event_at,
      case when attempt.status = 'submitted'
        then coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at)
        else coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at)
      end as latest_event_at,
      attempt.submitted_at,
      coalesce(attempt.started_at, attempt.created_at) as started_at
    from public.writing_attempts attempt
    join public.practice_item_sources source
      on source.task_type = attempt.task_type
     and source.source_question_id = attempt.question_id
    where attempt.assignment_id is null
      and attempt.task_type in ('email', 'academic_discussion')
      and public.practice_item_is_public(source.item_id, attempt.task_type)
  ) candidate
  group by candidate.student_id, candidate.task_type, candidate.item_id
) grouped
on conflict (student_id, task_type, item_id) do update
set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result,
    updated_at = excluded.updated_at;

-- Backfill: Reading CTW / RDL / RAP drafts and submissions.
insert into public.student_practice_item_state as state (
  student_id, task_type, item_id, status,
  resume_attempt_id, resume_source_question_id,
  latest_attempt_id, latest_completed_attempt_id, attempt_count,
  last_started_at, last_completed_at, latest_result, updated_at
)
select
  grouped.student_id,
  grouped.task_type,
  grouped.item_id,
  case when grouped.resume_attempt_id is not null then 'in_progress' else 'completed' end,
  grouped.resume_attempt_id,
  null,
  grouped.latest_attempt_id,
  grouped.latest_completed_attempt_id,
  grouped.attempt_count,
  grouped.last_started_at,
  grouped.last_completed_at,
  grouped.latest_result,
  clock_timestamp()
from (
  select
    candidate.student_id,
    candidate.task_type,
    candidate.item_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    (array_agg(candidate.attempt_id
      order by candidate.latest_event_at desc nulls last, candidate.attempt_id desc))[1]
      as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'draft'))[1]
      as resume_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted' and candidate.submitted_at is not null))[1]
      as latest_completed_attempt_id,
    (array_agg(candidate.submitted_at
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted' and candidate.submitted_at is not null))[1]
      as last_completed_at,
    (array_agg(candidate.latest_result
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted' and candidate.submitted_at is not null))[1]
      as latest_result
  from (
    select
      attempt.student_id,
      attempt.task_type,
      attempt.logical_item_id as item_id,
      attempt.attempt_id,
      attempt.status,
      coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at) as latest_event_at,
      coalesce(attempt.updated_at, attempt.created_at) as draft_event_at,
      attempt.submitted_at,
      coalesce(attempt.started_at, attempt.created_at) as started_at,
      jsonb_build_object(
        'correctPoints', attempt.correct_points,
        'totalPoints', attempt.total_points,
        'elapsedSeconds', attempt.elapsed_seconds
      ) as latest_result
    from public.reading_attempts attempt
    where attempt.task_type in ('ctw', 'rdl', 'rap')
  ) candidate
  group by candidate.student_id, candidate.task_type, candidate.item_id
) grouped
on conflict (student_id, task_type, item_id) do update
set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result,
    updated_at = excluded.updated_at;

-- Backfill: Reading Full Set attempts.
insert into public.student_practice_item_state as state (
  student_id, task_type, item_id, status,
  resume_attempt_id, resume_source_question_id,
  latest_attempt_id, latest_completed_attempt_id, attempt_count,
  last_started_at, last_completed_at, latest_result, updated_at
)
select
  grouped.student_id,
  'full_set',
  grouped.item_id,
  case when grouped.resume_attempt_id is not null then 'in_progress' else 'completed' end,
  grouped.resume_attempt_id,
  null,
  grouped.latest_attempt_id,
  grouped.latest_completed_attempt_id,
  grouped.attempt_count,
  grouped.last_started_at,
  grouped.last_completed_at,
  null,
  clock_timestamp()
from (
  select
    candidate.student_id,
    candidate.item_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    max(candidate.completed_at) filter (where candidate.status = 'completed') as last_completed_at,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc))[1]
      as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'in_progress'))[1]
      as resume_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.completed_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'completed' and candidate.completed_at is not null))[1]
      as latest_completed_attempt_id
  from (
    select
      attempt.student_id,
      attempt.full_set_id as item_id,
      attempt.attempt_id,
      attempt.status,
      attempt.completed_at,
      coalesce(attempt.completed_at, attempt.created_at) as event_at,
      coalesce(attempt.started_at, attempt.created_at) as started_at
    from public.reading_full_set_attempts attempt
  ) candidate
  group by candidate.student_id, candidate.item_id
) grouped
on conflict (student_id, task_type, item_id) do update
set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result,
    updated_at = excluded.updated_at;

-- Remove state rows whose source history disappeared or whose item is no
-- longer public (keeps re-runs and repaired history consistent).
delete from public.student_practice_item_state state
where (
  state.task_type = 'build_sentence'
  and (
    not public.practice_item_is_public(state.item_id::uuid, 'build_sentence')
    or not exists (
      select 1
      from public.attempts attempt
      join public.practice_item_sources source
        on source.item_id = state.item_id::uuid
       and source.task_type = 'build_sentence'
       and source.source_set_id = btrim(attempt.set_id)
      where attempt.student_id = state.student_id
        and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
    )
  )
) or (
  state.task_type in ('email', 'academic_discussion')
  and (
    not public.practice_item_is_public(state.item_id::uuid, state.task_type)
    or not exists (
      select 1
      from public.writing_attempts attempt
      join public.practice_item_sources source
        on source.item_id = state.item_id::uuid
       and source.task_type = state.task_type
       and source.source_question_id = attempt.question_id
      where attempt.user_id = state.student_id
        and attempt.task_type = state.task_type
        and attempt.assignment_id is null
    )
  )
) or (
  state.task_type in ('ctw', 'rdl', 'rap')
  and not exists (
    select 1
    from public.reading_attempts attempt
    where attempt.student_id = state.student_id
      and attempt.task_type = state.task_type
      and attempt.logical_item_id = state.item_id
  )
) or (
  state.task_type = 'full_set'
  and not exists (
    select 1
    from public.reading_full_set_attempts attempt
    where attempt.student_id = state.student_id
      and attempt.full_set_id = state.item_id
  )
);

-- Enable incremental maintenance only after the snapshot is complete.
drop trigger if exists trg_attempts_student_practice_item_state on public.attempts;
create trigger trg_attempts_student_practice_item_state
after insert or update or delete on public.attempts
for each row execute function public.sync_student_practice_item_state_attempts();

drop trigger if exists trg_writing_attempts_student_practice_item_state on public.writing_attempts;
create trigger trg_writing_attempts_student_practice_item_state
after insert or update or delete on public.writing_attempts
for each row execute function public.sync_student_practice_item_state_writing();

drop trigger if exists trg_reading_attempts_student_practice_item_state on public.reading_attempts;
create trigger trg_reading_attempts_student_practice_item_state
after insert or update or delete on public.reading_attempts
for each row execute function public.sync_student_practice_item_state_reading();

drop trigger if exists trg_reading_full_set_student_practice_item_state on public.reading_full_set_attempts;
create trigger trg_reading_full_set_student_practice_item_state
after insert or update or delete on public.reading_full_set_attempts
for each row execute function public.sync_student_practice_item_state_full_set();

drop trigger if exists trg_practice_item_sources_student_practice_item_state on public.practice_item_sources;
create trigger trg_practice_item_sources_student_practice_item_state
after insert or update or delete on public.practice_item_sources
for each row execute function public.sync_student_practice_item_state_practice_item_source();

drop trigger if exists trg_practice_items_student_practice_item_state on public.practice_items;
create trigger trg_practice_items_student_practice_item_state
after insert or update or delete on public.practice_items
for each row execute function public.sync_student_practice_item_state_practice_item();

drop trigger if exists trg_practice_items_catalog_revision on public.practice_items;
create trigger trg_practice_items_catalog_revision
after insert or update or delete on public.practice_items
for each row execute function public.sync_catalog_revision_practice_items();

drop trigger if exists trg_practice_item_sources_catalog_revision on public.practice_item_sources;
create trigger trg_practice_item_sources_catalog_revision
after insert or update or delete on public.practice_item_sources
for each row execute function public.sync_catalog_revision_practice_item_sources();

drop trigger if exists trg_practice_item_occurrences_catalog_revision on public.practice_item_occurrences;
create trigger trg_practice_item_occurrences_catalog_revision
after insert or update or delete on public.practice_item_occurrences
for each row execute function public.sync_catalog_revision_practice_item_occurrences();

drop trigger if exists trg_questions_catalog_revision on public.questions;
create trigger trg_questions_catalog_revision
after insert or update or delete on public.questions
for each row execute function public.sync_catalog_revision_questions();

drop trigger if exists trg_practice_item_question_map_catalog_revision on public.practice_item_question_map;
create trigger trg_practice_item_question_map_catalog_revision
after insert or update or delete on public.practice_item_question_map
for each row execute function public.sync_catalog_revision_practice_item_question_map();

drop trigger if exists trg_email_questions_catalog_revision on public.email_questions;
create trigger trg_email_questions_catalog_revision
after insert or update or delete on public.email_questions
for each row execute function public.sync_catalog_revision_writing_questions();

drop trigger if exists trg_academic_discussion_questions_catalog_revision on public.academic_discussion_questions;
create trigger trg_academic_discussion_questions_catalog_revision
after insert or update or delete on public.academic_discussion_questions
for each row execute function public.sync_catalog_revision_writing_questions();

drop trigger if exists trg_reading_logical_items_catalog_revision on public.reading_logical_items;
create trigger trg_reading_logical_items_catalog_revision
after insert or update or delete on public.reading_logical_items
for each row execute function public.sync_catalog_revision_reading_logical_items();

drop trigger if exists trg_reading_source_occurrences_catalog_revision on public.reading_source_occurrences;
create trigger trg_reading_source_occurrences_catalog_revision
after insert or update or delete on public.reading_source_occurrences
for each row execute function public.sync_catalog_revision_reading_source_occurrences();

-- ---------------------------------------------------------------------------
-- 8. In-migration structural checks (abort and roll back on any violation)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad integer;
begin
  select count(*)
  into v_bad
  from public.student_practice_item_state state
  where state.attempt_count < 1
     or (state.status = 'in_progress' and state.resume_attempt_id is null)
     or (state.status = 'completed' and state.latest_completed_attempt_id is null);

  if v_bad > 0 then
    raise exception 'student_practice_item_state structural check failed: % row(s)', v_bad;
  end if;
end;
$$;

commit;
