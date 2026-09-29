-- TPS student_practice_item_state parity verification (READ-ONLY, ONE result set).
--
-- Run this whole file once in the Supabase SQL Editor AFTER applying
-- supabase/student_practice_item_state.sql. It is a single SELECT, so the
-- editor always shows the complete result.
--
-- Result rows are grouped by `section`:
--   parity     -> 4 rows (one per task family); the three counter columns must
--                 all be 0:
--                   missing_state_rows : state row missing though history exists
--                   extra_state_rows   : state row without matching history
--                   value_mismatches   : status / attempt ids / count / dates /
--                                        reading score summary differ from the
--                                        historical JS algorithm
--   trigger    -> 15 rows; `present` must be true and `event_count` must be 3
--                 (the trigger covers INSERT + UPDATE + DELETE; the view lists
--                 one row per event, the query aggregates them back)
--   state_rows -> state row distribution per task type (snapshot)
--   revision   -> current catalog revision per task type / cache kind; an empty
--                 section is normal until the first content write after the
--                 migration (no row = revision 0, the app tolerates both)
--
-- If any parity counter is non-zero, send the whole result back and I will
-- provide a focused drill-down query for those items.
--
-- This file performs no INSERT / UPDATE / DELETE / RPC.

with
-- ---------------------------------------------------------------------------
-- Independent transcription of the directory eligibility rules
-- (lib/practicePublicUniverse.ts createPracticeCatalogDirectory +
-- isFormalSource). Deliberately NOT calling public.practice_item_is_public:
-- the expected side must not share the predicate it is verifying.
-- ---------------------------------------------------------------------------
catalog_items as (
  select
    item.item_id,
    item.task_type
  from public.practice_items item
  where item.task_type in ('build_sentence', 'email', 'academic_discussion')
    and item.is_active
    and nullif(btrim(coalesce(item.display_number, '')), '') is not null
    and exists (
      select 1
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
    )
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
      or not exists (
        select 1
        from public.practice_item_sources source
        where source.item_id = item.item_id
          and source.task_type = 'build_sentence'
          and source.is_canonical
          and source.source_set_id is not null
          and source.source_set_id <> ''
          and source.source_question_id is null
          and lower(btrim(source.source_set_id)) ~ '^(grammar|wrongbook)-'
      )
    )
),
-- ---------------------------------------------------------------------------
-- P1: Build a Sentence
-- ---------------------------------------------------------------------------
candidate_bas as (
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
  join catalog_items catalog
    on catalog.item_id = source.item_id
   and catalog.task_type = 'build_sentence'
),
expected_bas as (
  select
    candidate.student_id,
    candidate.item_id::text as item_id,
    'completed'::text as status,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc))[1] as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc))[1] as latest_completed_attempt_id,
    null::uuid as resume_attempt_id,
    count(*) as attempt_count,
    max(candidate.event_at) as last_started_at,
    max(candidate.submitted_at) as last_completed_at
  from candidate_bas candidate
  group by candidate.student_id, candidate.item_id
),
target_bas as (
  select
    state.student_id,
    state.item_id,
    state.status,
    state.latest_attempt_id,
    state.latest_completed_attempt_id,
    state.resume_attempt_id,
    state.attempt_count,
    state.last_started_at,
    state.last_completed_at
  from public.student_practice_item_state state
  where state.task_type = 'build_sentence'
),
bas_parity as (
  select
    count(*) filter (where target_bas.student_id is null) as missing_state_rows,
    count(*) filter (where expected_bas.student_id is null) as extra_state_rows,
    count(*) filter (
      where expected_bas.student_id is not null
        and target_bas.student_id is not null
        and (
          expected_bas.status is distinct from target_bas.status
          or expected_bas.latest_attempt_id is distinct from target_bas.latest_attempt_id
          or expected_bas.latest_completed_attempt_id is distinct from target_bas.latest_completed_attempt_id
          or expected_bas.resume_attempt_id is distinct from target_bas.resume_attempt_id
          or expected_bas.attempt_count is distinct from target_bas.attempt_count
          or expected_bas.last_started_at is distinct from target_bas.last_started_at
          or expected_bas.last_completed_at is distinct from target_bas.last_completed_at
        )
    ) as value_mismatches
  from expected_bas
  full join target_bas
    on target_bas.student_id = expected_bas.student_id
   and target_bas.item_id = expected_bas.item_id
),
-- ---------------------------------------------------------------------------
-- P2: Write an Email / Academic Discussion (free practice only)
-- ---------------------------------------------------------------------------
candidate_writing as (
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
  join catalog_items catalog
    on catalog.item_id = source.item_id
   and catalog.task_type = attempt.task_type
  where attempt.assignment_id is null
    and attempt.task_type in ('email', 'academic_discussion')
),
expected_writing as (
  select
    candidate.student_id,
    candidate.task_type,
    candidate.item_id::text as item_id,
    case
      when (array_agg(candidate.attempt_id
        order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
        filter (where candidate.status = 'draft'))[1] is not null
      then 'in_progress'
      else 'completed'
    end as status,
    (array_agg(candidate.attempt_id
      order by candidate.latest_event_at desc nulls last, candidate.attempt_id desc))[1] as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted'))[1] as latest_completed_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'draft'))[1] as resume_attempt_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    max(candidate.submitted_at) filter (where candidate.status = 'submitted') as last_completed_at
  from candidate_writing candidate
  group by candidate.student_id, candidate.task_type, candidate.item_id
),
target_writing as (
  select
    state.student_id,
    state.task_type,
    state.item_id,
    state.status,
    state.latest_attempt_id,
    state.latest_completed_attempt_id,
    state.resume_attempt_id,
    state.attempt_count,
    state.last_started_at,
    state.last_completed_at
  from public.student_practice_item_state state
  where state.task_type in ('email', 'academic_discussion')
),
writing_parity as (
  select
    count(*) filter (where target_writing.student_id is null) as missing_state_rows,
    count(*) filter (where expected_writing.student_id is null) as extra_state_rows,
    count(*) filter (
      where expected_writing.student_id is not null
        and target_writing.student_id is not null
        and (
          expected_writing.task_type is distinct from target_writing.task_type
          or expected_writing.status is distinct from target_writing.status
          or expected_writing.latest_attempt_id is distinct from target_writing.latest_attempt_id
          or expected_writing.latest_completed_attempt_id is distinct from target_writing.latest_completed_attempt_id
          or expected_writing.resume_attempt_id is distinct from target_writing.resume_attempt_id
          or expected_writing.attempt_count is distinct from target_writing.attempt_count
          or expected_writing.last_started_at is distinct from target_writing.last_started_at
          or expected_writing.last_completed_at is distinct from target_writing.last_completed_at
        )
    ) as value_mismatches
  from expected_writing
  full join target_writing
    on target_writing.student_id = expected_writing.student_id
   and target_writing.task_type = expected_writing.task_type
   and target_writing.item_id = expected_writing.item_id
),
-- ---------------------------------------------------------------------------
-- P3: Reading CTW / RDL / RAP
-- ---------------------------------------------------------------------------
candidate_reading as (
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
    attempt.correct_points,
    attempt.total_points,
    attempt.elapsed_seconds
  from public.reading_attempts attempt
  where attempt.task_type in ('ctw', 'rdl', 'rap')
),
expected_reading as (
  select
    candidate.student_id,
    candidate.task_type,
    candidate.item_id,
    case
      when (array_agg(candidate.attempt_id
        order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
        filter (where candidate.status = 'draft'))[1] is not null
      then 'in_progress'
      else 'completed'
    end as status,
    (array_agg(candidate.attempt_id
      order by candidate.latest_event_at desc nulls last, candidate.attempt_id desc))[1] as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted' and candidate.submitted_at is not null))[1] as latest_completed_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.draft_event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'draft'))[1] as resume_attempt_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    max(candidate.submitted_at) filter (where candidate.status = 'submitted') as last_completed_at,
    (array_agg(jsonb_build_object(
        'correctPoints', candidate.correct_points,
        'totalPoints', candidate.total_points,
        'elapsedSeconds', candidate.elapsed_seconds
      )
      order by candidate.submitted_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'submitted' and candidate.submitted_at is not null))[1] as latest_result
  from candidate_reading candidate
  group by candidate.student_id, candidate.task_type, candidate.item_id
),
target_reading as (
  select
    state.student_id,
    state.task_type,
    state.item_id,
    state.status,
    state.latest_attempt_id,
    state.latest_completed_attempt_id,
    state.resume_attempt_id,
    state.attempt_count,
    state.last_started_at,
    state.last_completed_at,
    state.latest_result
  from public.student_practice_item_state state
  where state.task_type in ('ctw', 'rdl', 'rap')
),
reading_parity as (
  select
    count(*) filter (where target_reading.student_id is null) as missing_state_rows,
    count(*) filter (where expected_reading.student_id is null) as extra_state_rows,
    count(*) filter (
      where expected_reading.student_id is not null
        and target_reading.student_id is not null
        and (
          expected_reading.task_type is distinct from target_reading.task_type
          or expected_reading.status is distinct from target_reading.status
          or expected_reading.latest_attempt_id is distinct from target_reading.latest_attempt_id
          or expected_reading.latest_completed_attempt_id is distinct from target_reading.latest_completed_attempt_id
          or expected_reading.resume_attempt_id is distinct from target_reading.resume_attempt_id
          or expected_reading.attempt_count is distinct from target_reading.attempt_count
          or expected_reading.last_started_at is distinct from target_reading.last_started_at
          or expected_reading.last_completed_at is distinct from target_reading.last_completed_at
          or expected_reading.latest_result is distinct from target_reading.latest_result
        )
    ) as value_mismatches
  from expected_reading
  full join target_reading
    on target_reading.student_id = expected_reading.student_id
   and target_reading.task_type = expected_reading.task_type
   and target_reading.item_id = expected_reading.item_id
),
-- ---------------------------------------------------------------------------
-- P4: Reading Full Set
-- ---------------------------------------------------------------------------
candidate_full_set as (
  select
    attempt.student_id,
    attempt.full_set_id as item_id,
    attempt.attempt_id,
    attempt.status,
    attempt.completed_at,
    coalesce(attempt.completed_at, attempt.created_at) as event_at,
    coalesce(attempt.started_at, attempt.created_at) as started_at
  from public.reading_full_set_attempts attempt
),
expected_full_set as (
  select
    candidate.student_id,
    candidate.item_id,
    case
      when (array_agg(candidate.attempt_id
        order by candidate.event_at desc nulls last, candidate.attempt_id desc)
        filter (where candidate.status = 'in_progress'))[1] is not null
      then 'in_progress'
      else 'completed'
    end as status,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc))[1] as latest_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.completed_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'completed' and candidate.completed_at is not null))[1] as latest_completed_attempt_id,
    (array_agg(candidate.attempt_id
      order by candidate.event_at desc nulls last, candidate.attempt_id desc)
      filter (where candidate.status = 'in_progress'))[1] as resume_attempt_id,
    count(*) as attempt_count,
    max(candidate.started_at) as last_started_at,
    max(candidate.completed_at) filter (where candidate.status = 'completed') as last_completed_at
  from candidate_full_set candidate
  group by candidate.student_id, candidate.item_id
),
target_full_set as (
  select
    state.student_id,
    state.item_id,
    state.status,
    state.latest_attempt_id,
    state.latest_completed_attempt_id,
    state.resume_attempt_id,
    state.attempt_count,
    state.last_started_at,
    state.last_completed_at
  from public.student_practice_item_state state
  where state.task_type = 'full_set'
),
full_set_parity as (
  select
    count(*) filter (where target_full_set.student_id is null) as missing_state_rows,
    count(*) filter (where expected_full_set.student_id is null) as extra_state_rows,
    count(*) filter (
      where expected_full_set.student_id is not null
        and target_full_set.student_id is not null
        and (
          expected_full_set.status is distinct from target_full_set.status
          or expected_full_set.latest_attempt_id is distinct from target_full_set.latest_attempt_id
          or expected_full_set.latest_completed_attempt_id is distinct from target_full_set.latest_completed_attempt_id
          or expected_full_set.resume_attempt_id is distinct from target_full_set.resume_attempt_id
          or expected_full_set.attempt_count is distinct from target_full_set.attempt_count
          or expected_full_set.last_started_at is distinct from target_full_set.last_started_at
          or expected_full_set.last_completed_at is distinct from target_full_set.last_completed_at
        )
    ) as value_mismatches
  from expected_full_set
  full join target_full_set
    on target_full_set.student_id = expected_full_set.student_id
   and target_full_set.item_id = expected_full_set.item_id
),
-- ---------------------------------------------------------------------------
-- Result assembly (single result set for the SQL editor)
-- ---------------------------------------------------------------------------
parity_rows as (
  select 'parity'::text as section, 'build_sentence'::text as check_name,
         bas_parity.missing_state_rows, bas_parity.extra_state_rows,
         bas_parity.value_mismatches, null::jsonb as detail
  from bas_parity
  union all
  select 'parity', 'writing (email + academic_discussion)',
         writing_parity.missing_state_rows, writing_parity.extra_state_rows,
         writing_parity.value_mismatches, null::jsonb
  from writing_parity
  union all
  select 'parity', 'reading (ctw + rdl + rap)',
         reading_parity.missing_state_rows, reading_parity.extra_state_rows,
         reading_parity.value_mismatches, null::jsonb
  from reading_parity
  union all
  select 'parity', 'full_set',
         full_set_parity.missing_state_rows, full_set_parity.extra_state_rows,
         full_set_parity.value_mismatches, null::jsonb
  from full_set_parity
),
trigger_rows as (
  select
    'trigger'::text as section,
    required.trigger_name as check_name,
    null::bigint as missing_state_rows,
    null::bigint as extra_state_rows,
    null::bigint as value_mismatches,
    -- information_schema.triggers lists one row per event (INSERT / UPDATE /
    -- DELETE), so aggregate back to one row per trigger.
    jsonb_build_object(
      'present', count(trigger.trigger_name) > 0,
      'event_count', count(trigger.trigger_name),
      'table', min(trigger.event_object_table)
    ) as detail
  from unnest(array[
    'trg_attempts_student_practice_item_state',
    'trg_writing_attempts_student_practice_item_state',
    'trg_reading_attempts_student_practice_item_state',
    'trg_reading_full_set_student_practice_item_state',
    'trg_practice_item_sources_student_practice_item_state',
    'trg_practice_items_student_practice_item_state',
    'trg_practice_items_catalog_revision',
    'trg_practice_item_sources_catalog_revision',
    'trg_practice_item_occurrences_catalog_revision',
    'trg_questions_catalog_revision',
    'trg_practice_item_question_map_catalog_revision',
    'trg_email_questions_catalog_revision',
    'trg_academic_discussion_questions_catalog_revision',
    'trg_reading_logical_items_catalog_revision',
    'trg_reading_source_occurrences_catalog_revision'
  ]) as required(trigger_name)
  left join information_schema.triggers trigger
    on trigger.trigger_name = required.trigger_name
   and trigger.trigger_schema = 'public'
  group by required.trigger_name
),
state_rows as (
  select
    'state_rows'::text as section,
    state.task_type as check_name,
    null::bigint as missing_state_rows,
    null::bigint as extra_state_rows,
    null::bigint as value_mismatches,
    jsonb_build_object(
      'state_rows', count(*),
      'in_progress_rows', count(*) filter (where state.status = 'in_progress'),
      'completed_rows', count(*) filter (where state.status = 'completed')
    ) as detail
  from public.student_practice_item_state state
  group by state.task_type
),
revision_rows as (
  select
    'revision'::text as section,
    revision.task_type || ':' || revision.cache_kind as check_name,
    null::bigint as missing_state_rows,
    null::bigint as extra_state_rows,
    null::bigint as value_mismatches,
    jsonb_build_object(
      'revision', revision.revision,
      'updated_at', revision.updated_at
    ) as detail
  from public.catalog_revisions revision
)
select
  checks.section,
  checks.check_name,
  checks.missing_state_rows,
  checks.extra_state_rows,
  checks.value_mismatches,
  checks.detail
from (
  select * from parity_rows
  union all
  select * from trigger_rows
  union all
  select * from state_rows
  union all
  select * from revision_rows
) checks
order by checks.section, checks.check_name;
