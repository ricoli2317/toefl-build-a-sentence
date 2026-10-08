# TPS 生词本 V1 — Phase A2

## 接入

- `POST /api/lexical/wordbook`：`{ action: "save" | "remove" | "status", selection: LexicalLookupRequest, entryId, occurrenceId }`。
- 不接收可信 student/domain/例句/释义/enrichment；归属来自逐请求账户鉴权，domain 来自六题型映射。
- 每次操作复用 lookup 的 owned-page authorization、canonical block hash、选择 span 和匹配规则。只有本次主结果或 containing phrase 的 entry/occurrence 配对可用。active Reading 仍拒绝；BAS prompt、Writing 原有可见性规则不改。
- 常规状态直接附加到原 lookup response 的可选 `wordbook` 字段；一次 owner/domain/canonical unique-key 查询，不增加第二个浏览器请求或 corpus 扫描。状态不可用时不影响原查词；操作前通过 `action: status` 恢复状态。
- 所有响应 `no-store`。本轮没有列表 API、独立页面或 enrichment 展示/复制。

## 单事务与部署前提

**A1 只有五表及 guards，没有收藏 RPC。仅 Supabase HTTP 多次 insert 无法满足事务要求。** 本轮交付独立 SQL：

`supabase/student_wordbook_v1_phase_a2_20261008.sql`

在 A1 已通过的项目 SQL Editor 完整执行一次，末尾应返回 `WORDBOOK_A2_RPC_OK`。本轮不自动执行生产 SQL；没有更新/删除任何 canonical corpus、R2 对象或 A1 SQL，也没有添加触发器。

- 新函数 `operate_student_wordbook_v1(uuid,uuid,text,jsonb)` 为 `SECURITY INVOKER`，固定 `pg_catalog` search_path，所有 public 对象限定 schema。
- PUBLIC/anon/authenticated 无 EXECUTE，仅 service_role 调用；提交前检查有效 EXECUTE 权限。浏览器仍无五表写权限。
- 服务端重新生成 expected payload；RPC 在开始写入前按 PK/unique key 重读账户、occurrence、entry、block，精确比较身份与快照，拒绝 stale/disabled。
- 同用户/domain/完整 lexeme-key 的 save/remove 使用同一个 transaction advisory lock（包括 entry 尚不存在时），并锁 entry。UNIQUE + ON CONFLICT 去重；不按 lemma 或显示词形合并，不批准 reviewed_equivalent。
- entry、canonical link、sense、example、M:N edge 均在一次 RPC 事务中写入。冲突时逐项比较完整身份/快照，hash 碰撞明确失败。来源 union 使用数据库 target 数组，不会由旧客户端数组覆盖。
- 删除当前 domain 的 entry，级联删除四类子记录；不存在也是成功。再次收藏新 ID/首次时间。失败无半成品，不覆盖存续快照/首次时间。
- PostgreSQL 常规 READ COMMITTED 语义；DO NOTHING 后用独立 statement 读取冲突 winner。

## 真实语境提取

`lib/lexical/wordbookContext.ts` + `wordbook.server.ts`：

1. 重新授权原文、校验 hash、完整 occurrence 的 UTF-16 span/surface、context_text、匹配 identity 与展示字段。
2. RAP paragraph 优先读取限定 passage/paragraph 的 sentence table，按顺序 `join(" ")` 必须精确等于 canonical block；唯一覆盖整个 occurrence，非空 sentence_id 必须一致。
3. 其他 source 使用确定性 `Intl.Segmenter("en", sentence)` 候选；已知缩写/人名 initials/小数保护不改变 offsets。句子识别保守，只保留 exact slice；不确定 acronym 末尾、未知缩写边界、多行、ellipsis 不冒充单句。
4. title/subject 保持 fragment；短自然字段或明确 paragraph boundary 可以保存完整真实 fragment。fragment 上限 600 UTF-16 units 是**拒绝门槛**，不是截取窗口；不截断任何原文。
5. 跨句 occurrence、RAP map 不一致、stale span、长 block 无可靠句界均明确失败（422/409），不调用写 RPC。没有 AI 改写/补写/生成，没有将整大段作为例句。
6. 提取器偏向安全拒绝：没有持久化句界的复杂标点/句型可能保存短 fragment 或拒绝，不能宣称通用语法分析/百分之百句界覆盖。

## 查词卡

- 标题行词条后紧接浅蓝边框按钮 `加入生词本`（自然 flex 横排、gap-2，水平位置随词条长度变化，不靠卡片右端对齐）；前置 Plus 图标显式使用 `text-student-primary` 主题蓝色，非黑色 emoji。已收藏为 `✓ 已加入 · 取消收藏`，直接切换当前 domain。
- pending disabled + 同步 ref 防重复点击；只有请求确认后更改状态；失败轻量 role=status，未知提交结果重新查询状态，不乐观显示成功。
- 查词编辑/重新选择/关闭递增 revision，旧 mutation 响应不会污染新卡片；lookup fetch 的既有 abort 行为保留。
- 关闭按钮参考 `components/teacher/SubjectBadges.tsx`：白底、圆形边框、X 图标，绝对定位 `-right-2 -top-3` 叠放。外壳 overflow-visible，滚动区独立且等宽 p-4；viewport 顶部预留叠放空间。保留 Escape/点击外部关闭，支持键盘、focus/hover/active。

## 定向验证与限制

本地测试不加载生产 env，仅复用 A1 的明确离线 dependency fixture，执行真实 A1 + 新 A2 RPC SQL（PGlite）。生产 Schema 基于用户已确认的 A1 状态，不把离线 fixture 当作生产 dump。

```sh
WORDBOOK_SQL_TEST_PGLITE='<approved-temp>/tps-wordbook-sql-runtime/node_modules/@electric-sql/pglite' \
  node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  tests/studentWordbookA2.test.js tests/lexicalLookup.test.js \
  tests/lexicalLookupUi.test.js tests/lexicalSelection.test.js
pnpm exec tsc --noEmit --incremental false
git diff --check
```

覆盖首次/重复收藏、sense/example/来源追加、M:N、多用户/domain、取消/重收、full identity_variant、不可信客户端内容、匿名/权限/active/disabled/stale 拒绝、语境失败零写入、末步骤失败全层回滚、真实 RPC 权限与 hash 碰撞，以及真实 provider loading/重复点击/取消/失败/旧响应关闭回归。

最终 A2 + lookup/UI/selection 定向测试 **50/50 通过，0 skipped**；另运行既有 A1 SQL 测试 **20/20 通过，0 skipped**。TypeScript noEmit 和 diff 格式检查通过。离线 hash-collision fixture 初次因 CREATE OR REPLACE 的参数名不一致失败，修正测试 fixture 后 A2 全部重跑通过；生产函数/Schema 未为测试放宽。

并发验证为多个请求排队调用同一个本地 PGlite 连接 + 实际 RPC 幂等去重；**不冒充真实多连接锁竞争实测**。锁协议及 UNIQUE/原子 union 已实现，可在有隔离 PostgreSQL 环境时补多连接压力验证。

浏览器：先按 AGENTS.md 在主目录正常 `pnpm dev` 并等待 Ready；为避免读取/覆盖另一 session 的源码，再启动当前 worktree 正常 `pnpm dev`（Next 自动选 3001）。当前 worktree 没有独立 env/账号文件，进程只读取既有主目录 env；账号仅用于正常 localhost 登录 UI，始终同一 `http://localhost:3001` origin。

- 从测试账户已有历史记录进入真实 RAP 结果页，选择 `technological`，原 lookup matched、Reading 未收藏状态、语境释义/所在短语正常。
- 实测标题右侧操作、等宽 padding、圆形 X 上方叠放，保存页面截图；真实收藏返回 `503 / WORDBOOK_UNAVAILABLE`（A2 RPC 未部署），失败提示可见且没有伪装成功。
- 根据补充要求，按钮紧跟词条而不是右对齐；`technological` 与 `technological innovation` 的词条→按钮间距均为 **8px**，长词条让按钮自然右移。Plus 的 computed color 为 **rgb(52, 127, 220)**，与查词卡主题蓝一致。
- 使用明确的 browser-only response fixture 验证加入成功、loading、取消、键盘 Enter 关闭；这不是生产收藏成功证明。真实写入由上述本地 server→RPC SQL 测试覆盖。
- 上线成功收藏/取消的真实页面闭环，须在操作人执行 A2 SQL 后再次验收。未执行全仓浏览器/测试、corpus pipeline、commit/push/deploy。

Phase A2 到此停止；不进入 A3/Admin/mastery/SRS/enrichment pipeline。

## 2026-10-08 真实生产链路验收（RPC 安装后）

用户已在生产 SQL Editor 完整执行 A2 SQL，确认 `WORDBOOK_A2_RPC_OK`。下列结果取代上文“RPC 尚未部署 / 成功 UI 使用 fixture”的待验收状态；上文保留为首次实施的历史记录。

### 会话与边界

- 复用此前已 Ready 的主目录 dev server 和当前 worktree `http://localhost:3001`，未重新配置环境。
- 使用维护 worktree `.codex/tps-test-accounts.local` 中匹配 `jiangzhuocheng2` 的学生凭证，仅通过正常 localhost 登录 UI；凭证文件未修改，未提取/打印/保存 token、Cookie 或 service-role key。
- 从学生自己的练习历史进入现有 RAP/BAS 结果页；未创建账号、题目、作答或 corpus，未调用生产 SQL/MCP 数据库查询，未 mock/intercept API 响应。
- 曾尝试此前截图的 Reading URL，当前学生会话返回 404；随后仅通过该学生自己的历史结果入口选取可访问样本，不继续尝试其他学生的数据。

### Reading 首次、持久化、取消与跨语境

- 结果页：`/student/reading/results/7bda461e-496a-4d6e-80ab-8ba4fd1caa8b/questions/0`，Arts of the Japanese Rock Garden。
- `gardens` lookup 真实匹配 `garden`，canonical entry `ebb78eda-b1b5-55da-84e4-85c17eaaebd2`，首次 occurrence `68540058-d6c5-59e9-8b98-fba35033bebc`。
- 首次保存 HTTP 200、reading、entry `a6b4d0b6-f5d1-4554-ae74-2ad065d35009`；第二个正常标签页在保存前已打开未收藏状态，顺序重复点击保存仍返回同一 entry，不伪造 React state 或重放认证数据。
- 关闭/重开以及整页刷新后，真实 lookup 仍返回上述 saved entry；取消 HTTP 200，刷新后真实 lookup 返回 `saved:false`。
- 再收藏创建新 entry `297dbb44-123b-4de3-89e0-bb5b7dc9f747`。第二处原句的 occurrence `bf191a3f-bc4b-5f92-8790-e9afef14ac02` 返回相同 canonical entry；在未收藏时预先打开该语境的正常标签页，顺序收藏两处语境及重复第一处，三个 save 都返回同一新 entry。
- 两处义项同为 noun / 庭园，但英文定义分别为 `Landscaped spaces arranged with rocks.` 和 `Cultivated outdoor spaces.`，应保存两个精确义项快照及两个不同原句，不做语义合并。
- 用户在 SQL Editor 执行新增的**只读、单 entry 限定** `supabase/student_wordbook_v1_phase_a2_acceptance_readonly_20261008.sql`，明确确认 `WORDBOOK_A2_REAL_ACCEPTANCE_PASS`：1 entry、1 canonical link、2 senses、2 examples、2 M:N links，两组原始义项/原句/关联精确保留，来源均为 rap，旧取消 entry 已不存在。
- 该查询是清理前的真实数据 checkpoint，不是 migration，不应在清理后期待再次返回 PASS。

### Reading / Writing 真实隔离

- 通过已有 BAS 结果页 `/student/results/1f88431c-1e63-4af1-bbea-2cc319864d2e` 的正常题号切换展开题目，未创建新 attempt。
- 可核验的共同词为 `that`，RAP 与 BAS lookup 返回**同一个** canonical entry `1b368e21-e002-5202-8d1c-937bde83dc22`，不是按显示词/lemma 推测等价。
- reading 保存 HTTP 200，entry `b4a5ffe6-4041-4c55-ae7e-c70abd5937a3`；writing 保存 HTTP 200，entry `3944281b-b929-4236-a109-99d7524acb5b`。
- 取消 reading 后，刷新 BAS 结果并重新 lookup，writing 仍 saved 且保持原 writing entry；随后取消 writing，两边再次 lookup 均未收藏。四次写操作均为真实 HTTP 200。

### UI、定向测试与清理

- 真实短词 garden 和长短语 Japanese rock garden 的标题→按钮间距均为 8px；Plus computed color `rgb(52,127,220)`；左右 padding 均 16px，圆形 X 确实跨越卡片上边缘叠放；原 POS/中英义项及 containing phrase 展示正常。
- 真实 save/remove loading disabled 状态被观察到；整个验收的 lexical API 响应无 mock/fixture，浏览器 pageerror 为零，相关服务端 lexical 请求均 200。
- 本轮仅重跑权限/异常相关 **10 项定向测试（9 项权限/事务 + 1 项语境/stale span），10/10 通过**：匿名/非法证明、owned-page/active Reading/Full Set、disabled/stale、语境失败零写入、重复请求去重、末步骤失败五层与 source union 回滚。这些异常/回滚仍是**本地 doubles/PGlite 验证**，未拿真实学生对其他学生数据做越权攻击，也未故意破坏生产 corpus。
- garden 验收样本清理 HTTP 200，整页刷新后 lookup `saved:false`；that 的 Reading/Writing 样本也全部通过正常 UI 取消并确认未收藏。未删除任何初始已有收藏。
- 无需业务代码或生产 Schema 修复。本轮仅新增只读验收 SQL、补充本说明；没有 commit/push/deploy，也未进入 A3。

**Phase A2 可部署：YES。** 真实首次收藏、持久化、取消、重复/跨语境数据库 checkpoint、Reading/Writing 隔离均有明确证据；无需新增修复 SQL。异常回滚的证据范围仍限定为本地定向测试，不冒充生产故障注入实测。
