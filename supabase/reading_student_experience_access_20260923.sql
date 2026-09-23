-- Student Experience is available to Student, Teacher, and Admin accounts.
-- This capability does not change profiles.role and does not grant access to
-- another account's attempts; the Reading RPCs continue to scope every row to
-- auth.uid().

create or replace function public.can_use_student_experience()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active
      and profile.role::text in ('student', 'teacher', 'admin')
  );
$$;

revoke all on function public.can_use_student_experience() from public, anon;
grant execute on function public.can_use_student_experience() to authenticated;

-- Preserve the currently deployed implementation of each RPC, including all
-- Full Set lifecycle hotfixes, and replace only its legacy Student/Admin role
-- predicate. The migration is idempotent and also normalizes definitions that
-- already contain Teacher but have not adopted the shared helper yet.
do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  foreach v_signature in array array[
    'public.get_or_create_reading_attempt(text)'::regprocedure,
    'public.get_or_create_reading_full_set_attempt(text)'::regprocedure,
    'public.get_or_create_reading_wrongbook_attempt(text,text,jsonb)'::regprocedure,
    'public.get_or_create_reading_full_set_wrongbook_attempt(uuid,text,text,jsonb)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position('public.can_use_student_experience()' in v_definition) > 0 then
      continue;
    end if;

    v_updated_definition := regexp_replace(
      v_definition,
      $pattern$profile\.role::text\s+in\s+\('student',\s*'admin'(,\s*'teacher')?\)$pattern$,
      'public.can_use_student_experience()',
      'g'
    );

    if v_updated_definition = v_definition then
      raise exception 'STUDENT_EXPERIENCE_ROLE_GUARD_NOT_FOUND: %', v_signature::text;
    end if;

    execute v_updated_definition;
  end loop;
end;
$$;
