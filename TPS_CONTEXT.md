# TPS Project Context

Version: 1.0 (Migration Draft)

## 1. Project Overview

TPS (TOEFL Practice System) is an online TOEFL practice platform.

Main goals:

-   Provide TOEFL practice for students.
-   Provide teachers with question management, assignment, review, and
    analytics tools.
-   Support AI-assisted writing evaluation while keeping teacher
    control.
-   Maintain stable question identity and historical data integrity.

Current main modules:

1.  Build a Sentence practice system
2.  Writing practice system:
    -   Write an Email
    -   Academic Discussion
3.  Teacher management system
4.  Student learning dashboard
5.  AI-assisted writing review workflow

------------------------------------------------------------------------

## 2. Technical Stack

### Frontend

-   Next.js
-   TypeScript
-   Tailwind CSS
-   React components

### Backend / Database

-   Supabase
-   PostgreSQL
-   Supabase Auth
-   Row Level Security (RLS)

### Deployment

-   Vercel

Production:

https://www.tuofubas.com

Backup:

https://toefl-build-a-sentence.vercel.app

------------------------------------------------------------------------

## 3. Development Principles

## Product-facing language

Never expose internal engineering terminology to students or teachers.

Forbidden examples:

-   Logical Item
-   item_id
-   raw database IDs
-   schema terminology
-   internal status names

Use natural product language.

Examples:

Internal: Logical Item

UI: Practice Question

Internal: BAS

UI: Build a Sentence

------------------------------------------------------------------------

## 4. Core Architecture Principles

## Stable Identity vs Display Information

All learning content must separate:

1.  Permanent identity
2.  Display information

Permanent identity is used for:

-   statistics
-   history
-   attempts
-   analytics

Display information is used for:

-   UI ordering
-   titles
-   numbering

Never use display numbers as database identity.

------------------------------------------------------------------------

## 5. Build a Sentence System

## Function

Students:

-   Select practice sets
-   Arrange word blocks
-   Submit answers
-   View results
-   Review mistakes

Teachers:

-   Import question bank
-   View statistics
-   Analyze student performance

------------------------------------------------------------------------

## Database Important Rules

The following IDs are TEXT, not UUID:

-   questions.question_id
-   questions.set_id
-   attempts.set_id
-   attempt_answers.question_id
-   attempt_answers.set_id

attempt_answers includes:

-   question_time_seconds

Used for:

-   per-question timing analysis

Current repository note:

-   Current business code treats the five identifiers above as TEXT.
-   supabase/schema.sql is a legacy reset script and still declares UUID
    fields. It is not the authoritative description of the current
    database.
-   The repository does not currently contain a complete baseline migration
    for all tables used by the application.

暂不处理：

-   Database baseline export and reconciliation are deferred. Before any future
    database baseline work, verify the actual Supabase schema, RLS policies,
    functions, triggers, and grants.

------------------------------------------------------------------------

## 6. Build a Sentence Naming Rules

## Set display

Current UI:

-   套题001
-   套题002

The system no longer uses monthly grouping as the primary student
display.

------------------------------------------------------------------------

## Item numbering rules

Each practice item has:

-   permanent identity
-   display_number

Normal new items:

Continue the next number.

Example:

-   058
-   059
-   060

If adding an older discovered item:

Do not renumber all existing items.

Use suffix:

-   058A
-   058B

Reason:

Existing statistics and student history must remain stable.

------------------------------------------------------------------------

## 7. Writing System Overview

Writing task types:

1.  Write an Email
2.  Academic Discussion

Workflow:

Student writes

↓

writing_attempt created

↓

Student submits writing

↓

Teacher opens the review workspace and triggers AI initial review

↓

Teacher edits review

↓

Teacher publishes

↓

Student views feedback

Confirmed product rule:

-   AI review generation remains a teacher-triggered action. Student submission
    does not automatically start AI review generation.

------------------------------------------------------------------------

## 8. Writing AI Review Design

Purpose:

AI provides initial evaluation.

Teacher remains final authority.

## Scores

Current code implementation (writing review schema v2.2):

-   official_score: 0-5
-   four diagnostic dimension scores for each task type

Email:

-   communicative_purpose_and_elaboration
-   syntactic_range_and_word_choice
-   social_conventions
-   lexical_and_grammatical_control

Academic Discussion:

-   relevance
-   elaboration
-   syntactic_range_and_word_choice
-   lexical_and_grammatical_control

Confirmed product rule:

-   The current writing review schema v2.2 score model replaces the previously
    documented dimension set.

------------------------------------------------------------------------

## Feedback Structure

### Content Feedback

Used for:

-   ideas
-   missing information
-   unclear explanation
-   insufficient development

May include:

-   problem
-   suggestion
-   proposed_revision

### Language Edits

Only:

-   grammar
-   spelling
-   punctuation
-   clear language errors

Do not use Language Edit for:

-   rewriting ideas
-   improving content

Current code implementation:

-   Email content feedback categories include communicative_purpose,
    elaboration, social_conventions, organization, and language_improvement.
-   Academic Discussion content feedback categories include relevance,
    elaboration, discussion_contribution, organization, and
    language_improvement.

Confirmed product rule:

-   language_improvement, social_conventions, and discussion_contribution are
    valid Content Feedback categories. Language Edits remain limited to the
    language-error rules above.

------------------------------------------------------------------------

## Feedback Priority

Priority:

Content Revision \> Language Edits

Minimum change principle:

Only modify necessary parts.

Do not rewrite correct student writing.

------------------------------------------------------------------------

## 9. Writing Assignment System

Teachers can assign:

-   Write an Email
-   Academic Discussion

Sources:

1.  Existing question bank
2.  Custom question

------------------------------------------------------------------------

## Assignment features

Teacher can:

-   choose students
-   select existing questions
-   create custom questions
-   set deadlines

Deadline behavior:

-   overdue submissions are allowed
-   overdue status is displayed

------------------------------------------------------------------------

## Custom Question Rules

### Write an Email

Teacher provides:

-   title
-   recipient
-   subject
-   scenario
-   required points
-   full prompt / task_instruction when using the full-prompt input flow

The system builds or preserves task_instruction and automatically adds the
fixed closing instruction.

Confirmed product rule:

-   The code implementation is the authoritative behavior for custom Email
    question fields.

### Academic Discussion

Teacher provides:

-   title
-   professor name/content
-   student names/content

System automatically adds fixed structure.

------------------------------------------------------------------------

## 10. UI Design Principles

General:

-   clean educational platform style
-   prioritize information hierarchy
-   avoid unnecessary loading states

Static UI:

Should appear immediately.

Do not block page rendering while waiting for data.

Approved exception and remaining UI rule violations:

-   The teacher import UI currently displays “新逻辑题”.
-   A student practice catalog error can display the internal term “logical”.
-   AI log pages may display technical terminology such as “Schema版本” and
    “Schema 校验”. This is an approved exception for the AI observability page.
-   No other product-facing UI may expose internal engineering terminology.
    The teacher import label and student catalog error above remain UI rule
    violations to be corrected in future implementation work.

------------------------------------------------------------------------

## 11. Current Important Constraints

Before changing code:

Check:

1.  Database relationships
2.  Existing statistics logic
3.  Student history compatibility
4.  Teacher workflow

Avoid:

-   changing stable IDs
-   renaming database fields casually
-   breaking historical data
# TPS Project Context - Part 2

Version: 1.0 (Migration Draft)

## 12. Student-side Modules

## Student Dashboard

Purpose:

Provide students with a central entry point for:

-   assigned tasks
-   practice progress
-   writing review access
-   learning history

Requirements:

-   Static interface elements should render immediately.
-   Data loading should not block the whole page.
-   Loading states should only apply to dynamic content.

------------------------------------------------------------------------

## Student Practice System

Supported practice types:

-   Build a Sentence
-   Write an Email
-   Academic Discussion

General flow:

Student selects practice

↓

Completes task

↓

Submits response

↓

Views results or feedback

------------------------------------------------------------------------

## Writing Review Access

Student workflow:

Assignment / practice entry

↓

Submit writing

↓

Teacher triggers AI review in the review workspace

↓

Teacher reviews and publishes

↓

Student views published feedback

Students should only see published reviews.

AI drafts and teacher editing states are not student-facing.

------------------------------------------------------------------------

# 13. Teacher-side Modules

## Teacher Dashboard

Teacher functions:

-   Manage students
-   Manage question bank
-   Assign writing tasks
-   Review student writing
-   View statistics

The UI should prioritize:

-   frequently used actions
-   clear status visibility
-   efficient workflow

------------------------------------------------------------------------

## Teacher Writing Review Workspace

Purpose:

Allow teachers to:

-   view student writing
-   review AI generated feedback
-   edit feedback
-   publish final feedback

Layout principles:

-   Main writing area
-   Feedback area
-   Clear distinction between original writing and edited version

Supported views:

1.  Review with annotations
2.  Clean revised version
3.  Original submission

------------------------------------------------------------------------

## Writing Feedback Display

Feedback categories:

## Language Edit

Represents:

-   grammar corrections
-   spelling corrections
-   punctuation corrections
-   direct language errors

## Content Feedback

Represents:

-   missing ideas
-   weak explanation
-   insufficient development
-   unclear reasoning

Do not mix the two categories.

------------------------------------------------------------------------

# 14. Writing Assignment Database Design

Main table:

writing_assignments

Important fields:

-   assignment_id
-   teacher_id
-   task_type
-   question_source
-   question_id
-   question_snapshot
-   due_at
-   status
-   deleted_at
-   group_id
-   group_position
-   created_at
-   updated_at

task_type:

-   email
-   academic_discussion

question_source:

-   question_bank
-   custom

question_snapshot stores custom or historical question information.

Purpose:

Assignments should remain stable even if the question bank changes
later.

------------------------------------------------------------------------

## Writing Attempt Relationship

writing_attempts may contain:

-   assignment_id

Assignment submission must respect:

-   assignment status
-   student permission
-   RLS rules

------------------------------------------------------------------------

# 15. Question Bank Principles

Question content should have:

1.  Stable identity
2.  Source information
3.  Display information

Never rely on displayed titles or numbers as identifiers.

------------------------------------------------------------------------

## Question Search

Teacher question selection should support:

Search by:

-   set title
-   question title
-   keywords inside question content

Search should be separated by task type:

-   Email
-   Academic Discussion

------------------------------------------------------------------------

# 16. Database and Security Principles

## Supabase RLS

Always consider:

-   user role
-   ownership
-   read/write permission

Previous important issue:

A database function using:

SELECT ... FOR KEY SHARE

could trigger UPDATE-related RLS behavior.

When modifying database policies:

Check:

-   SELECT policy
-   INSERT policy
-   UPDATE policy
-   DELETE policy
-   trigger execution context

------------------------------------------------------------------------

# 17. Performance Principles

## Frontend

Avoid:

-   unnecessary API requests
-   repeated data fetching
-   blocking static rendering

Use:

-   caching where appropriate
-   local state restoration
-   targeted refresh

Current implementation note:

-   The logical practice catalog currently loads the full task-scoped list,
    paginates with client-side slice, and does not synchronize page changes to
    the URL query.

Confirmed product rule:

-   Retain client-side pagination for the logical practice catalog. The current
    client-side slice behavior is the approved pagination contract; URL page
    synchronization is not required.

------------------------------------------------------------------------

## Backend

When optimizing:

Check:

1.  API response time
2.  Database query time
3.  Data processing time
4.  External API latency

Do not optimize only frontend loading indicators.

------------------------------------------------------------------------

# 18. AI Writing Evaluation System

## Current AI Pipeline

Student submission

↓

Teacher opens the review workspace and explicitly generates or regenerates
the AI review

↓

Provider response

↓

Validate AI output

↓

Save review

↓

Teacher edits

↓

Publish

------------------------------------------------------------------------

## Reliability Requirements

AI generation must handle:

-   timeout
-   provider failure
-   duplicate requests
-   invalid output

Important principles:

-   idempotent generation
-   safe retry
-   no duplicate reviews
-   preserve existing valid review

------------------------------------------------------------------------

## AI Provider Design

Current production implementation:

-   OpenRouter
-   moonshotai/kimi-k3
-   high reasoning configuration
-   a same-provider hedge request after 60 seconds
-   a total generation deadline of 240 seconds

DeepSeek and Qwen currently appear in benchmark or comparison scripts, not as
production runtime switching or fallback providers.

Confirmed product rule:

-   Keep the fixed production Kimi provider and same-provider hedge. Runtime
    multi-provider switching and fallback are not current requirements.

------------------------------------------------------------------------

# 19. Development Workflow

Preferred workflow:

1.  Understand existing implementation.
2.  Make the smallest required change.
3.  Run targeted tests.
4.  Verify affected user flow.
5.  Commit changes.

Avoid:

-   unnecessary refactoring
-   large unrelated changes
-   changing architecture without requirement

------------------------------------------------------------------------

# 20. Testing Principles

Before release:

Check:

-   TypeScript compilation
-   lint
-   build
-   critical user flows

For normal changes:

Prefer targeted tests.

Do not repeatedly run full test suites during every small iteration
unless necessary.

------------------------------------------------------------------------

END OF PART 2
