import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { mapPracticeAccessError } from "@/lib/practiceEntitlements";
import { isVirtualPracticeSetId } from "@/lib/studentNavigation";
import { createAnonSupabase, createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Explicit BAS Start / Unlock operation.
 *
 * The ordinary questions GET remains read-only. This POST is the only BAS entry
 * that can spend one entitlement and create the permanent unlock. Calling it
 * again for the same canonical item is idempotent.
 */
export async function POST(
  request: Request,
  { params }: { params: { setId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireUserWithRole(token, "student");
    if (auth.error || !auth.userId || !token) {
      return json({ error: "请先登录后再开始练习。" }, { status: 401 });
    }

    const setId = String(params.setId ?? "").trim();
    if (!setId || isVirtualPracticeSetId(setId)) {
      return json({ error: "无效的 Build a Sentence 套题。" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      assignmentId?: unknown;
    };
    if (
      body.assignmentId !== undefined
      && body.assignmentId !== null
      && typeof body.assignmentId !== "string"
    ) {
      return json({ error: "无效的作业来源。" }, { status: 400 });
    }
    const assignmentId = typeof body.assignmentId === "string"
      ? body.assignmentId.trim()
      : "";
    if (assignmentId && !UUID_PATTERN.test(assignmentId)) {
      return json({ error: "无效的作业来源。" }, { status: 400 });
    }

    const { data, error } = await createAnonSupabase(token).rpc(
      "student_start_build_sentence_practice",
      {
        p_source_set_id: setId,
        p_assignment_id: assignmentId || null
      }
    );
    if (error) {
      const failure = mapPracticeAccessError(
        error,
        "暂时无法开始这道练习，请稍后重试。"
      );
      if (failure.status >= 500) {
        console.error("[bas-practice-start] failed", {
          code: error.code ?? null,
          message: error.message
        });
      }
      return json({ error: failure.message }, { status: failure.status });
    }

    let access = data as {
      enforcementEnabled?: boolean;
      free?: boolean;
      unlocked?: boolean;
    } | null;
    if (auth.role === "student" && access?.enforcementEnabled === false) {
      // BAS has no persisted draft. While the switch is OFF, record the real
      // authenticated start through the service-role-only marker so the same
      // session remains submittable after the eventual phase-6 enable. The
      // authenticated start RPC deliberately cannot write this free unlock.
      const marker = await createServiceSupabase().rpc(
        "record_pre_enable_build_sentence_start",
        {
          p_student_id: auth.userId,
          p_source_set_id: setId,
          p_assignment_id: assignmentId || null
        }
      );
      if (marker.error) {
        console.error("[bas-practice-start] pre_enable_record_failed", {
          code: marker.error.code ?? null,
          message: marker.error.message
        });
        return json(
          { error: "暂时无法记录练习授权，请重试。" },
          { status: 500 }
        );
      }
      const markerPayload = marker.data as {
        free?: boolean;
        recorded?: boolean;
      } | null;
      if (markerPayload?.recorded) {
        access = {
          ...(access ?? {}),
          free: markerPayload.free === true,
          unlocked: true
        };
      }
    }

    return json({ access });
  } catch (error) {
    console.error("[bas-practice-start] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "暂时无法开始这道练习，请稍后重试。" }, { status: 500 });
  }
}
