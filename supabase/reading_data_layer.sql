-- TPS Reading data layer: CTW, RDL, and RAP.
-- Safe to run in the Supabase SQL Editor after the base TPS schema.

create table if not exists public.reading_logical_items (
  logical_item_id text primary key,
  module text not null check (module in ('ctw', 'rdl', 'rap')),
  title text,
  first_seen_date date not null,
  first_seen_source_label text not null,
  first_seen_source_order integer not null check (first_seen_source_order > 0),
  dedup_fingerprint text not null unique check (dedup_fingerprint ~ '^[a-f0-9]{64}$'),
  question_count integer not null check (question_count >= 0),
  scored_item_count integer not null check (scored_item_count >= question_count),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_logical_item_title_check check (
    (module = 'ctw' and title is null)
    or (module in ('rdl', 'rap') and nullif(btrim(title), '') is not null)
  )
);

create table if not exists public.reading_source_occurrences (
  occurrence_id text primary key,
  logical_item_id text not null references public.reading_logical_items(logical_item_id) on delete cascade,
  source_kind text not null,
  source_label text not null,
  occurrence_date date not null,
  year_month text not null check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source_question_file text not null,
  source_answer_file text not null,
  source_module text not null check (source_module in ('m1', 'm2')),
  source_order integer not null check (source_order > 0),
  source_question_start integer not null check (source_question_start > 0),
  source_question_end integer not null check (source_question_end >= source_question_start),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_kind, source_label, source_module, source_order),
  unique (occurrence_id, logical_item_id),
  check (year_month = left(occurrence_date::text, 7))
);

create table if not exists public.reading_materials (
  material_id text primary key,
  title text,
  material_type text not null check (material_type in (
    'advertisement', 'agenda', 'announcement', 'article', 'blog_post',
    'course_description', 'course_syllabus', 'email', 'email_exchange', 'flyer',
    'following_notice', 'form', 'instructions', 'label', 'message_exchange',
    'newspaper_article', 'notice', 'online_discussion', 'poster', 'review',
    'schedule', 'sign', 'social_media_post', 'student_magazine_article',
    'student_newspaper_article', 'syllabus', 'syllabus_excerpt', 'text_chain',
    'text_message_chain', 'travel_flyer', 'webpage'
  )),
  source text not null,
  source_date date,
  year_month text not null check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  binding_status text not null check (binding_status in ('bound', 'pending')),
  image_asset_path text,
  hitbox_data_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_material_binding_check check (
    (binding_status = 'bound' and nullif(btrim(image_asset_path), '') is not null
      and nullif(btrim(hitbox_data_path), '') is not null)
    or
    (binding_status = 'pending' and image_asset_path is null and hitbox_data_path is null)
  )
);

create table if not exists public.reading_passages (
  passage_id text primary key,
  logical_item_id text not null unique references public.reading_logical_items(logical_item_id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reading_passage_paragraphs (
  passage_id text not null references public.reading_passages(passage_id) on delete cascade,
  paragraph_id text not null,
  paragraph_order integer not null check (paragraph_order > 0),
  paragraph_text text not null,
  raw_text text not null,
  primary key (passage_id, paragraph_id),
  unique (passage_id, paragraph_order)
);

create table if not exists public.reading_passage_sentences (
  passage_id text not null,
  paragraph_id text not null,
  sentence_id text not null,
  sentence_order integer not null check (sentence_order > 0),
  sentence_text text not null,
  primary key (passage_id, sentence_id),
  unique (passage_id, paragraph_id, sentence_order),
  foreign key (passage_id, paragraph_id)
    references public.reading_passage_paragraphs(passage_id, paragraph_id)
    on delete cascade
);

create table if not exists public.reading_questions (
  question_id text primary key,
  logical_item_id text not null references public.reading_logical_items(logical_item_id) on delete cascade,
  question_order integer not null check (question_order > 0),
  module text not null check (module in ('ctw', 'rdl', 'rap')),
  question_type text not null check (question_type in (
    'ctw',
    'rdl',
    'rap_multiple_choice',
    'rap_sentence_insertion',
    'rap_sentence_selection'
  )),
  stem text not null,
  raw_display_text text,
  passage_highlight_ranges jsonb not null default '[]'::jsonb
    check (jsonb_typeof(passage_highlight_ranges) = 'array'),
  passage_id text references public.reading_passages(passage_id) on delete restrict,
  material_id text references public.reading_materials(material_id) on delete restrict,
  correct_option_id text,
  insert_sentence text,
  correct_anchor_id text,
  target_paragraph_id text,
  correct_sentence_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (logical_item_id, question_order),
  unique (question_id, logical_item_id),
  unique (question_id, passage_id),
  foreign key (passage_id, target_paragraph_id)
    references public.reading_passage_paragraphs(passage_id, paragraph_id)
    on delete restrict,
  foreign key (passage_id, correct_sentence_id)
    references public.reading_passage_sentences(passage_id, sentence_id)
    on delete restrict,
  constraint reading_question_module_check check (
    (question_type = 'ctw' and module = 'ctw')
    or (question_type = 'rdl' and module = 'rdl')
    or (question_type like 'rap_%' and module = 'rap')
  ),
  constraint reading_question_shape_check check (
    (question_type = 'ctw'
      and passage_id is null and material_id is null and correct_option_id is null
      and insert_sentence is null and correct_anchor_id is null
      and target_paragraph_id is null and correct_sentence_id is null)
    or
    (question_type = 'rdl'
      and material_id is not null and passage_id is null and correct_option_id is not null
      and insert_sentence is null and correct_anchor_id is null
      and target_paragraph_id is null and correct_sentence_id is null)
    or
    (question_type = 'rap_multiple_choice'
      and passage_id is not null and material_id is null and correct_option_id is not null
      and insert_sentence is null and correct_anchor_id is null
      and target_paragraph_id is null and correct_sentence_id is null)
    or
    (question_type = 'rap_sentence_insertion'
      and passage_id is not null and material_id is null and correct_option_id is null
      and nullif(btrim(insert_sentence), '') is not null and correct_anchor_id is not null
      and target_paragraph_id is null and correct_sentence_id is null)
    or
    (question_type = 'rap_sentence_selection'
      and passage_id is not null and material_id is null and correct_option_id is null
      and insert_sentence is null and correct_anchor_id is null
      and target_paragraph_id is not null and correct_sentence_id is not null)
  )
);

create table if not exists public.reading_question_occurrences (
  occurrence_id text not null,
  logical_item_id text not null,
  question_id text not null,
  source_question_start integer not null check (source_question_start > 0),
  source_question_end integer not null check (source_question_end >= source_question_start),
  primary key (occurrence_id, question_id),
  foreign key (occurrence_id, logical_item_id)
    references public.reading_source_occurrences(occurrence_id, logical_item_id)
    on delete cascade,
  foreign key (question_id, logical_item_id)
    references public.reading_questions(question_id, logical_item_id)
    on delete cascade
);

create table if not exists public.reading_question_options (
  question_id text not null references public.reading_questions(question_id) on delete cascade,
  option_id text not null,
  option_order integer not null check (option_order > 0),
  option_text text not null,
  primary key (question_id, option_id),
  unique (question_id, option_order)
);

create table if not exists public.reading_ctw_paragraphs (
  question_id text not null references public.reading_questions(question_id) on delete cascade,
  paragraph_id text not null,
  paragraph_order integer not null check (paragraph_order > 0),
  raw_text text not null,
  primary key (question_id, paragraph_id),
  unique (question_id, paragraph_order)
);

create table if not exists public.reading_ctw_slots (
  question_id text not null,
  slot_id text not null,
  slot_order integer not null check (slot_order > 0),
  paragraph_id text not null,
  answer text not null,
  prefix text not null,
  display_text text not null,
  missing_text text not null,
  missing_length integer not null check (missing_length > 0),
  primary key (question_id, slot_id),
  unique (question_id, slot_order),
  foreign key (question_id, paragraph_id)
    references public.reading_ctw_paragraphs(question_id, paragraph_id)
    on delete cascade,
  check (answer = prefix || missing_text),
  check (missing_length = char_length(missing_text))
);

create table if not exists public.reading_ctw_segments (
  question_id text not null,
  paragraph_id text not null,
  segment_order integer not null check (segment_order > 0),
  segment_type text not null check (segment_type in ('text', 'blank')),
  text_content text,
  slot_id text,
  primary key (question_id, paragraph_id, segment_order),
  foreign key (question_id, paragraph_id)
    references public.reading_ctw_paragraphs(question_id, paragraph_id)
    on delete cascade,
  foreign key (question_id, slot_id)
    references public.reading_ctw_slots(question_id, slot_id)
    on delete cascade,
  check (
    (segment_type = 'text' and text_content is not null and slot_id is null)
    or (segment_type = 'blank' and text_content is null and slot_id is not null)
  )
);

create table if not exists public.reading_rap_insertion_anchors (
  question_id text not null,
  passage_id text not null,
  anchor_id text not null,
  anchor_order integer not null check (anchor_order > 0),
  paragraph_id text not null,
  boundary_index integer not null check (boundary_index >= 0),
  after_sentence_id text,
  primary key (question_id, anchor_id),
  unique (question_id, anchor_order),
  foreign key (question_id, passage_id)
    references public.reading_questions(question_id, passage_id)
    on delete cascade,
  foreign key (passage_id, paragraph_id)
    references public.reading_passage_paragraphs(passage_id, paragraph_id)
    on delete restrict,
  foreign key (passage_id, after_sentence_id)
    references public.reading_passage_sentences(passage_id, sentence_id)
    on delete restrict
);

create index if not exists reading_logical_items_catalog_idx
  on public.reading_logical_items (
    module,
    is_active,
    first_seen_date,
    first_seen_source_label,
    first_seen_source_order,
    logical_item_id
  );
create index if not exists reading_source_occurrences_item_idx
  on public.reading_source_occurrences (logical_item_id, occurrence_date, source_label, source_order);
create index if not exists reading_questions_type_idx
  on public.reading_questions (question_type);
create index if not exists reading_questions_passage_idx
  on public.reading_questions (passage_id) where passage_id is not null;
create index if not exists reading_questions_material_idx
  on public.reading_questions (material_id) where material_id is not null;

drop trigger if exists reading_logical_items_set_updated_at on public.reading_logical_items;
create trigger reading_logical_items_set_updated_at
before update on public.reading_logical_items
for each row execute function public.set_updated_at();

drop trigger if exists reading_source_occurrences_set_updated_at on public.reading_source_occurrences;
create trigger reading_source_occurrences_set_updated_at
before update on public.reading_source_occurrences
for each row execute function public.set_updated_at();

drop trigger if exists reading_materials_set_updated_at on public.reading_materials;
create trigger reading_materials_set_updated_at
before update on public.reading_materials
for each row execute function public.set_updated_at();

drop trigger if exists reading_passages_set_updated_at on public.reading_passages;
create trigger reading_passages_set_updated_at
before update on public.reading_passages
for each row execute function public.set_updated_at();

drop trigger if exists reading_questions_set_updated_at on public.reading_questions;
create trigger reading_questions_set_updated_at
before update on public.reading_questions
for each row execute function public.set_updated_at();

alter table public.reading_logical_items enable row level security;
alter table public.reading_source_occurrences enable row level security;
alter table public.reading_materials enable row level security;
alter table public.reading_passages enable row level security;
alter table public.reading_passage_paragraphs enable row level security;
alter table public.reading_passage_sentences enable row level security;
alter table public.reading_questions enable row level security;
alter table public.reading_question_occurrences enable row level security;
alter table public.reading_question_options enable row level security;
alter table public.reading_ctw_paragraphs enable row level security;
alter table public.reading_ctw_slots enable row level security;
alter table public.reading_ctw_segments enable row level security;
alter table public.reading_rap_insertion_anchors enable row level security;

drop policy if exists "authenticated_select_active_reading_items" on public.reading_logical_items;
create policy "authenticated_select_active_reading_items"
on public.reading_logical_items for select to authenticated using (is_active);

drop policy if exists "teachers_manage_reading_logical_items" on public.reading_logical_items;
create policy "teachers_manage_reading_logical_items"
on public.reading_logical_items for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_source_occurrences" on public.reading_source_occurrences;
create policy "teachers_manage_reading_source_occurrences"
on public.reading_source_occurrences for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

-- Correct answers remain service-role/teacher only, matching the existing question bank pattern.
drop policy if exists "teachers_manage_reading_materials" on public.reading_materials;
create policy "teachers_manage_reading_materials"
on public.reading_materials for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_passages" on public.reading_passages;
create policy "teachers_manage_reading_passages"
on public.reading_passages for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_passage_paragraphs" on public.reading_passage_paragraphs;
create policy "teachers_manage_reading_passage_paragraphs"
on public.reading_passage_paragraphs for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_passage_sentences" on public.reading_passage_sentences;
create policy "teachers_manage_reading_passage_sentences"
on public.reading_passage_sentences for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_questions" on public.reading_questions;
create policy "teachers_manage_reading_questions"
on public.reading_questions for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_question_occurrences" on public.reading_question_occurrences;
create policy "teachers_manage_reading_question_occurrences"
on public.reading_question_occurrences for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_question_options" on public.reading_question_options;
create policy "teachers_manage_reading_question_options"
on public.reading_question_options for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_ctw_paragraphs" on public.reading_ctw_paragraphs;
create policy "teachers_manage_reading_ctw_paragraphs"
on public.reading_ctw_paragraphs for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_ctw_slots" on public.reading_ctw_slots;
create policy "teachers_manage_reading_ctw_slots"
on public.reading_ctw_slots for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_ctw_segments" on public.reading_ctw_segments;
create policy "teachers_manage_reading_ctw_segments"
on public.reading_ctw_segments for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "teachers_manage_reading_rap_insertion_anchors" on public.reading_rap_insertion_anchors;
create policy "teachers_manage_reading_rap_insertion_anchors"
on public.reading_rap_insertion_anchors for all to authenticated
using (public.is_teacher()) with check (public.is_teacher());
