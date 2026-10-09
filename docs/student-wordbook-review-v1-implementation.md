# TPS 生词本复习 V1

V1是复习产品版本；`fixed_pool_v2`是最终493条固定池及偏好算法，不是第二套复习系统。

## 功能与入口

- 生词本Reading/Writing的「开始复习」进入 `/student/wordbook/review`；支持来源多选、单日/日期范围、随机10/20/50或自定义数量。
- Reading：CTW/RDL/RAP；Writing：BAS/WE/AD。CTW/WE/AD考英文拼写＋固定POS7；RDL/RAP/BAS考英文提示下的中文语境义四选一。
- 同词条一轮只出一次；按所选来源交集优先拼写＋词性，证据不可靠时不能降级题型。日期按真实收藏活动及浏览器时区筛选，边界从2026-07-01到当地今天；同日优先未抽词，用尽后按最少抽取次数轮换，跨来源组合共享计数。
- 服务端保存进度、整轮题目、答案和成绩；支持暂停/刷新恢复、结果、错词、分页历史及错词再练。再练生成新轮，不修改原轮。
- `LexicalLookup.tsx`的「保存当前语境」追加已收藏词的真实源义证据；重复保存幂等，原取消收藏保留，Teacher仍只读。共享日期组件仅复习单日模式启用`singleDay`，默认行为不变。

代码：`components/student/WordbookReview.tsx`、`app/student/wordbook/review/`、`app/api/student/wordbook/review/`；参数与错误契约位于 `lib/lexical/wordbookReview.ts` / `wordbookReview.server.ts`。

## 不可破坏的架构规则

1. `student_wordbook_source_evidence`必须准确关联sense/source/occurrence；不能用entry级来源数组、例句徽标或未收藏旧语境猜目标义。
2. 干扰项先取当前学生同科目保存的同POS义，不足3项才用approved493小表。**运行时不查询occurrence作为全局干扰池，不调用AI**；正确答案来自保存的源义，固定池不覆盖它。
3. 每层排序为本次candidate调用未使用 → 类别/同或显式相关学科/名词类型软偏好 → 使用次数 → 目标相关MD5稳定顺序；供应少时允许有限复用。计数不是跨轮持久多样性，本地优先不因固定池语义更强而改变。
4. 标签需canonical关联＋POS＋规范化精确义匹配；未知/歧义保持中性，不能按拼写或篇章猜标签。过滤重复、目标其他保存义/身份变体、ASCII字母及包含/近义冲突，包括「限制／抑制／约束／制约」。
5. CREATE保存整轮option ID、顺序、正确项及反馈源义。READ/SUBMIT/历史/再练不重算candidate、不再读池；未作答不公开正确答案，后续题未解锁不能预读或提交。
6. API先认证再使用service client；严格允许列表拒绝客户owner/评分/正确答案。RPC固定search_path、security-invoker；私有表RLS、浏览器角色不可直读写或调用，service_role对固定池只读。事务锁、幂等及immutable guard保护旧轮。57014返回503/REVIEW_TIMEOUT，不提高超时、不自动重试或泄露SQL。

## 最终数据与维护

仅保留 `data/wordbook-review/` 的3个文件：

| 文件 | 用途 |
| --- | --- |
| `fixed-pool-v2.full-review.json` | 唯一冻结493词—义及canonical来源输入；含原90条和原样123条 |
| `fixed-pool-v2.preference-tags.json` | 精确关联的类别、学科、名词类型；只影响软排序 |
| `fixed-pool-v2.install-manifest.json` | 当前输入/组件/输出SHA256及字节数、revision、POS数量与依赖顺序；不是审批或安装状态档案 |

revision=`fixed-v2-approved-493-20261009`；n150/v120/adj100/adv60/prep27/conj16/pron20。实词370＝通用学术207＋学科专业163；名词abstract113/concrete29/other8。冻结JSON SHA256：

`b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352`

JSON内原审核字段仅是不可变来源元数据，不是当前安装开关；生成器由明确固定revision/哈希锁定最终493，不依赖旧492、审批记录或CSV。维护时不能为消除历史状态重写冻结词义/来源，不能更新hash来掩盖漂移。

离线生成器：`scripts/build-wordbook-choice-preference-tags.cjs`生成标签JSON/SQL；`scripts/build-wordbook-approved-pool-install.cjs`生成APPROVED seed、总事务、最终verify与校验manifest。均不加载env或连接数据库。需要重新生成时在隔离副本运行，先比较字节；不要把生成操作当成部署或自动刷新池。

## 数据库依赖与安装边界

用户已报告手动生产安装后verify OK；此说明不是重装指令。**已安装环境不要重跑初始化、历史补丁或seed。** 不为提交清理删除线上索引、清池、重写函数或改旧轮。

保留SQL统一位于`supabase/`，以下后缀均以 `student_wordbook_review_v1_` 为前缀。依赖顺序没有重设计：

| 阶段 | 必需文件后缀（顺序） |
| --- | --- |
| 基础复习schema/证据/会话/评分 | `preflight.sql` → `migration.sql` → `verify.sql` |
| POS7 | `pos7_migration.sql` → `pos7_verify.sql` |
| occurrence历史前置 | `occurrence_choice_index.sql` → `occurrence_choice_migration.sql` → `occurrence_choice_verify.sql` |
| local-POS历史前置 | `local_pos_choice_index.sql` → `local_pos_choice_migration.sql` → `local_pos_choice_verify.sql` |
| ASCII前置 | `ascii_distractor_migration.sql` → `ascii_distractor_verify.sql` |
| 最终493原子安装 | `fixed_pool_v2_install.sql` → `fixed_pool_v2_production_verify.sql` |

前置生词本A1/A2/A3、bugfix、batch-delete的已跟踪 `student_wordbook_v1_*20261008.sql` 仍需存在。初始化绑定历史明确批准的81个测试收藏及账户/数量/FK/定义保护，**不是通用空库安装器，不能在新库或不同账户上绕过保护套用**。隔离fixture重建依赖仅用于测试，不代表可自动清理生产收藏。

历史增量函数虽后来被覆盖，仍是下一阶段指纹/定义替换的必要依赖；保留而不改写成新的baseline。阶段verify既供安装检查，也供漂移/ACL回归或总包生成；不可只因当前线上已装就删除。

两份`*_index.sql`为独立`CREATE INDEX CONCURRENTLY`，不能放入BEGIN/COMMIT；如有同名或无效残留，先检查定义/有效性，不强制覆盖。PGlite采用同定义的普通索引，不代表并发构建已验证。

对于尚未安装且ASCII/local-POS基线审计正确、固定池表不存在的受控目标，由owner完整执行总事务；总包内已嵌入空池/基线/ACL预检，不再需要独立V2 Preflight。其stage 1注释保留历史文件名仅作标识，不会加载已移除文件。POS7和occurrence独立预检也已移除，对应定义/契约/ACL检查仍在迁移内；occurrence索引重名由独立DDL拒绝。

总包组件仍保留供生成及隔离测试：

`fixed_pool_migration.sql` → `fixed_pool_verify.sql` → `fixed_pool_v2_seed_APPROVED.sql` → `choice_preference_migration.sql` → `choice_preference_tags.sql` → `fixed_pool_v2_production_verify.sql`。

`choice_preference_verify.sql`为最终verify的生成输入。执行总包后**不要再执行组件**。独立seed仅对已核实未改变的空固定池schema适用；非空、半安装或未知漂移状态停止检查，不自动修复。

总事务repeatable-read、lock_timeout5秒；seed只共享锁493关联entry/occurrence并精确验证词义/定义/POS/source及generated状态。只接受空池，不DELETE/TRUNCATE/UPSERT，不改词典、学生收藏或成绩。失败整体回滚；必要时ROLLBACK后检查实际错误，不能跳过保护。安装校验的一次性canonical读取不是runtime干扰池查询。

成功标记：`WORDBOOK_FIXED_POOL_V2_ATOMIC_INSTALL_OK`和`WORDBOOK_FIXED_POOL_V2_PRODUCTION_VERIFY_OK`。最终verify只读检查算法/精确493来源快照/标签/ACL/RLS，不需要重新导入CSV或Reading源文件。

## 测试与已知边界

Node.js22.18+或24，`pnpm install --frozen-lockfile`后运行 `pnpm test:wordbook-review`。锁定PGlite0.5.8，离线合成fixture＋冻结493来源快照，不读取env/凭据或访问生产。覆盖迁移/回滚/ACL、6来源/轮换、收藏兼容、整轮快照/判分、固定池/偏好、来源漂移、生成器字节级复现，并回归共享日期/历史/Teacher只读。

`tests/studentWordbookReview.concurrent.cjs`另做原生多连接检查，需显式提供含embedded-postgres/pg的`TPS_REVIEW_NATIVE_RUNTIME`及全新绝对目录`TPS_REVIEW_NATIVE_DIR`；串行PGlite不能替代真实锁竞争。

真实6题RAP验收已验证源义判分、故意答错反馈、刷新/恢复和历史一致；这不是全493/全题型教学质量验收。rigorous及argue—主张缺精确标签，配对偏弱；本地优先/软排序不保证考试难度，Writing/BAS/CTW、跨账号或移动端未在线全覆盖。未来提升质量须单独授权，不重抽或修改既有验收轮掩盖问题。
