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
  label: "Read a label.",
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

export type RdlMaterialType = keyof typeof RDL_MATERIAL_TYPE_INSTRUCTIONS;

const RDL_MATERIAL_TYPES = new Set<string>(Object.keys(RDL_MATERIAL_TYPE_INSTRUCTIONS));
const RDL_MATERIAL_TYPE_BY_INSTRUCTION = new Map<string, RdlMaterialType>(
  Object.entries(RDL_MATERIAL_TYPE_INSTRUCTIONS).map(([materialType, instruction]) => [
    normalizeInstruction(instruction),
    materialType as RdlMaterialType
  ])
);

export function isRdlMaterialType(value: unknown): value is RdlMaterialType {
  return typeof value === "string" && RDL_MATERIAL_TYPES.has(value);
}

export function rdlMaterialInstruction(materialType: RdlMaterialType): string {
  return RDL_MATERIAL_TYPE_INSTRUCTIONS[materialType];
}

export function rdlMaterialTypeFromInstruction(instruction: string): RdlMaterialType | null {
  return RDL_MATERIAL_TYPE_BY_INSTRUCTION.get(normalizeInstruction(instruction)) ?? null;
}

function normalizeInstruction(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
