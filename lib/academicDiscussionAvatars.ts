export type AcademicDiscussionAvatarRow = {
  avatar_path: string;
  participant_name: string;
  participant_type: string;
};

export type AcademicDiscussionAvatarMap = Record<string, string>;
export type AcademicDiscussionParticipantType = "professor" | "student";

export type AcademicDiscussionAvatarsPayload = {
  avatars: AcademicDiscussionAvatarMap;
  error?: string;
};

export function buildAcademicDiscussionAvatarMap(
  rows: AcademicDiscussionAvatarRow[]
): AcademicDiscussionAvatarMap {
  return rows.reduce<AcademicDiscussionAvatarMap>((avatarMap, row) => {
    const participantType = normalizeParticipantType(row.participant_type);
    if (participantType && row.participant_name && row.avatar_path) {
      avatarMap[avatarKey(row.participant_name, participantType)] = row.avatar_path;
    }
    return avatarMap;
  }, {});
}

export function resolveAcademicDiscussionAvatar(
  avatarMap: AcademicDiscussionAvatarMap,
  participantName: string,
  participantType: AcademicDiscussionParticipantType
) {
  const key = avatarKey(participantName, participantType);
  return Object.prototype.hasOwnProperty.call(avatarMap, key)
    ? avatarMap[key]
    : null;
}

export async function loadAcademicDiscussionAvatars(session: {
  accessToken: string;
}) {
  const response = await fetch("/api/writing/academic-discussion-avatars", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json()) as AcademicDiscussionAvatarsPayload;
  if (!response.ok || payload.error) {
    throw new Error(
      payload.error ?? "Academic discussion avatars could not be loaded."
    );
  }
  return payload;
}

function avatarKey(
  participantName: string,
  participantType: AcademicDiscussionParticipantType
) {
  return `${participantType}:${participantName}`;
}

function normalizeParticipantType(
  value: string
): AcademicDiscussionParticipantType | null {
  const normalized = value.toLowerCase();
  if (normalized === "professor" || normalized === "student") return normalized;
  return null;
}
