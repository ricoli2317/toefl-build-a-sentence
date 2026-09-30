-- Student wrong-question bank: one-shot history / daily-pending backfill.
--
-- Run AFTER supabase/student_wrong_questions.sql. Manual execution only.
--
-- What it does (read-only against every existing practice table; writes only to
-- public.student_wrong_questions):
--
--   1) HISTORY: every wrong answer from FORMAL practice becomes one permanent,
--      date-independent identity. Formal sources are ordinary BAS attempts
--      (official set ids only), ordinary Reading attempts (ctw/rdl/rap) and
--      completed Reading Full Set attempts. Entry corrections, today
--      corrections and history practice never create or extend an identity.
--        BAS              -> 'sentence:<normalized final sentence>' when the
--                            question has one, else 'question:<id>' — the exact
--                            key the live submit hook writes, so different
--                            question_ids of one logical BAS question merge.
--        CTW / RDL / RAP  -> logical_item_id:question_id:(slot_id | 'question')
--      (Full Set uses the same canonical Reading identity; the occurrence is
--       intentionally not part of it.)
--
--   2) DAILY PENDING: replays every state-setting event in order and restores
--      the rows whose CURRENT pending business date equals `p_practice_date`:
--        formal wrong        -> pending for the date of that wrong
--        today correction ok -> cleared
--        everything else     -> no state change
--      The default `p_practice_date` is the current Asia/Shanghai date (the
--      project's one calendar rule), so the plain `select` at the bottom only
--      initializes the migration day. Wrongs from earlier days are restored to
--      history only and can never leak into today's pending. Pass an explicit
--      date to initialize a different day instead.
--
-- Re-running is safe:
--   * inserts conflict on the primary key and only widen first/last wrong times;
--   * the pending step only touches rows that were created by this backfill and
--     never modified afterwards (updated_at = created_at), so live corrections
--     and a second execution can never be clobbered.

create or replace function public.backfill_student_wrong_questions(
  p_practice_date date default (now() at time zone 'Asia/Shanghai')::date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_practice_date is null then
    raise exception using errcode = '22023', message = 'WRONG_QUESTION_BACKFILL_DATE_REQUIRED';
  end if;

  -- ---------------------------------------------------------------------
  -- 1) HISTORY (formal practice wrongs only, date-independent)
  -- ---------------------------------------------------------------------

  -- BAS: ordinary official sets only. wrongbook-* (today / history / entry
  -- corrections and history practice) and grammar-* are excluded. The key is
  -- the shared content rule used by the live submit hook.
  insert into public.student_wrong_questions as target (
    student_id, task_type, question_key, logical_item_id, question_id, slot_id,
    pending_date, first_wrong_at, last_wrong_at, corrected_at, updated_at
  )
  select
    bas_wrongs.student_id,
    'bas',
    bas_wrongs.question_key,
    null,
    (array_agg(bas_wrongs.question_id order by bas_wrongs.event_time desc))[1],
    null,
    null,
    min(bas_wrongs.event_time),
    max(bas_wrongs.event_time),
    null,
    now()
  from (
    select
      aa.student_id,
      case
        when btrim(coalesce(q.final_sentence, '')) <> ''
          then 'sentence:' || btrim(regexp_replace(coalesce(q.final_sentence, ''), '\s+', ' ', 'g'))
        else 'question:' || btrim(aa.question_id)
      end as question_key,
      btrim(aa.question_id) as question_id,
      coalesce(aa.answered_at, aa.created_at, a.submitted_at, a.created_at) as event_time
    from public.attempt_answers aa
    join public.attempts a on a.attempt_id = aa.attempt_id
    join public.questions q on q.question_id = aa.question_id
    where aa.is_correct = false
      and btrim(coalesce(aa.question_id, '')) <> ''
      and lower(btrim(coalesce(a.set_id, ''))) !~ '^(wrongbook|grammar)-'
      and exists (
        select 1 from public.questions official
        where btrim(official.set_id) = btrim(a.set_id)
      )
  ) bas_wrongs
  group by bas_wrongs.student_id, bas_wrongs.question_key
  on conflict (student_id, task_type, question_key) do update
    set first_wrong_at = least(target.first_wrong_at, excluded.first_wrong_at),
        last_wrong_at = greatest(target.last_wrong_at, excluded.last_wrong_at),
        updated_at = now();

  -- Reading: ordinary submitted attempts only. Correction answers live in
  -- reading_wrongbook_attempt_answers and are never read here.
  insert into public.student_wrong_questions as target (
    student_id, task_type, question_key, logical_item_id, question_id, slot_id,
    pending_date, first_wrong_at, last_wrong_at, corrected_at, updated_at
  )
  select
    ra.student_id,
    ra.task_type,
    ra.logical_item_id || ':' || aa.question_id || ':' || coalesce(aa.slot_id, 'question'),
    ra.logical_item_id,
    aa.question_id,
    aa.slot_id,
    null,
    min(coalesce(ra.submitted_at, aa.created_at)),
    max(coalesce(ra.submitted_at, aa.created_at)),
    null,
    now()
  from public.reading_attempt_answers aa
  join public.reading_attempts ra
    on ra.attempt_id = aa.attempt_id
   and ra.status = 'submitted'
  where aa.is_correct = false
    and btrim(coalesce(aa.question_id, '')) <> ''
  group by ra.student_id, ra.task_type, ra.logical_item_id, aa.question_id, aa.slot_id
  on conflict (student_id, task_type, question_key) do update
    set first_wrong_at = least(target.first_wrong_at, excluded.first_wrong_at),
        last_wrong_at = greatest(target.last_wrong_at, excluded.last_wrong_at),
        updated_at = now();

  -- Reading Full Set: completed attempts only; occurrence intentionally dropped
  -- so the same logical question merges with its ordinary Reading identity.
  insert into public.student_wrong_questions as target (
    student_id, task_type, question_key, logical_item_id, question_id, slot_id,
    pending_date, first_wrong_at, last_wrong_at, corrected_at, updated_at
  )
  select
    fa.student_id,
    li.module,
    fsa.logical_item_id || ':' || fsa.question_id || ':' || coalesce(fsa.slot_id, 'question'),
    fsa.logical_item_id,
    fsa.question_id,
    fsa.slot_id,
    null,
    min(fa.completed_at),
    max(fa.completed_at),
    null,
    now()
  from public.reading_full_set_answers fsa
  join public.reading_full_set_module_attempts ma
    on ma.module_attempt_id = fsa.module_attempt_id
  join public.reading_full_set_attempts fa
    on fa.attempt_id = ma.attempt_id
   and fa.status = 'completed'
  join public.reading_logical_items li
    on li.logical_item_id = fsa.logical_item_id
  where fsa.is_correct = false
    and btrim(coalesce(fsa.question_id, '')) <> ''
  group by fa.student_id, li.module, fsa.logical_item_id, fsa.question_id, fsa.slot_id
  on conflict (student_id, task_type, question_key) do update
    set first_wrong_at = least(target.first_wrong_at, excluded.first_wrong_at),
        last_wrong_at = greatest(target.last_wrong_at, excluded.last_wrong_at),
        updated_at = now();

  -- ---------------------------------------------------------------------
  -- 2) DAILY PENDING for p_practice_date (replayed state machine)
  -- ---------------------------------------------------------------------
  with events as (
    -- BAS formal wrongs (official sets only); key matches the live hook.
    select
      bas_wrongs.student_id,
      'bas'::text as task_type,
      bas_wrongs.question_key,
      bas_wrongs.event_time,
      true as pending_event
    from (
      select
        aa.student_id,
        case
          when btrim(coalesce(q.final_sentence, '')) <> ''
            then 'sentence:' || btrim(regexp_replace(coalesce(q.final_sentence, ''), '\s+', ' ', 'g'))
          else 'question:' || btrim(aa.question_id)
        end as question_key,
        coalesce(aa.answered_at, aa.created_at, a.submitted_at, a.created_at) as event_time
      from public.attempt_answers aa
      join public.attempts a on a.attempt_id = aa.attempt_id
      join public.questions q on q.question_id = aa.question_id
      where aa.is_correct = false
        and btrim(coalesce(aa.question_id, '')) <> ''
        and lower(btrim(coalesce(a.set_id, ''))) !~ '^(wrongbook|grammar)-'
        and exists (
          select 1 from public.questions official
          where btrim(official.set_id) = btrim(a.set_id)
        )
    ) bas_wrongs

    union all
    -- BAS today-correction corrects (clearing). Correction wrongs and history
    -- practice answers are intentionally not state events.
    select
      bas_corrections.student_id,
      'bas',
      bas_corrections.question_key,
      bas_corrections.event_time,
      false
    from (
      select
        aa.student_id,
        case
          when btrim(coalesce(q.final_sentence, '')) <> ''
            then 'sentence:' || btrim(regexp_replace(coalesce(q.final_sentence, ''), '\s+', ' ', 'g'))
          else 'question:' || btrim(aa.question_id)
        end as question_key,
        coalesce(aa.answered_at, aa.created_at, a.submitted_at, a.created_at) as event_time
      from public.attempt_answers aa
      join public.attempts a on a.attempt_id = aa.attempt_id
      join public.questions q on q.question_id = aa.question_id
      where aa.is_correct = true
        and btrim(coalesce(aa.question_id, '')) <> ''
        and lower(btrim(coalesce(a.set_id, ''))) like 'wrongbook-today-%'
    ) bas_corrections

    union all
    -- Reading formal wrongs
    select
      ra.student_id,
      ra.task_type,
      ra.logical_item_id || ':' || aa.question_id || ':' || coalesce(aa.slot_id, 'question'),
      coalesce(ra.submitted_at, aa.created_at),
      true
    from public.reading_attempt_answers aa
    join public.reading_attempts ra
      on ra.attempt_id = aa.attempt_id
     and ra.status = 'submitted'
    where aa.is_correct = false
      and btrim(coalesce(aa.question_id, '')) <> ''

    union all
    -- Reading today-scope correction corrects (clearing). History-scope
    -- corrections never change pending.
    select
      wa.student_id,
      wa.task_type,
      wa.logical_item_id || ':' || waa.question_id || ':' || coalesce(waa.slot_id, 'question'),
      coalesce(wa.submitted_at, waa.created_at),
      false
    from public.reading_wrongbook_attempt_answers waa
    join public.reading_wrongbook_attempts wa on wa.attempt_id = waa.attempt_id
    where waa.is_correct = true
      and wa.status = 'submitted'
      and wa.task_type <> 'full_set'
      and wa.scope = 'today'
      and wa.logical_item_id is not null
      and btrim(coalesce(waa.question_id, '')) <> ''

    union all
    -- Full Set formal wrongs
    select
      fa.student_id,
      li.module,
      fsa.logical_item_id || ':' || fsa.question_id || ':' || coalesce(fsa.slot_id, 'question'),
      fa.completed_at,
      true
    from public.reading_full_set_answers fsa
    join public.reading_full_set_module_attempts ma
      on ma.module_attempt_id = fsa.module_attempt_id
    join public.reading_full_set_attempts fa
      on fa.attempt_id = ma.attempt_id
     and fa.status = 'completed'
    join public.reading_logical_items li
      on li.logical_item_id = fsa.logical_item_id
    where fsa.is_correct = false
      and btrim(coalesce(fsa.question_id, '')) <> ''

    union all
    -- Full Set correction corrects (clearing, both scopes).
    select
      wa.student_id,
      li.module,
      waa.logical_item_id || ':' || waa.question_id || ':' || coalesce(waa.slot_id, 'question'),
      coalesce(wa.submitted_at, waa.created_at),
      false
    from public.reading_wrongbook_attempt_answers waa
    join public.reading_wrongbook_attempts wa on wa.attempt_id = waa.attempt_id
    join public.reading_logical_items li on li.logical_item_id = waa.logical_item_id
    where waa.is_correct = true
      and wa.status = 'submitted'
      and wa.task_type = 'full_set'
      and waa.logical_item_id is not null
      and btrim(coalesce(waa.question_id, '')) <> ''
  ),
  latest as (
    -- Latest state-setting event wins; on an exact tie the clearing event wins.
    select distinct on (student_id, task_type, question_key)
      student_id,
      task_type,
      question_key,
      pending_event,
      (event_time at time zone 'Asia/Shanghai')::date as event_date
    from events
    order by student_id, task_type, question_key, event_time desc, pending_event asc
  ),
  pending as (
    -- Only the target day: an older uncorrected wrong stays history-only and
    -- never leaks into today's pending.
    select student_id, task_type, question_key, event_date as pending_date
    from latest
    where pending_event
      and event_date = p_practice_date
  )
  update public.student_wrong_questions target
     set pending_date = pending.pending_date, corrected_at = null, updated_at = now()
    from pending
   where target.student_id = pending.student_id
     and target.task_type = pending.task_type
     and target.question_key = pending.question_key
     and target.pending_date is distinct from pending.pending_date
     -- Only rows this backfill created and never touched: live state and
     -- re-runs can never be clobbered.
     and target.updated_at = target.created_at;
end;
$$;

revoke all on function public.backfill_student_wrong_questions(date) from public, anon, authenticated;
grant execute on function public.backfill_student_wrong_questions(date) to service_role;

-- ---------------------------------------------------------------------------
-- Run the backfill.
--
-- Default: initialize ONLY the current Asia/Shanghai business day (the project's
-- one calendar rule). Older uncorrected wrongs go to history and do not appear
-- in today's pending.
--
-- To initialize a different day explicitly:
--
--   select public.backfill_student_wrong_questions('2026-09-30'::date);
-- ---------------------------------------------------------------------------
select public.backfill_student_wrong_questions();

-- ---------------------------------------------------------------------------
-- Verification (read-only, safe to run any time):
--
--   select task_type,
--          count(*) filter (where pending_date is not null) as pending_count,
--          count(*) as history_count
--     from public.student_wrong_questions
--    group by task_type
--    order by task_type;
--
-- Expected: history_count > 0 for every task type that has formal practice
-- history; pending_count only covers the initialized business day.
-- ---------------------------------------------------------------------------
