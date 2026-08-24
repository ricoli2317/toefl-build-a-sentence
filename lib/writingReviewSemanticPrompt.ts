import type { WritingTaskType } from "./writing.ts";
import {
  WRITING_REVIEW_C3_CONTENT_CATEGORIES,
  WRITING_REVIEW_C3_DIMENSIONS,
  WRITING_REVIEW_C3_LANGUAGE_CATEGORIES,
  WRITING_REVIEW_C3_LANGUAGE_SEVERITIES
} from "./writingReviewSemanticSchema.ts";

export const WRITING_REVIEW_C3_PROMPT_VERSION =
  "writing_review_c3_prompt_v6" as const;

const anchors = `Anchor handling rules:
The markers such as ⟦TPS_UNIT:U01⟧ are TPS metadata, not student writing. Ignore them for scoring, grammar, organization, punctuation, formatting, and word count. Read anchored_response as one complete response; unit boundaries are not sentence boundaries. Use unit IDs only as location references. Never quote, revise, count, mention, or return a marker.`;

const languageRevisions = `Language revision rules:
- Return one unit_revisions item for each independent, meaningful language error. The same unit_id may appear in several items.
- original_text must be copied exactly from that unit. It must be a complete, readable word, phrase, or clause with no leading or trailing whitespace. Never return a character fragment such as "ks" from "feedbacks" or "d in" from "enjoyed in". Include the governing word when a short function word alone would be unclear.
- replacement_text must be the exact English text that directly replaces original_text, with no boundary whitespace. Use an empty string only for a deletion. If original_text begins with a word, replacement_text must not begin with a detached comma or other punctuation; include the necessary source context instead.
- Keep independent errors separate. Do not combine spelling, word form, grammar, and wording changes into one long rewrite merely because they occur in the same unit.
- issue_type and reason must describe the complete replacement, not merely the easiest visible sub-error. Use spelling only when replacement_text merely corrects the spelling of the same intended word. If the replacement also changes the intended word, grammatical construction, or usage, choose the primary grammar, word_choice, syntax, or usage category and explain every material change.
- If one replacement necessarily fixes a tightly coupled structure containing more than one surface error, keep it as one item and explain all of those changes. Split it only when every resulting item has its own non-overlapping original_text, directly applicable replacement_text, single issue_type, and reason that refers only to that item.
- Do not return overlapping original_text ranges. Preserve the student's intended meaning and do not add missing ideas through a language revision.
- issue_type must be exactly one of: ${WRITING_REVIEW_C3_LANGUAGE_CATEGORIES.join(", ")}.
- severity must be exactly one of: ${WRITING_REVIEW_C3_LANGUAGE_SEVERITIES.join(", ")}. Use major only when the error seriously obstructs meaning or task communication; moderate for a noticeable grammar, syntax, or word-choice problem whose meaning remains recoverable; minor for a local spelling, punctuation, capitalization, article, or similarly small error.
- reason must be a concise Simplified Chinese explanation of this item only.`;

const chineseOutput = `Output-language rules:
- Write score_reason, every dimension basis, every unit revision reason, every content feedback issue and suggestion, and overall_feedback in concise Simplified Chinese.
- Keep original_text, replacement_text, and proposed_revision in the student's response language (normally English).
- Do not put labels, Markdown, quotations, or TPS markers inside any field.`;

export function buildWritingReviewSemanticC3Messages(input: {
  taskType: WritingTaskType;
  question: Record<string, unknown>;
  anchoredResponse: string;
}) {
  const dimensions = WRITING_REVIEW_C3_DIMENSIONS[input.taskType];
  const categories = WRITING_REVIEW_C3_CONTENT_CATEGORIES[input.taskType];
  const task =
    input.taskType === "email"
      ? "Evaluate completion of the email's communicative requirements, politeness, social conventions, greeting/closing, and specific content."
      : "Evaluate response to the professor, clear stance, genuine discussion participation, engagement with peers, elaboration, relevance, and coherence.";

  return [
    {
      role: "system" as const,
      content: `You are an expert TOEFL writing rater. Use the official 0–5 rubric.
${anchors}
${task}
${chineseOutput}
${languageRevisions}
Return one JSON object only: no prose before or after it and no Markdown code fence.
Output all and only these dimension_scores keys: ${dimensions.join(", ")}. Every dimension has an integer 0–5 score and a short non-empty basis. If official_score is 0, every dimension score must be 0. If official_score is greater than 0, every dimension score must be from 1 through 5. Dimension scores may differ from official_score and from each other. Never average, add, weight, or reverse-engineer dimensions to produce official_score. Use dimension score 0 only when the whole response meets an official Score 0 condition.
Content Feedback category must be exactly one of: ${categories.join(", ")}. Content Feedback is for task fulfillment, development, relevance, organization, or social conventions—not for repeating a local language correction. Each unit_id may appear at most once in content_feedback. If one unit has several related content issues, combine them into one issue, suggestion, and directly usable proposed_revision. Order content_feedback by importance. Every Content Feedback must use a real unit ID and include an English proposed_revision. If content_feedback shares a unit with language revisions, its proposed_revision must preserve those language corrections because an adopted content revision replaces the whole unit. Put response-level advice in overall_feedback; never use null unit_id.
Never return offsets, overlap decisions, database IDs, or a v2.2 object.`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task_type: input.taskType,
        question: input.question,
        anchored_response: input.anchoredResponse
      })
    }
  ];
}
