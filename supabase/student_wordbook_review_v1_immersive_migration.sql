-- MANUAL ONLY: incremental installation on the accepted review V1 / POS7 database.
-- No seeds, candidate changes, regrading, or updates to existing snapshots.
begin;
set local lock_timeout = '5s';

-- Fail closed if the accepted submit validation has drifted. Only empty strings
-- become valid; the normalization, assessment, insert, locks and idempotency stay intact.
do $patch$
declare definition text; old text; replacement text; expected text;
begin
  select value #>> '{}' into expected from public.student_wordbook_review_installation,
    lateral jsonb_each(function_hashes) where version='v1'
      and key in ('wordbook_review_submit(uuid,uuid,uuid,jsonb)','public.wordbook_review_submit(uuid,uuid,uuid,jsonb)');
  if expected is null or not exists(select 1 from pg_proc
    where oid='public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=expected)
    or has_function_privilege('anon','public.wordbook_review_submit(uuid,uuid,uuid,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.wordbook_review_submit(uuid,uuid,uuid,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.wordbook_review_submit(uuid,uuid,uuid,jsonb)','EXECUTE') then
    raise exception 'REVIEW_SUBMIT_BASELINE_DRIFT'; end if;
  select pg_get_functiondef('public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure) into definition;
  old := $old$or length(p_answer->>'spelling') not between 1 and 300$old$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_EMPTY_VALIDATION_DRIFT'; end if;
  definition := replace(definition,old,$new$or length(p_answer->>'spelling') not between 0 and 300$new$);
  old := $old$or not exists(select 1 from jsonb_array_elements(i.snapshot->'posOptions') o where o->>'id'=p_answer->>'pos')$old$;
  replacement := $new$or (p_answer->>'pos'<>'' and not exists(select 1 from jsonb_array_elements(i.snapshot->'posOptions') o where o->>'id'=p_answer->>'pos'))$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_EMPTY_VALIDATION_DRIFT'; end if;
  definition := replace(definition,old,replacement);
  old := $old$or not exists(select 1 from jsonb_array_elements(i.snapshot->'options') o where o->>'id'=p_answer->>'optionId')$old$;
  replacement := $new$or (p_answer->>'optionId'<>'' and not exists(select 1 from jsonb_array_elements(i.snapshot->'options') o where o->>'id'=p_answer->>'optionId'))$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_EMPTY_VALIDATION_DRIFT'; end if;
  execute replace(definition,old,replacement);
end;
$patch$;

create table public.student_wordbook_review_flow (
  session_id uuid primary key,
  student_id uuid not null,
  domain text not null,
  phase text not null check (phase in ('study','test','result')),
  position integer not null check (position > 0),
  -- Freeze only saved examples with exact sense AND tested-source provenance.
  -- Old rounds missing that evidence remain usable without an example.
  examples jsonb not null,
  foreign key (session_id,student_id,domain)
    references public.student_wordbook_review_sessions(session_id,student_id,domain) on delete cascade
);
alter table public.student_wordbook_review_flow enable row level security;
revoke all on public.student_wordbook_review_flow from public,anon,authenticated,service_role;
grant select,insert,update on public.student_wordbook_review_flow to service_role;

-- The ONLY new pre-test projection reads this round's immutable snapshot, not
-- candidates, live vocabulary, or the fixed pool. The API strips presentation
-- before sending test data and masks spelling examples on the server.
create function public.wordbook_review_flow_state(p_student uuid,p_session uuid,
  p_action text default 'read',p_item uuid default null,p_answer jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare s public.student_wordbook_review_sessions%rowtype;
  f public.student_wordbook_review_flow%rowtype;
  i public.student_wordbook_review_items%rowtype; result jsonb;
begin
  perform public.wordbook_review_authorize(p_student);
  select * into s from public.student_wordbook_review_sessions
    where session_id=p_session and student_id=p_student for update;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
  if p_action is null or p_action not in ('read','study_next','repeat','start_test','answer','advance') then
    raise exception 'REVIEW_INVALID_ACTION'; end if;
  if not exists(select 1 from public.student_wordbook_review_flow where session_id=p_session) then
  insert into public.student_wordbook_review_flow(session_id,student_id,domain,phase,position,examples)
    values(s.session_id,s.student_id,s.domain,
      case when s.status='completed' then 'result' when s.answered>0 then 'test' else 'study' end,
      least(s.total,s.answered+1),
      (select coalesce(jsonb_object_agg(ri.item_id::text,coalesce(
        (select pf.examples->pi.item_id::text from public.student_wordbook_review_flow pf
          join public.student_wordbook_review_items pi on pi.session_id=pf.session_id
          where pf.session_id=s.parent_session_id and pi.wordbook_entry_id=ri.wordbook_entry_id
            and pi.snapshot->'senseId'=ri.snapshot->'senseId' and pi.snapshot->'testedSources'=ri.snapshot->'testedSources'),(
        select coalesce(jsonb_agg(ex.value order by ex.n),'[]'::jsonb)
        from jsonb_array_elements(coalesce(ri.snapshot->'examples','[]'::jsonb)) with ordinality ex(value,n)
        where exists(select 1 from public.student_wordbook_examples sx
          join public.student_wordbook_example_senses sl using(example_id)
          where sx.student_id=p_student and sx.domain=s.domain and sx.wordbook_entry_id=ri.wordbook_entry_id
            and sl.sense_id::text=ri.snapshot->>'senseId' and sx.example_text=ex.value->>'text'
            and sx.source_types && array(select jsonb_array_elements_text(ri.snapshot->'testedSources')))
      ))),'{}'::jsonb) from public.student_wordbook_review_items ri where ri.session_id=p_session))
    on conflict(session_id) do nothing;
  end if;
  select * into f from public.student_wordbook_review_flow where session_id=p_session;
  select * into i from public.student_wordbook_review_items where session_id=p_session and position=f.position;
  -- Stale/double navigation returns the current cursor; it cannot skip a card.
  if p_action<>'read' and p_item=i.item_id then
    if p_action='study_next' and f.phase='study' then
      f.position:=least(s.total,f.position+1);
    elsif p_action='repeat' and f.phase='study' and f.position=s.total then
      f.position:=1;
    elsif p_action='start_test' and f.phase='study' then
      f.phase:='test';f.position:=least(s.total,s.answered+1);
    elsif p_action='answer' and f.phase='test' then
      perform public.wordbook_review_submit(p_student,p_session,p_item,p_answer);
    elsif p_action='advance' and f.phase='test' then
      if not exists(select 1 from public.student_wordbook_review_answers where item_id=i.item_id) then
        raise exception 'REVIEW_INVALID_POSITION'; end if;
      if f.position=s.total then f.phase:='result'; else f.position:=f.position+1; end if;
    elsif (p_action='start_test' and f.phase='test')
      or (p_action in ('advance','answer') and f.phase='result') then
      null; -- Last-item responses can be retried after their transition committed.
    else raise exception 'REVIEW_INVALID_ACTION'; end if;
    update public.student_wordbook_review_flow set phase=f.phase,position=f.position where session_id=p_session;
  elsif p_action<>'read' and p_item is null then raise exception 'REVIEW_INVALID_ITEM';
  end if;
  select * into i from public.student_wordbook_review_items where session_id=p_session and position=f.position;
  result:=public.wordbook_review_read(p_student,p_session,
    case when f.phase='test' then f.position else null end);
  if f.phase='study' then
    result:=jsonb_set(result,'{item}',jsonb_build_object('itemId',i.item_id,'position',i.position,
      'kind',i.kind,'sourceTypes',i.snapshot->'testedSources','prompt',i.snapshot->'expression','options','[]'::jsonb));
  end if;
  return result||jsonb_build_object('flow',jsonb_build_object('phase',f.phase,'position',f.position),
    'presentation',jsonb_build_object('expression',i.snapshot->'expression','pos',i.snapshot->'standardPos',
      'meaning',i.snapshot->'meaning','examples',f.examples->i.item_id::text));
end;
$$;
revoke all on function public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb) to service_role;
-- Extend the existing installation audit ONLY for these two functions. Old
-- snapshot/history rows and all protected pool/candidate hashes remain unchanged.
update public.student_wordbook_review_installation set function_hashes=(function_hashes-
  array['wordbook_review_submit(uuid,uuid,uuid,jsonb)','public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'])||(
  select jsonb_object_agg(p.oid::regprocedure::text,md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n')))
  from pg_proc p where p.oid in ('public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure,
    'public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)'::regprocedure)) where version='v1';
notify pgrst,'reload schema';
commit;
select 'WORDBOOK_REVIEW_IMMERSIVE_OK' as result;
