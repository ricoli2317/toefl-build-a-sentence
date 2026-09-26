-- Password reset requests (forgot password approval flow).
--
-- Run this file manually in the Supabase SQL Editor before the new
-- forgot-password / approval endpoints are used in production.
--
-- Design:
-- - One row per request; resolved rows (approved/rejected) stay as history.
-- - A partial unique index guarantees at most ONE pending request per user,
--   so repeat requests from the login page refresh the existing pending row
--   instead of creating duplicates. Frontend dedup is never relied upon.
-- - status is resolved with a conditional UPDATE ... WHERE status = 'pending',
--   so an already-handled request can never be approved/rejected twice.
-- - The fixed initial password is NEVER stored here; it only exists in the
--   server-side reset call to Supabase Auth.

create table if not exists public.password_reset_requests (
  request_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_role text not null
    constraint password_reset_requests_role_check
    check (account_role in ('student', 'teacher')),
  status text not null default 'pending'
    constraint password_reset_requests_status_check
    check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  constraint password_reset_requests_resolution_check
    check (
      (status = 'pending' and resolved_at is null)
      or (status <> 'pending' and resolved_at is not null)
    )
);

-- At most one pending request per user at any moment.
create unique index if not exists password_reset_requests_pending_unique
  on public.password_reset_requests(user_id)
  where status = 'pending';

create index if not exists password_reset_requests_pending_role_idx
  on public.password_reset_requests(account_role, requested_at desc)
  where status = 'pending';

-- Only the service-role API may read or write these rows. RLS is enabled with
-- no client policies, and table privileges are revoked from client roles.
alter table public.password_reset_requests enable row level security;
revoke all on table public.password_reset_requests from anon, authenticated;
