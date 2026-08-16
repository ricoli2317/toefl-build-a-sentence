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

export const CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS = {
  male_professor: "/avatars/academic-discussion/custom/professor-male.webp",
  female_professor: "/avatars/academic-discussion/custom/professor-female.webp",
  male_student: "/avatars/academic-discussion/custom/student-male.webp",
  female_student: "/avatars/academic-discussion/custom/student-female.webp"
} as const satisfies Record<
  AcademicDiscussionProfessorAvatarType | AcademicDiscussionStudentAvatarType,
  string
>;

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

export function resolveCustomAcademicDiscussionAvatar(
  avatarType: unknown,
  participantType: AcademicDiscussionParticipantType
) {
  if (participantType === "professor" && isProfessorAvatarType(avatarType)) {
    return CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS[avatarType];
  }
  if (participantType === "student" && isStudentAvatarType(avatarType)) {
    return CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS[avatarType];
  }
  return null;
}

export function isProfessorAvatarType(
  value: unknown
): value is AcademicDiscussionProfessorAvatarType {
  return value === "male_professor" || value === "female_professor";
}

export function isStudentAvatarType(
  value: unknown
): value is AcademicDiscussionStudentAvatarType {
  return value === "male_student" || value === "female_student";
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
import type {
  AcademicDiscussionProfessorAvatarType,
  AcademicDiscussionStudentAvatarType
} from "./writing.ts";
