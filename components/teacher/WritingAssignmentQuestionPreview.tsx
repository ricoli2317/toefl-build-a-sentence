"use client";

import { WritingQuestionReview } from "@/components/writing/WritingQuestionPrompt";
import {
  TEACHER_WRITING_ASSIGNMENT_AVATARS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { AcademicDiscussionAvatarsPayload } from "@/lib/academicDiscussionAvatars";
import type { WritingAssignmentQuestionSource } from "@/lib/writingAssignments";
import type { EmailQuestion, WritingQuestion, WritingTaskType } from "@/lib/writing";

export function WritingAssignmentQuestionPreview({
  question,
  questionSource,
  taskType
}: {
  question: WritingQuestion;
  questionSource: WritingAssignmentQuestionSource;
  taskType: WritingTaskType;
}) {
  const avatarState = useTeacherCachedData<AcademicDiscussionAvatarsPayload>(
    TEACHER_WRITING_ASSIGNMENT_AVATARS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments/avatars")
  );
  return (
    <div className="overflow-hidden rounded-xl border border-student-border bg-white p-3">
      <WritingQuestionReview
        academicDiscussionAvatarSource={questionSource}
        avatarMap={avatarState.data?.avatars ?? {}}
        avatarMapReady={Boolean(avatarState.data)}
        question={question}
        taskType={taskType}
      />
      {taskType === "email" ? (
        <div className="mt-3 rounded-xl border border-student-border bg-student-bg px-4 py-3 text-sm text-student-text">
          <p><strong className="mr-2">To:</strong>{(question as EmailQuestion).recipient}</p>
          <p className="mt-2"><strong className="mr-2">Subject:</strong>{(question as EmailQuestion).subject}</p>
        </div>
      ) : null}
    </div>
  );
}
