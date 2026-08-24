const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildManualWritingReviewDraft,
  buildReviewedText,
  buildWritingReviewPublishUpdate,
  buildWritingReviewSaveUpdate,
  normalizeWritingReviewWorkingDraft
} = require("../lib/writingReviewWorkspace.ts");
const {
  assertWritingReviewTeacher,
  loadWritingReviewWorkspace,
  saveWritingReviewWorkspace
} = require("../lib/writingReviewWorkspaceServer.ts");

const responseText = "I am write to school.";

function languageEdit(overrides = {}) {
  return {
    edit_id: "edit-1",
    start: 2,
    end: 10,
    original_text: "am write",
    replacement_text: "am writing",
    category: "grammar",
    severity: "moderate",
    explanation: "Use the correct verb form.",
    ...overrides
  };
}

function score(overrides = {}) {
  return {
    rubric_score: 3,
    rationale: "The response is understandable but has a noticeable error.",
    ...overrides
  };
}

function emailAnalysis() {
  return {
    communicative_purpose_and_elaboration: "The request is clear.",
    syntax_and_word_choice: "The range is adequate.",
    social_conventions: "The tone is suitable.",
    lexical_and_grammatical_control: "One error affects fluency."
  };
}

function discussionAnalysis() {
  return {
    relevance_and_elaboration: "The response is relevant.",
    syntax_and_word_choice: "The range is adequate.",
    lexical_and_grammatical_control: "Language is controlled."
  };
}

function feedbackItem(overrides = {}) {
  return {
    feedback_id: "feedback-1",
    category: "elaboration",
    issue: "The reason needs more detail.",
    suggestion: "Add one supporting detail.",
    example: "For example, explain why the request matters.",
    ...overrides
  };
}

function contentFeedback(overrides = {}) {
  return {
    rubric_analysis: emailAnalysis(),
    items: [feedbackItem()],
    overall_feedback: "A clear response that needs more development.",
    ...overrides
  };
}

function normalize(overrides = {}) {
  return normalizeWritingReviewWorkingDraft({
    taskType: "email",
    responseText,
    languageEdits: [languageEdit()],
    scores: score(),
    contentFeedback: contentFeedback(),
    teacherComment: "Keep developing your reason.",
    ...overrides
  });
}

test("legacy working data receives restored=false and included=true", () => {
  const draft = normalize();
  assert.equal(draft.language_edits[0].restored, false);
  assert.equal(draft.language_edits[0].source, "ai");
  assert.equal(draft.content_feedback.items[0].included, true);
  assert.equal(draft.content_feedback.items[0].source, "ai");
  assert.equal("original_sentence" in draft.content_feedback.items[0], false);
  assert.equal(draft.scores.official_score.ai_score, 3);
  assert.equal(draft.scores.official_score.teacher_score, 3);
  assert.equal(draft.scores.dimension_scores, null);
});

test("legacy working review can save newly added teacher feedback", () => {
  const selectedStart = responseText.indexOf("write");
  const draft = normalize({
    contentFeedback: contentFeedback({
      items: [
        feedbackItem(),
        {
          feedback_id: "teacher-feedback",
          source: "teacher",
          start: selectedStart,
          end: selectedStart + "write".length,
          original_sentence: "write",
          category: "elaboration",
          issue: "说明具体目的。",
          suggestion: "",
          proposed_revision: "",
          included: true
        }
      ]
    })
  });
  assert.equal(draft.content_feedback.items[1].source, "teacher");
  assert.equal(
    buildWritingReviewSaveUpdate(draft).content_feedback.items[1].original_sentence,
    "write"
  );
});

test("teacher replacement edits rebuild the article from response_text and offsets", () => {
  const draft = normalize({
    languageEdits: [languageEdit({ replacement_text: "am emailing" })]
  });
  assert.equal(buildReviewedText(responseText, draft.language_edits), "I am emailing to school.");
  assert.equal(responseText, "I am write to school.");
});

test("restored=true shows original text and restored=false reapplies the edit", () => {
  const restored = normalize({ languageEdits: [languageEdit({ restored: true })] });
  assert.equal(buildReviewedText(responseText, restored.language_edits), responseText);
  const reapplied = normalize({ languageEdits: [languageEdit({ restored: false })] });
  assert.equal(buildReviewedText(responseText, reapplied.language_edits), "I am writing to school.");
});

test("v1 rubric_score compatibility converts to official scores", () => {
  for (let rubricScore = 0; rubricScore <= 5; rubricScore += 1) {
    const scores = normalize({ scores: score({ rubric_score: rubricScore }) }).scores;
    assert.equal(scores.official_score.ai_score, rubricScore);
    assert.equal(scores.official_score.teacher_score, rubricScore);
    assert.equal(scores.dimension_scores, null);
  }
  assert.throws(() => normalize({ scores: score({ rubric_score: 6 }) }), /rubric_score/);
  assert.throws(() => normalize({ scores: score({ rubric_score: 2.5 }) }), /rubric_score/);
});

test("v2 working data validates and preserves independently edited teacher scores", () => {
  const sentence = responseText;
  const draft = normalizeWritingReviewWorkingDraft({
    taskType: "email",
    responseText,
    languageEdits: [languageEdit({ restored: false })],
    scores: {
      official_score: {
        ai_score: 4,
        teacher_score: 3,
        rationale: "The message is generally successful."
      },
      dimension_scores: {
        communicative_purpose_and_elaboration: {
          ai_score: 4,
          teacher_score: 4,
          ai_basis: "The purpose is clear."
        },
        syntactic_range_and_word_choice: {
          ai_score: 3,
          teacher_score: 2,
          ai_basis: "The language range is limited."
        },
        social_conventions: {
          ai_score: 4,
          teacher_score: 5,
          ai_basis: "The tone is appropriate."
        },
        lexical_and_grammatical_control: {
          ai_score: 3,
          teacher_score: 3,
          ai_basis: "A verb-form error is noticeable."
        }
      }
    },
    contentFeedback: {
      items: [
        {
          feedback_id: "feedback-v2",
          start: 0,
          end: sentence.length,
          original_sentence: sentence,
          category: "elaboration",
          issue: "The request needs a more specific reason.",
          suggestion: "Add one concrete supporting detail.",
          example: "I need more time because I was ill for two days.",
          included: true
        }
      ],
      overall_feedback: "A clear request that needs more development."
    },
    teacherComment: ""
  });

  assert.equal(draft.scores.official_score.ai_score, 4);
  assert.equal(draft.scores.official_score.teacher_score, 3);
  assert.equal(
    draft.scores.dimension_scores.syntactic_range_and_word_choice.teacher_score,
    2
  );
  assert.equal(draft.content_feedback.items[0].start, 0);
  const update = buildWritingReviewSaveUpdate(draft);
  assert.equal("rubric_analysis" in update.content_feedback, false);
});

test("v2.1 working data saves and publishes proposed revision without changing legacy v2", () => {
  const sentence = responseText;
  const base = {
    taskType: "email",
    responseText,
    languageEdits: [languageEdit({ restored: false })],
    scores: {
      official_score: { ai_score: 4, teacher_score: 4, rationale: "整体较好。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: { ai_score: 4, teacher_score: 4, ai_basis: "目的清楚。" },
        syntactic_range_and_word_choice: { ai_score: 3, teacher_score: 3, ai_basis: "用词有限。" },
        social_conventions: { ai_score: 4, teacher_score: 4, ai_basis: "语气合适。" },
        lexical_and_grammatical_control: { ai_score: 3, teacher_score: 3, ai_basis: "有语法错误。" }
      }
    },
    contentFeedback: {
      items: [{
        feedback_id: "feedback-v21", start: 0, end: sentence.length,
        original_sentence: sentence, category: "language_improvement",
        issue: "表达不够自然。", suggestion: "改用更直接的表达。",
        example: "I am writing to the school.",
        proposed_revision: "I am writing to the school today.", included: true
      }],
      overall_feedback: "表达需要提升。"
    },
    teacherComment: ""
  };
  const draft = normalizeWritingReviewWorkingDraft(base);
  assert.equal(draft.content_feedback.items[0].proposed_revision, "I am writing to the school today.");
  const saved = buildWritingReviewSaveUpdate(draft);
  assert.equal(saved.content_feedback.items[0].proposed_revision, "I am writing to the school today.");
  const published = buildWritingReviewPublishUpdate(draft, "2026-08-13T10:00:00.000Z");
  assert.equal(published.published_content_feedback.items[0].proposed_revision, "I am writing to the school today.");
});

test("v2.2 working data saves without manufacturing the removed example field", () => {
  const dimension = { ai_score: 4, teacher_score: 4, ai_basis: "具体依据。" };
  const input = {
    taskType: "email",
    responseText,
    languageEdits: [languageEdit({ restored: false })],
    scores: {
      official_score: { ai_score: 4, teacher_score: 4, rationale: "整体较好。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension,
        syntactic_range_and_word_choice: dimension,
        social_conventions: dimension,
        lexical_and_grammatical_control: dimension
      }
    },
    contentFeedback: {
      items: [{
        feedback_id: "feedback-v22",
        start: 0,
        end: responseText.length,
        original_sentence: responseText,
        category: "elaboration",
        issue: "展开不足。",
        suggestion: "补充直接支持请求的具体原因。",
        proposed_revision: "I am writing to explain my request in more detail.",
        included: true
      }],
      overall_feedback: "表达清楚，但需要补充细节。"
    },
    teacherComment: ""
  };
  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.equal("example" in draft.content_feedback.items[0], false);
  const saved = buildWritingReviewSaveUpdate(draft);
  assert.equal("example" in saved.content_feedback.items[0], false);
});

test("persisted pre-v5 character spans remain openable only through stored exact offsets", () => {
  const historicalResponse = "feedbacks are useful.";
  const input = emailV22Input();
  input.responseText = historicalResponse;
  input.languageEdits = [
    languageEdit({
      start: 7,
      end: 9,
      original_text: "ks",
      replacement_text: "k",
      restored: false
    })
  ];
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = historicalResponse.length;
  input.contentFeedback.items[0].original_sentence = historicalResponse;
  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.equal(draft.language_edits[0].original_text, "ks");
  assert.equal(draft.language_edits[0].start, 7);

  input.languageEdits[0].start = 6;
  assert.throws(
    () => normalizeWritingReviewWorkingDraft(input),
    /offset 无效/
  );
});

test("C3 working drafts keep anchored offsets when the same edit text appears elsewhere", () => {
  const repeatedResponse = "I like the room. I like the service.";
  const secondLike = repeatedResponse.lastIndexOf("like");
  const input = emailV22Input();
  input.responseText = repeatedResponse;
  input.languageEdits = [
    languageEdit({
      edit_id: "c3-second-like",
      start: secondLike,
      end: secondLike + "like".length,
      original_text: "like",
      replacement_text: "appreciate",
      restored: false
    })
  ];
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = repeatedResponse.length;
  input.contentFeedback.items[0].original_sentence = repeatedResponse;

  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.equal(draft.language_edits[0].start, secondLike);
  assert.equal(draft.language_edits[0].end, secondLike + "like".length);
  assert.equal(
    repeatedResponse.slice(
      draft.language_edits[0].start,
      draft.language_edits[0].end
    ),
    "like"
  );
});

test("workspace reload accepts a saved C3 anchored edit without global relocalization", async () => {
  const repeatedResponse = "I like the room. I like the service.";
  const secondLike = repeatedResponse.lastIndexOf("like");
  const input = emailV22Input();
  input.responseText = repeatedResponse;
  input.languageEdits = [
    languageEdit({
      edit_id: "c3-saved-second-like",
      start: secondLike,
      end: secondLike + "like".length,
      original_text: "like",
      replacement_text: "appreciate",
      restored: false
    })
  ];
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = repeatedResponse.length;
  input.contentFeedback.items[0].original_sentence = repeatedResponse;
  const storedDraft = normalizeWritingReviewWorkingDraft(input);
  const supabase = workspaceSupabase({
    attempt: { ...attemptRow(), response_text: repeatedResponse },
    review: reviewRow(buildWritingReviewSaveUpdate(storedDraft))
  });

  const workspace = await loadWritingReviewWorkspace(supabase, "attempt-1");
  assert.equal(workspace.review.language_edits[0].start, secondLike);
  assert.equal(workspace.review.language_edits[0].original_text, "like");
});

test("workspace reload repairs combined explanations on persisted C3 split parts", () => {
  const splitResponse = "The internet equipment is stable.";
  const equipmentStart = splitResponse.indexOf("equipment");
  const isStart = splitResponse.indexOf("is", equipmentStart);
  const combinedReason =
    "叙述入住经历应用过去时 was，且网络稳定通常用 connection 而非 equipment。";
  const input = emailV22Input();
  input.responseText = splitResponse;
  input.languageEdits = [
    languageEdit({
      edit_id: "c3-edit-01-part-01",
      start: equipmentStart,
      end: equipmentStart + "equipment".length,
      original_text: "equipment",
      replacement_text: "connection",
      explanation: combinedReason,
      restored: false
    }),
    languageEdit({
      edit_id: "c3-edit-01-part-02",
      start: isStart,
      end: isStart + "is".length,
      original_text: "is",
      replacement_text: "was",
      explanation: combinedReason,
      restored: false
    })
  ];
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = splitResponse.length;
  input.contentFeedback.items[0].original_sentence = splitResponse;

  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.deepEqual(
    draft.language_edits.map((item) => item.explanation),
    [
      "网络稳定通常用 connection 而非 equipment。",
      "叙述入住经历应用过去时 was。"
    ]
  );
  assert.deepEqual(
    draft.language_edits.map((item) => item.category),
    ["word_choice", "grammar"]
  );
});

test("workspace reload keeps persisted mixed-error split metadata internally consistent", () => {
  const response = "This will cause air polution for the enviroment.";
  const combinedReason =
    "pollution和environment均拼写错误，且pollution与environment搭配应用介词in。";
  const corrections = [
    ["polution", "pollution"],
    ["for", "in"],
    ["enviroment", "environment"]
  ];
  const input = emailV22Input();
  input.responseText = response;
  input.languageEdits = corrections.map(([original, replacement], index) => {
    const start = response.indexOf(original);
    return languageEdit({
      edit_id: `c3-edit-08-part-0${index + 1}`,
      start,
      end: start + original.length,
      original_text: original,
      replacement_text: replacement,
      explanation: combinedReason,
      category: "spelling",
      severity: "minor",
      restored: false
    });
  });
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = response.length;
  input.contentFeedback.items[0].original_sentence = response;

  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.deepEqual(
    draft.language_edits.map((item) => [
      item.original_text,
      item.replacement_text,
      item.category,
      item.explanation
    ]),
    [
      ["polution", "pollution", "spelling", "polution 拼写错误，应改为 pollution。"],
      ["for", "in", "usage", "for 此处介词用法不正确，应改为 in。"],
      ["enviroment", "environment", "spelling", "enviroment 拼写错误，应改为 environment。"]
    ]
  );
});

test("workspace reload splits a persisted C3 revision while preserving a reordered rewrite", () => {
  const response =
    "I suggest to conduct prompt miantenance. We recieved a pasta instead that we ordered a salad.";
  const firstOriginal = "to conduct prompt miantenance";
  const secondOriginal = "recieved a pasta instead that we ordered a salad";
  const input = emailV22Input();
  input.responseText = response;
  input.languageEdits = [
    languageEdit({
      edit_id: "c3-edit-01",
      start: response.indexOf(firstOriginal),
      end: response.indexOf(firstOriginal) + firstOriginal.length,
      original_text: firstOriginal,
      replacement_text: "conducting prompt maintenance",
      explanation: "suggest 后应接动名词 conducting，且 maintenance 拼写错误。",
      category: "grammar",
      severity: "moderate",
      restored: false
    }),
    languageEdit({
      edit_id: "c3-edit-02",
      start: response.indexOf(secondOriginal),
      end: response.indexOf(secondOriginal) + secondOriginal.length,
      original_text: secondOriginal,
      replacement_text: "received pasta instead of the salad we ordered",
      explanation: "recieved 拼写错误，且 instead 后应使用 of。",
      category: "grammar",
      severity: "moderate",
      restored: false
    })
  ];
  input.contentFeedback.items[0].start = 0;
  input.contentFeedback.items[0].end = response.length;
  input.contentFeedback.items[0].original_sentence = response;

  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.deepEqual(
    draft.language_edits.map((item) => [
      item.edit_id,
      item.original_text,
      item.replacement_text,
      item.category,
      item.explanation
    ]),
    [
      [
        "c3-edit-01-part-01",
        "to conduct",
        "conducting",
        "grammar",
        "suggest 后应接动名词 conducting。"
      ],
      [
        "c3-edit-01-part-02",
        "miantenance",
        "maintenance",
        "spelling",
        "miantenance 拼写错误，应改为 maintenance。"
      ],
      [
        "c3-edit-02",
        secondOriginal,
        "received pasta instead of the salad we ordered",
        "grammar",
        "recieved 拼写错误，且 instead 后应使用 of。"
      ]
    ]
  );
});

test("score references are optional in working Save and Publish snapshots", () => {
  const input = emailV22Input();
  input.scores.official_score.rationale = "";
  Object.values(input.scores.dimension_scores).forEach((dimension) => {
    dimension.ai_basis = "";
  });
  const draft = normalizeWritingReviewWorkingDraft(input);
  const saved = buildWritingReviewSaveUpdate(draft);
  assert.equal(saved.scores.official_score.rationale, "");
  assert.equal(
    saved.scores.dimension_scores.social_conventions.ai_basis,
    ""
  );
  const published = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-16T10:00:00.000Z"
  );
  assert.equal(published.published_scores.official_score.rationale, "");
  assert.equal(
    published.published_scores.dimension_scores.social_conventions.ai_basis,
    ""
  );
});

test("manual-only review accepts every score reference left blank", () => {
  const manual = buildManualWritingReviewDraft("email");
  const draft = normalizeWritingReviewWorkingDraft({
    taskType: "email",
    responseText,
    languageEdits: manual.language_edits,
    scores: manual.scores,
    contentFeedback: manual.content_feedback,
    teacherComment: manual.teacher_comment
  });
  assert.equal(draft.scores.official_score.rationale, "");
  assert.equal(
    Object.values(draft.scores.dimension_scores).every(
      (dimension) => dimension.ai_basis === ""
    ),
    true
  );
  assert.equal(
    buildWritingReviewSaveUpdate(draft).scores.official_score.rationale,
    ""
  );
  assert.equal(
    buildWritingReviewPublishUpdate(draft, "2026-08-16T10:00:00.000Z")
      .published_scores.official_score.rationale,
    ""
  );
  assert.equal(draft.content_feedback.overall_feedback, "");
  assert.equal(
    buildWritingReviewPublishUpdate(draft, "2026-08-16T10:00:00.000Z")
      .published_content_feedback.overall_feedback,
    ""
  );
});

test("v2.2 teacher items keep exact selected spans, source, and optional fields", () => {
  const input = emailV22Input();
  const schoolStart = responseText.indexOf("school");
  input.languageEdits.push({
    edit_id: "teacher-edit",
    source: "teacher",
    start: schoolStart,
    end: schoolStart + "school".length,
    original_text: "school",
    replacement_text: "my professor",
    category: "word_choice",
    severity: "moderate",
    explanation: "",
    restored: false
  });
  const selectedStart = responseText.indexOf("write");
  input.contentFeedback.items.push({
    feedback_id: "teacher-feedback",
    source: "teacher",
    start: selectedStart,
    end: selectedStart + "write".length,
    original_sentence: "write",
    category: "elaboration",
    issue: "说明这里的具体意图。",
    suggestion: "",
    proposed_revision: "",
    included: true
  });

  const draft = normalizeWritingReviewWorkingDraft(input);
  assert.equal(draft.language_edits[0].source, "ai", "legacy missing source is AI");
  assert.equal(draft.language_edits[1].source, "teacher");
  assert.equal(draft.content_feedback.items[0].source, "ai");
  assert.equal(draft.content_feedback.items[1].source, "teacher");
  assert.equal(draft.content_feedback.items[1].original_sentence, "write");
  assert.equal(draft.content_feedback.items[1].proposed_revision, "");

  const saved = buildWritingReviewSaveUpdate(draft);
  assert.equal(saved.language_edits[1].source, "teacher");
  assert.equal(saved.content_feedback.items[1].source, "teacher");
  const published = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T10:00:00.000Z"
  );
  assert.equal(
    published.published_language_edits.some((item) => item.edit_id === "teacher-edit"),
    true
  );
  assert.equal(
    published.published_content_feedback.items.some(
      (item) => item.feedback_id === "teacher-feedback"
    ),
    true
  );
  assert.equal("source" in published.published_language_edits[1], false);
});

for (const [name, values] of [
  ["issue only", { issue: "问题内容", suggestion: "", proposed_revision: "" }],
  ["suggestion only", { issue: "", suggestion: "建议内容", proposed_revision: "" }],
  ["proposed revision only", { issue: "", suggestion: "", proposed_revision: "A clearer revision." }],
  ["issue and suggestion", { issue: "问题内容", suggestion: "建议内容", proposed_revision: "" }],
  ["all feedback fields", { issue: "问题内容", suggestion: "建议内容", proposed_revision: "A clearer revision." }]
]) {
  test(`teacher content feedback saves with ${name}`, () => {
    const input = emailV22Input();
    const start = responseText.indexOf("write");
    input.contentFeedback.items = [{
      feedback_id: `teacher-${name.replaceAll(" ", "-")}`,
      source: "teacher",
      start,
      end: start + "write".length,
      original_sentence: "write",
      category: "elaboration",
      included: true,
      ...values
    }];
    const draft = normalizeWritingReviewWorkingDraft(input);
    const saved = buildWritingReviewSaveUpdate(draft);
    assert.equal(saved.content_feedback.items[0].source, "teacher");
    assert.equal(saved.content_feedback.items[0].issue, values.issue);
    assert.equal(saved.content_feedback.items[0].suggestion, values.suggestion);
    assert.equal(saved.content_feedback.items[0].proposed_revision, values.proposed_revision);
  });
}

test("teacher content feedback rejects all blank editable content", () => {
  const input = emailV22Input();
  const start = responseText.indexOf("write");
  input.contentFeedback.items = [{
    feedback_id: "teacher-empty",
    source: "teacher",
    start,
    end: start + "write".length,
    original_sentence: "write",
    category: "elaboration",
    issue: " ",
    suggestion: "\n",
    proposed_revision: "\t",
    included: true
  }];
  assert.throws(
    () => normalizeWritingReviewWorkingDraft(input),
    /请至少填写一项批改内容/
  );
});

test("teacher language edit accepts explanation-only deletion and rejects all blank content", () => {
  const input = emailV22Input();
  input.languageEdits = [{
    ...languageEdit({
      edit_id: "teacher-explanation-only",
      source: "teacher",
      replacement_text: "",
      explanation: "删除这处多余表达。",
      restored: false
    })
  }];
  assert.equal(
    normalizeWritingReviewWorkingDraft(input).language_edits[0].replacement_text,
    ""
  );
  input.languageEdits[0].explanation = " ";
  assert.throws(
    () => normalizeWritingReviewWorkingDraft(input),
    /请至少填写一项批改内容/
  );
});

test("teacher language edit overlap is rejected without replacing the existing edit", () => {
  const input = emailV22Input();
  input.languageEdits.push({
    edit_id: "teacher-overlap",
    source: "teacher",
    start: 5,
    end: 10,
    original_text: "write",
    replacement_text: "writing",
    category: "grammar",
    severity: "moderate",
    explanation: "",
    restored: false
  });
  assert.throws(
    () => normalizeWritingReviewWorkingDraft(input),
    /语言修改 offset 无效或发生重叠/
  );
});

test("Save update never contains status or published snapshot fields", () => {
  const update = buildWritingReviewSaveUpdate(normalize());
  assert.deepEqual(Object.keys(update).sort(), [
    "content_feedback",
    "language_edits",
    "scores",
    "teacher_comment"
  ]);
  assert.equal("published_scores" in update, false);
  assert.equal("status" in update, false);
});

test("Publish uses current draft and filters restored edits and excluded feedback", () => {
  const draft = normalize({
    languageEdits: [
      languageEdit({ edit_id: "kept" }),
      languageEdit({
        edit_id: "restored",
        start: 10,
        end: 13,
        original_text: " to",
        replacement_text: " for",
        restored: true
      })
    ],
    contentFeedback: contentFeedback({
      items: [
        feedbackItem({ feedback_id: "kept" }),
        feedbackItem({ feedback_id: "excluded", included: false })
      ]
    }),
    scores: score({ rubric_score: 5 }),
    teacherComment: "Latest teacher comment"
  });
  const update = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T10:00:00.000Z"
  );
  assert.equal(update.status, "published");
  assert.equal(update.published_scores.official_score.teacher_score, 5);
  assert.equal(update.published_teacher_comment, "Latest teacher comment");
  assert.deepEqual(update.published_language_edits.map((item) => item.edit_id), ["kept"]);
  assert.equal("restored" in update.published_language_edits[0], false);
  assert.deepEqual(update.published_content_feedback.items.map((item) => item.feedback_id), ["kept"]);
  assert.equal("included" in update.published_content_feedback.items[0], false);
});

test("Email and Academic Discussion working drafts both normalize", () => {
  assert.equal(normalize().scores.official_score.teacher_score, 3);
  const discussion = normalizeWritingReviewWorkingDraft({
    taskType: "academic_discussion",
    responseText: "Cities should invest in transit.",
    languageEdits: [],
    scores: score(),
    contentFeedback: {
      rubric_analysis: discussionAnalysis(),
      items: [feedbackItem({ category: "discussion_contribution" })],
      overall_feedback: "A relevant contribution."
    },
    teacherComment: ""
  });
  assert.equal(discussion.content_feedback.items[0].included, true);
});

test("historical teacher social-conventions feedback still opens for Academic Discussion", () => {
  const start = responseText.indexOf("write");
  const discussion = normalizeWritingReviewWorkingDraft({
    taskType: "academic_discussion",
    responseText,
    languageEdits: [],
    scores: score(),
    contentFeedback: {
      rubric_analysis: discussionAnalysis(),
      items: [{
        feedback_id: "historical-teacher-social",
        source: "teacher",
        start,
        end: start + "write".length,
        original_sentence: "write",
        category: "social_conventions",
        issue: "历史人工反馈。",
        suggestion: "",
        proposed_revision: "",
        included: true
      }],
      overall_feedback: "历史数据。"
    },
    teacherComment: ""
  });
  assert.equal(discussion.content_feedback.items[0].category, "social_conventions");
});

test("workspace GET reads submitted attempt, full question, review, and student name", async () => {
  const supabase = workspaceSupabase();
  const payload = await loadWritingReviewWorkspace(supabase, "attempt-1");
  assert.equal(payload.attempt.attempt_id, "attempt-1");
  assert.equal(payload.attempt.student_name, "Student One");
  assert.equal(payload.question.subject, "Extension");
  assert.equal(payload.review.language_edits[0].restored, false);
});

test("workspace GET loads the complete Academic Discussion source", async () => {
  const attempt = attemptRow({
    task_type: "academic_discussion",
    question_id: "discussion-1",
    response_text: "Cities should invest in transit.",
    word_count: 5
  });
  const review = reviewRow({
    language_edits: [],
    scores: score(),
    content_feedback: {
      rubric_analysis: discussionAnalysis(),
      items: [feedbackItem({ category: "discussion_contribution" })],
      overall_feedback: "A relevant contribution."
    }
  });
  const question = {
    question_id: "discussion-1",
    set_id: "set-1",
    set_title: "Discussion Set",
    year_month: "202608",
    source_labels: "official",
    professor_name: "Professor Lee",
    professor_prompt: "Should cities invest in public transit?",
    student_1_name: "Anna",
    student_1_response: "Yes, it reduces traffic.",
    student_2_name: "Mark",
    student_2_response: "Roads are more flexible."
  };
  const payload = await loadWritingReviewWorkspace(
    workspaceSupabase({ attempt, review, discussionQuestion: question }),
    "attempt-1"
  );
  assert.equal(payload.attempt.task_type, "academic_discussion");
  assert.equal(payload.question.professor_prompt, question.professor_prompt);
  assert.equal(payload.question.student_2_response, question.student_2_response);
});

test("published review Save preserves its old published snapshot", async () => {
  const oldSnapshot = { rubric_score: 2, rationale: "Old published rationale." };
  const supabase = workspaceSupabase({
    review: reviewRow({ status: "published", published_scores: oldSnapshot })
  });
  const review = await saveWritingReviewWorkspace(supabase, "attempt-1", normalize());
  assert.equal(review.status, "published");
  assert.deepEqual(review.published_scores, oldSnapshot);
  assert.equal(supabase.updates.length, 1);
  assert.equal("published_scores" in supabase.updates[0], false);
});

test("edited AI score references survive Save and workspace reload", async () => {
  const input = emailV22Input();
  const initialDraft = normalizeWritingReviewWorkingDraft(input);
  const supabase = workspaceSupabase({
    review: reviewRow({ ...buildWritingReviewSaveUpdate(initialDraft) })
  });
  const draft = structuredClone(initialDraft);
  draft.scores.official_score.rationale = "教师修改后的总分参考";
  draft.scores.dimension_scores.social_conventions.ai_basis =
    "教师修改后的单项依据";
  await saveWritingReviewWorkspace(supabase, "attempt-1", draft);
  const reloaded = await loadWritingReviewWorkspace(supabase, "attempt-1");
  assert.equal(
    reloaded.review.scores.official_score.rationale,
    "教师修改后的总分参考"
  );
  assert.equal(
    reloaded.review.scores.dimension_scores.social_conventions.ai_basis,
    "教师修改后的单项依据"
  );
});

test("Publish performs one update containing working fields and every snapshot", async () => {
  const supabase = workspaceSupabase();
  const review = await saveWritingReviewWorkspace(
    supabase,
    "attempt-1",
    normalize({ scores: score({ rubric_score: 4 }) }),
    { publish: true, now: () => new Date("2026-08-13T12:00:00.000Z") }
  );
  assert.equal(supabase.updates.length, 1);
  const update = supabase.updates[0];
  assert.equal(update.scores.official_score.teacher_score, 4);
  assert.equal(update.published_scores.official_score.teacher_score, 4);
  assert.equal(update.status, "published");
  assert.equal(update.published_at, "2026-08-13T12:00:00.000Z");
  assert.equal(review.status, "published");
});

test("repeated Publish is idempotent and preserves the first published_at", async () => {
  const draft = normalize({ scores: score({ rubric_score: 4 }) });
  const firstPublishedAt = "2026-08-13T12:00:00.000Z";
  const supabase = workspaceSupabase({
    review: reviewRow({
      ...buildWritingReviewPublishUpdate(draft, firstPublishedAt),
      updated_at: "2026-08-13T12:00:01.000Z"
    })
  });
  const review = await saveWritingReviewWorkspace(
    supabase,
    "attempt-1",
    draft,
    { publish: true, now: () => new Date("2026-08-13T13:00:00.000Z") }
  );
  assert.equal(review.status, "published");
  assert.equal(review.published_at, firstPublishedAt);
  assert.equal(supabase.updates.length, 0);
});

test("workspace loading rejects missing and draft attempts", async () => {
  await assert.rejects(
    loadWritingReviewWorkspace(workspaceSupabase({ attempt: null }), "attempt-1"),
    (error) => error.code === "ATTEMPT_NOT_FOUND" && error.status === 404
  );
  await assert.rejects(
    loadWritingReviewWorkspace(
      workspaceSupabase({ attempt: attemptRow({ status: "draft" }) }),
      "attempt-1"
    ),
    (error) => error.code === "ATTEMPT_NOT_SUBMITTED"
  );
});

test("review-less submitted attempt opens a pending manual workspace without AI data", async () => {
  const payload = await loadWritingReviewWorkspace(
    workspaceSupabase({ review: null }),
    "attempt-1"
  );
  assert.equal(payload.review.review_id, null);
  assert.equal(payload.review.status, "pending");
  assert.equal(payload.review.has_ai_review, false);
  assert.equal(payload.review.ai_review_raw, null);
  assert.deepEqual(payload.review.language_edits, []);
  assert.deepEqual(payload.review.content_feedback.items, []);
});

test("first manual Save inserts a reviewing row with null AI metadata", async () => {
  const supabase = workspaceSupabase({ review: null });
  const manual = buildManualWritingReviewDraft("email");
  manual.content_feedback.overall_feedback = "教师纯手动总体评价。";
  manual.scores.official_score.teacher_score = 4;
  manual.scores.official_score.rationale = "手动总分参考";
  manual.scores.dimension_scores.social_conventions.ai_basis = "手动单项依据";
  const review = await saveWritingReviewWorkspace(supabase, "attempt-1", manual);
  assert.equal(supabase.inserts.length, 1);
  assert.equal(supabase.inserts[0].status, "reviewing");
  assert.equal(supabase.inserts[0].ai_model, null);
  assert.equal(supabase.inserts[0].ai_generated_at, null);
  assert.equal(supabase.inserts[0].ai_review_raw, null);
  assert.equal(review.status, "reviewing");
  assert.equal(review.has_ai_review, false);
  assert.equal(review.content_feedback.overall_feedback, "教师纯手动总体评价。");
  assert.equal(review.teacher_comment, "");
  assert.equal(review.scores.official_score.rationale, "手动总分参考");
  assert.equal(
    review.scores.dimension_scores.social_conventions.ai_basis,
    "手动单项依据"
  );
  const reloaded = await loadWritingReviewWorkspace(supabase, "attempt-1");
  assert.equal(reloaded.review.scores.official_score.rationale, "手动总分参考");
  assert.equal(
    reloaded.review.scores.dimension_scores.social_conventions.ai_basis,
    "手动单项依据"
  );
  assert.equal(
    reloaded.review.content_feedback.overall_feedback,
    "教师纯手动总体评价。"
  );
});

test("first manual Publish inserts the current draft and published snapshot", async () => {
  const supabase = workspaceSupabase({ review: null });
  const manual = buildManualWritingReviewDraft("email");
  manual.content_feedback.overall_feedback = "无需 AI 的最终总体评价。";
  manual.scores.official_score.rationale = "最终总分参考";
  manual.scores.dimension_scores.lexical_and_grammatical_control.ai_basis =
    "最终单项依据";
  const review = await saveWritingReviewWorkspace(supabase, "attempt-1", manual, {
    publish: true,
    now: () => new Date("2026-08-16T08:00:00.000Z")
  });
  assert.equal(supabase.inserts[0].status, "published");
  assert.equal(supabase.inserts[0].published_teacher_comment, "");
  assert.equal(
    supabase.inserts[0].published_content_feedback.overall_feedback,
    "无需 AI 的最终总体评价。"
  );
  assert.equal(
    supabase.inserts[0].published_scores.official_score.rationale,
    "最终总分参考"
  );
  assert.equal(
    supabase.inserts[0].published_scores.dimension_scores
      .lexical_and_grammatical_control.ai_basis,
    "最终单项依据"
  );
  assert.equal(review.status, "published");
  assert.equal(review.has_ai_review, false);
});

test("manual Save and Publish both accept all score references blank", async () => {
  const supabase = workspaceSupabase({ review: null });
  const manual = buildManualWritingReviewDraft("email");
  const saved = await saveWritingReviewWorkspace(supabase, "attempt-1", manual);
  assert.equal(saved.scores.official_score.rationale, "");
  assert.equal(
    Object.values(saved.scores.dimension_scores).every(
      (dimension) => dimension.ai_basis === ""
    ),
    true
  );
  const published = await saveWritingReviewWorkspace(
    supabase,
    "attempt-1",
    manual,
    { publish: true, now: () => new Date("2026-08-16T11:00:00.000Z") }
  );
  assert.equal(published.status, "published");
  assert.equal(published.content_feedback.overall_feedback, "");
  assert.equal(published.published_content_feedback.overall_feedback, "");
  assert.equal(published.published_scores.official_score.rationale, "");
  assert.equal(
    Object.values(published.published_scores.dimension_scores).every(
      (dimension) => dimension.ai_basis === ""
    ),
    true
  );
});

test("legacy teacher overall feedback loads into the single final overall field", async () => {
  const payload = await loadWritingReviewWorkspace(
    workspaceSupabase({
      review: reviewRow({
        teacher_comment: "历史教师总体评价。",
        content_feedback: {
          ...contentFeedback(),
          overall_feedback: "历史 AI 总体评价。"
        }
      })
    }),
    "attempt-1"
  );
  assert.equal(
    payload.review.content_feedback.overall_feedback,
    "历史教师总体评价。"
  );
  assert.equal(payload.review.teacher_comment, "");
});

test("non-teacher access is rejected before workspace data is read", () => {
  assert.throws(
    () => assertWritingReviewTeacher({ error: "Unauthorized", userId: "student-1" }),
    (error) =>
      error.code === "UNAUTHORIZED" &&
      error.status === 403 &&
      /无权/.test(error.message)
  );
});

function attemptRow(overrides = {}) {
  return {
    attempt_id: "attempt-1",
    user_id: "student-1",
    task_type: "email",
    question_id: "email-1",
    set_id: "set-1",
    response_text: responseText,
    word_count: 5,
    status: "submitted",
    submitted_at: "2026-08-13T08:00:00.000Z",
    ...overrides
  };
}

function questionRow() {
  return {
    question_id: "email-1",
    set_id: "set-1",
    set_title: "Email Set",
    year_month: "202608",
    source_labels: "official",
    scenario: "You need more time.",
    task_instruction: "Write an email.",
    requirement_1: "Explain why.",
    requirement_2: "Request more time.",
    requirement_3: "Suggest a date.",
    closing_instruction: "Close appropriately.",
    recipient: "Professor Lee",
    subject: "Extension"
  };
}

function reviewRow(overrides = {}) {
  const draft = normalize();
  return {
    review_id: "review-1",
    attempt_id: "attempt-1",
    status: "reviewing",
    ai_model: "moonshotai/kimi-k3",
    ai_generated_at: "2026-08-13T08:05:00.000Z",
    ai_review_raw: {},
    ...buildWritingReviewSaveUpdate(draft),
    published_language_edits: null,
    published_scores: null,
    published_content_feedback: null,
    published_teacher_comment: null,
    published_at: null,
    updated_at: "2026-08-13T08:05:00.000Z",
    ...overrides
  };
}

function emailV22Input() {
  const dimension = { ai_score: 4, teacher_score: 4, ai_basis: "具体依据。" };
  return {
    taskType: "email",
    responseText,
    languageEdits: [languageEdit({ restored: false })],
    scores: {
      official_score: { ai_score: 4, teacher_score: 4, rationale: "整体较好。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension,
        syntactic_range_and_word_choice: dimension,
        social_conventions: dimension,
        lexical_and_grammatical_control: dimension
      }
    },
    contentFeedback: {
      items: [{
        feedback_id: "feedback-v22",
        start: 0,
        end: responseText.length,
        original_sentence: responseText,
        category: "elaboration",
        issue: "展开不足。",
        suggestion: "补充直接支持请求的具体原因。",
        proposed_revision: "I am writing to explain my request in more detail.",
        included: true
      }],
      overall_feedback: "表达清楚，但需要补充细节。"
    },
    teacherComment: ""
  };
}

function workspaceSupabase(options = {}) {
  const state = {
    writing_attempts: options.attempt === undefined ? attemptRow() : options.attempt,
    email_questions: options.question === undefined ? questionRow() : options.question,
    academic_discussion_questions:
      options.discussionQuestion === undefined ? null : options.discussionQuestion,
    profiles: options.profile === undefined
      ? { id: "student-1", email: "student@example.com", full_name: "Student One" }
      : options.profile,
    writing_reviews: options.review === undefined ? reviewRow() : options.review
  };
  const updates = [];
  const inserts = [];
  return {
    updates,
    inserts,
    from(table) {
      let updateValue;
      let insertValue;
      const query = {
        select() { return query; },
        eq() { return query; },
        update(value) { updateValue = structuredClone(value); updates.push(updateValue); return query; },
        insert(value) { insertValue = structuredClone(value); inserts.push(insertValue); return query; },
        async maybeSingle() {
          if (table === "writing_reviews" && updateValue) {
            state.writing_reviews = { ...state.writing_reviews, ...updateValue, updated_at: "2026-08-13T12:00:01.000Z" };
          }
          if (table === "writing_reviews" && insertValue) {
            state.writing_reviews = {
              review_id: "manual-review-1",
              published_language_edits: null,
              published_scores: null,
              published_content_feedback: null,
              published_teacher_comment: null,
              published_at: null,
              updated_at: "2026-08-13T12:00:01.000Z",
              ...insertValue
            };
          }
          return { data: state[table] ?? null, error: null };
        }
      };
      return query;
    }
  };
}
