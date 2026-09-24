const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LexicalAnnotationValidationError,
  parseLexicalAnnotationPayload,
  validateAnnotationBatch
} = require("../lib/lexical/annotation.ts");
const {
  annotationCacheMatches,
  enrichmentCacheMatches,
  lexicalAnnotationBatchCacheKey,
  lexicalBlockCacheIdentity,
  lexicalEntryEnrichmentCacheKey,
  lexicalEntryEnrichmentInputSignature
} = require("../lib/lexical/cache.ts");
const { applyEntryEnrichment, consolidateLexicalEntries, mergeCachedEntryEnrichment } = require("../lib/lexical/consolidate.ts");
const { assessLexicalCompletion } = require("../lib/lexical/completion.ts");
const { LEXICAL_GENERATION_VERSION, lexicalEntryKey } = require("../lib/lexical/generationTypes.ts");
const { normalizeLexicalExpression, normalizeLexicalSurface } = require("../lib/lexical/normalize.ts");
const { qaLexicalBlock } = require("../lib/lexical/qa.ts");
const { annotationCacheNeedsRecovery, annotationOccurrencesNeedRecovery } = require("../lib/lexical/semantic.ts");
const { tokenizeCanonicalBlock } = require("../lib/lexical/tokenize.ts");
const { enumerateWriteEmailBlocks } = require("../lib/lexical/enumerators/writeEmail.server.ts");

function block(text, overrides = {}) {
  return {
    sourceType: "ctw",
    sourceItemId: "item",
    contentBlockId: "block",
    blockKind: "ctw_paragraph",
    text,
    ...overrides
  };
}

function tokenAnnotation(token, overrides = {}) {
  return {
    candidate_id: token.candidateId,
    context_pos: "noun",
    context_meaning_zh: "测试义",
    context_definition_en: "A concise contextual definition.",
    canonical_expression: token.normalizedSurface,
    lemma: token.normalizedSurface,
    expression_type: "word",
    needs_review: false,
    review_notes: null,
    ...overrides
  };
}

function annotationPayload(work, options = {}) {
  return {
    blocks: [{
      block_key: `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`,
      tokens: work.tokens.filter((token) => !token.excluded).map((token) => tokenAnnotation(token)),
      expressions: options.expressions ?? []
    }]
  };
}

test("tokenizer covers words, apostrophes, possessives, contractions, hyphen parts, punctuation, numbers, and UTF-16", () => {
  const work = tokenizeCanonicalBlock(block("Normal can't student’s researchers' carbon-based, 123 😀end."));
  assert.deepEqual(work.tokens.map((token) => token.surfaceText), [
    "Normal", "can't", "student’s", "researchers'", "carbon", "based", "end"
  ]);
  assert.equal(work.tokens.some((token) => token.surfaceText === "123"), false);
  assert.equal(work.block.text.slice(work.tokens[6].startOffset, work.tokens[6].endOffset), "end");
  assert.equal(work.tokens[6].startOffset, work.block.text.indexOf("end"));
  assert.equal(normalizeLexicalSurface(" Student’s  "), "student's");
});

test("Email recipient remains canonical text but is excluded from the coverage denominator", () => {
  const blocks = enumerateWriteEmailBlocks({
    sourceItemId: "email-item",
    sourceQuestionId: "email-question",
    isCanonical: true,
    recipient: "Dr. Smith",
    question: {
      scenario: "Scenario",
      taskInstruction: "Write an email to Dr. Smith. In your email, do the following:",
      requirement1: "Explain the issue.",
      requirement2: "Request help.",
      requirement3: "Thank the reader.",
      subject: "Equipment issue"
    }
  });
  const work = tokenizeCanonicalBlock(blocks.find((value) => value.contentBlockId === "task-instruction"));
  assert.deepEqual(work.tokens.filter((token) => token.excluded).map((token) => token.surfaceText), ["Dr", "Smith"]);
  const payload = annotationPayload(work);
  const occurrences = validateAnnotationBatch([work], payload);
  const qa = qaLexicalBlock(work, occurrences);
  assert.equal(qa.excludedTokens, 2);
  assert.equal(qa.missingTokens, 0);
  assert.equal(qa.coveragePercent, 100);
});

test("annotation validation rejects malformed values, unknown POS, empty meaning, invalid spans, and duplicate exact spans", () => {
  const work = tokenizeCanonicalBlock(block("take part"));
  assert.throws(() => parseLexicalAnnotationPayload({ blocks: "bad" }), LexicalAnnotationValidationError);
  const unknownPos = annotationPayload(work);
  unknownPos.blocks[0].tokens[0].context_pos = "article";
  assert.throws(() => validateAnnotationBatch([work], unknownPos), /unknown POS/i);
  const emptyMeaning = annotationPayload(work);
  emptyMeaning.blocks[0].tokens[0].context_meaning_zh = "";
  assert.throws(() => validateAnnotationBatch([work], emptyMeaning), /non-empty string/i);
  const chineseDefinition = annotationPayload(work);
  chineseDefinition.blocks[0].tokens[0].context_definition_en = "这是中文定义";
  assert.throws(() => validateAnnotationBatch([work], chineseDefinition), /definition_en_contains_chinese/i);
  const mismatchedProperNoun = annotationPayload(work);
  mismatchedProperNoun.blocks[0].tokens[0].expression_type = "proper_noun";
  assert.throws(() => validateAnnotationBatch([work], mismatchedProperNoun), /proper_noun_pos_type_mismatch/i);
  const invalidSpan = annotationPayload(work, { expressions: [{
    start_offset: 0,
    end_offset: 100,
    surface_text: "take part",
    context_pos: "verb",
    context_meaning_zh: "参加",
    context_definition_en: "To participate in an activity.",
    canonical_expression: "take part",
    lemma: "take part",
    expression_type: "phrase",
    learning_value: "fixed_expression",
    needs_review: false,
    review_notes: null
  }] });
  assert.throws(() => validateAnnotationBatch([work], invalidSpan), /invalid MWE span/i);
  const duplicate = annotationPayload(work, { expressions: [
    {
      start_offset: 0, end_offset: 9, surface_text: "take part", context_pos: "verb",
      context_meaning_zh: "参加", context_definition_en: "To participate in an activity.",
      canonical_expression: "take part", lemma: "take part", expression_type: "phrase",
      learning_value: "fixed_expression", needs_review: false, review_notes: null
    },
    {
      start_offset: 0, end_offset: 9, surface_text: "take part", context_pos: "verb",
      context_meaning_zh: "参加", context_definition_en: "To participate in an activity.",
      canonical_expression: "take part", lemma: "take part", expression_type: "phrase",
      learning_value: "fixed_expression", needs_review: false, review_notes: null
    }
  ] });
  assert.throws(() => validateAnnotationBatch([work], duplicate), /duplicate exact occurrence span/i);
});

test("MWE validation permits overlapping token coverage and rejects arbitrary n-gram labels", () => {
  const work = tokenizeCanonicalBlock(block("was taking part in New York"));
  const payload = annotationPayload(work, { expressions: [
    {
      start_offset: 4, end_offset: 18, surface_text: "taking part in", context_pos: "verb",
      context_meaning_zh: "参加", context_definition_en: "To participate in the activity.",
      canonical_expression: "take part in", lemma: "take part in", expression_type: "phrasal_verb",
      learning_value: "phrasal_verb", needs_review: false, review_notes: null
    },
    {
      start_offset: 19, end_offset: 27, surface_text: "New York", context_pos: "proper_noun",
      context_meaning_zh: "纽约", context_definition_en: "A city in the United States.",
      canonical_expression: "New York", lemma: "New York", expression_type: "proper_noun",
      learning_value: "proper_name", needs_review: false, review_notes: null
    }
  ] });
  const occurrences = validateAnnotationBatch([work], payload);
  assert.equal(occurrences.filter((value) => value.layer === 1).length, 6);
  assert.equal(occurrences.filter((value) => value.layer === 2).length, 2);
  assert.equal(occurrences.find((value) => value.expression_type === "phrasal_verb").lemma, "take part in");

  const arbitrary = annotationPayload(work, { expressions: [{
    start_offset: 0, end_offset: 18, surface_text: "was taking part in", context_pos: "verb",
    context_meaning_zh: "任意", context_definition_en: "An arbitrary sequence.",
    canonical_expression: "was taking part in", lemma: "was take part in", expression_type: "phrase",
    learning_value: "arbitrary", needs_review: false, review_notes: null
  }] });
  assert.throws(() => validateAnnotationBatch([work], arbitrary), /learning value/i);
});

test("single-word proper noun creates one Layer 1 exact-span occurrence rather than a duplicate word", () => {
  const work = tokenizeCanonicalBlock(block("London grows."));
  const payload = annotationPayload(work);
  payload.blocks[0].tokens[0] = tokenAnnotation(work.tokens[0], {
    context_pos: "proper_noun",
    context_meaning_zh: "伦敦",
    context_definition_en: "The capital city of the United Kingdom.",
    canonical_expression: "London",
    lemma: "London",
    expression_type: "proper_noun"
  });
  const occurrences = validateAnnotationBatch([work], payload);
  const london = occurrences.filter((value) => value.start_offset === 0 && value.end_offset === 6);
  assert.equal(london.length, 1);
  assert.equal(london[0].expression_type, "proper_noun");
});

test("consolidation merges inflections and senses, separates types, and flags canonicalization conflicts", () => {
  function occurrence(overrides) {
    const expressionType = overrides.expression_type ?? "word";
    const normalizedExpression = normalizeLexicalExpression(overrides.canonical_expression, expressionType);
    return {
      entry_key: lexicalEntryKey(normalizedExpression, expressionType),
      source_type: "ctw",
      source_item_id: overrides.source_item_id ?? "one",
      content_block_id: "block",
      sentence_id: null,
      source_anchor_id: null,
      surface_text: overrides.surface_text,
      normalized_surface: normalizeLexicalSurface(overrides.surface_text),
      start_offset: 0,
      end_offset: overrides.surface_text.length,
      context_pos: overrides.context_pos ?? "verb",
      context_meaning_zh: overrides.context_meaning_zh ?? "提供",
      context_definition_en: "To make something available.",
      context_text: overrides.surface_text,
      review_status: "generated",
      generation_version: LEXICAL_GENERATION_VERSION,
      review_notes: null,
      layer: 1,
      expression_type: expressionType,
      canonical_expression: overrides.canonical_expression,
      normalized_expression: normalizedExpression,
      lemma: overrides.lemma
    };
  }
  const entries = consolidateLexicalEntries([
    occurrence({ surface_text: "offers", canonical_expression: "offer", lemma: "offer", source_item_id: "one" }),
    occurrence({ surface_text: "offered", canonical_expression: "offer", lemma: "offer", source_item_id: "two", context_meaning_zh: "提出" }),
    occurrence({ surface_text: "London", canonical_expression: "London", lemma: "London", expression_type: "proper_noun" }),
    occurrence({ surface_text: "london", canonical_expression: "london", lemma: "london", expression_type: "word" }),
    occurrence({ surface_text: "Student’s", canonical_expression: "Student’s", lemma: "student", source_item_id: "three" }),
    occurrence({ surface_text: "Student's", canonical_expression: "Student's", lemma: "student", source_item_id: "four" })
  ]);
  assert.equal(entries.find((entry) => entry.normalized_expression === "offer").sample_occurrences.length, 2);
  assert.equal(entries.filter((entry) => entry.normalized_expression === "london").length, 2);
  assert.equal(entries.find((entry) => entry.normalized_expression === "student's").review_status, "needs_review");
});

test("coverage QA distinguishes generated, needs_review, and failed blocks", () => {
  const work = tokenizeCanonicalBlock(block("Clear text"));
  const generated = validateAnnotationBatch([work], annotationPayload(work));
  assert.equal(qaLexicalBlock(work, generated).generationStatus, "generated");
  generated[0].review_status = "needs_review";
  generated[0].review_notes = "sense_ambiguity";
  assert.equal(qaLexicalBlock(work, generated).generationStatus, "needs_review");
  assert.equal(qaLexicalBlock(work, generated.slice(1)).generationStatus, "failed");
  assert.equal(qaLexicalBlock(work, [], "model_schema_failure").generationStatus, "failed");
});

test("cache identities support reuse, interrupted resume, and generation-version invalidation", () => {
  const first = tokenizeCanonicalBlock(block("First", { contentBlockId: "first" }));
  const second = tokenizeCanonicalBlock(block("Second", { contentBlockId: "second" }));
  const cache = {
    generation_version: LEXICAL_GENERATION_VERSION,
    blocks: [lexicalBlockCacheIdentity(first)],
    payload: { blocks: [] }
  };
  assert.equal(annotationCacheMatches(cache, [first]), true);
  assert.equal(annotationCacheMatches(cache, [second]), false);
  assert.notEqual(lexicalAnnotationBatchCacheKey([first]), lexicalAnnotationBatchCacheKey([second]));
  assert.equal(annotationCacheMatches({ ...cache, generation_version: "lexical-v2" }, [first]), false);

  const seed = {
    entry_key: lexicalEntryKey("first", "word"),
    canonical_expression: "first",
    normalized_expression: "first",
    expression_type: "word",
    lemma: "first",
    common_senses: [],
    derived_words: [],
    useful_patterns: [],
    review_status: "generated",
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: null,
    sample_occurrences: []
  };
  const enrichmentCache = {
    generation_version: LEXICAL_GENERATION_VERSION,
    normalized_expression: "first",
    expression_type: "word",
    input_signature: lexicalEntryEnrichmentInputSignature(seed)
  };
  assert.equal(enrichmentCacheMatches(enrichmentCache, seed), true);
  assert.equal(enrichmentCacheMatches({ ...enrichmentCache, input_signature: "stale" }, seed), false);
  assert.notEqual(
    lexicalEntryEnrichmentInputSignature(seed),
    lexicalEntryEnrichmentInputSignature({ ...seed, sample_occurrences: [{ surface_text: "changed", context_text: "changed" }] })
  );
  assert.equal(enrichmentCacheMatches({ ...enrichmentCache, generation_version: "lexical-v2" }, seed), false);
  assert.match(lexicalEntryEnrichmentCacheKey(seed), /^[a-f0-9]{64}$/);

  const conflictedSeed = { ...seed, review_status: "needs_review", review_notes: "lemma_conflict" };
  const cachedEntry = {
    ...seed,
    common_senses: [{ pos: "adjective", definition_en: "Coming before all others.", meaning_zh: "第一的" }]
  };
  const merged = mergeCachedEntryEnrichment(conflictedSeed, cachedEntry);
  assert.equal(merged.review_status, "needs_review");
  assert.match(merged.review_notes, /lemma_conflict/);
});

test("enrichment validation rejects semantic and entry QA failures before caching", () => {
  const seed = {
    entry_key: lexicalEntryKey("example", "word"),
    canonical_expression: "example",
    normalized_expression: "example",
    expression_type: "word",
    lemma: "example",
    common_senses: [],
    derived_words: [],
    useful_patterns: [],
    review_status: "generated",
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: null,
    sample_occurrences: []
  };
  const payload = {
    entries: [{
      entry_key: seed.entry_key,
      canonical_expression: "example",
      lemma: "example",
      common_senses: [{ pos: "noun", definition_en: "这是中文定义", meaning_zh: "示例" }],
      derived_words: [],
      useful_patterns: [],
      needs_review: false,
      review_notes: null
    }]
  };
  assert.throws(() => applyEntryEnrichment([seed], payload), /definition_en_contains_chinese/);
  payload.entries[0].common_senses = [
    { pos: "noun", definition_en: "An item that illustrates a point.", meaning_zh: "示例" },
    { pos: "noun", definition_en: "An item that illustrates a point.", meaning_zh: "示例" }
  ];
  assert.throws(() => applyEntryEnrichment([seed], payload), /duplicate_senses/);

  payload.entries[0].common_senses = [
    { pos: "noun", definition_en: "An item that illustrates a point.", meaning_zh: "示例" }
  ];
  payload.entries[0].canonical_expression = "examples";
  assert.throws(() => applyEntryEnrichment([seed], payload), /canonical_identity_mismatch/);
  payload.entries[0].canonical_expression = "example";
  payload.entries[0].needs_review = "true";
  assert.throws(() => applyEntryEnrichment([seed], payload), /needs_review must be boolean/);
  payload.entries[0].needs_review = false;
  payload.entries[0].common_senses = [{ pos: "noun", definition_en: "An example.", meaning_zh: "示例" }];
  assert.throws(() => applyEntryEnrichment([seed], payload), /circular_definition/);
  payload.entries[0].common_senses = [
    { pos: "noun", definition_en: "An item that illustrates a point.", meaning_zh: "示例" }
  ];
  payload.entries[0].derived_words = [{ expression: "examples", relation: "plural", meaning_zh: "示例（复数）" }];
  assert.throws(() => applyEntryEnrichment([seed], payload), /inflection_in_derived_words/);

  const teachSeed = { ...seed, entry_key: lexicalEntryKey("teach", "word"), canonical_expression: "teach", normalized_expression: "teach", lemma: "teach" };
  payload.entries[0] = {
    ...payload.entries[0],
    entry_key: teachSeed.entry_key,
    canonical_expression: "teach",
    lemma: "teach",
    derived_words: [{ expression: "teacher", relation: "agent noun", meaning_zh: "教师" }]
  };
  assert.equal(applyEntryEnrichment([teachSeed], payload)[0].derived_words[0].expression, "teacher");
});

test("annotation caches retry model fallbacks and semantic-invalid results", () => {
  assert.equal(annotationCacheNeedsRecovery({ recovered_by_lexeme: true, occurrences: [] }), true);
  assert.equal(annotationOccurrencesNeedRecovery([{ review_notes: "mwe_model_failure" }]), true);
  assert.equal(annotationOccurrencesNeedRecovery([{ review_notes: null }]), false);
  assert.equal(annotationOccurrencesNeedRecovery([{
    context_pos: "conjunction",
    context_meaning_zh: "并且",
    context_definition_en: "Used to connect words or clauses.",
    expression_type: "proper_noun",
    review_notes: null
  }]), true);
});

test("completion remains blocked while model fallbacks exist", () => {
  const occurrence = {
    entry_key: lexicalEntryKey("example", "word"),
    source_type: "ctw",
    source_item_id: "item",
    content_block_id: "block",
    sentence_id: null,
    source_anchor_id: null,
    surface_text: "example",
    normalized_surface: "example",
    start_offset: 0,
    end_offset: 7,
    context_pos: "noun",
    context_meaning_zh: "示例",
    context_definition_en: "An item used to illustrate a point.",
    context_text: "example",
    review_status: "needs_review",
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: "model_schema_failure: quota",
    layer: 1,
    expression_type: "word",
    canonical_expression: "example",
    normalized_expression: "example",
    lemma: "example"
  };
  const entry = {
    entry_key: occurrence.entry_key,
    canonical_expression: "example",
    normalized_expression: "example",
    expression_type: "word",
    lemma: "example",
    common_senses: [{ pos: "noun", definition_en: occurrence.context_definition_en, meaning_zh: occurrence.context_meaning_zh }],
    derived_words: [],
    useful_patterns: [],
    review_status: "needs_review",
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: "enrichment_model_failure: quota",
    sample_occurrences: [occurrence]
  };
  const qa = { generationStatus: "needs_review" };
  const blocked = assessLexicalCompletion([occurrence], [entry], [qa]);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.phase, "blocked_model_capacity");
  assert.deepEqual(blocked.blockingIssues, {
    annotation_model_failure_occurrences: 1,
    mwe_model_failure_blocks: 0,
    enrichment_model_failure_entries: 1,
    structural_qa_failure_blocks: 0,
    semantic_qa_issue_occurrences: 0,
    semantic_qa_issue_entries: 1,
    unsafe_recovery_blocks: 0
  });
  const cleanOccurrence = { ...occurrence, review_status: "generated", review_notes: null };
  const cleanEntry = { ...entry, review_status: "generated", review_notes: null, sample_occurrences: [cleanOccurrence] };
  assert.equal(assessLexicalCompletion([cleanOccurrence], [cleanEntry], [qa]).complete, true);

  const semanticOnly = assessLexicalCompletion([
    { ...cleanOccurrence, context_definition_en: "这是中文定义" }
  ], [cleanEntry], [qa]);
  assert.equal(semanticOnly.complete, false);
  assert.equal(semanticOnly.phase, "blocked_qa");
});
