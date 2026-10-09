-- USER-MANUAL read-only metadata verification; NOT pool approval/installation.
begin transaction read only;
do $check$
declare audit jsonb; f record;
begin
 select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
 if audit is null then raise exception 'REVIEW_PREFERENCE_AUDIT_REQUIRED'; end if;
 for f in select * from (values
  ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','5c1eef05c08c227b7b2b1fcccba9a0cc'),
  ('public.wordbook_review_meaning_conflict(text,text)','eb381c598b43005e5dc5ad7dd583ff34'),
  ('public.wordbook_review_preference_rank(jsonb,jsonb,text)','de07b8985b0c20bc6ecf623048c98885')
 ) expected(signature,hash) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
   and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
   or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then raise exception 'REVIEW_PREFERENCE_DEFINITION_DRIFT'; end if;
 end loop;
 for f in select key signature,value #>> '{}' hash from jsonb_each(audit) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
   and proconfig=array['search_path=pg_catalog']::text[] and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
   or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
   or not has_function_privilege('service_role',f.signature,'EXECUTE') then raise exception 'REVIEW_PREFERENCE_ACL_AUDIT_DRIFT'; end if;
 end loop;
 if (select count(*) from pg_attribute where attrelid='public.wordbook_review_fixed_distractors'::regclass
   and attname in('lexical_category','subject','noun_kind') and not attisdropped)<>3
  or not exists(select 1 from pg_class where oid='public.wordbook_review_fixed_distractors'::regclass and relrowsecurity)
  or has_table_privilege('authenticated','public.wordbook_review_fixed_distractors','SELECT')
  or has_table_privilege('anon','public.wordbook_review_fixed_distractors','SELECT')
  or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','UPDATE') then raise exception 'REVIEW_PREFERENCE_TABLE_DRIFT'; end if;
 if exists(select 1 from pg_proc where proname='wordbook_review_candidates' and strpos(prosrc,'lexical_occurrences')>0)
  or not public.wordbook_review_meaning_conflict('限制','抑制') then raise exception 'REVIEW_PREFERENCE_PATH_CONFLICT_DRIFT'; end if;
end;
$check$;
select 'WORDBOOK_CHOICE_PREFERENCE_VERIFY_OK' as result;
commit;
