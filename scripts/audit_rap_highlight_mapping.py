#!/usr/bin/env python3
"""Audit archived RAP DOCX formatting against source and logical questions.

This script is intentionally file-only: it never connects to Supabase and never
changes source/import packages. It writes a reproducible JSON and CSV audit.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from reading_docx_adapter import (
    MODULES,
    QUESTION_RE,
    RAP_HEADING,
    clean_anchor_text,
    module_ranges,
    read_docx_blocks,
    section_slice,
)


def json_files(root: Path) -> list[Path]:
    return sorted(root.rglob("*.json"))


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalized(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def quoted_spans(value: str) -> list[str]:
    spans: list[str] = []
    for pattern in (r"“([^”]+)”", r'"([^"]+)"', r"‘([^’]+)’", r"'([^']+)'"):
        spans.extend(re.findall(pattern, value))
    return spans


def occurrence_count(haystack: str, needle: str) -> int:
    if not needle:
        return 0
    count = 0
    cursor = 0
    normalized_haystack = normalized(haystack)
    normalized_needle = normalized(needle)
    while True:
        found = normalized_haystack.find(normalized_needle, cursor)
        if found < 0:
            return count
        count += 1
        cursor = found + max(1, len(normalized_needle))


def clean_text_and_boundaries(raw: str) -> tuple[str, list[int]]:
    """Mirror clean_anchor_text while preserving raw->clean boundary offsets."""
    boundaries: list[int | None] = [None] * (len(raw) + 1)
    output: list[str] = []
    raw_cursor = 0
    for match in re.finditer(r"\s*■\s*", raw):
        for index in range(raw_cursor, match.start()):
            boundaries[index] = len(output)
            output.append(raw[index])
        boundaries[match.start()] = len(output)
        output.append(" ")
        for index in range(match.start() + 1, match.end() + 1):
            boundaries[index] = len(output)
        raw_cursor = match.end()
    for index in range(raw_cursor, len(raw)):
        boundaries[index] = len(output)
        output.append(raw[index])
    boundaries[len(raw)] = len(output)

    untrimmed = "".join(output)
    left_trim = len(untrimmed) - len(untrimmed.lstrip())
    cleaned = untrimmed.strip()
    clean_length = len(cleaned)
    mapped = [
        min(clean_length, max(0, int(boundary or 0) - left_trim))
        for boundary in boundaries
    ]
    if cleaned != clean_anchor_text(raw):
        raise ValueError("anchor-cleaning boundary map disagrees with canonical cleaner")
    return cleaned, mapped


def logical_index(import_root: Path) -> dict[str, dict[str, Any]]:
    by_occurrence: dict[str, dict[str, Any]] = {}
    for path in json_files(import_root):
        package = load_json(path)
        question_by_id = {question["questionId"]: question for question in package["questions"]}
        paragraph_by_order = {
            paragraph["paragraphOrder"]: paragraph
            for paragraph in package["passages"][0]["paragraphs"]
        }
        for occurrence in package["occurrences"]:
            by_occurrence[occurrence["occurrenceId"]] = {
                "logicalItemId": package["item"]["logicalItemId"],
                "questionById": question_by_id,
                "paragraphByOrder": paragraph_by_order,
                "questionSources": occurrence["questionSources"],
            }
    return by_occurrence


def logical_question(
    logical: dict[str, Any], source_question_number: int
) -> dict[str, Any]:
    mapping = next(
        (
            candidate
            for candidate in logical["questionSources"]
            if candidate["sourceQuestionStart"] == source_question_number
            and candidate["sourceQuestionEnd"] == source_question_number
        ),
        None,
    )
    if mapping is None:
        raise ValueError(f"no logical question mapping for source question {source_question_number}")
    return logical["questionById"][mapping["questionId"]]


def correct_sentence_text(question: dict[str, Any], passage: dict[str, Any]) -> str | None:
    if question["questionType"] != "rap_sentence_selection":
        return None
    target_id = question["payload"]["targetParagraphId"]
    sentence_id = question["payload"]["correctSentenceId"]
    target = next(
        (paragraph for paragraph in passage["paragraphs"] if paragraph["paragraphId"] == target_id),
        None,
    )
    if target is None:
        return None
    sentence = next(
        (candidate for candidate in target["sentences"] if candidate["sentenceId"] == sentence_id),
        None,
    )
    return None if sentence is None else sentence["text"]


def classify_range(
    highlighted_text: str,
    questions: list[dict[str, Any]],
    passage: dict[str, Any],
) -> tuple[str, str, str, list[int]]:
    exact_question_matches = [
        question
        for question in questions
        if normalized(highlighted_text) in normalized(question["stem"])
    ]
    exact_quoted_matches = [
        question
        for question in exact_question_matches
        if any(normalized(span) == normalized(highlighted_text) for span in quoted_spans(question["stem"]))
    ]
    if len(exact_quoted_matches) == 1:
        question = exact_quoted_matches[0]
        return (
            "HIGH",
            "unique_exact_quoted_text",
            "DOCX highlighted text exactly equals one quoted word/phrase in exactly one question in the passage group.",
            [question["sourceQuestionStart"]],
        )
    if len(exact_question_matches) == 1:
        question = exact_question_matches[0]
        return (
            "HIGH",
            "unique_exact_question_text",
            "DOCX highlighted text occurs verbatim (case-insensitive) in exactly one question text in the passage group.",
            [question["sourceQuestionStart"]],
        )
    if len(exact_question_matches) > 1:
        return (
            "MEDIUM",
            "multiple_exact_question_text_matches",
            "DOCX highlighted text occurs in more than one question text; the range cannot be assigned uniquely from text alone.",
            [question["sourceQuestionStart"] for question in exact_question_matches],
        )

    sentence_answer_matches = [
        question
        for question in questions
        if (answer_text := correct_sentence_text(question, passage)) is not None
        and normalized(answer_text) == normalized(highlighted_text)
    ]
    if len(sentence_answer_matches) == 1:
        question = sentence_answer_matches[0]
        return (
            "HIGH",
            "unique_exact_authoritative_sentence_answer",
            "DOCX highlighted text exactly equals the authoritative correct sentence identified by this question's target paragraph and sentence ID.",
            [question["sourceQuestionStart"]],
        )
    if len(sentence_answer_matches) > 1:
        return (
            "MEDIUM",
            "multiple_authoritative_sentence_matches",
            "DOCX highlighted sentence equals authoritative answers for more than one question in the passage group.",
            [question["sourceQuestionStart"] for question in sentence_answer_matches],
        )

    quoted_overlap = [
        question
        for question in questions
        if any(
            normalized(highlighted_text) in normalized(span)
            or normalized(span) in normalized(highlighted_text)
            for span in quoted_spans(question["stem"])
        )
    ]
    if len(quoted_overlap) == 1:
        return (
            "MEDIUM",
            "unique_partial_quoted_text_overlap",
            "Only one question has quoted text overlapping the DOCX highlight, but the strings are not an exact match.",
            [quoted_overlap[0]["sourceQuestionStart"]],
        )
    return (
        "LOW",
        "no_reliable_text_match",
        "No unique exact question-text or authoritative sentence-answer evidence links this DOCX range to a question.",
        [question["sourceQuestionStart"] for question in quoted_overlap],
    )


def audit(project_root: Path) -> dict[str, Any]:
    source_root = project_root / "data/reading/source-packages"
    import_root = project_root / "data/reading/import-packages/rap"
    logical_by_occurrence = logical_index(import_root)
    rows: list[dict[str, Any]] = []
    source_question_docs: set[str] = set()

    for source_path in json_files(source_root):
        source_package = load_json(source_path)
        rap_occurrences = [
            occurrence
            for occurrence in source_package["occurrences"]
            if occurrence["module"] == "rap"
        ]
        if not rap_occurrences:
            continue
        question_file = project_root / rap_occurrences[0]["source"]["sourceQuestionFile"]
        source_question_docs.add(str(question_file.relative_to(project_root)))
        blocks = read_docx_blocks(question_file)
        ranges_by_module = {module: (start, end) for module, start, end in module_ranges(blocks)}

        for occurrence in rap_occurrences:
            source_module = occurrence["source"]["sourceModule"]
            module_start, module_end = ranges_by_module[source_module]
            rap_slice = section_slice(blocks, module_start, module_end, RAP_HEADING)
            if rap_slice is None:
                raise ValueError(f"missing RAP section in {question_file} {source_module}")
            rap_start, rap_end = rap_slice
            title_indices = [
                index
                for index in range(rap_start, rap_end)
                if blocks[index].style == "MaterialTitle" and blocks[index].text == occurrence["title"]
            ]
            if len(title_indices) != 1:
                raise ValueError(
                    f"expected one title {occurrence['title']!r} in {question_file} {source_module}; found {len(title_indices)}"
                )
            title_index = title_indices[0]
            next_title = next(
                (
                    index
                    for index in range(title_index + 1, rap_end)
                    if blocks[index].style == "MaterialTitle"
                ),
                rap_end,
            )
            first_question = next(
                (
                    index
                    for index in range(title_index + 1, next_title)
                    if QUESTION_RE.match(blocks[index].text.strip())
                ),
                None,
            )
            if first_question is None:
                raise ValueError(f"no questions after {occurrence['title']!r}")
            passage_blocks = [
                blocks[index]
                for index in range(title_index + 1, first_question)
                if blocks[index].style == "BodyText" and blocks[index].text.strip()
            ]
            passage = occurrence["passages"][0]
            if len(passage_blocks) != len(passage["paragraphs"]):
                raise ValueError(f"paragraph count mismatch for {occurrence['sourceOccurrenceId']}")
            logical = logical_by_occurrence.get(occurrence["sourceOccurrenceId"])
            if logical is None:
                raise ValueError(f"missing logical occurrence {occurrence['sourceOccurrenceId']}")

            for paragraph_order, (block, source_paragraph) in enumerate(
                zip(passage_blocks, passage["paragraphs"], strict=True),
                1,
            ):
                if block.text != source_paragraph["rawText"]:
                    raise ValueError(f"raw paragraph mismatch for {occurrence['sourceOccurrenceId']} p{paragraph_order}")
                cleaned, boundary_map = clean_text_and_boundaries(block.text)
                if cleaned != source_paragraph["text"]:
                    raise ValueError(f"clean paragraph mismatch for {occurrence['sourceOccurrenceId']} p{paragraph_order}")
                logical_paragraph = logical["paragraphByOrder"][paragraph_order]
                passage_text = "\n".join(item["text"] for item in passage["paragraphs"])

                for range_index, (raw_start, raw_end) in enumerate(block.highlight_ranges, 1):
                    start_offset = boundary_map[raw_start]
                    end_offset = boundary_map[raw_end]
                    highlighted_text = source_paragraph["text"][start_offset:end_offset]
                    raw_highlighted_text = block.text[raw_start:raw_end]
                    offset_verified = highlighted_text == raw_highlighted_text
                    confidence, evidence_kind, reason, candidate_numbers = classify_range(
                        highlighted_text,
                        occurrence["questions"],
                        passage,
                    )
                    if not offset_verified:
                        confidence = "LOW"
                        evidence_kind = "offset_transform_mismatch"
                        reason = "DOCX run text does not equal the final passage slice after insertion-marker normalization."

                    matched_source_number = candidate_numbers[0] if len(candidate_numbers) == 1 else None
                    source_question = next(
                        (
                            question
                            for question in occurrence["questions"]
                            if question["sourceQuestionStart"] == matched_source_number
                        ),
                        None,
                    )
                    logical_question_data = (
                        logical_question(logical, matched_source_number)
                        if matched_source_number is not None
                        else None
                    )
                    rows.append({
                        "source_label": occurrence["source"]["sourceLabel"],
                        "source_module": source_module,
                        "source_occurrence_id": occurrence["sourceOccurrenceId"],
                        "logical_item_id": logical["logicalItemId"],
                        "logical_question_id": None if logical_question_data is None else logical_question_data["questionId"],
                        "source_question_number": matched_source_number,
                        "question_order": None if logical_question_data is None else logical_question_data["questionOrder"],
                        "question_type": None if source_question is None else source_question["questionType"],
                        "question_text": None if source_question is None else source_question["stem"],
                        "highlighted_text": highlighted_text,
                        "source_paragraph_id": source_paragraph["paragraphId"],
                        "paragraph_id": logical_paragraph["paragraphId"],
                        "paragraph_order": paragraph_order,
                        "start_offset": start_offset,
                        "end_offset": end_offset,
                        "confidence": confidence,
                        "evidence_kind": evidence_kind,
                        "reason": reason,
                        "candidate_source_question_numbers": candidate_numbers,
                        "passage_text_occurrence_count": occurrence_count(passage_text, highlighted_text),
                        "offset_verified": offset_verified,
                        "docx_range_order_in_paragraph": range_index,
                    })

    confidence_counts = Counter(row["confidence"] for row in rows)
    mapped_rows = [row for row in rows if row["logical_question_id"] is not None]
    by_source_question: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
    by_logical_question: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in mapped_rows:
        by_source_question[(row["source_label"], row["source_module"], row["source_question_number"])].append(row)
        by_logical_question[row["logical_question_id"]].append(row)

    multi_range_questions = [
        {
            "source_label": key[0],
            "source_module": key[1],
            "source_question_number": key[2],
            "logical_question_id": values[0]["logical_question_id"],
            "range_count": len(values),
            "highlighted_texts": [value["highlighted_text"] for value in values],
        }
        for key, values in sorted(by_source_question.items())
        if len(values) > 1
    ]
    repeated_text_ranges = [
        {
            "source_label": row["source_label"],
            "source_module": row["source_module"],
            "logical_question_id": row["logical_question_id"],
            "highlighted_text": row["highlighted_text"],
            "paragraph_id": row["paragraph_id"],
            "start_offset": row["start_offset"],
            "end_offset": row["end_offset"],
            "passage_text_occurrence_count": row["passage_text_occurrence_count"],
        }
        for row in rows
        if row["passage_text_occurrence_count"] > 1
    ]
    shared_text_across_questions: list[dict[str, Any]] = []
    rows_by_occurrence_and_text: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in mapped_rows:
        rows_by_occurrence_and_text[(row["source_occurrence_id"], normalized(row["highlighted_text"]))].append(row)
    for (_, _), values in sorted(rows_by_occurrence_and_text.items()):
        question_numbers = sorted({value["source_question_number"] for value in values})
        if len(question_numbers) > 1:
            shared_text_across_questions.append({
                "source_label": values[0]["source_label"],
                "source_module": values[0]["source_module"],
                "source_occurrence_id": values[0]["source_occurrence_id"],
                "highlighted_text": values[0]["highlighted_text"],
                "source_question_numbers": question_numbers,
            })

    overlapping_ranges_across_questions: list[dict[str, Any]] = []
    rows_by_occurrence_and_paragraph: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in mapped_rows:
        rows_by_occurrence_and_paragraph[(row["source_occurrence_id"], row["paragraph_id"])].append(row)
    for (_, _), values in sorted(rows_by_occurrence_and_paragraph.items()):
        ordered = sorted(values, key=lambda value: (value["start_offset"], value["end_offset"]))
        for index, left in enumerate(ordered):
            for right in ordered[index + 1:]:
                if right["start_offset"] >= left["end_offset"]:
                    break
                if left["source_question_number"] != right["source_question_number"]:
                    overlapping_ranges_across_questions.append({
                        "source_label": left["source_label"],
                        "source_module": left["source_module"],
                        "source_occurrence_id": left["source_occurrence_id"],
                        "paragraph_id": left["paragraph_id"],
                        "left_question_number": left["source_question_number"],
                        "right_question_number": right["source_question_number"],
                        "left_range": [left["start_offset"], left["end_offset"]],
                        "right_range": [right["start_offset"], right["end_offset"]],
                    })
    manual_review = [
        {
            "source_label": row["source_label"],
            "source_module": row["source_module"],
            "source_occurrence_id": row["source_occurrence_id"],
            "logical_item_id": row["logical_item_id"],
            "highlighted_text": row["highlighted_text"],
            "confidence": row["confidence"],
            "reason": row["reason"],
            "candidate_source_question_numbers": row["candidate_source_question_numbers"],
        }
        for row in rows
        if row["confidence"] != "HIGH"
    ]
    return {
        "schemaVersion": 1,
        "auditScope": {
            "sourceQuestionDocCount": len(source_question_docs),
            "highlightRangeCount": len(rows),
            "databaseWrites": False,
            "importsRun": False,
            "browserUsed": False,
        },
        "method": {
            "rangeSource": "DOCX w:rPr/w:highlight or non-white w:rPr/w:shd run formatting only",
            "offsetUnit": "zero-based, end-exclusive Unicode code points in final paragraph text",
            "high": "one unique exact question-text/quoted-text match, or one exact authoritative sentence-answer match",
            "medium": "partial or non-unique textual evidence",
            "low": "no reliable unique textual evidence or offset verification failure",
        },
        "summary": {
            "confidenceCounts": {
                "HIGH": confidence_counts["HIGH"],
                "MEDIUM": confidence_counts["MEDIUM"],
                "LOW": confidence_counts["LOW"],
            },
            "mappedSourceQuestionCount": len(by_source_question),
            "mappedLogicalQuestionCount": len(by_logical_question),
            "mappedLogicalItemCount": len({row["logical_item_id"] for row in mapped_rows}),
            "sourceOccurrenceWithHighlightCount": len({row["source_occurrence_id"] for row in rows}),
            "manualReviewRangeCount": len(manual_review),
            "multiRangeQuestionCount": len(multi_range_questions),
            "repeatedTextRangeCount": len(repeated_text_ranges),
            "sharedTextAcrossQuestionsCount": len(shared_text_across_questions),
            "overlappingRangesAcrossQuestionsCount": len(overlapping_ranges_across_questions),
            "unmatchedRangeCount": sum(1 for row in rows if row["logical_question_id"] is None),
        },
        "specialChecks": {
            "multiRangeQuestions": multi_range_questions,
            "repeatedTextRanges": repeated_text_ranges,
            "sharedTextAcrossQuestions": shared_text_across_questions,
            "overlappingRangesAcrossQuestions": overlapping_ranges_across_questions,
            "manualReview": manual_review,
        },
        "ranges": rows,
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "source_label",
        "source_module",
        "source_occurrence_id",
        "logical_item_id",
        "logical_question_id",
        "source_question_number",
        "question_order",
        "question_type",
        "question_text",
        "highlighted_text",
        "paragraph_id",
        "paragraph_order",
        "start_offset",
        "end_offset",
        "confidence",
        "evidence_kind",
        "reason",
        "candidate_source_question_numbers",
        "passage_text_occurrence_count",
        "offset_verified",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            output = dict(row)
            output["candidate_source_question_numbers"] = "|".join(
                str(number) for number in row["candidate_source_question_numbers"]
            )
            writer.writerow(output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit RAP DOCX highlight-to-question mapping evidence.")
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--output-prefix",
        type=Path,
        default=Path("data/reading/reports/rap-highlight-mapping-audit"),
    )
    args = parser.parse_args()
    project_root = args.project_root.resolve()
    output_prefix = args.output_prefix
    if not output_prefix.is_absolute():
        output_prefix = project_root / output_prefix
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    report = audit(project_root)
    output_prefix.with_suffix(".json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_csv(output_prefix.with_suffix(".csv"), report["ranges"])
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
