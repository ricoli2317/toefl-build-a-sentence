import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
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
import { readingCsvImporter } from "./importers/reading";
import type { ImporterContext, ImportResult } from "./importers/types";
import { revalidatePracticeCatalog } from "@/lib/practiceCatalogCache.server";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import type { ReadingDuplicateResolutionInput } from "@/lib/reading/duplicateResolutionModel";

export const dynamic = "force-dynamic";

const importers: Record<
  KnownQuestionType,
  (context: ImporterContext) => Promise<ImportResult>
> = {
  build_a_sentence: importBuildASentence,
  email: importEmailQuestions,
  academic_discussion: importAcademicDiscussionQuestions,
  complete_the_words: readingCsvImporter("complete_the_words"),
  read_in_daily_life: readingCsvImporter("read_in_daily_life"),
  read_an_academic_passage: readingCsvImporter("read_an_academic_passage")
};

const importedTaskTypes: Partial<Record<KnownQuestionType, PracticeTaskType>> = {
  build_a_sentence: "build_sentence",
  email: "email",
  academic_discussion: "academic_discussion"
};

const readingQuestionTypes = new Set<KnownQuestionType>([
  "complete_the_words",
  "read_in_daily_life",
  "read_an_academic_passage"
]);

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
    const auth = await requireAdmin(bearerToken(request));
    if (auth.error || !auth.userId) {
      return json(
        {
          success: false,
          error: "Forbidden",
          message: "仅管理员可以导入题库。",
          operation: "authorize admin import"
        },
        { status: auth.role ? 403 : 401 }
      );
    }

    const body = (await request.json()) as {
      headers?: unknown;
      rows?: unknown;
      fileName?: unknown;
      dryRun?: unknown;
      readingDuplicateResolutions?: unknown;
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
      userId: auth.userId,
      fileName: typeof body.fileName === "string" ? body.fileName : undefined,
      dryRun: readingQuestionTypes.has(questionType) && body.dryRun === true,
      readingDuplicateResolutions: Array.isArray(body.readingDuplicateResolutions)
        ? body.readingDuplicateResolutions.flatMap<ReadingDuplicateResolutionInput>((value) => {
            if (!value || typeof value !== "object") return [];
            const candidate = value as Record<string, unknown>;
            const action = candidate.action;
            if (action !== "reuse_existing" && action !== "create_new") return [];
            const questionType = candidate.questionType;
            if (questionType !== "ctw" && questionType !== "rdl" && questionType !== "rap") return [];
            const resolutionId = String(candidate.resolutionId ?? "").trim();
            if (!resolutionId) return [];
            const logicalItemId = typeof candidate.logicalItemId === "string"
              ? candidate.logicalItemId.trim()
              : "";
            if (action === "reuse_existing" && !logicalItemId) return [];
            if (action === "reuse_existing") {
              return [{ resolutionId, questionType, action, logicalItemId }];
            }
            return [{ resolutionId, questionType, action }];
          })
        : undefined
    });

    const importedTaskType = importedTaskTypes[questionType];
    if (!result.preview && result.successCount > 0 && importedTaskType) {
      revalidatePracticeCatalog(importedTaskType);
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
