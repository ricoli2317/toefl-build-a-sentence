-- Canonical RDL instruction for reading_materials.
--
-- instruction stores the complete authoritative display string from the
-- original question (for example "Read an event program."). It is canonical
-- material data, independent from material_type, and is never derived or
-- generated from material_type.
--
-- Historical RDL rows keep instruction = NULL for now and continue to use the
-- legacy material_type mapping at runtime; they will be verified and
-- backfilled separately. This migration does not backfill any row.
--
-- Run manually in the Supabase SQL Editor. This file is not run by Codex and
-- does not touch any data.

alter table public.reading_materials
  add column if not exists instruction text;

alter table public.reading_materials
  drop constraint if exists reading_materials_instruction_check;

alter table public.reading_materials
  add constraint reading_materials_instruction_check check (
    instruction is null or btrim(instruction) <> ''
  );

comment on column public.reading_materials.instruction is
  'Canonical RDL display instruction from the original question, e.g. "Read an event program.". Stored once with the canonical material and never overwritten by later occurrences.';

comment on column public.reading_materials.material_type is
  'Stable RDL material classification (for example advertisement, email, notice). Decoupled from the canonical instruction column.';
