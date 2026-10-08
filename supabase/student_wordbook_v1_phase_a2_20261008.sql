-- A2: run the WHOLE file in SQL Editor after A1. No existing objects replaced.
-- Trusted Next.js server authorizes the owned page and extracts exact context.
-- One RPC = one transaction. No browser EXECUTE, no SECURITY DEFINER, no corpus writes.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';

create function public.operate_student_wordbook_v1(
  p_student_id uuid, p_occurrence_id uuid, p_action text, p_expected jsonb
) returns jsonb language plpgsql security invoker set search_path = pg_catalog
as $$
declare
  o public.lexical_occurrences%rowtype;
  e public.lexical_entries%rowtype;
  b public.lexical_source_blocks%rowtype;
  w public.student_wordbook_entries%rowtype;
  s public.student_wordbook_senses%rowtype;
  x public.student_wordbook_examples%rowtype;
  l public.student_wordbook_canonical_links%rowtype;
  v_domain text; v_key bytea; v_current jsonb;
begin
  if p_action is null or p_action not in ('save','remove') or p_expected is null then
    raise exception 'WORDBOOK_INVALID_OPERATION';
  end if;
  if not exists(select 1 from public.profiles where id=p_student_id
    and is_active and role in ('student','teacher','admin')) then
    raise exception 'WORDBOOK_STUDENT_REQUIRED';
  end if;
  select * into o from public.lexical_occurrences where occurrence_id=p_occurrence_id;
  if not found or o.review_status='disabled' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  select * into e from public.lexical_entries where entry_id=o.entry_id;
  if not found or e.review_status='disabled' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  select * into b from public.lexical_source_blocks where source_type=o.source_type
    and source_item_id=o.source_item_id and content_block_id=o.content_block_id;
  if not found or b.generation_status<>'generated' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  v_current := jsonb_build_object(
    'entry_id',e.entry_id,'source_type',o.source_type,'source_item_id',o.source_item_id,'content_block_id',o.content_block_id,
    'start_offset',o.start_offset,'end_offset',o.end_offset,'surface_text',o.surface_text,
    'context_text',o.context_text,'sentence_id',o.sentence_id,
    'context_pos',o.context_pos,'context_meaning_zh',o.context_meaning_zh,'context_definition_en',o.context_definition_en,
    'canonical_expression',e.canonical_expression,'normalized_expression',e.normalized_expression,
    'expression_type',e.expression_type,'identity_variant',e.identity_variant,
    'source_text_hash',b.source_text_hash,'source_block_kind',b.block_kind);
  if v_current is distinct from (p_expected - array['example_text','context_kind','extraction_method']) then
    raise exception 'WORDBOOK_CANONICAL_STALE';
  end if;
  v_domain := case when o.source_type in ('ctw','rdl','rap') then 'reading'
    when o.source_type in ('bas','write_email','academic_discussion') then 'writing' else null end;
  if v_domain is null then raise exception 'WORDBOOK_INVALID_SOURCE'; end if;
  v_key := public.wordbook_snapshot_key(array[e.normalized_expression,e.expression_type,e.identity_variant]);
  -- Shared save/remove protocol serializes even an ABSENT entry. Hash collisions
  -- merely serialize unrelated operations; the complete tuple is checked below.
  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text || ':' || v_domain || ':' || encode(v_key,'hex'),0));
  select * into w from public.student_wordbook_entries
    where student_id=p_student_id and domain=v_domain and lexeme_key=v_key for update;
  if found and row(w.normalized_expression,w.expression_type,w.identity_variant)
    is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant) then
    raise exception 'WORDBOOK_IDENTITY_HASH_COLLISION';
  end if;
  if p_action='remove' then
    delete from public.student_wordbook_entries where student_id=p_student_id and domain=v_domain
      and wordbook_entry_id=w.wordbook_entry_id;
    return jsonb_build_object('saved',false,'domain',v_domain,'wordbookEntryId',null);
  end if;
  -- Validate server-only extraction before any INSERT; no partly saved entry.
  if coalesce(btrim(p_expected->>'example_text'),'')=''
    or strpos(o.context_text,p_expected->>'example_text')=0
    or p_expected->>'context_kind' is null
    or p_expected->>'context_kind' not in ('sentence','fragment')
    or p_expected->>'extraction_method' is null then raise exception 'WORDBOOK_INVALID_CONTEXT'; end if;
  if w.wordbook_entry_id is null then
    insert into public.student_wordbook_entries(student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values(p_student_id,v_domain,e.canonical_expression,e.normalized_expression,e.expression_type,e.identity_variant)
      on conflict(student_id,domain,lexeme_key) do nothing;
    -- Separate statement sees a concurrent ON CONFLICT winner in READ COMMITTED.
    select * into strict w from public.student_wordbook_entries
      where student_id=p_student_id and domain=v_domain and lexeme_key=v_key for update;
    if row(w.normalized_expression,w.expression_type,w.identity_variant)
      is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant) then
      raise exception 'WORDBOOK_IDENTITY_HASH_COLLISION';
    end if;
  end if;
  insert into public.student_wordbook_canonical_links(wordbook_entry_id,student_id,domain,lexical_entry_id,
    canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind)
    values(w.wordbook_entry_id,p_student_id,v_domain,e.entry_id,e.normalized_expression,e.expression_type,e.identity_variant,'exact_identity')
    on conflict(wordbook_entry_id,lexical_entry_id) do nothing;
  select * into strict l from public.student_wordbook_canonical_links
    where student_id=p_student_id and domain=v_domain and lexical_entry_id=e.entry_id;
  if row(l.wordbook_entry_id,l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant,l.association_kind)
    is distinct from row(w.wordbook_entry_id,e.normalized_expression,e.expression_type,e.identity_variant,'exact_identity'::text) then
    raise exception 'WORDBOOK_CANONICAL_IDENTITY_MISMATCH';
  end if;
  insert into public.student_wordbook_senses(wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,context_definition_en)
    values(w.wordbook_entry_id,p_student_id,v_domain,o.context_pos,o.context_meaning_zh,o.context_definition_en)
    on conflict(wordbook_entry_id,snapshot_key) do nothing;
  select * into strict s from public.student_wordbook_senses where wordbook_entry_id=w.wordbook_entry_id
    and snapshot_key=public.wordbook_snapshot_key(array[o.context_pos,o.context_meaning_zh,o.context_definition_en]);
  if row(s.context_pos,s.context_meaning_zh,s.context_definition_en)
    is distinct from row(o.context_pos,o.context_meaning_zh,o.context_definition_en) then
    raise exception 'WORDBOOK_SENSE_HASH_COLLISION';
  end if;
  insert into public.student_wordbook_examples as target
    (wordbook_entry_id,student_id,domain,example_text,context_kind,source_block_kind,extraction_method,source_types)
    values(w.wordbook_entry_id,p_student_id,v_domain,p_expected->>'example_text',p_expected->>'context_kind',b.block_kind,
      p_expected->>'extraction_method',array[o.source_type])
    on conflict(wordbook_entry_id,snapshot_key) do update set source_types=
      array(select distinct t collate "C" from unnest(target.source_types || excluded.source_types) t order by t collate "C")
    returning * into x;
  if x.example_text is distinct from p_expected->>'example_text' then raise exception 'WORDBOOK_EXAMPLE_HASH_COLLISION'; end if;
  insert into public.student_wordbook_example_senses(example_id,sense_id,wordbook_entry_id,student_id,domain)
    values(x.example_id,s.sense_id,w.wordbook_entry_id,p_student_id,v_domain)
    on conflict(example_id,sense_id) do nothing;
  return jsonb_build_object('saved',true,'domain',v_domain,'wordbookEntryId',w.wordbook_entry_id);
end;
$$;
revoke all on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb) to service_role;
do $$
begin
  if has_function_privilege('anon','public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','EXECUTE') then
    raise exception 'WORDBOOK_EFFECTIVE_FUNCTION_PRIVILEGE_UNSAFE';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
select 'WORDBOOK_A2_RPC_OK' as result;
