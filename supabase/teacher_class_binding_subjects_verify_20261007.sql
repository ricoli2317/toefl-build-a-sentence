-- TPS｜班级绑定「教师 × 班级 × 科目」修复：只读验证 SQL
--
-- 对应迁移：supabase/teacher_class_binding_subjects_20261007.sql
--
-- 用途
--   在迁移执行后核对兼容滚动部署状态：
--     1. subjects 列与取值约束就位；
--     2. bind_teacher_to_class 的 2 参兼容层与 3 参正式实现同时存在，
--        且 2 参兼容层只转交 3 参、没有独立写入；
--     3. 其余班级 RPC 签名完整（含作业学生模式重载未被破坏）；
--     4. 每位教师自己的科目已合法回填，抽查没有跨教师回填。
--
-- 安全说明
--   * 本文件完全只读：只有 SELECT / WITH 查询，不含任何写操作或结构变更。
--   * 可重复执行，不依赖应用代码，可在生产库 SQL Editor 直接运行。
--   * QUERY 1 是部署门槛：所有行都应为 OK；出现 MISSING / MISMATCH
--     请先停下检查，不要继续后续操作。
--
-- 使用方法
--   在 Supabase SQL Editor 中把下方 QUERY 1..4 分别执行（也可以整段执行）。
--   * QUERY 1 是部署门槛，必须单独确认全部 OK 后再继续；
--   * QUERY 4 未替换 <CLASS_ID> 时返回 0 行，不会报错；
--   * 如果编辑器只显示最后一段结果，请逐段运行。

-- ===========================================================================
-- QUERY 1｜部署门槛（预期全部 OK）
-- ===========================================================================

with checks as (
  select
    'teacher_class_bindings.subjects 列存在且 NOT NULL'::text as check_name,
    case when exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_class_bindings'
        and column_name = 'subjects'
        and is_nullable = 'NO'
    ) then 'OK' else 'MISSING' end as status

  union all
  select
    'subjects 取值约束存在（1..2 个 reading/writing）',
    case when exists (
      select 1
      from pg_constraint
      where conrelid = 'public.teacher_class_bindings'::regclass
        and conname = 'teacher_class_bindings_subjects_check'
    ) then 'OK' else 'MISSING' end

  union all
  select
    'bind_teacher_to_class(uuid, uuid) 旧 2 参兼容层存在',
    case when to_regprocedure('public.bind_teacher_to_class(uuid,uuid)') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'bind_teacher_to_class(uuid, uuid, text[]) 新 3 参实现存在',
    case when to_regprocedure('public.bind_teacher_to_class(uuid,uuid,text[])') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'bind_teacher_to_class 恰好两个重载（无多余版本）',
    case when (
      select count(*)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'bind_teacher_to_class'
    ) = 2 then 'OK' else 'MISMATCH' end

  union all
  select
    '2 参兼容层只转交 3 参、无独立写入',
    case when exists (
      select 1
      from pg_proc p
      where p.oid = to_regprocedure('public.bind_teacher_to_class(uuid,uuid)')
        and pg_get_functiondef(p.oid)
          like '%bind_teacher_to_class(p_teacher_id, p_class_id, class_subjects)%'
        and pg_get_functiondef(p.oid)
          not like '%into public.teacher_student_bindings%'
        and pg_get_functiondef(p.oid)
          not like '%into public.teacher_class_bindings%'
    ) then 'OK' else 'MISSING' end

  union all
  select
    'is_class_teacher(uuid, uuid) 签名存在',
    case when to_regprocedure('public.is_class_teacher(uuid,uuid)') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'sync_class_members(uuid, uuid, uuid[]) 签名存在',
    case when to_regprocedure('public.sync_class_members(uuid,uuid,uuid[])') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'update_class_subjects(uuid, uuid, text[], boolean) 签名存在',
    case when to_regprocedure('public.update_class_subjects(uuid,uuid,text[],boolean)') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'remove_class_member(uuid, uuid, uuid, boolean) 签名存在',
    case when to_regprocedure('public.remove_class_member(uuid,uuid,uuid,boolean)') is not null
      then 'OK' else 'MISSING' end

  union all
  select
    'create_writing_assignment_group 班级模式 7 参签名存在',
    case when to_regprocedure(
      'public.create_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)'
    ) is not null then 'OK' else 'MISSING' end

  union all
  select
    'create_writing_assignment_group 学生模式 6 参签名未被破坏',
    case when to_regprocedure(
      'public.create_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text)'
    ) is not null then 'OK' else 'MISSING' end

  union all
  select
    'update_withdrawn_writing_assignment_group 签名存在',
    case when to_regprocedure(
      'public.update_withdrawn_writing_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)'
    ) is not null then 'OK' else 'MISSING' end

  union all
  select
    '全部 link 的科目已回填且取值合法',
    case when not exists (
      select 1
      from public.teacher_class_bindings link
      where link.subjects is null
        or coalesce(array_length(link.subjects, 1), 0) not between 1 and 2
        or not (link.subjects <@ array['reading','writing']::text[])
    ) then 'OK' else 'MISMATCH' end
)
select check_name, status
from checks
order by case when status = 'OK' then 1 else 0 end, check_name;

-- ===========================================================================
-- QUERY 2｜班级 RPC 签名清单
--   预期：
--     bind_teacher_to_class      两行（3 参正式实现 + 2 参兼容层）
--     create_writing_assignment_group 两行（6 参学生模式 + 7 参班级模式）
--     其余各一行
-- ===========================================================================

select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as signature,
  pg_get_function_result(p.oid)             as return_type,
  p.prosecdef                               as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'is_class_teacher',
    'bind_teacher_to_class',
    'sync_class_members',
    'update_class_subjects',
    'remove_class_member',
    'create_writing_assignment_group',
    'update_withdrawn_writing_assignment_group'
  )
order by p.proname, signature;

-- ===========================================================================
-- QUERY 3｜每个班级的教师科目对照（抽查，最多 50 行）
--   注意：本段只列出 teacher_class_bindings 里的“已绑定教师”，班级 owner
--   不在其中（owner 科目只出现在 owner_subjects 列作为对照；
--   owner + 绑定教师的完整明细请用 QUERY 4）。
--   关注：
--     * teacher_subjects 是该教师自己的科目集合（1..2 个 reading/writing）；
--     * owner_subjects 是班级行（owner 自己的集合）；
--     * 不同教师的行互相独立，不存在“给全员补班级科目”的痕迹；
--     * held_rows_for_teacher_subjects 为该教师在该班成员上的实际绑定行数。
-- ===========================================================================

select
  link.class_id,
  class_row.name                 as class_name,
  link.teacher_id,
  teacher.full_name              as teacher_name,
  link.subjects                  as teacher_subjects,
  class_row.subjects             as owner_subjects,
  class_row.teacher_id = link.teacher_id as is_owner_link,
  (select count(*)
     from public.class_members member
    where member.class_id = link.class_id) as member_count,
  (select count(*)
     from public.teacher_student_bindings binding
    where binding.teacher_id = link.teacher_id
      and binding.domain = any(link.subjects)
      and binding.student_id in (
        select member.student_id
        from public.class_members member
        where member.class_id = link.class_id
      )) as held_rows_for_teacher_subjects
from public.teacher_class_bindings link
join public.teacher_classes class_row on class_row.class_id = link.class_id
left join public.profiles teacher on teacher.id = link.teacher_id
order by link.created_at desc
limit 50;

-- ===========================================================================
-- QUERY 4｜单个班级明细（用于 0417 场景复核）
--   把下方 target 里的 <CLASS_ID> 换成需要复核的班级 id 后执行；
--   未替换时本段返回 0 行（不会报错，可直接整段运行）。
--   预期：
--     * owner 一行：teacher_subjects = owner_subjects（班级行科目）；
--     * 每位已绑定教师一行：teacher_subjects 是该教师自己的科目，
--       不会因为其他教师绑了别的科目而变化。
-- ===========================================================================

with target as (
  select '<CLASS_ID>'::text as class_id_text
)
select spot.class_id,
       spot.member_role,
       spot.teacher_id,
       spot.teacher_name,
       spot.teacher_subjects,
       spot.owner_subjects
from (
  select
    'owner'::text as member_role,
    owner_row.class_id as class_id,
    owner_row.teacher_id as teacher_id,
    owner_profile.full_name as teacher_name,
    owner_row.subjects as teacher_subjects,
    owner_row.subjects as owner_subjects
  from public.teacher_classes owner_row
  left join public.profiles owner_profile on owner_profile.id = owner_row.teacher_id
  where owner_row.class_id::text = (select class_id_text from target)

  union all

  select
    'linked',
    link.class_id,
    link.teacher_id,
    linked_profile.full_name,
    link.subjects,
    owner_row.subjects
  from public.teacher_class_bindings link
  join public.teacher_classes owner_row on owner_row.class_id = link.class_id
  left join public.profiles linked_profile on linked_profile.id = link.teacher_id
  where link.class_id::text = (select class_id_text from target)
) spot
order by spot.member_role, spot.teacher_name;
