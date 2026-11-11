-- Manual installation in Supabase SQL Editor, once, before enabling the UI.
-- Additive schema only. Requires existing profiles(id, role, is_active).
-- No existing business table/policy/function is changed. No recipient fan-out.
begin;

create table public.system_notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  content text not null check (char_length(btrim(content)) between 1 and 20000),
  type text not null default 'announcement' check (type in ('announcement', 'maintenance', 'update')),
  target_role text not null default 'all' check (target_role in ('all', 'teacher', 'student')),
  status text not null default 'draft' check (status in ('draft', 'published', 'withdrawn')),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  withdrawn_at timestamptz,
  constraint system_notifications_lifecycle check (
    (status = 'draft' and published_at is null and withdrawn_at is null) or
    (status = 'published' and published_at is not null and withdrawn_at is null) or
    (status = 'withdrawn' and published_at is not null and withdrawn_at is not null)
  )
);

create table public.user_notification_reads (
  notification_id uuid not null references public.system_notifications(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  read_at timestamptz not null default clock_timestamp(),
  primary key (notification_id, user_id)
);

create index system_notifications_published_idx
  on public.system_notifications (published_at desc, id desc)
  include (target_role) where status = 'published';
create index system_notifications_admin_idx on public.system_notifications (created_at desc, id desc);
create index system_notifications_creator_idx on public.system_notifications (created_by);
create index user_notification_reads_user_idx on public.user_notification_reads (user_id, notification_id);

-- Even direct PostgREST writes cannot edit a published payload or republish a
-- withdrawn row. Important corrections must be a NEW notification/new identity.
create function public.enforce_system_notification_lifecycle()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'NOTIFICATION_DRAFT_REQUIRED'; end if;
    new.created_by := auth.uid();
    new.created_at := clock_timestamp();
    new.published_at := null;
    new.withdrawn_at := null;
  else
    if new.id is distinct from old.id or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at then
      raise exception 'NOTIFICATION_IDENTITY_IMMUTABLE';
    end if;
    if old.status <> 'draft' and (
      new.title is distinct from old.title or new.content is distinct from old.content
      or new.type is distinct from old.type or new.target_role is distinct from old.target_role
    ) then raise exception 'NOTIFICATION_PUBLISHED_IMMUTABLE'; end if;
    if old.status = 'withdrawn' or (old.status = 'published' and new.status <> 'withdrawn')
      or (old.status = 'draft' and new.status not in ('draft', 'published')) then
      raise exception 'NOTIFICATION_INVALID_TRANSITION';
    end if;
    if new.status = 'published' then
      new.published_at := clock_timestamp();
    else
      new.published_at := old.published_at;
    end if;
    new.withdrawn_at := case when new.status = 'withdrawn' then clock_timestamp() else null end;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.enforce_system_notification_lifecycle() from public, anon, authenticated;
create trigger system_notifications_lifecycle
before insert or update on public.system_notifications
for each row execute function public.enforce_system_notification_lifecycle();

alter table public.system_notifications enable row level security;
alter table public.user_notification_reads enable row level security;
revoke all on public.system_notifications, public.user_notification_reads from public, anon, authenticated;
grant select, insert, update on public.system_notifications to authenticated;
-- Read confirmations are append-only: no UPDATE/DELETE, even for one's own row.
grant select, insert on public.user_notification_reads to authenticated;

create policy notifications_admin_select on public.system_notifications for select to authenticated
using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active));
create policy notifications_admin_insert on public.system_notifications for insert to authenticated
with check (created_by = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active
));
create policy notifications_admin_update on public.system_notifications for update to authenticated
using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active))
with check (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active));
create policy notifications_recipient_select on public.system_notifications for select to authenticated
using (status = 'published' and published_at <= now() and exists (
  select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
    and p.role in ('teacher', 'student') and (target_role = 'all' or target_role = p.role::text)
));
create policy notification_reads_own_select on public.user_notification_reads for select to authenticated
using (user_id = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and is_active and role in ('teacher', 'student')
));
create policy notification_reads_own_insert on public.user_notification_reads for insert to authenticated
with check (user_id = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and is_active and role in ('teacher', 'student')
) and exists (
  select 1 from public.system_notifications n where n.id = notification_id and n.status = 'published' and n.published_at <= now()
));

-- SECURITY INVOKER: these queries always use the caller's RLS, never a service key.
-- Badge checks touch only the notification indexes and the caller's read keys.
create function public.notification_unread_count()
returns bigint language sql stable security invoker set search_path = '' as $$
  select count(*) from public.system_notifications n
  where n.status = 'published' and n.published_at <= now()
    and not exists (select 1 from public.user_notification_reads r
      where r.notification_id = n.id and r.user_id = (select auth.uid()));
$$;

-- Keyset pagination, including an id tie-breaker: no lost items with equal dates.
-- Body is fetched only when the recipient explicitly opens the inbox/auto dialog.
create function public.notification_inbox(
  p_before timestamptz default null, p_before_id uuid default null,
  p_unread_only boolean default false, p_limit integer default 20
)
returns table (id uuid, title text, content text, type text, target_role text, published_at timestamptz, read_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select n.id, n.title, n.content, n.type, n.target_role, n.published_at, r.read_at
  from public.system_notifications n
  left join public.user_notification_reads r on r.notification_id = n.id and r.user_id = (select auth.uid())
  where n.status = 'published' and n.published_at <= now()
    and (not p_unread_only or r.notification_id is null)
    and (p_before is null or (n.published_at, n.id) < (p_before, p_before_id))
  order by n.published_at desc, n.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke all on function public.notification_unread_count() from public, anon;
revoke all on function public.notification_inbox(timestamptz, uuid, boolean, integer) from public, anon;
grant execute on function public.notification_unread_count() to authenticated;
grant execute on function public.notification_inbox(timestamptz, uuid, boolean, integer) to authenticated;

commit;
