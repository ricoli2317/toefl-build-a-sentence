-- Manual incremental data fix AFTER the reviewed Phase 3 spelling patch.
-- DO NOT rerun/rewrite the previously executed migration or reimport words.
-- Only life.irregular_forms changes. New rounds teach/test the same DB set;
-- existing attempts and already-started session snapshots are not rewritten.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';
do $$
declare v_entry uuid; v_forms jsonb; v_other_fields jsonb;
begin
  select e.entry_id,e.irregular_forms,to_jsonb(e)-'irregular_forms'
    into v_entry,v_forms,v_other_fields from public.ctw_vocabulary_entries e
    where e.word='life' for update;
  if not found then raise exception 'CTW_LIFE_ENTRY_REQUIRED'; end if;
  if v_forms<>'[{"form_type":"plural","answers":["lives"]}]'::jsonb and v_forms<>'[]'::jsonb then
    raise exception 'CTW_LIFE_FORM_DRIFT';
  end if;
  update public.ctw_vocabulary_entries e set irregular_forms='[]'::jsonb
    where e.entry_id=v_entry and e.irregular_forms<>'[]'::jsonb;
  if v_other_fields is distinct from (select to_jsonb(e)-'irregular_forms' from public.ctw_vocabulary_entries e where e.entry_id=v_entry) then
    raise exception 'CTW_LIFE_UNRELATED_FIELD_CHANGED';
  end if;
end $$;
commit;
