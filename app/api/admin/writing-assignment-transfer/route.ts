import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  loadWritingAssignmentTransferBoard,
  runWritingAssignmentTransfer,
  WritingAssignmentTransferError
} from "@/lib/writingAssignmentTransfer";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(request: Request) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error || !auth.userId) {
    return json({ message: "仅管理员可以查看历史作业转移数据。" }, { status: 403 });
  }
  try {
    const board = await loadWritingAssignmentTransferBoard(createServiceSupabase());
    return json(board);
  } catch (error) {
    console.error("[writing-assignment-transfer] board_load_failed", error);
    return json({ message: "历史作业转移数据加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error || !auth.userId) {
    return json({ message: "仅管理员可以转移历史作业。" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const transfer = await runWritingAssignmentTransfer(createServiceSupabase(), {
      unitType: body.unitType,
      unitId: body.unitId,
      targetTeacherId: body.targetTeacherId
    });
    return json({ transfer });
  } catch (error) {
    if (error instanceof WritingAssignmentTransferError) {
      return json(
        {
          code: error.code,
          message: error.message,
          ...(error.missingStudents ? { missingStudents: error.missingStudents } : {})
        },
        { status: error.status }
      );
    }
    console.error("[writing-assignment-transfer] transfer_failed", error);
    return json({ message: "历史作业转移失败，请稍后重试。" }, { status: 500 });
  }
}
