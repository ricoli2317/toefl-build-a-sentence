import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseEmptyQuery, parseListSource } from "@/lib/ctw-vocabulary/input";
import { startVocabularyList } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return vocabularyRoute(request, async client => {
    parseEmptyQuery(new URL(request.url).searchParams);
    return startVocabularyList(client, parseListSource(await request.json()));
  });
}
