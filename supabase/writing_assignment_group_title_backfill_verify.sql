-- =====================================================================
-- READ-ONLY verification for the writing assignment group title backfill.
--
-- SELECT only: this file contains no UPDATE / DELETE / DROP / ALTER and never
-- runs Phase B. Run it in the Supabase SQL Editor after the apply SQL
-- succeeded and before Phase B.
--
-- The expected plan below is copied verbatim from
-- supabase/writing_assignment_group_title_backfill_apply.sql, and
-- expected_title is recomputed with the exact same stable numbering
-- (teacher + base title, creation time, group_id tie-breaker) that the apply
-- SQL used. Every check returns PASS / FAIL plus a reviewable detail column.
-- =====================================================================

with writing_assignment_group_title_expected (
  group_id, teacher_id, old_title, base_auto_title, students, assigned_date,
  created_at, email_count, ad_count, can_auto_update, reason
) as (
  values
  ('02df5d72-2e19-4612-ad4c-9250224acab7', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目040 Training vs Low Prices', '陈俊伊 2026-09-18', '陈俊伊', '2026-09-18'::date, '2026-09-18T08:35:20.021Z'::timestamptz, 0, 1, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('2e9367ef-eda4-4999-8502-beb984962909', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目048 Technology Impact on Education 等 3 篇写作', '李梓瑜 2026-08-28', '李梓瑜', '2026-08-28'::date, '2026-08-28T08:40:27.634Z'::timestamptz, 0, 3, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('32fbecd0-a421-4a1b-a565-86f6fad0b39b', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目024 Academic and Work Balance', '陈俊伊 2026-09-18', '陈俊伊', '2026-09-18'::date, '2026-09-18T10:04:17.687Z'::timestamptz, 1, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('35363727-ca3d-4848-a70b-11204508fa2c', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目002 Personalization and Brand Loyalty', '陈俊伊 2026-09-18', '陈俊伊', '2026-09-18'::date, '2026-09-18T10:05:11.241Z'::timestamptz, 0, 1, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('38c1c92e-dc7b-4263-b48f-68c1d4776f0d', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目054 Renewable Energy vs Efficiency', '彭钰杰 2026-09-18', '彭钰杰', '2026-09-18'::date, '2026-09-18T10:13:11.059Z'::timestamptz, 0, 1, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('3cc85ba4-8c5f-4519-ba39-4bd439a9aef4', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目021 Hotel Stay Feedback', '彭钰杰 2026-09-18', '彭钰杰', '2026-09-18'::date, '2026-09-18T10:11:35.825Z'::timestamptz, 1, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('456e91b2-1e29-4c7f-9763-64e64c06c87f', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目059 Public Art and Identity', null, '蒋卓成', '2026-09-18'::date, '2026-09-18T08:04:23.907Z'::timestamptz, 0, 1, false, '全部题目已删除，无可见卡片'),
  ('479cf2cd-cf62-4214-8bcb-108337857d25', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目040 Training vs Low Prices 等 3 篇写作', '陈俊伊 2026-08-21', '陈俊伊', '2026-08-21'::date, '2026-08-21T06:00:36.527Z'::timestamptz, 0, 3, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('4acbaf65-3136-49ce-a1b5-69a479466577', '6f333422-384a-44fb-8a83-e9c1aadb0caf', 'E2E Admin Self 2026-08-27', null, 'admin', '2026-08-27'::date, '2026-08-27T03:53:19.260Z'::timestamptz, 1, 0, false, '自定义题目标题无法判定是否为教师手动修改，保留现状'),
  ('611de9a1-2e94-4e2b-a715-2ce5a328d802', 'bef319d4-3e57-4b78-aae2-95cac828b638', '260821-张宸皓 等 2 篇写作', '张宸皓 2026-08-21', '张宸皓', '2026-08-21'::date, '2026-08-21T02:57:02.545Z'::timestamptz, 2, 0, true, '自定义题目标题匹配旧版系统自动命名规则'),
  ('66402360-aed9-40eb-a48e-a20945eb55de', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目002 Fundraising Event Planning', '彭钰杰 2026-09-22', '彭钰杰', '2026-09-22'::date, '2026-09-22T07:52:21.741Z'::timestamptz, 1, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('6800a6be-ad82-4e8e-b32f-4c572f987e24', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '260829-张童予', '张童予 2026-08-29', '张童予', '2026-08-29'::date, '2026-08-29T08:22:28.473Z'::timestamptz, 1, 0, true, '自定义题目标题匹配旧版系统自动命名规则'),
  ('7345a079-18f0-453a-aeaa-53f742fe0cd0', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目048 Community Theater Costume Rentals', '蒋卓成 2026-09-18', '蒋卓成', '2026-09-18'::date, '2026-09-18T08:16:06.123Z'::timestamptz, 1, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('8f37a079-4071-4795-aa40-443ccd5f8cc5', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目039 Traditional vs Nontraditional Careers 等 4 篇写作', '李梓瑜 2026-09-17', '李梓瑜', '2026-09-17'::date, '2026-09-17T14:22:48.539Z'::timestamptz, 0, 4, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('913f7fc7-ca4d-4562-b901-90b0a44e845f', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目069 Summer Internship Documents', null, '蒋卓成', '2026-09-18'::date, '2026-09-18T08:03:47.196Z'::timestamptz, 1, 0, false, '全部题目已删除，无可见卡片'),
  ('97e18f23-7ebf-4a69-b48b-005137141b25', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目026 Project-Based Learning', '彭钰杰 2026-09-22', '彭钰杰', '2026-09-22'::date, '2026-09-22T07:51:25.683Z'::timestamptz, 0, 1, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('ac380b11-5c3d-4595-b767-291957475cc0', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目030 Dining Experience Feedback 等 2 篇写作', '冉阳 2026-09-19', '冉阳', '2026-09-19'::date, '2026-09-19T04:02:02.357Z'::timestamptz, 2, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('acf1121f-f060-4d07-8794-804ba944c0cc', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目030 Dining Experience Feedback 等 2 篇写作', '王思颖 2026-09-15', '王思颖', '2026-09-15'::date, '2026-09-15T14:05:49.520Z'::timestamptz, 2, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('c1d7f3ba-68cd-44f4-949f-011fcf3a9219', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目032 Eco-Friendly Resort Practices 等 2 篇写作', '张欣允 2026-08-23', '张欣允', '2026-08-23'::date, '2026-08-23T09:29:45.397Z'::timestamptz, 2, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('c225cbac-26a8-45de-aa1b-6d5201184745', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目026 Project-Based Learning 等 4 篇写作', '金韵雅 2026-09-16', '金韵雅', '2026-09-16'::date, '2026-09-16T08:14:59.191Z'::timestamptz, 0, 4, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('cad07437-6414-4e92-b1f7-fd266d913580', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目030 Dining Experience Feedback 等 4 篇写作', '金韵雅 2026-09-16', '金韵雅', '2026-09-16'::date, '2026-09-16T08:12:53.344Z'::timestamptz, 4, 0, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('cfb12449-398f-45d8-8035-a50e408f6336', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目053 Preserving Indigenous Cultures 等 4 篇写作', '蔡沂熹 2026-08-25', '蔡沂熹', '2026-08-25'::date, '2026-08-25T09:14:15.504Z'::timestamptz, 0, 4, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('cfe469ad-963e-4947-98c5-68171f591a84', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目051 Individual vs Systemic Climate Action 等 2 篇写作', '陈乐阳 2026-09-15', '陈乐阳', '2026-09-15'::date, '2026-09-15T14:09:55.813Z'::timestamptz, 0, 2, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('eb1e73d5-7f9c-42bc-a5f8-256d40a34753', 'bef319d4-3e57-4b78-aae2-95cac828b638', '题目043 Workplace Emotional Intelligence 等 2 篇写作', '张宸皓 2026-08-21', '张宸皓', '2026-08-21'::date, '2026-08-21T03:56:13.848Z'::timestamptz, 0, 2, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成'),
  ('f2a3eedc-ab9f-4b1c-a04d-efe27d248e3b', 'bdd0bd35-e23d-4b59-934f-cbc9de875a93', '题目068 Environmental Solutions and Speed', '蒋卓成 2026-09-18', '蒋卓成', '2026-09-18'::date, '2026-09-18T08:16:52.959Z'::timestamptz, 0, 1, true, '题库题目从未有可编辑的作业标题，按收件人与布置日期生成')
),
untouched(group_id) as (
  values
    ('4acbaf65-3136-49ce-a1b5-69a479466577'::uuid),
    ('456e91b2-1e29-4c7f-9763-64e64c06c87f'::uuid),
    ('913f7fc7-ca4d-4562-b901-90b0a44e845f'::uuid)
),
numbered as (
  select
    plan.*,
    case
      when plan.can_auto_update then row_number() over (
        partition by plan.teacher_id, plan.base_auto_title
        order by plan.created_at, plan.group_id
      )
    end as auto_title_sequence
  from writing_assignment_group_title_expected plan
),
expected as (
  select
    numbered.*,
    case
      when not numbered.can_auto_update then null
      when numbered.auto_title_sequence = 1 then numbered.base_auto_title
      else numbered.base_auto_title || ' (' || numbered.auto_title_sequence || ')'
    end as expected_title
  from numbered
),
-- The VALUES literals infer text; carry an explicit uuid form so joins and
-- comparisons against the real tables work.
expected_groups as (
  select
    expected.*,
    expected.group_id::uuid as group_id_uuid
  from expected
),
live as (
  select groups.group_id, groups.title
  from public.writing_assignment_groups groups
  where groups.group_id in (
    select expected_groups.group_id_uuid
    from expected_groups
  )
),
checks as (
  -- 1) all 22 can_auto_update groups are written with the expected title
  select
    '1. 22 个可自动更新的 group 已全部写入 title'::text as check_name,
    case
      when count(*) filter (
        where expected_groups.can_auto_update
          and live.title is distinct from expected_groups.expected_title
      ) = 0 then 'PASS' else 'FAIL'
    end as status,
    format(
      '可自动更新 %s 个，已写入 %s 个，title 不一致 %s 个',
      count(*) filter (where expected_groups.can_auto_update),
      count(*) filter (where expected_groups.can_auto_update and live.title is not null),
      count(*) filter (
        where expected_groups.can_auto_update
          and live.title is distinct from expected_groups.expected_title
      )
    )::text as detail
  from expected_groups
  join live on live.group_id = expected_groups.group_id_uuid

  union all

  -- 2) mismatch detail, expected to be empty
  select
    '2. title 与 dry-run 计划不一致的明细（期望为空）'::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(
      format('%s 实际=%L 期望=%L', expected_groups.group_id, live.title, expected_groups.expected_title),
      E'\n' order by expected_groups.group_id
    ), '无')::text
  from expected_groups
  join live on live.group_id = expected_groups.group_id_uuid
  where expected_groups.can_auto_update
    and live.title is distinct from expected_groups.expected_title

  union all

  -- 3) numbering per teacher + base title: no duplicates, with sequence list
  select
    '3. 同一教师+同一基础标题的编号正确且无重复'::text,
    case
      when count(*) filter (where per_base.distinct_titles <> per_base.group_count) = 0
      then 'PASS' else 'FAIL'
    end,
    coalesce(string_agg(per_base.listing, E'\n' order by per_base.listing), '无')::text
  from (
    select
      expected_groups.base_auto_title,
      count(*) as group_count,
      count(distinct live.title) as distinct_titles,
      format(
        '%s 组数=%s 标题：%s',
        expected_groups.base_auto_title,
        count(*),
        string_agg(live.title, ' | ' order by expected_groups.auto_title_sequence)
      ) as listing
    from expected_groups
    join live on live.group_id = expected_groups.group_id_uuid
    where expected_groups.can_auto_update
    group by expected_groups.base_auto_title
    having count(*) > 1
  ) per_base

  union all

  -- 4) the three non-auto groups were not touched and still have no title
  select
    '4. 3 个不可自动更新的 group 未被修改（title 仍为 null）'::text,
    case
      when count(*) = 3 and bool_and(live.title is null) then 'PASS' else 'FAIL'
    end,
    string_agg(
      format('%s: title=%L', untouched.group_id, live.title),
      '; ' order by untouched.group_id
    )::text
  from untouched
  join live using (group_id)

  union all

  -- 5) no group outside the safe set received a title
  select
    '5. 不存在计划外被写入 title 的 group'::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(
      format('%s: title=%L', groups.group_id, groups.title),
      '; ' order by groups.group_id
    ), '无')::text
  from public.writing_assignment_groups groups
  where groups.title is not null
    and groups.group_id not in (
      select expected_groups.group_id_uuid
      from expected_groups
      where expected_groups.can_auto_update
    )

  union all

  -- 6) sort_order was not touched by this backfill
  select
    '6. writing_assignment_students.sort_order 全部为空（本次 backfill 未触碰）'::text,
    case
      when count(*) filter (where members.sort_order is not null) = 0
      then 'PASS' else 'FAIL'
    end,
    format(
      '成员 %s 条，sort_order 非空 %s 条',
      count(*),
      count(*) filter (where members.sort_order is not null)
    )::text
  from public.writing_assignment_students members

  union all

  -- 7) title / sort_order columns exist
  select
    '7. title / sort_order 列存在'::text,
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    string_agg(
      format('%s.%s %s', columns.table_name, columns.column_name, columns.data_type),
      '; ' order by columns.table_name
    )::text
  from information_schema.columns columns
  where columns.table_schema = 'public'
    and (
      (columns.table_name = 'writing_assignment_groups' and columns.column_name = 'title')
      or (columns.table_name = 'writing_assignment_students' and columns.column_name = 'sort_order')
    )

  union all

  -- 8) before Phase B: the 3 / 4 / 5 argument overloads must all still exist
  select
    '8. Phase B 前 RPC 重载应为 3/4/5 参数各一个'::text,
    case
      when count(*) filter (where proc.pronargs = 3) = 1
        and count(*) filter (where proc.pronargs = 4) = 1
        and count(*) filter (where proc.pronargs = 5) = 1
        and count(*) = 3
      then 'PASS' else 'FAIL'
    end,
    string_agg(
      format('%s(%s)', proc.proname, pg_get_function_identity_arguments(proc.oid)),
      E'\n' order by proc.pronargs
    )::text
  from pg_proc proc
  join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
  where namespace_row.nspname = 'public'
    and proc.proname = 'create_writing_assignment_group'
)
select check_name, status, detail
from checks
order by check_name;
