-- Manual incremental install AFTER Phase 3 + start_owner_fix. No production execution by agent.
-- One session table; existing vocabulary, memberships, progress and immutable attempts stay intact.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';
create table public.student_ctw_vocabulary_review_sessions (
  student_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  source jsonb not null,
  parent_session_id uuid,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  total smallint not null check(total between 1 and 50),
  answered smallint not null default 0 check(answered between 0 and total),
  correct smallint not null default 0 check(correct between 0 and answered),
  phase text not null check(phase in ('study','test','result')),
  state jsonb not null check(jsonb_typeof(state)='object'),
  revision integer not null default 0 check(revision>=0),
  receipts jsonb not null default '{}' check(jsonb_typeof(receipts)='object'),
  primary key(student_id,session_id)
);
create index student_ctw_review_history_idx on public.student_ctw_vocabulary_review_sessions(student_id,started_at desc,session_id desc);
alter table public.student_ctw_vocabulary_review_sessions enable row level security;
create policy ctw_review_self_read on public.student_ctw_vocabulary_review_sessions for select to authenticated using (
  student_id=(select auth.uid()) and (select exists(select 1 from public.profiles p where p.id=(select auth.uid())
    and p.is_active and p.role::text in ('student','teacher','admin')))
);
revoke all on public.student_ctw_vocabulary_review_sessions from public,anon,authenticated,service_role;
grant select on public.student_ctw_vocabulary_review_sessions to authenticated,service_role;

create function public.create_ctw_vocabulary_review_v1(p_student uuid,p_session uuid,p_source jsonb,p_state jsonb,p_parent uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.student_ctw_vocabulary_review_sessions; v_ids uuid[]; v_allowed uuid[];
  v_edition text; v_group text; v_list integer; v_parent_source jsonb;
begin
  if not exists(select 1 from public.profiles p where p.id=p_student and p.is_active and p.role::text in ('student','teacher','admin'))
    then raise exception 'CTW_VOCAB_AUTH'; end if;
  select * into v_existing from public.student_ctw_vocabulary_review_sessions s where s.student_id=p_student and s.session_id=p_session;
  if found then
    if v_existing.source<>p_source or v_existing.parent_session_id is distinct from p_parent then raise exception 'CTW_REVIEW_CONFLICT'; end if;
    return to_jsonb(v_existing);
  end if;
  if exists(select 1 from public.student_ctw_vocabulary_attempts a where a.student_id=p_student and a.attempt_id=p_session)
    then raise exception 'CTW_REVIEW_CONFLICT'; end if;
  v_edition:=case when p_source->>'kind'='list' then 'mixed' when p_source->>'kind'='cefr_list' then 'cefr' end;
  v_group:=case when v_edition='mixed' then '' else p_source->>'group' end;
  v_list:=(p_source->>'listNumber')::integer;
  if v_edition is null or v_list is null then raise exception 'CTW_REVIEW_INVALID'; end if;
  select array_agg((c->>'itemId')::uuid order by (c->>'itemId')::uuid) into v_ids from jsonb_array_elements(p_state#>'{round,cards}') c;
  if v_ids is null or cardinality(v_ids) not between 1 and 50
    or cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x)
    or p_state->>'owner'<>p_student::text or p_state#>>'{round,session,session_id}'<>p_session::text
    or p_state#>'{round,metadata,source}'<>p_source then raise exception 'CTW_REVIEW_INVALID'; end if;
  if p_parent is null then
    v_allowed:=ctw_vocab_private.list_entry_ids(v_edition,v_group,v_list);
  else
    select s.source,array(select key::uuid from jsonb_each(s.state->'answers') a where (a.value->>'correct')::boolean=false order by key::uuid)
      into v_parent_source,v_allowed from public.student_ctw_vocabulary_review_sessions s
      where s.student_id=p_student and s.session_id=p_parent and s.phase='result';
    if not found then
      select a.answers->0->'source',array(select distinct (x->>'entryId')::uuid from jsonb_array_elements(a.answers) x
        where (x->>'correct')::boolean=false order by (x->>'entryId')::uuid)
        into v_parent_source,v_allowed from public.student_ctw_vocabulary_attempts a where a.student_id=p_student and a.attempt_id=p_parent;
    end if;
    if v_parent_source is not null and v_parent_source<>p_source then raise exception 'CTW_REVIEW_INVALID_PARENT'; end if;
  end if;
  if v_ids is distinct from v_allowed then raise exception 'CTW_REVIEW_INVALID_MEMBERS'; end if;
  insert into public.student_ctw_vocabulary_review_sessions(student_id,session_id,source,parent_session_id,total,answered,correct,phase,state)
    values(p_student,p_session,p_source,p_parent,cardinality(v_ids),0,0,'study',p_state) on conflict do nothing;
  if p_parent is null then
    insert into public.student_ctw_vocabulary_list_progress(student_id,edition,cefr_group,list_number)
      values(p_student,v_edition,v_group,v_list) on conflict do nothing;
  end if;
  select * into v_existing from public.student_ctw_vocabulary_review_sessions s where s.student_id=p_student and s.session_id=p_session;
  if v_existing.source<>p_source or v_existing.parent_session_id is distinct from p_parent then raise exception 'CTW_REVIEW_CONFLICT'; end if;
  return to_jsonb(v_existing);
end $$;
revoke all on function public.create_ctw_vocabulary_review_v1(uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_ctw_vocabulary_review_v1(uuid,uuid,jsonb,jsonb,uuid) to service_role;

-- The API replays exactly the shared JavaScript state machine and grading.
-- This transaction persists one command + ACK receipt. No SQL spelling grader.
create function public.sync_ctw_vocabulary_review_v1(p_student uuid,p_session uuid,p_revision integer,p_command jsonb,p_state jsonb,p_attempt jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.student_ctw_vocabulary_review_sessions; v_id text; v_answered integer; v_correct integer;
begin
  if not exists(select 1 from public.profiles p where p.id=p_student and p.is_active and p.role::text in ('student','teacher','admin'))
    then raise exception 'CTW_VOCAB_AUTH'; end if;
  select * into v_row from public.student_ctw_vocabulary_review_sessions s
    where s.student_id=p_student and s.session_id=p_session for update;
  if not found then raise exception 'CTW_REVIEW_NOT_FOUND'; end if;
  v_id:=p_command->>'id';
  if v_id is null then raise exception 'CTW_REVIEW_INVALID'; end if;
  if v_row.receipts ? v_id then
    if v_row.receipts->v_id<>p_command then raise exception 'CTW_REVIEW_CONFLICT'; end if;
    return jsonb_build_object('acknowledged',v_id);
  end if;
  if v_row.revision<>p_revision then raise exception 'CTW_REVIEW_REVISION'; end if;
  if v_row.phase='result' or p_state->>'owner'<>p_student::text
    or p_state->'round'<>v_row.state->'round' then raise exception 'CTW_REVIEW_CONFLICT'; end if;
  select count(*),count(*) filter(where (a.value->>'correct')::boolean) into v_answered,v_correct from jsonb_each(p_state->'answers') a;
  if p_state->>'phase'='result' then
    if v_answered<>v_row.total or p_attempt is null then raise exception 'CTW_REVIEW_INVALID'; end if;
    insert into public.student_ctw_vocabulary_attempts(student_id,attempt_id,mode,answer_count,correct_count,list_numbers,cefr_levels,request_answers,answers)
      values(p_student,p_session,'base_form',v_answered,v_correct,
        array(select jsonb_array_elements_text(p_attempt->'list_numbers')::integer),
        array(select jsonb_array_elements_text(p_attempt->'cefr_levels')),
        p_attempt->'request_answers',p_attempt->'answers');
  elsif p_attempt is not null then raise exception 'CTW_REVIEW_INVALID'; end if;
  update public.student_ctw_vocabulary_review_sessions s set state=p_state,revision=s.revision+1,
    receipts=s.receipts||jsonb_build_object(v_id,p_command),phase=p_state->>'phase',answered=v_answered,correct=v_correct,
    completed_at=case when p_state->>'phase'='result' then now() else null end
    where s.student_id=p_student and s.session_id=p_session;
  return jsonb_build_object('acknowledged',v_id);
end $$;
revoke all on function public.sync_ctw_vocabulary_review_v1(uuid,uuid,integer,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sync_ctw_vocabulary_review_v1(uuid,uuid,integer,jsonb,jsonb,jsonb) to service_role;

-- Include pre-upgrade immutable attempts without rewriting them or downloading
-- all their answers. New sessions hide their matching final attempt summary.
create function public.read_ctw_vocabulary_review_history_v1(p_page integer default 1,p_size integer default 10)
returns jsonb language sql stable security invoker set search_path='' as $$
  with history as (
    select s.session_id,s.source,s.started_at,s.parent_session_id,s.total,s.answered,s.correct,
      case when s.phase='result' then 'completed' else 'active' end status
      from public.student_ctw_vocabulary_review_sessions s where s.student_id=(select auth.uid())
    union all
    select a.attempt_id,a.answers->0->'source',a.submitted_at,null::uuid,a.answer_count,a.answer_count,a.correct_count,'completed'
      from public.student_ctw_vocabulary_attempts a where a.student_id=(select auth.uid())
        and not exists(select 1 from public.student_ctw_vocabulary_review_sessions s where s.student_id=a.student_id and s.session_id=a.attempt_id)
  ), page as (select * from history order by started_at desc,session_id desc limit least(greatest(p_size,1),50) offset (greatest(p_page,1)-1)*least(greatest(p_size,1),50))
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(page) order by started_at desc,session_id desc) from page),'[]'::jsonb),
    'total',(select count(*) from history),'page',p_page,'pageSize',p_size)
$$;
revoke all on function public.read_ctw_vocabulary_review_history_v1(integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_ctw_vocabulary_review_history_v1(integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
