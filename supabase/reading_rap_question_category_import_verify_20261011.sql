-- READ ONLY. Run AFTER reading_rap_question_category_import_20261011.sql.
-- All checks must be true and verification_status must be PASS.
-- Reads only catalog metadata/function source; never imports or changes data.

with rpc as (
  select p.oid, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) as definition
  from pg_proc p
  where p.oid = to_regprocedure('public.import_reading_package_atomic(jsonb,uuid)')
), question_write as (
  select *, substring(definition from
    'insert into public\.reading_questions \([\s\S]*?on conflict \(question_id\) do update set[\s\S]*?;') as statement
  from rpc
), checks as (
  select
    exists (select 1 from rpc) as rpc_exists,
    exists (
      select 1 from pg_attribute
      where attrelid = to_regclass('public.reading_questions')
        and attname = 'question_category' and not attisdropped
        and atttypid = 'text'::regtype
    ) as existing_column_present,
    coalesce((select statement like '%question_type, question_category, stem,%' from question_write), false) as insert_column_present,
    coalesce((select statement like '%question_type text, question_category text, stem text,%' from question_write), false) as recordset_field_present,
    coalesce((select statement like '%case when module = ''rap'' then question_category else null end, stem,%' from question_write), false) as rap_only_select_value_present,
    coalesce((select split_part(statement, 'on conflict (question_id) do update set', 2) !~ '\mquestion_category\M' from question_write), false) as existing_category_not_updated,
    coalesce((select prosecdef and 'search_path=public' = any(proconfig) from rpc), false) as security_settings_present,
    coalesce((select has_function_privilege('service_role', oid, 'EXECUTE')
      and not has_function_privilege('anon', oid, 'EXECUTE')
      and not has_function_privilege('authenticated', oid, 'EXECUTE') from rpc), false) as original_execute_permissions_present
)
select *, case when rpc_exists and existing_column_present and insert_column_present
    and recordset_field_present and rap_only_select_value_present
    and existing_category_not_updated and security_settings_present
    and original_execute_permissions_present
  then 'PASS' else 'FAIL: inspect RPC; do not import new RAP questions yet' end as verification_status
from checks;
