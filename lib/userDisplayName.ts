type UserMetadata = {
  display_name?: unknown;
  full_name?: unknown;
  name?: unknown;
};

export function getPreferredUserDisplayName({
  email,
  metadata
}: {
  email?: string | null;
  metadata?: UserMetadata | null;
}) {
  const displayName = stringValue(metadata?.display_name);
  if (displayName) return displayName;

  const fullName = stringValue(metadata?.full_name);
  if (fullName) return fullName;

  const name = stringValue(metadata?.name);
  if (name) return name;

  return email || "Unknown user";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
