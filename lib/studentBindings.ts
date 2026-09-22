export type StudentBindingDomain = "reading" | "writing";

export const STUDENT_BINDING_DOMAINS = ["reading", "writing"] as const;

export const STUDENT_BINDING_DOMAIN_LABELS: Record<StudentBindingDomain, string> = {
  reading: "阅读",
  writing: "写作"
};

export type StudentBindingInput = {
  teacherId: string;
  studentId: string;
  domain: string;
};

export function isStudentBindingDomain(value: unknown): value is StudentBindingDomain {
  return value === "reading" || value === "writing";
}

/**
 * Teacher self-service bindings never accept a teacher id from the client.
 * Only the domain selection is normalized; unknown values are ignored and the
 * canonical reading/writing order is always preserved.
 */
export function normalizeBindingDomains(input: unknown): StudentBindingDomain[] {
  if (!Array.isArray(input)) return [];
  const selected = new Set(input.filter(isStudentBindingDomain));
  return STUDENT_BINDING_DOMAINS.filter((domain) => selected.has(domain));
}

export function validateBindingDomains(
  input: unknown
): { ok: true; domains: StudentBindingDomain[] } | { ok: false; error: string } {
  const domains = normalizeBindingDomains(input);
  if (domains.length === 0) return { ok: false, error: "请至少选择一个授课科目。" };
  return { ok: true, domains };
}

export function bindingDomainsForTeacher(
  bindings: ReadonlyArray<{ teacherId: string; studentId: string; domain: string }>,
  teacherId: string,
  studentId: string
): StudentBindingDomain[] {
  const selected = new Set(
    bindings
      .filter((binding) => binding.teacherId === teacherId && binding.studentId === studentId)
      .map((binding) => binding.domain)
      .filter(isStudentBindingDomain)
  );
  return STUDENT_BINDING_DOMAINS.filter((domain) => selected.has(domain));
}

export function formatBindingDomainList(domains: readonly StudentBindingDomain[]) {
  return STUDENT_BINDING_DOMAINS.filter((domain) => domains.includes(domain))
    .map((domain) => STUDENT_BINDING_DOMAIN_LABELS[domain])
    .join("、");
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