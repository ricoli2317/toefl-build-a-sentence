// Generates offline QA evidence/current JSON only. Never connects to a DB.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadVocabularySource } from "../lib/ctw-vocabulary/import.ts";
import { applyVocabularySpellingReview, auditRegularVocabularyForms } from "../lib/ctw-vocabulary/spelling-review.ts";
import { FORM_LABELS } from "../lib/ctw-vocabulary/round.ts";
import { ctwSpellingGroups } from "../lib/ctw-vocabulary/review.ts";
const original = loadVocabularySource(readFileSync("data/ctw-vocabulary/ctw-vocabulary-cefr-reviewed.json"), "initial");
const patch = JSON.parse(readFileSync("data/ctw-vocabulary/irregular-spelling-adjustments.json", "utf8"));
if (patch.originalSourceSha256 !== original.sha256) throw new Error("Original review SHA mismatch");
const current = applyVocabularySpellingReview(original.rows, patch.changes);
const beforeLifeFix = applyVocabularySpellingReview(original.rows, patch.changes.filter((change: {word: string}) => change.word !== "life"));
const regularAudit = { beforeLifeFix: auditRegularVocabularyForms(beforeLifeFix), afterLifeFix: auditRegularVocabularyForms(current),
  policy: "Single regular forms are not extra tests; user-confirmed multiple variants remain all-required. Runtime does not read this audit." };
if (regularAudit.afterLifeFix.singleRegularForms.length) throw new Error("Unreviewed regular single-form extra test");
const audit = original.rows.filter(row => row.irregular_forms.length).sort((a,b) => a.word.localeCompare(b.word)).map(row => {
  const after = current.find(entry => entry.word === row.word)!;
  return { word: row.word, changed: JSON.stringify(after.irregular_forms) !== JSON.stringify(row.irregular_forms),
    reason: patch.changes.find((c: { word: string }) => c.word === row.word)?.reason ??
      (row.word === "far" ? "按用户 review 保留两种变体，每个形式都必须填写。"
        : row.word === "get" ? "按用户最新 review 恢复 got / gotten；过去分词两个形式同时测试，撤回仅 got 的旧建议。"
        : ["burn", "learn"].includes(row.word) ? "按用户 review 保留 -ed / -t 两种变化，同时测试；撤回此前删除附加题的建议。"
        : row.word === "be" ? "原始六个形式组不改写；同一时态合并为现在时、过去时、过去分词三排，全部填写，同字母数可交换。"
        : "保留原形式；学习展示与测试项目一致。"),
    displayGroups: ctwSpellingGroups({ ...after, entry_id: "", list_number: 1, list_position: 1, source_sha256: original.sha256 })
      .filter(group => group.id !== "base").map(group => ({label:group.label,answers:group.accepted,allRequired:true})),
    forms: row.irregular_forms.map(form => ({ formType: form.form_type, label: FORM_LABELS[form.form_type], before: form.answers,
      after: after.irregular_forms.find(f => f.form_type === form.form_type)?.answers ?? [],
      tested: after.irregular_forms.some(f => f.form_type === form.form_type) })) };
});
if (audit.length !== 47 || audit.filter(row => row.changed).length !== patch.changes.length) throw new Error("Unexpected review scope");
const directory = resolve("outputs/ctw-vocabulary-unification"); mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory,"current-vocabulary.json"), JSON.stringify(current,null,2)+"\n");
writeFileSync(resolve(directory,"regular-inflection-audit.json"), JSON.stringify(regularAudit,null,2)+"\n");
writeFileSync(resolve(directory,"irregular-spelling-audit.json"), JSON.stringify({standard:patch.standard,originalEntries:47,originalGroups:91,
  currentEntries:current.filter(row=>row.irregular_forms.length).length,currentGroups:current.reduce((n,row)=>n+row.irregular_forms.length,0),
  changedWords:patch.changes.map((c:{word:string})=>c.word),takeInLibrary:current.some(row=>row.word==='take'),items:audit},null,2)+"\n");
const lines=["# 不规则变化逐项复核（47 个原词条 / 91 个原始形式组）","", "已按用户最新 review 更新。life→lives 使用独立增量 SQL，不重跑旧补丁。多变体（包括 burn/learn 的 ed/t）仍全部必答。学习页展示同一份列表。原始 JSON 留档不改，current-vocabulary.json 是应用全部已批准修正后的离线预览。本脚本不连接生产数据库，也不证明生产执行状态。be 在 UI 合并为三排，数据库原始形式字段不重写。", "", "| # | 词条 | 学习展示 / 测试必答 | 说明 |","| --- | --- | --- | --- |"];
audit.forEach((row,index)=>lines.push(`| ${index+1} | ${row.word} | ${row.displayGroups.map(group=>`${group.label}：**${group.answers.join(" / ")}**`).join("<br>") || "无附加题；只测原形"} | ${row.reason} |`));
writeFileSync(resolve(directory,"IRREGULAR-SPELLING-AUDIT.md"),lines.join("\n")+"\n");
console.log(`Latest offline preview: ${regularAudit.afterLifeFix.wordsWithForms} words with extras / ${regularAudit.afterLifeFix.formGroups} stored groups; no unreviewed single regular forms. Offline audit only; no production reads or writes.`);
