-- MANUAL ONLY. Additive read functions; no record, binding, pool or grading changes.
begin;
set local lock_timeout = '5s';

-- Reading/category already have matching partial time indexes. These four
-- missing leading student/domain + time indexes cover the new bounded reads.
create index if not exists attempts_student_submitted_calendar_idx
  on public.attempts(student_id,submitted_at) where submitted_at is not null;
create index if not exists writing_attempts_student_submitted_calendar_idx
  on public.writing_attempts(user_id,submitted_at) where status='submitted';
create index if not exists reading_full_set_student_completed_calendar_idx
  on public.reading_full_set_attempts(student_id,completed_at) where status='completed';
create index if not exists wordbook_review_student_domain_history_idx
  on public.student_wordbook_review_sessions(student_id,domain,started_at desc,session_id);
-- Service-only: callers MUST authorize student bindings and restrict p_tasks.
create function public.read_practice_activity_dates_v1(
  p_student uuid, p_month date, p_timezone text, p_tasks text[], p_teacher boolean default false
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare lo timestamptz; hi timestamptz; result jsonb;
begin
  if p_student is null or p_month is null or p_timezone is null or p_tasks is null or p_teacher is null
    or p_month <> date_trunc('month',p_month)::date or p_month < date '2026-07-01'
    or p_month > date_trunc('month',current_timestamp at time zone p_timezone)::date
    or not p_tasks <@ array['ctw','rdl','rap','full_set','build_sentence','email','academic_discussion']::text[] then
    raise exception 'INVALID_CALENDAR_QUERY';
  end if;
  lo := p_month::timestamp at time zone p_timezone;
  hi := (p_month + interval '1 month')::timestamp at time zone p_timezone;
  select coalesce(jsonb_agg(day order by day),'[]'::jsonb) into result from (
    select distinct to_char(at at time zone p_timezone,'YYYY-MM-DD') as day from (
      select a.submitted_at as at from public.reading_attempts a
        where a.student_id=p_student and a.status='submitted' and a.task_type=any(p_tasks)
          and a.submitted_at>=lo and a.submitted_at<hi
      union all
      select a.completed_at from public.reading_full_set_attempts a
        where 'full_set'=any(p_tasks) and a.student_id=p_student and a.status='completed'
          and a.completed_at>=lo and a.completed_at<hi
      union all
      select a.completed_at from public.reading_question_category_sessions a
        where 'rap'=any(p_tasks) and a.student_id=p_student and a.status='completed'
          and a.completed_at>=lo and a.completed_at<hi
      union all
      select a.submitted_at from public.attempts a
        where 'build_sentence'=any(p_tasks) and a.student_id=p_student
          and a.submitted_at>=lo and a.submitted_at<hi
          and (p_teacher or (lower(btrim(a.set_id)) not like 'wrongbook-%'
            and lower(btrim(a.set_id)) not like 'grammar-all-%'
            and lower(btrim(a.set_id)) not like 'grammar-random-%'))
      union all
      select a.submitted_at from public.writing_attempts a
        where a.user_id=p_student and a.status='submitted' and a.task_type=any(p_tasks)
          and a.submitted_at>=lo and a.submitted_at<hi
      union all
      -- Match teacher day history: unfinished frozen sessions are not records;
      -- a completed session's task overrides its constituent material task.
      select a.submitted_at from public.reading_wrongbook_attempts a
      left join lateral (
        select s.status,case when s.task_type in ('ctw','rdl','rap') then s.task_type else (
          -- Mixed-session day records inherit that day's earliest material,
          -- exactly like the existing teacher history grouping/filter rule.
          select w.task_type from public.reading_wrongbook_attempts w
          where w.student_id=p_student and w.status='submitted'
            and w.submitted_at>=date_trunc('day',a.submitted_at at time zone p_timezone) at time zone p_timezone
            and w.submitted_at<(date_trunc('day',a.submitted_at at time zone p_timezone)+interval '1 day') at time zone p_timezone
            and exists(select 1 from jsonb_each(s.progress) e where e.value->>'attemptId'=w.attempt_id::text)
          order by w.submitted_at,w.attempt_id limit 1
        ) end as task_type from public.student_wrong_question_sessions s
        where s.student_id=p_student and s.created_at<hi
          and (s.completed_at is null or s.completed_at>=lo)
          and exists(select 1 from jsonb_each(s.progress) e where e.value->>'attemptId'=a.attempt_id::text)
        limit 1
      ) session on true
      where p_teacher and a.student_id=p_student and a.status='submitted'
        and a.submitted_at>=lo and a.submitted_at<hi
        and (session.status is null or session.status='completed')
        and (case when session.task_type in ('ctw','rdl','rap') then session.task_type else a.task_type end)=any(p_tasks)
    ) activity where at<=current_timestamp
  ) days;
  return result;
end;
$$;

-- Summary-only paginated history, or DISTINCT month dates. No items/snapshots,
-- question text, student answers or result-details RPC in the list path.
create function public.read_wordbook_review_history_v1(
  p_student uuid, p_domain text, p_page integer default 1,
  p_start_at timestamptz default null, p_end_at timestamptz default null,
  p_month date default null, p_timezone text default 'Asia/Shanghai'
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
  perform public.wordbook_review_authorize(p_student);
  if p_domain is null or p_domain not in ('reading','writing') or p_page is null or p_page not between 1 and 100000
    or (p_start_at is null)<>(p_end_at is null) or p_start_at>=p_end_at then
    raise exception 'REVIEW_INVALID_SETTINGS';
  end if;
  if p_month is not null then
    if p_month<>date_trunc('month',p_month)::date or p_month<date '2026-07-01'
      or p_month>date_trunc('month',current_timestamp at time zone p_timezone)::date then
      raise exception 'REVIEW_INVALID_SETTINGS'; end if;
    select jsonb_build_object('dates',coalesce(jsonb_agg(day order by day),'[]'::jsonb)) into result from (
      select distinct to_char(started_at at time zone p_timezone,'YYYY-MM-DD') as day
      from public.student_wordbook_review_sessions where student_id=p_student and domain=p_domain
        and started_at>=p_month::timestamp at time zone p_timezone
        and started_at<(p_month+interval '1 month')::timestamp at time zone p_timezone
        and started_at<=current_timestamp
    ) days;
    return result;
  end if;
  select jsonb_build_object('total',(select count(*) from public.student_wordbook_review_sessions
    where student_id=p_student and domain=p_domain
      and (p_start_at is null or started_at>=p_start_at) and (p_end_at is null or started_at<p_end_at)),
    'page',p_page,'pageSize',10,'items',coalesce(jsonb_agg(
      (to_jsonb(s)-'student_id'-'request_id')||jsonb_build_object('summary',public.wordbook_review_summary(s.session_id))
      order by s.started_at desc,s.session_id),'[]'::jsonb)) into result from (
        select * from public.student_wordbook_review_sessions where student_id=p_student and domain=p_domain
          and (p_start_at is null or started_at>=p_start_at) and (p_end_at is null or started_at<p_end_at)
          order by started_at desc,session_id offset (p_page-1)*10 limit 10
      ) s;
  return result;
end;
$$;
revoke all on function public.read_practice_activity_dates_v1(uuid,date,text,text[],boolean),
  public.read_wordbook_review_history_v1(uuid,text,integer,timestamptz,timestamptz,date,text) from public,anon,authenticated;
grant execute on function public.read_practice_activity_dates_v1(uuid,date,text,text[],boolean),
  public.read_wordbook_review_history_v1(uuid,text,integer,timestamptz,timestamptz,date,text) to service_role;
commit;
