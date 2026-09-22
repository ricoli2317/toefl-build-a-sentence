export type StudentBindingDomain = "reading" | "writing";

export const STUDENT_BINDING_DOMAINS = ["reading", "writing"] as const;

export type StudentBindingInput = {
  teacherId: string;
  studentId: string;
  domain: string;
};

export function isStudentBindingDomain(value: unknown): value is StudentBindingDomain {
  return value === "reading" || value === "writing";
}

export function validateStudentBindingInput(
  input: StudentBindingInput
): { ok: true; domain: StudentBindingDomain } | { ok: false; error: string } {
  if (typeof input.teacherId !== "string" || !input.teacherId.trim()) {
    return { ok: false, error: "请选择教师。" };
  }
  if (typeof input.studentId !== "string" || !input.studentId.trim()) {
    return { ok: false, error: "请选择学生。" };
  }
  const domain = input.domain.trim();
  if (!isStudentBindingDomain(domain)) {
    return { ok: false, error: "请选择教学领域（Reading 或 Writing）。" };
  }
  return { ok: true, domain };
}

export function bindingExists(
  existing: ReadonlyArray<{ teacherId: string; studentId: string; domain: string }>,
  candidate: { teacherId: string; studentId: string; domain: string }
) {
  return existing.some(
    (binding) =>
      binding.teacherId === candidate.teacherId &&
      binding.studentId === candidate.studentId &&
      binding.domain === candidate.domain
  );
}