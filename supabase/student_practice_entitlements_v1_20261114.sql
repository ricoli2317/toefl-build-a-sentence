-- TPS student practice entitlements V1 (phase 1: data + Admin management only).
--
-- MANUAL, additive migration. Execute in the Supabase SQL Editor before
-- deploying the accompanying application code.
--
-- Scope:
--   * public.practice_entitlement_defaults          authoritative initial values
--   * public.student_practice_entitlements          sparse per-student remaining values
--   * public.student_practice_unlocks               permanent six-task-type unlocks (no rows inserted here)
--   * public.student_practice_entitlement_events    append-only entitlement/unlock/spend audit
--   * Admin read/write RPCs and the student self-read RPC
--
-- This migration does NOT:
--   * read or write attempts, assignments, practice_items or reading_logical_items;
--   * backfill unlocks;
--   * add any student-callable unlock/spend/gating entry point;
--   * change any existing practice start/submit/retake/full-set behaviour.
--
-- Defaults are deliberately stored in a table so the database is the single
-- authoritative source. Missing entitlement rows always read the default value;
-- an explicitly stored 0 is never replaced by a default.

begin;

-- ---------------------------------------------------------------------------
-- 0. Production-shape guards (fail early and roll back the whole migration)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise exception 'TPS_ENTITLEMENTS_AUTH_UID_MISSING';
  end if;
  if to_regclass('public.profiles') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_active'
     ) then
    raise exception 'TPS_ENTITLEMENTS_PROFILES_SHAPE_MISMATCH';
  end if;
  if to_regclass('public.practice_items') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'practice_items' and column_name = 'item_id'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'practice_items' and column_name = 'task_type'
     ) then
    raise exception 'TPS_ENTITLEMENTS_PRACTICE_ITEMS_SHAPE_MISMATCH';
  end if;
  if to_regclass('public.reading_logical_items') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'reading_logical_items' and column_name = 'logical_item_id'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'reading_logical_items' and column_name = 'module'
     ) then
    raise exception 'TPS_ENTITLEMENTS_READING_LOGICAL_ITEMS_SHAPE_MISMATCH';
  end if;
  if to_regclass('public.writing_assignments') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'writing_assignments' and column_name = 'assignment_id'
     ) then
    raise exception 'TPS_ENTITLEMENTS_WRITING_ASSIGNMENTS_SHAPE_MISMATCH';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Defaults: the single authoritative source of initial remaining values
-- ---------------------------------------------------------------------------
create table if not exists public.practice_entitlement_defaults (
  entitlement_kind text primary key,
  default_remaining integer not null,
  sort_order smallint not null unique,
  constraint practice_entitlement_defaults_kind_check check (entitlement_kind in (
    'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap',
    'bas_category', 'rap_category'
  )),
  constraint practice_entitlement_defaults_nonnegative_check check (default_remaining >= 0),
  constraint practice_entitlement_defaults_sort_check check (sort_order between 1 and 8)
);

insert into public.practice_entitlement_defaults as defaults (
  entitlement_kind, default_remaining, sort_order
) values
  ('build_sentence', 5, 1),
  ('email', 5, 2),
  ('academic_discussion', 5, 3),
  ('ctw', 5, 4),
  ('rdl', 5, 5),
  ('rap', 5, 6),
  ('bas_category', 3, 7),
  ('rap_category', 3, 8)
on conflict (entitlement_kind) do update
set default_remaining = excluded.default_remaining,
    sort_order = excluded.sort_order;

do $$
begin
  if (select count(*) from public.practice_entitlement_defaults) <> 8 then
    raise exception 'TPS_ENTITLEMENTS_DEFAULTS_NOT_EXACTLY_EIGHT';
  end if;
end;
$$;

alter table public.practice_entitlement_defaults enable row level security;
revoke all on table public.practice_entitlement_defaults from public, anon, authenticated;
grant select, insert, update, delete on table public.practice_entitlement_defaults to service_role;

comment on table public.practice_entitlement_defaults is
  'Authoritative initial remaining values for the eight student practice entitlement kinds.';

-- ---------------------------------------------------------------------------
-- 2. Sparse student entitlement rows
-- ---------------------------------------------------------------------------
create table if not exists public.student_practice_entitlements (
  student_id uuid not null references public.profiles(id) on delete cascade,
  entitlement_kind text not null references public.practice_entitlement_defaults(entitlement_kind) on delete restrict,
  remaining integer not null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint student_practice_entitlements_pkey primary key (student_id, entitlement_kind),
  constraint student_practice_entitlements_remaining_nonnegative_check check (remaining >= 0)
);

create index if not exists student_practice_entitlements_student_updated_idx
  on public.student_practice_entitlements (student_id, updated_at desc);

alter table public.student_practice_entitlements enable row level security;
-- Default-deny: no table policy or grant for authenticated roles. Reads and
-- writes go through the SECURITY DEFINER RPCs below, so every Admin write is
-- always paired with its audit row.
revoke all on table public.student_practice_entitlements from public, anon, authenticated;
grant select, insert, update, delete on table public.student_practice_entitlements to service_role;

comment on table public.student_practice_entitlements is
  'Sparse per-student remaining practice entitlements. A missing row reads the defaults table.';

-- ---------------------------------------------------------------------------
-- 3. Permanent unlocks for the six ordinary task types
-- ---------------------------------------------------------------------------
-- BAS / WE / AD use practice_items.item_id identity.
-- CTW / RDL / RAP use reading_logical_items.logical_item_id identity.
-- item_id is polymorphic, so a single foreign key cannot express both
-- identities; the trigger in section 5 enforces the correct canonical table.
-- No unlock row is inserted by this migration and no unlock RPC is created.
create table if not exists public.student_practice_unlocks (
  student_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null,
  item_id text not null,
  source text not null,
  source_ref text,
  unlocked_at timestamptz not null default clock_timestamp(),
  primary key (student_id, task_type, item_id),
  constraint student_practice_unlocks_task_type_check check (task_type in (
    'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap'
  )),
  constraint student_practice_unlocks_item_nonempty_check check (nullif(btrim(item_id), '') is not null),
  constraint student_practice_unlocks_source_nonempty_check check (nullif(btrim(source), '') is not null),
  constraint student_practice_unlocks_source_ref_nonempty_check check (
    source_ref is null or nullif(btrim(source_ref), '') is not null
  )
);

create index if not exists student_practice_unlocks_student_time_idx
  on public.student_practice_unlocks (student_id, unlocked_at desc);
create index if not exists student_practice_unlocks_identity_idx
  on public.student_practice_unlocks (task_type, item_id);

alter table public.student_practice_unlocks enable row level security;
revoke all on table public.student_practice_unlocks from public, anon, authenticated;
grant select, insert, update, delete on table public.student_practice_unlocks to service_role;

comment on table public.student_practice_unlocks is
  'Permanent ordinary-task unlocks. Identity is canonical practice_item or reading logical_item.';

-- ---------------------------------------------------------------------------
-- 4. Append-only entitlement / unlock / spend audit
-- ---------------------------------------------------------------------------
create table if not exists public.student_practice_entitlement_events (
  event_id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  entitlement_kind text not null references public.practice_entitlement_defaults(entitlement_kind) on delete restrict,
  operation text not null,
  reason text,
  previous_remaining integer,
  new_remaining integer,
  actor_id uuid references public.profiles(id) on delete restrict,
  item_id text,
  assignment_id uuid references public.writing_assignments(assignment_id) on delete set null,
  request_id text,
  created_at timestamptz not null default clock_timestamp(),
  constraint student_practice_entitlement_events_operation_check check (operation in (
    'admin_set', 'spend', 'unlock', 'grant', 'refund', 'revoke'
  )),
  constraint student_practice_entitlement_events_previous_nonnegative_check check (
    previous_remaining is null or previous_remaining >= 0
  ),
  constraint student_practice_entitlement_events_new_nonnegative_check check (
    new_remaining is null or new_remaining >= 0
  ),
  constraint student_practice_entitlement_events_reason_check check (
    reason is null or char_length(btrim(reason)) between 1 and 500
  ),
  constraint student_practice_entitlement_events_item_nonempty_check check (
    item_id is null or nullif(btrim(item_id), '') is not null
  ),
  constraint student_practice_entitlement_events_request_nonempty_check check (
    request_id is null or nullif(btrim(request_id), '') is not null
  ),
  constraint student_practice_entitlement_events_admin_set_shape_check check (
    operation <> 'admin_set' or (
      previous_remaining is not null
      and new_remaining is not null
      and actor_id is not null
    )
  )
);

create index if not exists student_practice_entitlement_events_student_time_idx
  on public.student_practice_entitlement_events (student_id, created_at desc);
create index if not exists student_practice_entitlement_events_actor_time_idx
  on public.student_practice_entitlement_events (actor_id, created_at desc);
create index if not exists student_practice_entitlement_events_kind_time_idx
  on public.student_practice_entitlement_events (entitlement_kind, created_at desc);
create index if not exists student_practice_entitlement_events_request_idx
  on public.student_practice_entitlement_events (request_id) where request_id is not null;

alter table public.student_practice_entitlement_events enable row level security;
-- Append-only from the application perspective: no UPDATE/DELETE grant even to
-- service_role, and no authenticated table policy.
revoke all on table public.student_practice_entitlement_events from public, anon, authenticated;
grant select, insert on table public.student_practice_entitlement_events to service_role;

comment on table public.student_practice_entitlement_events is
  'Append-only audit for Admin entitlement changes and future unlock/spend/refund operations.';

-- ---------------------------------------------------------------------------
-- 5. Shape guards for rows that do carry a student identity
-- ---------------------------------------------------------------------------
create or replace function public.enforce_student_practice_entitlement_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.student_id is null or not exists (
    select 1 from public.profiles
    where id = new.student_id and role = 'student'
  ) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_student_practice_entitlement_student() from public, anon, authenticated;

drop trigger if exists student_practice_entitlements_student_guard on public.student_practice_entitlements;
create trigger student_practice_entitlements_student_guard
before insert or update of student_id on public.student_practice_entitlements
for each row execute function public.enforce_student_practice_entitlement_student();

drop trigger if exists student_practice_entitlement_events_student_guard on public.student_practice_entitlement_events;
create trigger student_practice_entitlement_events_student_guard
before insert or update of student_id on public.student_practice_entitlement_events
for each row execute function public.enforce_student_practice_entitlement_student();

create or replace function public.enforce_student_practice_unlock_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.student_id is null or not exists (
    select 1 from public.profiles
    where id = new.student_id and role = 'student'
  ) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;

  if new.task_type in ('build_sentence', 'email', 'academic_discussion') then
    if not exists (
      select 1 from public.practice_items
      where item_id = new.item_id and task_type = new.task_type
    ) then
      raise exception 'INVALID_PRACTICE_ITEM_IDENTITY';
    end if;
  else
    if not exists (
      select 1 from public.reading_logical_items
      where logical_item_id = new.item_id and module = new.task_type
    ) then
      raise exception 'INVALID_READING_ITEM_IDENTITY';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_student_practice_unlock_identity() from public, anon, authenticated;

drop trigger if exists student_practice_unlocks_identity_guard on public.student_practice_unlocks;
create trigger student_practice_unlocks_identity_guard
before insert or update of student_id, task_type, item_id on public.student_practice_unlocks
for each row execute function public.enforce_student_practice_unlock_identity();

-- ---------------------------------------------------------------------------
-- 6. Internal snapshot helper
-- ---------------------------------------------------------------------------
-- One place merges defaults with explicit rows. The helper is not executable by
-- client roles; only the SECURITY DEFINER entry points below call it.
create or replace function public.student_practice_entitlement_snapshot(p_student_id uuid)
returns table (
  entitlement_kind text,
  remaining integer,
  default_remaining integer,
  is_explicit boolean,
  updated_at timestamptz,
  updated_by uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    defaults.entitlement_kind,
    coalesce(entitlements.remaining, defaults.default_remaining)::integer as remaining,
    defaults.default_remaining,
    (entitlements.student_id is not null) as is_explicit,
    entitlements.updated_at,
    entitlements.updated_by
  from public.practice_entitlement_defaults defaults
  left join public.student_practice_entitlements entitlements
    on entitlements.student_id = p_student_id
   and entitlements.entitlement_kind = defaults.entitlement_kind
  order by defaults.sort_order;
$$;

revoke all on function public.student_practice_entitlement_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Admin read RPC
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_student_practice_entitlements(p_student_id uuid)
returns table (
  entitlement_kind text,
  remaining integer,
  default_remaining integer,
  is_explicit boolean,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and is_active = true
  ) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_student_id and role = 'student'
  ) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;

  return query select * from public.student_practice_entitlement_snapshot(p_student_id);
end;
$$;

revoke all on function public.admin_get_student_practice_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.admin_get_student_practice_entitlements(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Admin atomic set RPC
-- ---------------------------------------------------------------------------
-- * Validates the real Admin profile from auth.uid() (never a client role).
-- * Validates the target is a student.
-- * Serializes first materialization and concurrent updates per student.
-- * Writes the entitlement row and its audit row in the same transaction.
-- * Returns the authoritative database snapshot, including unchanged kinds.
create or replace function public.admin_set_student_practice_entitlements(
  p_student_id uuid,
  p_values jsonb,
  p_reason text default null
)
returns table (
  entitlement_kind text,
  remaining integer,
  default_remaining integer,
  is_explicit boolean,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_value jsonb;
  v_numeric numeric;
  v_new integer;
  v_previous integer;
  v_default integer;
  v_reason text;
begin
  if not exists (
    select 1 from public.profiles
    where id = v_actor and role = 'admin' and is_active = true
  ) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_student_id and role = 'student'
  ) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;

  if p_values is null
     or jsonb_typeof(p_values) <> 'object'
     or p_values = '{}'::jsonb then
    raise exception 'INVALID_ENTITLEMENT_PAYLOAD';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_values) as keys(kind)
    where not exists (
      select 1 from public.practice_entitlement_defaults defaults
      where defaults.entitlement_kind = keys.kind
    )
  ) then
    raise exception 'INVALID_ENTITLEMENT_KIND';
  end if;

  for v_kind, v_value in select key, value from jsonb_each(p_values)
  loop
    if jsonb_typeof(v_value) <> 'number'
       or (v_value #>> '{}') !~ '^[0-9]+$' then
      raise exception 'INVALID_ENTITLEMENT_VALUE';
    end if;
    v_numeric := (v_value #>> '{}')::numeric;
    if v_numeric < 0 or v_numeric > 2147483647 then
      raise exception 'INVALID_ENTITLEMENT_VALUE';
    end if;
  end loop;

  -- Two concurrent Admin saves for the same student must not both decide that
  -- the row is missing. The transaction-scoped lock serializes that decision.
  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text, 0));

  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'admin_manual_update'), 500);

  for v_kind, v_value in select key, value from jsonb_each(p_values)
  loop
    v_new := (v_value #>> '{}')::integer;

    select defaults.default_remaining
      into strict v_default
    from public.practice_entitlement_defaults defaults
    where defaults.entitlement_kind = v_kind;

    select entitlements.remaining
      into v_previous
    from public.student_practice_entitlements entitlements
    where entitlements.student_id = p_student_id
      and entitlements.entitlement_kind = v_kind
    for update;

    if not found then
      v_previous := v_default;
    end if;

    -- Setting an absent row to the same value as the default is a no-op: the
    -- sparse representation already returns that value. A real change (0, a
    -- larger value, or a different stored value) always writes both rows.
    if v_previous is distinct from v_new then
      insert into public.student_practice_entitlements as entitlements (
        student_id, entitlement_kind, remaining, updated_at, updated_by
      ) values (
        p_student_id, v_kind, v_new, clock_timestamp(), v_actor
      )
      on conflict on constraint student_practice_entitlements_pkey do update
      set remaining = excluded.remaining,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by;

      insert into public.student_practice_entitlement_events (
        student_id, entitlement_kind, operation, reason,
        previous_remaining, new_remaining, actor_id
      ) values (
        p_student_id, v_kind, 'admin_set', v_reason,
        v_previous, v_new, v_actor
      );
    end if;
  end loop;

  return query select * from public.student_practice_entitlement_snapshot(p_student_id);
end;
$$;

revoke all on function public.admin_set_student_practice_entitlements(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.admin_set_student_practice_entitlements(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Student self-read RPC (no target parameter by design)
-- ---------------------------------------------------------------------------
create or replace function public.student_practice_entitlements_self()
returns table (
  entitlement_kind text,
  remaining integer,
  default_remaining integer,
  is_explicit boolean,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
begin
  if v_student is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = v_student and role = 'student' and is_active = true
  ) then
    raise exception 'STUDENT_REQUIRED';
  end if;

  return query select * from public.student_practice_entitlement_snapshot(v_student);
end;
$$;

revoke all on function public.student_practice_entitlements_self() from public, anon, authenticated;
grant execute on function public.student_practice_entitlements_self() to authenticated;

-- No unlock/spend RPC is intentionally created in phase 1.

commit;
