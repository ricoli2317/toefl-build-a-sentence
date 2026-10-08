# TPS 生词本 V1 — Phase A1 审计与 SQL 交付

## 1. 审计范围与既有契约

- 基线：最新 `origin/main` / `bf88dc5`，独立 worktree `tps-lexical-wordbook-admin`，分支 `feature/lexical-wordbook-admin`。
- 原 main worktree 存在其他 session 的 lexical/enrichment 未提交修改；未复制、读取其 artifacts、修改或清理它们。维护 worktree 原先干净。
- 本轮只阅读下述代码、相关 SQL 与必要测试；没有连接生产、执行 corpus pipeline、改动 API/UI、commit/push/deploy。

### 证据与限制

**当前 tracked main 没有三张 lexical 表的初始 CREATE TABLE SQL。** 不把本地测试 fixture 当作线上 Schema 证据。下表区分代码依赖/历史交付契约与仍需操作人 preflight 核实的元数据；本轮不宣称完成实时生产 Schema 审计。

| 对象 | 已审计到的事实 | 依据 / 待核实项 |
| --- | --- | --- |
| `lexical_entries.entry_id` | importer 生成 deterministic UUID；lookup 使用它关联 occurrence；本地 SQL fixture 为 UUID PK | `lib/lexical/production.ts:ENTRY_COLUMNS/productionId`、`tests/lexicalIncrementalSql.test.js`；实际 PK、类型由 preflight 确认，新 migration 的 FK 会拒绝不符合唯一性要求的部署 |
| expression identity | `normalized_expression + expression_type + identity_variant` 唯一；homograph variant 被明确拆分 | `supabase/lexical_v1_production_identity.sql` 增加非空 text variant（默认空串）、替换旧二字段唯一约束为三字段唯一索引；migration 会校验索引 |
| enrichment | `common_senses` / `derived_words` / `useful_patterns` 属于 entry；V1 新 entry 使用空数组 | generation types 分别为 `{pos,definition_en,meaning_zh}[]`、`{expression,relation,meaning_zh}[]`、`{pattern,meaning_zh}[]`；本地 SQL fixture 用 `jsonb`，真实字段类型需 preflight，新 migration 强制要求 jsonb |
| `lexical_source_blocks` | 导出 `block_id`、source 三元组、`block_kind`、`source_text_hash`、生成状态/版本 | 本地 fixture 为 UUID PK，source 三元组唯一；真实约束/index/FK actions 需 preflight。导出列中没有原文或句子边界 |
| `lexical_occurrences` | 导出 UUID `occurrence_id` / `entry_id`，source 三元组、`sentence_id`、`source_anchor_id`、surface/normalized surface、UTF-16 `[start,end)`、context POS/中英释义/**整个 block 的** `context_text`、review/version | `production.ts:OCCURRENCE_COLUMNS`、`annotation.ts`、`tokenize.ts`；本地 fixture 有 entry FK、source+span UNIQUE 和合法范围 CHECK，真实约束/index/FK actions 需 preflight |
| 用户 identity | `profiles.id uuid` → `auth.users.id`；学生记录使用 `student_id uuid` → profiles | `supabase/schema.sql`、`student_wrong_questions.sql`、Reading category migration |

**不能按 lemma 合并。** normalize 只处理边界空白、内部连续空白、弯引号和英文大小写，不做词形还原。annotation 的 `canonical_expression` 与 `lemma` 是分开的字段，entry key 不含 lemma。不同词形可能被 annotation 归到同一 canonical expression，也可能拥有不同 normalized expression/entry；同 expression 还可按 expression type / homograph variant 分开。incremental consolidation 对 canonical/lemma 冲突 fail closed，不自动按词根归并。本轮不读取 frozen corpus 来枚举实际词形；preflight 提供小范围“同 lemma 多 entry”只读查询供核实。

### A1 定向修订：identity_variant 与词汇级身份

1. `production.ts:54` **直接使用 `review_target_id ?? ''` 作为 identity_variant**；UUID 来自已审阅的 entry_key。variant 是不透明的历史审阅目标标识，不是词形变化、POS、义项序号或可自动删除的 UI 后缀。`docs/lexical-v1-production.md` 记录实际发布有 **7 个 homograph groups / 10 个 explicit review targets**；这些组的词项名称不在 tracked main 中。
2. `incremental/consolidation.ts` 使用完整三元组复用 entry；相同 canonical expression/lemma 对应多个 variant 时也不猜测。`identityReview.ts` 要求 occurrence hash、明确 entry_id/variant、reason/provenance，而且不能改变 normalized expression / expression type / lemma 语义。
3. **存在不同 canonical entries 显示同样词形的结构性事实**：三元组唯一不禁止 normalized expression/type 相同而 variant 不同；既有增量测试的 `Delta` base / `other-sense` fixture 就是字面显示完全相同的两个 entry。既有 production fixture 的 `it`（pronoun）/ `IT`（abbreviation）同为 `(it,word)`，variant 分别为 pronoun/abbreviation，说明忽略 variant 会误合并。**以上两个具体词例均为已有离线 fixture，绝不是已核验的生产实例。** 本轮没有查询生产或读取 frozen/artifact 内容，不能捏造那 7 组的真实成员。
4. 当前字段不能区分某一 reviewed split 是“同一词汇的不同语境义项”还是“不可合并的 homograph/缩写/词源身份”；lemma、大小写或相同展示字符串都不足以证明等价。preflight 新增真实候选组查询（完整 identity/lemma/review_notes）；操作人拿到结果后逐组确认。
5. **自动规则**：学生词汇身份是完整 `(normalized_expression, expression_type, identity_variant)`，与 transport UUID 分离；按 `(student_id, domain, lexeme_key)` 唯一。key 是上述三元组的确定性 hash，冲突后比较完整三元组。没有跨 domain 或 lemma 聚合；不同 normalized expression 的词形独立收藏。canonical identity 完全相同的主键迁移仍是同一学生词汇。
6. **有审阅决议才可覆盖 variant 分组**：同 normalized expression/type 的多个 variant，如果明确判定同一学生词汇，可映射到一个**固定、版本化的 lexeme anchor 三元组**并追加 canonical links；anchor 不能按“这位学生先收藏哪一个”或“最小 UUID”选取。关联保存每个 canonical 的完整三元组与 review reference。没有 approved mapping 时必须走 exact identity，不能用 arbitrary review note 字符串或学生传参冒充审核。不同 expression type（特别是 word/proper_noun）或不同 normalized expression，即使 lemma 相同，本次 Schema 也禁止合并。
7. 本 migration **只提供关联结构，不创建/批准/填充任何生产等价映射，也不实现 resolver**。未知 variant 是否等价仍是独立人工决策项；不能宣称“所有相同显示词形已能可靠合并”。若审批后新增映射与既有收藏分组不一致，须专门的快照保全迁移，而非普通收藏时偷偷合并两个 entries。

### lookup 的真实 response

`app/api/lexical/lookup/route.ts`、`lib/lexical/lookup.ts`、`lookup.server.ts`：

```ts
type LookupResult =
  | { status: 'unmatched' | 'unavailable' }
  | {
      status: 'matched';
      match: 'exact_phrase' | 'exact_token' | 'entry_expression' | 'supplement_parent';
      entry: { entry_id: string; canonical_expression: string; expression_type: string; lemma: string | null };
      occurrence: {
        occurrence_id: string; entry_id: string; source_type: string;
        source_item_id: string; content_block_id: string;
        start_offset: number; end_offset: number; surface_text: string;
        context_pos: string | null; context_meaning_zh: string;
        context_definition_en: string | null;
      };
      containingPhrases?: Array<{ entry: /* 同上 */ unknown; occurrence: /* 同上 */ unknown }>;
    };
```

response **没有** `context_text`、`sentence_id`、`identity_variant`、enrichment 或原句；需要在 A2 服务端重新授权并读取，不能相信客户端递交的释义/例句。当前 lookup 支持的类型为 `word / phrase / phrasal_verb / idiom / proper_noun`。parent supplementation 收藏的是返回的 parent entry，而非学生选中的孤立词；containing phrase 收藏要明确选择相应 occurrence，并重新核验它属于同一合法选择。

### 授权、RLS、service-role

- `lib/auth.ts` 验证 token/JWKS，并逐请求读取 profiles.role/is_active；禁用账户不能绕过。
- `requireReadingAttemptStudent` 实际用 `requireUserWithRole(..., 'student')` capability。现有 Student Experience 同样允许 Teacher/Admin 使用，但只能访问自己的学生体验数据；不赋予查看他人生词本权限。
- 用户 token 客户端核实 attempt/assignment 归属；`authorizeLexicalSource` 通过后才用 service-role 查询 corpus。block 原文及 hash 不符返回 unavailable；查询过滤 disabled occurrence/entry，并限制候选 32 行。
- 历史交付文档明确 corpus 仅 postgres/service_role 可访问，RLS/grants 未改。实际线上权限仍由 preflight 核实，本 migration 不扩张 lexical 访问权限。
- SQL 风格参考最新 Reading category migration：独立手动 SQL Editor 文件、`begin/commit`、显式 grants/RLS、用户 owner SELECT、server-only writes、快照 guard。

### incremental sync 的影响

`lib/lexical/incremental/importer.ts` / `consolidation.ts`、`docs/lexical-incremental-sync.md`：

- 变更/删除 block：删除原 occurrence；变更 block 更新 hash 等并插入新的完整 occurrence 集；删除 block 删除 source row。
- entries 仅 `INSERT ... ON CONFLICT DO NOTHING`；没有 UPDATE/DELETE/自动 entry merge。复用 entry 时维持原 ID/语义；identity ambiguity 须明确审阅。
- orphan entry 可以保留。未来 enrichment 或人工 ID/merge migration 属于另一流程，本轮不更改该流程。

### 原句提取的可靠边界

`annotation.ts` 两层 occurrence 都把 `context_text` 写成 **work.block.text**。RAP paragraph、CTW paragraph、RDL material、Email scenario、AD posts 等可包含多句；标题、subject、选项和要求也可能只是片段。`sentence_id` 不是所有题型都有，更不等于一个可直接返回的句子。

下一阶段必须从重新授权且 hash 一致的 canonical block 提取 **包含所收藏 occurrence 完整 span 的真实语境**，不能仅依据原始 selected token 范围（parent expression 可能更长）。不是完整句子并不是失败理由：

1. **RAP passage paragraph**：使用现有 `reading_passage_sentences`（限定 passage/paragraph），按顺序拼接 `' '`，要求与 occurrence.context_text 和授权 paragraph **完全相同**；参照 `enumerators/rap.server.ts` 计算 JS UTF-16 起止范围，选唯一包住整个 occurrence 的 sentence；若 occurrence.sentence_id 非空也须一致。不依赖某个 sentence ID 在重新导入后仍指向同一文本。
2. **已有单句 canonical block**（例如 BAS final sentence / RAP insert-sentence）：仅在核验确为完整单句且覆盖 occurrence 后保存原文；block kind 名称不是免检许可证。
3. **CTW/RDL/WE/AD 及普通 stem/prompt**：目前没有通用持久化 sentence boundary。A2 可采用本地确定性英文 sentence segmentation（如 `Intl.Segmenter('en', {granularity:'sentence'})`）生成边界候选，保留 exact slice，不改写标点/空白；必须增加缩写、引号、小数、换行、跨句 expression 的针对性 fixture 与保守歧义规则。**segmenter 不是天然正确的完整句证明**；无法确认单句而原始 block 可可靠核验时，保存整个真实 block 为 `fragment / whole_block_fallback`，不截取固定字符窗、不冒充 sentence。这里 fragment 表示“原文摘录而非已证明的单句”，可包含多句。
4. **RDL**：已有 occurrence.context_text 是经过 selection-map reconstruction 的 canonical text（`rdl.server.ts`）；题型来源继续用 `rdl`。不读取本地 Reading PDF/DOCX/图片/_work，不建立第二份素材库。已完成的 corpus/hash 校验继续是边界。

5. **标题/Subject/短选项/自然片段**：保存该完整 canonical 字段为 `fragment / whole_fragment_block`；若有已验证的自然结构边界，可用 `verified_fragment_span`。词/字符 anchor 本身、固定长度窗口、句读不明的任意 substring 都不是可靠自然边界。不能 AI 生成、补全、改写或将 fragment 标签升级成 sentence 来改善展示。
6. 只有原文/权限/hash/offset 不可核验时才失败；例如 `CANONICAL_CONTEXT_UNAVAILABLE`、`CANONICAL_CONTEXT_STALE`、`OCCURRENCE_SPAN_MISMATCH`、`UNVERIFIABLE_CONTEXT_BOUNDARY`。sentence map 不一致时不信任其边界；若独立核验的整个 block 仍可信可 fragment fallback，否则明确失败、事务零写入。过长语境如超出现有请求合同也应明确拒绝，不暗中截断。

六题型提取合同（下面是 A2 设计，不是已实现的提取器）：

| 题型 | 当前 canonical block | 安全语境选择 |
| --- | --- | --- |
| CTW | `ctw_paragraph`，正确答案重建文本；UI segment/slot offsets 需投影回完整 paragraph | 已验证句子 span → sentence；没有可信句界则完整 paragraph fragment |
| RDL | `rdl_material`（selection-map 重建），`rdl_question_stem/option` | 已验证句子或自然 paragraph/字段边界；短选项完整 fragment；无边界则完整可信 material block fragment |
| RAP | `rap_paragraph/title/question_stem/question_option/question_instruction/insert_sentence` | paragraph 优先核验 sentence table；title/片段 option 可完整 fragment；insert sentence/完整句型 stem 核验后 sentence |
| BAS | `bas_prompt / bas_final_sentence` | final sentence 核验单句；prompt 对话可能多句，使用验证句界，否则完整 prompt fragment；不用学生拼出的句子 |
| WE | `email_scenario/task_instruction/requirement/subject` | scenario/要求按可信句界；subject 和短要求可完整 fragment；不能用 recipient name anchor 当语境边界 |
| AD | `academic_professor_prompt / academic_student_response` | 题目提供的 prompt/posts 按可信句界，否则完整 post fragment；不用学生自己的 response |

持久化 `context_kind(sentence/fragment)`、`extraction_method`、首次来源的 `source_block_kind`。它们是首次捕获的不可变 provenance，不宣称代表后来所有来源的结构；同文本再收藏只追加题型标签/义项关系，不覆盖首次分类。A1 不实现提取器，不宣称所有六题型已有可靠单句字段。

## 2. 最终 Schema

修订为三层主体 + sense/example M:N 关联 + canonical 关联，共 **5 张轻量表**；**没有 mastery/SRS、global alias 或 enrichment 副本表**。

| 表 | 关键字段与唯一性 |
| --- | --- |
| `student_wordbook_entries` | UUID PK；`student_id`、`domain(reading/writing)`；冻结 `expression / normalized_expression / expression_type / identity_variant / first_saved_at`；三元组生成 `lexeme_key`，UNIQUE(student, domain, lexeme_key)，不再持有单一 canonical ID |
| `student_wordbook_canonical_links` | PK(wordbook entry, canonical ID)，UNIQUE(student, domain, canonical ID)；canonical FK restrict delete/cascade ID update；冻结 canonical 完整 identity、关联种类、review reference 和首次关联时间 |
| `student_wordbook_senses` | UUID PK；owner/entry；冻结 POS（nullable）、中文释义（required）、英文定义（nullable）、首次时间；生成 SHA-256 `snapshot_key`；UNIQUE(wordbook entry, sense key) |
| `student_wordbook_examples` | UUID PK；owner/entry；exact `example_text`、`context_kind`、首次 `source_block_kind`、提取方式、首次时间；生成 SHA-256；UNIQUE(wordbook entry, example key)。`source_types text[]` 为已排序、非空、无 NULL/重复的允许来源集合，只可追加 |
| `student_wordbook_example_senses` | PK(example_id, sense_id)；双 composite FK 保证两端属于**同用户、同 domain、同 wordbook entry** |

为什么保留第四张表：同一个句子或 fragment 可说明多个收藏义项，允许 **entry 范围内真正的例句文本去重**。第五张表让学生 lexeme 身份和 canonical UUID 分开，并支持逐项审阅后的多 canonical 关联；不把 canonical identity 破坏成纯展示字符串。

- Reading 来源仅 `ctw / rdl / rap`；Writing 来源仅 `bas / write_email / academic_discussion`。WE/AD 仅展示标签，不引入另一套数据库值。
- 义项去重：三个快照字段的**精确字符串组合**；不按 POS+中文而忽略英文，不做模糊“相近释义”合并。NULL 和空串 hash 可区分；本 migration 对空白释义拒收（可选缺失字段用 NULL）。相同英文/中文文字的大小写、标点或空白差异属于不同快照，不在存储时改写原数据。
- 例句去重：同 entry 下 **exact example_text**；来源、提取方式不参与 identity。再次采集同句只合并 sources，保留第一次验证方法及时间。句子的大小写/空白/标点不同不自动归并。
- SHA-256 使用文本数组 JSON 编码，避免 NULL/分隔符碰撞，固定 32-byte 避免长句索引超过 btree 行大小。理论 hash collision 时 A2 要比较原字段并拒绝不一致；不能 `DO NOTHING` 后静默当成同义项。
- 索引：owner/domain/时间列表、canonical FK 查找、entry 范围 dedupe、example sources GIN、link 两方向/FK 查找。按题型筛词：限定 student/domain 的 examples，并用 `source_types @> ARRAY[source]`；通过 wordbook_entry_id 返回 distinct entries。不扫描 lexical corpus 或历史 attempts。
- RLS：五表仅 owner + `can_use_student_experience()` SELECT。authenticated/anon 无 INSERT/UPDATE/DELETE/TRUNCATE，service_role 仅 CRUD，helper 函数不向浏览器开放。用户修改走以后鉴权 API；service-role 本身绕过 RLS，**后端必须按可信 user ID 限定所有写和取消收藏**。
- 新 canonical link guard 只做两次 PK 定位读取，校验实际 canonical identity 与关联快照、owner/anchor 一致。exact 必须完整三元组匹配；reviewed_equivalent 必须 variant 不同但 normalized expression/type 相同，并有非空 review reference。review reference 只是审阅证据指针，不能由学生生成，不能代替人工审核；不使用昂贵的 canonical 同步 trigger。
- snapshot guard **只阻止 UPDATE 历史值，不阻止 INSERT 新层级**：追加 sense/example/canonical link、给同例句 INSERT 新 sense link、source_types 单调 union 均允许。反向减少来源、改正文/POS/释义/首次时间/分类或重写审核信息仍拒绝。

## 3. 快照保全与动态 Enrichment

- 不保存 occurrence/block/question/sentence 导航 FK；import 删除/替换 occurrence 不影响已保存文本。
- snapshot UPDATE guard 只比较当前/旧行（O(1)）：entry 身份文本及收藏时间不可改；sense 文本不可改；example 文本/方法/时间不可改，source set 只能增长。没有挂在 lexical_entries 上的同步 trigger。
- 三个 enrichment 字段**不在任何用户表里**。A2 列表查询按 canonical_links 中**全部** lexical_entry_id join 最新 entry，组合用户 senses/examples。响应/cache 必须 `no-store`（或等效每次刷新机制），不能长期缓存旧 enrichment。
- **停用**：收藏照常存在；生词本 join 不因 disabled 而过滤整条收藏，返回 canonical_status + 当前共享 enrichment；新收藏继续沿用 lookup 的 disabled 拒绝规则。
- **删除**：canonical_links 的 FK `ON DELETE RESTRICT`，保护历史与动态链接；有收藏的 canonical row 必须保留/tombstone，不能删除、置空或复用 ID 为不相关词。
- **主键 renumber**：`ON UPDATE CASCADE` 只更新引用 ID，快照不变；没有对用户收藏做 DELETE CASCADE。
- **合并/多 ID → 一个 ID**：本輪不添加 global redirect/alias 表或改 lexical schema。UUID renumber 的 identity 不变时直接 UPDATE canonical PK，可级联传递 link 而不改 wordbook lexeme。不同 identity 的合并必须独立人工审阅：INSERT 正确的 exact/reviewed target link，再在同事务中删除迁移完成的旧 link；禁止把旧 link 的 identity 快照覆盖为新 identity。normalized expression/type 不同的替换不是当前允许的 equivalence，需另外明确迁移方案。
- 合并事务要求：按固定 ID 顺序锁 canonical/wordbook rows；用批准的稳定 anchor，复制/去重 senses、examples、sense/example links，union sources，保留最早首次时间与历史文本。若已有两个学生 entries 需要归并，不可绕过 immutable guard 改它们的身份；应在专门迁移中构造/选取符合固定 anchor 的 survivor（必要时 INSERT 复制旧快照和最早时间），确认全部子数据/关联转移后才删 loser。普通收藏不做此类追溯迁移。
- **canonical identity 的原地变更**不能伪装为 enrichment 更新：link guard 不监听 canonical 表的 UPDATE（避免同步 trigger）；verify 检查 identity drift，发布流程必须冻结身份或执行上面的 reviewed relink。现有 occurrence FK 的动作也可能阻止 PK 更新，需 preflight 检查全部相关 FK 后设计迁移。
- 未完成 relink 前保留旧 canonical rows；若 enrichment 只写目标而关联仍是旧 ID，就不会自动追踪——**须先迁移关联或同步维护旧 canonical enrichment，不声称有未实现的 redirect**。
- **取消/再次收藏**：产品已确认 hard delete 当前用户该 domain 的 entry，cascade 删除其 sense/example/两类关联；canonical 不删。Reading 取消不影响 Writing。再收藏创建新 UUID、新首次时间、新快照；存续期间重复收藏才保留首次时间。

### 多 canonical enrichment 的确定性读取

- 单次有界 join 取当前 entry 的所有 links + 最新 lexical_entries，不挑首次收藏的 canonical、不按最小 UUID 选一个覆盖其它条目。缺失 canonical 是完整性错误；disabled 仍返回收藏和 status。读时比较 canonical 完整 identity 与 link 的身份快照；若 ID 被复用或身份被原地改动，保留学生收藏并标 `enrichmentStatus: identity_drift`，该 canonical 的数组返回 NULL 且不参与合并展示，不能把错误身份的 enrichment 套给历史词汇。
- 始终保留按 canonical UUID 排序的 `enrichmentSources`，含关联种类、状态与三组原始最新数组；不会把它们持久化回学生表。
- 合并展示按每个字段内的**完整 JSONB 值**去重（对象 key 顺序无关），附有贡献该值的全部 lexicalEntryIds；按字段名和 JSON 值文本的 `COLLATE "C"` 稳定排序。不能按 lemma、单个英文词或中文释义相近程度做语义去重。
- 非相同内容**不覆盖、不任选 winner**：common_senses 同 `(pos,definition_en)` 的不同 payload、derived_words 同 `(expression,relation)` 的不同 payload、useful_patterns 同 `pattern` 的不同 payload，保留全部并标 `hasConflict`。不同定义本来就是不同义项，不当成冲突。缺少这些键的 payload 仍保留原值，但不凭空生成 conflict key。
- `verify.sql` 的只读 CTE 演示并测试上述组装，不创建 view/RPC/API；A2 应按 verified student_id/domain 限定 page。新 enrichment 发布后下一次 join 即变化，用户快照/关联无需批量更新。

## 4. SQL 与本地检查

文件（完整文件可直接粘贴 SQL Editor，无 psql meta-command/COPY）：

1. `supabase/student_wordbook_v1_preflight_20261008.sql`：只读部署依赖/真实约束/权限核验与少量数据抽样。
2. `supabase/student_wordbook_v1_20261008.sql`：独立一次性 migration；一个 BEGIN/COMMIT，依赖类型/identity index fail closed；表、约束、索引、RLS、grants、helper/guard。
3. `supabase/student_wordbook_v1_verify_20261008.sql`：只读检查表约束/索引/RLS/权限/trigger、孤儿/不完整收藏计数及动态 join 示例。
4. `tests/studentWordbookSql.test.js`：定向静态与可选本地 PostgreSQL WASM 实际 SQL 测试。无需读取 .env，不能连接生产。

本地测试命令（test-only runtime 安装到外部临时目录，不改依赖文件，不使用 lexical/enrichment artifacts）：

```sh
npm install --prefix '<local-temp>/tps-wordbook-sql-runtime' --no-audit --no-fund --ignore-scripts @electric-sql/pglite
WORDBOOK_SQL_TEST_PGLITE='<local-temp>/tps-wordbook-sql-runtime/node_modules/@electric-sql/pglite' \
  node --test tests/studentWordbookSql.test.js
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/lexicalLookup.test.js
git diff --check
```

SQL-engine tests覆盖实际 migration 执行、重复收藏唯一性/来源原子 union、同句多义项、用户/domain/lemma 隔离、全部现有 expression types/homograph variant、composite FK、快照不可变、source 删除、最新 enrichment join、canonical 删除拒绝/ID cascade/冲突合并拒绝、收藏末步骤失败全回滚、取消/重收、RLS/账户禁用/浏览器写拒绝、长快照/hash 边界、依赖类型/index drift、重复 migration 失败及只读 verify SQL。

初稿已保留的实测结果：原有 A1 定向检查 **10/10 通过（0 skipped）**；既有 lexical lookup 测试 **22/22 通过**。本次在原测试基础上追加 identity/多关联/fragment/来源/权限与依赖漂移测试，结果见本次验收汇报。所有运行仅使用外部临时目录中的 PGlite，不连接生产，没有创建 production 收藏 RPC/API。

定向修订结果：wordbook **17/17 通过（0 skipped，其中 16 项本地 PostgreSQL SQL-engine 测试）**，保留原 10 项；preflight 与 verify 均在本地 fixture 下实际执行过且只读。新增覆盖 reviewed 多 canonical、UUID 迁移后词汇去重、it/IT 离线身份反例、六题型 fragments、classification/provenance 不可变、来源 stale replacement 拒绝、动态 enrichment 的重复/冲突/来源保留、domain 取消隔离，以及 PK/FK/权限/nullability/array 前提 fail closed。

**测试限制**：本地 dependency Schema 是已有代码契约的模型，不是线上 schema dump；PGlite 单连接不证明真实多数据库 session 并发。并发安全设计依赖 PostgreSQL UNIQUE + `ON CONFLICT` 行锁 + 服务端单事务协议；A2 应补多连接并发/收藏取消竞态验证。本轮没有全仓测试、build、浏览器、自动生产验证。

## 5. A2 收藏 API 数据契约（本轮只定义，不实现）

### 输入 / 服务端事实

- 客户端传现有 `LexicalLookupRequest` 的合法页面/选择证明，加 `occurrenceId`（从主结果或 containing phrase 明确选择）。不接收可信 student_id、domain、释义、例句或 enrichment。
- 服务端逐请求鉴权；复用既有 owned-page 校验、block hash/UTF-16 span 校验和匹配规则；确认 requested occurrence 是这次授权匹配的主结果或 containing phrase，entry 未 disabled。
- domain 由 source_type 计算，不能客户端任选：CTW/RDL/RAP → reading；BAS/WE/AD → writing。
- 加载完整 occurrence（含 context_text/sentence_id）、canonical entry identity。若收藏发生时 source/occurrence 已更新，拒绝 stale 或明确要求刷新；不能用客户端旧释义与当前 ID 拼接。
- 服务端产出的事务输入为可信 `studentId/domain/lexemeAnchor/lexicalEntryId`、canonical 完整 identity、合法关联种类/approved review reference、三个 context 字段、核验的 exact 原句**或 fragment**、context_kind/source_block_kind/提取方法、**一个真实 source type**。仅非完整句不报错；无法恢复可信原文时给出具体错误、无残留收藏。跨 variant anchor 只能来自已批准的一致映射，不接受学生提供；未决组默认 exact 并单列人工审阅。

### 原子写协议

1. 一个数据库事务（A2 server-only RPC 或等效可信事务层；不能五次独立 Supabase `.insert()`）。先确定不依赖学生收藏顺序的 lexeme anchor；按唯一 `(student,domain,lexeme_key)` 插入或冲突时取得该 entry 行锁，精确检查完整 anchor 三元组，保留首次时间/快照。追加 canonical link；仅引用已有合法 entry，不创建 canonical 数据。
2. sense 按 snapshot_key conflict dedupe；精确检查原字段。`ON CONFLICT DO NOTHING` 后如要查询冲突行，用下一 statement（READ COMMITTED）；不要假设同 statement CTE 能看到刚等来的其他事务 row。
3. example conflict update 使用 **数据库 target.source_types** 与本次 sources 原子集合 union，再排序；不得先读数组、客户端拼接后覆盖。核验 exact example_text 避免理论 hash collision，保留原方法/时间。
4. 插入 M:N link `ON CONFLICT DO NOTHING`；任一步失败全回滚，包括已追加的 sources。事务外不生成/同步 enrichment。
5. 取消收藏同样按 verified student+domain+wordbook entry 删除，并与收藏使用一致 lexeme 唯一键/entry 锁；并发以事务序列化结果为准。只有提交成功后返回 saved/cancelled；不得把五层部分成功当成成功。

### 读取 response

```ts
type WordbookItem = {
  wordbookEntryId: string; domain: 'reading' | 'writing';
  lexemeIdentity: { normalizedExpression: string; expressionType: string; identityVariant: string };
  expression: string; firstSavedAt: string;
  senses: Array<{ senseId: string; contextPos: string | null;
    contextMeaningZh: string; contextDefinitionEn: string | null; exampleIds: string[] }>;
  examples: Array<{ exampleId: string; text: string; contextKind: 'sentence' | 'fragment';
    sourceBlockKind: string; extractionMethod: string;
    sourceTypes: Array<'ctw' | 'rdl' | 'rap' | 'bas' | 'write_email' | 'academic_discussion'> }>;
  enrichmentSources: Array<{ lexicalEntryId: string; associationKind: 'exact_identity' | 'reviewed_equivalent';
    canonicalStatus: string; enrichmentStatus: 'available' | 'identity_drift';
    commonSenses: unknown[] | null; derivedWords: unknown[] | null; usefulPatterns: unknown[] | null }>;
  enrichmentItems: Array<{ field: 'common_senses' | 'derived_words' | 'useful_patterns';
    value: unknown; lexicalEntryIds: string[]; hasConflict: boolean }>;
};
```

用户快照与共享最新 enrichment 明确分区；source labels 无丢失，未来可按 `wordbookEntryId + sourceType` 建独立 mastery track，不预建 review 表。

## 6. 手动审批前仍需确认

1. 执行只读 preflight 后确认缺失基础 DDL 对应的真实类型、PK/UNIQUE/FK/RLS/grants，以及 can_use_student_experience 已部署；若不匹配停下并审阅，不自动修 corpus。
2. **唯一未能由现有字段解决的词汇归并决议**：生产那 7 组 homograph 中哪些 variant 是同词汇的不同义项、哪些是真不同身份？具体成员仍待只读 preflight 输出；已有 it/IT 与 Delta fixture 展示两类风险，但不冒充真实生产案例。建议真正不同身份保留全三元组；确认等价的组采用固定版本化 anchor + approved review reference。没有该决议不自动忽略 variant，不能宣称相同显示文本已全部可靠归并。
3. sentence/fragment 均允许、取消后新首次时间已按本轮产品规则落实；不再作为待确认项。exact 文本去重不做语义归并；enrichment 冲突全量保留并标记，不擅自猜测优先级。
4. 没有 canonical merge/redirect 现成机制。未来合并流程必须遵守上述 retention/relink/冲突合并事务协议，否则收藏虽然不丢，旧 ID 的 enrichment 也不会神奇跟随目标。
5. service-role bypass RLS 的 owner 限定、单事务保存、hash exact check、确定性原句验证和无旧 enrichment 缓存必须在 A2 实现并测试；A1 Schema 不能代替这些授权/事务入口。

**停止点：等待 SQL 审阅/确认，之后另行授权 Phase A2。**

## Phase A1 生产 Migration 最终安全审核

### 已收到的生产事实与限制

操作人已执行旧版 preflight、未收到 SQL 错误；SQL Editor 最后展示了 12 组 lemma 候选（包括 a/A、accompany、act as 等）。**这只说明旧脚本执行到候选查询，不证明此前所有兼容性布尔值/计数合格。** 旧脚本没有明确的 RAISE 断言；对象不存在等自然 SQL 错误能中止，但 FALSE/非零诊断值不能中止。候选不是 Schema 失败，也不是归并授权；本轮不要求重发这些结果、不处理其语义合并。

### Blocker / 安全检查缺口：已修复

1. **Preflight 必须可明确失败**：复用 migration 的只读依赖断言，两者由定向测试检查完全一致。强制校验表/字段类型、UUID PK、canonical 三元组及 source/span 唯一索引、key NOT NULL、profiles→auth.users / occurrence→entry 的已验证 FK、身份/capability 函数签名与权限、schema usage、corpus RLS 与有效 SELECT 权限、enrichment 必须是 JSON 数组。额外拒绝已有同名安装对象。成功时最后显示 `WORDBOOK_PREFLIGHT_OK`；对象定义、FK 动作、函数正文、原文抽样及候选仍是只读诊断，候选不参与通过/失败决策。
2. **RLS bypass / 继承权限不能仅凭 REVOKE 推断安全**：依赖断言拒绝具有 superuser/BYPASSRLS 或可继承 migration owner 权限的 anon/authenticated。migration 在 COMMIT 前再检查实际表/列级写权限与 helper EXECUTE，防止继承角色/default grants 绕过直接 REVOKE；不修改共享角色或全局默认权限，发现异常整体回滚。
3. **Verify 必须可明确判定安装完整性**：新增只读断言，校验五表完整字段/类型/可空性（同时排除 enrichment 副本）、PK/UNIQUE/索引、复合 FK 与 delete/update 动作、stored generated dedupe keys、CHECK 谓词、启用且正确绑定的 guard triggers、owner-only SELECT policy、有效表/列/函数权限。函数为 SECURITY INVOKER、固定 `pg_catalog` search_path；函数正文与 CHECK 表达式绑定本次批准的 migration，避免同名空 guard / CHECK(true) 误通过。额外 FK/trigger 和 canonical identity drift 会失败。最后显示 `WORDBOOK_VERIFY_OK`。

这些断言都是 `BEGIN TRANSACTION READ ONLY` 下的 metadata/SELECT/DO-RAISE，不创建持久化对象、不调用收藏 RPC、不修改 canonical 或用户数据。Verify 的 CHECK 指纹在固定 search_path 下按去空白后的表达式排序计算，函数正文只归一化 CRLF/外层空白；诊断查询仍保留完整定义便于人工审阅。

### Migration 审核结论

- **建议执行：YES（先通过更新后的强制 preflight）**。五表结构、去重、domain 隔离、快照不可变及来源单调追加的设计未调整、保护未放宽。
- 仅创建新的 wordbook 对象，显式授予服务端 CRUD；不合并/写入/删除 lexical data，不复制 enrichment，不修改 lookup/incremental 代码或既有 corpus 权限。canonical FK 带来的禁止删除/ID cascade 是预期关联保护；incremental 的 entry insert-only 与 occurrence 替换不受数据层关联阻碍。
- DDL/FK 安装可能短暂等待既有表锁；`lock_timeout=10s`、`statement_timeout=60s` 和单一事务使超时/任何错误安全回滚。一次性 migration 不覆盖现有对象，重复执行安全失败。
- **Non-blocker（A2）**：服务端鉴权/owner 写入限定、真实语境恢复、保存 RPC/单事务调用、多连接并发/取消竞态、hash 冲突精确比较。SQL Editor 的空表 Verify 不证明生产中的真实多用户行为；本轮只额外运行相关本地 owner-RLS 测试，不进行生产 JWT/数据验证。
- **Future**：12 组候选及其他 canonical identity 人工归组、Mastery/SRS、Enrichment V2。当前没有批准/填充任何跨 identity 等价映射，不阻塞创建空表。

### 本轮定向验证与手动执行顺序

本轮仅运行审核相关的 **7 项测试，7/7 通过、0 skipped**（包含 3 项新增 final-audit 用例），以及文件格式检查。覆盖断言型 preflight、migration 重复执行、真实本地 owner-RLS、继承 default grant 导致原子回滚、空表下错误 policy/表与列级写授权/禁用 trigger/cascade FK/CHECK(true)/空 guard/复制 enrichment 列/缺少索引/暴露函数的检测。此前 17/17 与 lookup 22/22 的历史结果保留，不声称重新全量执行。本地依赖 fixture 不是生产元数据证据。

SQL Editor 使用有权限的 operator（通常 postgres），每次粘贴**完整文件**：

1. 更新后的 `supabase/student_wordbook_v1_preflight_20261008.sql`，须显示 `WORDBOOK_PREFLIGHT_OK`；无需重发旧的 12 组候选。
2. `supabase/student_wordbook_v1_20261008.sql`，任何错误时停止并检查，不自行修改 canonical tables/共享权限让它通过。
3. `supabase/student_wordbook_v1_verify_20261008.sql`，须显示 `WORDBOOK_VERIFY_OK`。若失败，先调查具体缺失/漂移，不盲目重跑 migration 或删除表。

本轮没有连接生产、自动执行 SQL、commit/push/deploy；停止并等待操作人执行结果，不进入 Phase A2。
