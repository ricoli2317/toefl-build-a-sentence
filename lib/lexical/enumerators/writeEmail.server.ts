import type { CanonicalLexicalBlock } from "../types.ts";

export type WriteEmailLexicalInput = {
  sourceItemId: string;
  sourceQuestionId: string;
  isCanonical: boolean;
  recipient: string;
  question: {
    scenario: string;
    taskInstruction: string;
    requirement1: string;
    requirement2: string;
    requirement3: string;
    subject: string;
  };
};

/** Recipient names stay in taskInstruction; future coverage excludes their spans rather than changing canonical text. */
export function enumerateWriteEmailBlocks(input: WriteEmailLexicalInput): CanonicalLexicalBlock[] {
  if (!input.isCanonical) throw new Error(`Email source ${input.sourceQuestionId} is not canonical.`);
  const { question } = input;
  const blocks: CanonicalLexicalBlock[] = [
    ["scenario", "email_scenario", question.scenario],
    ["task-instruction", "email_task_instruction", question.taskInstruction],
    ["requirement:1", "email_requirement", question.requirement1],
    ["requirement:2", "email_requirement", question.requirement2],
    ["requirement:3", "email_requirement", question.requirement3],
    ["subject", "email_subject", question.subject]
  ].map(([contentBlockId, blockKind, text]) => ({
    sourceType: "write_email" as const,
    sourceItemId: input.sourceItemId,
    contentBlockId,
    blockKind,
    text
  }));
  const taskInstruction = blocks.find((block) => block.contentBlockId === "task-instruction")!;
  const recipient = input.recipient.trim();
  if (!recipient) throw new Error(`Email source ${input.sourceQuestionId} has an empty recipient.`);
  const genericRecipients = new Set(["customer service", "customer support", "chemistry class"]);
  if (genericRecipients.has(recipient.toLocaleLowerCase("en-US"))) return blocks;
  const anchors: NonNullable<CanonicalLexicalBlock["anchors"]> = [];
  let startOffset = taskInstruction.text.indexOf(recipient);
  while (startOffset >= 0) {
    anchors.push({
      anchorId: `recipient:${anchors.length + 1}`,
      anchorKind: "coverage_exclusion",
      startOffset,
      endOffset: startOffset + recipient.length,
      expectedText: taskInstruction.text.slice(startOffset, startOffset + recipient.length),
      metadata: { reason: "participant_name", field: "recipient" }
    });
    startOffset = taskInstruction.text.indexOf(recipient, startOffset + recipient.length);
  }
  if (!anchors.length) {
    throw new Error(`Email recipient ${JSON.stringify(recipient)} is not present in the canonical task instruction.`);
  }
  taskInstruction.anchors = anchors;
  return blocks;
}
