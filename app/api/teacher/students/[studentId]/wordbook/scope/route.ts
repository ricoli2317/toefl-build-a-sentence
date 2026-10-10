import { teacherWordbookRead } from "@/lib/lexical/teacherWordbook.server";
export const dynamic = "force-dynamic";
export function GET(request: Request, { params }: { params: { studentId: string } }) {
  return teacherWordbookRead(request, params, "scope");
}
