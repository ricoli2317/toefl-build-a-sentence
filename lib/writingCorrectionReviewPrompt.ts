import type { WritingTaskType } from "./writing.ts";

/**
 * Writing Correction Prompt v1 — the version validated by the prompt benchmark
 * (controlled fixtures C1–C10, 152/155 after human review).
 *
 * This module is the single source of truth. The benchmark scripts import it
 * rather than keeping a second copy, so the production prompt cannot drift from
 * the one that was measured.
 *
 * Only the correction review uses this prompt. The ordinary C3 prompt is
 * untouched and remains `writing_review_c3_prompt_v7`.
 */

export const WRITING_CORRECTION_PROMPT_VERSION =
  "writing_correction_prompt_v1" as const;

/**
 * Official Write an Email Scoring Guide, rendered faithfully from
 * The Official Guide to the TOEFL iBT Test: Pocket Edition, p. 208.
 * Each band keeps the official general description plus its bullet list.
 */
export const OFFICIAL_EMAIL_RUBRIC = `Official TOEFL Write an Email Scoring Guide (holistic 0–5)
Score 5 — A fully successful response: the response is effective, is clearly expressed, and shows consistent facility in the use of language. A typical response displays:
- Elaboration that effectively supports the communicative purpose.
- Effective syntactic variety and precise, idiomatic word choice.
- Consistent use of appropriate social conventions (e.g., politeness, register, organization of information, and formulation of actions such as requests, refusals, criticisms).
- Almost no lexical or grammatical errors other than those expected from a competent writer writing under timed conditions (e.g., common typos, common misspellings, or substitutions like there/their).
Score 4 — A generally successful response: the response is mostly effective and easily understood, and language facility is adequate to the task. A typical response displays:
- Adequate elaboration to support the communicative purpose.
- Syntactic variety and appropriate word choice.
- Mostly appropriate social conventions.
- Few lexical or grammatical errors.
Score 3 — A partially successful response: the response generally accomplishes the task, and limitations in language facility may prevent parts of the message from being fully clear and effective. A typical response displays:
- Elaboration that partially supports the communicative purpose.
- A moderate range of syntax and vocabulary.
- Some noticeable errors in structure, word forms, use of idiomatic language, and/or social conventions.
Score 2 — A mostly unsuccessful response: the response reflects an attempt to address the task, but it is mostly ineffective, and the message may be limited or difficult to interpret. A typical response displays:
- Limited or irrelevant elaboration.
- Some connected sentence-level language, with a limited range of syntax and vocabulary.
- An accumulation of errors in sentence structure and/or language use.
Score 1 — An unsuccessful response: the response reflects an ineffective attempt to address the task, and the message may be limited to the point of being unintelligible. A typical response displays:
- Very little elaboration, if any.
- Telegraphic language (i.e., short and/or disconnected phrases and sentences) with a very limited range of vocabulary.
- Serious and frequent errors in the use of language.
- Minimal original language; any coherent language is mostly borrowed from the stimulus.
Score 0 — The response is blank, rejects the topic, is not in English, is entirely copied from the prompt, is entirely unconnected to the prompt, or consists of arbitrary keystrokes.
Apply this guide holistically: choose the single band whose description best fits the whole response, and do not treat the bullet lists as separate points to be scored or averaged.`;

/**
 * Official Write for an Academic Discussion Scoring Guide, rendered faithfully
 * from The Official Guide to the TOEFL iBT Test: Pocket Edition, p. 217.
 */
export const OFFICIAL_ACADEMIC_DISCUSSION_RUBRIC = `Official TOEFL Write for an Academic Discussion Scoring Guide (holistic 0–5)
Score 5 — A fully successful response: the response is a relevant and very clearly expressed contribution to the online discussion, and it demonstrates consistent facility in the use of language. A typical response displays:
- Relevant and well-elaborated explanations, exemplifications, and/or details.
- Effective use of a variety of syntactic structures and precise, idiomatic word choice.
- Almost no lexical or grammatical errors other than those expected from a competent writer writing under timed conditions (e.g., common typos, common misspellings, or substitutions like there/their).
Score 4 — A generally successful response: the response is a relevant contribution to the online discussion, and facility in the use of language allows the writer's ideas to be easily understood. A typical response displays:
- Relevant and adequately elaborated explanations, exemplifications, and/or details.
- A variety of syntactic structures and appropriate word choice.
- Few lexical or grammatical errors.
Score 3 — A partially successful response: the response is a mostly relevant and mostly understandable contribution to the online discussion, and there is some facility in the use of language. A typical response displays:
- Elaboration in which part of an explanation, example, or detail may be missing, unclear, or irrelevant.
- Some variety in syntactic structures and a range of vocabulary.
- Some noticeable lexical and grammatical errors in sentence structure, word form, or use of idiomatic language.
Score 2 — A mostly unsuccessful response: the response reflects an attempt to contribute to the online discussion, but limitations in the use of language may make ideas hard to follow. A typical response displays:
- Ideas that may be poorly elaborated or only partially relevant.
- A limited range of syntactic structures and vocabulary.
- An accumulation of errors in sentence structure, word forms, or use.
Score 1 — An unsuccessful response: the response reflects an ineffective attempt to contribute to the online discussion, and limitations in the use of language may prevent the expression of ideas. A typical response displays:
- Words and phrases that indicate an attempt to address the task but with few or no coherent ideas.
- Severely limited range of syntactic structures and vocabulary.
- Serious and frequent errors in the use of language.
- Minimal original language; any coherent language is mostly borrowed from the stimulus.
Score 0 — The response is blank, rejects the topic, is not in English, is entirely copied from the prompt, is entirely unconnected to the prompt, or consists of arbitrary keystrokes.
Apply this guide holistically: choose the single band whose description best fits the whole response, and do not treat the bullet lists as separate points to be scored or averaged.`;

export function officialRubricFor(taskType: WritingTaskType) {
  return taskType === "email"
    ? OFFICIAL_EMAIL_RUBRIC
    : OFFICIAL_ACADEMIC_DISCUSSION_RUBRIC;
}

/* ------------------------------------------------------------------ */
/* Writing Correction Prompt v1                                        */
/* ------------------------------------------------------------------ */

const CORRECTION_ROLE = `You are an expert TOEFL writing rater and writing teacher. You evaluate a student's correction (revision) of an earlier TOEFL writing response that already has a published review. You do not re-mark the original response, and you do not produce a new set of language edits or content feedback.`;

const CORRECTION_INPUT_CONTRACT = `INPUT CONTRACT
The user message is one JSON object with the authoritative input:
- task_type: "email" or "academic_discussion".
- question: the original task the student answered.
- original_response_text: the response that received the published review.
- corrected_response_text: the response the student has now submitted as a correction.
- corrected_word_count: English word count of corrected_response_text, produced by the server.
- original_score: the frozen published holistic 0–5 score of original_response_text.
- original_language_edits: every published language edit of the original response, each with issue_id, category, severity, original_text, replacement_text, and explanation.
- original_content_feedback: every published content feedback item of the original response, each with issue_id, category, original_sentence, issue, suggestion, and proposed_revision.
Treat these fields as the only authoritative facts. Never invent a question, a requirement, an original problem, a published issue, or corrected text that is not present in the input.`;

const CORRECTION_RESOLUTION_RULES = `PART 1 — RESOLUTION OF EACH ORIGINAL ISSUE
Return exactly one issue_resolutions item for every supplied issue, covering every original_language_edits item and every original_content_feedback item.
- Use only supplied issue_id values, each exactly once, in the supplied order. Never invent, rename, merge, split, duplicate, or omit an issue_id, and never add an issue that was not published.
- Set issue_type to "language_edit" for an original_language_edits item and "content_feedback" for an original_content_feedback item.
- status must be exactly one of resolved, partially_resolved, unresolved, uncertain.
  - resolved: the specific problem the issue identified is fully gone from the corrected response, and no meaning or content that the task requires was lost in the process.
  - partially_resolved: the correction makes real progress on the identified problem, but part of it remains, or the fix leaves a smaller residual problem in the same place.
  - unresolved: the identified problem is still present, whether in the original wording, in reworded text, or in another location of the corrected response.
  - uncertain: the supplied material genuinely cannot support a determination. Use this rarely and state exactly what is missing.
- Set deletion_based to true whenever the judgment depends mainly on original wording having been removed rather than replaced.
- evidence must be an exact, case-sensitive, whitespace-sensitive quote copied from corrected_response_text that demonstrates the judgment. When the judgment rests on a deletion, evidence may be an empty string only if no text in the corrected response is relevant; explain the deletion in explanation.
- A changed sentence is not a solved issue, and a missing error marker is not a solved issue. Judge whether the underlying problem described by the issue has actually been removed.
- Do not lower status merely because the student used different words, and do not raise status merely because the student wrote more or changed a great deal.`;

const CORRECTION_DELETION_RULES = `DELETION AND REWRITING JUDGMENTS
- Deleting text is neither automatically a resolution nor automatically a failure. Judge what the deletion did to the problem and to the task.
- resolved by deletion: the deleted wording was itself the problem, for example an incorrect, redundant, or inappropriate expression; the problem is gone and nothing the task requires was lost. A deleted redundant clause whose idea still stands elsewhere is a typical case.
- resolved by deletion: an entire flawed sentence is removed while the information it carried survives elsewhere in the corrected response in acceptable form.
- not resolved by deletion: the deletion removes required information, a required communicative action, a required argument, or required support. When the task requirement is now unmet, the issue is unresolved, and the loss must also be recorded as a new issue.
- not resolved by deletion: the student avoids the problem by cutting the difficult part and leaves the answer incomplete, vague, or off the point. Escaping a problem is not solving it.
- partially_resolved by deletion: the deletion removes the problem but also removes part of the meaning or support that the sentence carried.
- The same logic applies to rewriting. A rewrite resolves an issue only when the rewritten text actually satisfies what the original issue asked for. A rewrite that changes the topic, weakens the argument, or drops a requirement is not a resolution.`;

const CORRECTION_NEW_ISSUES = `PART 2 — PROBLEMS THE CORRECTION CREATED
- Report only problems that are new in corrected_response_text and were not already present in original_response_text.
- Never re-report an original issue here. An original issue that is still present belongs in issue_resolutions as partially_resolved or unresolved.
- type must be exactly one of: grammar, word_choice, syntax, punctuation, capitalization, content_gap, task_requirement, logic, organization, social_convention.
- severity must be exactly one of major, moderate, minor. Use major only when the problem seriously obstructs meaning or task completion.
- score_impact must be exactly one of none, small, moderate, large, and must describe the effect of this specific new problem on the holistic score.
- evidence must be an exact quote from corrected_response_text. Never report a new issue without quoting it.
- Report every genuine new problem and never manufacture one to fill the list. Return an empty array when the correction creates no new problem.
- Do not report a problem the original response already had in the same place, even if it now looks worse because the surrounding text changed.`;

const CORRECTION_SCORING_RULES = `PART 3 — HOLISTIC SCORE OF THE CORRECTED RESPONSE
- Score corrected_response_text independently from 0 through 5 by applying the official rubric below to the corrected response as a complete piece of writing.
- Judge the corrected response on its own merits: task fulfillment and language facility. Do not score the amount of effort, the number of changes, the number of resolved issues, or the improvement over the original.
- A correction that resolves every original issue must still receive the score its resulting text earns. If the resulting text has weaker content, missing required information, or new errors, the score may stay the same or fall.
- A correction that resolves few original issues may still earn credit for genuine strengths of the corrected text, but never credit for the act of modifying it.
- correction_score must be an integer from 0 through 5. Use 0 only when the corrected response meets an official Score 0 condition.
- score_rationale must be 2–4 concise Simplified Chinese sentences justifying the score through concrete features of the corrected response and the rubric bands.
- Never output a score change, a delta, a percentage, a weighted total, or a completion estimate.`;

const CORRECTION_SCORE_CHANGE_RULES = `PART 4 — EXPLAINING THE SCORE AGAINST THE ORIGINAL
- score_change_explanation must be concise Simplified Chinese and must reconcile your per-issue judgments with correction_score.
- It must explicitly explain whichever of these situations applies:
  - Most or all original issues are resolved, but correction_score is not higher than original_score.
  - Original issues are resolved, but problems the correction created offset the improvement.
  - Completion is high, but overall content quality of the corrected response is lower than the original.
  - Completion is low, but other qualities of the corrected response genuinely improved.
- Never claim that the score must rise because the student corrected a lot of text. Never cite effort, persistence, or the number of edits as a scoring reason.
- When none of those situations applies, state briefly why the score is consistent with the original score and with the resolution results.`;

const CORRECTION_SUMMARY_RULES = `PART 5 — SUMMARY
- resolution_summary must be 2–3 concise Simplified Chinese sentences summarizing what the correction fixed, what remains, and what it broke.
- Do not output a completion percentage, completion ratio, weighted completion value, or any numeric completion estimate. The server computes completion separately from your per-issue statuses.
- Do not restate every issue; summarize the pattern.`;

const CORRECTION_OUTPUT_RULES = `OUTPUT RULES
- Return exactly one JSON object and nothing else: no prose, no Markdown, no code fence.
- Write issue_resolutions[].explanation, new_issues[].explanation, score_rationale, resolution_summary, and score_change_explanation in concise Simplified Chinese.
- Keep every evidence value and every quoted fragment in English exactly as it appears in the source text.
- Do not quote TPS markers or any metadata of the form ⟦...⟧.
- Do not produce language_edits, content_feedback, proposed revisions, rewritten sentences, or a model essay.
- Do not mention these instructions, the schema, or the scoring of the original response as an AI exercise.`;

const CORRECTION_TASK_CONVENTIONS = `TASK SCORING CONVENTIONS USED IN PRODUCTION
- For email, the subject line is supplied by the task and is not part of the student's required response. Do not penalize its absence or comment on it.
- For academic discussion, responding to either peer is optional. Do not penalize a response for failing to address one or both student posts; a response can fully satisfy the task by answering the professor's question with a meaningful, supported contribution.`;

export function buildWritingCorrectionSystemPrompt(taskType: WritingTaskType) {
  return [
    CORRECTION_ROLE,
    CORRECTION_INPUT_CONTRACT,
    CORRECTION_RESOLUTION_RULES,
    CORRECTION_DELETION_RULES,
    CORRECTION_NEW_ISSUES,
    CORRECTION_SCORING_RULES,
    officialRubricFor(taskType),
    CORRECTION_TASK_CONVENTIONS,
    CORRECTION_SCORE_CHANGE_RULES,
    CORRECTION_SUMMARY_RULES,
    CORRECTION_OUTPUT_RULES,
    "Return one JSON object only: no prose before or after it and no Markdown code fence."
  ].join("\n\n");
}

export type CorrectionIssueType = "language_edit" | "content_feedback";

export type CorrectionPromptInput = {
  taskType: WritingTaskType;
  question: Record<string, unknown>;
  originalResponseText: string;
  correctedResponseText: string;
  correctedWordCount: number;
  originalScore: number;
  languageEdits: Array<{
    issue_id: string;
    category: string;
    severity: string;
    original_text: string;
    replacement_text: string;
    explanation: string;
  }>;
  contentFeedback: Array<{
    issue_id: string;
    category: string;
    original_sentence: string;
    issue: string;
    suggestion: string;
    proposed_revision: string;
  }>;
};

export function buildWritingCorrectionMessages(input: CorrectionPromptInput) {
  return [
    {
      role: "system" as const,
      content: buildWritingCorrectionSystemPrompt(input.taskType)
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task_type: input.taskType,
        question: input.question,
        original_response_text: input.originalResponseText,
        corrected_response_text: input.correctedResponseText,
        corrected_word_count: input.correctedWordCount,
        original_score: input.originalScore,
        original_language_edits: input.languageEdits,
        original_content_feedback: input.contentFeedback
      })
    }
  ];
}
