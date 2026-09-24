import { createHash } from "node:crypto";

export const LEXICAL_AGENT_PROVENANCE = {
  semantic_engine: "openchamber_agent",
  provider: "openai",
  model: "gpt-5.6-sol",
  thinking_effort: "high"
} as const;

// Keep the original identity provenance: v2 batch IDs and accepted checkpoints depend on it.
export const LEXICAL_CURRENT_AGENT_PROVENANCE = {
  semantic_engine: "openchamber_agent",
  provider: "openai",
  model: "gpt-6-sol",
  thinking_effort: "high"
} as const;

export type LexicalSemanticProvenance = {
  readonly semantic_engine: "openchamber_agent";
  readonly provider: "openai";
  readonly model: string;
  readonly thinking_effort: "high";
};

export function lexicalSemanticProvenanceMatches(
  value: unknown,
  expected: LexicalSemanticProvenance = LEXICAL_AGENT_PROVENANCE
): value is LexicalSemanticProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, field]) => record[key] === field);
}

export function lexicalSemanticProvenanceKey() {
  return createHash("sha256").update(JSON.stringify(LEXICAL_AGENT_PROVENANCE), "utf8").digest("hex");
}
