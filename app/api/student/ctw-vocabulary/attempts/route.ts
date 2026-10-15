import { createServiceSupabase } from "@/lib/supabase/server";
import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseAttemptSubmission, parseEmptyQuery, parseHistoryQuery, VocabularyInputError } from "@/lib/ctw-vocabulary/input";
import { readVocabularyHistory, saveVocabularyAttempt } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return vocabularyRoute(request, async (client, studentId) =>
    readVocabularyHistory(client, studentId, parseHistoryQuery(new URL(request.url).searchParams)));
}
export async function POST(request: Request) {
  return vocabularyRoute(request, async (_client, studentId) => {
    parseEmptyQuery(new URL(request.url).searchParams);
    const body = await request.text();
    if (body.length > 100000) throw new VocabularyInputError();
    const submission = parseAttemptSubmission(JSON.parse(body));
    return saveVocabularyAttempt(createServiceSupabase(), studentId, submission);
  });
}
