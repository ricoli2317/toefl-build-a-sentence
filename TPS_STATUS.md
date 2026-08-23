# TPS Current Status

Version: 1.0 (Migration Draft)

## 1. Overall Project Status

TPS is currently in active development.

Major systems completed:

-   Build a Sentence practice system
-   Student practice workflow
-   Teacher question management
-   Writing assignment system
-   Writing AI review workflow
-   Student writing review access
-   Question bank organization and display improvements

Current development focus:

-   Writing system optimization
-   AI review reliability
-   Platform performance improvements
-   Continued UI refinement

------------------------------------------------------------------------

# 2. Completed Major Modules

## Build a Sentence System

Completed:

-   Student practice flow
-   Answer submission
-   Result display
-   Practice history
-   Mistake review
-   Teacher statistics

Teacher-side capabilities:

-   Question bank import
-   Set statistics
-   Question accuracy analysis
-   Student performance analysis

Current status:

Operational in the current application, with regression follow-up required.
The current automated suite has 792 passing tests out of 800.

------------------------------------------------------------------------

## Question Bank Organization

Completed:

-   Unified content identity model
-   Stable item identity
-   Display numbering system
-   Historical source tracking

Important completed rule:

Display numbers are separated from permanent identity.

Current status:

Architecture completed.

------------------------------------------------------------------------

# 3. Writing System Status

## Writing Practice

Supported:

-   Write an Email
-   Academic Discussion

Completed:

-   Student writing submission
-   Writing attempt creation
-   Teacher review workflow
-   Teacher-triggered AI initial review generation
-   Teacher editing
-   Publishing
-   Student feedback viewing

------------------------------------------------------------------------

# 4. Writing Assignment System Status

Completed:

Teacher can:

-   Create assignments
-   Select existing question bank questions
-   Create custom questions
-   Assign students
-   Set deadlines

Student can:

-   View assignments
-   Complete writing
-   Submit responses
-   Continue after deadline

Completed fixes:

-   Assignment status handling
-   Withdrawn assignment behavior
-   Student access validation
-   RLS related permission issues

Current status:

Core workflow completed.

------------------------------------------------------------------------

# 5. AI Writing Review Status

## Completed

AI review structure:

-   Official 0-5 score
-   Four task-specific diagnostic dimensions defined by writing review schema
    v2.2
-   Content feedback
-   Language edits
-   Overall feedback

Teacher workflow:

AI draft

↓

Teacher editing

↓

Publish

Completed reliability improvements:

-   Duplicate generation protection
-   REVIEW_ALREADY_EXISTS handling
-   Safer persistence logic
-   Provider failure handling improvements

Current production provider behavior:

-   OpenRouter with moonshotai/kimi-k3
-   high reasoning configuration
-   same-provider hedge request after 60 seconds
-   total generation deadline of 240 seconds

DeepSeek and Qwen are currently used by benchmark or comparison scripts, not
as production runtime fallback providers.

------------------------------------------------------------------------

# 6. Current Known Issues

## AI Review Stability

Current concern:

Some AI writing evaluations have:

-   long response time
-   timeout risk
-   occasional generation failure

Current investigation areas:

-   Prompt complexity
-   Provider latency
-   Timeout strategy
-   Retry mechanism

Important observation:

The same task performed in ChatGPT conversation may complete
successfully while API requests may experience longer latency.

Need further optimization.

------------------------------------------------------------------------

## Automated Regression Status

Current test result:

-   800 tests discovered
-   792 passing
-   8 failing

The failures include source-contract assertions. The logical catalog
pagination assertion reflects the previous server-side contract and must be
updated for the confirmed client-side product rule. The repository should not
be described as having a fully green regression baseline.

------------------------------------------------------------------------

## Database Baseline Status

Current repository state:

-   supabase/schema.sql is a legacy reset script and does not match current
    TEXT identifier usage.
-   It also does not provide a complete baseline for the tables currently used
    by the application.

暂不处理：

-   Exporting or reconciling the actual Supabase schema, RLS policies,
    functions, triggers, and grants is deferred.

------------------------------------------------------------------------

## Logical Catalog Pagination

Current implementation:

-   Loads the full task-scoped catalog.
-   Uses client-side slice for page display.
-   Does not synchronize page changes to the URL query.

Confirmed product rule:

-   Client-side pagination is the intended behavior. Server-side pagination and
    URL page synchronization are not current requirements.

------------------------------------------------------------------------

# 7. Current Performance Optimization Status

Completed:

-   Performance monitoring
-   Frontend request analysis
-   API timing analysis
-   Cache optimization for selected pages

Approved exception:

-   The logical practice catalog currently performs full-list loading and
    client-side pagination. This catalog-specific behavior is approved despite
    the general direction to avoid excessive data loading.

Main optimization principle:

Do not optimize only visible loading states.

Analyze:

-   frontend rendering
-   API latency
-   database queries
-   external service response time

------------------------------------------------------------------------

# 8. Current Development Priorities

Priority 1:

Improve AI writing review stability.

Goals:

-   Reduce timeout rate
-   Maintain the fixed Kimi provider and same-provider hedge
-   Reduce unnecessary retries
-   Maintain review consistency

Confirmed product rule:

-   Runtime multi-provider fallback is not a current requirement.

------------------------------------------------------------------------

Priority 2:

Continue writing module refinement.

Possible areas:

-   Teacher workflow efficiency
-   Feedback editing experience
-   Student review experience

------------------------------------------------------------------------

Priority 3:

Platform-wide performance optimization.

Focus:

-   unnecessary requests
-   duplicated loading
-   cache strategy
-   static UI rendering

------------------------------------------------------------------------

# 9. Important Recent Technical Decisions

## Writing Review

Final authority:

Teacher published review.

AI output:

Draft assistance only.

## Question Identity

Permanent identity must never change.

Display numbering can change when necessary.

## UI

Internal development concepts must not appear to users.

Current UI rule violations:

-   The teacher import UI displays “新逻辑题”.
-   A student practice catalog error can expose the term “logical”.

Approved UI exception:

-   AI log pages may display technical terminology such as “Schema版本” and
    “Schema 校验”. Other product-facing UI may not expose internal terminology.

## Confirmed Product Decisions

-   Writing review schema v2.2 replaces the previously documented scoring
    dimensions.
-   The current Content Feedback categories, including language_improvement,
    social_conventions, and discussion_contribution, are approved.
-   AI review generation remains teacher-triggered.
-   Production retains the fixed Kimi provider and same-provider hedge.
-   Current custom Email question fields and input behavior are approved; code
    behavior is authoritative.
-   Logical catalog pagination remains client-side.

------------------------------------------------------------------------

# 10. Recommended Next Development Approach

For any new feature:

1.  Confirm product requirement.
2.  Identify affected modules.
3.  Check existing database relationships.
4.  Implement smallest safe change.
5.  Test affected workflow.
6.  Update documentation.

Avoid:

-   rewriting completed architecture
-   changing stable data structures unnecessarily
-   mixing unrelated feature changes

------------------------------------------------------------------------

END OF STATUS
