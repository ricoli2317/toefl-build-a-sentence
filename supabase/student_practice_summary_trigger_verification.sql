-- TPS student_practice_summary trigger verification.
--
-- READ/WRITE ONLY INSIDE A ROLLED-BACK TRANSACTION.
-- Run this whole file once in the Supabase SQL Editor. The last statement is
-- ROLLBACK, so no test attempt row, no summary change, and no deleted attempt
-- survives the run.
--
-- Expected result: one row, ALL_CHECKS_PASSED.
-- On failure you get an exception like "T5 failed: ..."; the transaction is
-- then aborted, so run `rollback;` once and send me the exact message.
--
-- Inserts use the exact column lists of the production write paths (no
-- whole-row copy), so generated columns are never written directly.
--
-- Covers: attempts INSERT accumulate, attempts DELETE rebuild, Reading /
-- Reading wrongbook / Writing draft->submitted exactly once, re-submitted
-- UPDATE no-op, Full Set timestamp-only, rebuild correctness, NULL handling.

begin;

do $$
declare
  v_student uuid;
  v0_total bigint;
  v0_latest timestamptz;
  v_total bigint;
  v_latest timestamptz;
  v_attempt_old uuid;
  v_attempt_new uuid;
  v_reading_id uuid;
  v_wrongbook_id uuid;
  v_writing_id uuid;
  v_full_set_attempt_id uuid;
begin
  select s.student_id, s.total_practice_seconds, s.latest_practice_at
  into v_student, v0_total, v0_latest
  from public.student_practice_summary s
  order by s.student_id
  limit 1;

  if v_student is null then
    raise exception 'T0 failed: student_practice_summary has no row';
  end if;

  ---------------------------------------------------------------------------
  -- T1: attempts INSERT accumulates duration; older timestamp keeps latest
  ---------------------------------------------------------------------------
  insert into public.attempts (
    student_id, set_id, set_title, correct_count, total_questions,
    time_spent_seconds, submitted_at
  )
  select v_student, t.set_id, t.set_title, 0, 10, 100,
         '2001-01-01T00:00:00Z'::timestamptz
  from public.attempts t
  limit 1
  returning attempt_id into v_attempt_old;

  if v_attempt_old is null then
    raise exception 'T1 failed: no attempts template row';
  end if;

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total + 100 then
    raise exception 'T1 failed: expected total %, got %', v0_total + 100, v_total;
  end if;
  if v_latest is distinct from v0_latest then
    raise exception 'T1 failed: older completion changed latest (%)', v_latest;
  end if;

  ---------------------------------------------------------------------------
  -- T2: newer completion moves latest_practice_at
  ---------------------------------------------------------------------------
  insert into public.attempts (
    student_id, set_id, set_title, correct_count, total_questions,
    time_spent_seconds, submitted_at
  )
  select v_student, t.set_id, t.set_title, 0, 10, 7,
         '2099-01-01T00:00:00Z'::timestamptz
  from public.attempts t
  limit 1
  returning attempt_id into v_attempt_new;

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total + 107 then
    raise exception 'T2 failed: expected total %, got %', v0_total + 107, v_total;
  end if;
  if v_latest is distinct from '2099-01-01T00:00:00Z'::timestamptz then
    raise exception 'T2 failed: expected latest 2099-01-01, got %', v_latest;
  end if;

  ---------------------------------------------------------------------------
  -- T3: attempts DELETE runs the single-student rebuild
  ---------------------------------------------------------------------------
  delete from public.attempts where attempt_id = v_attempt_new;

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total + 100 then
    raise exception 'T3 failed: after delete rebuild expected total %, got %', v0_total + 100, v_total;
  end if;
  if v_latest is distinct from v0_latest then
    raise exception 'T3 failed: after delete rebuild latest should be %', v0_latest;
  end if;

  delete from public.attempts where attempt_id = v_attempt_old;

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total or v_latest is distinct from v0_latest then
    raise exception 'T3b failed: expected total % latest %, got % / %',
      v0_total, v0_latest, v_total, v_latest;
  end if;

  ---------------------------------------------------------------------------
  -- T4: Reading draft -> submitted accumulates exactly once
  ---------------------------------------------------------------------------
  insert into public.reading_attempts (
    student_id, logical_item_id, task_type, status, elapsed_seconds,
    total_points, correct_points
  )
  select v_student, t.logical_item_id, t.task_type, 'draft', 77, 0, 0
  from public.reading_attempts t
  where t.status = 'submitted'
    and not exists (
      select 1
      from public.reading_attempts d
      where d.student_id = v_student
        and d.status = 'draft'
        and d.logical_item_id = t.logical_item_id
        and d.task_type = t.task_type
    )
  limit 1
  returning attempt_id into v_reading_id;

  if v_reading_id is null then
    raise exception 'T4 failed: no reading_attempts template row';
  end if;

  update public.reading_attempts
  set status = 'submitted',
      submitted_at = '2001-01-01T00:00:00Z'::timestamptz
  where attempt_id = v_reading_id;

  select total_practice_seconds, latest_practice_at into v_total, v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 77 then
    raise exception 'T4 failed: reading draft->submitted did not add exactly 77 (got %)', v_total;
  end if;
  if v_latest is distinct from v0_latest then
    raise exception 'T4c failed: older reading completion changed latest (%)', v_latest;
  end if;

  update public.reading_attempts
  set status = 'submitted'
  where attempt_id = v_reading_id;

  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 77 then
    raise exception 'T4b failed: submitted -> submitted accumulated again (got %)', v_total;
  end if;

  ---------------------------------------------------------------------------
  -- T5: Reading wrongbook draft -> submitted accumulates exactly once
  ---------------------------------------------------------------------------
  insert into public.reading_wrongbook_attempts (
    student_id, logical_item_id, task_type, scope, targets, status,
    elapsed_seconds, total_points, correct_points
  )
  select v_student, t.logical_item_id, t.task_type, t.scope, t.targets,
         'draft', 55, 0, 0
  from public.reading_wrongbook_attempts t
  where t.status = 'submitted'
    and not exists (
      select 1
      from public.reading_wrongbook_attempts d
      where d.student_id = v_student
        and d.status = 'draft'
        and d.logical_item_id = t.logical_item_id
        and d.task_type = t.task_type
        and d.scope = t.scope
    )
  limit 1
  returning attempt_id into v_wrongbook_id;

  if v_wrongbook_id is null then
    raise exception 'T5 failed: no reading_wrongbook_attempts template row';
  end if;

  update public.reading_wrongbook_attempts
  set status = 'submitted',
      submitted_at = '2001-01-01T00:00:00Z'::timestamptz
  where attempt_id = v_wrongbook_id;

  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 132 then
    raise exception 'T5 failed: wrongbook draft->submitted did not add exactly 55 (got %)', v_total;
  end if;

  update public.reading_wrongbook_attempts
  set status = 'submitted'
  where attempt_id = v_wrongbook_id;

  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 132 then
    raise exception 'T5b failed: wrongbook submitted -> submitted accumulated again (got %)', v_total;
  end if;

  ---------------------------------------------------------------------------
  -- T6: Writing draft -> submitted accumulates exactly once
  ---------------------------------------------------------------------------
  insert into public.writing_attempts (
    assignment_id, user_id, task_type, question_id, set_id,
    response_text, word_count, status, time_limit_seconds, remaining_seconds,
    started_at, writing_mode, elapsed_seconds, overtime_ranges
  )
  select null, v_student, t.task_type, t.question_id, t.set_id,
         '', 0, 'draft', t.time_limit_seconds, t.time_limit_seconds,
         now(), null, 33, '[]'::jsonb
  from public.writing_attempts t
  where t.assignment_id is null
    and not exists (
      select 1
      from public.writing_attempts d
      where d.user_id = v_student
        and d.status = 'draft'
        and d.task_type = t.task_type
        and d.question_id = t.question_id
    )
  limit 1
  returning attempt_id into v_writing_id;

  if v_writing_id is null then
    raise exception 'T6 failed: no writing_attempts template row';
  end if;

  update public.writing_attempts
  set status = 'submitted',
      submitted_at = '2001-01-01T00:00:00Z'::timestamptz
  where attempt_id = v_writing_id;

  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 165 then
    raise exception 'T6 failed: writing draft->submitted did not add exactly 33 (got %)', v_total;
  end if;

  update public.writing_attempts
  set status = 'submitted'
  where attempt_id = v_writing_id;

  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> v0_total + 165 then
    raise exception 'T6b failed: writing submitted -> submitted accumulated again (got %)', v_total;
  end if;

  ---------------------------------------------------------------------------
  -- T7: Full Set completion updates latest only (duration stays 0)
  ---------------------------------------------------------------------------
  insert into public.reading_full_set_attempts (
    student_id, full_set_id, status, current_module, started_at
  )
  select v_student, t.full_set_id, 'in_progress', 1, now()
  from public.reading_full_set_attempts t
  where not exists (
    select 1
    from public.reading_full_set_attempts a
    where a.student_id = v_student
      and a.full_set_id = t.full_set_id
      and a.status = 'in_progress'
  )
  limit 1
  returning attempt_id into v_full_set_attempt_id;

  if v_full_set_attempt_id is null then
    raise exception 'T7 failed: no reading_full_set_attempts template row';
  end if;

  update public.reading_full_set_attempts
  set status = 'completed',
      current_module = 2,
      completed_at = '2098-01-01T00:00:00Z'::timestamptz
  where attempt_id = v_full_set_attempt_id;

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total + 165 then
    raise exception 'T7 failed: Full Set completion changed duration (% -> %)', v0_total + 165, v_total;
  end if;
  if v_latest is distinct from '2098-01-01T00:00:00Z'::timestamptz then
    raise exception 'T7 failed: expected latest 2098-01-01, got %', v_latest;
  end if;

  update public.reading_full_set_attempts
  set status = 'completed'
  where attempt_id = v_full_set_attempt_id;

  select latest_practice_at into v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_latest is distinct from '2098-01-01T00:00:00Z'::timestamptz then
    raise exception 'T7b failed: completed -> completed changed latest again (%)', v_latest;
  end if;

  ---------------------------------------------------------------------------
  -- T8: rebuild reproduces the five-table truth for one student
  ---------------------------------------------------------------------------
  perform public.rebuild_student_practice_summary(v_student);

  select total_practice_seconds, latest_practice_at
  into v_total, v_latest
  from public.student_practice_summary
  where student_id = v_student;

  if v_total <> v0_total + 165 then
    raise exception 'T8 failed: rebuild expected total %, got %', v0_total + 165, v_total;
  end if;
  if v_latest is distinct from '2098-01-01T00:00:00Z'::timestamptz then
    raise exception 'T8 failed: rebuild expected latest 2098-01-01, got %', v_latest;
  end if;

  ---------------------------------------------------------------------------
  -- T9: NULL latest handling and creation path
  ---------------------------------------------------------------------------
  delete from public.student_practice_summary where student_id = v_student;

  perform public.apply_student_practice_summary_increment(v_student, 5, '2031-01-01T00:00:00Z'::timestamptz);
  select total_practice_seconds, latest_practice_at into v_total, v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_total <> 5 or v_latest is distinct from '2031-01-01T00:00:00Z'::timestamptz then
    raise exception 'T9a failed: create path expected 5 / 2031-01-01, got % / %', v_total, v_latest;
  end if;

  perform public.apply_student_practice_summary_increment(v_student, 0, null);
  select total_practice_seconds, latest_practice_at into v_total, v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_total <> 5 or v_latest is distinct from '2031-01-01T00:00:00Z'::timestamptz then
    raise exception 'T9b failed: NULL completion must keep latest, got % / %', v_total, v_latest;
  end if;

  perform public.apply_student_practice_summary_increment(v_student, 7, '2030-01-01T00:00:00Z'::timestamptz);
  select total_practice_seconds, latest_practice_at into v_total, v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_total <> 12 or v_latest is distinct from '2031-01-01T00:00:00Z'::timestamptz then
    raise exception 'T9c failed: older timestamp must keep latest, got % / %', v_total, v_latest;
  end if;

  perform public.apply_student_practice_summary_increment(v_student, 0, '2032-01-01T00:00:00Z'::timestamptz);
  select total_practice_seconds, latest_practice_at into v_total, v_latest
  from public.student_practice_summary where student_id = v_student;
  if v_total <> 12 or v_latest is distinct from '2032-01-01T00:00:00Z'::timestamptz then
    raise exception 'T9d failed: newer timestamp must win, got % / %', v_total, v_latest;
  end if;

  perform public.apply_student_practice_summary_increment(v_student, -50, null);
  select total_practice_seconds into v_total
  from public.student_practice_summary where student_id = v_student;
  if v_total <> 12 then
    raise exception 'T9e failed: negative duration must clamp to 0, got %', v_total;
  end if;

  raise notice 'TPS student_practice_summary trigger verification: all checks passed';
end;
$$;

select 'ALL_CHECKS_PASSED' as result;

rollback;
