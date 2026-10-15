-- Manual install only. Exactly two new independent tables. No legacy writes.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
create schema ctw_vocab_private;
revoke all on schema ctw_vocab_private from public, anon, authenticated, service_role;

-- Storage validation, NOT spelling grading. Array order and original strings
-- are retained in JSONB. Definer privileges are not needed by these helpers.
create function ctw_vocab_private.valid_content(senses jsonb, forms jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; f jsonb; a jsonb; types text[] := '{}';
begin
  if jsonb_typeof(senses) is distinct from 'array' or jsonb_typeof(forms) is distinct from 'array' then return false; end if;
  if jsonb_array_length(senses) not between 1 and 100 then return false; end if;
  for s in select value from jsonb_array_elements(senses) loop
    if jsonb_typeof(s) is distinct from 'object' then return false; end if;
    if not s ?& array['pos','meaning_zh','example_en']
      or (select count(*) from jsonb_object_keys(s)) <> 3
      or jsonb_typeof(s->'pos') is distinct from 'string'
      or s->>'pos' not in ('noun','verb','adjective','adverb','preposition','determiner','pronoun','conjunction','particle','numeral')
      or jsonb_typeof(s->'meaning_zh') is distinct from 'string'
      or jsonb_typeof(s->'example_en') is distinct from 'string'
      or length(btrim(s->>'meaning_zh')) = 0 or length(btrim(s->>'example_en')) = 0 then return false; end if;
  end loop;
  for f in select value from jsonb_array_elements(forms) loop
    if jsonb_typeof(f) is distinct from 'object' then return false; end if;
    if not f ?& array['form_type','answers'] or (select count(*) from jsonb_object_keys(f)) <> 2
      or jsonb_typeof(f->'form_type') is distinct from 'string'
      or f->>'form_type' not in ('past','past_participle','plural','comparative','superlative',
        'present_third_person_singular','present_first_person_singular','present_second_person_or_plural',
        'past_first_or_third_person_singular','past_second_person_or_plural','past_modal')
      or (f->>'form_type') = any(types) or jsonb_typeof(f->'answers') is distinct from 'array' then return false; end if;
    types := array_append(types,f->>'form_type');
    if jsonb_array_length(f->'answers') not between 1 and 20
      or (select count(distinct value) from jsonb_array_elements(f->'answers')) <> jsonb_array_length(f->'answers') then return false; end if;
    for a in select value from jsonb_array_elements(f->'answers') loop
      if jsonb_typeof(a) is distinct from 'string' or length(a#>>'{}') > 200
        or (a#>>'{}') !~ '^[A-Za-z]+([-'' ][A-Za-z]+)*$' then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;
revoke all on function ctw_vocab_private.valid_content(jsonb,jsonb) from public, anon, authenticated, service_role;

create table public.ctw_vocabulary_entries (
  entry_id uuid primary key default gen_random_uuid(),
  word text not null check (length(word) <= 200 and word ~ '^[A-Za-z]+([-'' ][A-Za-z]+)*$'),
  normalized_word text generated always as (lower(word)) stored unique,
  list_number integer not null check (list_number between 1 and 1000000),
  list_position smallint not null check (list_position between 1 and 50),
  cefr text not null check (cefr in ('A1','A2','B1','B2','C1','C2')),
  senses jsonb not null,
  irregular_forms jsonb not null,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(list_number,list_position),
  check (ctw_vocab_private.valid_content(senses,irregular_forms))
);
create index ctw_vocabulary_cefr_order_idx on public.ctw_vocabulary_entries(cefr,list_number,list_position);

create table public.student_ctw_vocabulary_attempts (
  student_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  mode text not null check (mode in ('base_form','irregular')),
  submitted_at timestamptz not null default now(),
  answer_count smallint not null check (answer_count between 1 and 200),
  correct_count smallint not null check (correct_count between 0 and answer_count),
  list_numbers integer[] not null,
  cefr_levels text[] not null,
  request_answers jsonb not null check (jsonb_typeof(request_answers)='array' and jsonb_array_length(request_answers)=answer_count),
  answers jsonb not null check (jsonb_typeof(answers)='array' and jsonb_array_length(answers)=answer_count),
  primary key(student_id,attempt_id)
);
create index student_ctw_vocab_history_idx on public.student_ctw_vocabulary_attempts(student_id,submitted_at desc,attempt_id desc);

alter table public.ctw_vocabulary_entries enable row level security;
alter table public.student_ctw_vocabulary_attempts enable row level security;
-- Match existing Student Experience: Teacher/Admin practice is self-owned too.
create policy ctw_vocab_active_read on public.ctw_vocabulary_entries for select to authenticated using (
  (select exists(select 1 from public.profiles where id=(select auth.uid())
    and is_active and role::text in ('student','teacher','admin')))
);
create policy ctw_vocab_own_results on public.student_ctw_vocabulary_attempts for select to authenticated using (
  student_id=(select auth.uid()) and
  (select exists(select 1 from public.profiles where id=(select auth.uid())
    and is_active and role::text in ('student','teacher','admin')))
);
revoke all on public.ctw_vocabulary_entries, public.student_ctw_vocabulary_attempts from public,anon,authenticated,service_role;
grant select on public.ctw_vocabulary_entries, public.student_ctw_vocabulary_attempts to authenticated, service_role;
-- API authenticates, loads one batch of entries, grades in JS and INSERTs once.
-- Browser/anon cannot insert, update, delete or forge a result through PostgREST.
grant insert on public.student_ctw_vocabulary_attempts to service_role;

-- Lightweight directory only; no attempt-table access, no whole-library transfer.
create function public.read_ctw_vocabulary_catalog_v1()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'total',(select count(*) from public.ctw_vocabulary_entries),
    'lists',coalesce((select jsonb_agg(jsonb_build_object('listNumber',list_number,'count',n,'irregularCount',irregular_n) order by list_number)
      from (select list_number,count(*) n,count(*) filter(where jsonb_array_length(irregular_forms)>0) irregular_n
        from public.ctw_vocabulary_entries group by list_number) g),'[]'::jsonb),
    'cefr',coalesce((select jsonb_agg(jsonb_build_object('level',cefr,'count',n) order by cefr)
      from (select cefr,count(*) n from public.ctw_vocabulary_entries group by cefr) g),'[]'::jsonb)
  );
$$;
revoke all on function public.read_ctw_vocabulary_catalog_v1() from public,anon,authenticated,service_role;
grant execute on function public.read_ctw_vocabulary_catalog_v1() to authenticated;
notify pgrst,'reload schema';
commit;
