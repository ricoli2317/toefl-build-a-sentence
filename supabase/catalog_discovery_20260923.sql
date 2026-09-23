-- Lightweight metadata for the six independent student catalogs.
-- Reading Full Set tables and functions are intentionally not changed here.

alter table public.reading_logical_items
  add column if not exists catalog_category text,
  add column if not exists catalog_search_text text not null default '';

alter table public.reading_materials
  add column if not exists catalog_search_text text not null default '';

alter table public.email_questions
  add column if not exists catalog_category text;

alter table public.academic_discussion_questions
  add column if not exists catalog_category text;

alter table public.reading_logical_items
  drop constraint if exists reading_logical_items_catalog_category_check;
alter table public.reading_logical_items
  add constraint reading_logical_items_catalog_category_check
  check (nullif(btrim(catalog_category), '') is not null) not valid;

alter table public.email_questions
  drop constraint if exists email_questions_catalog_category_check;
alter table public.email_questions
  add constraint email_questions_catalog_category_check
  check (nullif(btrim(catalog_category), '') is not null) not valid;

alter table public.academic_discussion_questions
  drop constraint if exists academic_discussion_questions_catalog_category_check;
alter table public.academic_discussion_questions
  add constraint academic_discussion_questions_catalog_category_check
  check (nullif(btrim(catalog_category), '') is not null) not valid;
