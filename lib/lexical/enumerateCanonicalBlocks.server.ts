import { enumerateAcademicDiscussionBlocks, type AcademicDiscussionLexicalInput } from "./enumerators/academicDiscussion.server.ts";
import { enumerateBasBlocks, type BasLexicalInput } from "./enumerators/bas.server.ts";
import { enumerateCtwBlocks, type CtwLexicalInput } from "./enumerators/ctw.server.ts";
import { enumerateRdlBlocks, type RdlLexicalInput } from "./enumerators/rdl.server.ts";
import { enumerateRapBlocks, type RapLexicalInput } from "./enumerators/rap.server.ts";
import { enumerateWriteEmailBlocks, type WriteEmailLexicalInput } from "./enumerators/writeEmail.server.ts";
import type { CanonicalLexicalBlock } from "./types.ts";
import { validateCanonicalLexicalBlocks } from "./validateCanonicalBlock.ts";

export type CanonicalLexicalEnumerationInput = {
  ctw?: CtwLexicalInput[];
  rdl?: RdlLexicalInput[];
  rap?: RapLexicalInput[];
  bas?: BasLexicalInput[];
  writeEmail?: WriteEmailLexicalInput[];
  academicDiscussion?: AcademicDiscussionLexicalInput[];
};

/** Pure server-side entry point. Callers must first read authoritative canonical rows/assets. */
export function enumerateCanonicalLexicalBlocks(input: CanonicalLexicalEnumerationInput): CanonicalLexicalBlock[] {
  return validateCanonicalLexicalBlocks([
    ...(input.ctw ?? []).flatMap(enumerateCtwBlocks),
    ...(input.rdl ?? []).flatMap(enumerateRdlBlocks),
    ...(input.rap ?? []).flatMap(enumerateRapBlocks),
    ...(input.bas ?? []).flatMap(enumerateBasBlocks),
    ...(input.writeEmail ?? []).flatMap(enumerateWriteEmailBlocks),
    ...(input.academicDiscussion ?? []).flatMap(enumerateAcademicDiscussionBlocks)
  ]);
}
