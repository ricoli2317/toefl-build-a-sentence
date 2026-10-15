-- Read-only. Does not regrade or rewrite historical tests.
begin;
set transaction read only;
do $$ begin
  if (select irregular_forms from public.ctw_vocabulary_entries where word='get') is distinct from
    '[{"form_type":"past","answers":["got"]},{"form_type":"past_participle","answers":["got","gotten"]}]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='craftsperson') is distinct from '[{"form_type":"plural","answers":["craftspeople"]}]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='millennium') is distinct from '[{"form_type":"plural","answers":["millennia"]}]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='leaf') is distinct from '[]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='burn') is distinct from '[{"form_type":"past","answers":["burnt","burned"]},{"form_type":"past_participle","answers":["burnt","burned"]}]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='learn') is distinct from '[{"form_type":"past","answers":["learnt","learned"]},{"form_type":"past_participle","answers":["learnt","learned"]}]'::jsonb
    then raise exception 'CTW_AMERICAN_SPELLING_PATCH_REQUIRED'; end if;
end $$;
select 'CTW_AMERICAN_SPELLING_VERIFY_OK' status;
commit;
