#!/usr/bin/env python3
"""Generate an idempotent RAP highlight backfill from the confirmed audit.

The generator is local-file only. It validates source-occurrence compatibility
and final logical paragraph slices before writing SQL; it never connects to a
database or imports Reading content.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


EXPECTED_LOGICAL_QUESTION_COUNT = 152
EXPECTED_LOGICAL_RANGE_COUNT = 156
EXPECTED_LOGICAL_ITEM_COUNT = 96


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def package_index(import_root: Path) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for path in sorted(import_root.glob("*.json")):
        package = load_json(path)
        logical_item_id = package["item"]["logicalItemId"]
        if package["item"]["module"] != "rap":
            raise ValueError(f"non-RAP package in RAP import directory: {path}")
        result[logical_item_id] = {
            "package": package,
            "questions": {question["questionId"]: question for question in package["questions"]},
            "paragraphs": {
                paragraph["paragraphId"]: {
                    **paragraph,
                    "passageId": passage["passageId"],
                }
                for passage in package["passages"]
                for paragraph in passage["paragraphs"]
            },
        }
    return result


def validate_and_merge(audit: dict[str, Any], packages: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if audit.get("summary", {}).get("confidenceCounts") != {"HIGH": 186, "MEDIUM": 0, "LOW": 0}:
        raise ValueError("audit confidence totals are not the confirmed 186 HIGH / 0 MEDIUM / 0 LOW")

    rows_by_question_and_occurrence: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    validation_errors: list[str] = []
    for row_index, row in enumerate(audit["ranges"]):
        logical_item_id = row["logical_item_id"]
        question_id = row["logical_question_id"]
        package_entry = packages.get(logical_item_id)
        if package_entry is None:
            validation_errors.append(f"row {row_index}: missing logical item {logical_item_id}")
            continue
        question = package_entry["questions"].get(question_id)
        if question is None:
            validation_errors.append(f"row {row_index}: missing logical question {question_id}")
            continue
        if question["logicalItemId"] != logical_item_id or not question["questionType"].startswith("rap_"):
            validation_errors.append(f"row {row_index}: target is not a RAP question in {logical_item_id}")
            continue
        paragraph = package_entry["paragraphs"].get(row["paragraph_id"])
        if paragraph is None:
            validation_errors.append(f"row {row_index}: missing paragraph {row['paragraph_id']}")
            continue
        if paragraph["passageId"] != question["payload"]["passageId"]:
            validation_errors.append(f"row {row_index}: paragraph is outside question passage")
            continue
        start_offset = row["start_offset"]
        end_offset = row["end_offset"]
        paragraph_text = paragraph["text"]
        if (
            not isinstance(start_offset, int)
            or isinstance(start_offset, bool)
            or not isinstance(end_offset, int)
            or isinstance(end_offset, bool)
            or start_offset < 0
            or end_offset <= start_offset
            or end_offset > len(paragraph_text)
        ):
            validation_errors.append(f"row {row_index}: invalid offsets [{start_offset}, {end_offset})")
            continue
        sliced_text = paragraph_text[start_offset:end_offset]
        if sliced_text != row["highlighted_text"]:
            validation_errors.append(
                f"row {row_index}: final paragraph slice {sliced_text!r} != highlighted_text {row['highlighted_text']!r}"
            )
            continue
        if row["confidence"] != "HIGH":
            validation_errors.append(f"row {row_index}: non-HIGH mapping cannot enter formal backfill")
            continue
        rows_by_question_and_occurrence[question_id][row["source_occurrence_id"]].append(row)

    if validation_errors:
        raise ValueError("audit validation failed:\n" + "\n".join(validation_errors[:50]))

    targets: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    multi_source_question_count = 0
    for question_id, occurrence_groups in sorted(rows_by_question_and_occurrence.items()):
        if len(occurrence_groups) > 1:
            multi_source_question_count += 1
        occurrence_payloads: dict[str, tuple[tuple[str, int, int, str], ...]] = {}
        for occurrence_id, rows in sorted(occurrence_groups.items()):
            ordered_rows = sorted(
                rows,
                key=lambda row: (row["paragraph_order"], row["start_offset"], row["end_offset"]),
            )
            signature = tuple(
                (
                    row["paragraph_id"],
                    row["start_offset"],
                    row["end_offset"],
                    row["highlighted_text"],
                )
                for row in ordered_rows
            )
            for left, right in zip(signature, signature[1:]):
                if left[0] == right[0] and right[1] < left[2]:
                    validation_errors.append(
                        f"{question_id} {occurrence_id}: overlapping ranges {left[:3]} and {right[:3]}"
                    )
            occurrence_payloads[occurrence_id] = signature
        unique_signatures = set(occurrence_payloads.values())
        if len(unique_signatures) != 1:
            conflicts.append({
                "questionId": question_id,
                "occurrences": {
                    occurrence_id: [list(item) for item in signature]
                    for occurrence_id, signature in occurrence_payloads.items()
                },
            })
            continue
        signature = next(iter(unique_signatures))
        first_row = next(iter(occurrence_groups.values()))[0]
        targets.append({
            "questionId": question_id,
            "logicalItemId": first_row["logical_item_id"],
            "ranges": [
                {"paragraphId": item[0], "startOffset": item[1], "endOffset": item[2]}
                for item in signature
            ],
            "expectedTexts": [item[3] for item in signature],
            "sourceOccurrenceIds": sorted(occurrence_groups),
        })

    if validation_errors:
        raise ValueError("logical range validation failed:\n" + "\n".join(validation_errors[:50]))
    if conflicts:
        raise ValueError("logical question highlight conflicts:\n" + json.dumps(conflicts, ensure_ascii=False, indent=2))

    question_count = len(targets)
    range_count = sum(len(target["ranges"]) for target in targets)
    item_count = len({target["logicalItemId"] for target in targets})
    if question_count != EXPECTED_LOGICAL_QUESTION_COUNT:
        raise ValueError(f"expected {EXPECTED_LOGICAL_QUESTION_COUNT} logical questions, found {question_count}")
    if range_count != EXPECTED_LOGICAL_RANGE_COUNT:
        raise ValueError(f"expected {EXPECTED_LOGICAL_RANGE_COUNT} logical ranges, found {range_count}")
    if item_count != EXPECTED_LOGICAL_ITEM_COUNT:
        raise ValueError(f"expected {EXPECTED_LOGICAL_ITEM_COUNT} logical items, found {item_count}")

    report = {
        "schemaVersion": 1,
        "auditRangeCount": len(audit["ranges"]),
        "logicalQuestionCount": question_count,
        "logicalRangeCount": range_count,
        "logicalItemCount": item_count,
        "multiSourceLogicalQuestionCount": multi_source_question_count,
        "logicalConflictCount": 0,
        "invalidParagraphOrRangeCount": 0,
        "nonRapTargetCount": 0,
        "databaseWrites": False,
        "importsRun": False,
        "targets": targets,
    }
    return targets, report


def values_sql(targets: list[dict[str, Any]], indent: str = "  ") -> str:
    rows: list[str] = []
    for target in targets:
        rows.append(
            "(" + ", ".join([
                sql_text(target["questionId"]),
                sql_text(target["logicalItemId"]),
                sql_text(compact_json(target["ranges"])) + "::jsonb",
                sql_text(compact_json(target["expectedTexts"])) + "::jsonb",
            ]) + ")"
        )
    return (",\n" + indent).join(rows)


def generate_backfill_sql(targets: list[dict[str, Any]]) -> str:
    values = values_sql(targets)
    return f"""-- Generated from data/reading/reports/rap-highlight-mapping-audit.json.
-- Source mappings: 186 HIGH ranges; logical targets: 152 questions / 156 ranges / 96 items.
-- This script changes only reading_questions.passage_highlight_ranges for the stable RAP targets below.

begin;

create temporary table rap_highlight_backfill_targets (
  question_id text primary key,
  logical_item_id text not null,
  ranges jsonb not null,
  expected_texts jsonb not null
) on commit drop;

insert into rap_highlight_backfill_targets (question_id, logical_item_id, ranges, expected_texts)
values
  {values};

do $$
declare
  v_question_count integer;
  v_range_count integer;
  v_item_count integer;
  v_invalid_count integer;
begin
  select count(*), coalesce(sum(jsonb_array_length(ranges)), 0), count(distinct logical_item_id)
  into v_question_count, v_range_count, v_item_count
  from rap_highlight_backfill_targets;

  if v_question_count <> {EXPECTED_LOGICAL_QUESTION_COUNT}
    or v_range_count <> {EXPECTED_LOGICAL_RANGE_COUNT}
    or v_item_count <> {EXPECTED_LOGICAL_ITEM_COUNT} then
    raise exception 'Unexpected RAP highlight target totals: questions=%, ranges=%, items=%',
      v_question_count, v_range_count, v_item_count;
  end if;

  if exists (
    select 1
    from rap_highlight_backfill_targets target
    left join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.question_id is null
      or question.question_type not in (
        'rap_multiple_choice',
        'rap_sentence_insertion',
        'rap_sentence_selection'
      )
      or question.module <> 'rap'
  ) then
    raise exception 'RAP highlight backfill target identity/type validation failed';
  end if;

  if exists (
    select 1
    from rap_highlight_backfill_targets target
    join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.passage_highlight_ranges <> '[]'::jsonb
      and question.passage_highlight_ranges is distinct from target.ranges
  ) then
    raise exception 'RAP highlight backfill would overwrite a conflicting non-empty payload';
  end if;

  with expanded as (
    select
      target.question_id,
      target.logical_item_id,
      range_item.ordinality,
      range_item.value as range_value,
      expected_item.value #>> '{{}}' as highlighted_text
    from rap_highlight_backfill_targets target
    cross join lateral jsonb_array_elements(target.ranges) with ordinality as range_item(value, ordinality)
    join lateral jsonb_array_elements(target.expected_texts) with ordinality as expected_item(value, ordinality)
      on expected_item.ordinality = range_item.ordinality
  ), checked as (
    select
      expanded.*,
      question.question_type,
      paragraph.paragraph_text,
      (range_value->>'startOffset')::integer as start_offset,
      (range_value->>'endOffset')::integer as end_offset
    from expanded
    join public.reading_questions question
      on question.question_id = expanded.question_id
      and question.logical_item_id = expanded.logical_item_id
    left join public.reading_passage_paragraphs paragraph
      on paragraph.passage_id = question.passage_id
      and paragraph.paragraph_id = range_value->>'paragraphId'
  )
  select count(*) into v_invalid_count
  from checked
  where jsonb_typeof(range_value->'paragraphId') <> 'string'
    or jsonb_typeof(range_value->'startOffset') <> 'number'
    or jsonb_typeof(range_value->'endOffset') <> 'number'
    or paragraph_text is null
    or start_offset < 0
    or end_offset <= start_offset
    or end_offset > char_length(paragraph_text)
    or substring(paragraph_text from start_offset + 1 for end_offset - start_offset) <> highlighted_text;

  if v_invalid_count <> 0 then
    raise exception 'RAP highlight backfill has % invalid paragraph/range/text mappings', v_invalid_count;
  end if;
end;
$$;

update public.reading_questions question
set passage_highlight_ranges = target.ranges
from rap_highlight_backfill_targets target
where question.question_id = target.question_id
  and question.logical_item_id = target.logical_item_id
  and question.module = 'rap'
  and question.question_type in (
    'rap_multiple_choice',
    'rap_sentence_insertion',
    'rap_sentence_selection'
  )
  and question.passage_highlight_ranges is distinct from target.ranges;

do $$
begin
  if exists (
    select 1
    from rap_highlight_backfill_targets target
    join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.passage_highlight_ranges is distinct from target.ranges
  ) then
    raise exception 'RAP highlight backfill post-update payload verification failed';
  end if;
end;
$$;

commit;
"""


def generate_verification_sql(targets: list[dict[str, Any]]) -> str:
    values = values_sql(targets, indent="    ")
    return f"""-- Read-only verification for supabase/reading_rap_highlight_backfill.sql.
-- Expected result: verification_passed=true, 152 questions, 156 ranges, 96 items,
-- and zero missing, mismatched, invalid, or non-RAP rows.

with expected(question_id, logical_item_id, ranges, expected_texts) as (
  values
    {values}
), expected_ranges as (
  select
    expected.question_id,
    expected.logical_item_id,
    range_item.ordinality,
    range_item.value as range_value,
    expected_item.value #>> '{{}}' as highlighted_text
  from expected
  cross join lateral jsonb_array_elements(expected.ranges) with ordinality as range_item(value, ordinality)
  join lateral jsonb_array_elements(expected.expected_texts) with ordinality as expected_item(value, ordinality)
    on expected_item.ordinality = range_item.ordinality
), range_checks as (
  select
    expected_ranges.*,
    question.question_type,
    question.module,
    paragraph.paragraph_text,
    (range_value->>'startOffset')::integer as start_offset,
    (range_value->>'endOffset')::integer as end_offset
  from expected_ranges
  left join public.reading_questions question
    on question.question_id = expected_ranges.question_id
    and question.logical_item_id = expected_ranges.logical_item_id
  left join public.reading_passage_paragraphs paragraph
    on paragraph.passage_id = question.passage_id
    and paragraph.paragraph_id = range_value->>'paragraphId'
), metrics as (
  select
    (select count(*) from expected) as expected_question_count,
    (select coalesce(sum(jsonb_array_length(ranges)), 0) from expected) as expected_range_count,
    (select count(distinct logical_item_id) from expected) as expected_logical_item_count,
    (select count(*)
      from expected
      join public.reading_questions question using (question_id, logical_item_id)
      where jsonb_array_length(question.passage_highlight_ranges) > 0
    ) as nonempty_highlight_question_count,
    (select coalesce(sum(jsonb_array_length(question.passage_highlight_ranges)), 0)
      from expected
      join public.reading_questions question using (question_id, logical_item_id)
    ) as stored_range_count,
    (select count(distinct question.logical_item_id)
      from expected
      join public.reading_questions question using (question_id, logical_item_id)
      where jsonb_array_length(question.passage_highlight_ranges) > 0
    ) as stored_logical_item_count,
    (select count(*)
      from expected
      left join public.reading_questions question using (question_id, logical_item_id)
      where question.question_id is null
    ) as missing_target_count,
    (select count(*)
      from expected
      join public.reading_questions question using (question_id, logical_item_id)
      where question.passage_highlight_ranges is distinct from expected.ranges
    ) as payload_mismatch_count,
    (select count(*)
      from range_checks
      where question_type is null
        or module <> 'rap'
        or question_type not in (
          'rap_multiple_choice',
          'rap_sentence_insertion',
          'rap_sentence_selection'
        )
        or paragraph_text is null
        or start_offset < 0
        or end_offset <= start_offset
        or end_offset > char_length(paragraph_text)
        or substring(paragraph_text from start_offset + 1 for end_offset - start_offset) <> highlighted_text
    ) as invalid_range_count,
    (select count(*)
      from expected
      join public.reading_questions question using (question_id, logical_item_id)
      where question.module <> 'rap'
        or question.question_type not in (
          'rap_multiple_choice',
          'rap_sentence_insertion',
          'rap_sentence_selection'
        )
    ) as non_rap_target_count
)
select
  *,
  expected_question_count = {EXPECTED_LOGICAL_QUESTION_COUNT}
    and expected_range_count = {EXPECTED_LOGICAL_RANGE_COUNT}
    and expected_logical_item_count = {EXPECTED_LOGICAL_ITEM_COUNT}
    and nonempty_highlight_question_count = {EXPECTED_LOGICAL_QUESTION_COUNT}
    and stored_range_count = {EXPECTED_LOGICAL_RANGE_COUNT}
    and stored_logical_item_count = {EXPECTED_LOGICAL_ITEM_COUNT}
    and missing_target_count = 0
    and payload_mismatch_count = 0
    and invalid_range_count = 0
    and non_rap_target_count = 0
    as verification_passed
from metrics;
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the confirmed RAP highlight historical backfill.")
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    root = args.project_root.resolve()
    audit_path = root / "data/reading/reports/rap-highlight-mapping-audit.json"
    targets, report = validate_and_merge(
        load_json(audit_path),
        package_index(root / "data/reading/import-packages/rap"),
    )
    (root / "supabase/reading_rap_highlight_backfill.sql").write_text(
        generate_backfill_sql(targets),
        encoding="utf-8",
    )
    (root / "supabase/reading_rap_highlight_backfill_verify.sql").write_text(
        generate_verification_sql(targets),
        encoding="utf-8",
    )
    (root / "data/reading/reports/rap-highlight-backfill-generation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({key: value for key, value in report.items() if key != "targets"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
