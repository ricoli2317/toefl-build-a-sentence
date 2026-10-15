import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { VocabularyInputError } from "@/lib/ctw-vocabulary/input";
import { createCtwReview, parseCtwReviewStart, readCtwReviewHistory } from "@/lib/ctw-vocabulary/review.server";
import { createServiceSupabase } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return vocabularyRoute(request, client => {
    const params = new URL(request.url).searchParams;
    if (Array.from(params.keys()).some(k => k !== "page") || params.getAll("page").length > 1
      || params.has("page") && !/^[1-9]\d{0,5}$/.test(params.get("page")!)) throw new VocabularyInputError();
    return readCtwReviewHistory(client, Number(params.get("page") ?? 1));
  });
}
export async function POST(request: Request) {
  return vocabularyRoute(request, async (client, owner) => {
    if (new URL(request.url).search) throw new VocabularyInputError();
    const input = parseCtwReviewStart(await request.json());
    return createCtwReview(client, createServiceSupabase(), owner, input);
  });
}
