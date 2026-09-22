"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useCurrentAccount } from "@/components/RoleGate";

export function TeacherStudentHeaderActions() {
  const { role } = useCurrentAccount();
  return (
    <div className="flex flex-wrap gap-3">
      {role === "teacher" ? (
        <Link className="teacher-button-secondary" href="/teacher/students/bind">
          绑定学生
        </Link>
      ) : null}
      <Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/students/new">
        新增学生
        <Plus aria-hidden="true" size={17} strokeWidth={2} />
      </Link>
    </div>
  );
}
