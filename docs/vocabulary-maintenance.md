# CTW 词测 + Lexical 双增量运行规范

> 本文是供**获授权的维护批次**重复使用的运行规范。工具开发阶段的验收仅使用隔离数据；实际批次须单独授权其读取／制作／写入范围。工具不自动调用模型，也不自动认可语义／CEFR；只读准备授权不包含 production write。

## 1. 环境、工作目录与首次基准

仓库根目录运行，需要 Node.js（支持 strip-types）、pnpm；获授权的数据库操作另需 `psql`。
通过受保护的环境注入 `NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_DB_URL`，以及项目原有 R2 resolver 配置。
**统一入口与 CTW CLI 不自动加载 `.env.local`**；原有 `pnpm lexical:incremental` 保留其 env-file 行为。不要把密钥写进配置、命令参数、报告或 tracked 文件。

两分支范围不同：CTW 只处理新 canonical 的正确答案；Lexical 按当前 corpus 与 canonical 做全来源 block diff。不要用 Lexical 的 delta 充当 CTW 的同步基准。

CTW 首次使用需要一份**经核对、此前确实已同步的 canonical 历史 inventory**。格式是 `CtwSnapshot`，但 `canonical` 仅含已处理的历史项目；不得直接把全部当前题库标记为历史完成，也不得拿初始化词表推断已处理 canonical。仓库没有可自动证明这一历史覆盖面的 checkpoint，因此需要维护者一次性提供已确认 inventory。不要重跑初始化／历史全量生成。

```sh
pnpm ctw-vocabulary:incremental bootstrap \
  --snapshot tmp/vocabulary-maintenance/inputs/reviewed-history.json \
  --output tmp/vocabulary-maintenance/ctw-checkpoint.json \
  --ack-reviewed-history
```

bootstrap 离线、只生成文件，不能替代历史覆盖面审核。真正空历史的隔离测试可以显式提供 `{"version":"ctw-incremental-checkpoint-v1","sources":{}}`；不要将其用于已运行的生产词测。

如果维护者明确确认“此前全部 CTW canonical 已处理，仅指定 NEW ID 尚未处理”，可以不重建历史 inventory，改用本批范围输入：
`{"version":"ctw-incremental-checkpoint-v1","sources":{},"new_canonical_scope":{"ids":["已核对的 NEW canonical ID"],"authority":"维护者确认及日期／范围依据"}}`。
仅该列表进入答案提取，其他项目不重做词测；此输入不是历史成功 checkpoint 的伪造替代物。其后只有真实 import 和 post-verify 成功才生成正常的下一成功 checkpoint。
没有显式历史完成确认时禁止使用这个范围入口绕过历史核查。

每轮选择新的安全 run ID，按下方唯一配置模板准备本地文件，无需另外维护一份重复示例：

```json
{
  "version": "vocabulary-maintenance-config-v1",
  "run": "maintenance-YYYYMMDD-unique",
  "ctw": {
    "snapshot": "tmp/vocabulary-maintenance/inputs/ctw-current.json",
    "checkpoint": "tmp/vocabulary-maintenance/ctw-checkpoint.json",
    "review": "tmp/vocabulary-maintenance/inputs/ctw-review.json"
  },
  "lexical": { "run": "lexical-YYYYMMDD-unique" }
}
```

配置保存为 `tmp/vocabulary-maintenance/config.json`。开始后配置不可更改；重试沿用同一 run，下一周期另建 run 及独立 snapshot/review 文件。

## 2. 统一 plan（只读，但会读取真实数据，必须另行授权）

CTW capture 只读 CTW canonical 结构、词库和 memberships，不读学生记录，不读取其他 Reading 原始资产：

配置了 `SUPABASE_DB_URL` 时使用只读 repeatable-read SQL；未配置时使用原 service API 分页并要求连续两次完整采集一致。Verify 同样支持 API；写入仍必须提供数据库连接 URI。API 采集不是跨请求事务，最终 SQL import 仍会在锁内重复精确基准／canonical 校验。

```sh
pnpm ctw-vocabulary:incremental capture --read-live \
  --output tmp/vocabulary-maintenance/inputs/ctw-current.json
pnpm vocabulary:incremental plan --config tmp/vocabulary-maintenance/config.json --read-live
pnpm vocabulary:incremental report --config tmp/vocabulary-maintenance/config.json
```

产物：

- CTW：`tmp/vocabulary-maintenance/runs/<run>/ctw/plan.json`、`review-template.json`。
- Lexical：`tmp/lexical-incremental/runs/<lexical.run>/delta-plan.json`、`canonical-blocks.jsonl`、原有 full-row baseline。
- 统一报告：`tmp/vocabulary-maintenance/runs/<run>/report.json`。

`plan.json.candidates` 含原始正确答案、原语境、slot 身份、规范化答案和**非最终** base-form 候选。正文普通词不会进入 CTW 词测。重复答案保留语境审核证据，但不会生成重复 base form。
`changed` 历史 canonical 会阻止 CTW prepare，需另行批准的内容仲裁，不能静默刷新基准。`removed` 仅报告，绝不删除词条／历史记录。

## 3. prepare：两分支独立制作／审核

### CTW

复制 `review-template.json` 为配置中的 review 文件，填入 `reviewer`，为每个 candidate 填一个 decision（数组下标从 0 开始）：

```json
{
  "candidate_id": "plan 中原样复制的 ID",
  "base_form": "已确认的规范化原形",
  "action": "reuse",
  "sense_index": 0,
  "reason": "结合该答案在原句中的 POS、词形和义项作出的确认理由"
}
```

- `reuse`：指向现有 base 的 `sense_index`；原内容保持不变。
- `sense`：现有 base，仅提供 `sense: {pos, meaning_zh, example_en}`，不带 `sense_index`；重复已存在义项必须改为 reuse，不能借新增覆盖原例句。
- `new`：指向 `new_words` 中同名 base 的 `sense_index`。`new_words` 每个 base 仅一条，所有义项须有正确答案语境来源。

`new_words` 模板：

```json
{
  "word": "confirmed-base-form",
  "cefr": "B2",
  "senses": [{"pos":"noun","meaning_zh":"经审核的中文义项","example_en":"A reviewed contextual English example."}],
  "irregular_forms": [],
  "cefr_review": {
    "reference":"Oxford 3000/5000",
    "locator":"可追溯词典条目/POS/义项；未收录则记录检索结果与参照依据",
    "pos_sense_rationale":"结合实际 POS、义项及难度的复核理由，而非旧自动 A2 规则"
  },
  "forms_review":"审核全部变化；若无附加不规则题，明确说明规则变化依据"
}
```

`pos`／form types 沿用 `lib/ctw-vocabulary/model.ts`，`irregular_forms` 沿用 `{form_type, answers: [...]}`。be/get/far/burn/learn 等既定规则有额外 QA；一般新词仍需人工词形审核。多变体全必答，不得改成任选一个。
decision 的 `base_form` 用规范化去重键；`new_words.word` 保留审核后的正式拼写／必要大小写，数据库仍用既有 `lower(word)` 唯一键，不强制把专名展示形式小写。
有歧义的项目保留在待确认清单；缺任何 decision／证据／CEFR 或 forms 审核都会阻止 prepare，不会猜出最终条目。

### Lexical

统一 prepare 调用原来的 `stage-annotation → verify-checkpoints → stage-mwe → verify-checkpoints → stage-mwe-qa → verify-checkpoints → finalize → import`（最后一步为原 dry-run）。遇未完成语义批次停止**该分支**，已接受输出不重建。

```sh
pnpm vocabulary:incremental prepare --config tmp/vocabulary-maintenance/config.json --read-live
# Lexical 等待语义产物时，按原协议领取、制作、接受；三阶段分别完成：
LEXICAL_INCREMENTAL_RUN=lexical-YYYYMMDD-unique pnpm lexical:incremental next --stage annotation --owner WORKER
LEXICAL_INCREMENTAL_RUN=lexical-YYYYMMDD-unique pnpm lexical:incremental accept --stage annotation --owner WORKER BATCH_ID
# 对 mwe、mwe-qa 重复 next/accept；重试统一 prepare 会创建下一阶段。
LEXICAL_INCREMENTAL_RUN=lexical-YYYYMMDD-unique pnpm lexical:incremental status
pnpm vocabulary:incremental prepare --config tmp/vocabulary-maintenance/config.json --branch lexical --read-live
```

人工审核内容、输出格式和冲突解决继续按 [lexical-incremental-sync.md](lexical-incremental-sync.md)，不另建语义协议。Enrichment 仍沿用 V1 空数组，不启动 V2。

CTW 完成时产生 `publication.json`、`append-preview.json`、`delta-import.sql`，分别列出复用、新义项、新词、mixed 和 CEFR membership 位置；旧词不重排、不重新评级。

## 4. verify / import / post-verify / report

以下命令**只有后续获授权批次才运行**：

```sh
pnpm vocabulary:incremental verify --config tmp/vocabulary-maintenance/config.json --read-live
# verify 是两分支原有/新增导入前只读校验；确认各计划、待确认清零、追加预览后才授权写入：
pnpm vocabulary:incremental import --config tmp/vocabulary-maintenance/config.json --write
pnpm vocabulary:incremental post-verify --config tmp/vocabulary-maintenance/config.json --read-live
pnpm vocabulary:incremental report --config tmp/vocabulary-maintenance/config.json
```

统一 import 不带 `--write` 会拒绝，不会误认为完成。两个独立事务，不合并两套库的事务。
CTW 导入锁定词库／membership 和 canonical 结构，核对精确 pre-state，只追加 senses／新 base，CEFR 仍由 Phase 3 trigger 分配；事务内核对完整 post-state。没有新永久表、RLS／授权修改或定时任务。

只有**各自 post-verify 成功**后，才更新：

- CTW 配置指定 checkpoint（CAS 比较计划前基准／已应用后基准，拒绝覆盖其他任务推进）。
- `ctw-last-success.json` 与 `lexical-last-success.json` 两个独立成功指针。
- 对应报告 `branches.<branch>.completed = true`。

Lexical 自己的 baseline、canonical snapshot 和 stage checkpoint 仍在其 run 下，成功指针只用于报告，不替换／重置原 baseline。下一轮仍由既有 CLI 对当时 corpus 做 diff。

确认整个任务完成：两分支 `completed=true`，各阶段成功，最新 post-verify 含 `verified=true`、artifact hashes，CTW 义项／新词／List 追加数量和 Lexical delta 数量分别核对，不互相混用。对真实内容的语义质量仍由审核者负责，不以通过结构测试代替内容验收。

## 5. 单分支失败／中断重试

任一阶段可加 `--branch ctw` 或 `--branch lexical`，只恢复失败分支；不能跳过前一阶段。默认 `both` 也会跳过已成功阶段，保留另一分支结果。

```sh
pnpm vocabulary:incremental import --config tmp/vocabulary-maintenance/config.json --branch lexical --write
pnpm vocabulary:incremental post-verify --config tmp/vocabulary-maintenance/config.json --branch lexical --read-live
```

- 数据库提交后丢失本地 ACK：重试 import；精确 post-state 是零写入，然后 post-verify 恢复本地成功标记。
- 数据库事务中途失败：全部回滚，保留审核产物，排除故障后原批重试。
- 人工／外部造成混合部分状态或 baseline drift：拒绝导入／Verify，**不自动修补、不刷新 snapshot、不标完成**。单独核查后另行审批处理。
- 文件绑定改变：拒绝使用旧成功记录；不要编辑已发布 manifest／SQL／旧 checkpoint 以绕过校验。
- 并发：统一入口用 `tmp/vocabulary-maintenance/.lock` 排除本地写者；不要同时绕过入口跑独立导入。崩溃遗留锁须确认 PID 已退出后人工清理。

独立 CTW CLI（离线交付或排障）也可使用：

```sh
pnpm ctw-vocabulary:incremental plan --snapshot SNAPSHOT.json --checkpoint CHECKPOINT.json --out RUN_DIR
pnpm ctw-vocabulary:incremental prepare --out RUN_DIR --review REVIEW.json
pnpm ctw-vocabulary:incremental verify --out RUN_DIR --snapshot SYNTHETIC_SNAPSHOT.json
pnpm ctw-vocabulary:incremental import --out RUN_DIR # 仅校验 SQL 产物，不连库
# 后续授权生产操作：verify --read-live、import --write、post-verify --read-live
```

独立 CTW 命令不会自行推进成功 checkpoint；应回到统一入口完成阶段登记／post-verify。生产 Verify 不使用旧 Phase 2 固定初始化数量来验证新增批次，而是核对该批精确 post-state。

## 6. 隔离回归

```sh
pnpm test:vocabulary-incremental
LEXICAL_SQL_TEST_PGLITE=node_modules/@electric-sql/pglite node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test --test-concurrency=1 tests/lexical*.test.js tests/ctwVocabulary.test.cjs tests/ctwVocabularyPhase3.test.cjs tests/ctwVocabularyUnifiedReview.test.cjs
pnpm exec tsc --noEmit --incremental false
pnpm lint
git diff --check
```

新增测试 canonical／词条全为合成，数据库仅 PGlite 内存。CTW 旧回归使用仓库 versioned 历史 reviewed fixture、隔离数据库；不接生产、不运行真实账号验收脚本。没有浏览器验证或真实增量任务隐含在这些命令中。

## 7. 填词题词测总进度

- 在 `ctw_vocabulary_review_sync.sql` 已安装的环境中，先执行增量安装脚本
  `supabase/ctw_vocabulary_overall_progress.sql`，再发布对应应用代码。脚本新增掌握索引、两个内部触发器和一个只读 RPC，不重导词表或改写历史成绩。
- `entry_id` 是乱序版／CEFR、逐题会话／最终成绩共用的永久标识；`normalized_word` 的唯一约束保证同一词不重复。完整单词的服务器判分 `correct=true` 才计入（不是单独词形或原形部分答对）。新逐题正确答案提交成功后就累计，不必等待整轮结束；离线未同步答案不冒充已保存进度。
- 安装时一次性回填最终成绩与未完成会话中的正确答案。后续触发器按 `(student_id, entry_id)` 幂等写入。目录 RPC 只聚合当前词表与该学生掌握索引，不扫描历史 JSON，不返回答题明细。
- 当前词表没有逐词停用标记，有效集合与目录一致：`ctw_vocabulary_entries` 中经 RLS 可见的全部词条。RPC 每次与它取交集；新增／删除／RLS 可见性变化会改变分母与分子。删除时保留历史掌握 ID，不阻挡词表删除。若将来引入独立 `is_active` 等业务过滤，必须在目录与总进度 RPC 中同步使用同一个过滤条件。
- `/api/student/ctw-vocabulary/progress` 使用当前认证身份（学生、教师、Admin 的学生体验入口均一致），不接受外部传入学生 ID；没有新增代查学生入口。
- 总进度响应为 `no-store`，刻意不放入长期 layout cache：刷新或重新进入目录直接读取最新聚合，导入工具不需要依赖浏览器收到失效广播。目录可见时每 30 秒、恢复可见／焦点／pageshow 时更新；同页答题 ACK 也触发更新。切换版本不更换统计来源。
- 隔离回归：`pnpm test:ctw-vocabulary-progress`。
- 浏览器验收必须遵循 `AGENTS.md` 的先启动／Ready 再浏览器流程，始终保持同一 localhost origin。词表增删和答题验证使用隔离数据库，不创建账号或写入线上词测记录；一次性验收脚本、报告和截图按项目本机约定存放在 `outputs/local-only/`，不纳入功能提交。
