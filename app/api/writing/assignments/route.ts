import { writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET() {
  return writingJson(
    { error: "请指定月份、日期或作业范围。" },
    { status: 400 }
  );
}
