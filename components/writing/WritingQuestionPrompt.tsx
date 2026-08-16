"use client";

import { GraduationCap } from "lucide-react";
import Image from "next/image";
import { useEffect } from "react";
import {
  resolveAcademicDiscussionAvatar,
  resolveCustomAcademicDiscussionAvatar,
  type AcademicDiscussionAvatarMap
} from "@/lib/academicDiscussionAvatars";
import type {
  AcademicDiscussionQuestion,
  EmailQuestion,
  WritingQuestion,
  WritingTaskType
} from "@/lib/writing";

export function WritingQuestionReview({
  academicDiscussionAvatarSource,
  avatarMap,
  avatarMapReady,
  question,
  taskType
}: {
  academicDiscussionAvatarSource?: "question_bank" | "custom";
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  question: WritingQuestion;
  taskType: WritingTaskType;
}) {
  if (taskType === "email") {
    return <EmailPrompt question={question as EmailQuestion} />;
  }

  const academicQuestion = question as AcademicDiscussionQuestion;
  const customQuestion = academicDiscussionAvatarSource
    ? academicDiscussionAvatarSource === "custom"
    : academicQuestion.source_labels === "custom";
  return (
    <div className="grid gap-3">
      <AcademicPrompt
        avatarMap={avatarMap}
        avatarMapReady={avatarMapReady}
        avatarPathOverride={customQuestion
          ? resolveCustomAcademicDiscussionAvatar(academicQuestion.professor_avatar_type, "professor")
          : undefined}
        question={academicQuestion}
      />
      <section className="divide-y divide-student-border rounded-xl border border-student-border px-4">
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          avatarPathOverride={customQuestion
            ? resolveCustomAcademicDiscussionAvatar(academicQuestion.student_1_avatar_type, "student")
            : undefined}
          name={academicQuestion.student_1_name}
          response={academicQuestion.student_1_response}
        />
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          avatarPathOverride={customQuestion
            ? resolveCustomAcademicDiscussionAvatar(academicQuestion.student_2_avatar_type, "student")
            : undefined}
          name={academicQuestion.student_2_name}
          response={academicQuestion.student_2_response}
        />
      </section>
    </div>
  );
}

export function EmailPrompt({ question }: { question: EmailQuestion }) {
  return (
    <section className="writing-prompt-panel min-h-0 overflow-y-auto !px-5 !py-4 !text-[15px] !leading-[1.45]">
      <p>{question.scenario}</p>
      <p className="mt-4 font-bold">{question.task_instruction}</p>
      <ul className="mt-2 grid gap-2.5 pl-5">
        {[question.requirement_1, question.requirement_2, question.requirement_3].map(
          (requirement) => (
            <li
              className="relative pl-1.5 before:absolute before:-left-3.5 before:top-[0.65em] before:h-2 before:w-2 before:rounded-full before:bg-student-primary"
              key={requirement}
            >
              {requirement}
            </li>
          )
        )}
      </ul>
      <p className="mt-4">{question.closing_instruction}</p>
    </section>
  );
}

export function AcademicPrompt({
  avatarMap,
  avatarMapReady,
  avatarPathOverride,
  question
}: {
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  avatarPathOverride?: string | null;
  question: AcademicDiscussionQuestion;
}) {
  const avatarPath = avatarPathOverride !== undefined
    ? avatarPathOverride
    : resolveAcademicDiscussionAvatar(avatarMap, question.professor_name, "professor");
  return (
    <section className="writing-prompt-panel flex min-h-0 flex-col overflow-hidden !px-5 !py-4 !text-[15px] !leading-[1.45]">
      <div className="shrink-0">
        <p>
          Your professor is teaching a class. Write a post responding to the
          professor&apos;s question.
        </p>
        <p className="mt-3 font-bold">In your response, you should do the following:</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          <li>Express and support your opinion.</li>
          <li>Make a contribution to the discussion in your own words.</li>
        </ul>
        <p className="mt-3">An effective response will contain at least 100 words.</p>
        <div className="my-3 h-px bg-student-border" />
      </div>
      <AcademicAvatar
        avatarMapReady={avatarPathOverride !== undefined ? Boolean(avatarPath) : avatarMapReady}
        avatarPath={avatarPath}
        label={question.professor_name}
        professor
      />
      <p className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap">
        {question.professor_prompt}
      </p>
    </section>
  );
}

export function AcademicStudentPost({
  avatarMap,
  avatarMapReady,
  avatarPathOverride,
  name,
  response
}: {
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  avatarPathOverride?: string | null;
  name: string;
  response: string;
}) {
  const avatarPath = avatarPathOverride !== undefined
    ? avatarPathOverride
    : resolveAcademicDiscussionAvatar(avatarMap, name, "student");
  return (
    <article className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 py-[15px] text-[15px] leading-[1.45]">
      <AcademicAvatar
        avatarMapReady={avatarPathOverride !== undefined ? Boolean(avatarPath) : avatarMapReady}
        avatarPath={avatarPath}
        label={name}
      />
      <p className="whitespace-pre-wrap">{response}</p>
    </article>
  );
}

export function AcademicAvatar({
  avatarMapReady,
  avatarPath,
  label,
  professor = false
}: {
  avatarMapReady: boolean;
  avatarPath: string | null;
  label: string;
  professor?: boolean;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && avatarMapReady && !avatarPath) {
      console.warn(`Missing academic discussion avatar: ${label}`);
    }
  }, [avatarMapReady, avatarPath, label]);

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span
        className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-student-primary-soft text-student-primary ring-1 ring-student-primary-border ${
          professor ? "h-24 w-24" : "h-[72px] w-[72px]"
        }`}
      >
        {avatarPath ? (
          <Image
            alt={`${label} avatar`}
            className="h-full w-full rounded-full object-cover"
            fill
            sizes={professor ? "96px" : "72px"}
            src={avatarPath}
          />
        ) : professor ? (
          <GraduationCap aria-hidden="true" size={28} />
        ) : (
          <span className="text-lg font-bold">
            {label.trim().charAt(0).toUpperCase() || "?"}
          </span>
        )}
      </span>
      <strong className="text-[15px] font-semibold leading-[1.45]">{label}</strong>
    </div>
  );
}
