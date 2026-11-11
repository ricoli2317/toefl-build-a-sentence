-- MANUAL additive upgrade after system_notifications_20261110.sql.
-- Execute in SQL Editor before deploying the accompanying application code.
-- No UPDATE/DELETE of existing notifications/reads, no recipient fan-out,
-- no R2 changes and no new Storage bucket/policy. Existing text remains text.
begin;

alter table public.system_notifications
  add column content_document jsonb,
  add column admin_deleted_at timestamptz,
  add constraint notification_document_shape check (content_document is null or coalesce((
    jsonb_typeof(content_document) = 'object' and content_document->>'type' = 'doc'
    and jsonb_typeof(content_document->'content') = 'array' and octet_length(content_document::text) <= 150000
  ), false));
create index system_notifications_admin_visible_idx
  on public.system_notifications(created_at desc, id desc) where admin_deleted_at is null;

-- Metadata ONLY. No image bytes, HTML, data URLs or base64 in PostgreSQL.
create table public.notification_image_assets (
  id uuid primary key,
  object_key text not null unique check (object_key ~ '^notifications/[0-9a-f-]{36}\.(png|jpg|webp)$'),
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  uploaded_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '720 hours'),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 3145728)
);
create index notification_image_assets_uploader_idx on public.notification_image_assets(uploaded_by);
alter table public.notification_image_assets enable row level security;
revoke all on public.notification_image_assets from public, anon, authenticated;
grant select, insert on public.notification_image_assets to authenticated;
grant select on public.notification_image_assets to service_role;
create policy notification_image_assets_admin_select on public.notification_image_assets for select to authenticated
using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active));
create policy notification_image_assets_admin_insert on public.notification_image_assets for insert to authenticated
with check (uploaded_by = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_active
));
create function public.stamp_notification_image_asset()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.uploaded_by := auth.uid();
  new.uploaded_at := clock_timestamp();
  new.expires_at := new.uploaded_at + interval '720 hours';
  if split_part(split_part(new.object_key, '/', 2), '.', 1) <> new.id::text then
    raise exception 'NOTIFICATION_IMAGE_KEY_MISMATCH';
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_notification_image_asset() from public, anon, authenticated;
create trigger notification_image_asset_stamp before insert on public.notification_image_assets
for each row execute function public.stamp_notification_image_asset();

create function public.notification_document_image_ids(p_document jsonb)
returns table (image_id uuid) language sql immutable security invoker set search_path = '' as $$
  with recursive nodes(value) as (
    select p_document
    union all
    select child from nodes cross join lateral jsonb_array_elements(
      case when jsonb_typeof(value->'content') = 'array' then value->'content' else '[]'::jsonb end
    ) child
  )
  select distinct case when value->'attrs'->>'imageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (value->'attrs'->>'imageId')::uuid else null end
  from nodes where value->>'type' = 'image';
$$;
revoke all on function public.notification_document_image_ids(jsonb) from public, anon;
grant execute on function public.notification_document_image_ids(jsonb) to authenticated;

-- Replace ONLY the notification lifecycle helper. Existing trigger is reused.
create or replace function public.enforce_system_notification_lifecycle()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'NOTIFICATION_DRAFT_REQUIRED'; end if;
    new.created_by := auth.uid();
    new.created_at := clock_timestamp();
    new.published_at := null;
    new.withdrawn_at := null;
    new.admin_deleted_at := null;
  else
    if new.id is distinct from old.id or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at then raise exception 'NOTIFICATION_IDENTITY_IMMUTABLE'; end if;
    if old.admin_deleted_at is not null then raise exception 'NOTIFICATION_ADMIN_DELETED'; end if;
    if new.admin_deleted_at is not null then
      -- Soft delete is independent of delivery/withdrawal and changes NO payload.
      if (to_jsonb(new) - 'admin_deleted_at' - 'updated_at') is distinct from
         (to_jsonb(old) - 'admin_deleted_at' - 'updated_at') then raise exception 'NOTIFICATION_DELETE_PAYLOAD_IMMUTABLE'; end if;
      new.admin_deleted_at := clock_timestamp();
    else
      if old.status <> 'draft' and (new.title is distinct from old.title or new.content is distinct from old.content
        or new.content_document is distinct from old.content_document or new.type is distinct from old.type
        or new.target_role is distinct from old.target_role) then raise exception 'NOTIFICATION_PUBLISHED_IMMUTABLE'; end if;
      if old.status = 'withdrawn' or (old.status = 'published' and new.status <> 'withdrawn')
        or (old.status = 'draft' and new.status not in ('draft', 'published')) then raise exception 'NOTIFICATION_INVALID_TRANSITION'; end if;
      if old.status = 'draft' and new.status = 'published' then
        if exists (select 1 from public.notification_document_image_ids(new.content_document) refs
          left join public.notification_image_assets a on a.id = refs.image_id
          where a.id is null or a.expires_at <= clock_timestamp()) then raise exception 'NOTIFICATION_IMAGE_EXPIRED'; end if;
        new.published_at := clock_timestamp();
      else new.published_at := old.published_at;
      end if;
      new.withdrawn_at := case when new.status = 'withdrawn' then clock_timestamp() else null end;
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- Atomic create+optional publish: any error rolls back the entire new row.
-- Caller JWT and existing Admin RLS are retained (no SECURITY DEFINER bypass).
create function public.admin_create_system_notification(
  p_title text, p_content text, p_type text, p_target_role text,
  p_document jsonb default null, p_publish boolean default false
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare notification_id uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and is_active) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  insert into public.system_notifications(title,content,type,target_role,content_document)
  values(p_title,p_content,p_type,p_target_role,p_document) returning id into notification_id;
  if p_publish then update public.system_notifications set status = 'published' where id = notification_id; end if;
  return notification_id;
end;
$$;
revoke all on function public.admin_create_system_notification(text,text,text,text,jsonb,boolean) from public, anon;
grant execute on function public.admin_create_system_notification(text,text,text,text,jsonb,boolean) to authenticated;

-- New lightweight list RPC. Keep the old RPC intact for the currently deployed
-- app until the new code is deployed. Soft deletion is deliberately NOT filtered
-- here or in recipient RLS: published content remains available to eligible users.
create function public.notification_inbox_titles(
  p_before timestamptz default null, p_before_id uuid default null,
  p_unread_only boolean default false, p_limit integer default 20
)
returns table(id uuid,title text,type text,published_at timestamptz,read_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select n.id,n.title,n.type,n.published_at,r.read_at from public.system_notifications n
  left join public.user_notification_reads r on r.notification_id = n.id and r.user_id = (select auth.uid())
  where n.status = 'published' and n.published_at <= now() and (not p_unread_only or r.notification_id is null)
    and (p_before is null or (n.published_at,n.id) < (p_before,p_before_id))
  order by n.published_at desc,n.id desc limit greatest(1,least(coalesce(p_limit,20),50));
$$;
revoke all on function public.notification_inbox_titles(timestamptz,uuid,boolean,integer) from public, anon;
grant execute on function public.notification_inbox_titles(timestamptz,uuid,boolean,integer) to authenticated;

-- No DELETE grant/policy is added, even for drafts. All Admin deletion is soft,
-- so the existing reads FK cascade can NEVER be invoked by this feature.
-- Delivery stays the existing dynamic-role model; no fictional user snapshots.
commit;
