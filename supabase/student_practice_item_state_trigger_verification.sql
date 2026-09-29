-- TPS student_practice_item_state + catalog revision trigger verification.
--
-- READ/WRITE ONLY INSIDE A ROLLED-BACK TRANSACTION.
-- Run this whole file once in the Supabase SQL Editor. The last statement is
-- ROLLBACK, so no test attempt, occurrence, revision, or state row survives.
--
-- Expected result: one row, ALL_CHECKS_PASSED.
-- On failure you get an exception like "T1 failed: ..."; the transaction is
-- then aborted, so run `rollback;` once and send me the exact message.
--
-- Covers: BAS insert / older insert / delete rebuild / virtual set isolation,
-- Writing draft -> submitted -> retake -> delete and assignment isolation,
-- Reading draft / submitted / retake / delete with score summary,
-- Full Set in_progress / completed / retake, and direct-SQL occurrence writes
-- bumping the lightweight catalog revision (the mechanism that makes manual SQL
-- writes visible to the Next.js caches).
--
-- The last checks take a short EXCLUSIVE lock on public.catalog_revisions so
-- concurrent production writes (imports) cannot land between the "before" and
-- "after" revision reads. Other user triggers on the occurrence tables (e.g.
-- production first-seen denormalization) are temporarily disabled inside the
-- same rolled-back transaction so T19/T20 measure exactly our revision trigger.
-- The lock and every disabled trigger are restored by the final rollback.

begin;

do $$
declare
  v_student uuid;
  -- BAS
  v_item uuid;
  v_set text;
  v_baseline_count integer;
  v_baseline_latest uuid;
  v_attempt_new uuid;
  v_attempt_old uuid;
  v_count integer;
  v_latest uuid;
  v_completed uuid;
  v_resume_question text;
  v_status text;
  v_rows_before integer;
  v_rows_after integer;
  -- Writing
  v_writing_item uuid;
  v_writing_question text;
  v_writing_task text;
  v_writing_set text;
  v_writing_mode text;
  v_writing_time_limit integer;
  v_writing_draft uuid;
  v_writing_submitted uuid;
  v_writing_retake uuid;
  v_writing_baseline integer;
  -- Reading
  v_reading_item text;
  v_reading_task text;
  v_reading_draft uuid;
  v_reading_submitted uuid;
  v_reading_retake uuid;
  v_reading_baseline integer;
  v_result jsonb;
  -- Writing assignment isolation
  v_assignment_id uuid;
  v_assignment_question text;
  -- Full Set
  v_full_set text := '20990101';
  v_full_set_active uuid;
  v_full_set_completed uuid;
  v_full_set_baseline integer;
  -- Revisions
  v_revision_before bigint;
  v_revision_after bigint;
  v_search_before bigint;
  v_search_after bigint;
  v_revision_trigger_count integer;
  v_occurrence_source uuid;
  v_occurrence_task text;
  v_trigger_name text;
  v_reading_occurrence_item text;
  v_reading_occurrence_module text;
  v_full_set_revision_before bigint;
  v_full_set_revision_after bigint;
begin
  -------------------------------------------------------------------------
  -- T0: fixtures
  -------------------------------------------------------------------------
  select profile.id into v_student
  from public.profiles profile
  where profile.role::text = 'student'
  order by profile.id
  limit 1;

  if v_student is null then
    raise exception 'T0 failed: no student profile available';
  end if;

  select source.item_id, btrim(source.source_set_id)
  into v_item, v_set
  from public.practice_item_sources source
  join public.practice_items item on item.item_id = source.item_id
  where source.task_type = 'build_sentence'
    and source.is_canonical
    and item.is_active
    and nullif(btrim(coalesce(item.display_number, '')), '') is not null
    and lower(btrim(source.source_set_id)) !~ '^(grammar|wrongbook)-'
  order by source.item_id
  limit 1;

  if v_item is null then
    raise exception 'T0 failed: no public BAS item available';
  end if;

  select state.attempt_count, state.latest_attempt_id
  into v_baseline_count, v_baseline_latest
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'build_sentence'
    and state.item_id = v_item::text;

  -------------------------------------------------------------------------
  -- T1: BAS attempt INSERT creates / advances the sparse row
  -------------------------------------------------------------------------
  insert into public.attempts (
    student_id, set_id, set_title, correct_count, total_questions,
    time_spent_seconds, submitted_at
  ) values (
    v_student, v_set, 'state verification', 10, 10, 60,
    '2099-01-02T00:00:00Z'::timestamptz
  )
  returning attempt_id into v_attempt_new;

  select state.status, state.attempt_count, state.latest_attempt_id,
         state.latest_completed_attempt_id
  into v_status, v_count, v_latest, v_completed
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'build_sentence'
    and state.item_id = v_item::text;

  if v_status is null then
    raise exception 'T1 failed: state row was not created';
  end if;
  if v_status <> 'completed' then
    raise exception 'T1 failed: expected completed, got %', v_status;
  end if;
  if v_count <> coalesce(v_baseline_count, 0) + 1 then
    raise exception 'T1 failed: expected attempt_count %, got %', coalesce(v_baseline_count, 0) + 1, v_count;
  end if;
  if v_latest is distinct from v_attempt_new or v_completed is distinct from v_attempt_new then
    raise exception 'T1 failed: expected latest %, got %', v_attempt_new, v_latest;
  end if;

  -------------------------------------------------------------------------
  -- T2: older BAS attempt keeps the newer latest attempt
  -------------------------------------------------------------------------
  insert into public.attempts (
    student_id, set_id, set_title, correct_count, total_questions,
    time_spent_seconds, submitted_at
  ) values (
    v_student, v_set, 'state verification older', 1, 10, 10,
    '2001-01-01T00:00:00Z'::timestamptz
  )
  returning attempt_id into v_attempt_old;

  select state.attempt_count, state.latest_attempt_id
  into v_count, v_latest
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'build_sentence'
    and state.item_id = v_item::text;

  if v_count <> coalesce(v_baseline_count, 0) + 2 then
    raise exception 'T2 failed: expected attempt_count %, got %', coalesce(v_baseline_count, 0) + 2, v_count;
  end if;
  if v_latest is distinct from v_attempt_new then
    raise exception 'T2 failed: older attempt replaced latest';
  end if;

  -------------------------------------------------------------------------
  -- T3: deleting the latest BAS attempt falls back to the previous one
  -------------------------------------------------------------------------
  delete from public.attempts where attempt_id = v_attempt_new;

  select state.attempt_count, state.latest_attempt_id
  into v_count, v_latest
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'build_sentence'
    and state.item_id = v_item::text;

  if v_count <> coalesce(v_baseline_count, 0) + 1 then
    raise exception 'T3 failed: expected attempt_count %, got %', coalesce(v_baseline_count, 0) + 1, v_count;
  end if;
  if v_latest is distinct from v_attempt_old then
    raise exception 'T3 failed: expected latest %, got %', v_attempt_old, v_latest;
  end if;

  -------------------------------------------------------------------------
  -- T4: deleting the last test attempt restores the baseline exactly
  -------------------------------------------------------------------------
  delete from public.attempts where attempt_id = v_attempt_old;

  if v_baseline_count is null then
    if exists (
      select 1 from public.student_practice_item_state state
      where state.student_id = v_student
        and state.task_type = 'build_sentence'
        and state.item_id = v_item::text
    ) then
      raise exception 'T4 failed: expected the state row to be deleted';
    end if;
  else
    select state.attempt_count, state.latest_attempt_id
    into v_count, v_latest
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = 'build_sentence'
      and state.item_id = v_item::text;

    if v_count is distinct from v_baseline_count or v_latest is distinct from v_baseline_latest then
      raise exception 'T4 failed: baseline was not restored (count %, latest %)', v_count, v_latest;
    end if;
  end if;

  -------------------------------------------------------------------------
  -- T5: virtual grammar / wrongbook sets never create catalog state
  -------------------------------------------------------------------------
  select count(*) into v_rows_before
  from public.student_practice_item_state state
  where state.student_id = v_student;

  insert into public.attempts (
    student_id, set_id, set_title, correct_count, total_questions,
    time_spent_seconds, submitted_at
  ) values (
    v_student, 'grammar-state-verification', 'state verification virtual', 1, 10, 5,
    '2099-02-01T00:00:00Z'::timestamptz
  );

  select count(*) into v_rows_after
  from public.student_practice_item_state state
  where state.student_id = v_student;

  if v_rows_after <> v_rows_before then
    raise exception 'T5 failed: virtual set changed state rows (% -> %)', v_rows_before, v_rows_after;
  end if;

  delete from public.attempts where set_id = 'grammar-state-verification';

  -------------------------------------------------------------------------
  -- T6..T10: Writing free practice lifecycle
  -------------------------------------------------------------------------
  select source.item_id, source.source_question_id, source.task_type
  into v_writing_item, v_writing_question, v_writing_task
  from public.practice_item_sources source
  join public.practice_items item on item.item_id = source.item_id
  where source.task_type in ('email', 'academic_discussion')
    and source.is_canonical
    and item.is_active
    and nullif(btrim(coalesce(item.display_number, '')), '') is not null
  order by source.item_id
  limit 1;

  if v_writing_item is null then
    raise notice 'T6-T10 skipped: no public writing item available';
  else
    select attempt.set_id, attempt.writing_mode, attempt.time_limit_seconds
    into v_writing_set, v_writing_mode, v_writing_time_limit
    from public.writing_attempts attempt
    where attempt.task_type = v_writing_task
    limit 1;

    v_writing_set := coalesce(v_writing_set, 'state-verification-set');
    v_writing_mode := coalesce(v_writing_mode, 'practice');
    v_writing_time_limit := coalesce(v_writing_time_limit, 1800);

    select count(*) into v_writing_baseline
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    insert into public.writing_attempts (
      assignment_id, user_id, task_type, question_id, set_id, response_text,
      word_count, status, time_limit_seconds, remaining_seconds, started_at,
      writing_mode, elapsed_seconds, overtime_ranges
    ) values (
      null, v_student, v_writing_task, v_writing_question, v_writing_set, '',
      0, 'draft', v_writing_time_limit, v_writing_time_limit,
      '2099-01-01T00:00:00Z'::timestamptz, v_writing_mode, 0, '[]'::jsonb
    )
    returning attempt_id into v_writing_draft;

    select state.status, state.resume_attempt_id, state.resume_source_question_id
    into v_status, v_latest, v_resume_question
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    if v_status is distinct from 'in_progress' or v_latest is distinct from v_writing_draft then
      raise exception 'T6 failed: draft did not produce in_progress state (%, %)', v_status, v_latest;
    end if;

    update public.writing_attempts
    set status = 'submitted',
        submitted_at = '2099-01-03T00:00:00Z'::timestamptz,
        updated_at = '2099-01-03T00:00:00Z'::timestamptz
    where attempt_id = v_writing_draft;

    select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
    into v_status, v_latest, v_writing_submitted
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    if v_status is distinct from 'completed'
       or v_latest is not null
       or v_writing_submitted is distinct from v_writing_draft then
      raise exception 'T7 failed: submit did not complete the item (%, %, %)', v_status, v_latest, v_writing_submitted;
    end if;

    insert into public.writing_attempts (
      assignment_id, user_id, task_type, question_id, set_id, response_text,
      word_count, status, time_limit_seconds, remaining_seconds, started_at,
      writing_mode, elapsed_seconds, overtime_ranges
    ) values (
      null, v_student, v_writing_task, v_writing_question, v_writing_set, '',
      0, 'draft', v_writing_time_limit, v_writing_time_limit,
      '2099-01-04T00:00:00Z'::timestamptz, v_writing_mode, 0, '[]'::jsonb
    )
    returning attempt_id into v_writing_retake;

    select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
    into v_status, v_latest, v_completed
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    if v_status is distinct from 'in_progress'
       or v_latest is distinct from v_writing_retake
       or v_completed is distinct from v_writing_draft then
      raise exception 'T8 failed: retake draft lost the previous completion (%, %, %)', v_status, v_latest, v_completed;
    end if;

    delete from public.writing_attempts where attempt_id = v_writing_retake;

    select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
    into v_status, v_latest, v_completed
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    if v_status is distinct from 'completed'
       or v_latest is not null
       or v_completed is distinct from v_writing_draft then
      raise exception 'T8b failed: deleting the retake draft did not restore completed (%, %, %)', v_status, v_latest, v_completed;
    end if;

    -- Assignment attempts must never touch free-practice state.
    select assignment.assignment_id, assignment.question_snapshot ->> 'question_id'
    into v_assignment_id, v_assignment_question
    from public.writing_assignments assignment
    join public.writing_assignment_students assignment_student
      on assignment_student.assignment_id = assignment.assignment_id
     and assignment_student.student_id = v_student
    where assignment.status = 'active'
      and assignment.deleted_at is null
      and assignment.task_type = v_writing_task
      and nullif(btrim(coalesce(assignment.question_snapshot ->> 'question_id', '')), '') is not null
    order by assignment.assignment_id
    limit 1;

    if v_assignment_id is null then
      raise notice 'T9 skipped: no active writing assignment for this student';
    else
      insert into public.writing_attempts (
        assignment_id, user_id, task_type, question_id, set_id, response_text,
        word_count, status, time_limit_seconds, remaining_seconds, started_at,
        writing_mode, elapsed_seconds, overtime_ranges
      ) values (
        v_assignment_id, v_student, v_writing_task, v_assignment_question, v_writing_set, '',
        0, 'draft', v_writing_time_limit, v_writing_time_limit,
        '2099-01-05T00:00:00Z'::timestamptz, v_writing_mode, 0, '[]'::jsonb
      );

      select state.status, state.resume_attempt_id
      into v_status, v_latest
      from public.student_practice_item_state state
      where state.student_id = v_student
        and state.task_type = v_writing_task
        and state.item_id = v_writing_item::text;

      if v_status is distinct from 'completed' or v_latest is not null then
        raise exception 'T9 failed: assignment draft polluted free-practice state (%, %)', v_status, v_latest;
      end if;

      delete from public.writing_attempts
      where user_id = v_student
        and assignment_id = v_assignment_id;
    end if;

    delete from public.writing_attempts where attempt_id = v_writing_draft;

    select count(*) into v_count
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_writing_task
      and state.item_id = v_writing_item::text;

    if v_writing_baseline = 0 and v_count <> 0 then
      raise exception 'T10 failed: deleting the last writing attempt left a state row';
    end if;
  end if;

  -------------------------------------------------------------------------
  -- T11..T15: Reading CTW / RDL / RAP lifecycle
  -------------------------------------------------------------------------
  select item.logical_item_id, item.module
  into v_reading_item, v_reading_task
  from public.reading_logical_items item
  order by item.logical_item_id
  limit 1;

  if v_reading_item is null then
    raise notice 'T11-T15 skipped: no reading logical item available';
  else
    select count(*) into v_reading_baseline
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    insert into public.reading_attempts (
      student_id, logical_item_id, task_type, status
    ) values (
      v_student, v_reading_item, v_reading_task, 'draft'
    )
    returning attempt_id into v_reading_draft;

    select state.status, state.resume_attempt_id
    into v_status, v_latest
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    if v_status is distinct from 'in_progress' or v_latest is distinct from v_reading_draft then
      raise exception 'T11 failed: reading draft did not produce in_progress state (%, %)', v_status, v_latest;
    end if;

    update public.reading_attempts
    set status = 'submitted',
        submitted_at = '2099-01-06T00:00:00Z'::timestamptz,
        correct_points = 1,
        total_points = 2,
        elapsed_seconds = 30,
        updated_at = '2099-01-06T00:00:00Z'::timestamptz
    where attempt_id = v_reading_draft;

    select state.status, state.latest_completed_attempt_id, state.latest_result
    into v_status, v_reading_submitted, v_result
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    if v_status is distinct from 'completed'
       or v_reading_submitted is distinct from v_reading_draft then
      raise exception 'T12 failed: reading submit did not complete the item (%, %)', v_status, v_reading_submitted;
    end if;
    if (v_result ->> 'correctPoints')::integer is distinct from 1
       or (v_result ->> 'totalPoints')::integer is distinct from 2 then
      raise exception 'T12 failed: reading score summary is wrong (%)', v_result;
    end if;

    insert into public.reading_attempts (
      student_id, logical_item_id, task_type, status
    ) values (
      v_student, v_reading_item, v_reading_task, 'draft'
    )
    returning attempt_id into v_reading_retake;

    select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
    into v_status, v_latest, v_completed
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    if v_status is distinct from 'in_progress'
       or v_latest is distinct from v_reading_retake
       or v_completed is distinct from v_reading_draft then
      raise exception 'T13 failed: reading retake lost the previous completion (%, %, %)', v_status, v_latest, v_completed;
    end if;

    delete from public.reading_attempts where attempt_id = v_reading_retake;

    select state.status, state.resume_attempt_id
    into v_status, v_latest
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    if v_status is distinct from 'completed' or v_latest is not null then
      raise exception 'T13b failed: deleting the reading retake did not restore completed (%, %)', v_status, v_latest;
    end if;

    delete from public.reading_attempts where attempt_id = v_reading_draft;

    select count(*) into v_count
    from public.student_practice_item_state state
    where state.student_id = v_student
      and state.task_type = v_reading_task
      and state.item_id = v_reading_item;

    if v_reading_baseline = 0 and v_count <> 0 then
      raise exception 'T14 failed: deleting the last reading attempt left a state row';
    end if;
  end if;

  -------------------------------------------------------------------------
  -- T16..T18: Full Set lifecycle
  -------------------------------------------------------------------------
  select count(*) into v_full_set_baseline
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'full_set'
    and state.item_id = v_full_set;

  insert into public.reading_full_set_attempts (
    student_id, full_set_id, status
  ) values (
    v_student, v_full_set, 'in_progress'
  )
  returning attempt_id into v_full_set_active;

  select state.status, state.resume_attempt_id
  into v_status, v_latest
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'full_set'
    and state.item_id = v_full_set;

  if v_status is distinct from 'in_progress' or v_latest is distinct from v_full_set_active then
    raise exception 'T16 failed: full set start did not produce in_progress state (%, %)', v_status, v_latest;
  end if;

  update public.reading_full_set_attempts
  set status = 'completed',
      current_module = 2,
      completed_at = '2099-01-07T00:00:00Z'::timestamptz
  where attempt_id = v_full_set_active;

  select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
  into v_status, v_latest, v_full_set_completed
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'full_set'
    and state.item_id = v_full_set;

  if v_status is distinct from 'completed'
     or v_latest is not null
     or v_full_set_completed is distinct from v_full_set_active then
    raise exception 'T17 failed: full set completion is wrong (%, %, %)', v_status, v_latest, v_full_set_completed;
  end if;

  insert into public.reading_full_set_attempts (
    student_id, full_set_id, status
  ) values (
    v_student, v_full_set, 'in_progress'
  )
  returning attempt_id into v_full_set_active;

  select state.status, state.resume_attempt_id, state.latest_completed_attempt_id
  into v_status, v_latest, v_completed
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'full_set'
    and state.item_id = v_full_set;

  if v_status is distinct from 'in_progress'
     or v_latest is distinct from v_full_set_active
     or v_completed is distinct from v_full_set_completed then
    raise exception 'T18 failed: full set retake lost the previous completion (%, %, %)', v_status, v_latest, v_completed;
  end if;

  delete from public.reading_full_set_attempts
  where student_id = v_student and full_set_id = v_full_set;

  select count(*) into v_count
  from public.student_practice_item_state state
  where state.student_id = v_student
    and state.task_type = 'full_set'
    and state.item_id = v_full_set;

  if v_full_set_baseline = 0 and v_count <> 0 then
    raise exception 'T18b failed: deleting the last full set attempt left a state row';
  end if;

  -------------------------------------------------------------------------
  -- T19: direct SQL occurrence write bumps the lightweight catalog revision
  --      (the mechanism that makes SQL Editor writes visible to the app cache)
  -------------------------------------------------------------------------
  -- This verification runs against a live database. Serialize the revision
  -- reads/bumps against concurrent production writes (imports) for the rest of
  -- this rolled-back transaction, otherwise a concurrent bump can land between
  -- "before" and "after" and make the delta look like +2.
  lock table public.catalog_revisions in exclusive mode;

  -- Precondition: every catalog revision function must be wired exactly once
  -- (writing questions shared by two tables => 9 triggers total). A stale
  -- duplicate trigger would double-bump silently.
  select count(*) into v_revision_trigger_count
  from pg_trigger trigger
  join pg_proc procedure on procedure.oid = trigger.tgfoid
  join pg_namespace procedure_namespace on procedure_namespace.oid = procedure.pronamespace
  where not trigger.tgisinternal
    and procedure_namespace.nspname = 'public'
    and procedure.proname in (
      'sync_catalog_revision_practice_items',
      'sync_catalog_revision_practice_item_sources',
      'sync_catalog_revision_practice_item_occurrences',
      'sync_catalog_revision_questions',
      'sync_catalog_revision_practice_item_question_map',
      'sync_catalog_revision_writing_questions',
      'sync_catalog_revision_reading_logical_items',
      'sync_catalog_revision_reading_source_occurrences'
    );

  if v_revision_trigger_count <> 9 then
    raise exception 'T19 precondition failed: expected exactly 9 catalog revision triggers, found %',
      v_revision_trigger_count;
  end if;

  select source.source_id, source.task_type
  into v_occurrence_source, v_occurrence_task
  from public.practice_item_sources source
  where source.task_type in ('build_sentence', 'email', 'academic_discussion')
  order by source.source_id
  limit 1;

  if v_occurrence_source is null then
    raise notice 'T19 skipped: no practice item source available';
  else
    -------------------------------------------------------------------------
    -- T19a: production chain with every user trigger enabled. A new occurrence
    -- also refreshes practice_items.first_seen_date through the production
    -- first-seen trigger; that refresh may bump the lightweight revision, but
    -- must never bump the search index (the searchable item set is unchanged).
    -------------------------------------------------------------------------
    select revision.revision into v_revision_before
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_before
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'search_index';

    insert into public.practice_item_occurrences (
      source_id, occurred_on, source_label
    ) values (
      v_occurrence_source, '2099-01-01'::date, 'state-verification'
    );

    select revision.revision into v_revision_after
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_after
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'search_index';

    if coalesce(v_revision_after, 0) <= coalesce(v_revision_before, 0) then
      raise exception 'T19a failed: occurrence insert did not bump % lightweight revision (% -> %)',
        v_occurrence_task, v_revision_before, v_revision_after;
    end if;
    if coalesce(v_search_after, 0) <> coalesce(v_search_before, 0) then
      raise exception 'T19a failed: first-seen refresh must not bump the search index revision (% -> %)',
        v_search_before, v_search_after;
    end if;

    delete from public.practice_item_occurrences
    where source_id = v_occurrence_source
      and occurred_on = '2099-01-01'::date
      and source_label = 'state-verification';

    -------------------------------------------------------------------------
    -- T19b: isolate our revision trigger (disable every other user trigger on
    -- the occurrence table for the rest of this rolled-back transaction) and
    -- require an exact +1 bump.
    -------------------------------------------------------------------------
    for v_trigger_name in
      select trigger.tgname
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'practice_item_occurrences'
        and not trigger.tgisinternal
        and trigger.tgname <> 'trg_practice_item_occurrences_catalog_revision'
    loop
      execute format(
        'alter table public.practice_item_occurrences disable trigger %I',
        v_trigger_name
      );
    end loop;

    select revision.revision into v_revision_before
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_before
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'search_index';

    insert into public.practice_item_occurrences (
      source_id, occurred_on, source_label
    ) values (
      v_occurrence_source, '2099-01-01'::date, 'state-verification'
    );

    select revision.revision into v_revision_after
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_after
    from public.catalog_revisions revision
    where revision.task_type = v_occurrence_task
      and revision.cache_kind = 'search_index';

    if coalesce(v_revision_after, 0) <> coalesce(v_revision_before, 0) + 1 then
      raise exception 'T19b failed: isolated occurrence insert must bump exactly once (% -> %)',
        v_revision_before, v_revision_after;
    end if;
    if coalesce(v_search_after, 0) <> coalesce(v_search_before, 0) then
      raise exception 'T19b failed: isolated occurrence insert must not bump the search index revision (% -> %)',
        v_search_before, v_search_after;
    end if;

    delete from public.practice_item_occurrences
    where source_id = v_occurrence_source
      and occurred_on = '2099-01-01'::date
      and source_label = 'state-verification';
  end if;

  -------------------------------------------------------------------------
  -- T20: direct SQL reading occurrence write bumps module + full set revisions
  -------------------------------------------------------------------------
  select item.logical_item_id, item.module
  into v_reading_occurrence_item, v_reading_occurrence_module
  from public.reading_logical_items item
  order by item.logical_item_id
  limit 1;

  if v_reading_occurrence_item is null then
    raise notice 'T20 skipped: no reading logical item available';
  else
    -------------------------------------------------------------------------
    -- T20a: production chain with every user trigger enabled. Module and
    -- full_set lightweight revisions must move; the module search index must
    -- stay (reading occurrence writes do not change searchable content).
    -------------------------------------------------------------------------
    select revision.revision into v_revision_before
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_full_set_revision_before
    from public.catalog_revisions revision
    where revision.task_type = 'full_set'
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_before
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'search_index';

    insert into public.reading_source_occurrences (
      occurrence_id, logical_item_id, source_kind, source_label,
      occurrence_date, year_month, source_question_file, source_answer_file,
      source_module, source_order, source_question_start, source_question_end
    ) values (
      'state-verification-occurrence', v_reading_occurrence_item,
      'state_verification', '1.1',
      '2099-01-01'::date, '2099-01', 'state-verification', 'state-verification',
      'm1', 9999, 1, 1
    );

    select revision.revision into v_revision_after
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_full_set_revision_after
    from public.catalog_revisions revision
    where revision.task_type = 'full_set'
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_search_after
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'search_index';

    if coalesce(v_revision_after, 0) <= coalesce(v_revision_before, 0) then
      raise exception 'T20a failed: reading occurrence insert did not bump the % revision (% -> %)',
        v_reading_occurrence_module, v_revision_before, v_revision_after;
    end if;
    if coalesce(v_full_set_revision_after, 0) <= coalesce(v_full_set_revision_before, 0) then
      raise exception 'T20a failed: reading occurrence insert did not bump the full_set revision (% -> %)',
        v_full_set_revision_before, v_full_set_revision_after;
    end if;
    if coalesce(v_search_after, 0) <> coalesce(v_search_before, 0) then
      raise exception 'T20a failed: reading occurrence insert must not bump the search index revision (% -> %)',
        v_search_before, v_search_after;
    end if;

    delete from public.reading_source_occurrences
    where occurrence_id = 'state-verification-occurrence';

    -------------------------------------------------------------------------
    -- T20b: isolate our revision trigger and require an exact +1 for both the
    -- module and the full_set lightweight revisions.
    -------------------------------------------------------------------------
    for v_trigger_name in
      select trigger.tgname
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'reading_source_occurrences'
        and not trigger.tgisinternal
        and trigger.tgname <> 'trg_reading_source_occurrences_catalog_revision'
    loop
      execute format(
        'alter table public.reading_source_occurrences disable trigger %I',
        v_trigger_name
      );
    end loop;

    select revision.revision into v_revision_before
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_full_set_revision_before
    from public.catalog_revisions revision
    where revision.task_type = 'full_set'
      and revision.cache_kind = 'lightweight_catalog';

    insert into public.reading_source_occurrences (
      occurrence_id, logical_item_id, source_kind, source_label,
      occurrence_date, year_month, source_question_file, source_answer_file,
      source_module, source_order, source_question_start, source_question_end
    ) values (
      'state-verification-occurrence', v_reading_occurrence_item,
      'state_verification', '1.1',
      '2099-01-01'::date, '2099-01', 'state-verification', 'state-verification',
      'm1', 9999, 1, 1
    );

    select revision.revision into v_revision_after
    from public.catalog_revisions revision
    where revision.task_type = v_reading_occurrence_module
      and revision.cache_kind = 'lightweight_catalog';

    select revision.revision into v_full_set_revision_after
    from public.catalog_revisions revision
    where revision.task_type = 'full_set'
      and revision.cache_kind = 'lightweight_catalog';

    if coalesce(v_revision_after, 0) <> coalesce(v_revision_before, 0) + 1 then
      raise exception 'T20b failed: isolated reading occurrence insert must bump the % revision exactly once (% -> %)',
        v_reading_occurrence_module, v_revision_before, v_revision_after;
    end if;
    if coalesce(v_full_set_revision_after, 0) <> coalesce(v_full_set_revision_before, 0) + 1 then
      raise exception 'T20b failed: isolated reading occurrence insert must bump the full_set revision exactly once (% -> %)',
        v_full_set_revision_before, v_full_set_revision_after;
    end if;

    delete from public.reading_source_occurrences
    where occurrence_id = 'state-verification-occurrence';
  end if;
end;
$$;

select 'ALL_CHECKS_PASSED' as result;

rollback;
