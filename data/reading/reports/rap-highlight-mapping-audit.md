# RAP passage highlight mapping audit

## Scope and safety

- Source: all 47 archived RAP question DOCX files.
- Audited DOCX highlight ranges: 186.
- Database writes: none.
- Reading imports: none.
- Browser use: none.
- Detailed records: `rap-highlight-mapping-audit.csv` and `rap-highlight-mapping-audit.json`.

## Evidence rules

- **HIGH**: the actual DOCX-highlighted text has one unique exact quoted/question-text match in its five-question passage group, or it exactly equals the one authoritative `correctSentenceId` sentence for a sentence-selection question.
- **MEDIUM**: textual evidence exists but is partial or non-unique.
- **LOW**: no reliable unique text evidence, or the DOCX-to-final-text offset cannot be verified.
- Question type alone is never mapping evidence.

Offsets are zero-based, end-exclusive Unicode code-point positions in the final logical paragraph text. Every reported range was verified by slicing that paragraph at the recorded offsets and comparing it with the actual formatted DOCX run text after insertion-marker normalization.

## Summary

| Measure | Count |
| --- | ---: |
| HIGH ranges | 186 |
| MEDIUM ranges | 0 |
| LOW ranges | 0 |
| Source questions receiving ranges | 182 |
| Unique logical questions receiving ranges | 152 |
| Unique logical RAP items receiving ranges | 96 |
| Source passage occurrences containing ranges | 118 |
| Questions with multiple ranges | 4 |
| Ranges whose text repeats in the same passage | 2 |
| Same highlighted text assigned to multiple questions in one passage | 0 |
| Overlapping ranges assigned to different questions | 0 |
| Unmatched ranges | 0 |
| Ranges requiring manual review | 0 |

Evidence breakdown:

- 181 ranges: exact highlighted text equals a unique quoted word or phrase in one question.
- 5 ranges: exact highlighted sentence equals the authoritative sentence-selection answer.

## Multiple-range questions

| Source | Module | Source question | Logical question | Highlighted texts |
| --- | --- | ---: | --- | --- |
| 5.18B | M1 | 34 | `reading-rap-18254e6c2471afbb626c22b4-q04` | `hospitals`; `office spaces` |
| 6.17 | M2 | 14 | `reading-rap-059ab1c8259c00f0242e7951-q04` | `hospitals`; `office spaces` |
| 6.3 | M1 | 29 | `reading-rap-6832cb7ccf74f003a2ef7628-q04` | `hospitals`; `office spaces` |
| 6.7C | M1 | 31 | `reading-rap-c63fb3651607230289cc9a21-q01` | `retention` in paragraph 1; `retention` in paragraph 3 |

## Repeated passage text

The only repeated highlighted text case is 6.7C / M1 / source question 31. The source formats both occurrences of `retention`, and both map to the same logical question:

- `reading-rap-c63fb3651607230289cc9a21-passage-01-p01`, `[466, 475)`
- `reading-rap-c63fb3651607230289cc9a21-passage-01-p03`, `[68, 77)`

The two positions come from distinct DOCX formatting runs and remain distinct after paragraph-ID remapping.

## Sentence-selection evidence

The five ranges without a literal stem quote all exactly match an authoritative `correctSentenceId` sentence:

| Source | Module | Source question | Logical question | Paragraph / range |
| --- | --- | ---: | --- | --- |
| 6.21A | M2 | 12 | `reading-rap-98e3b20d6b6e1d9ce46eac7c-q02` | p02 `[0, 182)` |
| 6.22 | M2 | 14 | `reading-rap-bbe98bba9b4c8463d35912f4-q04` | p02 `[0, 194)` |
| 6.23 | M2 | 11 | `reading-rap-8371c3948e75cac783023b5c-q01` | p01 `[292, 430)` |
| 6.24 | M1 | 31 | `reading-rap-f50dd6e4cd831e6155bb31ac-q01` | p01 `[129, 349)` |
| 6.30B | M1 | 33 | `reading-rap-c0a09dd368b968fd01c859ed-q03` | p02 `[338, 480)` |

## Manual review

No MEDIUM or LOW mappings remain. No question requires manual review under the evidence rules above.
