# Historical May/June Batch 1B migration tool only. Future Reading content is
# produced by the separate Reading project and enters TPS as final CSV.
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from lxml import etree
from PIL import Image

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
QUESTION_RE = re.compile(r"^(\d{1,2})\.\s*(.*)$", re.S)
OPTION_RE = re.compile(r"^([A-D])\.\s?(.*)$", re.S)
RANGE_RE = re.compile(r"Questions\s+(\d+)[-–](\d+)\s+of\s+\d+", re.I)
BLANK_RE = re.compile(r"(?P<prefix>[A-Za-z][A-Za-z’'\-]*)(?P<blank>_(?:\s*_)+|_)")
MODULES = {"M1": "m1", "M2": "m2"}
CTW_HEADING = "Complete the Words"
RDL_HEADING = "Read in Daily Life"
RAP_HEADING = "Read an Academic Passage"
ABBREVIATIONS = {
    "a.m.", "p.m.", "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.",
    "st.", "vs.", "etc.", "e.g.", "i.e.", "fig.", "no.", "u.s.", "u.k."
}


@dataclass(frozen=True)
class Block:
    kind: str
    text: str
    style: str | None
    # Zero-based, end-exclusive Unicode code-point ranges taken only from Word
    # run formatting. Historical files use teal w:shd rather than w:highlight.
    highlight_ranges: tuple[tuple[int, int], ...] = ()


class AdapterIssue(Exception):
    pass


def qn(local: str) -> str:
    return f"{{{W}}}{local}"


def xml_text(node: etree._Element) -> str:
    parts: list[str] = []
    for item in node.iter():
        if item.tag == qn("t"):
            parts.append(item.text or "")
        elif item.tag == qn("tab"):
            parts.append("\t")
        elif item.tag in {qn("br"), qn("cr")}:
            parts.append("\n")
    return "".join(parts)


def source_highlighted_run(run: etree._Element) -> bool:
    run_properties = run.find(qn("rPr"))
    if run_properties is None:
        return False
    highlight = run_properties.find(qn("highlight"))
    if highlight is not None and highlight.get(qn("val")) not in {None, "none", "default"}:
        return True
    shading = run_properties.find(qn("shd"))
    return (
        shading is not None
        and shading.get(qn("val")) == "clear"
        and shading.get(qn("fill")) not in {None, "auto", "FFFFFF"}
    )


def xml_highlight_ranges(node: etree._Element) -> tuple[tuple[int, int], ...]:
    ranges: list[tuple[int, int]] = []
    cursor = 0
    for run in node.iter(qn("r")):
        run_text = xml_text(run)
        end = cursor + len(run_text)
        if run_text and source_highlighted_run(run):
            if ranges and ranges[-1][1] == cursor:
                ranges[-1] = (ranges[-1][0], end)
            else:
                ranges.append((cursor, end))
        cursor = end
    return tuple(ranges)


def read_docx_blocks(path: Path) -> list[Block]:
    with zipfile.ZipFile(path) as archive:
        root = etree.fromstring(archive.read("word/document.xml"))
    body = root.find(qn("body"))
    if body is None:
        raise AdapterIssue("DOCX has no word/document.xml body")
    blocks: list[Block] = []
    for child in body:
        if child.tag == qn("p"):
            style = None
            ppr = child.find(qn("pPr"))
            if ppr is not None:
                style_node = ppr.find(qn("pStyle"))
                if style_node is not None:
                    style = style_node.get(qn("val"))
            blocks.append(Block("paragraph", xml_text(child), style, xml_highlight_ranges(child)))
        elif child.tag == qn("tbl"):
            rows: list[str] = []
            for row in child.findall(qn("tr")):
                cells = [
                    "\n".join(xml_text(p) for p in cell.xpath("./w:p", namespaces=NS))
                    for cell in row.findall(qn("tc"))
                ]
                rows.append("\t".join(cells))
            blocks.append(Block("table", "\n".join(rows), None))
    return blocks


def parse_source_label(path: Path) -> str:
    match = re.fullmatch(r"TOEFL_Reading_(.+?)(?:_Answers)?\.docx", path.name)
    if not match:
        raise AdapterIssue(f"unsupported source filename: {path.name}")
    return match.group(1)


def source_date(label: str) -> tuple[str, str, str]:
    match = re.fullmatch(r"(5|6)\.(\d{1,2})([A-Z]?)", label)
    if not match:
        raise AdapterIssue(f"unsupported source label: {label}")
    month = int(match.group(1))
    day = int(match.group(2))
    suffix = match.group(3).lower()
    iso = f"2026-{month:02d}-{day:02d}"
    set_id = f"reading-{iso}{f'-{suffix}' if suffix else ''}"
    return iso, f"2026-{month:02d}", set_id


def parse_answers(path: Path) -> dict[tuple[str, int], str]:
    answers: dict[tuple[str, int], str] = {}
    module: str | None = None
    for block in read_docx_blocks(path):
        text = block.text.strip()
        if text in MODULES:
            module = MODULES[text]
            continue
        match = QUESTION_RE.match(text)
        if not match or module is None:
            continue
        key = (module, int(match.group(1)))
        if key in answers:
            raise AdapterIssue(f"duplicate answer {module} question {key[1]}")
        answers[key] = match.group(2)
    return answers


def strip_question_number(text: str) -> tuple[int, str]:
    match = QUESTION_RE.match(text.strip())
    if not match:
        raise AdapterIssue(f"question paragraph has no numeric prefix: {text[:80]}")
    return int(match.group(1)), match.group(2)


def parse_options(blocks: list[Block], question_index: int, end: int) -> list[tuple[str, str]]:
    options: list[tuple[str, str]] = []
    for block in blocks[question_index + 1:end]:
        text = block.text.strip()
        if not text:
            continue
        if QUESTION_RE.match(text) or block.style in {"MaterialTitle", "Instruction", "Module", "TypeHeading"}:
            break
        match = OPTION_RE.match(text)
        if not match:
            continue
        options.append((match.group(1), match.group(2)))
        if len(options) == 4:
            break
    return options


def rdl_title(table_text: str) -> str | None:
    """Return only a structurally explicit email subject.

    Historical RDL tables flatten visual headings and body copy into one string,
    so their first line is not a reliable title boundary. Other RDL titles must
    arrive as a reviewed canonical_title from content production.
    """
    lines = [line.strip() for line in table_text.splitlines() if line.strip()]
    if not lines:
        return None
    subject_index = next((index for index, line in enumerate(lines) if line.lower().startswith("subject:")), None)
    if subject_index is not None:
        value = lines[subject_index].split(":", 1)[1].strip()
        if not value and subject_index + 1 < len(lines):
            value = lines[subject_index + 1]
        if value:
            return value
    return None


def rdl_title_word_count(title: str) -> int:
    return len(re.findall(r"[A-Za-z]+(?:['\N{RIGHT SINGLE QUOTATION MARK}-][A-Za-z]+)*", title))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_copy(source: Path, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    source_hash = sha256(source)
    copied_hash = sha256(destination)
    if source_hash != copied_hash:
        raise AdapterIssue(f"checksum mismatch after copy: {source} -> {destination}")
    return source_hash


def sentence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = 0
    length = len(text)
    index = 0
    while index < length:
        char = text[index]
        if char not in ".?!":
            index += 1
            continue
        if char == "." and index + 1 < length and text[index + 1] == ".":
            index += 1
            continue
        end = index + 1
        while end < length and text[end] in "\"'”’)]":
            end += 1
        if end < length and not text[end].isspace():
            index += 1
            continue
        candidate = text[start:end].strip()
        last_token = candidate.split()[-1].lower() if candidate.split() else ""
        if char == "." and (
            last_token in ABBREVIATIONS
            or re.search(r"(?:^|\s)[A-Z]\.$", candidate)
            or re.search(r"(?:[A-Za-z]\.){2,}$", candidate)
            or (index > 0 and index + 1 < length and text[index - 1].isdigit() and text[index + 1].isdigit())
        ):
            index += 1
            continue
        if candidate:
            leading = len(text[start:end]) - len(text[start:end].lstrip())
            spans.append((start + leading, end))
        start = end
        while start < length and text[start].isspace():
            start += 1
        index = start
    tail = text[start:].strip()
    if tail:
        tail_start = text.find(tail, start)
        spans.append((tail_start, tail_start + len(tail)))
    return spans


def clean_anchor_text(raw: str) -> str:
    return re.sub(r"\s*■\s*", " ", raw).strip()


def build_passage(
    set_id: str,
    module: str,
    passage_number: int,
    title: str,
    raw_paragraphs: list[str],
    source: str,
    date: str,
    year_month: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    passage_id = f"{set_id}-{module}-rap-p{passage_number:02d}"
    paragraphs: list[dict[str, Any]] = []
    marker_boundaries: list[dict[str, Any]] = []
    marker_order = 0
    for paragraph_index, raw_text in enumerate(raw_paragraphs, 1):
        paragraph_id = f"{passage_id}-p{paragraph_index:02d}"
        text = clean_anchor_text(raw_text)
        spans = sentence_spans(text)
        sentences = [
            {
                "sentenceId": f"{paragraph_id}-s{sentence_index:02d}",
                "sentenceOrder": sentence_index,
                "text": text[start:end],
            }
            for sentence_index, (start, end) in enumerate(spans, 1)
        ]
        if not sentences:
            raise AdapterIssue(f"passage paragraph has no sentence boundary: {passage_id} p{paragraph_index}")
        search_from = 0
        for marker_match in re.finditer("■", raw_text):
            marker_order += 1
            prefix = clean_anchor_text(raw_text[:marker_match.start()])
            prefix_spans = sentence_spans(prefix) if prefix else []
            boundary_index = len(prefix_spans)
            if boundary_index > len(sentences):
                raise AdapterIssue(f"anchor boundary exceeds paragraph: {passage_id}")
            marker_boundaries.append({
                "markerOrder": marker_order,
                "paragraphId": paragraph_id,
                "boundaryIndex": boundary_index,
                "afterSentenceId": None if boundary_index == 0 else sentences[boundary_index - 1]["sentenceId"],
            })
            search_from = marker_match.end()
        paragraphs.append({
            "paragraphId": paragraph_id,
            "paragraphOrder": paragraph_index,
            "text": text,
            "rawText": raw_text,
            "sentences": sentences,
        })
    return ({
        "passageId": passage_id,
        "title": title,
        "source": source,
        "sourceDate": date,
        "yearMonth": year_month,
        "paragraphs": paragraphs,
    }, marker_boundaries)


def module_ranges(blocks: list[Block]) -> list[tuple[str, int, int]]:
    starts = [(MODULES[block.text.strip()], index) for index, block in enumerate(blocks) if block.text.strip() in MODULES]
    result: list[tuple[str, int, int]] = []
    for position, (module, start) in enumerate(starts):
        end = starts[position + 1][1] if position + 1 < len(starts) else len(blocks)
        result.append((module, start, end))
    if [item[0] for item in result] != ["m1", "m2"]:
        raise AdapterIssue("expected one M1 section followed by one M2 section")
    return result


def section_slice(blocks: list[Block], start: int, end: int, heading: str) -> tuple[int, int] | None:
    heading_index = next((index for index in range(start, end) if blocks[index].text.strip() == heading), None)
    if heading_index is None:
        return None
    later = [
        index for index in range(heading_index + 1, end)
        if blocks[index].text.strip() in {CTW_HEADING, RDL_HEADING, RAP_HEADING}
    ]
    return heading_index + 1, later[0] if later else end


def set_alias(label: str, occurrence_labels: set[str]) -> str:
    if label in occurrence_labels:
        return label
    candidate = f"{label}A"
    matches = [item for item in occurrence_labels if item == candidate]
    if len(matches) == 1:
        return candidate
    raise AdapterIssue(f"no unique material-index set label for {label}")


def option_payload(question_id: str, options: list[tuple[str, str]], answer: str) -> tuple[list[dict[str, Any]], str]:
    if len(options) != 4:
        raise AdapterIssue(f"expected four options for {question_id}, found {len(options)}")
    if [letter for letter, _ in options] != ["A", "B", "C", "D"]:
        raise AdapterIssue(f"expected ordered A-D options for {question_id}")
    by_letter: dict[str, str] = {}
    payload = []
    for order, (letter, text) in enumerate(options, 1):
        option_id = f"{question_id}-opt-{order}"
        by_letter[letter] = option_id
        payload.append({"optionId": option_id, "optionOrder": order, "text": text})
    if answer not in by_letter:
        raise AdapterIssue(f"answer {answer!r} does not map to options for {question_id}")
    return payload, by_letter[answer]


def question_base(
    question_id: str,
    set_id: str,
    order: int,
    module: str,
    start: int,
    end: int,
    question_type: str,
    stem: str,
    raw: str,
) -> dict[str, Any]:
    return {
        "questionId": question_id,
        "setId": set_id,
        "questionOrder": order,
        "testModule": module,
        "sourceQuestionStart": start,
        "sourceQuestionEnd": end,
        "questionType": question_type,
        "stem": stem,
        "rawDisplayText": raw,
    }


class SetAdapter:
    def __init__(
        self,
        question_file: Path,
        answer_file: Path,
        archived_question_file: str,
        archived_answer_file: str,
        material_by_id: dict[str, dict[str, Any]],
        occurrences_by_set: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
        manifest_by_id: dict[str, dict[str, Any]],
        unresolved: list[dict[str, Any]],
    ) -> None:
        self.question_file = question_file
        self.answer_file = answer_file
        self.label = parse_source_label(question_file)
        self.date, self.year_month, self.set_id = source_date(self.label)
        self.archived_question_file = archived_question_file
        self.archived_answer_file = archived_answer_file
        self.blocks = read_docx_blocks(question_file)
        self.answers = parse_answers(answer_file)
        self.material_by_id = material_by_id
        self.occurrences_by_set = occurrences_by_set
        self.manifest_by_id = manifest_by_id
        self.unresolved = unresolved
        self.questions: list[dict[str, Any]] = []
        self.passages: list[dict[str, Any]] = []
        self.material_ids: set[str] = set()
        self.material_titles: dict[str, str] = {}

    def issue(self, module: str | None, question: str | int | None, type_name: str, issue: str, reason: str) -> None:
        self.unresolved.append({
            "month": self.year_month,
            "sourceFile": self.archived_question_file,
            "answerFile": self.archived_answer_file,
            "set": self.label,
            "module": module,
            "question": question,
            "type": type_name,
            "issue": issue,
            "reason": reason,
        })

    def append_question(self, question: dict[str, Any]) -> None:
        question["questionOrder"] = len(self.questions) + 1
        self.questions.append(question)

    def answer(self, module: str, number: int) -> str:
        answer = self.answers.get((module, number))
        if answer is None:
            raise AdapterIssue(f"answer missing for {module} question {number}")
        return answer

    def parse_ctw(self, module: str, start: int, end: int) -> None:
        index = start
        while index < end:
            block = self.blocks[index]
            range_match = RANGE_RE.search(block.text.strip())
            if not range_match:
                index += 1
                continue
            question_start = int(range_match.group(1))
            question_end = int(range_match.group(2))
            paragraph_index = next(
                (candidate for candidate in range(index + 1, end) if self.blocks[candidate].style == "BodyText"),
                None,
            )
            if paragraph_index is None:
                self.issue(module, f"{question_start}-{question_end}", "ctw", "missing paragraph", "No BodyText paragraph follows the CTW range heading")
                index += 1
                continue
            raw_text = self.blocks[paragraph_index].text
            matches = list(BLANK_RE.finditer(raw_text))
            expected = question_end - question_start + 1
            if len(matches) != expected:
                self.issue(module, f"{question_start}-{question_end}", "ctw", "blank count mismatch", f"Found {len(matches)} source blanks for {expected} official answers")
                index = paragraph_index + 1
                continue
            question_id = f"{self.set_id}-{module}-ctw-q{question_start:02d}-{question_end:02d}"
            paragraph_id = f"{question_id}-p01"
            slots: list[dict[str, Any]] = []
            segments: list[dict[str, Any]] = []
            cursor = 0
            failed = False
            for slot_order, match in enumerate(matches, 1):
                source_number = question_start + slot_order - 1
                answer = self.answers.get((module, source_number))
                if answer is None:
                    self.issue(module, source_number, "ctw", "answer missing", "The answer DOCX has no authoritative answer for this blank")
                    failed = True
                    break
                prefix = match.group("prefix")
                display_text = match.group(0)
                blank_count = display_text.count("_")
                if not answer.startswith(prefix):
                    self.issue(module, source_number, "ctw", "prefix mismatch", f"Source prefix {prefix!r} does not match authoritative answer {answer!r}")
                    failed = True
                    break
                missing_text = answer[len(prefix):]
                if len(missing_text) != blank_count:
                    self.issue(module, source_number, "ctw", "missing length mismatch", f"Source has {blank_count} blanks but answer requires {len(missing_text)} characters")
                    failed = True
                    break
                if match.start() > cursor:
                    segments.append({"kind": "text", "text": raw_text[cursor:match.start()]})
                slot_id = f"{question_id}-slot-{slot_order:02d}"
                segments.append({"kind": "blank", "slotId": slot_id})
                slots.append({
                    "slotId": slot_id,
                    "slotOrder": slot_order,
                    "sourceQuestionNumber": source_number,
                    "paragraphId": paragraph_id,
                    "answer": answer,
                    "prefix": prefix,
                    "displayText": display_text,
                    "missingText": missing_text,
                    "missingLength": len(missing_text),
                })
                cursor = match.end()
            if failed:
                index = paragraph_index + 1
                continue
            if cursor < len(raw_text):
                segments.append({"kind": "text", "text": raw_text[cursor:]})
            question = question_base(
                question_id, self.set_id, 0, module, question_start, question_end,
                "ctw", "Fill in the missing letters in the paragraph.", raw_text,
            )
            question["payload"] = {
                "paragraphs": [{
                    "paragraphId": paragraph_id,
                    "paragraphOrder": 1,
                    "rawText": raw_text,
                    "segments": segments,
                }],
                "slots": slots,
            }
            self.append_question(question)
            index = paragraph_index + 1

    def material_occurrences(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        candidates = [self.label, f"{self.label}A"]
        matches = [
            item
            for candidate in candidates
            for item in self.occurrences_by_set.get(candidate, [])
        ]
        if not matches:
            raise AdapterIssue(f"no material-index occurrences for {self.label}")
        ranges: list[tuple[int, int]] = []
        deduplicated: list[tuple[dict[str, Any], dict[str, Any]]] = []
        seen_occurrences: set[str] = set()
        for material, occurrence in matches:
            occurrence_id = str(occurrence.get("occurrence_id"))
            if occurrence_id in seen_occurrences:
                continue
            start = int(occurrence["question_range"]["start"])
            end = int(occurrence["question_range"]["end"])
            if any(start <= existing_end and end >= existing_start for existing_start, existing_end in ranges):
                raise AdapterIssue(
                    f"ambiguous overlapping material-index ranges for {self.label}: {start}-{end}"
                )
            seen_occurrences.add(occurrence_id)
            ranges.append((start, end))
            deduplicated.append((material, occurrence))
        return deduplicated

    def occurrence_for_question(self, number: int) -> tuple[dict[str, Any], dict[str, Any]]:
        matches = [
            item for item in self.material_occurrences()
            if int(item[1]["question_range"]["start"]) <= number <= int(item[1]["question_range"]["end"])
        ]
        if len(matches) != 1:
            raise AdapterIssue(f"question {number} maps to {len(matches)} material-index occurrences")
        return matches[0]

    def parse_choice_question(
        self,
        module: str,
        number: int,
        raw_stem: str,
        options: list[tuple[str, str]],
        question_type: str,
        payload_identity: dict[str, Any],
    ) -> None:
        answer = self.answer(module, number)
        question_id = f"{self.set_id}-{module}-q{number:02d}"
        option_rows, correct_option_id = option_payload(question_id, options, answer)
        question = question_base(
            question_id, self.set_id, 0, module, number, number,
            question_type, strip_question_number(raw_stem)[1], raw_stem,
        )
        question["payload"] = {**payload_identity, "options": option_rows, "correctOptionId": correct_option_id}
        self.append_question(question)

    def parse_rdl(self, module: str, start: int, end: int) -> None:
        for index in range(start, end):
            block = self.blocks[index]
            if not QUESTION_RE.match(block.text.strip()):
                continue
            try:
                number, _ = strip_question_number(block.text)
                material, occurrence = self.occurrence_for_question(number)
                options = parse_options(self.blocks, index, end)
                material_id = str(material["asset_id"])
                if number == int(occurrence["question_range"]["start"]):
                    material_block = next(
                        (self.blocks[candidate] for candidate in range(index - 1, start - 1, -1) if self.blocks[candidate].kind == "table"),
                        None,
                    )
                    if material_block is None:
                        raise AdapterIssue("no RDL material table precedes the question group")
                    explicit_title = rdl_title(material_block.text)
                    canonical_title = str(material.get("canonical_title") or "").strip()
                    title = (
                        explicit_title
                        if explicit_title and rdl_title_word_count(explicit_title) <= 5
                        else canonical_title
                    )
                    if not title:
                        raise AdapterIssue(
                            "RDL material has no eligible explicit title; content production "
                            "must supply a reviewed canonical_title"
                        )
                    if rdl_title_word_count(title) < 1 or rdl_title_word_count(title) > 5:
                        raise AdapterIssue("canonical RDL title must contain 1-5 English words")
                    existing_title = self.material_titles.get(material_id)
                    if existing_title is not None and existing_title != title:
                        raise AdapterIssue(f"conflicting RDL titles {existing_title!r} and {title!r}")
                    self.material_titles[material_id] = title
                self.material_ids.add(material_id)
                self.parse_choice_question(module, number, block.text, options, "rdl", {"materialId": material_id})
            except AdapterIssue as error:
                number = QUESTION_RE.match(block.text.strip())
                self.issue(module, int(number.group(1)) if number else block.text[:80], "rdl", "question conversion failed", str(error))

    def parse_rap(self, module: str, start: int, end: int) -> None:
        title_indices = [index for index in range(start, end) if self.blocks[index].style == "MaterialTitle"]
        for passage_number, title_index in enumerate(title_indices, 1):
            passage_end = title_indices[passage_number] if passage_number < len(title_indices) else end
            first_question = next(
                (index for index in range(title_index + 1, passage_end) if QUESTION_RE.match(self.blocks[index].text.strip())),
                None,
            )
            if first_question is None:
                self.issue(module, None, "rap", "passage has no questions", self.blocks[title_index].text)
                continue
            raw_paragraphs = [
                self.blocks[index].text for index in range(title_index + 1, first_question)
                if self.blocks[index].style == "BodyText" and self.blocks[index].text.strip()
            ]
            try:
                passage, marker_boundaries = build_passage(
                    self.set_id, module, passage_number, self.blocks[title_index].text,
                    raw_paragraphs, self.archived_question_file, self.date, self.year_month,
                )
            except AdapterIssue as error:
                self.issue(module, None, "rap", "passage conversion failed", str(error))
                continue
            self.passages.append(passage)
            question_indices = [
                index for index in range(first_question, passage_end)
                if QUESTION_RE.match(self.blocks[index].text.strip())
            ]
            for question_position, question_index in enumerate(question_indices):
                raw_stem = self.blocks[question_index].text
                try:
                    number, stem = strip_question_number(raw_stem)
                    answer = self.answer(module, number)
                    question_id = f"{self.set_id}-{module}-q{number:02d}"
                    next_question = question_indices[question_position + 1] if question_position + 1 < len(question_indices) else passage_end
                    if re.fullmatch(r"[A-D]", answer):
                        options = parse_options(self.blocks, question_index, next_question)
                        self.parse_choice_question(
                            module, number, raw_stem, options, "rap_multiple_choice",
                            {"passageId": passage["passageId"]},
                        )
                    elif re.fullmatch(r"Location\s+[1-4]", answer, re.I):
                        location = int(re.search(r"[1-4]", answer).group())
                        insertion_texts = [
                            self.blocks[index].text.strip() for index in range(question_index + 1, next_question)
                            if self.blocks[index].text.strip()
                            and not OPTION_RE.match(self.blocks[index].text.strip())
                            and not QUESTION_RE.match(self.blocks[index].text.strip())
                            and not self.blocks[index].text.strip().lower().startswith("where would the sentence best fit")
                        ]
                        if len(insertion_texts) != 1:
                            raise AdapterIssue(f"expected one insertion sentence, found {len(insertion_texts)}")
                        if len(marker_boundaries) != 4:
                            raise AdapterIssue(f"expected four passage anchors, found {len(marker_boundaries)}")
                        anchors = [
                            {
                                "anchorId": f"{question_id}-anchor-{anchor['markerOrder']}",
                                "anchorOrder": anchor["markerOrder"],
                                "paragraphId": anchor["paragraphId"],
                                "boundaryIndex": anchor["boundaryIndex"],
                                "afterSentenceId": anchor["afterSentenceId"],
                            }
                            for anchor in marker_boundaries
                        ]
                        question = question_base(
                            question_id, self.set_id, 0, module, number, number,
                            "rap_sentence_insertion", stem, raw_stem,
                        )
                        question["payload"] = {
                            "passageId": passage["passageId"],
                            "insertSentence": insertion_texts[0],
                            "anchors": anchors,
                            "correctAnchorId": anchors[location - 1]["anchorId"],
                        }
                        self.append_question(question)
                    elif re.fullmatch(r"Sentence\s+\d+", answer, re.I):
                        sentence_number = int(re.search(r"\d+", answer).group())
                        paragraph_match = re.search(r"paragraph\s+(\d+)", stem, re.I)
                        if not paragraph_match:
                            raise AdapterIssue("sentence-selection stem has no target paragraph number")
                        paragraph_number = int(paragraph_match.group(1))
                        if paragraph_number < 1 or paragraph_number > len(passage["paragraphs"]):
                            raise AdapterIssue(f"target paragraph {paragraph_number} does not exist")
                        target = passage["paragraphs"][paragraph_number - 1]
                        if sentence_number < 1 or sentence_number > len(target["sentences"]):
                            raise AdapterIssue(f"answer sentence {sentence_number} does not exist in target paragraph")
                        question = question_base(
                            question_id, self.set_id, 0, module, number, number,
                            "rap_sentence_selection", stem, raw_stem,
                        )
                        question["payload"] = {
                            "passageId": passage["passageId"],
                            "targetParagraphId": target["paragraphId"],
                            "correctSentenceId": target["sentences"][sentence_number - 1]["sentenceId"],
                        }
                        self.append_question(question)
                    else:
                        raise AdapterIssue(f"unsupported authoritative answer format {answer!r}")
                except AdapterIssue as error:
                    number_match = QUESTION_RE.match(raw_stem.strip())
                    self.issue(module, int(number_match.group(1)) if number_match else raw_stem[:80], "rap", "question conversion failed", str(error))

    def build(self) -> dict[str, Any]:
        if any("missing from the source" in block.text.lower() for block in self.blocks):
            self.issue("m1", "1-10", "ctw", "source questions missing", "The question and answer DOCX explicitly state that M1 questions 1-10 are missing from the source PDF")
        for module, module_start, module_end in module_ranges(self.blocks):
            ctw = section_slice(self.blocks, module_start, module_end, CTW_HEADING)
            rdl = section_slice(self.blocks, module_start, module_end, RDL_HEADING)
            rap = section_slice(self.blocks, module_start, module_end, RAP_HEADING)
            if ctw:
                self.parse_ctw(module, *ctw)
            if rdl:
                self.parse_rdl(module, *rdl)
            if rap:
                self.parse_rap(module, *rap)
        materials = [self.material_package(material_id) for material_id in sorted(self.material_ids)]
        scored_items = sum(len(question["payload"]["slots"]) if question["questionType"] == "ctw" else 1 for question in self.questions)
        return {
            "schemaVersion": 1,
            "set": {
                "setId": self.set_id,
                "title": f"TOEFL Reading {self.label}",
                "source": self.label,
                "sourceDate": self.date,
                "yearMonth": self.year_month,
                "questionCount": len(self.questions),
                "scoredItemCount": scored_items,
                "sourceQuestionFile": self.archived_question_file,
                "sourceAnswerFile": self.archived_answer_file,
                "isActive": False,
            },
            "materials": materials,
            "passages": self.passages,
            "questions": self.questions,
        }

    def material_package(self, material_id: str) -> dict[str, Any]:
        material = self.material_by_id[material_id]
        manifest = self.manifest_by_id[material_id]
        first_seen = str(material.get("first_seen") or self.label)
        first_seen_date, first_seen_month, _ = source_date(first_seen)
        return {
            "materialId": material_id,
            "title": self.material_titles[material_id],
            "source": f"material-index.json#{material_id}",
            "sourceDate": first_seen_date,
            "yearMonth": first_seen_month,
            "bindingStatus": "bound",
            "imageAssetPath": manifest["imageRuntimePath"],
            "hitboxDataPath": manifest["selectionMapRuntimePath"],
        }


def build_material_catalog(
    index_path: Path,
    project_root: Path,
    copy_assets: bool,
) -> tuple[dict[str, dict[str, Any]], dict[str, list[tuple[dict[str, Any], dict[str, Any]]]], dict[str, dict[str, Any]], dict[str, Any]]:
    index = json.loads(index_path.read_text(encoding="utf-8"))
    source_project = index_path.parent.parent
    materials = {str(material["asset_id"]): material for material in index["materials"]}
    occurrences: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    manifest_materials: list[dict[str, Any]] = []
    manifest_by_id: dict[str, dict[str, Any]] = {}
    for material_id, material in sorted(materials.items()):
        for occurrence in material["occurrences"]:
            occurrences.setdefault(str(occurrence["set"]), []).append((material, occurrence))
        source_image = source_project / str(material["material_final"])
        source_map = source_project / str(material["selection_map"])
        if not source_image.is_file() or not source_map.is_file():
            raise AdapterIssue(f"canonical asset missing for {material_id}")
        runtime_dir = project_root / "public" / "reading" / "rdl" / material_id.lower()
        runtime_image = runtime_dir / "material_final.png"
        runtime_map = runtime_dir / "selection_map.json"
        source_image_hash = sha256(source_image)
        source_map_hash = sha256(source_map)
        if copy_assets:
            if safe_copy(source_image, runtime_image) != source_image_hash:
                raise AdapterIssue(f"image checksum copy failure for {material_id}")
            if safe_copy(source_map, runtime_map) != source_map_hash:
                raise AdapterIssue(f"selection checksum copy failure for {material_id}")
        selection = json.loads(source_map.read_text(encoding="utf-8"))
        with Image.open(source_image) as image:
            width, height = image.size
        selection_image_hash_matches_canonical = (
            not selection.get("image_sha256") or selection["image_sha256"] == source_image_hash
        )
        entry = {
            "materialId": material_id,
            "slug": material.get("slug"),
            "firstSeen": material.get("first_seen"),
            "firstSeenDate": source_date(str(material["first_seen"]))[0],
            "imageRuntimePath": f"/reading/rdl/{material_id.lower()}/material_final.png",
            "selectionMapRuntimePath": f"/reading/rdl/{material_id.lower()}/selection_map.json",
            "canonicalSourceIdentity": {
                "materialIndexAssetId": material_id,
                "materialIndexImagePath": material["material_final"],
                "materialIndexSelectionMapPath": material["selection_map"],
                "canonicalSource": material.get("canonical_source"),
                "provenance": material.get("provenance"),
            },
            "width": width,
            "height": height,
            "imageSha256": source_image_hash,
            "selectionMapSha256": source_map_hash,
            "imageCopyVerified": copy_assets and sha256(runtime_image) == source_image_hash,
            "selectionMapCopyVerified": copy_assets and sha256(runtime_map) == source_map_hash,
            "selectionMetadata": {
                "schemaVersion": selection.get("schema_version"),
                "imageFile": selection.get("image_file"),
                "imageSha256": selection.get("image_sha256"),
                "imageSha256MatchesCanonical": selection_image_hash_matches_canonical,
                "coordinateSpace": selection.get("coordinate_space"),
                "counts": selection.get("counts"),
            },
            "occurrences": [
                {
                    "occurrenceId": occurrence.get("occurrence_id"),
                    "set": occurrence.get("set"),
                    "sourceDate": source_date(str(occurrence.get("set")))[0],
                    "sourceFile": occurrence.get("source_file"),
                    "questionRange": occurrence.get("question_range"),
                    "rdlType": occurrence.get("rdl_type"),
                }
                for occurrence in material["occurrences"]
            ],
        }
        manifest_materials.append(entry)
        manifest_by_id[material_id] = entry
    manifest = {
        "schemaVersion": 1,
        "sourceIndex": "rdl-image-hitbox-prototype/data/material-index.json",
        "sourceIndexSha256": sha256(index_path),
        "sourceIndexSchemaVersion": index.get("schema_version"),
        "materialCount": len(manifest_materials),
        "materials": manifest_materials,
    }
    return materials, occurrences, manifest_by_id, manifest


def matching_pairs(question_dir: Path, answer_dir: Path) -> list[tuple[Path, Path]]:
    question_files = {parse_source_label(path): path for path in question_dir.glob("*.docx")}
    answer_files = {parse_source_label(path): path for path in answer_dir.glob("*.docx")}
    if set(question_files) != set(answer_files):
        missing_answers = sorted(set(question_files) - set(answer_files))
        missing_questions = sorted(set(answer_files) - set(question_files))
        raise AdapterIssue(f"DOCX pairing mismatch: missing answers={missing_answers}, missing questions={missing_questions}")
    return [(question_files[label], answer_files[label]) for label in sorted(question_files, key=source_label_sort_key)]


def source_label_sort_key(label: str) -> tuple[int, int, str]:
    match = re.fullmatch(r"(\d+)\.(\d+)([A-Z]?)", label)
    if not match:
        return 99, 99, label
    return int(match.group(1)), int(match.group(2)), match.group(3)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def month_summary(packages: Iterable[dict[str, Any]]) -> dict[str, Any]:
    packages = list(packages)
    type_counts = Counter(
        question["questionType"] for package in packages for question in package["questions"]
    )
    return {
        "setCount": len(packages),
        "questionRowCount": sum(len(package["questions"]) for package in packages),
        "scoredItemCount": sum(package["set"]["scoredItemCount"] for package in packages),
        "typeCounts": dict(sorted(type_counts.items())),
        "ctwSlotCount": sum(
            len(question["payload"]["slots"])
            for package in packages for question in package["questions"]
            if question["questionType"] == "ctw"
        ),
    }


def compact_qa_report(
    packages_by_month: dict[str, list[dict[str, Any]]],
    unresolved: list[dict[str, Any]],
) -> dict[str, Any]:
    packages = [package for month in sorted(packages_by_month) for package in packages_by_month[month]]
    by_label = {package["set"]["source"]: package for package in packages}

    def selected_questions(labels: list[str], question_type: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        selected: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for label in labels:
            package = by_label[label]
            question = next(item for item in package["questions"] if item["questionType"] == question_type)
            selected.append((package, question))
        return selected

    ctw_samples = []
    for package, question in selected_questions(["5.3A", "5.18B", "6.30A"], "ctw"):
        slot = question["payload"]["slots"][0]
        paragraph = question["payload"]["paragraphs"][0]
        ctw_samples.append({
            "set": package["set"]["source"],
            "questionFile": package["set"]["sourceQuestionFile"],
            "answerFile": package["set"]["sourceAnswerFile"],
            "sourceQuestionNumber": slot["sourceQuestionNumber"],
            "rawExcerpt": paragraph["rawText"][:180],
            "displayText": slot["displayText"],
            "prefix": slot["prefix"],
            "missingText": slot["missingText"],
            "answer": slot["answer"],
        })

    rdl_samples = []
    for package, question in selected_questions(["5.3A", "5.18B", "6.30A"], "rdl"):
        correct = next(option for option in question["payload"]["options"] if option["optionId"] == question["payload"]["correctOptionId"])
        material = next(item for item in package["materials"] if item["materialId"] == question["payload"]["materialId"])
        rdl_samples.append({
            "set": package["set"]["source"],
            "questionId": question["questionId"],
            "stem": question["stem"],
            "optionCount": len(question["payload"]["options"]),
            "correctOptionText": correct["text"],
            "materialId": material["materialId"],
            "imageRuntimePath": material["imageAssetPath"],
            "selectionMapRuntimePath": material["hitboxDataPath"],
        })

    rap_samples = []
    for package, question in selected_questions(["5.3A", "5.18B", "6.30A"], "rap_multiple_choice"):
        passage = next(item for item in package["passages"] if item["passageId"] == question["payload"]["passageId"])
        correct = next(option for option in question["payload"]["options"] if option["optionId"] == question["payload"]["correctOptionId"])
        rap_samples.append({
            "set": package["set"]["source"],
            "passageId": passage["passageId"],
            "passageTitle": passage["title"],
            "paragraphCount": len(passage["paragraphs"]),
            "questionId": question["questionId"],
            "stem": question["stem"],
            "correctOptionText": correct["text"],
        })

    insertion_checks = []
    selection_checks = []
    for package in packages:
        passage_by_id = {passage["passageId"]: passage for passage in package["passages"]}
        for question in package["questions"]:
            if question["questionType"] == "rap_sentence_insertion":
                insertion_checks.append({
                    "questionId": question["questionId"],
                    "anchorCount": len(question["payload"]["anchors"]),
                    "correctAnchorId": question["payload"]["correctAnchorId"],
                })
            elif question["questionType"] == "rap_sentence_selection":
                passage = passage_by_id[question["payload"]["passageId"]]
                paragraph = next(item for item in passage["paragraphs"] if item["paragraphId"] == question["payload"]["targetParagraphId"])
                sentence = next(item for item in paragraph["sentences"] if item["sentenceId"] == question["payload"]["correctSentenceId"])
                selection_checks.append({
                    "questionId": question["questionId"],
                    "targetParagraphId": paragraph["paragraphId"],
                    "correctSentenceId": sentence["sentenceId"],
                    "correctSentenceText": sentence["text"],
                })

    return {
        "schemaVersion": 1,
        "ctwSamples": ctw_samples,
        "rdlSamples": rdl_samples,
        "rapMultipleChoiceSamples": rap_samples,
        "allInsertionChecks": insertion_checks,
        "allSentenceSelectionChecks": selection_checks,
        "unresolvedCount": len(unresolved),
    }


def split_source_package(package: dict[str, Any]) -> dict[str, Any]:
    set_data = package["set"]
    material_by_id = {material["materialId"]: material for material in package["materials"]}
    passage_by_id = {passage["passageId"]: passage for passage in package["passages"]}
    groups: list[tuple[str, str | None, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]] = []

    for question in package["questions"]:
        if question["questionType"] == "ctw":
            groups.append(("ctw", None, [], [], [question]))

    rdl_groups: dict[str, list[dict[str, Any]]] = {}
    for question in package["questions"]:
        if question["questionType"] == "rdl":
            rdl_groups.setdefault(question["payload"]["materialId"], []).append(question)
    for material_id, questions in rdl_groups.items():
        material = material_by_id[material_id]
        groups.append(("rdl", material["title"], [material], [], questions))

    rap_groups: dict[str, list[dict[str, Any]]] = {}
    for question in package["questions"]:
        if question["questionType"].startswith("rap_"):
            rap_groups.setdefault(question["payload"]["passageId"], []).append(question)
    for passage_id, questions in rap_groups.items():
        passage = passage_by_id[passage_id]
        groups.append(("rap", passage["title"], [], [passage], questions))

    occurrences = []
    for module, title, materials, passages, questions in sorted(
        groups, key=lambda item: min(question["questionOrder"] for question in item[4])
    ):
        ordered_questions = sorted(questions, key=lambda question: question["questionOrder"])
        source_order = min(question["questionOrder"] for question in ordered_questions)
        source_module = ordered_questions[0]["testModule"]
        if any(question["testModule"] != source_module for question in ordered_questions):
            raise AdapterIssue(f"logical source occurrence spans M1/M2 in {set_data['source']}")
        source_start = min(question["sourceQuestionStart"] for question in ordered_questions)
        source_end = max(question["sourceQuestionEnd"] for question in ordered_questions)
        source_questions = []
        for local_order, question in enumerate(ordered_questions, 1):
            source_question = copy.deepcopy(question)
            source_question.pop("setId", None)
            source_question.pop("testModule", None)
            source_question["questionOrder"] = local_order
            source_questions.append(source_question)
        label_slug = re.sub(r"[^a-z0-9]+", "-", str(set_data["source"]).lower()).strip("-")
        occurrences.append({
            "sourceOccurrenceId": f"reading-source-{label_slug}-{source_module}-{module}-{source_order:02d}",
            "module": module,
            "title": title,
            "source": {
                "sourceKind": "docx",
                "sourceLabel": set_data["source"],
                "occurrenceDate": set_data["sourceDate"],
                "yearMonth": set_data["yearMonth"],
                "sourceQuestionFile": set_data["sourceQuestionFile"],
                "sourceAnswerFile": set_data["sourceAnswerFile"],
                "sourceModule": source_module,
                "sourceOrder": source_order,
                "sourceQuestionStart": source_start,
                "sourceQuestionEnd": source_end,
            },
            "materials": copy.deepcopy(materials),
            "passages": [
                {
                    "passageId": passage["passageId"],
                    "title": passage["title"],
                    "paragraphs": copy.deepcopy(passage["paragraphs"]),
                }
                for passage in passages
            ],
            "questions": source_questions,
        })
    return {
        "schemaVersion": 1,
        "sourceKind": "docx",
        "sourceLabel": set_data["source"],
        "occurrences": occurrences,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert authoritative TPS Reading DOCX sources to ReadingImportPackage JSON.")
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--may-questions", required=True, type=Path)
    parser.add_argument("--may-answers", required=True, type=Path)
    parser.add_argument("--june-questions", required=True, type=Path)
    parser.add_argument("--june-answers", required=True, type=Path)
    parser.add_argument("--material-index", required=True, type=Path)
    parser.add_argument("--no-copy", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    material_by_id, occurrences_by_set, manifest_by_id, manifest = build_material_catalog(
        args.material_index.resolve(), project_root, not args.no_copy
    )
    unresolved: list[dict[str, Any]] = []
    source_documents: list[dict[str, Any]] = []
    packages_by_month: dict[str, list[dict[str, Any]]] = {"2026-05": [], "2026-06": []}

    month_inputs = [
        ("2026-05", args.may_questions.resolve(), args.may_answers.resolve()),
        ("2026-06", args.june_questions.resolve(), args.june_answers.resolve()),
    ]
    for year_month, question_dir, answer_dir in month_inputs:
        for question_file, answer_file in matching_pairs(question_dir, answer_dir):
            label = parse_source_label(question_file)
            question_target = project_root / "data" / "reading" / "source-docx" / year_month / "questions" / question_file.name
            answer_target = project_root / "data" / "reading" / "source-docx" / year_month / "answers" / answer_file.name
            if not args.no_copy:
                safe_copy(question_file, question_target)
                safe_copy(answer_file, answer_target)
            question_relative = question_target.relative_to(project_root).as_posix()
            answer_relative = answer_target.relative_to(project_root).as_posix()
            question_hash = sha256(question_file)
            answer_hash = sha256(answer_file)
            source_documents.extend([
                {
                    "set": label,
                    "kind": "question",
                    "archivedPath": question_relative,
                    "sha256": question_hash,
                    "copyVerified": not args.no_copy and sha256(question_target) == question_hash,
                },
                {
                    "set": label,
                    "kind": "answer",
                    "archivedPath": answer_relative,
                    "sha256": answer_hash,
                    "copyVerified": not args.no_copy and sha256(answer_target) == answer_hash,
                },
            ])
            adapter = SetAdapter(
                question_file, answer_file, question_relative, answer_relative,
                material_by_id, occurrences_by_set, manifest_by_id, unresolved,
            )
            try:
                package = adapter.build()
            except AdapterIssue as error:
                adapter.issue(None, None, "set", "set conversion failed", str(error))
                continue
            packages_by_month[year_month].append(package)

    canonical_titles: dict[str, str] = {}
    for package in [item for month in sorted(packages_by_month) for item in packages_by_month[month]]:
        for material in package["materials"]:
            canonical_titles.setdefault(material["materialId"], material["title"])
    for year_month, packages in packages_by_month.items():
        for package in packages:
            for material in package["materials"]:
                material["title"] = canonical_titles[material["materialId"]]
            output = project_root / "data" / "reading" / "source-packages" / year_month / f"{package['set']['setId']}.json"
            write_json(output, split_source_package(package))

    used_material_ids = {
        material["materialId"]
        for packages in packages_by_month.values()
        for package in packages
        for material in package["materials"]
    }
    for material in manifest["materials"]:
        material["title"] = canonical_titles.get(material["materialId"])
    manifest["usedMaterialCount"] = len(used_material_ids)
    manifest["materials"] = [item for item in manifest["materials"] if item["materialId"] in used_material_ids]
    manifest["materialCount"] = len(manifest["materials"])
    write_json(project_root / "data" / "reading" / "manifests" / "rdl-materials.json", manifest)
    write_json(project_root / "data" / "reading" / "manifests" / "source-documents.json", {
        "schemaVersion": 1,
        "documentCount": len(source_documents),
        "documents": source_documents,
    })
    write_json(project_root / "data" / "reading" / "reports" / "reading-import-unresolved.json", unresolved)
    write_json(
        project_root / "data" / "reading" / "reports" / "reading-import-qa.json",
        compact_qa_report(packages_by_month, unresolved),
    )

    summary = {
        "schemaVersion": 1,
        "months": {month: month_summary(packages) for month, packages in packages_by_month.items()},
        "total": month_summary(package for packages in packages_by_month.values() for package in packages),
        "rdlMaterialCount": len(used_material_ids),
        "unresolvedCount": len(unresolved),
        "packages": [
            {
                "setId": package["set"]["setId"],
                "source": package["set"]["source"],
                "yearMonth": package["set"]["yearMonth"],
                "questionCount": package["set"]["questionCount"],
                "scoredItemCount": package["set"]["scoredItemCount"],
                "path": f"data/reading/source-packages/{package['set']['yearMonth']}/{package['set']['setId']}.json",
            }
            for packages in packages_by_month.values() for package in packages
        ],
    }
    write_json(project_root / "data" / "reading" / "reports" / "reading-import-summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
