-- TPS Reading Batch 7B: idempotent retake. Run after reading_attempts.sql.

create or replace function public.retake_reading_attempt(p_submitted_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_source public.reading_attempts%rowtype;
  v_draft_id uuid;
  v_created boolean := false;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;

  select attempt.* into v_source
  from public.reading_attempts attempt
  where attempt.attempt_id = p_submitted_attempt_id
    and attempt.student_id = v_user_id
    and attempt.status = 'submitted'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'READING_SUBMITTED_ATTEMPT_NOT_FOUND';
  end if;

  select attempt.attempt_id into v_draft_id
  from public.reading_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.logical_item_id = v_source.logical_item_id
    and attempt.task_type = v_source.task_type
    and attempt.status = 'draft'
  order by attempt.created_at desc
  limit 1;

  if v_draft_id is null then
    insert into public.reading_attempts (
      student_id, logical_item_id, task_type, status
    ) values (
      v_user_id, v_source.logical_item_id, v_source.task_type, 'draft'
    )
    on conflict (student_id, logical_item_id, task_type)
      where status = 'draft'
    do nothing
    returning attempt_id into v_draft_id;

    if v_draft_id is not null then
      v_created := true;
    else
      select attempt.attempt_id into v_draft_id
      from public.reading_attempts attempt
      where attempt.student_id = v_user_id
        and attempt.logical_item_id = v_source.logical_item_id
        and attempt.task_type = v_source.task_type
        and attempt.status = 'draft'
      order by attempt.created_at desc
      limit 1;
    end if;
  end if;

  select public.reading_attempt_result_json(v_draft_id) into v_result;
  return v_result || jsonb_build_object(
    'created', v_created,
    'resumed', not v_created,
    'retakeOfAttemptId', v_source.attempt_id
  );
end;
$$;

revoke all on function public.retake_reading_attempt(uuid) from public, anon;
grant execute on function public.retake_reading_attempt(uuid) to authenticated;

