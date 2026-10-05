-- TPS｜班级科目更新 RPC 修复：class_row 变量与表别名冲突（SQLSTATE 42702）
--
-- 现象
--   教师端班级列表科目的 ×、班级详情「修改授课科目」保存时统一返回
--   500「保存失败，请稍后重试。」；服务端日志为
--   [teacher-classes] update_class_subjects_failed
--   column reference "class_row.teacher_id" is ambiguous。
--
-- 根因
--   public.update_class_subjects 内 declare 了
--     class_row public.teacher_classes%rowtype;
--   而成员绑定回填子查询又把 teacher_classes 的表别名也写成 class_row:
--     select class_row.teacher_id from public.teacher_classes class_row ...
--   默认 plpgsql.variable_conflict = error 下该引用歧义，RPC 抛错整体回滚，
--   因此班级科目添加 / 取消都会失败；单学生 binding API 不受影响。
--
-- 修复
--   仅把该表别名改名为 owner_class，函数语义完全不变：
--   * 只更新 teacher_classes.subjects；
--   * 仅为新科目补齐缺失的 teacher_student_bindings；
--   * 不删除任何已有 teacher_student_bindings；
--   * p_remove_writing 仅为签名兼容保留，恒不释放学生 binding。
--
-- 适用
--   已执行过 teacher_class_multi_teacher_binding_20261003.sql 的数据库。
--   全新环境直接执行已修复的该迁移文件即可，无需再执行本文件。
--   本文件为 create or replace 同名同签名，可安全重复执行。
--
-- 执行方式：Supabase SQL Editor 整段运行。

begin;

-- Updates the class subjects and keeps member bindings consistent:
--   * every member gains the bindings the new subjects require, for every
--     teacher of the class;
--   * class subject changes NEVER release a member's existing binding. The
--     legacy p_remove_writing parameter is kept only for signature
--     compatibility and has no effect; removed_writing_count is always 0.
create or replace function public.update_class_subjects(
  p_teacher_id uuid,
  p_class_id uuid,
  p_subjects text[],
  p_remove_writing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_row public.teacher_classes%rowtype;
  removed_writing_count integer := 0;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  if array_length(coalesce(p_subjects, array[]::text[]), 1) is null
    or not (coalesce(p_subjects, array[]::text[]) <@ array['reading', 'writing']::text[])
    or array_position(p_subjects, null) is not null then
    raise exception 'INVALID_SUBJECTS';
  end if;

  select * into class_row
  from public.teacher_classes
  where class_id = p_class_id
    and public.is_class_teacher(p_class_id, p_teacher_id)
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  update public.teacher_classes
  set subjects = p_subjects
  where class_id = p_class_id;

  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select class_teacher.teacher_id, member.student_id, subject.domain
  from public.class_members member
  join public.profiles student
    on student.id = member.student_id
   and student.role = 'student'
   and student.is_active = true
  cross join unnest(p_subjects) as subject(domain)
  cross join (
    select class_teacher_ids.teacher_id
    from (
      -- The table alias must not be named class_row: that name is already the
      -- plpgsql record variable loaded above, and the default
      -- plpgsql.variable_conflict=error makes "class_row.teacher_id" ambiguous
      -- (SQLSTATE 42702), aborting the whole RPC.
      select owner_class.teacher_id
      from public.teacher_classes owner_class
      where owner_class.class_id = p_class_id
      union
      select link.teacher_id
      from public.teacher_class_bindings link
      where link.class_id = p_class_id
    ) class_teacher_ids
    join public.profiles teacher
      on teacher.id = class_teacher_ids.teacher_id
     and teacher.role = 'teacher'
     and teacher.is_active = true
  ) class_teacher
  where member.class_id = p_class_id
  on conflict (teacher_id, student_id, domain) do nothing;

  return jsonb_build_object(
    'class_id', p_class_id,
    'subjects', to_jsonb(p_subjects),
    'removed_writing_count', removed_writing_count
  );
end;
$$;

revoke all on function public.update_class_subjects(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.update_class_subjects(uuid, uuid, text[], boolean) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- 验证（只读，执行修复后可选）
-- ---------------------------------------------------------------------------
--
-- select pg_get_functiondef(p.oid)
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname = 'update_class_subjects';
--
-- 确认定义中已无 "from public.teacher_classes class_row"，
-- 且回填子查询使用 owner_class。
