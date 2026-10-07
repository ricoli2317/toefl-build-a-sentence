-- Incremental fix AFTER reading_question_category_sessions_20261007.sql.
-- MANUAL execution only. No table/data/category/importer changes.
-- Active progress means SAVED, not frozen. Only explicit final Submit freezes.
-- Install together with the updated API. Removing the four-argument signature
-- makes old servers fail closed instead of emitting provisional wrong events.
begin;

create or replace function public.save_reading_question_category_draft(p_session_id uuid, p_logical_item_id text, p_draft jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_question_category_sessions%rowtype;
  v_group jsonb; v_current text; v_workspaces jsonb; v_revision bigint;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid() for update;
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  if v_session.status = 'completed' then return; end if;
  select g into v_group from jsonb_array_elements(v_session.manifest->'groups') g where g->>'logicalItemId' = p_logical_item_id;
  select g->>'logicalItemId' into v_current from jsonb_array_elements(v_session.manifest->'groups') with ordinality e(g,n)
    where not v_session.progress ? (g->>'logicalItemId') order by n limit 1;
  if v_group is null or (not v_session.progress ? p_logical_item_id and v_current is distinct from p_logical_item_id)
    or jsonb_typeof(p_draft) is distinct from 'object'
    or jsonb_typeof(p_draft->'answers') is distinct from 'object'
    or jsonb_typeof(p_draft->'questionTimes') is distinct from 'object'
    or not coalesce(p_draft->>'currentIndex','') ~ '^[0-9]{1,2}$'
    or not coalesce(p_draft->>'elapsedSeconds','') ~ '^[0-9]{1,6}$'
    or not coalesce(p_draft->>'revision','') ~ '^[0-9]{1,16}$' then raise exception 'READING_INVALID_CATEGORY_DRAFT'; end if;
  v_revision := (p_draft->>'revision')::bigint;
  if v_revision not between 1 and 9007199254740991
    or (p_draft->>'currentIndex')::integer >= jsonb_array_length(v_group->'targets')
    or (p_draft->>'elapsedSeconds')::integer > 604800
    or exists (select 1 from jsonb_object_keys(p_draft->'answers') key
      where not exists (select 1 from jsonb_array_elements(v_group->'targets') t where t->>'questionId' = key))
    or exists (select 1 from jsonb_each_text(p_draft->'questionTimes') e
      where not e.value ~ '^[0-9]{1,6}$' or e.value::integer > 604800
        or not exists (select 1 from jsonb_array_elements(v_group->'targets') t where t->>'questionId' = e.key)) then
    raise exception 'READING_INVALID_CATEGORY_DRAFT';
  end if;
  v_workspaces := coalesce(v_session.draft->'workspaces','{}'::jsonb);
  -- Preserve the old one-workspace shape for active sessions started before this fix.
  if v_session.draft->>'logicalItemId' is not null and v_session.draft->'workspace' is not null then
    v_workspaces := v_workspaces || jsonb_build_object(v_session.draft->>'logicalItemId',v_session.draft->'workspace');
  end if;
  if v_revision <= coalesce((v_session.progress->p_logical_item_id->>'revision')::bigint,0)
    or v_revision <= coalesce((v_workspaces->p_logical_item_id->>'revision')::bigint,0) then return; end if;
  v_workspaces := v_workspaces || jsonb_build_object(p_logical_item_id,p_draft);
  update public.reading_question_category_sessions set draft = jsonb_build_object(
    'logicalItemId',p_logical_item_id,'workspace',p_draft,'workspaces',v_workspaces
  ) where session_id = p_session_id;
end; $$;

drop function public.submit_reading_question_category_group(uuid,text,integer,jsonb);
create function public.submit_reading_question_category_group(
  p_session_id uuid, p_logical_item_id text, p_elapsed_seconds integer, p_answers jsonb,
  p_finalize boolean, p_revision bigint
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_question_category_sessions%rowtype;
  v_group jsonb; v_progress jsonb; v_workspaces jsonb; v_current text; v_events jsonb;
  v_correct integer; v_total integer; v_expected integer; v_elapsed integer; v_all_saved boolean;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid() for update;
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  select g into v_group from jsonb_array_elements(v_session.manifest->'groups') g where g->>'logicalItemId' = p_logical_item_id;
  if v_group is null then raise exception 'READING_INVALID_CATEGORY_GROUP'; end if;
  -- Frozen only at session completion. Retries return ALL final grading but never
  -- a new completion signal (API must not replay final wrong events).
  if v_session.status = 'completed' then
    return jsonb_build_object('alreadySubmitted',true,'completedNow',false,
      'group',v_session.progress->p_logical_item_id,'session',public.reading_category_session_json(v_session),
      'answers',public.reading_category_answers_json(p_session_id));
  end if;
  select g->>'logicalItemId' into v_current from jsonb_array_elements(v_session.manifest->'groups') with ordinality e(g,n)
    where not v_session.progress ? (g->>'logicalItemId') order by n limit 1;
  if not v_session.progress ? p_logical_item_id and v_current is distinct from p_logical_item_id then
    raise exception 'READING_INVALID_CATEGORY_GROUP';
  end if;
  if p_finalize is null or p_revision is null or p_revision not between 1 and 9007199254740991
    or p_elapsed_seconds is null or p_elapsed_seconds not between 0 and 604800
    or jsonb_typeof(p_answers) is distinct from 'array' then raise exception 'READING_INVALID_SUBMISSION'; end if;
  if p_finalize and v_session.manifest->'groups'->-1->>'logicalItemId' is distinct from p_logical_item_id then
    raise exception 'READING_INVALID_CATEGORY_FINALIZE';
  end if;
  v_workspaces := coalesce(v_session.draft->'workspaces','{}'::jsonb);
  if v_session.draft->>'logicalItemId' is not null and v_session.draft->'workspace' is not null then
    v_workspaces := v_workspaces || jsonb_build_object(v_session.draft->>'logicalItemId',v_session.draft->'workspace');
  end if;
  -- A retry/late packet cannot replace a newer saved answer or pending draft.
  if p_revision < coalesce((v_workspaces->p_logical_item_id->>'revision')::bigint,0)
    or p_revision <= coalesce((v_session.progress->p_logical_item_id->>'revision')::bigint,0) then
    if p_finalize or not v_session.progress ? p_logical_item_id then raise exception 'READING_INVALID_STALE_CATEGORY_SAVE'; end if;
    return jsonb_build_object('alreadySubmitted',false,'completedNow',false,'alreadySaved',true,
      'group',v_session.progress->p_logical_item_id,'session',public.reading_category_session_json(v_session),
      'answers',public.reading_category_answers_json(p_session_id,p_logical_item_id));
  end if;
  v_total := jsonb_array_length(v_group->'targets');
  if jsonb_array_length(p_answers) <> v_total or exists (
    select 1 from jsonb_array_elements(p_answers) a
    where jsonb_typeof(a) is distinct from 'object' or coalesce(a->>'slotId','') <> ''
      or (jsonb_typeof(a->'studentAnswer') is distinct from 'string' and jsonb_typeof(a->'studentAnswer') is distinct from 'null')
      or not coalesce(a->>'questionTimeSeconds','') ~ '^[0-9]{1,6}$'
  ) or exists (select 1 from jsonb_array_elements(p_answers) a group by a->>'questionId' having count(*) > 1) then
    raise exception 'READING_INVALID_SUBMISSION';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_group->'targets') t
    left join lateral (select a from jsonb_array_elements(p_answers) a where a->>'questionId' = t->>'questionId') submitted on true
    left join public.reading_questions q on q.question_id = t->>'questionId' and q.logical_item_id = p_logical_item_id
    where submitted.a is null or q.question_id is null or q.module <> 'rap'
      or q.question_category is distinct from v_session.question_category
      or q.question_type not in ('rap_multiple_choice','rap_sentence_insertion','rap_sentence_selection')
      or submitted.a->>'kind' is distinct from case q.question_type
        when 'rap_multiple_choice' then 'option' when 'rap_sentence_insertion' then 'insertion_anchor' else 'sentence_selection' end
      or (submitted.a->>'questionTimeSeconds')::integer > 604800
      or (nullif(submitted.a->>'studentAnswer','') is not null and (
        (q.question_type = 'rap_multiple_choice' and not exists (
          select 1 from public.reading_question_options o where o.question_id = q.question_id and o.option_id = submitted.a->>'studentAnswer'))
        or (q.question_type = 'rap_sentence_insertion' and not exists (
          select 1 from public.reading_rap_insertion_anchors a where a.question_id = q.question_id and a.anchor_id = submitted.a->>'studentAnswer'))
        or (q.question_type = 'rap_sentence_selection' and not exists (
          select 1 from public.reading_passage_sentences s where s.passage_id = q.passage_id
            and s.paragraph_id = q.target_paragraph_id and s.sentence_id = submitted.a->>'studentAnswer'))
      ))
  ) then raise exception 'READING_ANSWER_ID_NOT_IN_ITEM'; end if;
  insert into public.reading_question_category_session_answers as answer(
    session_id,logical_item_id,question_id,answer_kind,student_answer,is_correct,question_time_seconds
  ) select p_session_id,p_logical_item_id,q.question_id,a->>'kind',nullif(a->>'studentAnswer',''),
    coalesce(nullif(a->>'studentAnswer','') = case q.question_type
      when 'rap_multiple_choice' then q.correct_option_id when 'rap_sentence_insertion' then q.correct_anchor_id else q.correct_sentence_id end,false),
    (a->>'questionTimeSeconds')::integer
  from jsonb_array_elements(v_group->'targets') t
  join public.reading_questions q on q.question_id = t->>'questionId' and q.logical_item_id = p_logical_item_id
  join lateral (select a from jsonb_array_elements(p_answers) a where a->>'questionId' = q.question_id) submitted on true
  on conflict (session_id,question_id) do update set student_answer = excluded.student_answer,
    is_correct = excluded.is_correct,answer_kind = excluded.answer_kind,
    question_time_seconds = greatest(answer.question_time_seconds,excluded.question_time_seconds);

  -- Regrade against current authoritative keys, and derive every aggregate from
  -- the saved rows/snapshots rather than adding a source again on revisit.
  update public.reading_question_category_session_answers a set is_correct = coalesce(a.student_answer = case q.question_type
    when 'rap_multiple_choice' then q.correct_option_id when 'rap_sentence_insertion' then q.correct_anchor_id else q.correct_sentence_id end,false)
  from public.reading_questions q where a.session_id = p_session_id and a.question_id = q.question_id and a.logical_item_id = q.logical_item_id;
  select count(*) filter (where is_correct) into v_correct from public.reading_question_category_session_answers
    where session_id = p_session_id and logical_item_id = p_logical_item_id;
  v_elapsed := greatest(p_elapsed_seconds,coalesce((v_session.progress->p_logical_item_id->>'elapsedSeconds')::integer,0));
  v_progress := v_session.progress || jsonb_build_object(p_logical_item_id,jsonb_build_object(
    'correctPoints',v_correct,'totalPoints',v_total,'elapsedSeconds',v_elapsed,'submittedAt',now(),'revision',p_revision
  ));
  -- Keep per-source score metadata in agreement with final authoritative rows.
  select jsonb_object_agg(e.key,e.value || jsonb_build_object('correctPoints',(
    select count(*) filter (where a.is_correct) from public.reading_question_category_session_answers a
    where a.session_id = p_session_id and a.logical_item_id = e.key
  ))) into v_progress from jsonb_each(v_progress) e;
  select count(*),count(*) filter (where is_correct) into v_total,v_correct
    from public.reading_question_category_session_answers where session_id = p_session_id;
  select coalesce(sum((e.value->>'elapsedSeconds')::integer),0) into v_elapsed from jsonb_each(v_progress) e;
  select not exists (select 1 from jsonb_array_elements(v_session.manifest->'groups') g
    where not v_progress ? (g->>'logicalItemId')) into v_all_saved;
  select count(*) into v_expected from jsonb_array_elements(v_session.manifest->'groups') g
    cross join lateral jsonb_array_elements(g->'targets') t;
  v_workspaces := v_workspaces - p_logical_item_id;
  if p_finalize and (not v_all_saved or v_total <> v_expected or v_workspaces <> '{}'::jsonb) then
    raise exception 'READING_INVALID_CATEGORY_FINALIZE';
  end if;
  if p_finalize then
    -- Same canonical Reading key / ordinary `wrong` policy and Asia/Shanghai
    -- business date as readingWrongAnswerEvents + wrongQuestionBusinessDate.
    -- No corrected events: a final correct answer does not erase older history.
    -- Invoke the existing privileged policy from this owner-checked definer;
    -- never grant callers direct execute on the general bank writer.
    select coalesce(jsonb_agg(jsonb_build_object('event','wrong','taskType','rap',
      'questionKey',logical_item_id || ':' || question_id || ':question',
      'logicalItemId',logical_item_id,'questionId',question_id,'slotId',null)),'[]'::jsonb)
      into v_events from public.reading_question_category_session_answers
      where session_id = p_session_id and not is_correct;
    perform public.apply_student_wrong_question_events(v_session.student_id,
      (statement_timestamp() at time zone 'Asia/Shanghai')::date,v_events);
  end if;
  update public.reading_question_category_sessions set progress = v_progress,
    draft = case when p_finalize then '{}'::jsonb else jsonb_build_object('workspaces',v_workspaces) end,
    elapsed_seconds = v_elapsed,total_points = v_total,correct_points = v_correct,
    status = case when p_finalize then 'completed' else 'active' end,
    completed_at = case when p_finalize then now() else null end
  where session_id = p_session_id returning * into v_session;
  return jsonb_build_object('alreadySubmitted',false,'completedNow',p_finalize,
    'group',v_progress->p_logical_item_id,'session',public.reading_category_session_json(v_session),
    'answers',public.reading_category_answers_json(p_session_id,case when p_finalize then null else p_logical_item_id end));
end; $$;

revoke all on function public.submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint) from public,anon;
grant execute on function public.submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint) to authenticated;
-- Existing draft function privileges, owner SELECT RLS, manifest immutability,
-- answer uniqueness, completion trigger and summary rebuild stay unchanged.
notify pgrst, 'reload schema';
commit;
