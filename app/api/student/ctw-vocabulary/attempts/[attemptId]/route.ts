import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseEmptyQuery, UUID_PATTERN, VocabularyInputError } from "@/lib/ctw-vocabulary/input";
import { readVocabularyResult } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { attemptId: string } }) {
  return vocabularyRoute(request, async (client, studentId) => {
    parseEmptyQuery(new URL(request.url).searchParams);
    if (!UUID_PATTERN.test(params.attemptId)) throw new VocabularyInputError();
    return readVocabularyResult(client, studentId, params.attemptId.toLowerCase());
  });
}
