-- TPS mixed Assignment batch - READ-ONLY VERIFY
-- Run in the Supabase SQL Editor AFTER supabase/category_assignment_mixed_batch_20261115.sql.
-- Executing this file performs no writes.

begin transaction read only;

-- 1. Both create overloads and the edit RPC carry the mixed support and remain
--    service-role-only security definers.
select
  'create_rpc' as check_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_execute,
  pg_get_functiondef(p.oid) like '%bas_category%'
    and pg_get_functiondef(p.oid) like '%category_assignment_answer_snapshots%' as mixed_support
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'create_writing_assignment_group'
order by pg_get_function_identity_arguments(p.oid);

select
  'group_edit_rpc' as check_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_execute,
  pg_get_functiondef(p.oid) like '%rap_category%'
    and pg_get_functiondef(p.oid) like '%category_assignment_answer_snapshots%' as mixed_support
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'update_withdrawn_writing_assignment_group';

-- 2. V5 category-only RPCs are untouched and still available.
select
  'v5_category_rpcs_still_present' as check_name,
  to_regprocedure('public.create_category_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)') is not null
    and to_regprocedure('public.update_withdrawn_category_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)') is not null as ok;

-- 3. Stored category snapshots never carry answers, and every visible category
--    Assignment still has its service-only answer snapshot.
select
  'snapshot_answers_leak' as check_name,
  count(*) as rows,
  count(*) = 0 as ok
from public.writing_assignments
where task_type in ('bas_category', 'rap_category')
  and question_snapshot ? 'answers';

select
  'category_answer_snapshot_coverage' as check_name,
  count(*) as visible_category_assignments,
  count(snapshot.assignment_id) as with_snapshot,
  count(*) = count(snapshot.assignment_id) as ok
from public.writing_assignments assignment
left join public.category_assignment_answer_snapshots snapshot
  on snapshot.assignment_id = assignment.assignment_id
where assignment.task_type in ('bas_category', 'rap_category')
  and assignment.deleted_at is null;

-- 4. The switch is still off after the migration.
select
  'enforcement_enabled' as check_name,
  enforcement_enabled as value,
  enforcement_enabled = false as ok
from public.practice_entitlement_runtime_config
where singleton = true;

-- 5. No new Assignment Group / recipient row shape was introduced.
select
  'mixed_groups_present' as check_name,
  count(*) as groups
from (
  select group_id
  from public.writing_assignments
  where group_id is not null
    and deleted_at is null
  group by group_id
  having bool_or(task_type in ('bas_category', 'rap_category'))
     and bool_or(task_type not in ('bas_category', 'rap_category'))
) mixed;

commit;
