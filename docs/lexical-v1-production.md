# Lexical V1 production import and lookup QA

## Publication

`tmp/lexical-v1/production/manifest.json` binds the complete publication by SHA-256.

- Entries: **13,043**
- Occurrences: **149,411**
- Frozen source blocks: **8,791**
- All structural blocking counters: **0**
- Invalid exclusion: **1**, absent from publication
- Removed MWE: **754**, absent from publication
- Enrichment arrays remain empty; V1 reads occurrence-level context fields.

Input entries and mappings come exclusively from `consolidation-resolved`. Frozen
canonical blocks and removed-occurrence audit are hash-verified against the formal
successor dependency snapshot. There is no reconsolidation, semantic generation,
OCR, enrichment, or historical lexical corpus.

Workflow stays `agent_consolidation_complete`, with `complete=true` and
`import_ready=true`. No new phase is introduced.

## The single production operation

**Production import is already complete and manually accepted. Do not rerun it
for this release, execute verification SQL, or regenerate the frozen corpus.**

The accepted counts are `13043 / 149411 / 8791`; orphan entries, missing blocks,
duplicate spans and duplicate entry keys are all zero. These are the accepted
handoff results, not database queries performed by release checks.

The following is historical importer documentation, not a release instruction:

```sh
SUPABASE_DB_URL='<production Postgres connection URL>' pnpm lexical:production-import --write
```

Use the production Postgres direct or session-pooler connection URL, with a role
authorized to perform the lexical-only schema correction (normally `postgres`).
The installed `psql` client is used. The password is passed through the child
process environment, not command arguments or importer logs. Do not commit the URL.

This one command validates publication hashes, then executes `production/import.sql`:

1. Begin one transaction and obtain an advisory lock.
2. Add `lexical_entries.identity_variant` and replace the old normalized-expression/type
   unique constraint with a normalized-expression/type/variant unique index. This is
   required by seven formally resolved homograph groups (10 explicit review targets).
3. COPY exact artifacts into constrained temporary staging tables.
4. Lock only the three lexical destination tables; refuse any non-identical existing row.
5. Insert entries, source blocks, then occurrences in FK order.
6. Compare staged and destination rows and exact corpus counts before commit.

Any SQL error stops `psql`; the transaction rolls back. Exact reruns are no-ops, and
an exact partial destination can resume. There is no truncation, deletion, business
schema change, or Reading/Writing content/attempt/assignment write.

`pnpm lexical:production-import` without `--write` is a local artifact-only dry run;
it opens no database connection. Neither mode is run during release verification.
The scripts require the external frozen publication handoff; artifacts are not
bundled with the code release and are not runtime dependencies.

## Post-import SQL

`supabase/lexical_v1_verify.sql` is retained as the historical verification query;
do not run it as part of this release. The accepted first row is
`13043 / 149411 / 8791`, with all four integrity counters zero.

| source_type | occurrences | blocks |
| --- | ---: | ---: |
| academic_discussion | 14,730 | 255 |
| bas | 27,068 | 2,820 |
| ctw | 18,715 | 214 |
| rap | 48,890 | 2,837 |
| rdl | 32,385 | 2,131 |
| write_email | 7,623 | 534 |

## Runtime

`POST /api/lexical/lookup` accepts an owned page/attempt proof, source type, canonical
block identity, visible block text, exact selected text and JS UTF-16 `[start,end)`.
The server authenticates using the normal student auth helper, resolves permission
from the existing attempt/assignment APIs, checks current authorized text and frozen
block hash, and reads one bounded occurrence/entry join. Browser code never reads
lexical tables. Existing service-only grants and RLS remain unchanged.

Matching is exact phrase, exact token, complete-token containing parent expression,
then unmatched. There is no normalized-text cross-item search, fuzzy fallback,
dictionary API, runtime entry creation, or model call. Response excludes full
context text and enrichment fields.

The shared card shows expression, context POS, Chinese meaning and English definition.
Selection cancellation, outside pointer and Escape close it. A new selection cancels
the previous request. Unmatched asks for a complete word/phrase; unavailable/stale
canonical text fails gracefully. No nonfunctional vocabulary button is shown.

Existing occurrence source-span/entry indexes and source-block identity indexes
cover runtime queries. No extra occurrence index is needed.

## Lookup QA locations

- **Reading CTW/RDL/RAP:** Practice History → submitted reading result → question number.
  `/student/reading/results/<attemptId>/questions/<questionIndex>`
- **Full Set:** completed Full Set result → question number.
  `/student/reading/full-sets/<fullSetId>/result/<attemptId>/questions/<questionIndex>`
  Sources remain the internal CTW/RDL/RAP logical item; no Full Set corpus is copied.
- **Reading correction review:** submitted correction result → question number.
  Access binds the correction's own canonical item/target questions, not another attempt.
- **BAS:** canonical prompt in practice, result or history. The final sentence supports
  lookup only where the existing page actually shows it; student-built answers and
  blank templates/options are not lexical sources.
   Latest main displays canonical correct answers for all submitted BAS questions.
   Lookup follows that current result presentation, after checking student ownership,
   submission and question membership. Active BAS still permits only the prompt.
- **Write Email:** canonical scenario, task instruction, requirements, subject on practice,
  submitted and published-review question views.
- **Academic Discussion:** canonical professor prompt and two provided student posts on
  practice, submitted and published-review question views. The student's own response
  is not annotated.

All active Reading workspaces, including active Full Set, disable lookup. Submitted
Reading and completed Full Set are required by the server, not just by the UI.
Writing drafts require the normal visible assignment/question permission; withdrawn
draft assignments and custom/noncanonical snapshots are excluded. Historical
canonical text must match the frozen publication hash.

CTW readonly passage uses reconstructed correct text (student errors remain in the
answer zone). RDL retains the existing verified image and selection map; flattened
character positions are converted with the existing canonical UTF-16 mapping. RAP
sentence spans carry canonical UTF-16 bases, excluding insertion markers; inserted
sentences and transformed visible instructions/stems have their own canonical block.
RDL lookup checks the registered material binding and frozen corpus text hash without
downloading the image or selection map again for each request.

## Targeted checks

```sh
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/lexicalProduction.test.js tests/lexicalLookup.test.js tests/lexicalLookupUi.test.js
```

Also run `pnpm exec tsc --noEmit --incremental false`, `git diff --check` and
`pnpm build`. Run `tsc` separately from `build`: Next rebuilds `.next/types`, so
concurrent checks can race with generated files. No historical lexical pipeline
regression is required or started.

Targeted tests use small offline contract fixtures. They do not read ignored
`tmp/lexical-v1` artifacts, recreate 149,411 occurrences, execute SQL, connect to
the production database or run importer/finalizer entrypoints. The finalizer's
production count/hash gates remain intact; its completion validator is kept
locally so historical checkpoint/enrichment coordinator modules need not ship.

Latest-main adaptations retain BAS question-chip navigation/correction, lazy
Full Set/source review, CTW responsive answer layout/mobile input, verified RDL
selection maps, Writing session recovery/editor scrolling, and published sample
views. Multi-source correction review authorizes the underlying correction
attempt, never the session ID as a Full Set attempt. Teacher standalone preview
receives no lexical access proof; its existing navigation is unchanged.

The release is a single local commit. Push and deployment require separate approval.
