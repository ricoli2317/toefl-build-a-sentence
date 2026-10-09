-- MANUAL ONLY. Run WHOLE file after matching Preflight. Never auto-execute.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
-- Freeze collection transactions before RECHECKING the approved cleanup.
lock table public.student_wordbook_entries,public.student_wordbook_senses,public.student_wordbook_examples,
  public.student_wordbook_example_senses,public.student_wordbook_canonical_links,public.student_wordbook_activities
  in share row exclusive mode;
-- Same safety checks as Preflight, repeated AFTER collection locks. No stale approval.
do $$
declare r record; t text; n integer;
begin
  foreach t in array array['anon','authenticated'] loop
    if not exists(select 1 from pg_roles where rolname=t and not rolbypassrls and not rolsuper)
      or pg_has_role(t,current_user,'USAGE') then raise exception 'REVIEW_UNSAFE_CLIENT_ROLE: %',t; end if;
  end loop;
  if not exists(select 1 from pg_roles where rolname='service_role' and (rolbypassrls or rolsuper)) then raise exception 'REVIEW_SERVICE_ROLE_REQUIRED'; end if;
  for r in select * from (values
    ('bdd0bd35-e23d-4b59-934f-cbc9de875a93'::uuid,'like@bas.com',34,20),
    ('523be430-1f13-4660-8f11-1d263fc1438e'::uuid,'jiangzhuocheng2@bas.com',9,17),
    ('c05d7082-ae31-46a0-918c-ae3de880017a'::uuid,'zhangciwei0@bas.com',1,0)
  ) v(id,email,reading,writing) loop
    if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=r.id and lower(u.email)=r.email and p.role in ('student','teacher','admin')) then raise exception 'REVIEW_CLEANUP_ACCOUNT_DRIFT: %',r.id; end if;
    if (select count(*) from public.student_wordbook_entries where student_id=r.id and domain='reading')<>r.reading
      or (select count(*) from public.student_wordbook_entries where student_id=r.id and domain='writing')<>r.writing then raise exception 'REVIEW_CLEANUP_COUNT_DRIFT: %',r.id; end if;
  end loop;
  if exists(select 1 from public.student_wordbook_entries where student_id not in (
    'bdd0bd35-e23d-4b59-934f-cbc9de875a93','523be430-1f13-4660-8f11-1d263fc1438e','c05d7082-ae31-46a0-918c-ae3de880017a')) then raise exception 'REVIEW_UNAPPROVED_EXISTING_WORDBOOK_DATA'; end if;
  for r in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','ae7b641ab11d258581b0665a23a230f9'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','dec6074fd48dcba5d0f20aecc14b987d'),
    ('public.delete_student_wordbook_entries_v1(uuid,text,uuid[])','e51054f20e708846b746ae70e000850d')
  ) v(signature,body_hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(r.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[] and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=r.body_hash)
      or has_function_privilege('anon',r.signature,'EXECUTE') or has_function_privilege('authenticated',r.signature,'EXECUTE')
      or not has_function_privilege('service_role',r.signature,'EXECUTE') then raise exception 'REVIEW_EXISTING_RPC_DRIFT: %',r.signature; end if;
  end loop;
  for r in select * from (values
    ('student_wordbook_senses','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_examples','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_canonical_links','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_activities','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_example_senses','student_wordbook_examples',array['example_id','wordbook_entry_id','student_id','domain']),
    ('student_wordbook_example_senses','student_wordbook_senses',array['sense_id','wordbook_entry_id','student_id','domain'])
  ) v(child,parent,columns) loop
    if not exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.'||r.child)
      and c.confrelid=to_regclass('public.'||r.parent) and c.contype='f' and c.convalidated and c.confdeltype='c'
      and (select array_agg(a.attname::text order by k.n) from unnest(c.conkey) with ordinality k(attnum,n)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)=r.columns
      and (select array_agg(a.attname::text order by k.n) from unnest(c.confkey) with ordinality k(attnum,n)
        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum)=r.columns) then raise exception 'REVIEW_CLEANUP_CASCADE_DRIFT: %',r.child; end if;
  end loop;
  if exists(select 1 from pg_trigger where not tgisinternal and (tgtype::integer & 8)<>0 and tgrelid in (
    'public.student_wordbook_entries'::regclass,'public.student_wordbook_senses'::regclass,'public.student_wordbook_examples'::regclass,
    'public.student_wordbook_example_senses'::regclass,'public.student_wordbook_canonical_links'::regclass,
    'public.student_wordbook_activities'::regclass)) then raise exception 'REVIEW_UNEXPECTED_DELETE_TRIGGER'; end if;
  if exists(select 1 from pg_constraint c where c.contype='f' and c.confrelid in (
    'public.student_wordbook_entries'::regclass,'public.student_wordbook_senses'::regclass,
    'public.student_wordbook_examples'::regclass,'public.student_wordbook_example_senses'::regclass,
    'public.student_wordbook_canonical_links'::regclass,'public.student_wordbook_activities'::regclass)
    and c.conrelid not in ('public.student_wordbook_senses'::regclass,'public.student_wordbook_examples'::regclass,
      'public.student_wordbook_example_senses'::regclass,'public.student_wordbook_canonical_links'::regclass,
      'public.student_wordbook_activities'::regclass)) then raise exception 'REVIEW_UNKNOWN_INBOUND_FK'; end if;
  foreach t in array array['student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses',
    'student_wordbook_canonical_links','student_wordbook_activities'] loop
    execute format('select count(*) from public.%I c left join public.student_wordbook_entries w using(wordbook_entry_id)
      where w.wordbook_entry_id is null or (c.student_id,c.domain) is distinct from (w.student_id,w.domain)',t) into n;
    if n<>0 then raise exception 'REVIEW_CHILD_OWNERSHIP_DRIFT: %',t; end if;
  end loop;
  foreach t in array array['student_wordbook_source_evidence','student_wordbook_review_sessions','student_wordbook_review_items',
    'student_wordbook_review_answers','student_wordbook_review_installation'] loop
    if to_regclass('public.'||t) is not null then raise exception 'REVIEW_ALREADY_INSTALLED_OR_NAME_COLLISION: %',t; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wordbook_review_%') then raise exception 'REVIEW_FUNCTION_NAME_COLLISION'; end if;
end;
$$;

create table public.student_wordbook_review_installation (
  version text primary key,
  installed_at timestamptz not null default clock_timestamp(),
  cleanup_counts jsonb not null,
  protected_counts jsonb not null,
  function_hashes jsonb not null default '{}'
);
insert into public.student_wordbook_review_installation(version,cleanup_counts,protected_counts)
select 'v1', (select jsonb_agg(to_jsonb(c)) from (
  select student_id,domain,count(*) as entries from public.student_wordbook_entries group by student_id,domain) c),
  jsonb_build_object('users',(select count(*) from auth.users),'profiles',(select count(*) from public.profiles),
    'lexicalEntries',(select count(*) from public.lexical_entries),'lexicalOccurrences',(select count(*) from public.lexical_occurrences));

-- One parent delete; validated owner/domain CASCADE FKs remove all approved children.
delete from public.student_wordbook_entries where student_id in (
  'bdd0bd35-e23d-4b59-934f-cbc9de875a93','523be430-1f13-4660-8f11-1d263fc1438e','c05d7082-ae31-46a0-918c-ae3de880017a');

create table public.student_wordbook_source_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  sense_id uuid not null,
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null,
  source_type text not null,
  -- Immutable canonical identity at collection time, not a second corpus row.
  lexical_entry_id uuid not null,
  canonical_normalized_expression text not null,
  canonical_expression_type text not null,
  canonical_identity_variant text not null,
  -- Snapshot identifiers, not a live occurrence FK: later corpus edits cannot rewrite provenance.
  occurrence_id uuid not null,
  source_item_id text not null,
  content_block_id text not null,
  start_offset integer not null check(start_offset>=0),
  end_offset integer not null check(end_offset>start_offset),
  source_text_hash text not null,
  first_saved_at timestamptz not null default clock_timestamp(),
  unique(sense_id,source_type,occurrence_id,source_text_hash),
  foreign key(sense_id,wordbook_entry_id,student_id,domain)
    references public.student_wordbook_senses(sense_id,wordbook_entry_id,student_id,domain) on delete cascade,
  -- Canonical/occurrence IDs are snapshot identities, not live FKs. Existing
  -- canonical UUID maintenance can cascade through links without rewriting or
  -- being blocked by immutable historical evidence. The verified save RPC binds them.
  check(public.wordbook_source_types_valid(array[source_type],domain))
);
create index student_wordbook_source_evidence_filter_idx
  on public.student_wordbook_source_evidence(student_id,domain,source_type,wordbook_entry_id,sense_id);
create index student_wordbook_source_evidence_canonical_idx
  on public.student_wordbook_source_evidence(wordbook_entry_id,lexical_entry_id);
create trigger student_wordbook_source_evidence_snapshot_guard before update on public.student_wordbook_source_evidence
  for each row execute function public.guard_student_wordbook_snapshot();

-- Patch ONLY exact approved save body. Existing authorization, stale checks, locks,
-- snapshots, examples, status/remove contract and activity transaction remain intact.
do $patch$
declare body text; marker text;
begin
  select prosrc into strict body from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)');
  marker := '  if p_expected->>''example_text'' is not null then';
  if (length(body)-length(replace(body,marker,'')))/length(marker)<>1 then raise exception 'REVIEW_SAVE_PATCH_DRIFT'; end if;
  body := replace(body,marker,$new$  insert into public.student_wordbook_source_evidence(sense_id,wordbook_entry_id,student_id,domain,
    source_type,lexical_entry_id,canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,
    occurrence_id,source_item_id,content_block_id,start_offset,end_offset,source_text_hash)
    values(s.sense_id,w.wordbook_entry_id,p_student_id,v_domain,o.source_type,e.entry_id,e.normalized_expression,e.expression_type,e.identity_variant,o.occurrence_id,
      o.source_item_id,o.content_block_id,o.start_offset,o.end_offset,b.source_text_hash)
    on conflict(sense_id,source_type,occurrence_id,source_text_hash) do nothing;
  get diagnostics v_rows = row_count;
  -- A fresh occurrence for an already-proven sense/source pair is provenance,
  -- not a new meaning/example/source activity. Only the first exact pair counts.
  v_changed := v_changed or (v_rows > 0 and (select count(*) from public.student_wordbook_source_evidence ev
    where ev.sense_id=s.sense_id and ev.source_type=o.source_type)=1);
  if not exists(select 1 from public.student_wordbook_source_evidence ev where ev.sense_id=s.sense_id
    and ev.source_type=o.source_type and ev.occurrence_id=o.occurrence_id and ev.source_text_hash=b.source_text_hash
    and (ev.wordbook_entry_id,ev.student_id,ev.domain,ev.source_item_id,ev.content_block_id,ev.start_offset,ev.end_offset)
      =(w.wordbook_entry_id,p_student_id,v_domain,o.source_item_id,o.content_block_id,o.start_offset,o.end_offset)
    and (ev.canonical_normalized_expression,ev.canonical_expression_type,ev.canonical_identity_variant)
      =(e.normalized_expression,e.expression_type,e.identity_variant)) then
    raise exception 'WORDBOOK_SOURCE_EVIDENCE_DRIFT'; end if;
  if p_expected->>'example_text' is not null then$new$);
  execute 'create or replace function public.operate_student_wordbook_v1(p_student_id uuid,p_occurrence_id uuid,p_action text,p_expected jsonb)
    returns jsonb language plpgsql security invoker set search_path=pg_catalog as '||quote_literal(body);
end;
$patch$;

create table public.student_wordbook_review_sessions (
  session_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null check(domain in ('reading','writing')),
  source_types text[] not null check(public.wordbook_source_types_valid(source_types,domain)),
  mode text not null check(mode in ('date','range','random','retry')),
  settings jsonb not null,
  timezone text not null,
  request_id uuid not null,
  parent_session_id uuid,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  status text not null default 'active' check(status in ('active','completed')),
  total integer not null check(total>0),
  answered integer not null default 0 check(answered>=0 and answered<=total),
  unique(student_id,request_id),
  unique(session_id,student_id,domain),
  foreign key(parent_session_id,student_id,domain)
    references public.student_wordbook_review_sessions(session_id,student_id,domain),
  check((status='completed')=(completed_at is not null)),
  check((status='completed')=(answered=total))
);
create index student_wordbook_review_sessions_history_idx on public.student_wordbook_review_sessions(student_id,started_at desc,session_id);
create index student_wordbook_review_sessions_random_idx on public.student_wordbook_review_sessions(student_id,domain,started_at)
  where mode='random';
create index student_wordbook_review_sessions_parent_idx on public.student_wordbook_review_sessions(parent_session_id,student_id,domain)
  where parent_session_id is not null;
create table public.student_wordbook_review_items (
  item_id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  student_id uuid not null,
  domain text not null,
  wordbook_entry_id uuid not null,
  position integer not null check(position>0),
  kind text not null check(kind in ('spelling_pos','meaning_choice')),
  -- Private fixed snapshot: identity, sense, provenance, options, expected assessments, examples.
  snapshot jsonb not null,
  unique(session_id,wordbook_entry_id),
  unique(session_id,position),
  unique(item_id,session_id,student_id,domain),
  foreign key(session_id,student_id,domain) references public.student_wordbook_review_sessions(session_id,student_id,domain) on delete cascade
);
create index student_wordbook_review_items_rotation_idx on public.student_wordbook_review_items(student_id,domain,wordbook_entry_id,session_id);
create table public.student_wordbook_review_answers (
  item_id uuid primary key,
  session_id uuid not null,
  student_id uuid not null,
  domain text not null,
  student_answer jsonb not null,
  -- Extensible per-item assessments; no derived-word questions in V1.
  assessments jsonb not null,
  spelling_correct boolean,
  pos_correct boolean,
  choice_correct boolean,
  item_correct boolean not null,
  submitted_at timestamptz not null default clock_timestamp(),
  foreign key(item_id,session_id,student_id,domain)
    references public.student_wordbook_review_items(item_id,session_id,student_id,domain) on delete cascade
);
create index student_wordbook_review_answers_session_idx on public.student_wordbook_review_answers(session_id,item_correct,item_id);
create function public.wordbook_review_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'REVIEW_SNAPSHOT_IMMUTABLE'; end; $$;
create trigger review_items_immutable before update on public.student_wordbook_review_items
  for each row execute function public.wordbook_review_immutable();
create trigger review_answers_immutable before update on public.student_wordbook_review_answers
  for each row execute function public.wordbook_review_immutable();
create function public.wordbook_review_session_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if (to_jsonb(new)-array['answered','status','completed_at']) is distinct from (to_jsonb(old)-array['answered','status','completed_at'])
    or old.status='completed' or new.answered<>old.answered+1 then raise exception 'REVIEW_SESSION_IMMUTABLE'; end if;
  return new;
end; $$;
create trigger review_session_guard before update on public.student_wordbook_review_sessions
  for each row execute function public.wordbook_review_session_guard();
create function public.wordbook_review_authorize(p_student uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
  if not exists(select 1 from public.profiles where id=p_student and is_active and role in ('student','teacher','admin')) then
    raise exception 'REVIEW_STUDENT_REQUIRED'; end if;
end; $$;

-- Explicit canonical POS mapping. Only observed corpus values become buttons.
create function public.wordbook_review_pos(p text) returns text language sql immutable set search_path=pg_catalog as $$
  select case lower(regexp_replace(btrim(p),'[.[:space:]_]','','g'))
    when 'noun' then 'noun' when 'n' then 'noun'
    when 'verb' then 'verb' when 'v' then 'verb'
    when 'adjective' then 'adjective' when 'adj' then 'adjective'
    when 'adverb' then 'adverb' when 'adv' then 'adverb'
    when 'preposition' then 'preposition' when 'prep' then 'preposition'
    when 'conjunction' then 'conjunction' when 'conj' then 'conjunction'
    when 'pronoun' then 'pronoun' when 'pron' then 'pronoun'
    when 'determiner' then 'determiner' when 'det' then 'determiner'
    when 'auxiliary' then 'auxiliary' when 'auxiliaryverb' then 'auxiliary' when 'aux' then 'auxiliary' when 'auxv' then 'auxiliary'
    when 'modal' then 'modal' when 'modalverb' then 'modal'
    when 'particle' then 'particle' when 'part' then 'particle'
    when 'interjection' then 'interjection' when 'interj' then 'interjection'
    when 'propernoun' then 'proper_noun' when 'propn' then 'proper_noun'
    when 'numeral' then 'numeral' when 'num' then 'numeral'
    when 'phrasalverb' then 'phrasal_verb' when 'phrv' then 'phrasal_verb'
    else null end;
$$;
create function public.wordbook_review_pos_options() returns jsonb language sql stable set search_path=pg_catalog as $$
  with observed as (
    select public.wordbook_review_pos(o.context_pos) as id from public.lexical_occurrences o
      join public.lexical_entries e on e.entry_id=o.entry_id where o.review_status<>'disabled' and e.review_status<>'disabled'
    union select public.wordbook_review_pos(s.value->>'pos') from public.lexical_entries e
      cross join lateral jsonb_array_elements(e.common_senses) s(value) where e.review_status<>'disabled'
  ), labels(id,label,rank) as (values ('noun','n.',1),('verb','v.',2),('adjective','adj.',3),('adverb','adv.',4),
    ('preposition','prep.',5),('conjunction','conj.',6),('pronoun','pron.',7),('determiner','det.',8),
    ('auxiliary','aux.',9),('modal','modal v.',10),('particle','part.',11),('interjection','interj.',12),
    ('proper_noun','prop. n.',13),('numeral','num.',14),('phrasal_verb','phr. v.',15))
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label) order by rank),'[]') from labels where id in(select id from observed);
$$;
create function public.wordbook_review_spelling(p text) returns text language sql immutable set search_path=pg_catalog as $$
  select lower(btrim(regexp_replace(p,'[[:space:]]+',' ','g')));
$$;
create function public.wordbook_review_meaning(p text) returns text language sql immutable set search_path=pg_catalog as $$
  select regexp_replace(lower(normalize(p,NFKC)),'[[:space:][:punct:]，。；：、（）【】《》“”‘’·…—]+','','g');
$$;
create function public.wordbook_review_meaning_conflict(a text,b text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare x text:=public.wordbook_review_meaning(a); y text:=public.wordbook_review_meaning(b); group_words text[];
begin
  if x is null or y is null or x='' or y='' or strpos(x,y)>0 or strpos(y,x)>0 then return true; end if;
  -- Conservative TEXT heuristics, never a proof of complete semantic disjointness.
  -- Shared Chinese characters are rejected, including negation variants.
  if exists(select 1 from regexp_split_to_table(x,'') c where c~'[一-龥]' and strpos(y,c)>0) then return true; end if;
  foreach group_words slice 1 in array array[
    ['保持','维持','保留','保存'],['增加','增长','提高','提升'],['减少','降低','下降','削减'],
    ['重要','关键','主要','重大'],['支持','赞成','帮助','协助'],['获得','取得','得到','获取'],
    ['开始','启动','发起','着手'],['结束','完成','终止','停止'],['允许','许可','准许','同意'],
    ['阻止','禁止','防止','制止'],['允许','许可','禁止','阻止'],['显示','表明','说明','体现'],['改变','变化','转变','转换'],
    ['使用','利用','应用','采用'],['需要','要求','需求','必要'],['建立','创建','设立','创立']
  ] loop
    if exists(select 1 from unnest(group_words) w where strpos(x,w)>0)
      and exists(select 1 from unnest(group_words) w where strpos(y,w)>0) then return true; end if;
  end loop;
  return false;
end;
$$;

-- Private candidate builder: one row per matching entry, no other student's senses.
-- Availability and creation call this SAME engine. A fixed deterministic greedy pool
-- yields repeatable eligibility; only final order/sense rotation is randomized.
create function public.wordbook_review_candidates(p_student uuid,p_domain text,p_sources text[],p_start timestamptz,p_end timestamptz)
returns table(entry_id uuid,kind text,snapshot jsonb,reason text) language plpgsql stable set search_path=pg_catalog as $$
declare w record; s record; d record; chosen jsonb; excluded text[]; options jsonb; hit text[]; required_sources text[];
  mode text; pool jsonb; pos_options jsonb:=public.wordbook_review_pos_options(); pos_id text; miss text;
begin
  select coalesce(jsonb_agg(jsonb_build_object('lexicalEntryId',q.entry_id,'meaning',q.meaning) order by q.meaning collate "C",q.entry_id),'[]') into pool from (
    select distinct e.entry_id,btrim(v.value->>'meaning_zh') as meaning from public.lexical_entries e
    cross join lateral jsonb_array_elements(e.common_senses) v(value)
    where e.review_status='generated' and jsonb_typeof(v.value)='object' and v.value->>'meaning_zh'~'[一-龥]'
      and length(v.value->>'meaning_zh') between 1 and 160
  ) q;
  for w in select e.* from public.student_wordbook_entries e where e.student_id=p_student and e.domain=p_domain
    and e.source_types && p_sources and (p_start is null or exists(select 1 from public.student_wordbook_activities a
      where a.student_id=p_student and a.domain=p_domain and a.wordbook_entry_id=e.wordbook_entry_id
        and a.activity_at>=p_start and a.activity_at<p_end)) order by e.wordbook_entry_id loop
    hit:=array(select t from unnest(w.source_types) t where t=any(p_sources) order by t collate "C");
    required_sources:=array(select t from unnest(hit) t where t in ('ctw','write_email','academic_discussion'));
    mode:=case when cardinality(required_sources)>0 then 'spelling_pos' else 'meaning_choice' end;
    if mode='meaning_choice' then required_sources:=hit; end if;
    chosen:=null; miss:='missing_source_sense';
    -- All saved meanings AND current exact-identity common meanings are excluded.
    select coalesce(array_agg(meaning),'{}') into excluded from (
      select context_meaning_zh as meaning from public.student_wordbook_senses where wordbook_entry_id=w.wordbook_entry_id
      union select v.value->>'meaning_zh' from public.student_wordbook_canonical_links l
      join public.lexical_entries e on e.entry_id=l.lexical_entry_id
      cross join lateral jsonb_array_elements(e.common_senses) v(value)
      where l.wordbook_entry_id=w.wordbook_entry_id and
        (e.normalized_expression,e.expression_type,e.identity_variant)=
        (l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant)
    ) q where meaning is not null;
    for s in select ss.* from public.student_wordbook_senses ss where ss.wordbook_entry_id=w.wordbook_entry_id
      and exists(select 1 from public.student_wordbook_source_evidence ev where ev.sense_id=ss.sense_id and ev.source_type=any(required_sources))
      order by (select count(*) from public.student_wordbook_review_items ri where ri.student_id=p_student and ri.domain=p_domain
        and ri.wordbook_entry_id=w.wordbook_entry_id and ri.snapshot->>'senseId'=ss.sense_id::text),ss.sense_id loop
      if s.context_meaning_zh!~'[一-龥]' or length(s.context_meaning_zh)>160 then miss:='missing_reliable_meaning'; continue; end if;
      if mode='spelling_pos' and (strpos(public.wordbook_review_spelling(normalize(s.context_meaning_zh,NFKC)),public.wordbook_review_spelling(w.expression))>0
        or s.context_meaning_zh ~* '\m(n|v|adj|adv|prep|conj|pron|det|aux|interj|noun|verb|adjective|adverb)\.'
        or s.context_meaning_zh ~* '\m(noun|verb|adjective|adverb|preposition|conjunction|pronoun|determiner|auxiliary|interjection|numeral)\M'
        or s.context_meaning_zh ~ '(名词|动词|形容词|副词|介词|连词|代词|数词|助动词)') then
        miss:='answer_in_prompt';continue; end if;
      pos_id:=public.wordbook_review_pos(s.context_pos);
      if mode='spelling_pos' and (pos_id is null or not exists(select 1 from jsonb_array_elements(pos_options) v where v->>'id'=pos_id)) then
        miss:='missing_reliable_pos'; continue; end if;
      options:='[]';
      if mode='meaning_choice' then
        for d in select v.value from jsonb_array_elements(pool) v(value) loop
          if exists(select 1 from public.student_wordbook_canonical_links l where l.wordbook_entry_id=w.wordbook_entry_id
            and l.lexical_entry_id=(d.value->>'lexicalEntryId')::uuid) then continue; end if;
          -- Same expression/other variant can also be a reasonable correct answer; exclude without merging identities.
          if exists(select 1 from public.lexical_entries e where e.entry_id=(d.value->>'lexicalEntryId')::uuid
            and e.normalized_expression=w.normalized_expression) then continue; end if;
          if exists(select 1 from unnest(excluded) m where public.wordbook_review_meaning_conflict(m,d.value->>'meaning'))
            or exists(select 1 from jsonb_array_elements(options) o where public.wordbook_review_meaning_conflict(o->>'text',d.value->>'meaning')) then continue; end if;
          options:=options||jsonb_build_array(jsonb_build_object('text',d.value->>'meaning','lexicalEntryId',d.value->>'lexicalEntryId'));
          exit when jsonb_array_length(options)=3;
        end loop;
        if jsonb_array_length(options)<3 then miss:='insufficient_distractors'; continue; end if;
      end if;
      chosen:=jsonb_build_object('expression',w.expression,'identity',jsonb_build_object('normalizedExpression',w.normalized_expression,
        'expressionType',w.expression_type,'identityVariant',w.identity_variant),'senseId',s.sense_id,
        'meaning',s.context_meaning_zh,'definitionEn',s.context_definition_en,'pos',pos_id,'standardPos',s.context_pos,
        'sourceTypes',hit,'testedSources',(select jsonb_agg(distinct ev.source_type) from public.student_wordbook_source_evidence ev
          where ev.sense_id=s.sense_id and ev.source_type=any(required_sources)),
        'evidence',(select jsonb_agg(to_jsonb(ev)) from public.student_wordbook_source_evidence ev
          where ev.sense_id=s.sense_id and ev.source_type=any(required_sources)),
        'examples',coalesce((select jsonb_agg(jsonb_build_object('text',x.example_text,'kind',x.context_kind) order by x.example_id)
          from public.student_wordbook_example_senses l join public.student_wordbook_examples x using(example_id)
          where l.sense_id=s.sense_id),'[]'), 'posOptions',pos_options,'distractors',options);
      exit;
    end loop;
    entry_id:=w.wordbook_entry_id;kind:=mode;snapshot:=chosen;reason:=case when chosen is null then miss else null end;return next;
  end loop;
end;
$$;

create function public.wordbook_review_validate(p_student uuid,p_settings jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare domain text:=p_settings->>'domain'; sources text[]; mode text:=p_settings->>'mode'; zone text:=p_settings->>'timeZone';
  first_day date; last_day date; today date; k integer;
begin
  if not exists(select 1 from public.profiles where id=p_student and is_active and role in ('student','teacher','admin')) then raise exception 'REVIEW_STUDENT_REQUIRED'; end if;
  if jsonb_typeof(p_settings) is distinct from 'object' or p_settings-array['domain','sources','mode','timeZone','start','end','count']<>'{}'::jsonb
    or domain is null or domain not in ('reading','writing') or mode is null or mode not in ('date','range','random')
    or jsonb_typeof(p_settings->'sources') is distinct from 'array'
    or zone is null or not exists(select 1 from pg_timezone_names where name=zone) then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  sources:=array(select v from jsonb_array_elements_text(p_settings->'sources') v order by v collate "C");
  if not public.wordbook_source_types_valid(sources,domain) then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  today:=(statement_timestamp() at time zone zone)::date;
  if mode='random' then
    if p_settings ? 'start' or p_settings ? 'end' or coalesce(p_settings->>'count','')!~'^[1-9][0-9]{0,5}$' then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
    k:=(p_settings->>'count')::integer;
  else
    if p_settings ? 'count' or coalesce(p_settings->>'start','')!~'^\d{4}-\d{2}-\d{2}$'
      or coalesce(p_settings->>'end','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
    first_day:=(p_settings->>'start')::date;last_day:=(p_settings->>'end')::date;
    if first_day<'2026-07-01' or last_day>today or last_day<first_day or mode='date' and first_day<>last_day then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  end if;
  return jsonb_build_object('domain',domain,'sources',sources,'mode',mode,'timeZone',zone,'count',k,
    'startAt',first_day::timestamp at time zone zone,'endAt',(last_day+1)::timestamp at time zone zone);
end;
$$;
create function public.wordbook_review_availability(p_student uuid,p_settings jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare q jsonb:=public.wordbook_review_validate(p_student,p_settings); result jsonb;
begin
  with candidates as materialized (select * from public.wordbook_review_candidates(p_student,q->>'domain',
    array(select jsonb_array_elements_text(q->'sources')),(q->>'startAt')::timestamptz,(q->>'endAt')::timestamptz))
  select jsonb_build_object('total',count(*) filter(where reason is null),'spellingPos',count(*) filter(where reason is null and kind='spelling_pos'),
    'meaningChoice',count(*) filter(where reason is null and kind='meaning_choice'),'unavailable',count(*) filter(where reason is not null),
    'reasons',coalesce((select jsonb_object_agg(reason,n) from (select reason,count(*) as n from candidates where reason is not null group by reason) r),'{}'),
    'posOptions',public.wordbook_review_pos_options()) into result
  from candidates;
  return result;
end;
$$;

-- Public-response builder is an explicit allowlist. Never return private snapshot wholesale.
create function public.wordbook_review_public_item(i public.student_wordbook_review_items,a public.student_wordbook_review_answers)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  result:=jsonb_build_object('itemId',i.item_id,'position',i.position,'kind',i.kind,'sourceTypes',i.snapshot->'testedSources',
    'prompt',case when i.kind='spelling_pos' then i.snapshot->'meaning' else i.snapshot->'expression' end,
    'options',case when i.kind='spelling_pos' then i.snapshot->'posOptions' else (
      select jsonb_agg(jsonb_build_object('id',v->>'id','text',v->>'text') order by n)
      from jsonb_array_elements(i.snapshot->'options') with ordinality o(v,n)) end);
  if a.item_id is not null then
    result:=result||jsonb_build_object('answer',jsonb_build_object('student',a.student_answer,'assessments',a.assessments,'correct',a.item_correct,
      'submittedAt',a.submitted_at,'expression',i.snapshot->'expression','pos',i.snapshot->'pos','standardPos',i.snapshot->'standardPos',
      'meaning',i.snapshot->'meaning','definitionEn',i.snapshot->'definitionEn','correctOptionId',i.snapshot->'correctOptionId','examples',i.snapshot->'examples'));
  end if;
  return result;
end;
$$;
create function public.wordbook_review_summary(p_session uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('correct',count(*) filter(where item_correct),'incorrect',count(*) filter(where not item_correct),
    'spellingCorrect',count(*) filter(where spelling_correct),'spellingTotal',count(spelling_correct),
    'posCorrect',count(*) filter(where pos_correct),'posTotal',count(pos_correct),
    'choiceCorrect',count(*) filter(where choice_correct),'choiceTotal',count(choice_correct))
  from public.student_wordbook_review_answers where session_id=p_session;
$$;
create function public.wordbook_review_read(p_student uuid,p_session uuid,p_position integer default null) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s public.student_wordbook_review_sessions%rowtype; i public.student_wordbook_review_items%rowtype; a public.student_wordbook_review_answers%rowtype;
begin
  perform public.wordbook_review_authorize(p_student);
  select * into s from public.student_wordbook_review_sessions where session_id=p_session and student_id=p_student;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
  if p_position is not null and (p_position<1 or p_position>least(s.total,s.answered+1)) then raise exception 'REVIEW_INVALID_POSITION'; end if;
  select * into i from public.student_wordbook_review_items where session_id=p_session and position=coalesce(p_position,least(s.total,s.answered+1));
  select * into a from public.student_wordbook_review_answers where item_id=i.item_id;
  return jsonb_build_object('session',to_jsonb(s)-'student_id'-'request_id','summary',public.wordbook_review_summary(p_session),
    'composition',(select jsonb_build_object('spellingPos',count(*) filter(where kind='spelling_pos'),'meaningChoice',count(*) filter(where kind='meaning_choice'))
      from public.student_wordbook_review_items where session_id=p_session),'item',public.wordbook_review_public_item(i,a));
end;
$$;

create function public.wordbook_review_create(p_student uuid,p_settings jsonb,p_request uuid,p_parent uuid default null)
returns jsonb language plpgsql volatile set search_path=pg_catalog as $$
declare q jsonb; s public.student_wordbook_review_sessions%rowtype; parent public.student_wordbook_review_sessions%rowtype;
  c record; selected jsonb:='[]'; snap jsonb; sid uuid; position integer:=0; k integer; day_start timestamptz; day_end timestamptz; now_at timestamptz;
begin
  if p_request is null then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  perform public.wordbook_review_authorize(p_student);
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'REVIEW_ISOLATION_REQUIRED'; end if;
  -- One identity/request lock first makes cross-domain retry idempotent and rejects reuse with changed settings.
  perform pg_advisory_xact_lock(hashtextextended('review-request:'||p_student::text||':'||p_request::text,0));
  select * into s from public.student_wordbook_review_sessions where student_id=p_student and request_id=p_request;
  if found then
    if s.settings is distinct from p_settings or s.parent_session_id is distinct from p_parent then raise exception 'REVIEW_REQUEST_CONFLICT'; end if;
    return public.wordbook_review_read(p_student,s.session_id); end if;
  if p_parent is not null then
    if p_settings<>'{}'::jsonb then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
    select * into parent from public.student_wordbook_review_sessions where session_id=p_parent and student_id=p_student and status='completed';
    if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
    perform pg_advisory_xact_lock(hashtextextended('review:'||p_student::text||':'||parent.domain,0));
    select coalesce(jsonb_agg(jsonb_build_object('entry',i.wordbook_entry_id,'kind',i.kind,'snapshot',i.snapshot) order by i.position),'[]') into selected
      from public.student_wordbook_review_items i join public.student_wordbook_review_answers a using(item_id)
      where i.session_id=p_parent and not a.item_correct;
    q:=jsonb_build_object('domain',parent.domain,'sources',parent.source_types,'mode','retry','timeZone',parent.timezone);
  else
    q:=public.wordbook_review_validate(p_student,p_settings);
    -- Reading/Writing independent; all combinations in a domain share this lock and history.
    perform pg_advisory_xact_lock(hashtextextended('review:'||p_student::text||':'||(q->>'domain'),0));
    now_at:=clock_timestamp();
    day_start:=((now_at at time zone (q->>'timeZone'))::date)::timestamp at time zone (q->>'timeZone');
    day_end:=(((now_at at time zone (q->>'timeZone'))::date)+1)::timestamp at time zone (q->>'timeZone');
    -- A single post-lock statement snapshot fixes candidate pool and history together.
    with candidates as materialized (select * from public.wordbook_review_candidates(p_student,q->>'domain',
      array(select jsonb_array_elements_text(q->'sources')),(q->>'startAt')::timestamptz,(q->>'endAt')::timestamptz)),
    counts as (select i.wordbook_entry_id,count(*) as n from public.student_wordbook_review_sessions rs
      join public.student_wordbook_review_items i using(session_id) where rs.student_id=p_student and rs.domain=q->>'domain'
        and rs.mode='random' and rs.started_at>=day_start and rs.started_at<day_end group by i.wordbook_entry_id),
    ranked as (select candidate.*,row_number() over(order by case when q->>'mode'='random' then coalesce(n,0) else 0 end,random()) as rank
      from candidates candidate left join counts h on h.wordbook_entry_id=candidate.entry_id where reason is null)
    select coalesce(jsonb_agg(jsonb_build_object('entry',entry_id,'kind',kind,'snapshot',snapshot) order by rank),'[]'),
      (select count(*) from candidates where reason is null) into selected,k from ranked
      where q->>'mode'<>'random' or rank<=(q->>'count')::integer;
    if q->>'mode'='random' and k<(q->>'count')::integer then raise exception 'REVIEW_INSUFFICIENT:%',k; end if;
  end if;
  k:=jsonb_array_length(selected);
  if k=0 then raise exception 'REVIEW_EMPTY'; end if;
  insert into public.student_wordbook_review_sessions(student_id,domain,source_types,mode,settings,timezone,request_id,parent_session_id,total,started_at)
    values(p_student,q->>'domain',array(select jsonb_array_elements_text(q->'sources')),q->>'mode',p_settings,q->>'timeZone',p_request,p_parent,k,coalesce(now_at,clock_timestamp()))
    returning session_id into sid;
  for c in select v from jsonb_array_elements(selected) v loop
    position:=position+1;snap:=c.v->'snapshot';
    if c.v->>'kind'='meaning_choice' then
      snap:=snap||jsonb_build_object('correctOptionId',gen_random_uuid());
      select snap||jsonb_build_object('options',jsonb_agg(v order by random())) into snap from (
        select jsonb_build_object('id',snap->>'correctOptionId','text',snap->>'meaning') as v
        union all select jsonb_build_object('id',gen_random_uuid(),'text',d->>'text') from jsonb_array_elements(snap->'distractors') d
      ) opts;
    end if;
    insert into public.student_wordbook_review_items(session_id,student_id,domain,wordbook_entry_id,position,kind,snapshot)
      values(sid,p_student,q->>'domain',(c.v->>'entry')::uuid,position,c.v->>'kind',snap);
  end loop;
  return public.wordbook_review_read(p_student,sid);
end;
$$;

create function public.wordbook_review_submit(p_student uuid,p_session uuid,p_item uuid,p_answer jsonb)
returns jsonb language plpgsql volatile set search_path=pg_catalog as $$
declare s public.student_wordbook_review_sessions%rowtype; i public.student_wordbook_review_items%rowtype;
  a public.student_wordbook_review_answers%rowtype; sc boolean; pc boolean; cc boolean; assessment jsonb;
begin
  perform public.wordbook_review_authorize(p_student);
  select * into s from public.student_wordbook_review_sessions where session_id=p_session and student_id=p_student for update;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
  select * into i from public.student_wordbook_review_items where session_id=p_session and item_id=p_item and student_id=p_student;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
  select * into a from public.student_wordbook_review_answers where item_id=p_item;
  if found then return public.wordbook_review_read(p_student,p_session,i.position); end if;
  if s.status<>'active' or i.position<>s.answered+1 then raise exception 'REVIEW_INVALID_POSITION'; end if;
  if jsonb_typeof(p_answer) is distinct from 'object' then raise exception 'REVIEW_INVALID_ANSWER'; end if;
  if i.kind='spelling_pos' then
    if p_answer-array['spelling','pos']<>'{}'::jsonb or jsonb_typeof(p_answer->'spelling') is distinct from 'string'
      or length(p_answer->>'spelling') not between 1 and 300 or jsonb_typeof(p_answer->'pos') is distinct from 'string'
      or not exists(select 1 from jsonb_array_elements(i.snapshot->'posOptions') o where o->>'id'=p_answer->>'pos') then raise exception 'REVIEW_INVALID_ANSWER'; end if;
    sc:=public.wordbook_review_spelling(p_answer->>'spelling')=public.wordbook_review_spelling(i.snapshot->>'expression');
    pc:=p_answer->>'pos'=i.snapshot->>'pos';assessment:=jsonb_build_object('spelling',sc,'pos',pc);
  else
    if p_answer-array['optionId']<>'{}'::jsonb or jsonb_typeof(p_answer->'optionId') is distinct from 'string'
      or not exists(select 1 from jsonb_array_elements(i.snapshot->'options') o where o->>'id'=p_answer->>'optionId') then raise exception 'REVIEW_INVALID_ANSWER'; end if;
    cc:=p_answer->>'optionId'=i.snapshot->>'correctOptionId';assessment:=jsonb_build_object('meaning_choice',cc);
  end if;
  insert into public.student_wordbook_review_answers(item_id,session_id,student_id,domain,student_answer,assessments,spelling_correct,pos_correct,choice_correct,item_correct)
    values(p_item,p_session,p_student,s.domain,p_answer,assessment,sc,pc,cc,coalesce(sc and pc,cc));
  update public.student_wordbook_review_sessions set answered=answered+1,
    status=case when answered+1=total then 'completed' else 'active' end,
    completed_at=case when answered+1=total then clock_timestamp() else null end where session_id=p_session;
  return public.wordbook_review_read(p_student,p_session,i.position);
end;
$$;

create function public.wordbook_review_history(p_student uuid,p_page integer) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  if p_page is null or p_page not between 1 and 100000 then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  perform public.wordbook_review_authorize(p_student);
  select jsonb_build_object('page',p_page,'pageSize',10,'total',(select count(*) from public.student_wordbook_review_sessions where student_id=p_student),
    'items',coalesce(jsonb_agg((to_jsonb(s)-'student_id'-'request_id')||jsonb_build_object('summary',public.wordbook_review_summary(s.session_id))
      order by s.started_at desc,s.session_id),'[]')) into result
    from (select * from public.student_wordbook_review_sessions where student_id=p_student order by started_at desc,session_id limit 10 offset (p_page-1)::bigint*10) s;
  return result;
end;
$$;
create function public.wordbook_review_errors(p_student uuid,p_session uuid,p_page integer) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  perform public.wordbook_review_authorize(p_student);
  if not exists(select 1 from public.student_wordbook_review_sessions where session_id=p_session and student_id=p_student and status='completed') then raise exception 'REVIEW_NOT_FOUND'; end if;
  if p_page is null or p_page not between 1 and 100000 then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  select jsonb_build_object('page',p_page,'pageSize',10,'total',(select count(*) from public.student_wordbook_review_answers where session_id=p_session and not item_correct),
    'items',coalesce(jsonb_agg(public.wordbook_review_public_item(i,a) order by i.position),'[]')) into result
    from (select ri.item_id from public.student_wordbook_review_items ri join public.student_wordbook_review_answers ra using(item_id)
      where ri.session_id=p_session and not ra.item_correct order by ri.position limit 10 offset (p_page-1)::bigint*10) page
    join public.student_wordbook_review_items i using(item_id) join public.student_wordbook_review_answers a using(item_id);
  return result;
end;
$$;

-- All data, including unsubmitted answers, stays service-only. Authenticated API
-- verifies active student-experience identity before making an owner-scoped RPC.
do $$
declare t text; f record;
begin
  foreach t in array array['student_wordbook_source_evidence','student_wordbook_review_sessions','student_wordbook_review_items',
    'student_wordbook_review_answers','student_wordbook_review_installation'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  end loop;
  grant select,insert,delete on public.student_wordbook_source_evidence to service_role;
  grant select,insert,update on public.student_wordbook_review_sessions to service_role;
  grant select,insert on public.student_wordbook_review_items,public.student_wordbook_review_answers to service_role;
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'wordbook_review_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end;
$$;
update public.student_wordbook_review_installation set function_hashes=(select jsonb_object_agg(p.oid::regprocedure::text,
  md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'wordbook_review_%' or p.proname='operate_student_wordbook_v1')) where version='v1';
notify pgrst,'reload schema';
commit;
select 'WORDBOOK_REVIEW_MIGRATION_OK' as result;
