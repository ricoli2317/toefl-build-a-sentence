-- TPS mixed Assignment batch - READ-ONLY PREFLIGHT
-- Run in the Supabase SQL Editor BEFORE supabase/category_assignment_mixed_batch_20261115.sql.
-- Executing this file performs no writes.

begin transaction read only;

-- 1. Required V5 artifacts.
select
  'v5_answer_snapshot_table' as check_name,
  to_regclass('public.category_assignment_answer_snapshots') is not null as ok
union all
select
  'v5_manifest_validator',
  to_regprocedure('public.validate_category_assignment_manifest(text,jsonb)') is not null
union all
select
  'v5_category_create_rpc',
  to_regprocedure('public.create_category_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)') is not null
union all
select
  'v5_category_edit_rpc',
  to_regprocedure('public.update_withdrawn_category_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)') is not null
union all
select
  'mixed_student_create_rpc',
  to_regprocedure('public.create_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text)') is not null
union all
select
  'mixed_class_create_rpc',
  to_regprocedure('public.create_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)') is not null
union all
select
  'mixed_group_edit_rpc',
  to_regprocedure('public.update_withdrawn_writing_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)') is not null;

-- 2. Runtime switch must stay off; this migration never turns it on.
select
  'enforcement_enabled' as check_name,
  enforcement_enabled as value,
  enforcement_enabled = false as ok
from public.practice_entitlement_runtime_config
where singleton = true;

-- 3. Assignment type constraints already accept category types.
select
  'category_task_type_constraint' as check_name,
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.writing_assignments'::regclass
      and conname = 'writing_assignments_task_type_check'
      and pg_get_constraintdef(oid) like '%bas_category%'
      and pg_get_constraintdef(oid) like '%rap_category%'
  ) as ok;

-- 4. Answer maps are already service-only and never on the Assignment snapshot.
select
  'snapshot_answers_leak' as check_name,
  count(*) as rows,
  count(*) = 0 as ok
from public.writing_assignments
where task_type in ('bas_category', 'rap_category')
  and question_snapshot ? 'answers';

select
  'category_assignments' as check_name,
  count(*) as category_assignments,
  count(snapshot.assignment_id) as answer_snapshots
from public.writing_assignments assignment
left join public.category_assignment_answer_snapshots snapshot
  on snapshot.assignment_id = assignment.assignment_id
where assignment.task_type in ('bas_category', 'rap_category')
  and assignment.deleted_at is null;

-- 5. How many groups already mix a category item with normal items?
select
  'existing_mixed_groups' as check_name,
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

-- 6. Current function identities that the new migration replaces.
select
  'current_create_functions' as check_name,
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'create_writing_assignment_group'
order by pg_get_function_identity_arguments(p.oid);

select
  'current_group_edit_function' as check_name,
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'update_withdrawn_writing_assignment_group';

commit;
