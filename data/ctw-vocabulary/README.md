# Reviewed CTW vocabulary fixtures

These versioned inputs make the CTW tests and initial CEFR List generator usable
from a clean checkout. They are offline fixtures, not runtime content or an
automatic production import.

- `ctw-vocabulary-cefr-reviewed.json` is an exact byte-for-byte copy of the
  reviewed Phase 2 handoff: 1,032 entries, 1,152 senses, 47 irregular entries.
  SHA-256: `09480ce1a52a79906082df9cd0503396c4b334850587f8c95e8629ce63eb38c6`.
- `source-topics.json` retains only `word`, `topic` and `all_topics` from the
  original CTW topic provenance. Its order and repeated occurrences are retained
  because the existing List balancing algorithm counts those occurrences.
  Source passages, question content, account details and credentials are omitted.

With Node.js supporting `--experimental-strip-types`, Python 3 and the project's
dependencies installed:

```sh
pnpm test:ctw-vocabulary
pnpm test:ctw-vocabulary-ui
pnpm ctw-vocabulary:cefr-lists
```

Tests run against isolated PGlite and never connect to production. The CEFR
generator reproduces the committed membership, audit and installation handoff
under `outputs/ctw-vocabulary-phase3/`; it does not execute SQL or regroup the
existing mixed Lists. The historical installation must be followed by
`supabase/ctw_vocabulary_phase3_start_owner_fix.sql` before running the current
`supabase/ctw_vocabulary_phase3_verify.sql`. Already-installed projects must not
rerun initial migrations or reimport the library.

Browser scripts require separately provisioned local test credentials and an
explicitly started localhost server. The real-account script additionally
requires explicit opt-in, creates real account history, and is not a CI test.
Never commit its credentials, storage state, or real-account acceptance output.

## Reviewed form delta (2026-10-15)

`irregular-spelling-adjustments.json` records the user's latest review without
rewriting the original attachment or its hash. It retains only `craftspeople`
and `millennia`, removes the extra `leaf → leaves` test, and records that every
listed variant must be spelled (not just one accepted alternative). `get`
retains **both got/gotten**; burn/learn retain both -ed/-t forms. The earlier
got-only and burn/learn-removal draft was never applied to production.

`pnpm ctw-vocabulary:audit-irregular` generates a complete 47-word checklist and
an effective offline JSON preview under `outputs/ctw-vocabulary-unification/`.
These are QA artifacts, not runtime dependencies or a bulk-import instruction.
Already-imported production data must receive only the targeted manual SQL
`supabase/ctw_vocabulary_american_spelling.sql` and its read-only Verify. All
historical test grades remain unchanged.

For the unified flow, `scripts/verify-ctw-unified-real-account.cjs` is a separate
explicitly authorized acceptance tool, not a CI test. It uses the normal local
login UI and real production-backed API, and creates five final attempts. It
refuses an existing acceptance report to prevent accidental duplicate runs.
`verify-ctw-phase3-real-account.cjs` remains historical v1-only tooling.

## Additional regular-form review: life

The user additionally excludes `life → lives`, like `leaf → leaves`, from extra
spelling tests. `irregular-spelling-adjustments.json` includes this cumulative
offline delta; the original attachment stays unchanged. Existing production
installations need ONLY the new manual
`supabase/ctw_vocabulary_life_regular_form_fix.sql` and its read-only Verify,
not a rerun of previously executed migrations or a bulk import.

The administrator confirmed that the life patch was applied and its Verify
passed on 2026-10-15. Keep both SQL files as the record of this correction;
this confirmation does not require another execution or a vocabulary reimport.

The audit now checks simple `+s/es/d/ed`, consonant-y `ies/ied`, consonant-doubling
past spellings and the user-defined `f/fe → ves` exclusions. Per the user's
explicit clarification, multi-variant forms stay all-required: burn's
`burnt/burned` and learn's `learnt/learned` are intentionally retained. QA is
offline only; it never filters the frontend or invents runtime accepted answers.

New rounds and new wrong-word retries read the corrected database form set.
Existing started rounds keep their fixed snapshots, and historical scores and
answers are never regraded. To see the correction in an already-open study
session, begin a new round after the administrator applies the life patch.
