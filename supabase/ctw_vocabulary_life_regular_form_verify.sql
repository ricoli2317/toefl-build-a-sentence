-- Read-only verification. No session/attempt mutation or regrading.
begin;
set transaction read only;
do $$ begin
  if (select irregular_forms from public.ctw_vocabulary_entries where word='life') is distinct from '[]'::jsonb
    then raise exception 'CTW_LIFE_REGULAR_FORM_FIX_REQUIRED'; end if;
  -- The user reaffirmed that multiple variants remain tested together.
  if (select irregular_forms from public.ctw_vocabulary_entries where word='burn') is distinct from
    '[{"form_type":"past","answers":["burnt","burned"]},{"form_type":"past_participle","answers":["burnt","burned"]}]'::jsonb
    or (select irregular_forms from public.ctw_vocabulary_entries where word='learn') is distinct from
    '[{"form_type":"past","answers":["learnt","learned"]},{"form_type":"past_participle","answers":["learnt","learned"]}]'::jsonb
    then raise exception 'CTW_MULTI_VARIANT_FORMS_DRIFT'; end if;
end $$;
select 'CTW_LIFE_REGULAR_FORM_VERIFY_OK' status;
commit;
