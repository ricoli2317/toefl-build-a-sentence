import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { parseEmptyQuery } from "@/lib/ctw-vocabulary/input";
import { readVocabularyCatalog } from "@/lib/ctw-vocabulary/store.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return vocabularyRoute(request, async client => {
    parseEmptyQuery(new URL(request.url).searchParams);
    return readVocabularyCatalog(client);
  });
}
