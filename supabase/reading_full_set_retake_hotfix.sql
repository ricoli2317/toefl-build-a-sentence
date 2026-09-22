-- TPS Reading Full Set retake hotfix.
-- Apply after reading_full_set_attempts.sql. The original Start RPC selected
-- the latest completed attempt when no active attempt existed, which prevented
-- Retake from creating a new attempt. This replacement reuses active attempts
-- only; the existing partial unique index keeps concurrent Retake idempotent.

begin;

create or replace function public.get_or_create_reading_full_set_attempt(p_full_set_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
  v_time_limit integer;
  v_now timestamptz := clock_timestamp();
  v_created boolean := false;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.is_active
      and profile.role::text in ('student', 'admin', 'teacher')
  ) then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;

  v_time_limit := public.reading_full_set_module_time_limit(p_full_set_id, 1::smallint);
  if v_time_limit is null
    or public.reading_full_set_module_time_limit(p_full_set_id, 2::smallint) <> 540
  then
    raise exception using errcode = 'P0002', message = 'FULL_SET_NOT_FOUND';
  end if;

  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where student_id = v_user_id
    and full_set_id = p_full_set_id
    and status = 'in_progress'
  order by created_at desc
  limit 1;

  if v_attempt_id is null then
    insert into public.reading_full_set_attempts(
      student_id, full_set_id, status, current_module, started_at
    )
    values (v_user_id, p_full_set_id, 'in_progress', 1, v_now)
    on conflict (student_id, full_set_id) where status = 'in_progress' do nothing
    returning attempt_id into v_attempt_id;

    if v_attempt_id is not null then
      v_created := true;
      insert into public.reading_full_set_module_attempts(
        attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
      ) values (
        v_attempt_id, 1, 'active', v_time_limit, v_now,
        v_now + make_interval(secs => v_time_limit)
      );
    else
      select attempt_id into v_attempt_id
      from public.reading_full_set_attempts
      where student_id = v_user_id
        and full_set_id = p_full_set_id
        and status = 'in_progress'
      order by created_at desc
      limit 1;
    end if;
  end if;

  perform public.reconcile_reading_full_set_attempt(v_attempt_id);
  return public.reading_full_set_attempt_json(v_attempt_id)
    || jsonb_build_object('created', v_created);
end;
$$;

revoke all on function public.get_or_create_reading_full_set_attempt(text)
from public, anon;

grant execute on function public.get_or_create_reading_full_set_attempt(text)
to authenticated;

commit;
