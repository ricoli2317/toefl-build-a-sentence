-- TPS RAP question-category normal practice. Apply MANUALLY; never run historical reset SQL.
-- Requires the existing Reading data layer, student experience capability and practice summary.
-- Two tables only. No ordinary/correction child attempts and no passage-level item-state writes.
begin;

create table public.reading_question_category_sessions (
  session_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  question_category text not null check (question_category in (
    '事实信息题','否定信息题','主旨题','词汇题','选句题',
    '句子简化题','指代题','推断题','修辞目的题','句子插入题'
  )),
  amount integer not null check (amount in (5,10,15,20)),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  -- Resume the unfinished workspace without inventing a child attempt.
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object'),
  status text not null default 'active' check (status in ('active','completed')),
  elapsed_seconds integer not null default 0 check (elapsed_seconds between 0 and 12096000),
  total_points integer not null default 0 check (total_points between 0 and 20),
  correct_points integer not null default 0 check (correct_points between 0 and total_points),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint reading_category_completion_shape check (
    (status = 'active' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
  )
);
create table public.reading_question_category_session_answers (
  answer_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reading_question_category_sessions(session_id) on delete cascade,
  logical_item_id text not null,
  question_id text not null,
  answer_kind text not null check (answer_kind in ('option','insertion_anchor','sentence_selection')),
  student_answer text,
  is_correct boolean not null,
  question_time_seconds integer not null check (question_time_seconds between 0 and 604800),
  created_at timestamptz not null default now(),
  unique (session_id, question_id),
  foreign key (question_id, logical_item_id)
    references public.reading_questions(question_id, logical_item_id) on delete restrict
);
create index reading_category_sessions_student_completed_idx
  on public.reading_question_category_sessions(student_id, completed_at desc) where status = 'completed';
-- One small covering index for BOTH count and identity-only category sampling.
create index reading_questions_rap_category_pool_idx
  on public.reading_questions(question_category, logical_item_id, question_order, question_id)
  where module = 'rap';

alter table public.reading_question_category_sessions enable row level security;
alter table public.reading_question_category_session_answers enable row level security;
revoke all on public.reading_question_category_sessions,
  public.reading_question_category_session_answers from public, anon, authenticated;
grant select on public.reading_question_category_sessions,
  public.reading_question_category_session_answers to authenticated;
grant all on public.reading_question_category_sessions,
  public.reading_question_category_session_answers to service_role;
create policy students_select_own_category_sessions
  on public.reading_question_category_sessions for select to authenticated
  using (student_id = auth.uid() and public.can_use_student_experience());
create policy students_select_own_category_answers
  on public.reading_question_category_session_answers for select to authenticated
  using (exists (
    select 1 from public.reading_question_category_sessions session
    where session.session_id = reading_question_category_session_answers.session_id
      and session.student_id = auth.uid() and public.can_use_student_experience()
  ));

-- Creation is performed by the authenticated Next.js server with service_role
-- after shared JS random sampling/grouping. No browser can insert a chosen manifest.
-- Validate the server-produced manifest as well, and freeze identity forever.
create function public.guard_reading_category_manifest()
returns trigger language plpgsql set search_path = public as $$
declare v_count integer; v_pool integer;
begin
  if tg_op = 'UPDATE' then
    if new.manifest is distinct from old.manifest or new.student_id <> old.student_id
      or new.question_category <> old.question_category or new.amount <> old.amount then
      raise exception 'READING_INVALID_CATEGORY_MANIFEST_MUTATION';
    end if;
    if old.status = 'completed' and (
      new.status <> old.status or new.completed_at is distinct from old.completed_at
      or new.progress is distinct from old.progress or new.elapsed_seconds <> old.elapsed_seconds
      or new.total_points <> old.total_points or new.correct_points <> old.correct_points
    ) then raise exception 'READING_INVALID_COMPLETED_CATEGORY_MUTATION'; end if;
    return new;
  end if;
  if not exists (select 1 from public.profiles where id = new.student_id and is_active
    and role::text in ('student','teacher','admin')) then
    raise exception 'READING_STUDENT_REQUIRED';
  end if;
  if new.manifest->>'kind' is distinct from 'question_category'
    or new.manifest->>'category' is distinct from new.question_category
    or jsonb_typeof(new.manifest->'groups') is distinct from 'array'
    or jsonb_array_length(new.manifest->'groups') = 0 then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  if exists (select 1 from jsonb_array_elements(new.manifest->'groups') g
    where jsonb_typeof(g->'targets') is distinct from 'array'
      or jsonb_array_length(g->'targets') = 0)
    or exists (select 1 from jsonb_array_elements(new.manifest->'groups') g
      group by g->>'logicalItemId' having count(*) > 1) then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  select count(*) into v_count from jsonb_array_elements(new.manifest->'groups') g,
    lateral jsonb_array_elements(g->'targets') t;
  select count(*) into v_pool from public.reading_questions
    where module = 'rap' and question_category = new.question_category;
  if v_count <> least(new.amount, v_pool) or v_count = 0 or exists (
    select 1 from jsonb_array_elements(new.manifest->'groups') g
    cross join lateral jsonb_array_elements(g->'targets') t
    left join public.reading_questions q on q.question_id = t->>'questionId'
      and q.logical_item_id = g->>'logicalItemId'
    left join public.reading_logical_items item on item.logical_item_id = q.logical_item_id
    where q.question_id is null or q.module <> 'rap' or item.module <> 'rap'
      or q.question_category is distinct from new.question_category
  ) or exists (
    select 1 from jsonb_array_elements(new.manifest->'groups') g,
      lateral jsonb_array_elements(g->'targets') t
    group by t->>'questionId' having count(*) > 1
  ) then raise exception 'READING_INVALID_CATEGORY_MANIFEST'; end if;
  return new;
end; $$;
revoke all on function public.guard_reading_category_manifest() from public, anon, authenticated;
create trigger reading_category_manifest_guard before insert or update
  on public.reading_question_category_sessions for each row execute function public.guard_reading_category_manifest();
create trigger reading_category_updated_at before update on public.reading_question_category_sessions
  for each row execute function public.set_updated_at();

create function public.reading_category_session_json(p_session public.reading_question_category_sessions)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'sessionId',p_session.session_id,'questionCategory',p_session.question_category,
    'amount',p_session.amount,'groups',p_session.manifest->'groups','progress',p_session.progress,
    'draft',p_session.draft,'status',p_session.status,'elapsedSeconds',p_session.elapsed_seconds,
    'totalPoints',p_session.total_points,'correctPoints',p_session.correct_points,
    'createdAt',p_session.created_at,'completedAt',p_session.completed_at
  );
$$;
create function public.reading_category_answers_json(p_session_id uuid, p_item_id text default null)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'answerId',answer_id,'logicalItemId',logical_item_id,'questionId',question_id,
    'answerKind',answer_kind,'studentAnswer',student_answer,'isCorrect',is_correct,
    'questionTimeSeconds',question_time_seconds
  ) order by question_id),'[]'::jsonb)
  from public.reading_question_category_session_answers
  where session_id = p_session_id and (p_item_id is null or logical_item_id = p_item_id);
$$;
revoke all on function public.reading_category_session_json(public.reading_question_category_sessions),
  public.reading_category_answers_json(uuid,text) from public, anon, authenticated;

create function public.get_reading_question_category_session(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_session public.reading_question_category_sessions%rowtype;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid();
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  return jsonb_build_object('session',public.reading_category_session_json(v_session),
    'answers',public.reading_category_answers_json(p_session_id));
end; $$;
create function public.reading_question_category_counts()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_counts jsonb;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  with categories(category,position) as (values
    ('事实信息题',1),('否定信息题',2),('主旨题',3),('词汇题',4),('选句题',5),
    ('句子简化题',6),('指代题',7),('推断题',8),('修辞目的题',9),('句子插入题',10)
  ), counts as (
    select question_category, count(*) as count from public.reading_questions
    where module = 'rap' group by question_category
  ) select jsonb_agg(jsonb_build_object('questionCategory',category,'count',coalesce(count,0))
    order by position) into v_counts from categories left join counts on question_category = category;
  return v_counts;
end; $$;

create function public.save_reading_question_category_draft(p_session_id uuid, p_logical_item_id text, p_draft jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_session public.reading_question_category_sessions%rowtype; v_group jsonb; v_current text;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid() for update;
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  -- A late autosave cannot overwrite a submitted group or resurrect a finished session.
  if v_session.status = 'completed' or v_session.progress ? p_logical_item_id then return; end if;
  select g into v_group from jsonb_array_elements(v_session.manifest->'groups') g
    where g->>'logicalItemId' = p_logical_item_id;
  select g->>'logicalItemId' into v_current from jsonb_array_elements(v_session.manifest->'groups') with ordinality e(g,n)
    where not v_session.progress ? (g->>'logicalItemId') order by n limit 1;
  if v_group is null or v_current <> p_logical_item_id
    or jsonb_typeof(p_draft) is distinct from 'object'
    or jsonb_typeof(p_draft->'answers') is distinct from 'object'
    or jsonb_typeof(p_draft->'questionTimes') is distinct from 'object'
    or not coalesce(p_draft->>'currentIndex','') ~ '^[0-9]{1,2}$'
    or not coalesce(p_draft->>'elapsedSeconds','') ~ '^[0-9]{1,6}$' then
    raise exception 'READING_INVALID_CATEGORY_DRAFT';
  end if;
  if (p_draft->>'currentIndex')::integer >= jsonb_array_length(v_group->'targets')
    or (p_draft->>'elapsedSeconds')::integer > 604800
    or exists (select 1 from jsonb_object_keys(p_draft->'answers') key
      where not exists (select 1 from jsonb_array_elements(v_group->'targets') t where t->>'questionId' = key))
    or exists (select 1 from jsonb_each_text(p_draft->'questionTimes') e
      where not e.value ~ '^[0-9]{1,6}$' or e.value::integer > 604800
        or not exists (select 1 from jsonb_array_elements(v_group->'targets') t where t->>'questionId' = e.key)) then
    raise exception 'READING_INVALID_CATEGORY_DRAFT';
  end if;
  update public.reading_question_category_sessions set draft = jsonb_build_object(
    'logicalItemId',p_logical_item_id,'workspace',p_draft
  ) where session_id = p_session_id;
end; $$;

create function public.submit_reading_question_category_group(
  p_session_id uuid, p_logical_item_id text, p_elapsed_seconds integer, p_answers jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.reading_question_category_sessions%rowtype;
  v_group jsonb; v_progress jsonb; v_correct integer; v_total integer;
  v_current text; v_completed boolean; v_expected integer;
begin
  if auth.uid() is null or not public.can_use_student_experience() then raise exception 'READING_STUDENT_REQUIRED'; end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid() for update;
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  select g into v_group from jsonb_array_elements(v_session.manifest->'groups') g
    where g->>'logicalItemId' = p_logical_item_id;
  if v_group is null then raise exception 'READING_INVALID_CATEGORY_GROUP'; end if;
  if v_session.progress ? p_logical_item_id then
    return jsonb_build_object('alreadySubmitted',true,'group',v_session.progress->p_logical_item_id,
      'session',public.reading_category_session_json(v_session),
      'answers',public.reading_category_answers_json(p_session_id,p_logical_item_id));
  end if;
  select g->>'logicalItemId' into v_current from jsonb_array_elements(v_session.manifest->'groups') with ordinality e(g,n)
    where not v_session.progress ? (g->>'logicalItemId') order by n limit 1;
  if v_session.status <> 'active' or v_current <> p_logical_item_id then raise exception 'READING_INVALID_CATEGORY_GROUP'; end if;
  v_total := jsonb_array_length(v_group->'targets');
  if p_elapsed_seconds is null or p_elapsed_seconds not between 0 and 604800
    or jsonb_typeof(p_answers) is distinct from 'array' then raise exception 'READING_INVALID_SUBMISSION'; end if;
  if jsonb_array_length(p_answers) <> v_total or exists (
    select 1 from jsonb_array_elements(p_answers) a
    where jsonb_typeof(a) <> 'object'
      or coalesce(a->>'slotId','') <> ''
      or jsonb_typeof(a->'studentAnswer') is distinct from 'string'
        and jsonb_typeof(a->'studentAnswer') is distinct from 'null'
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
  insert into public.reading_question_category_session_answers(
    session_id,logical_item_id,question_id,answer_kind,student_answer,is_correct,question_time_seconds
  ) select p_session_id,p_logical_item_id,q.question_id,a->>'kind',nullif(a->>'studentAnswer',''),
    coalesce(nullif(a->>'studentAnswer','') = case q.question_type
      when 'rap_multiple_choice' then q.correct_option_id
      when 'rap_sentence_insertion' then q.correct_anchor_id else q.correct_sentence_id end,false),
    (a->>'questionTimeSeconds')::integer
  from jsonb_array_elements(v_group->'targets') t
  join public.reading_questions q on q.question_id = t->>'questionId' and q.logical_item_id = p_logical_item_id
  join lateral (select a from jsonb_array_elements(p_answers) a where a->>'questionId' = q.question_id) submitted on true;
  select count(*) filter (where is_correct) into v_correct from public.reading_question_category_session_answers
    where session_id = p_session_id and logical_item_id = p_logical_item_id;
  v_progress := v_session.progress || jsonb_build_object(p_logical_item_id,jsonb_build_object(
    'correctPoints',v_correct,'totalPoints',v_total,'elapsedSeconds',p_elapsed_seconds,'submittedAt',now()
  ));
  select not exists (select 1 from jsonb_array_elements(v_session.manifest->'groups') g
    where not v_progress ? (g->>'logicalItemId')) into v_completed;
  select count(*) into v_expected from jsonb_array_elements(v_session.manifest->'groups') g,
    lateral jsonb_array_elements(g->'targets') t;
  -- amount is the requested valid chooser tier. A small pool uses min(amount,pool)
  -- exactly like wrongbook; completion must equal the ACTUAL frozen target count.
  if v_completed and v_session.total_points + v_total <> v_expected then raise exception 'READING_SCORING_CONTRACT_MISMATCH'; end if;
  update public.reading_question_category_sessions set progress = v_progress,draft = '{}'::jsonb,
    elapsed_seconds = elapsed_seconds + p_elapsed_seconds,total_points = total_points + v_total,
    correct_points = correct_points + v_correct,status = case when v_completed then 'completed' else 'active' end,
    completed_at = case when v_completed then now() else null end
  where session_id = p_session_id returning * into v_session;
  return jsonb_build_object('alreadySubmitted',false,'group',v_progress->p_logical_item_id,
    'session',public.reading_category_session_json(v_session),
    'answers',public.reading_category_answers_json(p_session_id,p_logical_item_id));
end; $$;

revoke all on function public.get_reading_question_category_session(uuid),
  public.reading_question_category_counts(),public.save_reading_question_category_draft(uuid,text,jsonb),
  public.submit_reading_question_category_group(uuid,text,integer,jsonb) from public, anon;
grant execute on function public.get_reading_question_category_session(uuid),
  public.reading_question_category_counts(),public.save_reading_question_category_draft(uuid,text,jsonb),
  public.submit_reading_question_category_group(uuid,text,integer,jsonb) to authenticated;

create function public.sync_student_practice_summary_category()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.apply_student_practice_summary_increment(new.student_id,new.elapsed_seconds::bigint,new.completed_at);
  return null;
end; $$;
revoke all on function public.sync_student_practice_summary_category() from public, anon, authenticated;
create trigger reading_category_summary_completed after update on public.reading_question_category_sessions
  for each row when (old.status = 'active' and new.status = 'completed')
  execute function public.sync_student_practice_summary_category();

-- Preserve all five existing summary sources; add completed category sessions once.
create or replace function public.rebuild_student_practice_summary(p_student_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_total bigint; v_latest timestamptz;
begin
  if p_student_id is null then return; end if;
  select coalesce(sum(part.duration_seconds),0),max(part.completed_at) into v_total,v_latest from (
    select greatest(coalesce(elapsed_seconds,0),0)::bigint as duration_seconds,submitted_at as completed_at
      from public.reading_attempts where student_id = p_student_id and status = 'submitted' and submitted_at is not null
    union all select greatest(coalesce(elapsed_seconds,0),0)::bigint,submitted_at
      from public.reading_wrongbook_attempts where student_id = p_student_id and status = 'submitted' and submitted_at is not null
    union all select greatest(coalesce(time_spent_seconds,0),0)::bigint,submitted_at
      from public.attempts where student_id = p_student_id and submitted_at is not null
    union all select greatest(coalesce(elapsed_seconds,0),0)::bigint,submitted_at
      from public.writing_attempts where user_id = p_student_id and status = 'submitted' and submitted_at is not null
    union all select 0::bigint,completed_at from public.reading_full_set_attempts
      where student_id = p_student_id and status = 'completed' and completed_at is not null
    union all select elapsed_seconds::bigint,completed_at from public.reading_question_category_sessions
      where student_id = p_student_id and status = 'completed' and completed_at is not null
  ) part;
  if v_total = 0 and v_latest is null then
    delete from public.student_practice_summary where student_id = p_student_id; return;
  end if;
  insert into public.student_practice_summary(student_id,total_practice_seconds,latest_practice_at,updated_at)
    values(p_student_id,v_total,v_latest,clock_timestamp())
  on conflict(student_id) do update set total_practice_seconds = excluded.total_practice_seconds,
    latest_practice_at = excluded.latest_practice_at,updated_at = clock_timestamp();
end; $$;
revoke all on function public.rebuild_student_practice_summary(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_student_practice_summary(uuid) to service_role;
commit;
