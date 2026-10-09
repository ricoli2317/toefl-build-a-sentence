-- USER-MANUAL minimal incremental schema/runtime patch; NO pool installation.
-- Requires previous fixed_pool migration. Production may still be on ASCII:
-- do not rerun old seed or assume the V2 pool is already installed.
begin;
set local lock_timeout='5s';
do $guard$
declare f record; audit jsonb;
begin
 if to_regclass('public.wordbook_review_fixed_distractors') is null then raise exception 'REVIEW_PREFERENCE_FIXED_POOL_REQUIRED'; end if;
 if exists(select 1 from pg_attribute where attrelid='public.wordbook_review_fixed_distractors'::regclass and attname='noun_kind' and not attisdropped) then
  raise exception 'REVIEW_PREFERENCE_ALREADY_PRESENT'; end if;
 select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
 if audit is null then raise exception 'REVIEW_PREFERENCE_AUDIT_REQUIRED'; end if;
 for f in select * from (values
  ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','b210f1a05fbea67b249faf81b57d857e'),
  ('public.wordbook_review_meaning_conflict(text,text)','556b46059d2e33322d35dbea5c39ff25'),
  ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9')
 ) expected(signature,hash) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
   and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
   or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then raise exception 'REVIEW_PREFERENCE_BASELINE_DRIFT: %',f.signature; end if;
 end loop;
 for f in select key signature,value #>> '{}' hash from jsonb_each(audit) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
    and proconfig=array['search_path=pg_catalog']::text[] and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
   or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
   or not has_function_privilege('service_role',f.signature,'EXECUTE') then raise exception 'REVIEW_PREFERENCE_AUDIT_ACL_DRIFT'; end if;
 end loop;
end;
$guard$;
alter table public.wordbook_review_fixed_distractors
 add column lexical_category text check(lexical_category in('通用学术','学科专业')),
 add column subject text check(subject in('跨学科学术','生物','生态','地质','天文','考古','历史','艺术','心理','科技')),
 add column noun_kind text check(noun_kind is null or (noun_kind in('abstract','concrete','other') and pos='noun'));

-- Small explicit related-subject pairs, not a classifier. Missing target tags
-- give NO preference; unknown candidate tags get neutral intermediate rank.
create function public.wordbook_review_preference_rank(target jsonb,candidate jsonb,p_pos text)
returns integer language plpgsql immutable set search_path=pg_catalog as $$
declare rank integer:=0; t text; c text;
begin
 if p_pos='noun' and target->>'noun_kind' in('abstract','concrete') then
  t:=target->>'noun_kind';c:=candidate->>'noun_kind';
  rank:=rank+case when c=t then 0 when c is null or c='other' then 100 else 200 end;
 end if;
 t:=target->>'lexical_category';c:=candidate->>'lexical_category';
 if t is not null then rank:=rank+case when c=t then 0 when c is null then 10 else 20 end; end if;
 if t='学科专业' and c='学科专业' and target->>'subject' is not null then
  t:=target->>'subject';c:=candidate->>'subject';
  rank:=rank+case when c=t then 0 when c is null then 2
   when exists(select 1 from (values
    ('生物','生态'),('生物','心理'),('生态','地质'),('地质','考古'),('地质','天文'),
    ('天文','科技'),('考古','历史'),('考古','艺术'),('历史','艺术'),('心理','科技')
   ) related(a,b) where (a=t and b=c) or (a=c and b=t)) then 1 else 3 end;
 end if;
 return rank;
end;
$$;
revoke all on function public.wordbook_review_preference_rank(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.wordbook_review_preference_rank(jsonb,jsonb,text) to service_role;

do $patch$
declare definition text; signature text; before_meta jsonb; after_meta jsonb;
begin
 signature:='public.wordbook_review_meaning_conflict(text,text)';
 definition:=pg_get_functiondef(to_regprocedure(signature));
 definition:=replace(definition,$old$['使用','利用','应用','采用'],$old$,
  $new$['限制','抑制','约束','制约'],['使用','利用','应用','采用'],$new$);
 execute definition;

 signature:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
 select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
  into before_meta from pg_proc where oid=to_regprocedure(signature);
 definition:=pg_get_functiondef(to_regprocedure(signature));
 definition:=replace(definition,$old$selected_meaning text;$old$,
  $new$selected_meaning text; metadata_map jsonb; target_meta jsonb; matches jsonb;$new$);
 -- Fixed table contains at most the small maintained pool. Read ONCE per call
 -- for labels as well as fallback; no corpus query and no runtime classification.
 definition:=replace(definition,$old$      options:='[]';
      if mode='meaning_choice' then$old$,$new$      options:='[]';
      if mode='meaning_choice' then
        if fixed_pool is null then
          select coalesce(jsonb_agg(jsonb_build_object('meaning',f.meaning,'pos',f.pos,
            'normalized_expression',f.normalized_expression,'lexical_id',f.canonical_entry_id,'pool_id',f.pool_id,
            'lexical_category',f.lexical_category,'subject',f.subject,'noun_kind',f.noun_kind)
            order by f.pool_id),'[]'),
            coalesce(jsonb_object_agg(f.canonical_entry_id::text||'|'||f.pos||'|'||public.wordbook_review_meaning(f.meaning),
              jsonb_build_object('lexical_category',f.lexical_category,'subject',f.subject,'noun_kind',f.noun_kind)),'{}')
            into fixed_pool,metadata_map from public.wordbook_review_fixed_distractors f where f.approved;
        end if;$new$);
 definition:=replace(definition,$old$          ) q;
        end if;
        target_links:=$old$,$new$          ) q;
          -- Local tags require the saved canonical link + exact POS/meaning.
          -- Different/ambiguous labels fail neutral rather than being guessed.
          select coalesce(jsonb_agg(v.value||case when jsonb_array_length(m.tags)=1 then m.tags->0 else '{}'::jsonb end),'[]')
            into local_pool from jsonb_array_elements(local_pool) v(value)
            cross join lateral (select coalesce(jsonb_agg(distinct tag) filter(where tag is not null),'[]') tags from (
              select metadata_map->(l.value||'|'||(v.value->>'pos')||'|'||public.wordbook_review_meaning(v.value->>'meaning')) tag
              from jsonb_array_elements_text(v.value->'links') l(value)
            ) labels) m;
        end if;
        target_links:=$new$);
 definition:=replace(definition,$old$        for tier in 1..2 loop$old$,$new$        select coalesce(jsonb_agg(distinct tag) filter(where tag is not null),'[]') into matches from (
          select metadata_map->(l::text||'|'||pos_id||'|'||public.wordbook_review_meaning(s.context_meaning_zh)) tag
          from unnest(target_links) l
        ) labels;
        target_meta:=case when jsonb_array_length(matches)=1 then matches->0 else '{}'::jsonb end;
        for tier in 1..2 loop$new$);
 -- Remove the now-unreachable former lazy block, keeping tier boundaries.
 definition:=replace(definition,$old$            -- Read the small approved fixed table at most once for this call,
            -- and only AFTER local choices fail. Never read occurrences.
            if fixed_pool is null then
              select coalesce(jsonb_agg(jsonb_build_object('meaning',f.meaning,'pos',f.pos,
                'normalized_expression',f.normalized_expression,'lexical_id',f.canonical_entry_id,'pool_id',f.pool_id)
                order by f.pool_id),'[]') into fixed_pool
              from public.wordbook_review_fixed_distractors f where f.approved;
            end if;
$old$,'');
 definition:=replace(definition,$old$            order by coalesce((used_meanings->>public.wordbook_review_meaning(v.value->>'meaning'))::integer,0),
              v.value->>'meaning' collate "C",coalesce(v.value->>'wordbook_id',v.value->>'pool_id') loop$old$,$new$            where v.value->>'pos'=pos_id
            order by case when used_meanings ? public.wordbook_review_meaning(v.value->>'meaning') then 1 else 0 end,
              public.wordbook_review_preference_rank(target_meta,v.value,pos_id),
              coalesce((used_meanings->>public.wordbook_review_meaning(v.value->>'meaning'))::integer,0),
              md5(jsonb_build_array(w.normalized_expression,pos_id,public.wordbook_review_meaning(s.context_meaning_zh),
                v.value->>'normalized_expression',public.wordbook_review_meaning(v.value->>'meaning'))::text),
              coalesce(v.value->>'wordbook_id',v.value->>'pool_id') loop$new$);
 -- Candidate traversal also avoids fresh random UUIDs perturbing round counts.
 definition:=replace(definition,'order by e.wordbook_entry_id loop',
  'order by md5(jsonb_build_array(e.normalized_expression,e.expression_type,e.identity_variant)::text),e.wordbook_entry_id loop');
 if strpos(definition,'lexical_occurrences')>0 or strpos(definition,'meaning'' collate "C"')>0 then raise exception 'REVIEW_PREFERENCE_OLD_PATH_REMAINS'; end if;
 execute definition;
 select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
  into after_meta from pg_proc where oid=to_regprocedure(signature);
 if before_meta is distinct from after_meta then raise exception 'REVIEW_PREFERENCE_CONTRACT_CHANGED'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure(signature)
   and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='5c1eef05c08c227b7b2b1fcccba9a0cc')
  or not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_meaning_conflict(text,text)')
   and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='eb381c598b43005e5dc5ad7dd583ff34') then
  raise exception 'REVIEW_PREFERENCE_PATCH_MISMATCH'; end if;
 update public.student_wordbook_review_installation set function_hashes=function_hashes||(
  select jsonb_object_agg(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
   from pg_proc where pronamespace='public'::regnamespace and proname in('wordbook_review_candidates','wordbook_review_meaning_conflict','wordbook_review_preference_rank')
 ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_CHOICE_PREFERENCE_MIGRATION_OK' as result;
