# TPS 生词本 V1 — Phase A3 交付

> 更新：用户已手动安装 A3，2026-10-08 已完成核心真实 UI → 生产 RPC/API 闭环验收，测试数据已清理。详见 [真实生产链路验收](student-wordbook-v1-phase-a3-production-acceptance.md)。下文「尚未安装 / 等待执行」保留为初次实施交付的历史状态，不代表当前生产安装状态。

## 状态与边界

代码、独立增量 SQL、本地 SQL/API 定向测试及目标页面验证已完成。
**A3 未自动安装到生产；真实收藏活动和日期筛选仍待操作人安装 SQL 后验收。**

- 工作目录仍为 `tps-lexical-wordbook-admin`，分支 `feature/lexical-wordbook-admin`。
- 开始时 `git status --short` 为空；本轮没有覆盖其他未提交工作。
- 未 commit / push / deploy，未调用生产 SQL 工具，未进行生产数据写入。
- 未触碰 enrichment continuation artifacts、lexical corpus pipeline、Reading 原始素材、题目去重或导入逻辑。
- 不实现 Admin 编辑、Mastery、SRS 或跨 identity 自动归并。

## 实际文件

### 页面、导航和共享日期

- `app/student/wordbook/page.tsx`（新增）
- `components/student/StudentWordbook.tsx`（新增）
- `components/student/StudentWordbook.module.css`（新增）
- `components/student/StudentDateSelection.tsx`（新增：提取已有日期表单，可选活动月视图）
- `components/student/StudentPracticeHistory.tsx`（使用提取后的共享表单/日期函数）
- `components/student/StudentShell.tsx`（仅增加 Sidebar 生词本入口）
- `lib/studentNavigation.ts`（增加 route 常量）
- `lib/studentUiText.ts`（增加生词本文案）
- `lib/studentDates.ts`（新增：提取练习历史本地日期/时区函数）

### API / 数据合同

- `app/api/student/wordbook/route.ts`（新增）
- `app/api/student/wordbook/activity-dates/route.ts`（新增）
- `lib/lexical/wordbookList.ts`（新增：查询校验、日期边界、响应类型、语境关联）
- `lib/lexical/wordbookList.server.ts`（新增：可信学生 ID 下的只读 RPC）

### SQL、测试和说明

- `supabase/student_wordbook_v1_phase_a3_preflight_20261008.sql`（新增）
- `supabase/student_wordbook_v1_phase_a3_20261008.sql`（新增）
- `supabase/student_wordbook_v1_phase_a3_verify_20261008.sql`（新增）
- `tests/studentWordbookA3.test.js`（新增）
- `tests/studentWordbookA3.browser.cjs`（新增：可选目标页浏览器检查）
- `tests/studentWordbookA2.test.js`（仅增加可选 A3 compatibility 安装开关）
- `tests/studentPracticeHistory.test.js`（原日期表单静态断言指向提取后的共享组件，未移除原行为检查）
- 本文件。

## 页面和视觉

路由：`/student/wordbook`。Sidebar「学习」中，生词本在错题集正下方，使用 Lucide `BookMarked`，完全沿用现有 Sidebar 的 active/hover/移动导航行为。

标题和容器使用 `StudentPage`，Breadcrumb 使用 `StudentNavigation`：学习 / 生词本。
Reading / Writing 各自的日期、排序和页码独立保留。仅请求当前 domain 当前页和当前月，切月不重新加载词汇。

| Domain | 五列（固定顺序） | 来源 |
| --- | --- | --- |
| Reading | 单词 / 词性 / 语境义 / 例句 / 派生 | CTW / RDL / RAP |
| Writing | 单词 / 词性 / 语境义 / 例句 / 常见搭配 | BAS / WE / AD |

使用原生表格、浅灰表头和极浅横线，无竖向网格或横向滚动；窄屏将同一 `tbody` 内的字段重排，不产生独立单词卡片。
单词按整个语境组 `rowSpan` 纵向居中；义项与例句通过真实 M:N 关联展开，不将两组数组按下标配对。
相同例句可对应多个义项，展示时重复其说明位置但不创建重复数据库记录。
长例句根据实际渲染高度检测，默认两行；每个展示位置独立展开/收起，原文不修改。

Badge 复用既有题型所属主题：Reading 使用 `WrongQuestionsHome` / 练习历史现有蓝色 chip；BAS/WE/AD 使用现有 Writing `student-primary` tokens。没有引入新题型颜色或全部统一成蓝色。

## 复用日期组件

定向审计发现练习历史使用 `TeacherPopover` + 两个原生 `type="date"` 输入，并无可绘制圆点的自定义月历。

- 将原表单直接提取为 `StudentDateSelection`，保留弹层外点/Escape 关闭、单日/范围提交、结束日期可空、倒序起止自动规范化等行为。
- `studentDates.ts` 提取原来的本地零点、`setDate` 次日边界、`YYYY-MM-DD`、浏览器 IANA timezone；严格拒绝不存在的日期。
- 练习历史未启用活动月视图，原来的今天/上一天/下一天、URL/Back 状态、日期加载范围不变。
- 生词本启用可选月视图、月份切换、小圆点和清除功能；范围仍通过同一组原生输入选择。
- 小圆点仅请求当前学生、domain、timezone 和月份的 DISTINCT 日期集合，不取整月词汇或语境。

## 活动模型与 A2 兼容升级

本地 A1/A2 审计依据：三张主体/子表有不可变 `first_saved_at`；canonical link 有 `first_linked_at`；M:N 关联没有时间；例句来源数组只保存当前集合。A2 原 RPC 没有活动记录。
**因此现有字段不能恢复所有历史来源追加或关联追加日期。** 真实生产函数正文/签名/ACL/依赖由只读 Preflight 读取并强制比对，尚未替用户执行。

新增最小表 `student_wordbook_activities`：

- `activity_id`、`wordbook_entry_id`、`student_id`、`domain`、`event_type`、`activity_at`。
- event 为 `first_save` / `append` / `historical_created`，一次有效保存可以只产生一个 event。
- composite owner/domain FK 指向原 entry，取消收藏 cascade 删除活动。
- 索引覆盖 owner/domain/time 日期查询，以及 owner/domain/entry/latest 活动查询。
- UPDATE guard 防止修改历史；RLS 开启，浏览器无读写或 RPC 执行权限；service-role 只获 SELECT/INSERT/DELETE，不获 UPDATE/TRUNCATE。

原 `operate_student_wordbook_v1(uuid,uuid,text,jsonb)` 参数、返回 JSON、SECURITY INVOKER、固定 search_path、授权校验、identity/hash 比较及 save/remove 协议保持不变。
在原 advisory transaction lock + entry row lock 内，通过实际 sense INSERT `ROW_COUNT`、锁定来源集合与 upsert 结果差异、M:N INSERT `ROW_COUNT` 判定有效变化；不由客户端猜测。
来源仍是数据库 target 数组的原子 union；完全重复请求不生成活动。
活动插入位于同一事务末尾，插入失败会回滚全部收藏内容；前面任一步失败也不会残留活动。

历史迁移仅读取 student-wordbook 的真实 entry/sense/example `first_saved_at`，对同 entry 同 timestamp 去重。
不利用 canonical `first_linked_at` 推测有效收藏内容，不编造来源/关联时间，不改变原快照或整个 corpus。
Preflight 和 Migration 都检查原时间字段及 snapshot guard；若发现漂移，停止而非自动修复。

## 读取 API 与动态 Enrichment

列表：`GET /api/student/wordbook`

- `domain=reading|writing`，`page`（默认 1），`pageSize`（默认 20，上限 50），`sort=newest|oldest`。
- 可选 `date=YYYY-MM-DD`，或 `start=YYYY-MM-DD&end=YYYY-MM-DD`；单日与范围不能混传。
- `timeZone` 使用浏览器 IANA 时区，默认 `Asia/Shanghai`。API 将起日零点和结束日的**次日零点**独立换算 UTC，数据库使用 `[start,end)`，覆盖 DST 23/25 小时日期。
- 不接收 student ID 或任意扩展参数；每次使用现有鉴权返回的可信 `auth.userId`。
- 返回 entry/full identity、首次时间、全局最近活动时间、筛选范围内排序时间、来源集合、全部已保存 sense/example 及真实关系、最新 Enrichment 来源和合并项、total/page/pageSize。

活动日期：`GET /api/student/wordbook/activity-dates?domain=reading&month=2026-10&timeZone=Asia%2FShanghai`。
返回轻量日期数组；月边界在数据库按同一 IANA timezone 计算。

列表 SQL 先按活动过滤及 group by entry，按范围内 `max(activity_at)` 排序，再按唯一 entry UUID 升序作次级键并分页。
上下文/enrichment join 只处理该页。日期只决定 entry 是否进入结果，**不裁剪任何 sense/example**。
读取在一个 SQL statement snapshot 中完成，无逐词请求或浏览器 canonical 查询。

Enrichment 按 A1 冻结规则读取全部 canonical links：

- canonical UUID 排序，保留各来源及状态；disabled 不删除收藏。
- 比较完整 canonical identity 与 link 快照；drift 标记并返回 NULL，不把错误 identity 的数组套到收藏上。
- 按完整 JSONB payload 去重、保留所有贡献 UUID；按 field / JSONB 文本 `COLLATE "C"` 排序。
- 按 A1 的 conflict key 保留并标记冲突，不任选 canonical winner。
- Reading UI 使用 `derived_words`，Writing UI 使用 `useful_patterns`；空数组展示 `—`。
- `common_senses` 保留在后端合同中，本轮无 UI。
- API `force-dynamic` + `Cache-Control: no-store`，前端 fetch `no-store`，不使用长期 Enrichment cache。切 domain 或筛选后的下一次读取取得当前内容。

## 定向验证结果

实际执行（无生产 SQL）：

1. `tests/studentWordbookA3.test.js`：**11/11，0 skipped**。含实际 PGlite SQL：首次/义项/例句/来源/关系追加、重复不产生活动、读/Enrichment 更新不产生活动、晚期失败整体回滚、权限/append-only、历史真实时间保全、domain/user/取消重收隔离、单日/范围去重与完整语境、时区/月边界/DST、范围内最近时间、稳定 UUID 分页、多 canonical 去重/冲突/来源/disabled/identity drift/即时更新、只读 Preflight/Verify 及漂移拒绝。GET handler 定向用例执行真实 handler 逻辑并隔离鉴权/数据库依赖。
2. 原 A2 用例在升级后的 A3 RPC 下：**15/15，0 skipped**；未发现 lookup 收藏/取消合同回归，保留原 hash collision、身份隔离、失败回滚场景。
3. `tests/studentPracticeHistory.test.js`：**13/13**；提取共享日期组件后的原历史页合同仍通过。
4. `pnpm exec tsc --noEmit --incremental false`、修改相关文件的定向 Next lint、`git diff --check` 通过。
5. 真实 localhost 正常登录后，两条 A3 读取 API 在尚未安装 RPC 时 **503/no-store**；匿名读取 **401**。这是依赖尚未安装的明确状态，不伪装为生产空词表。
6. 目标浏览器检查随后仅拦截 wordbook GET，以交付 SQL 在本地 PGlite 执行的结果验证 UI，**不是生产日期筛选验收**。覆盖 Sidebar/Breadcrumb/两表、题型主题、多语境关系、纵向居中、长句原文及独立展开/收起、月份及 domain 圆点、单日/范围/清除/排序、20+1 的真实 SQL 分页、空状态、原历史表单的单日/范围 URL 行为。无 page error。
7. 1440 / 1024 / 768 / 390 / 320px：document scrollWidth 均等于 viewport，表格无横向滚动，320px 日期弹层不溢出。桌面及移动截图已人工查看。

### 测试限制

- PGlite dependency fixture 是离线模型，不是生产 schema dump。
- PGlite 为单连接；原 A2 queued concurrent 调用在 A3 下通过，但**不是原生 PostgreSQL 多连接 advisory/row lock 并发证明**。本轮没有可用本地 postgres server binary，未声称真实多连接竞态验收通过。RPC 仍沿用 A2 已验收锁协议和 target-side union。
- 未重新进行生产 save/remove 写入，也未跑全站审计、全仓测试或 deploy。
- 原练习历史测试里的两条离线 catalog 缺少标题诊断来自已有 fixture，不影响其 13 项通过结果。

### 复跑

本地 SQL runtime 通过 `WORDBOOK_SQL_TEST_PGLITE` 指向已安装的外部 PGlite 目录，不连接 Supabase：

```bash
WORDBOOK_SQL_TEST_PGLITE='<local-runtime>/node_modules/@electric-sql/pglite' \
  node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test tests/studentWordbookA3.test.js tests/studentPracticeHistory.test.js

WORDBOOK_SQL_TEST_A3=1 WORDBOOK_SQL_TEST_PGLITE='<local-runtime>/node_modules/@electric-sql/pglite' \
  node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test tests/studentWordbookA2.test.js
```

浏览器脚本需先正常启动开发服务并看到 Ready，再显式提供当前 localhost origin、现有 `.codex/tps-test-accounts.local` 路径、外部 Playwright/PGlite runtime 和输出目录。
本次先依 AGENTS 启动主工作目录 `pnpm dev`（3000），再用进程内继承既有环境启动本 worktree 的正常 `pnpm dev`，Next 自动选择 3001；整个认证验证仅用 `http://localhost:3001`。没有复制凭据/环境文件或指定 hostname/port。
浏览器脚本不保存 token/password/login 截图；`realApi` 仅记录拦截前的真实响应，后续测试查询单独记为 `fixtureRequests`。

本次浏览器证据（外部临时目录，不是运行时依赖）：`wordbook-a3-ui/report.json`、`reading-desktop.png`、`writing-desktop.png`、`reading-mobile.png`。

## 用户手动执行顺序和成功标记

**每个文件完整粘贴 Supabase SQL Editor；任何错误时停止，不自动修改 corpus/权限，不重跑 A1/A2。**

| 顺序 | 文件 | 必须看到 |
| --- | --- | --- |
| 1 | `supabase/student_wordbook_v1_phase_a3_preflight_20261008.sql` | `WORDBOOK_A3_PREFLIGHT_OK` |
| 2 | `supabase/student_wordbook_v1_phase_a3_20261008.sql` | `WORDBOOK_A3_MIGRATION_OK` |
| 3 | `supabase/student_wordbook_v1_phase_a3_verify_20261008.sql` | `WORDBOOK_A3_VERIFY_OK` |

Preflight 为只读元数据核验，强制检查真实 A2 签名、参数名、正文指纹、invoker/search_path、有效权限、时间字段/guard，另列 owner/ACL/依赖/trigger 供审阅。
Migration 再做关键断言，锁住 student-wordbook 表防止旧 RPC 与历史重建穿插；单事务、10 秒 lock timeout、60 秒 statement timeout。若函数有实际漂移会拒绝替换，防止同名重载或覆盖未知升级。一次性文件，成功后不要重复执行。
Verify 为只读断言，核验活动表字段/PK/check/FK/index/RLS/guard、函数正文及有效权限、首藏历史覆盖；它不能证明生产的多用户交互或并发。

### 安装后的真实验收

1. 刷新 `/student/wordbook`，确认两 API 从依赖 503 转为正常响应。
2. 使用现有合法原题查词卡，验证首次收藏、新义项、新例句、同句新题型来源产生活动；纯重复不新增。
3. 验证 Reading/Writing 隔离、日期圆点、单日/跨日范围找到同一主 entry 且展示全部当前语境。
4. 验证全局/范围内最近活动排序、分页、取消后圆点消失及重新收藏新记录。
5. 验证最新 Enrichment 下一次读取可见，自动 Enrichment 更新不增加活动；lookup 原收藏/取消仍正常。
6. 需要真实多连接并发证明时，另行在受控本地 PostgreSQL 环境或人工批准的验收流程覆盖并发 save/source append/remove；本轮不自动操作生产。

**停止点：等待用户人工执行 A3 SQL 和真实页面验收，不继续 Admin/Mastery/SRS。**
