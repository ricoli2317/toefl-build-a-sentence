-- TPS｜教师 × 班级 × 授课科目：绑定页科目选择修复（讨论中的 bug fix）
--
-- 线上现象
--   班级 0417 由阅读教师栗科创建（teacher_classes.subjects = {reading}）。
--   写作教师曾焱在「绑定班级」搜索到 0417 后，「授课科目」区域只显示
--   ✓ 阅读（班级授课科目），没有写作可选；且绑定按钮在已绑定后禁用，
--   同一班级无法再为另一位教师追加另一个科目。
--
-- 根因
--   多教师班级绑定迁移把 teacher_classes.subjects（班级/创建者的科目集合）
--   当成了每个绑定教师自己的科目集合：
--     * teacher_class_bindings 只有 (class_id, teacher_id)，没有科目维度；
--     * bind_teacher_to_class 只为调用者补齐“班级全部科目”，无法只绑定写作；
--     * sync_class_members / update_class_subjects 按班级科目给班级里每一个
--       教师回填 teacher_student_bindings，会给其他教师错误补出权限。
--
-- 修复层级（不改变权限来源，只补充“教师自己的科目”这一维）
--   * teacher_classes.subjects          = 班级创建者（owner）自己的授课科目；
--   * teacher_class_bindings.subjects   = 每位绑定教师自己的授课科目（新增列）；
--   * teacher_student_bindings          = 只按“该教师自己的科目”回填：
--     一个教师的绑定操作永远不会写入其他教师的 teacher_student_bindings。
--
-- 本文件修改
--   * 新增 teacher_class_bindings.subjects 列 + 约束 + 存量回填；
--   * bind_teacher_to_class(p_teacher_id, p_class_id, p_subjects)：3 参正式签名，
--     幂等；只补齐调用教师所选科目的成员绑定；
--   * 旧 2 参 bind_teacher_to_class(uuid, uuid) 保留为 compatibility wrapper：
--     无独立业务实现，只读取班级当前科目并转交 3 参实现，对旧前端保持
--     “按班级原有语义绑定调用者所需科目”的行为，且不会给其他教师补权限；
--     本文件不 DROP 任何函数（wrapper 待新代码线上稳定后另行清理）；
--   * sync_class_members：新增成员时按“每位教师自己的科目”补齐绑定；
--   * update_class_subjects：更新“调用教师自己的科目”（owner 更新班级科目），
--     只回填调用教师的成员绑定；
--   * create_writing_assignment_group /
--     update_withdrawn_writing_assignment_group：科目校验改用
--     “调用教师自己的科目集合”；
--   * 不删除任何 teacher_student_bindings，不重写班级成员与其他教师数据。
--
-- Unchanged rules kept intact:
--   * Removing a class subject or a member NEVER releases a historical
--     student-domain binding. update_class_subjects / remove_class_member keep
--     their legacy p_remove_writing parameter for signature compatibility,
--     but never delete bindings: removed_writing_count is always 0.
--   * A class never introduces a teacher-student relation from an arbitrary
--     student id: members must already be bound to the acting teacher, and
--     the acting teacher must be able to manage the class.
--
-- 执行顺序（无中断滚动，migration 先执行时旧 production 不受影响）
--   A. 先在 Supabase SQL Editor 中整段执行本文件（事务内）：旧前端的 2 参
--      RPC 由 compatibility wrapper 继续提供，行为与旧版一致；
--   B. 再 commit / push / deploy 新代码：新前端调用 3 参 RPC；
--   C. 线上确认稳定后，可另行用单独的清理迁移 DROP 2 参 wrapper（本轮不做）。
--   必须已执行 teacher_class_multi_teacher_binding_20261003.sql；本文件是它的
--   增量修复，包含其全部 RPC 的最终定义。
--
-- 可重复执行：IF NOT EXISTS + create or replace（含 2 参 wrapper 同签名替换）。
-- 整个迁移在一个事务内（BEGIN ... COMMIT）：任一语句失败则整体回滚。

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Teacher <-> Class sharing links
-- ---------------------------------------------------------------------------

create table if not exists public.teacher_class_bindings (
  class_id uuid not null
    references public.teacher_classes(class_id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (class_id, teacher_id)
);

create index if not exists teacher_class_bindings_teacher_idx
  on public.teacher_class_bindings(teacher_id, created_at desc);

-- Class sharing is configured only through the protected service-role APIs;
-- direct anon/authenticated access is denied by RLS with no client policies
-- (same rule as teacher_classes / teacher_student_bindings).
alter table public.teacher_class_bindings enable row level security;

revoke all on public.teacher_class_bindings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1b. 每位教师自己的授课科目（新增列，幂等）
-- ---------------------------------------------------------------------------

-- 一个 (class, teacher) 链接记录该教师在这个班级负责的科目；默认规则：
--   * 班级创建者的科目集合 = teacher_classes.subjects；
--   * 绑定教师的科目集合 = 本列 subjects；
--   * 绑定只读/只写调用者自己的行，绝不写其他教师。

alter table public.teacher_class_bindings
  add column if not exists subjects text[];

-- 存量回填：已绑定教师保留“班级现有科目 ∪ 该教师已经实际持有的成员科目”，
-- 没有任何线索时回退到阅读；只处理 subjects is null 的行，重复执行是 no-op。
update public.teacher_class_bindings link
set subjects = coalesce(
  (
    select array_agg(distinct domain order by domain)
    from (
      select unnest(coalesce(owner_class.subjects, array[]::text[])) as domain
      from public.teacher_classes owner_class
      where owner_class.class_id = link.class_id
      union all
      select binding.domain
      from public.teacher_student_bindings binding
      join public.class_members member
        on member.student_id = binding.student_id
       and member.class_id = link.class_id
      where binding.teacher_id = link.teacher_id
        and binding.domain in ('reading', 'writing')
    ) merged
    where domain in ('reading', 'writing')
  ),
  array['reading']::text[]
)
where link.subjects is null;

alter table public.teacher_class_bindings
  alter column subjects set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.teacher_class_bindings'::regclass
      and conname = 'teacher_class_bindings_subjects_check'
  ) then
    alter table public.teacher_class_bindings
      add constraint teacher_class_bindings_subjects_check
      check (
        coalesce(array_length(subjects, 1), 0) between 1 and 2
        and subjects <@ array['reading', 'writing']::text[]
        and array_position(subjects, null) is null
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Class authorization helper
-- ---------------------------------------------------------------------------

-- True when the teacher owns the class or holds a sharing link. Read-only and
-- service-role only; the RPCs below are security definer and run as the
-- function owner.
create or replace function public.is_class_teacher(p_class_id uuid, p_teacher_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_classes class_row
    where class_row.class_id = p_class_id
      and (
        class_row.teacher_id = p_teacher_id
        or exists (
          select 1
          from public.teacher_class_bindings link
          where link.class_id = p_class_id
            and link.teacher_id = p_teacher_id
        )
      )
  );
$$;

revoke all on function public.is_class_teacher(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.is_class_teacher(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Bind an existing class for one teacher (idempotent, subject-scoped)
-- ---------------------------------------------------------------------------

-- 正式实现：绑定调用教师所选的一个或多个科目。
--   * owner：追加到班级科目集合（= 创建者自己的科目），并为创建者补齐成员绑定；
--   * 绑定教师：写入/追加 teacher_class_bindings.subjects，并只补齐调用者的
--     成员绑定；
--   * 重复调用是 no-op（链接与绑定都走 conflict do nothing，科目取并集）；
--   * 其他教师的链接、科目、teacher_student_bindings 一律不写。
create or replace function public.bind_teacher_to_class(
  p_teacher_id uuid,
  p_class_id uuid,
  p_subjects text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_row public.teacher_classes%rowtype;
  effective_subjects text[];
  linked boolean := false;
  bindings_inserted integer := 0;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  -- 只接受非空、去重后 1..2 个 reading/writing 科目。
  if array_length(coalesce(p_subjects, array[]::text[]), 1) is null
    or not (coalesce(p_subjects, array[]::text[]) <@ array['reading', 'writing']::text[])
    or array_position(p_subjects, null) is not null then
    raise exception 'INVALID_SUBJECTS';
  end if;
  select array_agg(distinct domain order by domain)
    into effective_subjects
  from unnest(p_subjects) as provided(domain);
  if effective_subjects is null
    or array_length(effective_subjects, 1) < 1
    or array_length(effective_subjects, 1) > 2 then
    raise exception 'INVALID_SUBJECTS';
  end if;

  select * into class_row
  from public.teacher_classes
  where class_id = p_class_id
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  if class_row.teacher_id = p_teacher_id then
    -- 班级创建者：班级科目集合就是创建者自己的科目集合；追加本次科目。
    update public.teacher_classes
    set subjects = (
      select array_agg(distinct domain order by domain)
      from (
        select unnest(class_row.subjects) as domain
        union all
        select unnest(effective_subjects) as domain
      ) merged
      where domain in ('reading', 'writing')
    )
    where class_id = p_class_id
    returning subjects into effective_subjects;
  else
    if exists (
      select 1 from public.teacher_class_bindings
      where class_id = p_class_id and teacher_id = p_teacher_id
    ) then
      -- 已绑定的教师：科目取并集，重复提交同一科目不会重复创建。
      update public.teacher_class_bindings
      set subjects = (
        select array_agg(distinct domain order by domain)
        from (
          select unnest(subjects) as domain
          union all
          select unnest(effective_subjects) as domain
        ) merged
        where domain in ('reading', 'writing')
      )
      where class_id = p_class_id and teacher_id = p_teacher_id
      returning subjects into effective_subjects;
    else
      insert into public.teacher_class_bindings (class_id, teacher_id, subjects)
      values (p_class_id, p_teacher_id, effective_subjects);
      linked := true;
    end if;
  end if;

  -- 只补齐“本次绑定的教师 × 本次科目 × 当前成员”的绑定；唯一约束保证幂等。
  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select p_teacher_id, member.student_id, subject.domain
  from public.class_members member
  join public.profiles student
    on student.id = member.student_id
   and student.role = 'student'
   and student.is_active = true
  cross join unnest(effective_subjects) as subject(domain)
  where member.class_id = p_class_id
  on conflict (teacher_id, student_id, domain) do nothing;
  get diagnostics bindings_inserted = row_count;

  return jsonb_build_object(
    'class_id', p_class_id,
    'linked', linked,
    'bindings_inserted', bindings_inserted,
    'subjects', to_jsonb(effective_subjects),
    'member_count', (
      select count(*) from public.class_members where class_id = p_class_id
    )
  );
end;
$$;

revoke all on function public.bind_teacher_to_class(uuid, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.bind_teacher_to_class(uuid, uuid, text[])
  to service_role;

-- ---------------------------------------------------------------------------
-- 3b. Legacy 2-arg compatibility wrapper (过渡期保留；本文件不 DROP)
-- ---------------------------------------------------------------------------

-- 部署过渡：SQL 先于应用代码执行时，旧 production 前端仍调用
-- bind_teacher_to_class(p_teacher_id, p_class_id)，必须继续可用。
--   1. 本 wrapper 不含任何独立业务实现：只读取班级当前科目并转交 3 参实现；
--   2. 对旧客户端保持旧语义：把该教师在该班“尚未绑定”的班级科目补齐，
--      重复调用幂等；
--   3. 实际写入全部发生在 3 参实现内部，只为调用教师本人写 link.subjects /
--      teacher_student_bindings，绝不会按班级科目给其他教师补权限
--      （旧的跨教师污染不在这里，也不存在）。
-- 待新代码线上确认稳定后，可用单独的清理迁移 DROP 本 wrapper。
create or replace function public.bind_teacher_to_class(
  p_teacher_id uuid,
  p_class_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_subjects text[];
begin
  select subjects into class_subjects
  from public.teacher_classes
  where class_id = p_class_id;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  return public.bind_teacher_to_class(p_teacher_id, p_class_id, class_subjects);
end;
$$;

revoke all on function public.bind_teacher_to_class(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bind_teacher_to_class(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Class member / subject RPCs (multi-teacher aware)
-- ---------------------------------------------------------------------------

-- Adds students to a class: ensures the teacher_student_bindings rows each
-- class teacher's own subjects require and inserts the memberships in one
-- transaction. Existing memberships and bindings are left untouched. A member
-- added later is backfilled per teacher from that teacher's OWN subject set
-- (owner: teacher_classes.subjects, bound teacher: teacher_class_bindings.
-- subjects), so nobody inherits another teacher's subjects.
create or replace function public.sync_class_members(
  p_teacher_id uuid,
  p_class_id uuid,
  p_student_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_subjects text[];
  requested_count integer;
  valid_count integer;
  related_count integer;
  inserted_count integer;
  member_count integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  select subjects into class_subjects
  from public.teacher_classes
  where class_id = p_class_id
    and public.is_class_teacher(p_class_id, p_teacher_id)
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  select count(*) into requested_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_count < 1 then
    raise exception 'STUDENT_REQUIRED';
  end if;

  select count(*) into valid_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true;
  if valid_count <> requested_count then
    raise exception 'INVALID_STUDENT';
  end if;

  -- Every member must already have a teaching relation with the ACTING
  -- teacher (the API checks visibility, and new accounts are created with the
  -- acting teacher's subjects). A class never introduces a teacher/student
  -- relation from an arbitrary student id. A student may hold BOTH domains, so
  -- count distinct students rather than binding rows.
  select count(distinct students.id) into related_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id;
  if related_count <> requested_count then
    raise exception 'INVALID_STUDENT';
  end if;

  -- Reading/writing relations the class requires, for every teacher of the
  -- class. Each teacher contributes ONLY their own subject set: the owner uses
  -- teacher_classes.subjects, a bound teacher uses teacher_class_bindings.
  -- subjects. No teacher ever receives another teacher's subjects. The
  -- existing bindings trigger still enforces the active teacher/student roles;
  -- inactive teachers are skipped.
  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select class_teacher.teacher_id, students.id, subject.domain
  from (select distinct unnest(p_student_ids) as id) students
  cross join (
    select active_teacher.teacher_id, active_teacher.subjects
    from (
      select owner_class.teacher_id, owner_class.subjects as subjects
      from public.teacher_classes owner_class
      where owner_class.class_id = p_class_id
      union all
      select link.teacher_id, link.subjects
      from public.teacher_class_bindings link
      where link.class_id = p_class_id
    ) active_teacher
    join public.profiles teacher
      on teacher.id = active_teacher.teacher_id
     and teacher.role = 'teacher'
     and teacher.is_active = true
  ) class_teacher
  cross join unnest(coalesce(class_teacher.subjects, array[]::text[])) as subject(domain)
  on conflict (teacher_id, student_id, domain) do nothing;

  insert into public.class_members (class_id, student_id)
  select p_class_id, students.id
  from (select distinct unnest(p_student_ids) as id) students
  on conflict (class_id, student_id) do nothing;
  get diagnostics inserted_count = row_count;

  select count(*) into member_count
  from public.class_members where class_id = p_class_id;

  return jsonb_build_object(
    'class_id', p_class_id,
    'added_count', inserted_count,
    'member_count', member_count
  );
end;
$$;

-- Updates the ACTING teacher's own subject set for the class:
--   * owner: updates teacher_classes.subjects (the owner's subject set);
--   * bound teacher: updates teacher_class_bindings.subjects (only their row);
--   * every member gains the bindings the new subjects require, for the ACTING
--     teacher only — other teachers are never written;
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
  effective_subjects text[];
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
  select array_agg(distinct domain order by domain)
    into effective_subjects
  from unnest(p_subjects) as provided(domain);
  if effective_subjects is null
    or array_length(effective_subjects, 1) < 1
    or array_length(effective_subjects, 1) > 2 then
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

  if class_row.teacher_id = p_teacher_id then
    -- 班级创建者：班级科目集合就是创建者自己的科目集合。
    update public.teacher_classes
    set subjects = effective_subjects
    where class_id = p_class_id;
  else
    -- 已绑定教师：只更新自己在班级里的科目集合，不影响创建者与其他教师。
    update public.teacher_class_bindings
    set subjects = effective_subjects
    where class_id = p_class_id
      and teacher_id = p_teacher_id;
    if not found then
      insert into public.teacher_class_bindings (class_id, teacher_id, subjects)
      values (p_class_id, p_teacher_id, effective_subjects);
    end if;
  end if;

  -- 只为调用教师补齐新科目缺失的成员绑定；不删除、不影响其他教师。
  insert into public.teacher_student_bindings (teacher_id, student_id, domain)
  select p_teacher_id, member.student_id, subject.domain
  from public.class_members member
  join public.profiles student
    on student.id = member.student_id
   and student.role = 'student'
   and student.is_active = true
  cross join unnest(effective_subjects) as subject(domain)
  where member.class_id = p_class_id
  on conflict (teacher_id, student_id, domain) do nothing;

  return jsonb_build_object(
    'class_id', p_class_id,
    'subjects', to_jsonb(effective_subjects),
    'removed_writing_count', removed_writing_count
  );
end;
$$;

-- Removes one membership only. Historical assignments, submissions, reviews
-- and every teacher's bindings are never touched. The legacy
-- p_remove_writing parameter is kept only for signature compatibility and
-- has no effect; removed_writing_count is always 0.
create or replace function public.remove_class_member(
  p_teacher_id uuid,
  p_class_id uuid,
  p_student_id uuid,
  p_remove_writing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  class_subjects text[];
  removed_writing_count integer := 0;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'INVALID_TEACHER';
  end if;

  select subjects into class_subjects
  from public.teacher_classes
  where class_id = p_class_id
    and public.is_class_teacher(p_class_id, p_teacher_id)
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  delete from public.class_members
  where class_id = p_class_id and student_id = p_student_id;
  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'class_id', p_class_id,
    'student_id', p_student_id,
    'removed_writing_count', removed_writing_count
  );
end;
$$;

revoke all on function public.sync_class_members(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.sync_class_members(uuid, uuid, uuid[]) to service_role;
revoke all on function public.update_class_subjects(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.update_class_subjects(uuid, uuid, text[], boolean) to service_role;
revoke all on function public.remove_class_member(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.remove_class_member(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Class-aware Assignment Group creation (subject-aware, class sharing)
-- ---------------------------------------------------------------------------

-- Identical to the subject-aware class-mode RPC, except the class may be
-- managed by a bound teacher (owner OR teacher_class_bindings). The created
-- group and items always belong to the ACTING teacher, and recipients must
-- hold that teacher's subject binding for every class member.
create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean,
  p_subject text,
  p_class_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_data jsonb;
  assignment_ids uuid[] := array[]::uuid[];
  created_assignment_id uuid;
  created_group_id uuid;
  position integer := 0;
  requested_student_count integer;
  valid_student_count integer;
  class_row public.teacher_classes%rowtype;
  member_ids uuid[];
  base_title text;
  final_title text;
  base_title_taken boolean := false;
  max_sequence integer := 0;
  next_sequence integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Invalid teacher';
  end if;

  if p_subject not in ('writing', 'reading') then
    raise exception 'Invalid assignment subject';
  end if;

  if p_class_id is null then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  select * into class_row
  from public.teacher_classes
  where class_id = p_class_id
    and public.is_class_teacher(p_class_id, p_teacher_id)
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;
  -- The acting teacher may create items only for a subject THEY teach in this
  -- class: the owner uses teacher_classes.subjects, a bound teacher uses their
  -- own teacher_class_bindings.subjects. Another teacher's subjects never leak
  -- in. (The per-member binding check below is the effective gate.)
  if not exists (
    select 1
    from (
      select subject.domain
      from unnest(class_row.subjects) as subject(domain)
      where class_row.teacher_id = p_teacher_id
      union all
      select unnest(link.subjects) as domain
      from public.teacher_class_bindings link
      where link.class_id = p_class_id
        and link.teacher_id = p_teacher_id
    ) acting_subject
    where acting_subject.domain = p_subject
  ) then
    if p_subject = 'reading' then
      raise exception 'CLASS_NOT_READING_CLASS';
    end if;
    raise exception 'CLASS_NOT_WRITING_CLASS';
  end if;

  select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
    into member_ids
  from public.class_members member
  where member.class_id = p_class_id;

  requested_student_count := coalesce(array_length(member_ids, 1), 0);
  if requested_student_count < 1 then
    raise exception 'CLASS_HAS_NO_MEMBERS';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 50 then
    raise exception 'Assignments must contain between 1 and 50 items';
  end if;

  -- Class recipients must hold the subject binding; the creation-time member
  -- snapshot stays authoritative for later membership changes.
  select count(*) into valid_student_count
  from (select distinct unnest(member_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = p_subject;
  if valid_student_count <> requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    if assignment_data ->> 'task_type' not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
    ) then
      raise exception 'Invalid assignment item type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if p_subject = 'writing' then
      if assignment_data ->> 'task_type' not in ('email', 'academic_discussion', 'build_sentence') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    else
      if assignment_data ->> 'task_type' not in ('ctw', 'rdl', 'rap', 'full_set') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and assignment_data ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'Reading assignment requires question_bank source';
    end if;
    if jsonb_typeof(assignment_data -> 'question_snapshot') is distinct from 'object' then
      raise exception 'Question snapshot must be an object';
    end if;
    if assignment_data ->> 'question_source' = 'question_bank'
      and nullif(assignment_data ->> 'question_id', '') is null then
      raise exception 'Question bank assignment requires question_id';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and nullif(assignment_data ->> 'question_id', '') is not null then
      raise exception 'Custom assignment cannot include question_id';
    end if;
  end loop;

  base_title := nullif(btrim(coalesce(p_title, '')), '');
  if base_title is not null and char_length(base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  if base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || base_title, 0)
    );

    select
      coalesce(bool_or(group_row.title = base_title), false),
      coalesce(max(
        case
          when group_row.title = base_title then 1
          else nullif(substring(group_row.title from ' \((\d+)\)$'), '')::integer
        end
      ), 0)
    into base_title_taken, max_sequence
    from public.writing_assignment_groups group_row
    where group_row.teacher_id = p_teacher_id
      and group_row.title is not null
      and left(group_row.title, char_length(base_title)) = base_title
      and (group_row.title = base_title
        or substring(group_row.title from ' \((\d+)\)$') is not null)
      and exists (
        select 1 from public.writing_assignments item
        where item.group_id = group_row.group_id
          and item.deleted_at is null
      );

    if not base_title_taken then
      final_title := base_title;
    else
      select free.sequence into next_sequence
      from generate_series(2, greatest(max_sequence, 1) + 1) as free(sequence)
      where not exists (
        select 1 from public.writing_assignment_groups taken
        where taken.teacher_id = p_teacher_id
          and taken.title = base_title || ' (' || free.sequence || ')'
          and exists (
            select 1 from public.writing_assignments item
            where item.group_id = taken.group_id
              and item.deleted_at is null
          )
      )
      order by free.sequence
      limit 1;
      final_title := base_title || ' (' || next_sequence || ')';
    end if;

    if char_length(final_title) > 120 then
      raise exception 'Assignment title is too long';
    end if;
  else
    final_title := base_title;
  end if;

  insert into public.writing_assignment_groups (teacher_id, title, class_id)
  values (p_teacher_id, final_title, p_class_id)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id, subject, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, p_subject, created_group_id, position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    -- Class mode: the creation-time member snapshot, ordered by joined_at.
    insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
    select created_assignment_id, ordered.id, ordered.position
    from (
      select id, ordinality::integer as position
      from unnest(member_ids) with ordinality as ordered(id, ordinality)
    ) ordered;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'title', final_title,
    'subject', p_subject,
    'class_id', p_class_id
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Withdrawn Assignment Group edit (class sharing aware)
-- ---------------------------------------------------------------------------

-- Identical to the subject-aware group edit RPC, except the re-targeted class
-- may be managed by a bound teacher (owner OR teacher_class_bindings). The
-- group still belongs to the acting teacher and recipients must hold that
-- teacher's subject binding for every class member.
create or replace function public.update_withdrawn_writing_assignment_group(
  p_teacher_id uuid,
  p_group_id uuid,
  p_legacy_assignment_id uuid,
  p_title text,
  p_items jsonb,
  p_student_ids uuid[],
  p_due_at timestamptz,
  p_reactivate boolean default false,
  p_class_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_group_id uuid;
  current_legacy public.writing_assignments%rowtype;
  provided_item jsonb;
  item_record record;
  provided_assignment_id text;
  provided_existing_ids uuid[];
  owned_item_ids uuid[];
  recipient_ids uuid[];
  class_row public.teacher_classes%rowtype;
  current_item_count integer;
  provided_item_count integer;
  requested_student_count integer;
  valid_student_count integer;
  removed_with_attempt_count integer;
  removed_item_count integer;
  updated_item_count integer := 0;
  inserted_item_count integer := 0;
  next_position integer;
  derived_subject text;
  group_subjects text[];
  new_assignment_id uuid;
begin
  -- -------------------------------------------------------------------------
  -- 1. Resolve and lock the effective group (existing group or legacy item).
  -- -------------------------------------------------------------------------
  if p_group_id is not null then
    perform 1
    from public.writing_assignment_groups
    where group_id = p_group_id
      and teacher_id = p_teacher_id
    for update;
    if not found then
      raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
    end if;
    effective_group_id := p_group_id;
  elsif p_legacy_assignment_id is not null then
    select * into current_legacy
    from public.writing_assignments
    where assignment_id = p_legacy_assignment_id
      and teacher_id = p_teacher_id
      and deleted_at is null
    for update;
    if not found then
      raise exception 'ASSIGNMENT_NOT_FOUND';
    end if;
    if current_legacy.status <> 'withdrawn' then
      raise exception 'ASSIGNMENT_NOT_WITHDRAWN';
    end if;
    if current_legacy.group_id is not null then
      effective_group_id := current_legacy.group_id;
      perform 1
      from public.writing_assignment_groups
      where group_id = effective_group_id
        and teacher_id = p_teacher_id
      for update;
      if not found then
        raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
      end if;
    else
      insert into public.writing_assignment_groups (teacher_id, title)
      values (p_teacher_id, nullif(btrim(coalesce(p_title, '')), ''))
      returning group_id into effective_group_id;
      update public.writing_assignments
      set group_id = effective_group_id,
          group_position = 1
      where assignment_id = p_legacy_assignment_id;
    end if;
  else
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  -- Lock every visible item of the group. The active-assignment trigger takes
  -- FOR KEY SHARE on the same rows, so attempts and question edits cannot
  -- interleave.
  perform 1
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null
  for update;

  select count(*) into current_item_count
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null;
  if current_item_count < 1 then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  -- Editing follows the historical rule: only a fully withdrawn group can be
  -- edited.
  if exists (
    select 1 from public.writing_assignments
    where group_id = effective_group_id
      and deleted_at is null
      and status <> 'withdrawn'
  ) then
    raise exception 'ASSIGNMENT_GROUP_NOT_WITHDRAWN';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Validate the payload shape and the provided existing item ids.
  -- -------------------------------------------------------------------------
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) < 1
    or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;
  provided_item_count := jsonb_array_length(p_items);

  select coalesce(array_agg((value ->> 'assignment_id')::uuid), array[]::uuid[])
  into provided_existing_ids
  from jsonb_array_elements(p_items)
  where nullif(value ->> 'assignment_id', '') is not null;

  if (select count(distinct id) from unnest(provided_existing_ids) as ids(id))
     <> coalesce(array_length(provided_existing_ids, 1), 0) then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  select coalesce(array_agg(assignment_id), array[]::uuid[])
  into owned_item_ids
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null;

  if exists (
    select 1
    from unnest(provided_existing_ids) as provided(id)
    where provided.id <> all(owned_item_ids)
  ) then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Per-item validation (types, question identity, frozen questions).
  -- -------------------------------------------------------------------------
  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    if provided_item ->> 'task_type' not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
    ) then
      raise exception 'INVALID_TASK_TYPE';
    end if;
    if provided_item ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'INVALID_QUESTION_SOURCE';
    end if;
    if provided_item ->> 'question_source' = 'custom'
      and provided_item ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'INVALID_QUESTION_SOURCE';
    end if;
    if jsonb_typeof(provided_item -> 'question_snapshot') is distinct from 'object' then
      raise exception 'INVALID_QUESTION_SNAPSHOT';
    end if;
    if provided_item ->> 'question_source' = 'question_bank'
      and nullif(provided_item ->> 'question_id', '') is null then
      raise exception 'QUESTION_REQUIRED';
    end if;
    if provided_item ->> 'question_source' = 'custom'
      and nullif(provided_item ->> 'question_id', '') is not null then
      raise exception 'CUSTOM_QUESTION_HAS_ID';
    end if;

    if nullif(provided_item ->> 'assignment_id', '') is not null then
      select * into item_record
      from public.writing_assignments
      where assignment_id = (provided_item ->> 'assignment_id')::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      if not found then
        raise exception 'INVALID_GROUP_ITEMS';
      end if;

      -- Submitted items keep their frozen question, same as before.
      if exists (
        select 1 from public.writing_attempts
        where assignment_id = item_record.assignment_id
          and status = 'submitted'
      ) and (
        item_record.task_type is distinct from provided_item ->> 'task_type'
        or item_record.question_source is distinct from provided_item ->> 'question_source'
        or item_record.question_id is distinct from nullif(provided_item ->> 'question_id', '')
        or item_record.question_snapshot is distinct from (provided_item -> 'question_snapshot')
      ) then
        raise exception 'QUESTION_LOCKED_AFTER_SUBMISSION';
      end if;
    end if;
  end loop;

  -- Every provided item must share exactly one subject; the group can never
  -- become mixed.
  select array_agg(distinct case
      when value ->> 'task_type' in ('ctw', 'rdl', 'rap', 'full_set') then 'reading'
      else 'writing'
    end)
  into group_subjects
  from jsonb_array_elements(p_items);
  if group_subjects is null or array_length(group_subjects, 1) <> 1 then
    raise exception 'MIXED_ASSIGNMENT_SUBJECT';
  end if;
  derived_subject := group_subjects[1];

  -- -------------------------------------------------------------------------
  -- 4. Recipients: explicit student list or the selected class members.
  -- -------------------------------------------------------------------------
  if p_class_id is not null then
    select * into class_row
    from public.teacher_classes
    where class_id = p_class_id
      and public.is_class_teacher(p_class_id, p_teacher_id)
    for update;
    if not found then
      raise exception 'CLASS_NOT_FOUND';
    end if;
    -- Same acting-teacher rule as create_writing_assignment_group: the owner
    -- uses the class subjects, a bound teacher uses their own link subjects.
    if not exists (
      select 1
      from (
        select subject.domain
        from unnest(class_row.subjects) as subject(domain)
        where class_row.teacher_id = p_teacher_id
        union all
        select unnest(link.subjects) as domain
        from public.teacher_class_bindings link
        where link.class_id = p_class_id
          and link.teacher_id = p_teacher_id
      ) acting_subject
      where acting_subject.domain = derived_subject
    ) then
      if derived_subject = 'reading' then
        raise exception 'CLASS_NOT_READING_CLASS';
      end if;
      raise exception 'CLASS_NOT_WRITING_CLASS';
    end if;

    select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
    into recipient_ids
    from public.class_members member
    where member.class_id = p_class_id;
    if coalesce(array_length(recipient_ids, 1), 0) < 1 then
      raise exception 'CLASS_HAS_NO_MEMBERS';
    end if;

    requested_student_count := array_length(recipient_ids, 1);
    select count(*) into valid_student_count
    from unnest(recipient_ids) as students(id)
    join public.profiles student
      on student.id = students.id
     and student.role = 'student'
     and student.is_active = true
    join public.teacher_student_bindings binding
      on binding.teacher_id = p_teacher_id
     and binding.student_id = students.id
     and binding.domain = derived_subject;
    if valid_student_count <> requested_student_count then
      raise exception 'INVALID_STUDENT';
    end if;
  else
    select coalesce(array_agg(ordered.id order by ordered.position), array[]::uuid[])
    into recipient_ids
    from (
      select id, min(ordinality)::integer as position
      from unnest(coalesce(p_student_ids, array[]::uuid[])) with ordinality as submitted(id, ordinality)
      where id is not null
      group by id
    ) ordered;
    requested_student_count := coalesce(array_length(recipient_ids, 1), 0);
    if requested_student_count < 1 then
      raise exception 'STUDENT_REQUIRED';
    end if;
    select count(*) into valid_student_count
    from unnest(recipient_ids) as students(id)
    join public.profiles student
      on student.id = students.id
     and student.role = 'student'
     and student.is_active = true
    join public.teacher_student_bindings binding
      on binding.teacher_id = p_teacher_id
     and binding.student_id = students.id
     and binding.domain = derived_subject;
    if valid_student_count <> requested_student_count then
      raise exception 'INVALID_STUDENT';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Remove the visible items that are no longer part of the payload.
  --    Any item with an attempt is never removable.
  -- -------------------------------------------------------------------------
  select count(*) into removed_with_attempt_count
  from public.writing_assignments item
  where item.group_id = effective_group_id
    and item.deleted_at is null
    and item.assignment_id <> all(provided_existing_ids)
    and exists (
      select 1 from public.writing_attempts attempt
      where attempt.assignment_id = item.assignment_id
    );
  if removed_with_attempt_count > 0 then
    raise exception 'ITEM_HAS_ATTEMPT';
  end if;

  delete from public.writing_assignment_students member
  where member.assignment_id in (
    select item.assignment_id
    from public.writing_assignments item
    where item.group_id = effective_group_id
      and item.deleted_at is null
      and item.assignment_id <> all(provided_existing_ids)
  );

  update public.writing_assignments
  set deleted_at = now()
  where group_id = effective_group_id
    and deleted_at is null
    and assignment_id <> all(provided_existing_ids);
  get diagnostics removed_item_count = row_count;

  -- A student with any attempt on a remaining item of the group cannot be
  -- removed.
  select count(*) into removed_with_attempt_count
  from public.writing_assignment_students member
  join public.writing_assignments item
    on item.assignment_id = member.assignment_id
   and item.group_id = effective_group_id
   and item.deleted_at is null
  where not (member.student_id = any(recipient_ids))
    and exists (
      select 1 from public.writing_attempts attempt
      where attempt.assignment_id = member.assignment_id
        and attempt.user_id = member.student_id
    );
  if removed_with_attempt_count > 0 then
    raise exception 'STUDENT_HAS_ATTEMPT';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Apply the title, class association, items and recipients atomically.
  -- -------------------------------------------------------------------------
  if p_title is not null and btrim(p_title) <> '' then
    if char_length(btrim(p_title)) > 120 then
      raise exception 'Assignment title is too long';
    end if;
    update public.writing_assignment_groups
    set title = btrim(p_title)
    where group_id = effective_group_id
      and teacher_id = p_teacher_id;
  end if;

  update public.writing_assignment_groups
  set class_id = p_class_id
  where group_id = effective_group_id
    and teacher_id = p_teacher_id;

  -- New items are appended after the highest position the group has EVER used,
  -- including soft-deleted items. `writing_assignments_group_position_unique`
  -- is a plain unique index on (group_id, group_position) that is NOT partial on
  -- deleted_at, so a soft-deleted row keeps occupying its position: reusing the
  -- highest visible position (which is what a 换题型 / 换科目 edit does after the
  -- old items were just soft-deleted) raised
  --   23505 duplicate key ... writing_assignments_group_position_unique
  -- and surfaced as 作业更新失败. Historical deleted positions are never reused.
  select coalesce(max(group_position), 0) into next_position
  from public.writing_assignments
  where group_id = effective_group_id;

  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    provided_assignment_id := nullif(provided_item ->> 'assignment_id', '');
    if provided_assignment_id is null then
      next_position := next_position + 1;
      insert into public.writing_assignments (
        teacher_id, subject, group_id, group_position, task_type, question_source,
        question_id, question_snapshot, due_at, status
      ) values (
        p_teacher_id,
        derived_subject,
        effective_group_id,
        next_position,
        provided_item ->> 'task_type',
        provided_item ->> 'question_source',
        nullif(provided_item ->> 'question_id', ''),
        provided_item -> 'question_snapshot',
        p_due_at,
        case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      ) returning assignment_id into new_assignment_id;
      inserted_item_count := inserted_item_count + 1;

      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select new_assignment_id, selected.id, selected.position
      from (
        select id, min(ordinality)::integer as position
        from unnest(recipient_ids) with ordinality as ordered(id, ordinality)
        group by id
      ) selected
      on conflict (assignment_id, student_id)
        do update set sort_order = excluded.sort_order;
    else
      update public.writing_assignments
      set task_type = provided_item ->> 'task_type',
          subject = derived_subject,
          question_source = provided_item ->> 'question_source',
          question_id = nullif(provided_item ->> 'question_id', ''),
          question_snapshot = provided_item -> 'question_snapshot',
          due_at = p_due_at,
          status = case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      where assignment_id = provided_assignment_id::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      updated_item_count := updated_item_count + 1;

      delete from public.writing_assignment_students member
      where member.assignment_id = provided_assignment_id::uuid
        and not (member.student_id = any(recipient_ids));
      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select provided_assignment_id::uuid, selected.id, selected.position
      from (
        select id, min(ordinality)::integer as position
        from unnest(recipient_ids) with ordinality as ordered(id, ordinality)
        group by id
      ) selected
      on conflict (assignment_id, student_id)
        do update set sort_order = excluded.sort_order;
    end if;
  end loop;

  return jsonb_build_object(
    'group_id', effective_group_id,
    'item_count', updated_item_count + inserted_item_count,
    'updated_item_count', updated_item_count,
    'inserted_item_count', inserted_item_count,
    'removed_item_count', removed_item_count,
    'student_count', requested_student_count,
    'class_id', p_class_id,
    'status', case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
  );
end;
$$;


revoke all on function public.update_withdrawn_writing_assignment_group(uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment_group(uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Transaction end: everything above commits or rolls back together.
-- ---------------------------------------------------------------------------

commit;

-- ---------------------------------------------------------------------------
-- Verification（只读校验：不在本文件内，单独执行专用 SQL）
-- ---------------------------------------------------------------------------
--
-- 本文件不再内嵌注释形式的校验查询。执行完成后请运行独立文件：
--
--   supabase/teacher_class_binding_subjects_verify_20261007.sql
--
-- 该文件完全只读（只有 SELECT / WITH），可重复执行，检查内容：
--   QUERY 1 部署门槛：subjects 列 / 约束、bind 2 参与 3 参同时存在且
--           wrapper 只转交 3 参、其余班级 RPC 签名完整、作业学生模式重载
--           未被破坏、link 科目全部已合法回填（每行应为 OK）；
--   QUERY 2 班级 RPC 签名清单（bind 两行、作业两行、其余一行）；
--   QUERY 3 每个班级的教师科目 / owner 科目 / 成员绑定对照（抽查无跨教师回填）；
--   QUERY 4 单个班级（如 0417）的 owner 与已绑定教师科目明细。
