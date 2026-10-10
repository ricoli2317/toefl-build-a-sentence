import { teacherWordbookRead } from "@/lib/lexical/teacherWordbook.server";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { studentId: string } }) {
  return teacherWordbookRead(request, params, "history-dates");
}
