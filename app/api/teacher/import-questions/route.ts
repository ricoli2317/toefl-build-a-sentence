import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  QUESTION_TYPE_SCHEMAS,
  closestQuestionSchema,
  detectQuestionType,
  type KnownQuestionType
} from "@/lib/questionCsvSchemas";
import { createServiceSupabase } from "@/lib/supabase/server";
import { importAcademicDiscussionQuestions } from "./importers/academicDiscussion";
import { importBuildASentence } from "./importers/buildASentence";
import { serializeError } from "./importers/common";
import { importEmailQuestions } from "./importers/email";
import type { ImporterContext, ImportResult } from "./importers/types";
import { revalidatePracticeCatalog } from "@/lib/practiceCatalogCache.server";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";

export const dynamic = "force-dynamic";

const importers: Record<
  KnownQuestionType,
  (context: ImporterContext) => Promise<ImportResult>
> = {
  build_a_sentence: importBuildASentence,
  email: importEmailQuestions,
  academic_discussion: importAcademicDiscussionQuestions
};

const importedTaskTypes: Record<KnownQuestionType, PracticeTaskType> = {
  build_a_sentence: "build_sentence",
  email: "email",
  academic_discussion: "academic_discussion"
};

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...init?.headers,
      "Cache-Control": "no-store"
    }
  });
}

function jsonImportError({
  error,
  operation,
  status = 500
}: {
  error: unknown;
  operation: string;
  status?: number;
}) {
  const serialized = serializeError(error);
  console.error("Teacher CSV import failed", { error, operation });

  return json(
    {
      ...serialized,
      success: false,
      error: serialized.message,
      message: serialized.message,
      operation
    },
    { status }
  );
}

function headerMismatchResponse(headers: string[]) {
  const closest = closestQuestionSchema(headers);
  const missingFields = closest?.difference.missingFields ?? [];
  const unexpectedFields = closest?.difference.unexpectedFields ?? [];
  const expectedHeader = closest ? QUESTION_TYPE_SCHEMAS[closest.questionType].join(",") : "";

  return json(
    {
      success: false,
      error: "无法识别题型：CSV 表头与现有题型格式不匹配",
      message: "无法识别题型：CSV 表头与现有题型格式不匹配",
      code: "CSV_HEADER_MISMATCH",
      operation: "detect question type",
      details: [
        `Missing fields: ${missingFields.join(", ") || "none"}.`,
        `Unexpected fields: ${unexpectedFields.join(", ") || "none"}.`,
        `Received header: ${headers.join(",") || "none"}.`,
        `Closest required header: ${expectedHeader || "none"}.`
      ].join(" "),
      hint: "Use one of the exact supported CSV headers, including the documented column order."
    },
    { status: 400 }
  );
}

export async function POST(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      return json(
        {
          success: false,
          error: auth.error,
          message: auth.error,
          operation: "authorize teacher import"
        },
        { status: 401 }
      );
    }

    const body = (await request.json()) as {
      headers?: unknown;
      rows?: unknown;
    };
    if (!Array.isArray(body.rows) || !body.rows.every((row) => row && typeof row === "object")) {
      return json(
        {
          success: false,
          error: "Invalid import payload",
          message: "Invalid import payload",
          operation: "parse import request"
        },
        { status: 400 }
      );
    }

    const rows = body.rows as Array<Record<string, string>>;
    const headers = Array.isArray(body.headers)
      ? body.headers.map((header) => String(header))
      : Object.keys(rows[0] ?? {});
    const rowHeaders = Object.keys(rows[0] ?? {});
    if (
      rows.length > 0 &&
      (headers.length !== rowHeaders.length ||
        headers.some((header, index) => header !== rowHeaders[index]))
    ) {
      return headerMismatchResponse(rowHeaders);
    }
    const questionType = detectQuestionType(headers);

    if (questionType === "unknown") return headerMismatchResponse(headers);

    const importer = importers[questionType];
    const result = await importer({
      rows,
      supabase: createServiceSupabase(),
      userId: auth.userId
    });

    if (result.successCount > 0) {
      revalidatePracticeCatalog(importedTaskTypes[questionType]);
    }

    return json({ ...result, questionType });
  } catch (error) {
    const operation =
      error && typeof error === "object" && "operation" in error
        ? String(error.operation)
        : "import CSV questions";
    return jsonImportError({ error, operation });
  }
}
