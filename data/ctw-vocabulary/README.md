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
