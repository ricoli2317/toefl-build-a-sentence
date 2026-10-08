import type { SupabaseClient } from "@supabase/supabase-js";
import type { WordbookBatchDelete } from "./wordbookManagement.ts";
import { WordbookError } from "./wordbookContext.ts";

export async function deleteWordbookBatch(db: SupabaseClient, studentId: string, input: WordbookBatchDelete) {
  // The authenticated server supplies studentId. Domain is only a request scope:
  // every selected ID must actually belong to that owner AND that scope.
  const { data: entries, error: readError } = await db.from("student_wordbook_entries")
    .select("wordbook_entry_id,student_id,domain").eq("student_id", studentId).eq("domain", input.domain)
    .in("wordbook_entry_id", input.entryIds);
  if (readError) throw new WordbookError("WORDBOOK_BATCH_UNAVAILABLE", 503, "无法核验词条归属，请稍后重试。");
  if (!entries || entries.length !== input.entryIds.length || entries.some(e => e.student_id !== studentId
    || e.domain !== input.domain || !input.entryIds.includes(e.wordbook_entry_id)))
    throw new WordbookError("WORDBOOK_BATCH_NOT_FOUND", 409, "所选词条已变化或不属于当前词表，本次未删除任何词条。请刷新后重新选择。");
  // RPC repeats the entire check after acquiring the existing save/remove locks.
  // No per-entry DELETE requests; one RPC transaction, including FK cascades.
  const { data, error } = await db.rpc("delete_student_wordbook_entries_v1", {
    p_student_id: studentId, p_domain: input.domain, p_entry_ids: input.entryIds
  });
  if (error?.message?.includes("WORDBOOK_BATCH_NOT_FOUND"))
    throw new WordbookError("WORDBOOK_BATCH_NOT_FOUND", 409, "所选词条已变化，本次未删除任何词条。请刷新后重新选择。");
  if (error?.message?.includes("WORDBOOK_STUDENT_REQUIRED")) throw new WordbookError("STUDENT_REQUIRED", 403);
  if (error || !data || data.domain !== input.domain || data.deletedCount !== input.entryIds.length
    || !Array.isArray(data.deletedEntryIds) || data.deletedEntryIds.length !== input.entryIds.length
    || new Set(data.deletedEntryIds).size !== input.entryIds.length
    || data.deletedEntryIds.some((id: string) => !input.entryIds.includes(id)))
    throw new WordbookError("WORDBOOK_BATCH_UNAVAILABLE", 503, "批量删除尚未安装或暂时不可用，操作结果未确认。请刷新后重试。");
  return data as { domain: string; deletedCount: number; deletedEntryIds: string[] };
}
