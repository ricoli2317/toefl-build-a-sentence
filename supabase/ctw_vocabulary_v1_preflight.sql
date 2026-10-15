-- Read-only preflight, run manually as postgres. No legacy changes.
do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('auth.users') is null then
    raise exception 'CTW_VOCAB_AUTH_TABLES_REQUIRED';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='profiles' and column_name='is_active') then
    raise exception 'CTW_VOCAB_ACTIVE_PROFILE_REQUIRED';
  end if;
  if to_regclass('public.ctw_vocabulary_entries') is not null
    or to_regclass('public.student_ctw_vocabulary_attempts') is not null
    or exists(select 1 from pg_namespace where nspname='ctw_vocab_private')
    or to_regprocedure('public.read_ctw_vocabulary_catalog_v1()') is not null then
    raise exception 'CTW_VOCAB_ALREADY_INSTALLED_OR_NAME_COLLISION';
  end if;
end;
$$;
