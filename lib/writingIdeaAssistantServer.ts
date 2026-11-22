import {
  WritingIdeaAssistantError,
  type WritingIdeaRepository
} from "@/lib/writingIdeaAssistant";
import type { WritingIdeaClaim } from "@/lib/writingIdeaAssistantTypes";
import { createServiceSupabase } from "@/lib/supabase/server";

type ServiceSupabase = ReturnType<typeof createServiceSupabase>;

export function createWritingIdeaRepository(
  supabase: ServiceSupabase = createServiceSupabase()
): WritingIdeaRepository {
  return {
    async loadSelection(attemptId) {
      const { data, error } = await supabase
        .from("writing_idea_selections")
        .select("selection")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      if (error) throw repositoryError("load_selection", error);
      return data?.selection ?? null;
    },

    async saveSelection(input) {
      const { data, error } = await supabase
        .from("writing_idea_selections")
        .insert({
          attempt_id: input.attemptId,
          pool_id: input.poolId,
          student_id: input.studentId,
          task_type: input.taskType,
          question_id: input.questionId,
          selection: input.selection
        })
        .select("selection")
        .single();
      if (!error && data) return data.selection;

      if (isUniqueViolation(error)) {
        const { data: existing, error: readError } = await supabase
          .from("writing_idea_selections")
          .select("selection")
          .eq("attempt_id", input.attemptId)
          .maybeSingle();
        if (!readError && existing) return existing.selection;
        if (readError) throw repositoryError("read_selection_after_conflict", readError);
      }

      throw repositoryError("save_selection", error);
    },

    async claimPool(identity) {
      const { data, error } = await supabase.rpc("writing_idea_claim_pool", {
        p_task_type: identity.taskType,
        p_question_id: identity.questionId,
        p_question_source: identity.questionSource,
        p_prompt_version: identity.promptVersion,
        p_lease_seconds: 90
      });
      if (error) throw repositoryError("claim_pool", error);
      return readClaim(data);
    },

    async completePool(input) {
      const { data, error } = await supabase.rpc("writing_idea_complete_pool", {
        p_pool_id: input.poolId,
        p_token: input.token,
        p_content: input.content,
        p_model: input.model
      });
      if (error) throw repositoryError("complete_pool", error);
      return data === true;
    },

    async failPool(input) {
      const { data, error } = await supabase.rpc("writing_idea_fail_pool", {
        p_pool_id: input.poolId,
        p_token: input.token,
        p_error: input.error
      });
      if (error) throw repositoryError("fail_pool", error);
      return data === true;
    }
  };
}

function readClaim(data: unknown): WritingIdeaClaim {
  if (!isRecord(data) || typeof data.state !== "string") {
    throw new WritingIdeaAssistantError(
      "写作思路暂时不可用，请稍后重试。",
      "STORAGE_FAILED",
      500
    );
  }
  if (data.state === "ready") {
    if (typeof data.pool_id !== "string" || !data.pool_id) {
      throw new WritingIdeaAssistantError(
        "写作思路缓存异常，请稍后重试。",
        "CACHE_INVALID",
        502
      );
    }
    return {
      kind: "ready",
      poolId: data.pool_id,
      content: data.content
    };
  }
  if (data.state === "claimed") {
    if (
      typeof data.pool_id !== "string" ||
      !data.pool_id ||
      typeof data.token !== "string" ||
      !data.token
    ) {
      throw new WritingIdeaAssistantError(
        "写作思路暂时不可用，请稍后重试。",
        "STORAGE_FAILED",
        500
      );
    }
    return {
      kind: "claimed",
      poolId: data.pool_id,
      token: data.token
    };
  }
  if (data.state === "busy") {
    const retryAfter = Number(data.retry_after_ms);
    return {
      kind: "busy",
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter : 1500
    };
  }
  throw new WritingIdeaAssistantError(
    "写作思路暂时不可用，请稍后重试。",
    "STORAGE_FAILED",
    500
  );
}

function isUniqueViolation(error: unknown) {
  return isRecord(error) && error.code === "23505";
}

function repositoryError(stage: string, error: unknown) {
  if (isMissingInstallation(error)) {
    console.error("[writing-idea-assistant] database_not_installed", { stage });
    return new WritingIdeaAssistantError(
      "写作思路助手尚未完成数据库配置，请联系管理员。",
      "NOT_INSTALLED",
      503
    );
  }
  console.error("[writing-idea-assistant] repository_error", {
    stage,
    code: isRecord(error) && typeof error.code === "string" ? error.code : null,
    message: isRecord(error) && typeof error.message === "string"
      ? error.message.slice(0, 300)
      : "unknown"
  });
  return new WritingIdeaAssistantError(
    "写作思路暂时不可用，请稍后重试。",
    "STORAGE_FAILED",
    500
  );
}

function isMissingInstallation(error: unknown) {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (
    code === "PGRST202" ||
    code === "PGRST205" ||
    code === "42P01" ||
    /does not exist|could not find the function|schema cache/i.test(message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
