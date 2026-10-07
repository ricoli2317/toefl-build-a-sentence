# RAP 按题型分类练习：实施前模型审计

状态：**上一轮的历史审计记录。已根据用户确认的 production preflight 继续实施；当前交付见 [实施报告](reading-question-category-implementation-20261007.md)。**

本报告基于实际应用代码和仓库中相关 SQL，不将仓库 SQL 当作已核实的生产 schema。没有连接生产数据库、调用业务 RPC、写入生产数据或使用真实账号创建 attempt。未改 Sidebar、route、业务组件、去重、分类数据或 importer。

## 1. 当前模型与冲突证据

### 普通 RAP 提交是整篇提交，不是 frozen target 提交

- `app/api/reading/attempts/[attemptId]/submit/route.ts:58` 调用 `submit_reading_attempt_with_times`。
- `supabase/reading_question_time_persistence.sql:34` 和 `supabase/reading_attempts.sql:462` 中该函数继续调用 `submit_reading_attempt`。
- `supabase/reading_attempts.sql:341–353` 按 logical item 的全部 question 计算 expected points，并核对整篇 `scored_item_count`。
- `supabase/reading_attempts.sql:383–417` 从整篇所有 question 写答案，未传入的 question 也会进入写入集合。
- `supabase/reading_attempts.sql:509–510` 的 time wrapper 要求带时间的答案数等于整篇总计分数。

因此客户端过滤到 1–3 个 question 后调用普通 submit，不能实现正常 partial practice；按仓库实现会触发计分/时间约束，绕开 wrapper 又会将未抽中的题记为未答。不能采用此路径。

此外，普通 attempt 的 draft 唯一键是 `(student_id, logical_item_id, task_type)`，没有 session 身份（`supabase/reading_attempts.sql:55–57`）；直接复用普通 draft 还可能与学生已有的整篇练习互相抢占。

### 可用的 partial submission 明确属于 correction

- `reading_wrongbook_attempts.scope` 是 `today/history`；`student_wrong_question_sessions.mode` 同样只表示 `today/history`。
- `app/api/reading/wrongbook-attempts/[attemptId]/submit/route.ts:68–79` 调用 correction RPC，并依据 scope 触发 correction events。
- `lib/wrongQuestionBank.ts:259–274`：history correction 不产生事件；today correction 仅对正确答案发 `corrected`。
- `lib/wrongQuestionBank.ts:238–252`：正常 Reading 错题是另一条 `readingWrongAnswerEvents` 路径，发 `wrong`。

不能通过添加 category、改标题或强制 scope 来复用 correction 提交业务。

### 当前学生历史按普通 attempt 展示，且排除 wrongbook

- `lib/studentPracticeHistory.server.ts:20–23` 固定 `includeWrongbook: false`。
- `lib/teacherStudentPractice.server.ts:379–393` 查询普通 `reading_attempts`；`lib/teacherStudentPractice.ts:400–423` 为每个 attempt 生成一条记录。
- `lib/studentPracticeHistory.ts:195` 不为 wrongbook 记录生成结果入口；普通 RAP 导向单篇 Reading result。
- 范围统计也从普通 attempt 逐条计数（`lib/teacherStudentPracticeRange.server.ts:66–77`）。只修改单日列表会造成范围统计与记录不一致。

多篇 child 普通 attempt 会展示为多条；放进 wrongbook 又不会进入学生历史。现有正常练习模型没有 session-level identity。

## 2. 确认可以共享的能力

| 能力 | 实际实现 | 使用边界 |
| --- | --- | --- |
| 5/10/15/20 规则 | `lib/wrongQuestionBank.ts` 的 `wrongQuestionAmountOptions`、`wrongQuestionPracticeCount`、amount parser | 全部不超过总量的档位 + 最小超出档位可用；0 题全禁用；实际题量取 min。提示语需要共享参数化，不复制规则。 |
| 题量 dialog 视觉 | `components/WrongQuestionsHome.tsx` 的 `WrongQuestionHistoryDialog` | 抽共享呈现组件，wrongbook/category 注入各自 count、说明和导航。 |
| 题目级抽样与 grouping | `shuffleWrongQuestionTargets`、`buildReadingSessionGroups` | 第一遇到 item 的顺序不变；同 item 按 canonical question_order 排序。服务端冻结后不重抽。 |
| 全局编号 | `lib/reading/wrongbookSession.ts` 的 group starts、steps、progress label | 都是身份/顺序机制，不涉及 correction 判分。 |
| 稳定 shell 和跨 source Previous | `ReadingWrongbookBankPractice` + `ReadingPracticeShell.session` | 抽 runner 通用层；`session` 已将答案、时间和提交回调交由父层控制，不必让正常练习走 `wrongbook` submit。 |
| 当前材料 + 下一材料预取 | `ReadingWrongbookBankPractice:217–228,339–370` | 继承 StudentDataCache、in-flight 去重和局部 pending；不预加载全场。 |
| 冻结 URL / refresh | `ReadingWrongbookBankPractice:145–173` | 创建后 pin session ID；新 session 与 resume 区分。 |
| 结果组件及 aggregation | `ReadingWrongbookSessionResult`、`PracticeResultSummary`、`ReadingResultDetailCard`、session merge helper | category 使用正常练习标题和链路；答案结果可以批量读取，不能加载全场正文。 |
| 多材料只读 review | `ReadingWrongbookSessionReview` + `ReadingFullSetReviewShell` | 复用 shape/global index/source-first/cache 机制，注入正常练习数据源。 |

### 现有性能实现中不能盲目照搬的部分

- wrongbook result 当前通过 `Promise.all` 并发获取 source results，不是 N+1 串行请求；新存储可一次批量获取本 session 的判分行，更轻。
- wrongbook review 当前除当前位置和相邻 source 外，还会后台逐个读取剩余 source（`ReadingWrongbookSessionReview:229–253`）。hard refresh 下会走 full review。category 不能因此预先 hydration 全场正文：共享层需区分轻量答案预取与正文按需加载。
- wrongbook runner 的 `sessionElapsed` 从 0 起，答案存在 React state；group progress 保存在服务端，但未见该 runner 的未提交答案/位置持久化。category 的 refresh/resume 需要明确持久化当前答案、位置、question times 和累计 elapsed，不能只复制该行为声称完整恢复。

### 重新练习已存在

`ReadingWrongbookSessionResult:201–207,232–235` 为 history session 提供“重新练习”。它使用 `nextWrongQuestionHistoryAmount` 将 effective amount 映射回合法档位，进入新创建入口，不携带原 session ID。

category 应保持题型并遵循同一档位逻辑，创建新的随机 manifest；不能复用旧 manifest。

## 3. 最小且语义正确的改造建议

以下为待核实生产 schema 后实施的建议，**尚未建立任何表或 RPC**。

1. 增加独立正常练习模型，而不是扩展 wrongbook 的业务含义：
   - `reading_practice_sessions`：owner、kind=question_category、category、合法 requested amount、actual count、frozen manifest、progress、active/completed、汇总计分/用时、完成时间。
   - `reading_practice_session_sources`：以 `(session_id, logical_item_id)` 唯一绑定 source 身份、draft/submitted 状态及未完成答案/位置/计时；不复用整篇普通 RAP 的 draft。
   - `reading_practice_session_answers`：只保存本 session/group frozen targets 的正常判分记录，复合身份约束关联 session/source/question。
2. 专用的正常 partial-target submit RPC：锁 session/source，校验 owner、当前 group、RAP、category、question/item 关系、target 集合、答案选项/anchor/sentence 和重复提交；只判分 frozen targets。
3. 提交、group progress、session completion 和 wrong bank `wrong` 事件尽量在同一事务落地。复用现有 canonical identity 和 wrong-event 应用逻辑，不调用 correction events；沿用服务端业务日期。重试不重新发旧 wrong 事件导致 pending 被重新打开。
4. 多材料 runner 抽为共享层；业务 adapter 提供 session/source 加载、保存、提交、结果路由和 cache invalidation。wrongbook adapter 保持原语义，category adapter 使用正常练习语义。
5. Student History 只读取 session summary，将每个已完成 category session 映射为一条正常 RAP record，标题 `题型分类练习·${category}`，identity 为 session ID。内部 source 表不进入现有普通 attempt 查询，因此不需要“隐藏 4 条”的补丁。单日、范围计数/正确率和 result/retake navigation 同时接入 session 身份。
6. 分类 count 和服务端抽样共用一套 RAP/category 查询口径；首页一次聚合只返回 10 类 counts。现有 RAP catalog 按 module 查询，没有题目 is_active 过滤，不自行引入该条件，不改变去重。
7. 不将 partial source 标为原整篇 RAP 完成，不让目录的 `student_practice_item_state` 把 1 题 partial 当成整篇 completed。检查现有统计 triggers，避免汇总 double count。

## 4. 需要的 SQL 与执行顺序

### 现在只执行只读 preflight

文件：`supabase/reading_question_category_preflight_20261007.sql`。

执行顺序：只有这一个文件。它查询 PostgreSQL 系统目录中的列、约束、索引、RLS、policies、grants、triggers 和现有相关函数定义，不调用业务函数，不读取学生 attempt/答案数据，不做任何写入。

请将返回的 `question_category_schema_preflight` JSON 完整贴回（较长可以导出文件），以核实仓库 SQL 与真实结构的差异。

### 后续

核查结果后才生成 additive feature migration 和对应只读 verification SQL，给出明确执行顺序，由用户手动执行。当前 preflight **不是 migration**，执行它不会启用功能。

## 5. 本轮改动与验证状态

- 新增本审计说明和只读 preflight SQL；没有业务实现、route/API/schema 变更。
- 未运行功能单测、typecheck、lint、build：本轮停在用户要求的模型冲突说明阶段，尚无功能代码可验收。
- 未启动本地学生 browser verification、未生成 UI 截图；不能将现有页面或 mock 截图当作新功能验收。
- 未 commit、push、deploy，未写生产数据。
