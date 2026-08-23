# TPS 代码库与文档一致性分析报告

本报告基于以下文档与当前代码进行只读交叉核对：

- `TPS_CONTEXT.md`
- `TPS_STATUS.md`
- `CODEX_RULES.md`
- `TPS_CODEBASE_ANALYSIS.md` 的上一版本

结论：核心业务方向基本一致，但数据库文档、写作批改模型和部分 UI/性能实现已出现明显漂移。

## 1. 项目理解

TPS 是一个基于 Next.js、TypeScript、Supabase、PostgreSQL 和 Supabase Auth 的 TOEFL 教学平台，当前包含以下核心系统。

### 1.1 统一逻辑题库

系统把“永久内容身份”和“展示信息”分开：

- `practice_items` 保存稳定逻辑身份。
- `practice_item_sources` 关联多个历史原始来源。
- `practice_item_occurrences` 保存出现日期。
- `practice_item_question_map` 处理 BAS 原题到逻辑 Q1–Q10 的映射。
- `display_number` 只用于展示，可以从 `058` 调整为 `058A`，但 `item_id` 不变。

该原则已经真实落地，核心实现位于：

- `lib/practiceLogicalCatalog.ts`
- `lib/practiceImporter/server.ts`
- `supabase/practice_importer_v2.sql`

### 1.2 Build a Sentence

已实现：

- 逻辑套题目录
- 句块排序练习
- 服务端评分
- 每题用时
- 练习结果和同伴对比
- 历史记录
- 今日/历史错题
- 语法标签练习
- 教师套题、单题、学生表现统计

### 1.3 写作系统

支持：

- Write an Email
- Academic Discussion
- 模考模式和练习模式
- 草稿保存及恢复
- 计时、超时区间
- 多次提交
- 写作提交历史
- 教师批改
- 学生查看已发布反馈

### 1.4 作业系统

教师可以从题库或自定义题目布置作业，支持：

- 多学生
- 多篇作业分组
- 截止时间
- 撤回、编辑、重新布置和软删除
- 题目快照
- 提交后内容锁定
- 学生逾期提交

### 1.5 AI 批改系统

当前生产流程是：

1. 学生提交写作。
2. 教师进入批改工作区并触发 AI 初批。
3. OpenRouter 调用固定的 Kimi K3。
4. 校验 v2.2 JSON Schema 和原文位置。
5. 保存为教师工作稿。
6. 教师编辑或重生成反馈。
7. 教师发布快照。
8. 学生只能看到发布快照。

系统实现了：

- 重复生成保护
- 并发保存恢复
- 超时处理
- hedged request
- 成本和 token 日志
- AI 输出格式校验
- 原文位置校验
- 单条反馈和全文重生成

### 1.6 与文档一致的重要部分

以下关键原则已经正确落地：

- 展示编号不作为数据库永久身份。
- 历史提交仍关联原始题目。
- 作业使用题目快照。
- 学生只能读取 `published` 批改。
- AI 结果不能直接替代教师发布。
- 作业撤回和学生访问有服务端校验。
- 旧月份 URL 保留兼容跳转。
- 静态页面结构通常先显示，动态区域独立加载。

## 2. 文档与代码不一致点

### 2.1 数据库类型严重不一致

`TPS_CONTEXT.md` 明确规定以下字段为 TEXT：

- `questions.question_id`
- `questions.set_id`
- `attempts.set_id`
- `attempt_answers.question_id`
- `attempt_answers.set_id`

但 `supabase/schema.sql` 仍把这些字段定义为 UUID。

此外，文档要求 `attempt_answers.question_time_seconds`，当前业务代码会读写该字段，但基础 `schema.sql` 没有定义它。

结论：`schema.sql` 是早期版本，不能代表当前数据库。

### 2.2 基础数据库脚本与当前项目不匹配

`schema.sql` 会先级联删除：

- `profiles`
- `question_sets`
- `questions`
- `attempts`
- `attempt_answers`

但它没有创建当前项目所需的多个核心表：

- `practice_items`
- `practice_item_sources`
- `email_questions`
- `academic_discussion_questions`
- `writing_attempts`
- `writing_reviews`

仓库只有针对部分表的增量 SQL，缺少完整、可顺序执行的数据库基线。因此当前代码不能仅依靠仓库 SQL 在新环境中完整重建。

### 2.3 作业字段名称与文档不一致

`TPS_CONTEXT.md` 描述：

- `id`
- `deadline_at`

当前数据库和代码实际使用：

- `assignment_id`
- `due_at`

实际定义位于 `supabase/writing_assignments.sql`。

这属于文档落后，不一定是代码错误，但会误导后续数据库开发。

### 2.4 AI 批改触发时机不一致

文档流程写成：

> 学生提交 → AI 初批 → 教师编辑 → 发布

当前代码没有在学生提交时自动生成 AI 批改。AI 请求由教师批改工作区调用：

- `/generate-ai`
- `/regenerate-ai`

因此实际流程是：

> 学生提交 → 教师进入工作区 → 教师触发 AI → 教师编辑 → 发布

需要明确究竟是文档描述不准确，还是自动初批尚未实现。

### 2.5 写作评分维度不一致

文档中 Email 有六个评分维度，Academic Discussion 有五个。

当前代码使用一个官方总分，加四个诊断维度。

Email：

- `communicative_purpose_and_elaboration`
- `syntactic_range_and_word_choice`
- `social_conventions`
- `lexical_and_grammatical_control`

Academic Discussion：

- `relevance`
- `elaboration`
- `syntactic_range_and_word_choice`
- `lexical_and_grammatical_control`

实际定义位于 `lib/writingReviewSchemaV2.ts`。

这是明确的业务模型漂移，应决定以代码还是文档为准。

### 2.6 反馈分类定义不完全一致

文档要求：

- Language Edit 只处理语法、拼写、标点和明确语言错误。
- Content Feedback 只处理观点、解释、组织和内容发展。

代码的 Content Feedback 分类还包括：

- `language_improvement`
- `social_conventions`
- `discussion_contribution`

这不一定代表当前输出一定混类，但代码允许的分类体系已经超出文档定义，需要重新确认产品规则。

### 2.7 AI Provider 设计不一致

文档要求 Kimi、DeepSeek、Qwen 可以在不改变业务逻辑的情况下切换。

当前生产代码固定为：

```text
moonshotai/kimi-k3
```

生产配置位于 `lib/writingReviewProductionHedge.ts`。

DeepSeek、Qwen 主要存在于基准和模型比较脚本，并没有形成生产环境的可配置 provider 策略。

### 2.8 自定义 Email 作业输入规则有差异

文档描述教师只提供：

- 标题
- 场景
- 三个要求

系统自动添加固定 TOEFL 指令。

当前实现还需要或保存：

- recipient
- subject
- 从完整题目中解析出的 `task_instruction`

虽然 closing instruction 是固定生成的，但主 task instruction 可以从教师粘贴的完整题目中保留，相关实现位于 `lib/writingAssignments.ts` 和 `components/teacher/TeacherWritingAssignmentForm.tsx`。

### 2.9 UI 暴露了内部术语

文档和 `CODEX_RULES.md` 都禁止向学生或教师显示：

- Logical Item
- schema
- 内部字段名
- 开发概念

当前存在以下情况：

- 教师导入结果显示“新逻辑题”。
- AI 日志页面显示“Schema 版本”“Schema 校验”。
- 学生逻辑目录 API 失败时返回 `Could not load the logical practice catalog.`，前端可能直接显示该错误。
- 部分教师组件的数据契约直接使用 `logical_item_id`、`logical_display_name`，目前主要作为内部属性，但需要防止进入用户文本。

最直接的违规点位于 `components/TeacherImportQuestions.tsx`。

### 2.10 分页实现与性能原则不一致

文档要求避免过度加载和不必要请求。

当前逻辑题库 API：

- 固定使用 `page: 1`
- 获取当前题型全部逻辑项目
- 前端使用 `slice()` 做分页
- 翻页只修改本地 state
- URL 中的 `?page=` 不会随翻页更新

相关实现位于：

- `lib/practiceLogicalCatalog.ts`
- `components/LogicalPracticeCatalog.tsx`
- `app/api/practice-catalog/route.ts`

数据量较小时可工作，但不符合“服务端分页、避免过度加载”的方向，也破坏可分享和刷新恢复的页码状态。

### 2.11 “稳定运行”与测试状态不完全一致

`TPS_STATUS.md` 将 BAS 描述为“Stable and operational”。

当前测试结果：

- 800 项
- 792 通过
- 8 失败

失败涉及：

- 逻辑目录分页
- URL 页码
- 历史显示映射
- 草稿恢复
- 缓存失效
- 动态 API 缓存策略

部分失败属于基于源码正则的脆弱契约测试，不一定都是运行时缺陷；但项目当前不能被描述为完整测试通过状态。

### 2.12 文档本身未进入版本控制

当前四份文档均为未跟踪文件：

```text
?? CODEX_RULES.md
?? TPS_CODEBASE_ANALYSIS.md
?? TPS_CONTEXT.md
?? TPS_STATUS.md
```

如果这些文件代表正式产品决策，它们当前不会随正常 Git 提交和部署流程传播。

## 3. 开发风险

### 3.1 高风险：数据库没有权威来源

当前最严重的问题是无法确定：

- 生产表的完整定义
- 实际字段类型
- 当前 RLS policy
- grants
- trigger
- function
- 索引和唯一约束

继续根据过期的 `schema.sql` 开发，可能导致破坏历史数据或创建不兼容迁移。

### 3.2 高风险：潜在角色提权和成绩伪造

如果线上仍存在基础 schema 中的策略：

- 用户可以更新自己的 `profiles` 行，可能修改 `role`。
- `handle_new_user` 信任用户 metadata 中的角色。
- 学生可以直接插入自己的 attempts 和 answers。

由于浏览器持有 Supabase anon key，RLS 是实际安全边界，不能只依赖 Next.js API。

### 3.3 高风险：BAS 提交可混入不同套题的问题

`app/api/submissions/route.ts` 在收到 `questionIds` 时只按 ID 查询，没有确认所有题目属于请求的 `setId`。

恶意请求可能创建：

- attempt 汇总属于套题 A
- attempt_answers 实际包含套题 B/C 的题目

这会污染正确率、历史记录、同伴比较和教师统计。

### 3.4 中风险：Service Role 的影响范围过大

API 路由中约有 22 处创建 service-role Supabase 客户端。虽然多数接口先鉴权并附带用户范围过滤，但 service role 绕过 RLS。

任何未来漏写以下过滤条件的修改都可能造成跨用户数据读取：

- `user_id`
- `student_id`
- `teacher_id`
- `attempt_id` 所有权
- `assignment_id` 成员关系

### 3.5 中风险：写入缺少数据库事务

BAS 提交分两步执行：

1. 插入 attempt
2. 插入 attempt_answers

第二步失败后由应用代码补偿删除，并非原子事务。

创建学生也先创建 Auth 用户，再保存 profile；profile 失败时会留下孤立账号。

### 3.6 中风险：测试套件未全绿

8 个失败测试意味着无法把当前分支作为完全可信的回归基线。继续开发前应先把失败分为：

- 真实产品回归
- 实现方案改变后测试未更新
- 过度依赖源码文本的脆弱测试

其中逻辑目录分页至少存在可确认的实现偏差。

### 3.7 中风险：客户端可影响计时和统计

以下数据主要由客户端提交：

- BAS 总用时
- BAS 每题用时
- 写作 elapsed seconds
- 写作 remaining seconds
- overtime ranges

代码有基础规范化，但这些数据不能作为防作弊或高可信分析依据。

### 3.8 中风险：AI 延迟和成本放大

生产配置为：

- 60 秒后启动第二个相同模型请求
- 240 秒总超时

这可以改善长尾成功率，但可能造成：

- 单次批改双倍费用
- Vercel 超时
- 用户重复点击
- 上游并发压力
- loser 请求取消后仍产生部分成本

### 3.9 低至中风险：页面缺少统一服务端访问守卫

学生和教师布局主要提供 UI Shell，没有 middleware 或服务端 layout 级角色跳转。数据 API 通常有鉴权，因此主要风险是：

- 未登录用户看到空页面或错误状态
- 角色错误时体验不一致
- 所有安全责任集中在每一个 API 路由上

### 3.10 维护风险：文档和实现继续漂移

当前已有多处“文档描述旧模型、代码实现新模型”的情况。如果没有明确权威来源，后续开发者可能：

- 按文档恢复旧评分维度
- 使用错误字段名创建迁移
- 误运行破坏性的 `schema.sql`
- 误以为 AI 会在提交后自动执行
- 在 UI 中继续暴露内部术语

## 综合结论

项目核心业务架构是健康的，尤其是稳定身份、历史兼容、作业快照和教师发布控制。但当前不能简单认定“代码与文档一致”。

建议优先顺序为：

1. 确立实际 Supabase schema 和 RLS 为权威基线。
2. 决定写作评分维度、反馈分类和 AI 触发时机的正式产品规则。
3. 修复 BAS 提交套题边界。
4. 对 8 个失败测试逐项归类。
5. 清理用户界面的内部术语。
6. 更新并纳入版本控制的正式文档。

本报告基于只读代码审阅、文档交叉核对和自动化测试结果生成。除更新本报告外，未修改其他项目文件。
