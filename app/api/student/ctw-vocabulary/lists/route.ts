import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseListEdition } from "@/lib/ctw-vocabulary/input";
import { readVocabularyLists } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return vocabularyRoute(request, client => readVocabularyLists(client, parseListEdition(new URL(request.url).searchParams)));
}
