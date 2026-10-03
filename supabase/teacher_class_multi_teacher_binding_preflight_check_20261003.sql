-- TPS｜班级多教师绑定迁移：生产函数签名预检（只读）
--
-- 用途
--   在执行 supabase/teacher_class_multi_teacher_binding_20261003.sql 之前，
--   先核对生产库现有函数签名，确认 CREATE OR REPLACE 会替换预期签名、
--   不会意外新增重载，也不会让旧版重载残留。
--
-- 安全说明
--   * 本文件完全只读：只有 SELECT / WITH 查询，不含任何 DDL/DML。
--   * 不包含 DROP，也不会自动修复任何签名差异。
--   * 不依赖新迁移，可在迁移执行前直接运行。
--   * 建议在 Supabase SQL Editor 中按 QUERY 1..6 逐条执行。
--   * 若 QUERY 4 / 5 / 6 出现 MISSING / UNEXPECTED / MISMATCH / LEGACY，
--     请先报告结果，不要直接执行迁移或 DROP。
--
-- 迁移预计涉及的对象（对照表见 QUERY 3）
--   CREATE（本次新增） : is_class_teacher, bind_teacher_to_class
--   REPLACE（同名同签名）: sync_class_members, update_class_subjects,
--                         remove_class_member, create_writing_assignment_group(7参),
--                         update_withdrawn_writing_assignment_group
--   KEEP（不得改动）    : create_writing_assignment_group(6参，学生模式)

-- ===========================================================================
-- QUERY 1｜七个函数的全部重载（参数名、类型、顺序、默认参数数量、返回类型）
-- ===========================================================================

select
  n.nspname                                  as schema_name,
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as parameter_names_and_types,
  pg_get_function_arguments(p.oid)           as arguments_with_defaults,
  p.pronargdefaults                          as default_argument_count,
  pg_get_function_result(p.oid)              as return_type,
  case p.provolatile
    when 'i' then 'IMMUTABLE'
    when 's' then 'STABLE'
    else 'VOLATILE'
  end                                        as volatility,
  p.prosecdef                                as security_definer,
  pg_get_userbyid(p.proowner)                as owner_role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in (
    'is_class_teacher',
    'bind_teacher_to_class',
    'sync_class_members',
    'update_class_subjects',
    'remove_class_member',
    'create_writing_assignment_group',
    'update_withdrawn_writing_assignment_group'
  )
order by p.proname, p.pronargs, parameter_names_and_types;

-- ===========================================================================
-- QUERY 2｜上述函数的完整定义（pg_get_functiondef）
-- ===========================================================================

select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as signature,
  pg_get_functiondef(p.oid)                 as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in (
    'is_class_teacher',
    'bind_teacher_to_class',
    'sync_class_members',
    'update_class_subjects',
    'remove_class_member',
    'create_writing_assignment_group',
    'update_withdrawn_writing_assignment_group'
  )
order by p.proname, p.pronargs;

-- ===========================================================================
-- QUERY 3｜新迁移预计覆盖/新增的函数签名对照表
-- ===========================================================================

select *
from (
  values
    (
      'is_class_teacher',
      'p_class_id uuid, p_teacher_id uuid',
      'CREATE：本次迁移新增（拥有者或已绑定教师的授权辅助函数）'
    ),
    (
      'bind_teacher_to_class',
      'p_teacher_id uuid, p_class_id uuid',
      'CREATE：本次迁移新增（幂等绑定班级并补齐成员绑定）'
    ),
    (
      'sync_class_members',
      'p_teacher_id uuid, p_class_id uuid, p_student_ids uuid[]',
      'REPLACE：同名同签名整体替换（成员绑定补齐改为覆盖班级全部教师）'
    ),
    (
      'update_class_subjects',
      'p_teacher_id uuid, p_class_id uuid, p_subjects text[], p_remove_writing boolean',
      'REPLACE：同名同签名整体替换；不再删除任何 teacher_student_bindings'
    ),
    (
      'remove_class_member',
      'p_teacher_id uuid, p_class_id uuid, p_student_id uuid, p_remove_writing boolean',
      'REPLACE：同名同签名整体替换；不再删除任何 teacher_student_bindings'
    ),
    (
      'create_writing_assignment_group',
      'p_teacher_id uuid, p_assignments jsonb, p_student_ids uuid[], p_title text, p_title_is_automatic boolean, p_subject text',
      'KEEP：subject-aware 学生模式，历史重载必须保留，迁移不修改'
    ),
    (
      'create_writing_assignment_group',
      'p_teacher_id uuid, p_assignments jsonb, p_student_ids uuid[], p_title text, p_title_is_automatic boolean, p_subject text, p_class_id uuid',
      'REPLACE：subject-aware 班级模式，本次迁移整体替换'
    ),
    (
      'update_withdrawn_writing_assignment_group',
      'p_teacher_id uuid, p_group_id uuid, p_legacy_assignment_id uuid, p_title text, p_items jsonb, p_student_ids uuid[], p_due_at timestamp with time zone, p_reactivate boolean, p_class_id uuid',
      'REPLACE：整体替换；生产实际签名必须与这一行完全一致，否则迁移会产生新重载'
    )
) as expected(function_name, expected_signature, migration_action);

-- ===========================================================================
-- QUERY 4｜偏差检查：生产实际签名 vs 迁移预期签名
--   输出中仅需关注 MISSING / UNEXPECTED 行；PRESENT 表示符合预期。
-- ===========================================================================

with target_functions(function_name) as (
  values
    ('is_class_teacher'),
    ('bind_teacher_to_class'),
    ('sync_class_members'),
    ('update_class_subjects'),
    ('remove_class_member'),
    ('create_writing_assignment_group'),
    ('update_withdrawn_writing_assignment_group')
),
actual as (
  select
    p.proname::text                           as function_name,
    p.proargnames                             as argument_names,
    p.proargtypes                             as argument_types,
    pg_get_function_identity_arguments(p.oid) as identity_arguments
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname::text in (select function_name from target_functions)
),
expected(function_name, argument_names, type_names) as (
  values
    ('is_class_teacher', array['p_class_id', 'p_teacher_id'], array['uuid', 'uuid']),
    ('bind_teacher_to_class', array['p_teacher_id', 'p_class_id'], array['uuid', 'uuid']),
    (
      'sync_class_members',
      array['p_teacher_id', 'p_class_id', 'p_student_ids'],
      array['uuid', 'uuid', 'uuid[]']
    ),
    (
      'update_class_subjects',
      array['p_teacher_id', 'p_class_id', 'p_subjects', 'p_remove_writing'],
      array['uuid', 'uuid', 'text[]', 'boolean']
    ),
    (
      'remove_class_member',
      array['p_teacher_id', 'p_class_id', 'p_student_id', 'p_remove_writing'],
      array['uuid', 'uuid', 'uuid', 'boolean']
    ),
    (
      'create_writing_assignment_group',
      array['p_teacher_id', 'p_assignments', 'p_student_ids', 'p_title', 'p_title_is_automatic', 'p_subject'],
      array['uuid', 'jsonb', 'uuid[]', 'text', 'boolean', 'text']
    ),
    (
      'create_writing_assignment_group',
      array['p_teacher_id', 'p_assignments', 'p_student_ids', 'p_title', 'p_title_is_automatic', 'p_subject', 'p_class_id'],
      array['uuid', 'jsonb', 'uuid[]', 'text', 'boolean', 'text', 'uuid']
    ),
    (
      'update_withdrawn_writing_assignment_group',
      array['p_teacher_id', 'p_group_id', 'p_legacy_assignment_id', 'p_title', 'p_items', 'p_student_ids', 'p_due_at', 'p_reactivate', 'p_class_id'],
      array['uuid', 'uuid', 'uuid', 'text', 'jsonb', 'uuid[]', 'timestamptz', 'boolean', 'uuid']
    )
),
expected_typed as (
  select
    e.function_name,
    e.argument_names,
    array_to_string(
      array(select t::regtype::oid::text from unnest(e.type_names) as u(t)),
      ' '
    )::oidvector as argument_types
  from expected e
)
select
  coalesce(a.function_name, e.function_name) as function_name,
  coalesce(a.identity_arguments, array_to_string(e.argument_names, ', ')) as signature,
  case
    when a.function_name is null then 'MISSING：迁移将创建该签名'
    when e.function_name is null then 'UNEXPECTED：生产存在预期外的重载，先报告再决定是否 DROP'
    else 'PRESENT：签名符合预期（迁移将整体替换）'
  end as status
from actual a
full join expected_typed e
  on e.function_name = a.function_name
 and e.argument_names = a.argument_names
 and e.argument_types = a.argument_types
order by function_name, status;

-- ===========================================================================
-- QUERY 5｜create_writing_assignment_group 历史重载兼容检查
--   历史迁移已 DROP 旧 5 参版本和旧 6 参（以 p_class_id 结尾）版本；
--   这里确认它们没有残留，并确认当前两个 subject-aware 重载存在。
-- ===========================================================================

select
  pg_get_function_identity_arguments(p.oid) as signature,
  p.pronargs                                as argument_count,
  case
    when p.pronargs = 5
      then 'LEGACY：旧 5 参版本（应已被历史迁移 DROP；若存在请先报告）'
    when p.pronargs = 6 and p.proargnames[6] = 'p_subject'
      then 'OK：subject-aware 学生模式（迁移保留，不修改）'
    when p.pronargs = 6 and p.proargnames[6] = 'p_class_id'
      then 'LEGACY：旧 6 参 class 版本（应已被历史迁移 DROP；若存在请先报告）'
    when p.pronargs = 7 and p.proargnames[7] = 'p_class_id'
      then 'OK：subject-aware 班级模式（本次迁移整体替换）'
    else 'UNEXPECTED：未知重载（请先报告）'
  end                                       as classification,
  p.pronargdefaults                         as default_argument_count,
  pg_get_function_result(p.oid)             as return_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname = 'create_writing_assignment_group'
order by p.pronargs, signature;

-- 汇总：应恰好为 2 个重载（6 参学生模式 + 7 参班级模式）。
select
  count(*) as overload_count,
  count(*) filter (where p.pronargs = 6 and p.proargnames[6] = 'p_subject') as student_mode_count,
  count(*) filter (where p.pronargs = 7 and p.proargnames[7] = 'p_class_id') as class_mode_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname = 'create_writing_assignment_group';

-- ===========================================================================
-- QUERY 6｜update_withdrawn_writing_assignment_group 实际签名核对
--   迁移使用 CREATE OR REPLACE（不带 DROP）。只有生产签名与 MATCH 行完全
--   一致时才会替换旧函数；MISMATCH 表示会新增重载且旧函数继续存在。
-- ===========================================================================

select
  pg_get_function_identity_arguments(p.oid) as actual_signature,
  p.pronargs                                as argument_count,
  p.pronargdefaults                         as default_argument_count,
  pg_get_function_arguments(p.oid)          as arguments_with_defaults,
  pg_get_function_result(p.oid)             as return_type,
  case
    when pg_get_function_identity_arguments(p.oid) =
      'p_teacher_id uuid, p_group_id uuid, p_legacy_assignment_id uuid, p_title text, p_items jsonb, p_student_ids uuid[], p_due_at timestamp with time zone, p_reactivate boolean, p_class_id uuid'
      then 'MATCH：迁移的 CREATE OR REPLACE 将替换这个精确签名'
      else 'MISMATCH：迁移会创建新重载、旧函数将保留；先报告，不要执行迁移'
  end                                       as migration_impact
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname = 'update_withdrawn_writing_assignment_group'
order by p.pronargs;

-- ===========================================================================
-- 结果处理建议（只读检查，不自动修复）
--   * QUERY 4 全部 PRESENT、QUERY 5 全部 OK 且汇总为 2、QUERY 6 为 MATCH
--     -> 可以执行迁移。
--   * 出现 MISSING -> 正常（is_class_teacher / bind_teacher_to_class 属于新增）。
--   * 出现 UNEXPECTED / LEGACY / MISMATCH -> 先报告，确认是否需要 DROP 或
--     调整迁移签名，不要直接执行迁移或 DROP。
-- ===========================================================================
