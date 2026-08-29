# TPS Reading CSV contract

Use one independent UTF-8 CSV per Reading product. Headers and their order are fixed; do not add, remove, or reorder columns. The three template files are synthetic interface examples and must be replaced with reviewed source content before production import.

## Common source fields

`source_label,occurrence_date,year_month,source_module,source_order,source_group_id`

- `source_label`: stable name of the real source set, not a display number.
- `occurrence_date`: real source date in `YYYY-MM-DD`; never CSV creation/upload time.
- `year_month`: matching `YYYY-MM`.
- `source_module`: `m1` or `m2`.
- `source_order`: positive item order within that source/module; it must be unique there.
- `source_group_id`: stable generator-owned key that groups all rows of one full source item.

TPS deterministically hashes CSV type + `source_label` + `source_module` + `source_order` + `source_group_id` into `occurrence_id`. Filenames, upload order, database UUIDs, dates of upload, and display numbers never enter identity. Reuploading the same source is idempotent.

## Complete the Words

Fixed header:

`source_label,occurrence_date,year_month,source_module,source_order,source_group_id,source_question_start,source_question_end,question_stem,raw_display_text,passage_json,slots_json`

One row is one complete passage plus all blanks. CTW has no title.

- `source_question_start/end`: inclusive original blank-number range.
- `passage_json`: array of `{paragraphId,paragraphOrder,rawText,segments}`; each segment is `{kind:"text",text}` or `{kind:"blank",slotId}`.
- `slots_json`: array of `{slotId,slotOrder,paragraphId,answer,prefix,displayText,missingText,missingLength}`.
- `question_stem` is required; `raw_display_text` may be empty.

Every ID/order/reference, rendered passage, `prefix + missingText = answer`, and blank length is validated. One bad reference rejects the full occurrence.

## Read in Daily Life

Fixed header:

`source_label,occurrence_date,year_month,source_module,source_order,source_group_id,source_question_number,material_id,title,question_order,question_stem,raw_display_text,options_json,correct_option_id`

One row is one question; equal common/group fields form one full material + question group. Question count is not hard-coded.

- `material_id`: canonical `RDL-NNN` only. URLs, object keys, buckets, hostnames, and local paths are not accepted columns.
- `title`: real canonical material title, never `题目037` or another display label.
- `options_json`: ordered array of `{optionId,optionOrder,text}`.
- `correct_option_id`: references an `optionId` in that row.

The database material must already exist, be `bound`, and have both frozen production keys:
`reading/rdl/<MATERIAL_ID>/material_final.png` and `reading/rdl/<MATERIAL_ID>/selection_map.json`.
Import never creates materials or touches R2.

## Read an Academic Passage

Fixed header:

`source_label,occurrence_date,year_month,source_module,source_order,source_group_id,source_question_number,passage_id,passage_title,passage_json,question_order,question_type,question_stem,raw_display_text,passage_highlights_json,options_json,correct_option_id,insert_sentence,insertion_anchors_json,correct_anchor_id,target_paragraph_id,correct_sentence_id`

One row is one question; equal common/group fields form one complete passage + question group. Every row in a group repeats the same `passage_id`, real `passage_title`, and semantically identical `passage_json`. A conflict rejects the full group.

- `passage_json`: array of `{paragraphId,paragraphOrder,text,rawText,sentences}`; each sentence is `{sentenceId,sentenceOrder,text}`. Sentence boundaries are final and TPS never re-splits text.
- `passage_highlights_json`: required per-question array of `{paragraphId,startOffset,endOffset}`. Offsets are zero-based, end-exclusive Unicode code-point positions in that paragraph's exact `text`. Use `[]` only when the authoritative source has no highlight for the question. TPS never derives these ranges from question type, stem, or passage wording.
- `rap_multiple_choice`: fill `options_json` and `correct_option_id`.
- `rap_sentence_insertion`: fill `insert_sentence`, `insertion_anchors_json`, and `correct_anchor_id`. Anchors are `{anchorId,anchorOrder,paragraphId,boundaryIndex,afterSentenceId}` and describe text/sentence boundaries, never pixels.
- `rap_sentence_selection`: fill `target_paragraph_id` and `correct_sentence_id`; the sentence must belong to that paragraph.
- Fields irrelevant to a question type remain empty, but their header columns remain present.

## Import behavior

A complete CTW interaction, RDL material/question group, or RAP passage/question group is one logical item and one atomic database transaction. All three adapters normalize to the existing `ReadingImportPackage`, then share the existing validation and SHA-256 global grouping logic.

An exact match anywhere in database history reuses the logical item and only adds a new source occurrence. A newly imported earlier occurrence moves `first_seen_date` earlier. Similar-but-not-exact content is never fuzzy-merged: it is preserved as a new item and reported as a possible duplicate. Reuploading the same CSV creates no additional logical item, occurrence, question, passage, slot, option, or anchor.

Dynamic catalog labels such as `套题057` and `题目037` do not belong in CSV content, titles, or IDs. They are computed later from `first_seen_date`, source natural order, `source_order`, and stable logical ID.
