import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseWordQuery } from "@/lib/ctw-vocabulary/input";
import { readVocabularyWords } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return vocabularyRoute(request, async client =>
    readVocabularyWords(client, parseWordQuery(new URL(request.url).searchParams)));
}
