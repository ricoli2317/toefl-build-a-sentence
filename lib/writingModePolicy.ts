import type { SupabaseClient } from "@supabase/supabase-js";
import type { WritingMode } from "./writing.ts";

export type StudentWritingModeAvailability = {
  practiceModeEnabled: boolean;
  mockModeEnabled: boolean;
};

type StudentWritingModeSettingRow = {
  practice_mode_enabled: boolean | null;
};

export const DEFAULT_STUDENT_WRITING_MODE_AVAILABILITY = {
  practiceModeEnabled: true,
  mockModeEnabled: true
} as const satisfies StudentWritingModeAvailability;

export function normalizeStudentWritingModeAvailability(
  row: StudentWritingModeSettingRow | null | undefined
): StudentWritingModeAvailability {
  return {
    practiceModeEnabled: row?.practice_mode_enabled !== false,
    mockModeEnabled: true
  };
}

export function isStudentWritingModeAllowed(
  availability: StudentWritingModeAvailability,
  mode: WritingMode | null | undefined
) {
  return mode === "practice"
    ? availability.practiceModeEnabled
    : mode === "exam"
      ? availability.mockModeEnabled
      : false;
}

export async function getStudentWritingModeAvailability(
  supabase: SupabaseClient,
  studentId: string
) {
  const { data, error } = await supabase
    .from("student_writing_mode_settings")
    .select("practice_mode_enabled")
    .eq("student_id", studentId)
    .maybeSingle();

  return {
    data: error
      ? null
      : normalizeStudentWritingModeAvailability(
          data as StudentWritingModeSettingRow | null
        ),
    error
  };
}

export function writingModeUnavailableMessage(mode: WritingMode) {
  return mode === "practice"
    ? "练习模式当前不可用，请选择模考模式。"
    : "模考模式当前不可用。";
}
