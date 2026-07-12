type UserMetadata = {
  display_name?: unknown;
  full_name?: unknown;
  name?: unknown;
};

export function getPreferredUserDisplayName({
  email,
  metadata,
  profileFullName
}: {
  email?: string | null;
  metadata?: UserMetadata | null;
  profileFullName?: string | null;
}) {
  const profileName = nameValue(profileFullName, email);
  if (profileName) return profileName;

  const displayName = nameValue(metadata?.display_name, email);
  if (displayName) return displayName;

  const fullName = nameValue(metadata?.full_name, email);
  if (fullName) return fullName;

  const name = nameValue(metadata?.name, email);
  if (name) return name;

  return email || "Unknown user";
}

function nameValue(value: unknown, email?: string | null) {
  const name = stringValue(value);
  if (!name) return "";

  return email && name.toLocaleLowerCase() === email.trim().toLocaleLowerCase() ? "" : name;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
