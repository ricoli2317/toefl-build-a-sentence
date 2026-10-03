-- TPS｜学生账号命名空间：按姓名拼音解析第一个可用账号（服务端权威检查）
--
-- Run this file in the Supabase SQL Editor BEFORE deploying the matching app
-- code (teacher 新增学生 account suggestion). Order relative to the class
-- binding migration does not matter; both are additive.
--
-- Scope
--   * Adds public.first_available_student_account(p_base). Given a base slug
--     (for example zhangsan) it returns the first free account following the
--     product rule: zhangsan, zhangsan2, zhangsan3, ... (max 50 suffixes).
--   * The function checks BOTH public.profiles AND auth.users, so the
--     suggestion never reports an account as free while the real Auth unique
--     constraint would reject it (for example an orphaned Auth user without a
--     profiles row). The final auth.admin.createUser call in the API stays the
--     concurrency guard and still resolves the next suffix if a parallel
--     create wins the race.
--   * Read-only helper: no table data is modified.
--
-- Re-running this file is safe (create or replace).

create or replace function public.first_available_student_account(p_base text)
returns text
language sql
security definer
set search_path = public
as $$
  select candidate.account
  from (
    select
      n.sequence,
      case
        when n.sequence = 1 then base.normalized
        else base.normalized || n.sequence::text
      end as account
    from (
      select left(
        lower(regexp_replace(coalesce(p_base, ''), '[^A-Za-z0-9]', '', 'g')),
        30
      ) as normalized
    ) base
    cross join generate_series(1, 51) as n(sequence)
  ) candidate
  where candidate.account <> ''
    and candidate.account <> 'admin'
    and not exists (
      select 1 from auth.users auth_user
      where lower(auth_user.email) = candidate.account || '@bas.com'
    )
    and not exists (
      select 1 from public.profiles profile
      where lower(profile.email) = candidate.account || '@bas.com'
    )
  order by candidate.sequence
  limit 1;
$$;

revoke all on function public.first_available_student_account(text)
  from public, anon, authenticated;
grant execute on function public.first_available_student_account(text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Verification SQL (read-only; run after applying)
-- ---------------------------------------------------------------------------
--
-- The function must exist with this signature:
--
-- select p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'first_available_student_account';
--
-- Preview the next free account for a pinyin base (no data is written):
--
-- select public.first_available_student_account('zhangsan');
--
-- Compare against the real account namespace (should be empty for the value
-- returned above; the existing accounts preview stays unchanged):
--
-- select u.email from auth.users u
-- where lower(u.email) like 'zhangsan%'
-- order by u.email;
