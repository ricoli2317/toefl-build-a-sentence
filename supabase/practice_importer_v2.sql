-- Step 10 only: future imports. This migration does not backfill or renumber existing items.
create extension if not exists pgcrypto;

create table if not exists public.practice_import_review_queue (
  review_id uuid primary key default gen_random_uuid(),
  task_type text not null check (task_type in ('build_sentence', 'email', 'academic_discussion')),
  source_set_id text,
  source_question_id text,
  candidate_item_id uuid references public.practice_items(item_id) on delete set null,
  candidate_item_ids jsonb not null default '[]'::jsonb,
  similarity_summary jsonb not null default '{}'::jsonb,
  occurrences jsonb not null default '[]'::jsonb,
  content_fingerprint text not null,
  normalization_version integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'resolved_merge', 'resolved_new')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (
    (task_type = 'build_sentence' and source_set_id is not null and source_question_id is null)
    or
    (task_type in ('email', 'academic_discussion') and source_set_id is null and source_question_id is not null)
  )
);
alter table public.practice_import_review_queue
  add column if not exists occurrences jsonb not null default '[]'::jsonb;

create table if not exists public.practice_item_number_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.practice_items(item_id) on delete restrict,
  task_type text not null check (task_type in ('build_sentence', 'email', 'academic_discussion')),
  old_display_number text not null check (old_display_number ~ '^[0-9]{3,}[A-Z]*$'),
  new_display_number text not null check (new_display_number ~ '^[0-9]{3,}[A-Z]*$'),
  reason text not null check (
    reason in ('historical_new_item_insert', 'earlier_duplicate_occurrence', 'local_resequence')
  ),
  changed_at timestamptz not null default now(),
  check (old_display_number <> new_display_number)
);
create index if not exists practice_item_number_history_item_changed_idx
  on public.practice_item_number_history (item_id, changed_at desc);
create index if not exists practice_item_number_history_reserved_idx
  on public.practice_item_number_history (task_type, old_display_number);

alter table public.practice_item_number_history enable row level security;

create unique index if not exists practice_item_sources_set_identity_uidx
  on public.practice_item_sources (task_type, source_set_id)
  where source_set_id is not null;
create unique index if not exists practice_item_sources_question_identity_uidx
  on public.practice_item_sources (task_type, source_question_id)
  where source_question_id is not null;
create unique index if not exists practice_item_sources_one_canonical_uidx
  on public.practice_item_sources (item_id)
  where is_canonical;
create unique index if not exists practice_item_occurrences_identity_uidx
  on public.practice_item_occurrences (source_id, occurred_on, coalesce(source_label, ''));
create unique index if not exists practice_item_question_map_source_question_uidx
  on public.practice_item_question_map (source_id, source_question_id);
create unique index if not exists practice_item_question_map_source_logical_uidx
  on public.practice_item_question_map (source_id, logical_question_order);
create unique index if not exists practice_import_review_queue_set_uidx
  on public.practice_import_review_queue (task_type, source_set_id)
  where source_set_id is not null and status = 'pending';
create unique index if not exists practice_import_review_queue_question_uidx
  on public.practice_import_review_queue (task_type, source_question_id)
  where source_question_id is not null and status = 'pending';
create index if not exists practice_import_review_queue_status_created_idx
  on public.practice_import_review_queue (status, created_at desc);

alter table public.practice_import_review_queue enable row level security;

create or replace function public.practice_import_excel_suffix(p_value integer)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_value integer := p_value;
  v_suffix text := '';
begin
  if v_value < 1 then
    raise exception 'suffix index must be positive';
  end if;
  while v_value > 0 loop
    v_value := v_value - 1;
    v_suffix := chr(65 + (v_value % 26)) || v_suffix;
    v_value := v_value / 26;
  end loop;
  return v_suffix;
end;
$$;

create or replace function public.practice_import_suffix_rank(p_suffix text)
returns integer
language plpgsql
immutable
strict
as $$
declare
  v_rank integer := 0;
  v_index integer;
  v_character text;
begin
  if p_suffix !~ '^[A-Z]*$' then
    raise exception 'Invalid display_number suffix: %', p_suffix;
  end if;
  if p_suffix = '' then
    return 0;
  end if;
  for v_index in 1..length(p_suffix) loop
    v_character := substr(p_suffix, v_index, 1);
    v_rank := v_rank * 26 + ascii(v_character) - 64;
  end loop;
  return v_rank;
end;
$$;

create or replace function public.practice_import_display_base(p_display_number text)
returns integer
language sql
immutable
strict
as $$
  select (regexp_match(p_display_number, '^([0-9]{3,})[A-Z]*$'))[1]::integer;
$$;

create or replace function public.practice_import_display_suffix_rank(p_display_number text)
returns integer
language sql
immutable
strict
as $$
  select public.practice_import_suffix_rank(
    coalesce((regexp_match(p_display_number, '^[0-9]{3,}([A-Z]*)$'))[1], '')
  );
$$;

create or replace function public.practice_import_compare_display_numbers(
  p_left text,
  p_right text
)
returns integer
language sql
immutable
strict
as $$
  select case
    when public.practice_import_display_base(p_left) < public.practice_import_display_base(p_right) then -1
    when public.practice_import_display_base(p_left) > public.practice_import_display_base(p_right) then 1
    when public.practice_import_display_suffix_rank(p_left) < public.practice_import_display_suffix_rank(p_right) then -1
    when public.practice_import_display_suffix_rank(p_left) > public.practice_import_display_suffix_rank(p_right) then 1
    else 0
  end;
$$;

create or replace function public.practice_import_allocate_display_number(
  p_task_type text,
  p_first_seen_date date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest_date date;
  v_number integer;
  v_anchor integer;
  v_suffix_index integer := 1;
  v_candidate text;
begin
  if p_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    raise exception 'Unsupported task_type: %', p_task_type;
  end if;
  if p_first_seen_date is null then
    raise exception 'first_seen_date is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('practice-import-number:' || p_task_type, 0));
  select max(first_seen_date) into v_latest_date
  from public.practice_items
  where task_type = p_task_type and display_number is not null;

  if v_latest_date is null or p_first_seen_date >= v_latest_date then
    select coalesce(max(public.practice_import_display_base(display_number)), 0) + 1 into v_number
    from public.practice_items
    where task_type = p_task_type;
    loop
      v_candidate := lpad(v_number::text, 3, '0');
      exit when not exists (
        select 1 from public.practice_items
        where task_type = p_task_type and display_number = v_candidate
      ) and not exists (
        select 1 from public.practice_item_number_history
        where task_type = p_task_type and old_display_number = v_candidate
      );
      v_number := v_number + 1;
    end loop;
    return v_candidate;
  end if;

  select coalesce(max(public.practice_import_display_base(display_number)), 0) into v_anchor
  from public.practice_items
  where task_type = p_task_type
    and first_seen_date <= p_first_seen_date
    and public.practice_import_display_suffix_rank(display_number) = 0;

  loop
    v_candidate := lpad(v_anchor::text, 3, '0') || public.practice_import_excel_suffix(v_suffix_index);
    exit when not exists (
      select 1 from public.practice_items
      where task_type = p_task_type and display_number = v_candidate
    ) and not exists (
      select 1 from public.practice_item_number_history
      where task_type = p_task_type and old_display_number = v_candidate
    );
    v_suffix_index := v_suffix_index + 1;
  end loop;
  return v_candidate;
end;
$$;

create or replace function public.reconcile_practice_item_numbers_v2(
  p_task_type text,
  p_affected_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base integer;
  v_previous_rank integer;
  v_rank integer;
  v_candidate text;
  v_temp_base integer;
  v_temp_index integer := 0;
  v_member record;
  v_change_count integer := 0;
begin
  if p_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    raise exception 'Unsupported task_type: %', p_task_type;
  end if;
  if jsonb_typeof(p_affected_items) <> 'array' then
    raise exception 'p_affected_items must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('practice-import-number:' || p_task_type, 0));

  create temporary table _practice_import_affected (
    item_id uuid primary key,
    reason text not null
  ) on commit drop;
  insert into _practice_import_affected (item_id, reason)
  select
    (value->>'item_id')::uuid,
    value->>'reason'
  from jsonb_array_elements(p_affected_items)
  where value->>'reason' in ('historical_new_item_insert', 'earlier_duplicate_occurrence')
  on conflict (item_id) do update
  set reason = case
    when excluded.reason = 'earlier_duplicate_occurrence' then excluded.reason
    else _practice_import_affected.reason
  end;

  create temporary table _practice_import_items on commit drop as
  select
    item_id,
    display_number,
    first_seen_date,
    public.practice_import_display_base(display_number) as display_base,
    public.practice_import_display_suffix_rank(display_number) as suffix_rank
  from public.practice_items
  where task_type = p_task_type and display_number is not null;
  create unique index on _practice_import_items (item_id);
  create unique index on _practice_import_items (display_number);

  create temporary table _practice_import_moving (
    item_id uuid primary key,
    reason text not null,
    target_base integer
  ) on commit drop;
  insert into _practice_import_moving (item_id, reason)
  select item.item_id, affected.reason
  from _practice_import_items item
  join _practice_import_affected affected using (item_id)
  where exists (
    select 1
    from _practice_import_items earlier
    where earlier.first_seen_date < item.first_seen_date
      and public.practice_import_compare_display_numbers(
        earlier.display_number,
        item.display_number
      ) >= 0
  ) or exists (
    select 1
    from _practice_import_items later
    where later.first_seen_date > item.first_seen_date
      and public.practice_import_compare_display_numbers(
        later.display_number,
        item.display_number
      ) <= 0
  );

  update _practice_import_moving moving
  set target_base = coalesce((
    select anchor.display_base
    from _practice_import_items anchor
    where anchor.suffix_rank = 0
      and not exists (
        select 1 from _practice_import_moving displaced
        where displaced.item_id = anchor.item_id
      )
      and (
        anchor.first_seen_date < item.first_seen_date
        or (
          anchor.first_seen_date = item.first_seen_date
          and public.practice_import_compare_display_numbers(
            anchor.display_number,
            item.display_number
          ) < 0
        )
      )
    order by anchor.first_seen_date desc, anchor.display_base desc, anchor.item_id
    limit 1
  ), 0)
  from _practice_import_items item
  where item.item_id = moving.item_id;

  create temporary table _practice_import_number_plan (
    item_id uuid primary key,
    old_display_number text not null,
    new_display_number text not null,
    reason text not null,
    temporary_display_number text
  ) on commit drop;

  for v_base in
    select distinct target_base
    from _practice_import_moving
    order by target_base
  loop
    v_previous_rank := 0;
    for v_member in
      select members.*
      from (
        select
          item.item_id,
          item.display_number,
          item.first_seen_date,
          item.display_base,
          item.suffix_rank,
          false as is_moving,
          'local_resequence'::text as reason
        from _practice_import_items item
        where item.display_base = v_base
          and item.suffix_rank > 0
          and not exists (
            select 1 from _practice_import_moving moving
            where moving.item_id = item.item_id
          )
        union all
        select
          item.item_id,
          item.display_number,
          item.first_seen_date,
          item.display_base,
          item.suffix_rank,
          true as is_moving,
          moving.reason
        from _practice_import_items item
        join _practice_import_moving moving using (item_id)
        where moving.target_base = v_base
      ) members
      order by
        members.first_seen_date,
        members.display_base,
        members.suffix_rank,
        members.item_id
    loop
      v_rank := case
        when v_member.is_moving then v_previous_rank + 1
        else greatest(v_previous_rank + 1, v_member.suffix_rank)
      end;
      loop
        v_candidate := lpad(v_base::text, 3, '0') || public.practice_import_excel_suffix(v_rank);
        exit when not exists (
          select 1
          from public.practice_item_number_history history
          where history.task_type = p_task_type
            and history.old_display_number = v_candidate
            and not exists (
              select 1 from _practice_import_items current_item
              where current_item.display_number = v_candidate
            )
        );
        v_rank := v_rank + 1;
      end loop;

      if v_candidate <> v_member.display_number then
        insert into _practice_import_number_plan (
          item_id, old_display_number, new_display_number, reason
        ) values (
          v_member.item_id,
          v_member.display_number,
          v_candidate,
          v_member.reason
        );
      end if;
      v_previous_rank := v_rank;
    end loop;
  end loop;

  select coalesce(max(display_base), 0) + 1000000 into v_temp_base
  from _practice_import_items;
  for v_member in
    select * from _practice_import_number_plan order by old_display_number, item_id
  loop
    v_temp_index := v_temp_index + 1;
    update _practice_import_number_plan
    set temporary_display_number =
      lpad(v_temp_base::text, 3, '0') || 'TMP' || public.practice_import_excel_suffix(v_temp_index)
    where item_id = v_member.item_id;
  end loop;

  update public.practice_items item
  set display_number = plan.temporary_display_number
  from _practice_import_number_plan plan
  where item.item_id = plan.item_id;

  update public.practice_items item
  set display_number = plan.new_display_number
  from _practice_import_number_plan plan
  where item.item_id = plan.item_id;

  insert into public.practice_item_number_history (
    item_id, task_type, old_display_number, new_display_number, reason
  )
  select item_id, p_task_type, old_display_number, new_display_number, reason
  from _practice_import_number_plan;
  get diagnostics v_change_count = row_count;

  return jsonb_build_object('changes', v_change_count);
end;
$$;

create or replace function public.queue_practice_import_review_v2(
  p_task_type text,
  p_source_set_id text,
  p_source_question_id text,
  p_candidate_item_id uuid,
  p_candidate_item_ids jsonb,
  p_similarity_summary jsonb,
  p_occurrences jsonb,
  p_content_fingerprint text,
  p_normalization_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review_id uuid;
  v_created boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'practice-import-source:' || p_task_type || ':' || coalesce(p_source_set_id, p_source_question_id), 0
  ));

  select review_id into v_review_id
  from public.practice_import_review_queue
  where task_type = p_task_type
    and source_set_id is not distinct from p_source_set_id
    and source_question_id is not distinct from p_source_question_id
    and status = 'pending'
  limit 1;

  if v_review_id is null then
    v_review_id := gen_random_uuid();
    insert into public.practice_import_review_queue (
      review_id, task_type, source_set_id, source_question_id, candidate_item_id,
      candidate_item_ids, similarity_summary, occurrences, content_fingerprint, normalization_version
    ) values (
      v_review_id, p_task_type, p_source_set_id, p_source_question_id, p_candidate_item_id,
      coalesce(p_candidate_item_ids, '[]'::jsonb), coalesce(p_similarity_summary, '{}'::jsonb),
      coalesce(p_occurrences, '[]'::jsonb),
      p_content_fingerprint, p_normalization_version
    );
    v_created := true;
  end if;

  return jsonb_build_object('review_id', v_review_id, 'created', v_created);
end;
$$;

create or replace function public.finalize_practice_import_v2(
  p_task_type text,
  p_classification text,
  p_source_set_id text,
  p_source_question_id text,
  p_candidate_item_id uuid,
  p_content_fingerprint text,
  p_normalization_version integer,
  p_first_seen_date date,
  p_display_title text,
  p_occurrences jsonb,
  p_question_map jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  v_source_id uuid;
  v_display_number text;
  v_created_item boolean := false;
  v_created_source boolean := false;
  v_occurrence_count integer := 0;
  v_inserted integer;
  v_occurrence jsonb;
  v_map jsonb;
  v_map_count integer;
  v_source_order_count integer;
  v_logical_order_count integer;
  v_first_seen_before date;
  v_first_seen_after date;
begin
  if p_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    raise exception 'Unsupported task_type: %', p_task_type;
  end if;
  if p_classification not in ('AUTO_MERGE', 'NEW_ITEM') then
    raise exception 'Unsupported classification: %', p_classification;
  end if;
  if (p_task_type = 'build_sentence' and (p_source_set_id is null or p_source_question_id is not null))
     or (p_task_type <> 'build_sentence' and (p_source_set_id is null or p_source_question_id is null)) then
    raise exception 'Invalid source identity for task_type %', p_task_type;
  end if;
  if jsonb_typeof(p_occurrences) <> 'array' or jsonb_array_length(p_occurrences) = 0 then
    raise exception 'At least one occurrence is required';
  end if;
  if p_task_type = 'build_sentence' and p_display_title is not null then
    raise exception 'Build a Sentence display_title must be null';
  end if;
  if p_task_type in ('email', 'academic_discussion') and nullif(btrim(p_display_title), '') is null
     and p_classification = 'NEW_ITEM' then
    raise exception 'A title is required for new writing items';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'practice-import-source:' || p_task_type || ':' || coalesce(p_source_set_id, p_source_question_id), 0
  ));

  select source_id, item_id into v_source_id, v_item_id
  from public.practice_item_sources
  where task_type = p_task_type
    and (
      (p_task_type = 'build_sentence' and source_set_id = p_source_set_id)
      or
      (p_task_type <> 'build_sentence' and source_question_id = p_source_question_id)
    )
  limit 1;

  if v_source_id is null then
    if p_classification = 'AUTO_MERGE' then
      if p_candidate_item_id is null or not exists (
        select 1 from public.practice_items where item_id = p_candidate_item_id and task_type = p_task_type
      ) then
        raise exception 'AUTO_MERGE candidate item is missing or invalid';
      end if;
      v_item_id := p_candidate_item_id;
    else
      perform pg_advisory_xact_lock(hashtextextended(
        'practice-import-fingerprint:' || p_task_type || ':' || p_content_fingerprint, 0
      ));
      select item_id into v_item_id
      from public.practice_item_sources
      where task_type = p_task_type and content_fingerprint = p_content_fingerprint
      order by is_canonical desc, created_at, source_id
      limit 1;

      if v_item_id is not null and p_task_type = 'build_sentence' then
        raise exception using
          errcode = '40001',
          message = 'Concurrent identical BAS source detected; retry import to build canonical question mapping';
      end if;

      if v_item_id is null then
        v_display_number := public.practice_import_allocate_display_number(p_task_type, p_first_seen_date);
        v_item_id := gen_random_uuid();
        insert into public.practice_items (
          item_id, task_type, display_number, display_title, first_seen_date, is_active
        ) values (
          v_item_id, p_task_type, v_display_number,
          case when p_task_type = 'build_sentence' then null else p_display_title end,
          p_first_seen_date, true
        );
        v_created_item := true;
      end if;
    end if;

    v_source_id := gen_random_uuid();
    insert into public.practice_item_sources (
      source_id, item_id, task_type, source_set_id, source_question_id,
      content_fingerprint, normalization_version, is_canonical
    ) values (
      v_source_id, v_item_id, p_task_type, p_source_set_id, p_source_question_id,
      p_content_fingerprint, p_normalization_version, v_created_item
    );
    v_created_source := true;
  end if;

  select first_seen_date into v_first_seen_before
  from public.practice_items
  where item_id = v_item_id;

  for v_occurrence in select value from jsonb_array_elements(p_occurrences) loop
    insert into public.practice_item_occurrences (occurrence_id, source_id, occurred_on, source_label)
    select gen_random_uuid(), v_source_id,
      (v_occurrence->>'occurred_on')::date,
      nullif(v_occurrence->>'source_label', '')
    where not exists (
      select 1 from public.practice_item_occurrences existing
      where existing.source_id = v_source_id
        and existing.occurred_on = (v_occurrence->>'occurred_on')::date
        and coalesce(existing.source_label, '') = coalesce(v_occurrence->>'source_label', '')
    );
    get diagnostics v_inserted = row_count;
    v_occurrence_count := v_occurrence_count + v_inserted;
  end loop;

  if p_task_type = 'build_sentence' then
    if jsonb_typeof(p_question_map) <> 'array' or jsonb_array_length(p_question_map) <> 10 then
      raise exception 'A formal BAS source requires exactly 10 question-map rows';
    end if;
    select
      count(distinct value->>'source_question_id'),
      count(distinct (value->>'source_question_order')::integer),
      count(distinct (value->>'logical_question_order')::integer)
    into v_map_count, v_source_order_count, v_logical_order_count
    from jsonb_array_elements(p_question_map)
    where (value->>'source_question_order')::integer between 1 and 10
      and (value->>'logical_question_order')::integer between 1 and 10;
    if v_map_count <> 10 or v_source_order_count <> 10 or v_logical_order_count <> 10 then
      raise exception 'BAS question map must contain distinct source/logical orders 1-10';
    end if;

    for v_map in select value from jsonb_array_elements(p_question_map) loop
      insert into public.practice_item_question_map (
        map_id, source_id, source_question_id, source_question_order,
        logical_question_order, question_fingerprint
      )
      select gen_random_uuid(), v_source_id,
        v_map->>'source_question_id',
        (v_map->>'source_question_order')::integer,
        (v_map->>'logical_question_order')::integer,
        v_map->>'question_fingerprint'
      where not exists (
        select 1 from public.practice_item_question_map existing
        where existing.source_id = v_source_id
          and existing.source_question_id = v_map->>'source_question_id'
      );
    end loop;
  end if;

  select first_seen_date into v_first_seen_after
  from public.practice_items
  where item_id = v_item_id;

  return jsonb_build_object(
    'item_id', v_item_id,
    'source_id', v_source_id,
    'created_item', v_created_item,
    'created_source', v_created_source,
    'occurrences_inserted', v_occurrence_count,
    'first_seen_before', v_first_seen_before,
    'first_seen_after', v_first_seen_after
  );
end;
$$;

revoke all on function public.practice_import_allocate_display_number(text, date) from public, anon, authenticated;
revoke all on function public.reconcile_practice_item_numbers_v2(text, jsonb) from public, anon, authenticated;
revoke all on function public.queue_practice_import_review_v2(text, text, text, uuid, jsonb, jsonb, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.finalize_practice_import_v2(text, text, text, text, uuid, text, integer, date, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_practice_item_numbers_v2(text, jsonb) to service_role;
grant execute on function public.queue_practice_import_review_v2(text, text, text, uuid, jsonb, jsonb, jsonb, text, integer) to service_role;
grant execute on function public.finalize_practice_import_v2(text, text, text, text, uuid, text, integer, date, text, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
