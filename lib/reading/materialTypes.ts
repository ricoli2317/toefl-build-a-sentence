export const RDL_MATERIAL_TYPE_INSTRUCTIONS = {
  advertisement: "Read an advertisement.",
  agenda: "Read an agenda.",
  announcement: "Read an announcement.",
  article: "Read an article.",
  blog_post: "Read a blog post.",
  course_description: "Read a course description.",
  course_syllabus: "Read a course syllabus.",
  email: "Read an email.",
  email_exchange: "Read an email exchange.",
  flyer: "Read a flyer.",
  following_notice: "Read the following notice.",
  form: "Read a form.",
  instructions: "Read some instructions.",
  invitation: "Read an invitation.",
  label: "Read a label.",
  meeting_minutes: "Read some meeting minutes.",
  message_exchange: "Read a message exchange.",
  newspaper_article: "Read a newspaper article.",
  notice: "Read a notice.",
  online_discussion: "Read an online discussion.",
  poster: "Read a poster.",
  review: "Read a review.",
  schedule: "Read a schedule.",
  sign: "Read a sign.",
  social_media_post: "Read a social media post.",
  student_magazine_article: "Read an article in a student magazine.",
  student_newspaper_article: "Read an article in a student newspaper.",
  syllabus: "Read a syllabus.",
  syllabus_excerpt: "Read an excerpt from a syllabus.",
  text_chain: "Read a text chain.",
  text_message_chain: "Read a text-message chain.",
  travel_flyer: "Read a travel flyer.",
  webpage: "Read a webpage."
} as const;

// Reading production owns the canonical material taxonomy. TPS validates the
// stable storage format instead of maintaining a second, closed allowlist.
// The instruction map above remains intentionally finite because it is used
// only to recover legacy material types from exact source instructions.
export type KnownRdlMaterialType = keyof typeof RDL_MATERIAL_TYPE_INSTRUCTIONS;
export type RdlMaterialType = string;

const RDL_MATERIAL_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RDL_MATERIAL_TYPE_BY_INSTRUCTION = new Map<string, KnownRdlMaterialType>(
  Object.entries(RDL_MATERIAL_TYPE_INSTRUCTIONS).map(([materialType, instruction]) => [
    normalizeInstruction(instruction),
    materialType as KnownRdlMaterialType
  ])
);

export function isRdlMaterialType(value: unknown): value is RdlMaterialType {
  return typeof value === "string" && RDL_MATERIAL_TYPE_PATTERN.test(value);
}

export function rdlMaterialInstruction(materialType: KnownRdlMaterialType): string {
  return RDL_MATERIAL_TYPE_INSTRUCTIONS[materialType];
}

export function rdlMaterialTypeFromInstruction(instruction: string): KnownRdlMaterialType | null {
  return RDL_MATERIAL_TYPE_BY_INSTRUCTION.get(normalizeInstruction(instruction)) ?? null;
}

function normalizeInstruction(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
