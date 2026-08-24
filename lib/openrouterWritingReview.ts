type JsonSchema = Record<string, unknown>;

import type { CostObservability } from "./writingReviewCost.ts";

export const WRITING_REVIEW_PROMPT_VERSION =
  "writing_review_prompt_v2026_08_16_1" as const;
// Bump the human-readable version above whenever the review Prompt contract changes.

export type OpenRouterMessage = {
  role: "system" | "user";
  content: string;
};

export type OpenRouterWritingReviewInput = {
  taskType: "email" | "academic_discussion";
  question: Record<string, unknown>;
  responseText: string;
};

export type OpenRouterWritingReviewOptions = {
  env?: Partial<Pick<NodeJS.ProcessEnv, "OPENROUTER_API_KEY" | "OPENROUTER_WRITING_MODEL">>;
  fetchImpl?: typeof fetch;
  jsonSchema: JsonSchema;
  modelOverride?: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
};

export type OpenRouterReasoningEffort = "max" | "high" | "medium" | "low";

export type OpenRouterStructuredOutputOptions = OpenRouterWritingReviewOptions & {
  schemaName: string;
};

export type OpenRouterTokenUsage = {
  prompt_tokens: number | null;
  cached_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  accepted_prediction_tokens: number | null;
  rejected_prediction_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  upstream_inference_cost: number | null;
  upstream_inference_prompt_cost: number | null;
  upstream_inference_completions_cost: number | null;
};

export const EMPTY_OPENROUTER_USAGE: OpenRouterTokenUsage = {
  prompt_tokens: null,
  cached_tokens: null,
  completion_tokens: null,
  reasoning_tokens: null,
  accepted_prediction_tokens: null,
  rejected_prediction_tokens: null,
  total_tokens: null,
  cost: null,
  upstream_inference_cost: null,
  upstream_inference_prompt_cost: null,
  upstream_inference_completions_cost: null
};

export type OpenRouterWritingReviewResponse = {
  content: string;
  model: string;
  usage: OpenRouterTokenUsage;
  generationId: string | null;
  costObservability?: CostObservability;
};

export type OpenRouterWritingReviewErrorCode =
  | "OPENROUTER_API_KEY_MISSING"
  | "OPENROUTER_MODEL_MISSING"
  | "OPENROUTER_REQUEST_FAILED"
  | "AI_REQUEST_TIMEOUT"
  | "AI_RESPONSE_INVALID";

export type OpenRouterErrorDiagnostic = {
  http_status: number | null;
  error_code: number | string | null;
  error_message: string | null;
  error_type: string | null;
  provider_code: string | number | null;
  provider_name: string | null;
};

export const EMPTY_OPENROUTER_ERROR_DIAGNOSTIC: OpenRouterErrorDiagnostic = {
  http_status: null,
  error_code: null,
  error_message: null,
  error_type: null,
  provider_code: null,
  provider_name: null
};

export class OpenRouterWritingReviewError extends Error {
  code: OpenRouterWritingReviewErrorCode;
  status: number;
  httpStatus: number | null;
  openRouterErrorCode: number | string | null;
  openRouterErrorType: string | null;
  providerCode: string | number | null;
  providerName: string | null;
  safeProviderMessage: string | null;

  constructor(
    code: OpenRouterWritingReviewErrorCode,
    message: string,
    status = 500,
    diagnostic: OpenRouterErrorDiagnostic = EMPTY_OPENROUTER_ERROR_DIAGNOSTIC
  ) {
    super(message);
    this.name = "OpenRouterWritingReviewError";
    this.code = code;
    this.status = status;
    this.httpStatus = diagnostic.http_status;
    this.openRouterErrorCode = diagnostic.error_code;
    this.openRouterErrorType = diagnostic.error_type;
    this.providerCode = diagnostic.provider_code;
    this.providerName = diagnostic.provider_name;
    this.safeProviderMessage = diagnostic.error_message;
  }
}

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

export const WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS = 240_000;
export const WRITING_FEEDBACK_REQUEST_TIMEOUT_MS = 120_000;

export type OpenRouterTimeoutOptions = {
  timeoutMs: number;
  timeoutMessage: string;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

/** Runs exactly one provider request with an abortable hard deadline. */
export async function requestOpenRouterWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: OpenRouterTimeoutOptions
): Promise<T> {
  const controller = new AbortController();
  const schedule = options.setTimeoutImpl ?? setTimeout;
  const cancel = options.clearTimeoutImpl ?? clearTimeout;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = schedule(() => {
        timedOut = true;
        controller.abort();
        reject(
          new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            options.timeoutMessage,
            504
          )
        );
      }, options.timeoutMs);
    });
    return await Promise.race([request(controller.signal), timeout]);
  } catch (error) {
    if (timedOut) {
      throw new OpenRouterWritingReviewError(
        "AI_REQUEST_TIMEOUT",
        options.timeoutMessage,
        504
      );
    }
    throw error;
  } finally {
    if (timer !== null) cancel(timer);
  }
}

const EMAIL_SCORING_GUIDE = `Official TOEFL Write an Email Scoring Guide (holistic 0-5)
Score 5 — Fully successful:
- Elaboration effectively supports communicative purpose.
- Effective syntactic variety and precise, idiomatic word choice.
- Consistent appropriate social conventions, including politeness, register, organization, and formulation of requests, refusals, criticisms, and other actions.
- Almost no lexical or grammatical errors except normal timed-writing slips.
Score 4 — Generally successful:
- Adequate elaboration supports communicative purpose.
- Syntactic variety and appropriate word choice.
- Mostly appropriate social conventions.
- Few lexical or grammatical errors.
Score 3 — Partially successful:
- Elaboration partially supports communicative purpose.
- Moderate range of syntax and vocabulary.
- Some noticeable errors in structure, word forms, idiomatic language, and/or social conventions.
Score 2 — Mostly unsuccessful:
- Limited or irrelevant elaboration.
- Some connected sentence-level language with limited syntax and vocabulary.
- Accumulation of sentence-structure and/or language-use errors.
Score 1 — Unsuccessful:
- Very little elaboration.
- Telegraphic language and very limited vocabulary.
- Serious and frequent language errors.
- Minimal original language; coherent language is mostly borrowed from the stimulus.
Score 0:
- Blank, rejects the topic, is not in English, is entirely copied, entirely unrelated, or arbitrary keystrokes.`;

const ACADEMIC_DISCUSSION_SCORING_GUIDE = `Official TOEFL Write for an Academic Discussion Scoring Guide (holistic 0-5)
Score 5 — Fully successful:
- Relevant and well-elaborated explanations, examples, and/or details.
- Effective variety of syntactic structures and precise, idiomatic word choice.
- Almost no lexical or grammatical errors except normal timed-writing slips.
Score 4 — Generally successful:
- Relevant and adequately elaborated explanations, examples, and/or details.
- Variety of syntactic structures and appropriate word choice.
- Few lexical or grammatical errors.
Score 3 — Partially successful:
- Mostly relevant and understandable.
- Part of an explanation, example, or detail may be missing, unclear, or irrelevant.
- Some syntactic variety and vocabulary range.
- Some noticeable lexical and grammatical errors.
Score 2 — Mostly unsuccessful:
- Poorly elaborated or only partially relevant ideas.
- Limited range of syntax and vocabulary.
- Accumulation of sentence-structure, word-form, or usage errors.
Score 1 — Unsuccessful:
- Few or no coherent ideas.
- Severely limited syntax and vocabulary.
- Serious and frequent language errors.
- Minimal original language; coherent language is mostly borrowed from the stimulus.
Score 0:
- Blank, rejects the topic, is not in English, is entirely copied, entirely unrelated, or arbitrary keystrokes.`;

const EMAIL_DIMENSION_GUIDE = `Teaching diagnostic dimensions derived from the official Email rubric (these are not ETS-reported independent subscores):
- communicative_purpose_and_elaboration: distinguish two judgments. Communicative purpose covers only whether required actions such as thanks, feedback, suggestion, request, or criticism are actually performed. Once an action is present, insufficient why/how, specificity, examples, or detail is an elaboration weakness, not a missing communicative purpose.
- syntactic_range_and_word_choice: syntactic range and effectiveness, vocabulary range, word-choice accuracy, collocation, idiomaticity, naturalness, and whether wording precisely expresses the intended meaning.
- social_conventions: politeness, register, information organization, and effective formulation of requests, refusals, criticisms, suggestions, appreciation, and other communicative actions.
- lexical_and_grammatical_control: frequency and severity of actual grammar, word-form, sentence-structure, agreement, tense, article, preposition, and objectively erroneous usage. Do not duplicate every naturalness or collocation weakness here; diagnose those primarily under syntactic_range_and_word_choice.
For each dimension use 5 for the strongest official-rubric characteristics, 4 for generally successful, 3 for partially successful, 2 for mostly unsuccessful, and 1 for unsuccessful. Use 0 only when the whole response meets an official Score 0 condition.`;

const ACADEMIC_DISCUSSION_DIMENSION_GUIDE = `Teaching diagnostic dimensions derived from the official Academic Discussion rubric (these are not ETS-reported independent subscores):
- relevance: only whether the response directly addresses the professor's prompt, remains within the discussion topic, and avoids substantial unrelated content. Do not lower relevance merely because evidence is weak or mismatched.
- elaboration: how fully and logically explanations, examples, evidence, and details support the position. Missing links, weak evidence, claim/example mismatch, and incomplete reasoning belong here even when the response remains on topic.
- syntactic_range_and_word_choice: syntactic range and effectiveness, vocabulary range, word-choice accuracy, collocation, idiomaticity, naturalness, and whether wording precisely expresses the intended meaning.
- lexical_and_grammatical_control: frequency and severity of actual grammar, word-form, sentence-structure, agreement, tense, article, preposition, and objectively erroneous usage. Do not duplicate every naturalness or collocation weakness here; diagnose those primarily under syntactic_range_and_word_choice.
For each dimension use 5 for the strongest official-rubric characteristics, 4 for generally successful, 3 for partially successful, 2 for mostly unsuccessful, and 1 for unsuccessful. Use 0 only when the whole response meets an official Score 0 condition.`;

const WORD_CHOICE_AND_COLLOCATION_AUDIT = `WORD CHOICE & COLLOCATION AUDIT — perform this internal sentence-by-sentence audit before producing the final JSON:
- Independently inspect every sentence for inaccurate word choice, verb–noun collocation problems, adjective–noun collocation problems, noun–noun combination problems, unnatural noun phrases, inappropriate verb selection, inappropriate prepositions in lexical collocations, non-idiomatic combinations, literal translation or Chinglish-like wording, and wording that does not precisely express the intended meaning. Do not stop after checking grammar.
- Apply this decision test: Would a competent English teacher explicitly tell the student that this wording is inaccurate, unnatural, non-idiomatic, poorly collocated, or inappropriate for the intended meaning? If yes, it is a genuine word-choice issue. Do not ask merely whether the sentence could be improved.
- Every genuine issue must affect the task's syntactic_range_and_word_choice judgment. Its ai_basis must cite the student's specific expression whenever practical instead of saying only that there are "some word-choice problems."
- When a genuine issue is concrete and worth revising, create sentence-level content_feedback with category "language_improvement" and provide a concise Simplified Chinese issue, a concise Simplified Chinese suggestion, and an English proposed_revision that directly repairs the sentence.
- Do not place inaccurate word choice, awkward collocation, an unnatural noun phrase, non-idiomatic wording, or grammatically possible but clearly unnatural expression in language_edits. language_edits remain only for objectively identifiable normative errors such as grammar, spelling, capitalization, punctuation, tense, agreement, article, preposition, number, word form, or an unambiguous grammatical usage error.
- If one sentence contains several closely related word-choice or collocation problems, create one combined language_improvement feedback and one proposed_revision for that sentence. Do not create overlapping feedback items.

Required calibration examples:
1. "make a directional goal" is an unnatural collocation/wording choice. Depending on context, a natural revision may use "set a clear career goal" or "develop a clearer sense of career direction."
2. "apply my dream career" has an inappropriate verb–noun collocation because "career" is not the direct object of "apply." Depending on context, consider "pursue my dream career" or "apply for jobs in my preferred field."
3. In a career-event context, "introduction papers" may be understandable but is not a natural or precise noun phrase. Explicitly inspect its context and consider "informational materials," "information sheets," or "brochures." Do not ignore it merely because it does not violate basic grammar.
4. Inspect "career workshop organization" in context. If the writer means the event itself or its arrangement and the noun phrase is clearly unnatural, diagnose it as word choice/language improvement rather than grammar.

Anti-polishing calibration:
- "I think this would be helpful." is already correct, clear, and natural in an appropriate context. Do not generate language_improvement merely to replace it with a more sophisticated sentence such as "I firmly believe this initiative would prove highly beneficial."
- Prohibit sophistication polishing, vocabulary upgrading for its own sake, unnecessary paraphrasing, and rewriting already-natural sentences.`;

const CONTENT_FEEDBACK_CLASSIFICATION_RULES = `CONTENT FEEDBACK CLASSIFICATION BOUNDARIES:
- Before assigning a content_feedback category, identify the PRIMARY problem being addressed. Do not use language_improvement as a catch-all merely because the same sentence also contains awkward wording.
- For Academic Discussion, relevance judges only whether the response addresses the professor's prompt, stays on the discussion topic, and avoids off-topic or tangential material. Weak evidence, a claim/example mismatch, an inconsistent scope between a claim and its example, a broken causal or logical chain, or an internal inconsistency is not a relevance problem when the response remains on topic.
- For Academic Discussion, classify insufficient explanation, evidence that does not support the claim, claim/example mismatch, inconsistent claim/evidence scope, weak logical support, incomplete reasoning, and internal inconsistency as elaboration.
- Use language_improvement when the primary problem is inaccurate word choice, awkward collocation, non-idiomatic wording, an unnatural noun phrase, imprecise lexical expression, literal translation or Chinglish-like wording, or a syntactically possible but clearly unnatural expression. For example, "introduction papers," "make a directional goal," and "apply my dream career" are language_improvement issues when the sentence's logic itself is sound.
- Do not automatically classify a nonstandard or invented-looking lexical form as spelling. When its primary problem is lexical naturalness or word choice rather than an objectively mechanical spelling error, diagnose it under syntactic_range_and_word_choice and, when feedback-worthy, language_improvement.
- When one sentence contains both a logical/development problem and a word-choice problem, do not create overlapping feedback revisions. Choose the category from the primary problem. The single proposed_revision may also repair the secondary wording problem only when issue or suggestion explicitly explains that secondary repair. Still cite the secondary word-choice issue in syntactic_range_and_word_choice.ai_basis, and continue to put objectively identifiable grammar errors in language_edits. Never misclassify the primary problem merely to avoid overlap.
- Email boundaries remain unchanged: communicative_purpose covers whether the required communicative action such as thanks, feedback, suggestion, or request is performed; elaboration covers why, how, detail, and adequacy of support; word-choice findings affect syntactic_range_and_word_choice and, when feedback-worthy, language_improvement.`;

export const PROPOSED_REVISION_FIDELITY_RULES = `PROPOSED REVISION FIDELITY:
- proposed_revision is not a free-polishing or general rewrite. It may implement only changes necessary to resolve the current issue and suggestion.
- Every material insertion, deletion, replacement, or structural change in proposed_revision must be directly explained by that item's issue or suggestion. There must be feedback rationale for every material change.
- Do not add unrelated stylistic polishing, more natural phrasing, extra vocabulary upgrades, sentence-pattern refinement, information expansion, new arguments, new facts, or any other unexplained content.
- If a change is not necessary to solve the identified feedback problem, leave the student's wording unchanged and do not include that change in proposed_revision.
- If several material changes are genuinely necessary, issue and/or suggestion must explicitly cover why all of them are needed. Preserve the student's intended meaning and do not silently broaden the feedback.
- BAD pattern: issue and suggestion request only deletion of redundant X, but proposed_revision also rewrites an unrelated earlier clause.
- GOOD pattern: when the feedback requests only deletion of redundant X, proposed_revision deletes only X and preserves the rest. If the earlier clause also must change, issue or suggestion must explicitly explain that additional problem.`;

const REVIEW_RULES = `Review rules:
- Return only the JSON object required by the supplied JSON Schema.
- Set schema_version to "2.2".
- First make an independent holistic judgment under the complete official rubric and return it as scores.official_score.ai_score from 0 through 5. Keep rationale to about 2–3 concise Simplified Chinese sentences and normally no more than about 150 Chinese characters. Explain why the response belongs at that holistic score without repeating all dimension analyses or cataloguing every language error.
- Second score every task-specific teaching diagnostic dimension from 0 through 5 and give a response-specific ai_basis in 1–2 concise Simplified Chinese sentences, normally about 60–100 Chinese characters. State why the score fits and cite the most important concrete evidence. These dimensions are derived teaching diagnostics, not ETS-reported independent subscores.
- Never average, add, weight, or reverse-engineer dimension scores to produce the official score. Dimension scores may legitimately differ from the official score and from one another.
- If official_score.ai_score is 0, every dimension ai_score must be 0. If the official score is greater than 0, every dimension ai_score must be from 1 through 5.
- Never return teacher_score, totals, averages, or weighted scores. Server code initializes teacher scores.
- Base every judgment on the supplied original question and the student's unmodified response.
- Keep official_score.rationale tied to the official scoring guide. Keep overall_feedback concise and avoid substantially repeating the rationale.
- language_edits correct only clear, objectively identifiable normative language errors: grammar, spelling, capitalization, punctuation, word form, tense, agreement, article, preposition, number, and other unambiguous usage errors; do not return start or end offsets. Server code strictly localizes each original_text.
- For every independent language edit, use the smallest uniquely localizable contiguous source span: the shortest continuous original_text that both contains the actual error and occurs exactly once in the full response_text.
- First identify the smallest true error unit. If that exact original_text already occurs once in the full response_text, use it without extra context. If it occurs more than once, extend the exact source span only as far as necessary to the left and/or right until it occurs exactly once, then stop extending immediately. Never expand to an entire sentence when shorter unique context is sufficient.
- original_text must be an exact, case-sensitive, whitespace-sensitive, punctuation-preserving copy from response_text. Never normalize, respell, rewrite, change case, insert or remove spaces, or otherwise alter source characters to manufacture uniqueness. Uniqueness may be achieved only by extending the contiguous source span.
- Expanding original_text is solely for localization. In replacement_text, preserve the added context exactly and change only what the correction requires; never use the wider span as permission to polish or paraphrase surrounding words.
- Split independent errors into separate non-overlapping edits. Combine errors only when they form one tightly coupled grammatical structure or separate corrections would produce an incorrect combined sentence. All active language_edits must be applicable together without creating any new grammatical error.
- One error must produce exactly one language_edit. Never express the same correction more than once.
- Never return both a broad edit and a contained sub-edit for the same correction (for example, "some issue" → "some issues" together with "issue" → "issues"). Return only the smallest uniquely localizable edit that fully expresses the correction.
- If multiple necessary corrections modify any of the same source characters, express the compatible corrections as one language_edit. Never emit overlapping edits on the same source characters.
- If extending source context for unique localization would make otherwise separate language_edits overlap, return one combined uniquely localizable edit for that overlap group. Its replacement may apply only the already-required corrections and must not polish unrelated wording.
- Continue to split unrelated errors when their actual source corrections do not overlap; do not combine every issue in a sentence into a broad edit.
- Localization examples: when the full response contains multiple occurrences of "is", BAD is "is" → "are"; use the shortest unique context such as "is crucial" → "are crucial" when that phrase occurs once. When "decided" is not unique, a shortest unique correction may be "may decided" → "may decide", not the whole sentence.
- Source-fidelity examples: if response_text contains "generaly", BAD is original_text "general y"; original_text must remain "generaly". For "event help me growed", BAD is two edits "help" → "helped" and "growed" → "grew" when their combined result is "event helped me grew". GOOD is one tightly coupled edit "help me growed" → "helped me grow", or separate shortest unique edits only when their combined result is grammatical.
- Each language_edits[].explanation must be exactly one concise Simplified Chinese sentence explaining only why the change is needed. Do not repeat original_text, replacement_text, the full sentence, the rubric, or general teaching background.
- Identify every genuine language edit. Never cap the number of language_edits, return only the first N, or keep only severe edits.
- Each language_edit must be a local correction of existing wording. Never add an unwritten opinion, missing task requirement, new reason or example, unfinished paragraph, full closing paragraph, sign-off, request, thanks, or other content the student did not write. Never disguise missing content as a language edit.
- Inaccurate word choice, poor collocation, non-idiomatic or materially unnatural wording that a competent English teacher would identify must not be ignored. Diagnose it in syntactic_range_and_word_choice.ai_basis and, when important, add content_feedback with category language_improvement. Do not force it into language_edits unless it is an objectively clear usage error.
- When word choice is a main weakness, mention that direction briefly in overall_feedback, optionally with one representative example, without repeating every detailed correction.
- Do not rewrite large spans to raise the score. Do not stylistically polish wording that is already correct, natural, and suitable merely because a more sophisticated alternative exists. Ask whether a competent English teacher would identify the current wording as inaccurate, unnatural, non-idiomatic, poorly collocated, or clearly inappropriate—not merely whether it could be improved.
- Explicit example: if the response ends with "Also, ", never replace "Also, " with a completed paragraph, request for advice, thanks, or signature. Report the unfinished task/content problem in content_feedback; proposed_revision belongs only in content_feedback and must not be inserted through language_edits.
- Judge severity by impact on meaning, clarity, task effectiveness, and grammatical acceptability.
- Each content_feedback item must quote one complete, exact, case-sensitive, whitespace-sensitive original_sentence that occurs exactly once in response_text. Never return start/end or included; server code locates the sentence and initializes included=true. Never invent or normalize a sentence.
- Every content_feedback item must include a non-empty English proposed_revision that can directly replace original_sentence, resolves the main identified issue, preserves the student's intended core meaning, and stays local to that feedback. It may split the sentence into two only when locally necessary. It is not a generic example, unrelated paragraph, whole-essay rewrite, or license to invent substantial new ideas.
- Active content revisions must not overlap. If one sentence has several highly related issues, combine them into one clear feedback item and one proposed_revision for that sentence. This prevents overlapping revisions; it is not a limit on the total number of feedback items. Different sentences with independent genuine issues must remain separate. Adjacent sentence revisions are allowed.
- Bind each feedback item to one concrete existing sentence and address one main problem only. For missing content, bind the closest relevant existing thesis, development, or paragraph-ending sentence rather than inventing text.
- issue identifies the sentence's task, argument, organization, development, or higher-level language-improvement problem in normally one concise Simplified Chinese sentence. Do not repeat the original sentence or scoring rationale.
- suggestion gives a specific, actionable remedy in normally 1–2 concise Simplified Chinese sentences. Do not add a long teaching explanation because proposed_revision supplies the actual English revision. Do not repeat individual grammar, spelling, or punctuation corrections that belong in language_edits.
- proposed_revision must contain only the final directly applicable English revision: no "For example:", explanation, Chinese, quotation marks, or repetition of suggestion.
- Return an empty content_feedback array when there is no worthwhile content issue. Never manufacture feedback to reach a quota.
- Never cap content_feedback, limit a category to N items, return only the first N, or select only a few "most important" issues. Identify every substantive, teacher-worthy issue, including all genuine word-choice, collocation, idiomaticity, inaccurate-wording, language-improvement, development, and task-related problems. Do not omit a substantive issue merely to keep the response short.
- Conciseness applies to the wording of each explanation and feedback item, NOT to the number of genuine issues identified. If the response contains many genuine problems, report all of them; do not manufacture issues merely to increase the count.
- Keep structured items consistent with the overall feedback. If the analysis identifies a specific, locally correctable language error (for example, "you advice" should be "your advice"), include it in language_edits. If it identifies a clear content problem, include it as sentence-bound content_feedback.
- Keep overall_feedback to 2–3 concise Simplified Chinese sentences summarizing the main strength and most important improvement direction. Do not repeat every feedback item, language edit, dimension basis, or the full official rationale.
- Before returning JSON, silently self-check every language_edit: original_text is copied exactly from response_text; it occurs exactly once in the full response_text; it is the shortest contiguous span satisfying uniqueness; replacement_text changes only what is necessary; edits do not overlap; and all edits applied together produce a grammatically correct result. Do not output this checklist.
- Use stable, unique edit_id and feedback_id strings within this result.`;

const OUTPUT_LANGUAGE_RULES = `OUTPUT LANGUAGE RULES:
- All explanatory and evaluative prose must be written in Simplified Chinese.
- language_edits[].explanation must be in Simplified Chinese.
- scores.official_score.rationale must be in Simplified Chinese.
- every dimension_scores.*.ai_basis must be in Simplified Chinese.
- content_feedback[].issue must be in Simplified Chinese.
- content_feedback[].suggestion must be in Simplified Chinese.
- overall_feedback must be in Simplified Chinese.
- original_text, replacement_text, and original_sentence must preserve the student's English exactly where required.
- content_feedback[].proposed_revision must contain only the directly applicable English revision, with no explanation, Chinese, label, or quotation marks.
- Do not translate the student's original writing into Chinese.
- Do not translate corrected English expressions into Chinese.`;

export function buildWritingReviewMessages(input: OpenRouterWritingReviewInput) {
  const scoringGuide =
    input.taskType === "email"
      ? EMAIL_SCORING_GUIDE
      : ACADEMIC_DISCUSSION_SCORING_GUIDE;
  const dimensionGuide =
    input.taskType === "email"
      ? EMAIL_DIMENSION_GUIDE
      : ACADEMIC_DISCUSSION_DIMENSION_GUIDE;

  return [
    {
      role: "system" as const,
      content: `You are an expert TOEFL writing rater and writing teacher.\n\n${scoringGuide}\n\n${dimensionGuide}\n\n${WORD_CHOICE_AND_COLLOCATION_AUDIT}\n\n${CONTENT_FEEDBACK_CLASSIFICATION_RULES}\n\n${PROPOSED_REVISION_FIDELITY_RULES}\n\n${REVIEW_RULES}\n\n${OUTPUT_LANGUAGE_RULES}`
    },
    {
      role: "user" as const,
      content: `Evaluate this TOEFL writing response. The original question fields and response are authoritative and must not be invented or normalized.\n\n${JSON.stringify(
        {
          task_type: input.taskType,
          original_question: input.question,
          response_text: input.responseText
        },
        null,
        2
      )}`
    }
  ];
}

export async function requestOpenRouterWritingReview(
  input: OpenRouterWritingReviewInput,
  options: OpenRouterWritingReviewOptions
): Promise<OpenRouterWritingReviewResponse> {
  return requestOpenRouterStructuredOutput(buildWritingReviewMessages(input), {
    ...options,
    schemaName: "tps_writing_review"
  });
}

export async function requestOpenRouterStructuredOutput(
  messages: OpenRouterMessage[],
  options: OpenRouterStructuredOutputOptions
): Promise<OpenRouterWritingReviewResponse> {
  if (options.timeoutMs !== undefined) {
    return requestOpenRouterWithTimeout(
      (signal) =>
        requestOpenRouterStructuredOutput(messages, {
          ...options,
          signal,
          timeoutMs: undefined,
          timeoutMessage: undefined
        }),
      {
        timeoutMs: options.timeoutMs,
        timeoutMessage:
          options.timeoutMessage ?? "AI 请求超时，请稍后重试。"
      }
    );
  }
  const env = options.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model = options.modelOverride?.trim() || env.OPENROUTER_WRITING_MODEL?.trim();

  if (!apiKey) {
    throw new OpenRouterWritingReviewError(
      "OPENROUTER_API_KEY_MISSING",
      "Server configuration is missing OPENROUTER_API_KEY."
    );
  }
  if (!model) {
    throw new OpenRouterWritingReviewError(
      "OPENROUTER_MODEL_MISSING",
      "Server configuration is missing OPENROUTER_WRITING_MODEL."
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        ...(options.reasoningEffort
          ? { reasoning: { effort: options.reasoningEffort } }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.schemaName,
            strict: true,
            schema: options.jsonSchema
          }
        },
        provider: {
          require_parameters: true
        }
      })
    });
  } catch {
    throw new OpenRouterWritingReviewError(
      "OPENROUTER_REQUEST_FAILED",
      "OpenRouter could not be reached.",
      502
    );
  }

  if (!response.ok) {
    const diagnostic = await readOpenRouterErrorDiagnostic(response);
    throw new OpenRouterWritingReviewError(
      "OPENROUTER_REQUEST_FAILED",
      formatOpenRouterErrorMessage(diagnostic),
      502,
      diagnostic
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterWritingReviewError(
      "AI_RESPONSE_INVALID",
      "OpenRouter returned an unreadable response.",
      502
    );
  }

  const content = readAssistantContent(payload);
  if (!content) {
    throw new OpenRouterWritingReviewError(
      "AI_RESPONSE_INVALID",
      "OpenRouter response did not contain assistant message content.",
      502
    );
  }

  return {
    content,
    model,
    usage: readOpenAICompatibleUsage(payload),
    generationId: isRecord(payload) ? readNonEmptyString(payload.id) : null
  };
}

export async function readOpenRouterErrorDiagnostic(
  response: Pick<Response, "status" | "text">
): Promise<OpenRouterErrorDiagnostic> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // HTTP status remains useful even when the body cannot be read.
  }
  return parseOpenRouterErrorDiagnostic(response.status, body);
}

export function parseOpenRouterErrorDiagnostic(
  httpStatus: number,
  body: string
): OpenRouterErrorDiagnostic {
  const fallback = {
    ...EMPTY_OPENROUTER_ERROR_DIAGNOSTIC,
    http_status: httpStatus
  };
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return fallback;
  }
  if (!isRecord(payload) || !isRecord(payload.error)) return fallback;
  const error = payload.error;
  const metadata = isRecord(error.metadata) ? error.metadata : null;
  return {
    http_status: httpStatus,
    error_code: readStringOrNumber(error.code),
    error_message: truncateProviderMessage(error.message),
    error_type: readNonEmptyString(metadata?.error_type),
    provider_code: readStringOrNumber(metadata?.provider_code),
    provider_name: readNonEmptyString(metadata?.provider_name)
  };
}

export function getOpenRouterErrorDiagnostic(
  error: unknown
): OpenRouterErrorDiagnostic {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5 && current !== null; depth += 1) {
    if (current instanceof OpenRouterWritingReviewError) {
      return {
        http_status: current.httpStatus,
        error_code: current.openRouterErrorCode,
        error_message: current.safeProviderMessage,
        error_type: current.openRouterErrorType,
        provider_code: current.providerCode,
        provider_name: current.providerName
      };
    }
    if (!isRecord(current) || visited.has(current)) break;
    visited.add(current);
    current = current.cause;
  }
  return { ...EMPTY_OPENROUTER_ERROR_DIAGNOSTIC };
}

function formatOpenRouterErrorMessage(diagnostic: OpenRouterErrorDiagnostic) {
  const status = diagnostic.http_status ?? "unknown";
  if (!diagnostic.error_message) return `OpenRouter returned HTTP ${status}.`;
  const errorType = diagnostic.error_type ? ` [${diagnostic.error_type}]` : "";
  return `OpenRouter HTTP ${status}${errorType}: ${diagnostic.error_message}`;
}

function truncateProviderMessage(value: unknown) {
  const message = readNonEmptyString(value);
  if (!message) return null;
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function readStringOrNumber(value: unknown) {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readAssistantContent(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return null;
  const content = firstChoice.message.content;
  return typeof content === "string" && content.trim() ? content : null;
}

export function readOpenAICompatibleUsage(payload: unknown): OpenRouterTokenUsage {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null;
  const completionDetails = isRecord(usage?.completion_tokens_details)
    ? usage.completion_tokens_details
    : null;
  const promptDetails = isRecord(usage?.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : null;
  const costDetails = isRecord(usage?.cost_details) ? usage.cost_details : null;
  return {
    prompt_tokens: readTokenCount(usage?.prompt_tokens),
    cached_tokens: readTokenCount(
      promptDetails?.cached_tokens ??
        usage?.cached_tokens ??
        usage?.prompt_cache_hit_tokens
    ),
    completion_tokens: readTokenCount(usage?.completion_tokens),
    reasoning_tokens: readTokenCount(
      completionDetails?.reasoning_tokens ?? usage?.reasoning_tokens
    ),
    accepted_prediction_tokens: readTokenCount(
      completionDetails?.accepted_prediction_tokens
    ),
    rejected_prediction_tokens: readTokenCount(
      completionDetails?.rejected_prediction_tokens
    ),
    total_tokens: readTokenCount(usage?.total_tokens),
    cost: readFiniteNumber(usage?.cost),
    upstream_inference_cost: readFiniteNumber(
      costDetails?.upstream_inference_cost
    ),
    upstream_inference_prompt_cost: readFiniteNumber(
      costDetails?.upstream_inference_prompt_cost
    ),
    upstream_inference_completions_cost: readFiniteNumber(
      costDetails?.upstream_inference_completions_cost
    )
  };
}

function readTokenCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
