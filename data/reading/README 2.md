# Reading import staging

Place the untouched May/June source DOCX files in `data/reading/source-docx/` and converted packages in `data/reading/import-packages/`.

The repository currently has no production Reading DOCX or accepted RDL material/hitbox assets. The checked-in fixture is synthetic and keeps its RDL material explicitly `pending`; it must never be imported as production content.

The conversion boundary is `ReadingSourceAdapter<TSource>` in `lib/reading/types.ts`. A DOCX adapter should be implemented only after the real DOCX layout is available, so that it copies authoritative text without guessing headings, blanks, sentence boundaries, answers, or IDs.

Validate a converted package without writing to Supabase:

```bash
pnpm import:reading -- data/reading/fixtures/reading-import.fixture.json --dry-run
```

After applying `supabase/reading_data_layer.sql`, import a validated production package with service-role environment variables configured:

```bash
pnpm import:reading -- data/reading/import-packages/<package>.json
```
