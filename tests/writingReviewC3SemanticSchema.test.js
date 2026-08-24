import test from "node:test";
import assert from "node:assert/strict";
import { buildWritingReviewTextUnits } from "../lib/writingReviewTextUnits.ts";
import { buildWritingReviewSemanticC3Messages } from "../lib/writingReviewSemanticPrompt.ts";
import {
  parseWritingReviewSemanticC3,
  writingReviewC3JsonSchema,
  WRITING_REVIEW_C3_CONTENT_CATEGORIES,
  WRITING_REVIEW_C3_DIMENSIONS,
  WRITING_REVIEW_C3_LANGUAGE_CATEGORIES,
  WRITING_REVIEW_C3_LANGUAGE_SEVERITIES
} from "../lib/writingReviewSemanticSchema.ts";

const units = buildWritingReviewTextUnits(
  "I really enjoyed in the gym and saw some equipments."
);

function value(taskType = "academic_discussion") {
  const dimensions = WRITING_REVIEW_C3_DIMENSIONS[taskType];
  return {
    official_score: 4,
    score_reason: "回答切题且表达清楚。",
    overall_feedback: "可以再补充一个具体例子。",
    dimension_scores: Object.fromEntries(
      dimensions.map((key) => [key, { score: 4, basis: "文中有明确依据。" }])
    ),
    unit_revisions: [
      {
        unit_id: units[0].unitId,
        original_text: "enjoyed in",
        replacement_text: "enjoyed",
        reason: "enjoy 是及物动词，后面不需要介词 in。",
        issue_type: "grammar",
        severity: "moderate"
      },
      {
        unit_id: units[0].unitId,
        original_text: "equipments",
        replacement_text: "equipment",
        reason: "equipment 通常是不可数名词。",
        issue_type: "word_form",
        severity: "minor"
      }
    ],
    content_feedback: [
      {
        unit_id: units[0].unitId,
        category: WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType][0],
        issue: "论述缺少具体细节。",
        suggestion: "补充一个能支持观点的例子。",
        proposed_revision: "I enjoyed the gym because it had modern equipment."
      }
    ]
  };
}

function rejects(mutator, code = "C3_SCHEMA_INVALID") {
  const item = value();
  mutator(item);
  assert.throws(
    () =>
      parseWritingReviewSemanticC3(
        JSON.stringify(item),
        "academic_discussion",
        units
      ),
    (error) => error.code === code
  );
}

test("task schemas require their dimensions, content categories, and granular language fields", () => {
  for (const taskType of ["email", "academic_discussion"]) {
    const schema = writingReviewC3JsonSchema(taskType);
    assert.deepEqual(
      schema.properties.dimension_scores.required,
      WRITING_REVIEW_C3_DIMENSIONS[taskType]
    );
    assert.deepEqual(
      schema.properties.content_feedback.items.properties.category.enum,
      WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType]
    );
    assert.deepEqual(
      schema.properties.unit_revisions.items.properties.issue_type.enum,
      WRITING_REVIEW_C3_LANGUAGE_CATEGORIES
    );
    assert.deepEqual(
      schema.properties.unit_revisions.items.properties.severity.enum,
      WRITING_REVIEW_C3_LANGUAGE_SEVERITIES
    );
  }
});

test("semantic parser accepts several non-overlapping revisions in one unit", () => {
  const parsed = parseWritingReviewSemanticC3(
    JSON.stringify(value()),
    "academic_discussion",
    units
  );
  assert.equal(parsed.unit_revisions.length, 2);
  assert.equal(parsed.unit_revisions[0].severity, "moderate");
});

test("semantic parser treats a standalone word as distinct from letters inside another word", () => {
  const responseUnits = buildWritingReviewTextUnits(
    "hello teacher i miss meeting."
  );
  const item = value();
  item.unit_revisions = [
    {
      unit_id: responseUnits[0].unitId,
      original_text: "i",
      replacement_text: "I",
      reason: "第一人称代词 I 必须大写。",
      issue_type: "capitalization",
      severity: "minor"
    }
  ];
  const parsed = parseWritingReviewSemanticC3(
    JSON.stringify(item),
    "academic_discussion",
    responseUnits
  );
  assert.equal(parsed.unit_revisions[0].original_text, "i");
});

test("semantic parser accepts strict JSON plus a legal BOM or single fence", () => {
  const json = JSON.stringify(value());
  for (const content of [
    json,
    `\uFEFF ${json} `,
    `\`\`\`json\n${json}\n\`\`\``,
    `\`\`\` ${json} \`\`\``
  ]) {
    assert.equal(
      parseWritingReviewSemanticC3(
        content,
        "academic_discussion",
        units
      ).official_score,
      4
    );
  }
});

test("semantic parser rejects character fragments, boundary whitespace, and overlapping edits", () => {
  rejects(
    (item) => {
      item.unit_revisions[0].original_text = "d in";
    },
    "C3_UNIT_VALIDATION_FAILED"
  );
  rejects(
    (item) => {
      item.unit_revisions[0].original_text = " enjoyed in";
    },
    "C3_UNIT_VALIDATION_FAILED"
  );
  rejects(
    (item) => {
      item.unit_revisions[1].original_text = "in the gym and saw some equipments";
    },
    "C3_UNIT_VALIDATION_FAILED"
  );
  rejects(
    (item) => {
      item.unit_revisions[0].replacement_text = ", enjoyed";
    },
    "C3_UNIT_VALIDATION_FAILED"
  );
  rejects(
    (item) => {
      item.unit_revisions[0].replacement_text = "enjoyed ";
    },
    "C3_UNIT_VALIDATION_FAILED"
  );
});

test("semantic parser rejects English-only explanatory feedback", () => {
  rejects((item) => {
    item.score_reason = "Clear response.";
  });
  rejects((item) => {
    item.unit_revisions[0].reason = "Remove the preposition.";
  });
  rejects((item) => {
    item.content_feedback[0].suggestion = "Add one example.";
  });
});

test("semantic parser rejects dimensions, categories, scores, and top-level drift", () => {
  rejects((item) => delete item.dimension_scores.relevance);
  rejects((item) => (item.dimension_scores.extra = { score: 4, basis: "有依据。" }));
  rejects((item) => (item.dimension_scores.relevance.score = 6));
  rejects((item) => (item.content_feedback[0].category = "language_improvement"));
  rejects((item) => (item.extra = true));
});

test("score contract is enforced before assembly for Email and AD", () => {
  for (const taskType of ["email", "academic_discussion"]) {
    const validZero = value(taskType);
    validZero.official_score = 0;
    for (const item of Object.values(validZero.dimension_scores)) item.score = 0;
    assert.equal(
      parseWritingReviewSemanticC3(
        JSON.stringify(validZero),
        taskType,
        units
      ).official_score,
      0
    );
    const invalidZero = structuredClone(validZero);
    invalidZero.dimension_scores[
      WRITING_REVIEW_C3_DIMENSIONS[taskType][0]
    ].score = 1;
    assert.throws(
      () =>
        parseWritingReviewSemanticC3(
          JSON.stringify(invalidZero),
          taskType,
          units
        ),
      (error) => error.code === "C3_SCORE_CONTRACT_INVALID"
    );
  }
});

test("prompt shares schema constants and states readability, severity, Chinese, and content precedence rules", () => {
  for (const taskType of ["email", "academic_discussion"]) {
    const prompt = buildWritingReviewSemanticC3Messages({
      taskType,
      question: {},
      anchoredResponse: "⟦TPS_UNIT:U01⟧Text"
    })[0].content;
    for (const key of WRITING_REVIEW_C3_DIMENSIONS[taskType]) {
      assert.match(prompt, new RegExp(key));
    }
    for (const key of WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType]) {
      assert.match(prompt, new RegExp(key));
    }
    assert.match(prompt, /Anchor handling rules/);
    assert.match(prompt, /character fragment/);
    assert.match(prompt, /Simplified Chinese/);
    assert.match(prompt, /same unit_id may appear in several items/);
    assert.match(prompt, /proposed_revision must preserve those language corrections/);
  }
});
