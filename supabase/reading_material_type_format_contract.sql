-- Replace the closed reading_materials material_type allowlist with the stable
-- snake_case format contract owned by TPS. Review and run manually in the
-- Supabase SQL Editor; Codex does not execute this file.
--
-- Reading production remains authoritative for each canonical material_type.
-- This constraint rejects malformed storage values while allowing future
-- authoritative types without another TPS schema migration.

begin;

alter table public.reading_materials
  drop constraint if exists reading_materials_material_type_check;

alter table public.reading_materials
  add constraint reading_materials_material_type_check check (
    material_type ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  );

select
  material_type,
  count(*) as material_count
from public.reading_materials
group by material_type
order by material_type;

commit;
