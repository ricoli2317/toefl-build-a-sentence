# CODEX RULES

Version: 1.0 (Migration Draft)

## 1. General Development Rules

Before modifying code:

1.  Understand the current implementation.
2.  Identify affected files and dependencies.
3.  Confirm existing business logic.
4.  Make the smallest required change.
5.  Test the affected workflow.

Do not rewrite completed systems without a clear requirement.

------------------------------------------------------------------------

# 2. Product Requirement Rules

The project contains many confirmed product decisions.

Before implementing a feature:

-   Check existing behavior.
-   Preserve existing user workflows.
-   Do not introduce alternative designs unless requested.

When requirements are ambiguous:

-   Ask for clarification.
-   Do not redesign based on assumptions.

------------------------------------------------------------------------

# 3. Database Rules

## Identity

Never change stable identifiers casually.

Important principle:

Permanent identity is separate from display information.

Do not:

-   use display numbers as IDs
-   recreate existing records unnecessarily
-   break historical relationships

------------------------------------------------------------------------

## Schema Changes

Before changing database structure:

Check:

-   existing tables
-   foreign keys
-   RLS policies
-   triggers
-   API usage
-   frontend dependencies

Prefer:

-   additive changes
-   migration scripts
-   backward-compatible updates

Avoid:

-   deleting fields
-   renaming fields without migration
-   changing data types without checking usage

Current repository facts:

-   Business code treats questions.question_id, questions.set_id,
    attempts.set_id, attempt_answers.question_id, and
    attempt_answers.set_id as TEXT.
-   writing_assignments uses assignment_id and due_at, not id and
    deadline_at.
-   supabase/schema.sql is a legacy reset script with UUID declarations and is
    not an authoritative description of the current database.
-   The repository does not contain a complete baseline migration for every
    table currently used by the application.

Rule:

-   Do not use supabase/schema.sql as the current migration baseline without
    first verifying the actual Supabase schema.
-   Database baseline export and reconciliation are currently deferred. Do not
    start this work unless it is requested separately.

------------------------------------------------------------------------

# 4. Supabase Rules

Always consider:

-   authentication context
-   RLS policies
-   trigger execution context

When modifying permissions:

Check:

-   SELECT
-   INSERT
-   UPDATE
-   DELETE

Be careful with database functions that use:

-   row locking
-   security definer
-   trigger-based validation

The actual Supabase schema, RLS policies, functions, triggers, and grants must
be inspected before permission or schema work. Do not assume policies in the
legacy supabase/schema.sql file are the live policies.

------------------------------------------------------------------------

# 5. Frontend Rules

## UI Language

Never expose internal engineering concepts.

Do not display:

-   database field names
-   internal IDs
-   schema terminology
-   development concepts

Use natural user-facing language.

Approved exception and remaining UI rule violations:

-   The teacher import UI currently displays “新逻辑题”.
-   A student practice catalog error can expose the internal term “logical”.
-   AI log pages may display technical terminology such as “Schema版本” and
    “Schema 校验”. This exception applies only to the AI observability page.
-   All other product-facing UI must continue to use natural user-facing
    language. Do not copy the AI log exception into other interfaces.

------------------------------------------------------------------------

## UI Changes

When modifying UI:

Preserve:

-   existing design language
-   spacing hierarchy
-   component behavior
-   responsive behavior

Avoid:

-   unnecessary redesign
-   adding decorative elements without purpose
-   changing established workflows

------------------------------------------------------------------------

## Loading Performance

Do not block static UI while waiting for data.

Preferred:

1.  Render static structure immediately.
2.  Load dynamic data separately.
3.  Show loading states only where necessary.

------------------------------------------------------------------------

# 6. Writing System Rules

## AI Review

AI output is assistance only.

Teacher published feedback is the final version.

Current implementation:

-   Student submission creates or updates the writing attempt.
-   AI generation or regeneration is explicitly triggered by a teacher in the
    review workspace.
-   Production generation uses OpenRouter with moonshotai/kimi-k3, a
    same-provider hedge after 60 seconds, and a 240-second total deadline.

Confirmed product rules:

-   AI generation remains teacher-triggered. Do not automatically start it on
    student submission.
-   Keep the fixed production Kimi provider and same-provider hedge. Runtime
    multi-provider switching and fallback are not current requirements.

Do not:

-   replace teacher workflow with automatic decisions
-   modify feedback logic without checking existing rules

Current scoring implementation (writing review schema v2.2):

-   official_score uses a 0-5 scale.
-   Email dimensions are communicative_purpose_and_elaboration,
    syntactic_range_and_word_choice, social_conventions, and
    lexical_and_grammatical_control.
-   Academic Discussion dimensions are relevance, elaboration,
    syntactic_range_and_word_choice, and lexical_and_grammatical_control.

Confirmed product rule:

-   These writing review schema v2.2 dimensions replace the previously
    documented product dimensions.

------------------------------------------------------------------------

## Feedback Categories

Language Edit:

Only:

-   grammar
-   spelling
-   punctuation
-   clear language errors

Content Feedback:

Includes:

-   ideas
-   explanation
-   organization
-   development problems
-   task fulfillment and contribution
-   task-specific conventions
-   holistic language improvement guidance

Do not mix categories.

Approved current taxonomy:

-   Email Content Feedback categories include communicative_purpose,
    elaboration, social_conventions, organization, and language_improvement.
-   Academic Discussion Content Feedback categories include relevance,
    elaboration, discussion_contribution, organization, and
    language_improvement.

language_improvement, social_conventions, and discussion_contribution are valid
Content Feedback categories. The category name language_improvement does not
make an item a Language Edit; direct grammar, spelling, punctuation, and clear
error corrections remain in Language Edit.

------------------------------------------------------------------------

# 7. Performance Optimization Rules

When analyzing performance:

Check the complete chain:

Frontend

↓

API

↓

Database

↓

External services

Do not assume the slowest part without measurement.

Avoid:

-   unnecessary API calls
-   duplicate requests
-   excessive data loading
-   blocking static rendering

Approved catalog-specific exception:

-   The logical practice catalog loads the full task-scoped list, uses
    client-side slice for pagination, and does not synchronize page changes to
    the URL query.
-   Retain this client-side pagination behavior. Server-side pagination and URL
    page synchronization are not current requirements for this catalog.

------------------------------------------------------------------------

# 8. Testing Rules

For small changes:

Run targeted verification.

For major changes:

Run:

-   type checking
-   lint
-   build
-   critical user flows

Do not repeatedly run full test suites for unrelated small
modifications.

Current regression baseline:

-   800 tests discovered
-   792 passing
-   8 failing

Treat the baseline as not fully green. Classify existing failures separately
from failures introduced by a change. The logical catalog pagination assertion
reflects the previous server-side contract and must be updated for the
confirmed client-side product rule; the other source-contract assertions also
require follow-up.

------------------------------------------------------------------------

# 9. Git and Change Management

Keep changes focused.

Prefer:

-   one feature or bug fix per change set
-   clear commit messages
-   easy rollback

Avoid:

-   mixing refactoring with feature changes
-   unrelated cleanup
-   large uncontrolled modifications

------------------------------------------------------------------------

# 10. Codex Response Requirements

Before editing:

Explain briefly:

-   current issue
-   root cause
-   planned files
-   expected impact

After editing:

Report:

-   modified files
-   changes made
-   verification performed
-   remaining risks

Keep explanations focused on the requested task.

------------------------------------------------------------------------

END OF CODEX RULES
