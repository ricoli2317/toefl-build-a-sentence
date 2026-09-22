"use client";

import { ClipboardList, ClipboardPenLine, FileText } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_INACTIVE_STUDENTS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherFeatureCard,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { TeacherStudentOverviewList } from "@/components/teacher/TeacherStudentOverview";

type InactiveStudentsPayload = {
  students: Array<{
    studentId: string;
    studentName: string;
    lastActivityAt: string | null;
  }>;
};

/**
 * Teacher home: three static work entries followed by the shared student list.
 * The entry cards are pure navigation (no data requests, no counts, no
 * badges); the list is the same component and cache the standalone
 * /teacher/students route uses, so nothing is duplicated or refetched.
 */
export function TeacherWorkHome() {
  return (
    <div className="grid gap-6">
      <div className="grid gap-5 md:grid-cols-3">
        <TeacherFeatureCard
          description="布置写作任务并查看每名学生的完成状态。"
          href="/teacher/writing/assignments"
          icon={ClipboardList}
          title="作业管理"
        />
        <TeacherFeatureCard
          description="查看写作提交并进行 AI 或手动批改"
          href="/teacher/writing/reviews"
          icon={ClipboardPenLine}
          title="写作批改"
        />
        <TeacherFeatureCard
          description="浏览阅读/写作题库"
          href="/teacher/question-bank"
          icon={FileText}
          title="查看题目"
        />
      </div>
      <TeacherStudentOverviewList showManageActions />
    </div>
  );
}

export function TeacherInactiveStudents() {
  const { data, error, loading } = useTeacherCachedData<InactiveStudentsPayload>(
    TEACHER_INACTIVE_STUDENTS_CACHE_KEY,
    loadInactiveStudentsPayload
  );

  return (
    <div className="grid gap-4">
      {loading ? <TeacherLoadingRegion label="正在加载未活跃学生名单" /> : null}
      <TeacherCard className="overflow-hidden p-0">
        {loading ? (
          <div className="grid gap-2 p-5 sm:p-6">
            {Array.from({ length: 6 }, (_, index) => (
              <TeacherSkeleton className="h-10 w-full" key={index} />
            ))}
          </div>
        ) : error ? (
          <div className="p-5 sm:p-6"><TeacherDataError text={toTeacherErrorMessage(error)} /></div>
        ) : data && data.students.length > 0 ? (
          <table className="w-full border-separate border-spacing-0 text-left text-sm">
            <thead className="bg-student-primary-soft/55">
              <tr className="text-student-text">
                <th className="px-5 py-3 font-semibold sm:px-6">学生姓名</th>
                <th className="px-5 py-3 font-semibold sm:px-6">最近一次练习时间</th>
              </tr>
            </thead>
            <tbody>
              {data.students.map((student) => (
                <tr className="border-t border-student-border" key={student.studentId}>
                  <td className="border-t border-student-border px-5 py-3 font-semibold text-student-text sm:px-6">
                    {student.studentName}
                  </td>
                  <td className="border-t border-student-border px-5 py-3 text-student-muted sm:px-6">
                    {student.lastActivityAt
                      ? formatDateTime(student.lastActivityAt)
                      : "暂无练习记录"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-5 sm:p-6">
            <TeacherEmptyState text="近 3 天所有学生都有练习活动。" />
          </div>
        )}
      </TeacherCard>
    </div>
  );
}

async function loadInactiveStudentsPayload(): Promise<InactiveStudentsPayload> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const response = await fetch("/api/teacher/inactive-students", {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
  const payload = (await response.json().catch(() => ({}))) as
    | InactiveStudentsPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "无法加载未活跃学生名单。");
  }
  return payload as InactiveStudentsPayload;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toTeacherErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : "数据加载失败，请稍后重试。";
}
