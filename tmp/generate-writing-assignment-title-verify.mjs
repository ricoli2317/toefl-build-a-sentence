import { readFileSync, writeFileSync } from "node:fs";

const applyFile = "supabase/writing_assignment_group_title_backfill_apply.sql";
const outFile = "supabase/writing_assignment_group_title_backfill_verify.sql";

const applyLines = readFileSync(applyFile, "utf8").split("\n");
const valuesIndex = applyLines.findIndex((line) => line.trim() === ") values");
if (valuesIndex === -1) throw new Error("values block not found");
const valuesLines = [];
for (let index = valuesIndex + 1; index < applyLines.length; index += 1) {
  const line = applyLines[index];
  if (!line.trim()) continue;
  if (line.trimEnd().endsWith(";")) {
    valuesLines.push(line.replace(/;\s*$/, ""));
    break;
  }
  valuesLines.push(line);
}
if (valuesLines.length !== 25) {
  throw new Error(`expected 25 plan rows, found ${valuesLines.length}`);
}

const sql = `-- =====================================================================
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
${valuesLines.join("\n")}
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
      E'\\n' order by expected_groups.group_id
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
    coalesce(string_agg(per_base.listing, E'\\n' order by per_base.listing), '无')::text
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
      E'\\n' order by proc.pronargs
    )::text
  from pg_proc proc
  join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
  where namespace_row.nspname = 'public'
    and proc.proname = 'create_writing_assignment_group'
)
select check_name, status, detail
from checks
order by check_name;
`;

writeFileSync(outFile, sql);
console.log(`wrote ${outFile} with ${valuesLines.length} expected plan rows`);
