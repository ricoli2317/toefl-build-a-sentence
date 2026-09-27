"use client";

import Link from "next/link";
import { Network, Plus } from "lucide-react";
import { useCurrentAccount } from "@/components/RoleGate";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";

export function TeacherStudentHeaderActions({
  showClassAction = false
}: {
  /** The home list card additionally offers 新增班级; other pages keep the two
   * original buttons untouched. */
  showClassAction?: boolean;
} = {}) {
  const { role } = useCurrentAccount();
  return (
    <div className="flex flex-wrap gap-3">
      {role === "teacher" ? (
        <Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/students/bind">
          绑定学生
          <Network aria-hidden="true" size={17} strokeWidth={2} />
        </Link>
      ) : null}
      <Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/students/new">
        新增学生
        <Plus aria-hidden="true" size={17} strokeWidth={2} />
      </Link>
      {role === "teacher" && showClassAction ? (
        <Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/classes/new">
          新增班级
          <TeacherClassIcon aria-hidden="true" size={17} strokeWidth={2} />
        </Link>
      ) : null}
    </div>
  );
}
