import { vocabularyRoute } from "@/lib/ctw-vocabulary/http.server";
import { exactKeys, UUID_PATTERN, VocabularyInputError } from "@/lib/ctw-vocabulary/input";
import { parseCtwReviewCommand, readCtwReview, syncCtwReview } from "@/lib/ctw-vocabulary/review.server";
import { createServiceSupabase } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
function id(value: string) { if (!UUID_PATTERN.test(value)) throw new VocabularyInputError(); return value.toLowerCase(); }
export async function GET(request: Request, { params }: { params: { sessionId: string } }) {
  return vocabularyRoute(request, (client, owner) => {
    const query = new URL(request.url).searchParams;
    if (query.size && (query.size !== 1 || query.get("round") !== "1")) throw new VocabularyInputError();
    return readCtwReview(client, owner, id(params.sessionId));
  });
}
export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  return vocabularyRoute(request, async (_client, owner) => {
    if (new URL(request.url).search) throw new VocabularyInputError();
    const session = id(params.sessionId), body = await request.json();
    if (!exactKeys(body, ["action", "command"]) || body.action !== "sync") throw new VocabularyInputError();
    const command = parseCtwReviewCommand(body.command);
    return syncCtwReview(createServiceSupabase(), owner, session, command);
  });
}
