-- Apply once only to databases that already ran reading_full_set_attempts.sql
-- before the explicit smallint call-site fix. This overload preserves the
-- original helper and lets the installed RPC bodies resolve integer literals.

begin;

create or replace function public.reading_full_set_module_time_limit(
  p_full_set_id text,
  p_module_number integer
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.reading_full_set_module_time_limit(
    p_full_set_id,
    p_module_number::smallint
  );
$$;

revoke all on function public.reading_full_set_module_time_limit(text, integer)
from public, anon, authenticated;

commit;
