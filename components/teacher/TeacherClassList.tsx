"use client";

import Link from "next/link";
import { UsersRound } from "lucide-react";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import {
  TEACHER_CLASSES_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherDataError,
  TeacherEmptyState,
  TeacherSkeleton,
  TeacherTextLink
} from "@/components/teacher/TeacherUI";
import { SubjectBindingBadges } from "@/components/teacher/SubjectBadges";
import {
  STUDENT_BINDING_DOMAINS,
  type StudentBindingDomain
} from "@/lib/studentBindings";
import { filterClassSummariesByName, type TeacherClassSummary } from "@/lib/teacherClasses";
import {
  applyClassSubjectsMutation,
  updateTeacherClassSubjectsRequest
} from "@/lib/teacherClassClient";
import { teacherApiFetch } from "@/lib/teacherClientApi";

type ClassListResponse = { classes: TeacherClassSummary[] };

/**
 * 班级列表 of the home list card. One row per class with the minimum the card
 * needs; member counts come from the list payload and never trigger per-class
 * requests. The 授课科目 column edits the VIEWING teacher's own subject set
 * (owner: the class row; bound teacher: their own link row); removing a
 * subject never releases a member's binding.
 */
export function TeacherClassList({ query }: { query: string }) {
  const cache = useTeacherDataCache();
  const { data, error, loading } = useTeacherCachedData<ClassListResponse>(
    TEACHER_CLASSES_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes")
  );

  async function mutateClassSubjects(
    entry: TeacherClassSummary,
    next: StudentBindingDomain[]
  ) {
    const payload = await updateTeacherClassSubjectsRequest(entry.class_id, next);
    applyClassSubjectsMutation(cache, payload);
  }

  async function addClassSubject(entry: TeacherClassSummary, domain: StudentBindingDomain) {
    await mutateClassSubjects(
      entry,
      STUDENT_BINDING_DOMAINS.filter(
        (item) => item === domain || entry.subjects.includes(item)
      )
    );
  }

  async function removeClassSubject(entry: TeacherClassSummary, domain: StudentBindingDomain) {
    await mutateClassSubjects(
      entry,
      entry.subjects.filter((item) => item !== domain)
    );
  }

  if (loading) return <ClassTableSkeleton />;
  if (error) {
    return (
      <div className="px-6 pb-6 pt-4">
        <TeacherDataError text={toClassListErrorMessage(error)} />
      </div>
    );
  }

  const classes = filterClassSummariesByName(data?.classes ?? [], query);
  if (classes.length === 0) {
    return (
      <div className="px-6 pb-6 pt-4">
        <TeacherEmptyState text={query.trim() ? "没有找到匹配的班级。" : "暂无班级。"} />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">班级</th>
            <th className="px-3 py-3 font-medium">授课科目</th>
            <th className="px-3 py-3 font-medium">学生人数</th>
            <th className="w-px whitespace-nowrap px-3 py-3 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((entry) => (
            <tr
              className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45"
              key={entry.class_id}
            >
              <td className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                    <TeacherClassIcon aria-hidden="true" size={20} strokeWidth={1.9} />
                  </span>
                  <TeacherTextLink href={`/teacher/classes/${encodeURIComponent(entry.class_id)}`}>
                    {entry.name}
                  </TeacherTextLink>
                </div>
              </td>
              <td className="px-3 py-3">
                {entry.subjects.length > 0 ? (
                  <SubjectBindingBadges
                    actionFallback="授课科目更新失败，请稍后重试。"
                    domains={entry.subjects}
                    onAddDomain={(domain) => addClassSubject(entry, domain)}
                    onRemoveDomain={(domain) => removeClassSubject(entry, domain)}
                    removeBlockedReason={() =>
                      // The class subject set is constrained to 1..2 by the
                      // database; removing the last subject is not possible.
                      entry.subjects.length <= 1 ? "班级至少保留一个授课科目。" : null
                    }
                    removeSubjectLabel="该班级"
                  />
                ) : (
                  <span className="text-student-muted">—</span>
                )}
              </td>
              <td className="px-3 py-3 tabular-nums text-student-text">
                <span className="inline-flex items-center gap-2">
                  <UsersRound aria-hidden="true" className="text-student-muted" size={16} strokeWidth={1.9} />
                  {entry.member_count} 人
                </span>
              </td>
              <td className="w-px whitespace-nowrap px-3 py-3 text-right">
                <div className="flex flex-nowrap items-center justify-end gap-2">
                  <Link
                    className="teacher-button-secondary"
                    href={`/teacher/writing/assignments?view=class&classId=${encodeURIComponent(entry.class_id)}`}
                  >
                    作业管理
                  </Link>
                  <Link
                    className="teacher-button-secondary"
                    href={`/teacher/classes/${encodeURIComponent(entry.class_id)}`}
                  >
                    查看详情
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassTableSkeleton() {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">班级</th>
            <th className="px-3 py-3 font-medium">授课科目</th>
            <th className="px-3 py-3 font-medium">学生人数</th>
            <th className="px-3 py-3 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 4 }, (_, index) => (
            <tr className="border-b border-student-border" key={index}>
              <td className="px-3 py-3"><TeacherSkeleton className="h-10 w-40" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-20" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-12" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-9 w-40" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toClassListErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : "班级列表加载失败，请稍后重试。";
}
