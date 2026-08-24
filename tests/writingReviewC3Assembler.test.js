import test from "node:test";
import assert from "node:assert/strict";
import { buildWritingReviewTextUnits } from "../lib/writingReviewTextUnits.ts";
import {
  assembleWritingReviewV22FromC3,
  normalizeC3ContentFeedback,
  writingReviewRawV22FromAssembled
} from "../lib/writingReviewV22Assembler.ts";
import { parseAIReviewRawResultV22ForResponse } from "../lib/writingReviewSchemaV22.ts";
import { applyWritingReviewDiffs } from "../lib/writingReviewRevisionDiff.ts";

const AD_DIMENSIONS = [
  "relevance",
  "elaboration",
  "syntactic_range_and_word_choice",
  "lexical_and_grammatical_control"
];
const EMAIL_DIMENSIONS = [
  "communicative_purpose_and_elaboration",
  "syntactic_range_and_word_choice",
  "social_conventions",
  "lexical_and_grammatical_control"
];

function semantic(dimensions, revisions = [], feedback = []) {
  return {
    official_score: 3,
    score_reason: "文章完成了主要任务，但语言准确性仍需提高。",
    overall_feedback: "建议优先修改影响表达清晰度的问题。",
    dimension_scores: Object.fromEntries(
      dimensions.map((key) => [key, { score: 3, basis: "文章提供了相关信息。" }])
    ),
    unit_revisions: revisions,
    content_feedback: feedback
  };
}

function edit(input) {
  return {
    unit_id: "U01",
    reason: "这是一个需要单独修正的语言问题。",
    issue_type: "grammar",
    severity: "moderate",
    ...input
  };
}

test("C3 preserves readable model-selected edits and their real severities", () => {
  const text = "I am writing to give you some feedbacks.";
  const units = buildWritingReviewTextUnits(text);
  const assembled = assembleWritingReviewV22FromC3({
    taskType: "academic_discussion",
    responseText: text,
    units,
    semantic: semantic(AD_DIMENSIONS, [
      edit({
        original_text: "feedbacks",
        replacement_text: "feedback",
        issue_type: "word_form",
        severity: "minor",
        reason: "feedback 是不可数名词，此处不应使用复数形式。"
      })
    ])
  });
  assert.equal(assembled.language_edits[0].original_text, "feedbacks");
  assert.equal(assembled.language_edits[0].replacement_text, "feedback");
  assert.equal(assembled.language_edits[0].category, "word_form");
  assert.equal(assembled.language_edits[0].severity, "minor");
});

test("C3 keeps independent errors in one unit as separate applicable edits", () => {
  const text = "I suggest to conduct prompt miantenance to reduce the lose.";
  const units = buildWritingReviewTextUnits(text);
  const revisions = [
    edit({
      original_text: "suggest to conduct",
      replacement_text: "suggest conducting",
      reason: "suggest 后应使用动名词形式。"
    }),
    edit({
      original_text: "miantenance",
      replacement_text: "maintenance",
      reason: "maintenance 的拼写有误。",
      issue_type: "spelling",
      severity: "minor"
    }),
    edit({
      original_text: "lose",
      replacement_text: "loss",
      reason: "此处需要名词 loss，而不是动词 lose。",
      issue_type: "word_form"
    })
  ];
  const assembled = assembleWritingReviewV22FromC3({
    taskType: "academic_discussion",
    responseText: text,
    units,
    semantic: semantic(AD_DIMENSIONS, revisions)
  });
  assert.equal(assembled.language_edits.length, 3);
  assert.deepEqual(
    assembled.language_edits.map((item) => item.original_text),
    ["suggest to conduct", "miantenance", "lose"]
  );
  const changes = assembled.language_edits.map((item) => ({
    start: item.start,
    end: item.end,
    originalText: item.original_text,
    replacementText: item.replacement_text
  }));
  assert.equal(
    applyWritingReviewDiffs(text, changes),
    "I suggest conducting prompt maintenance to reduce the loss."
  );
});

test("C3 expands a repeated source only to a unique whole-token phrase", () => {
  const text = "I like coffee. I like tea.";
  const units = buildWritingReviewTextUnits(text);
  const assembled = assembleWritingReviewV22FromC3({
    taskType: "academic_discussion",
    responseText: text,
    units,
    semantic: semantic(AD_DIMENSIONS, [
      edit({
        unit_id: "U02",
        original_text: "like",
        replacement_text: "prefer",
        reason: "此处使用 prefer 更准确。",
        issue_type: "word_choice"
      })
    ])
  });
  const actual = assembled.language_edits[0];
  assert.equal(actual.original_text, "like tea.");
  assert.equal(actual.replacement_text, "prefer tea.");
  assert.equal(text.slice(actual.start, actual.end), actual.original_text);
});

test("C3 localizes a standalone word without confusing letters inside another word", () => {
  const text = "hello teacher i miss meeting.";
  const units = buildWritingReviewTextUnits(text);
  const assembled = assembleWritingReviewV22FromC3({
    taskType: "academic_discussion",
    responseText: text,
    units,
    semantic: semantic(AD_DIMENSIONS, [
      edit({
        original_text: "i",
        replacement_text: "I",
        reason: "第一人称代词 I 必须大写。",
        issue_type: "capitalization",
        severity: "minor"
      })
    ])
  });
  const actual = assembled.language_edits[0];
  assert.equal(actual.original_text, "i");
  assert.equal(actual.replacement_text, "I");
  assert.equal(text.slice(actual.start, actual.end), "i");
});

test("C3 supports a readable deletion without inventing source text", () => {
  const text = "I really enjoyed in the gym.";
  const units = buildWritingReviewTextUnits(text);
  const assembled = assembleWritingReviewV22FromC3({
    taskType: "academic_discussion",
    responseText: text,
    units,
    semantic: semantic(AD_DIMENSIONS, [
      edit({
        original_text: "enjoyed in",
        replacement_text: "enjoyed",
        reason: "enjoy 是及物动词，后面不需要介词 in。"
      })
    ])
  });
  assert.equal(assembled.language_edits[0].original_text, "enjoyed in");
  assert.equal(assembled.language_edits[0].replacement_text, "enjoyed");
});

test("C3 assembly rejects a revision source that is absent from its unit", () => {
  const text = "I agree.";
  const units = buildWritingReviewTextUnits(text);
  assert.throws(
    () =>
      assembleWritingReviewV22FromC3({
        taskType: "academic_discussion",
        responseText: text,
        units,
        semantic: semantic(AD_DIMENSIONS, [
          edit({ original_text: "disagree", replacement_text: "agree" })
        ])
      }),
    (error) => error.code === "C3_ASSEMBLY_INVALID"
  );
});

test("C3 feedback normalization merges duplicate units and preserves the primary revision", () => {
  const value = semantic(AD_DIMENSIONS, [], [
    {
      unit_id: "U01",
      category: "relevance",
      issue: "问题 A",
      suggestion: "建议 A",
      proposed_revision: "Revision A"
    },
    {
      unit_id: "U01",
      category: "elaboration",
      issue: "问题 B",
      suggestion: "建议 B",
      proposed_revision: "Revision B"
    }
  ]);
  const normalized = normalizeC3ContentFeedback(value);
  assert.equal(normalized.content_feedback.length, 1);
  assert.equal(normalized.content_feedback[0].category, "relevance");
  assert.match(normalized.content_feedback[0].issue, /问题 A/);
  assert.match(normalized.content_feedback[0].issue, /问题 B/);
  assert.equal(normalized.content_feedback[0].proposed_revision, "Revision A");
});

test("C3 feedback normalization fails rather than inventing a missing revision", () => {
  assert.throws(
    () =>
      normalizeC3ContentFeedback(
        semantic(AD_DIMENSIONS, [], [
          {
            unit_id: "U01",
            category: "relevance",
            issue: "问题",
            suggestion: "建议"
          }
        ])
      ),
    (error) => error.code === "C3_ASSEMBLY_INVALID"
  );
});

const fixtures = [
  {
    name: "email strong",
    taskType: "email",
    text: "Dear Professor Lee, I apologise. Could we meet at 3:00 p.m.? Sincerely, Jordan",
    dimensions: EMAIL_DIMENSIONS,
    category: "communicative_purpose",
    original: "apologise",
    replacement: "apologize"
  },
  {
    name: "email weak",
    taskType: "email",
    text: "Hello professor I need more time. My project is not finish.",
    dimensions: EMAIL_DIMENSIONS,
    category: "elaboration",
    original: "not finish",
    replacement: "not finished"
  },
  {
    name: "AD strong",
    taskType: "academic_discussion",
    text: "I agree because students need practical financial skills. It helps them avoid debt.",
    dimensions: AD_DIMENSIONS,
    category: "elaboration",
    original: "It helps",
    replacement: "These skills help"
  },
  {
    name: "AD weak",
    taskType: "academic_discussion",
    text: "Money is important. Students need learn it.",
    dimensions: AD_DIMENSIONS,
    category: "relevance",
    original: "need learn",
    replacement: "need to learn"
  }
];

for (const fixture of fixtures) {
  test(`C3 ${fixture.name} assembles and round-trips strict v2.2`, () => {
    const units = buildWritingReviewTextUnits(fixture.text);
    const target = units.find((unit) => unit.text.includes(fixture.original));
    const review = semantic(
      fixture.dimensions,
      [
        edit({
          unit_id: target.unitId,
          original_text: fixture.original,
          replacement_text: fixture.replacement,
          reason: "这是一项可直接应用的局部修改。",
          issue_type: "grammar"
        })
      ],
      [
        {
          unit_id: units[0].unitId,
          category: fixture.category,
          issue: "内容还可以进一步展开。",
          suggestion: "补充一个具体细节。",
          proposed_revision: `${units[0].text} For example, add one detail.`
        }
      ]
    );
    const assembled = assembleWritingReviewV22FromC3({
      taskType: fixture.taskType,
      responseText: fixture.text,
      units,
      semantic: review
    });
    const raw = writingReviewRawV22FromAssembled(assembled);
    const reparsed = parseAIReviewRawResultV22ForResponse(raw, fixture.text);
    assert.equal(reparsed.scores.official_score.ai_score, review.official_score);
    assert.equal(
      reparsed.scores.official_score.rationale,
      review.score_reason
    );
    assert.equal(reparsed.language_edits[0].severity, "moderate");
    assert.equal(
      fixture.text.slice(
        reparsed.language_edits[0].start,
        reparsed.language_edits[0].end
      ),
      reparsed.language_edits[0].original_text
    );
  });
}
