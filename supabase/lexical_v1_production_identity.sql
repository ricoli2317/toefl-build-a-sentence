-- The frozen consolidation explicitly splits homographs. No business tables change.
ALTER TABLE public.lexical_entries
  ADD COLUMN IF NOT EXISTS identity_variant text NOT NULL DEFAULT '';
ALTER TABLE public.lexical_entries
  DROP CONSTRAINT IF EXISTS lexical_entries_normalized_expression_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS lexical_entries_expression_variant_key
  ON public.lexical_entries (normalized_expression, expression_type, identity_variant);
-- Keep existing RLS/grants: only postgres/service_role can access the corpus.
