# RAP 按题型分类练习：实施交付

本轮功能代码、正式 migration、独立 verification SQL、相关测试及离线本地 UI 验证已完成。**未连接 production DB、未执行 migration／verification SQL、未调用真实账号 production RPC、未创建 production attempt、未 commit／push／deploy。**

> 上述为第一阶段交付记录。用户现已确认 production migration 成功，完整 verification 返回 `question_category_verification_passed`；最终收尾／发布状态见 [post-migration 报告](reading-question-category-release-20261007.md)。不重复执行这两个 SQL 文件。

## 1. 模型及安全边界

只新增两张表：

- `reading_question_category_sessions`：owner、category、请求题量档位、永久冻结的轻量 manifest、已提交 group progress、未提交 workspace draft、累计分数／用时／完成状态。
- `reading_question_category_session_answers`：每道 frozen question 一行真实作答，含 `student_answer`、authoritative `is_correct`、作答时间；不复制题干、options、correct answer 或 category。

不新增 source／child attempt 表，不插入 `reading_attempts` 或 `reading_wrongbook_attempts`，不更新 `student_practice_item_state`。同一学生已有的整篇 RAP draft 因此不会被占用或替换。

`amount` 保存 5／10／15／20 请求档位。沿用既有 wrongbook chooser，题池不足时实际题量是 `min(amount,poolCount)`；例如 8 题的池可以选 10 档，frozen targets／最终 totalPoints 都是 8，而不是制造两道不存在的题。

RLS 只开放本人 SELECT；answer SELECT 经 parent owner 校验。authenticated 无直接 INSERT／UPDATE／DELETE。创建请求只接受 `questionCategory + amount`，server 验证 active Student Experience account 后通过 service-role 写入 server 生成的 manifest；插入 trigger 再检查身份、题型、关联、数量和重复 identity。manifest／owner／category／amount 不可修改，完成结果不能退回 active 再累计 summary。

首页 counts RPC 一次聚合，仅返回固定十类及 count。抽题只查询 question identity／canonical order，口径始终为 `module='rap'` 和指定 category，不加 `is_active`，不改变 importer、CSV、分类或现有 RAP 去重。canonical content loader 经审计没有 inactive logical item 的硬限制。

只新增一个 RAP pool covering index 和一个 owner/completed-at history index；answers 的 `(session_id,question_id)` unique index 同时支持按 session 读取。

## 2. 提交和正常练习语义

`submit_reading_question_category_group(session_id,logical_item_id,elapsed_seconds,answers)`：

- 验证 `auth.uid()`、active profile／Student Experience capability，锁定 owner session row。
- frozen manifest 提供唯一 authoritative targets；只允许当前第一个未提交 group。
- 强制逐题齐全、无重复／额外／缺失 question，验证 RAP、category、logical item、answer kind 和真实 option／anchor／目标 paragraph sentence identity。
- 数据库内部判分；unanswered 仍写一行，存 NULL／incorrect。
- answers、progress、aggregate、completion 和 summary transition 在一个 RPC 事务中写入。
- 已提交 group 的重试返回 `alreadySubmitted=true`，不再插入 answers、不加时间／分数。

API 只对首次提交的 authoritative graded answers 调用共享 `applyReadingGradedWrongEvents`。ordinary Reading 的 `applyReadingAttemptWrongEvents` 也委托给这个 helper，继续复用 `readingWrongAnswerEvents` → `applyStudentWrongQuestionEvents` → canonical `apply_student_wrong_question_events`，practice date 使用原 `wrongQuestionBusinessDate`。

这不是 correction：错误／未答进入正常 wrong 事件，答对不清除已有历史错题；幂等重试不重放事件。与 ordinary Reading 一致，错题事件是提交后的辅助 API 写入，事件服务失败不回滚已完成的权威提交。**本轮没有设计 outbox／跨 RPC 分布式事务，因此不声称网络失败下 exactly-once 事件投递。**

## 3. 共享 runner／内容和恢复

`components/reading/ReadingMultiSourceSessionRunner.tsx` 从实际 wrongbook bank practice 抽取：

- frozen groups、groupStarts、全局编号、当前 group、跨 source Previous。
- 单个稳定 `ReadingPracticeShell`，source-local pending，切 source 不重建 header。
- 当前 canonical source hydration + 一个 next source 预取；StudentDataCache；适用时的 next RDL image preload。
- source-local 答案／question times／workspace index、session 累计 timer、只读已提交 source、完成导航。

Wrongbook adapter 保留 correction API／attempt／entry／结果链及 CTW preserved/context answers；category adapter 不创建任何 child attempt，通过 category API 做正常 partial submit。category 的 renderer summary 只是共享 shell 的 UI metadata。

`selectReadingTargetPractice` 是原 selector 的中性名称，`selectReadingWrongbookPractice` 保留为同一函数的兼容 alias。两种业务不复制筛题逻辑，仍展示原 canonical passage，只导航／提交 frozen targets。

category 创建后将 session id pin 到 URL。refresh／resume 读取同一 manifest，不抽新题；已提交 progress 和 answers 来自服务器。未提交 workspace 在 parent session.draft 中周期保存，当前浏览器立即保存 sessionStorage checkpoint，恢复答案、题目位置、question times 和当前 group elapsed。同步失败提示本浏览器 checkpoint 并继续重试。跨 source Previous 保存当前 checkpoint、暂停已提交 source 计时且不重复提交。

## 4. 结果、review、历史及 summary

结果复用 `PracticeResultSummary`、`ReadingResultDetailCard`、frozen/global steps。轻量 session+answer 查询直接得到真实 aggregate 和 1..N 题目，不请求每篇 source attempt 的结果。标题为 `题型分类练习·${questionCategory}`，breadcrumb／Back 走 category 链路。

review 复用现有 `buildReadingWrongbookSessionReviewPayload` 的 global shape／placeholder 和 `ReadingFullSetReviewShell`；只获取当前 source 的 answer disclosures 和 canonical passage，预取一个 next source。result/session cache 已含轻量 shape/status；hard refresh 也不 hydration 整场正文。

重新练习复用 `nextWrongQuestionHistoryAmount(session.amount)`，同 category／档位创建新 session，由 server 再随机生成 manifest；URL 不携带旧 session／targets。

学生与教师共用的单日／范围 loaders 都加入 completed category sessions。历史 source kind 为 `question_category`，task 仍 RAP，一 session 一条，标题运行时派生；active session 不进入历史。source groups 从来没有普通 attempt，天然不会形成多条 history。学生结果／retake 导航定位 session；教师复用既有 Reading result/review UI 和教师 scope 校验，不额外设计教师界面。

独立 completion trigger 仅在 `active -> completed` 调用一次 `apply_student_practice_summary_increment`，累计整场 elapsed。`rebuild_student_practice_summary` 保留现有五类来源，并加入 completed category sessions 的 UNION；不写 passage-level item state。完成后刷新学生 summary/history cache，内容目录变更使 category counts cache 失效。

## 5. 主要文件

### SQL／domain／API

- `supabase/reading_question_category_sessions_20261007.sql`
- `supabase/reading_question_category_verify_20261007.sql`
- `lib/reading/questionCategory.ts`
- `lib/reading/questionCategory.server.ts`
- `lib/reading/questionCategoryHistory.server.ts`
- `lib/reading/questionCategory.client.ts`
- `app/api/reading/question-category/route.ts`
- `app/api/reading/question-category/sessions/[sessionId]/route.ts`
- `app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/route.ts`
- `app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/review/route.ts`
- `app/api/teacher/students/[studentId]/reading/category-sessions/[attemptId]/route.ts`

### 共享/UI/routes

- `components/reading/ReadingMultiSourceSessionRunner.tsx`
- `components/reading/ReadingWrongbookBankPractice.tsx`
- `components/reading/ReadingPractice.tsx`
- `components/student/PracticeAmountDialog.tsx`
- `components/WrongQuestionsHome.tsx`
- `components/reading/QuestionCategoryPracticeHome.tsx`
- `components/reading/QuestionCategoryPractice.tsx`
- `components/reading/QuestionCategorySessionResult.tsx`
- `components/reading/QuestionCategorySessionReview.tsx`
- `app/student/question-category-practice/page.tsx`
- `app/student/question-category-practice/practice/page.tsx`
- `app/student/question-category-practice/sessions/[sessionId]/page.tsx`
- `app/student/question-category-practice/sessions/[sessionId]/questions/[questionIndex]/page.tsx`
- `app/teacher/students/[studentId]/reading/category-sessions/[attemptId]/page.tsx`
- `components/student/StudentShell.tsx`
- `components/StudentDataCache.tsx`
- `components/teacher/TeacherStudentReadingAttemptDetail.tsx`
- `lib/studentNavigation.ts`、`lib/studentUiText.ts`
- `lib/reading/wrongbook.ts`、`lib/wrongQuestionBank.ts`、`lib/reading/wrongQuestionEvents.server.ts`
- `lib/studentPracticeHistory.ts`
- `lib/teacherStudentPractice.ts`、`lib/teacherStudentPractice.server.ts`
- `lib/teacherStudentPracticeRange.ts`、`lib/teacherStudentPracticeRange.server.ts`

### 验证

- `tests/readingQuestionCategory.test.js`
- `tests/fixtures/questionCategoryBrowser.cjs`（synthetic content，不是 canonical asset collection）
- `scripts/verify-reading-question-category-ui.cjs`
- runner 抽取位置变化对应的四个 existing wrongbook regression test 文件。

## 6. 测试和截图

| 检查 | 结果 |
|---|---|
| category／history／teacher range／wrongbook 相关测试 | **174/174 通过** |
| 全仓 `pnpm test` | **2310/2317 通过；7 项现有失败** |
| `pnpm exec tsc --noEmit` | 通过 |
| `pnpm lint` | 通过；仅 3 条已有 `<img>` warning |
| `pnpm build` | 首次及最终完整 build 均通过；使用离线 Supabase 环境覆盖 |
| SQL／PL/pgSQL parser | migration 32 statements、verification 7 statements，语法通过；没有执行 SQL |
| 离线真实 localhost UI | 通过，0 page errors，0 production requests |
| `git diff --check` | 通过 |

相关单测包含：固定分类、随机/group/canonical 顺序、不足题量共享规则、20 题全局编号、partial selector/unanswered、ordinary wrong 事件语义、session 级 history/date/range、retake、SQL owner/lock/targets/类型／重试／completion／summary／rebuild／无 item-state 写入等 contract assertions。

**SQL contract assertions 和 mock 测试不是数据库执行测试。** RPC concurrency、真实 FK/RLS/ACL、权威判分事务及真实 summary trigger 尚未在数据库运行。

全仓现有失败：

1. `readingCtwInteraction.test.js`：旧 focus effect source assertion。
2. `readingHistoryRetake.test.js`：旧题号 wording source assertion。
3. `readingQuestionTimePersistence.test.js`：旧 unknown-time source assertion。
4. `readingRapInteraction.test.js`：旧 font source assertion。
5. `readingRdlInteraction.test.js`：旧 option span source assertion。
6. `teacherDashboardHome.test.js`：旧 pending-count source assertion。
7. `readingRealData.test.js`：历史 canonical runtime image checksum assertion。

前六项在 HEAD 的临时只读 baseline snapshot 中复现；第七项未修改的历史资产校验仍失败。没有为了本功能重写这些断言或碰 Reading 历史资产／Desktop production／_work。

浏览器按本地启动规则先正常启动指定 checkout 并等 Ready，再在本 session checkout 正常 `pnpm dev`（自动使用空闲 3001）并等 Ready。整个认证／验证只用 `http://localhost:3001`，通过正常 localhost login UI 输入本地 credential 文件中的 Student 凭据；auth 和所有 API 完全拦截为离线 fixtures。凭据不写入源码、tests、日志或截图，没有创建测试账号。验证完成后关闭了本轮启动的两个 dev servers。

截图：

- [分类首页 desktop](question-category-ui/home-desktop.png)
- [分类首页 mobile](question-category-ui/home-mobile.png)
- [共享 amount dialog／不足题量](question-category-ui/amount-shortfall.png)
- [refresh 恢复已选答案](question-category-ui/practice-resumed.png)
- [跨 source practice](question-category-ui/practice-cross-source.png)
- [20 题聚合结果](question-category-ui/result-20.png)
- [全局第 14 题 read-only review](question-category-ui/review-question-14.png)
- [离线 UI 验证数据](question-category-ui/verification.json)

## 7. 用户下一步／SQL 顺序

**目前只手动执行** `supabase/reading_question_category_sessions_20261007.sql` 的完整文件，然后贴回成功结果／错误。这是 one-shot、BEGIN/COMMIT migration；不要重复运行成功的文件，不要运行历史 initialization/reset SQL，也不必重新跑上一轮只读 preflight。

正式 migration 包含两表、constraints、indexes、RLS/policies/ACL、manifest guard、updated_at、counts/get/draft/submit RPC、completion summary trigger 和 summary rebuild。文件不包含真实账号或生产作答。

独立 verification SQL 已生成在 `supabase/reading_question_category_verify_20261007.sql`，**本轮不要执行**。等 migration 成功反馈后再交付确认执行步骤：metadata assertions、匿名请求在访问业务数据前被拒绝的 rollback transaction，不创建或读取真实学生作答。

顺序：

1. 用户执行正式 migration。
2. 用户返回 migration 成功／错误；先核对，不自行修生产。
3. 仅在成功后，用户执行独立 verification 并返回 `question_category_verification_passed`。
4. 数据库已具备新表／函数后才能做真实 counts/RPC/ownership/history/summary 验收；在不允许 production attempt 的前提下，有身份的作答／并发／wrong-event 行为应在**另行批准的隔离测试库**验证，而不是用 production 真实账号冒充验收。
5. 本轮仍不 commit／push／deploy。后续发布前必须先确认 migration 完成，不能把读取新表的代码部署在未迁移的数据库上。
