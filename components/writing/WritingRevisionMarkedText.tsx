"use client";

import clsx from "clsx";
import { Fragment } from "react";
import {
  CONTENT_FEEDBACK_MARKER_CLASS,
  languageEditDisplayRange,
  languageEditSeverityMarkerClass,
  type WorkspaceAnnotationSegment
} from "@/lib/writingReviewWorkspaceUi";
import type { WritingRevisionComposition } from "@/lib/writingReviewRevisionComposition";
import type { WorkingLanguageEdit } from "@/lib/writingReviewWorkspace";
import type { WritingOvertimeRange } from "@/lib/writing";
import { WritingOvertimeText } from "@/components/writing/WritingOvertimeText";

/**
 * Shared read-only essay presentation. With marks visible it always keeps the
 * student's original prose and exposes only teacher-style location markers;
 * with marks hidden it renders the existing clean revision composition.
 */
export function WritingRevisionMarkedText({
  composition,
  markerSegments = composition.workspaceSegments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    originalText: segment.originalText,
    displayText: segment.originalText,
    edit: segment.kind === "language_edit" ? segment.edit : null,
    feedbackIds: segment.kind === "feedback_sentence" ? [segment.feedback.feedback_id] : [],
    feedbackStarts: segment.kind === "feedback_sentence" ? [segment.feedback.feedback_id] : []
  })),
  marksVisible = true,
  onSelectContentFeedback,
  onSelectLanguageEdit,
  overtimeRanges,
  selectedId
}: {
  composition: WritingRevisionComposition;
  markerSegments?: WorkspaceAnnotationSegment[];
  marksVisible?: boolean;
  onSelectContentFeedback?: (feedbackId: string) => void;
  onSelectLanguageEdit?: (edit: WorkingLanguageEdit, anchorRect?: DOMRect) => void;
  overtimeRanges?: WritingOvertimeRange[] | null;
  selectedId?: string | null;
}) {
  if (!marksVisible) {
    return <span className="whitespace-pre-wrap [font:inherit] [line-height:inherit]">{composition.cleanText}</span>;
  }

  const feedbackOrdinals = new Map(
    Array.from(new Set(markerSegments.flatMap((segment) => segment.feedbackStarts)))
      .map((feedbackId, index) => [feedbackId, index + 1])
  );

  return (
    <span className="whitespace-pre-wrap [font:inherit] [line-height:inherit]">
      {markerSegments.map((segment, index) => {
        const feedbackSelected = segment.feedbackIds.includes(selectedId ?? "");
        return (
          <Fragment key={`${segment.start}-${segment.end}-${index}`}>
            {segment.feedbackStarts.map((feedbackId) => (
              <button
                className={clsx(
                  CONTENT_FEEDBACK_MARKER_CLASS,
                  selectedId === feedbackId && "bg-violet-200"
                )}
                data-feedback-marker={feedbackId}
                data-feedback-id={feedbackId}
                key={feedbackId}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectContentFeedback?.(feedbackId);
                }}
                type="button"
              >
                F{feedbackOrdinals.get(feedbackId)}
              </button>
            ))}
            {segment.edit ? (
              <>
                {segment.feedbackIds.length ? (
                  <FeedbackRangeAnchor feedbackIds={segment.feedbackIds} />
                ) : null}
                <LanguageEditMarker
                  edit={segment.edit}
                  onSelect={onSelectLanguageEdit}
                  overtimeRanges={overtimeRanges}
                  selected={selectedId === segment.edit.edit_id}
                  start={segment.start}
                />
              </>
            ) : (
              <FeedbackRangeText
                feedbackIds={segment.feedbackIds}
                selected={feedbackSelected}
                sourceStart={segment.start}
                text={segment.originalText}
                overtimeRanges={overtimeRanges}
              />
            )}
          </Fragment>
        );
      })}
    </span>
  );
}

function FeedbackRangeAnchor({ feedbackIds }: { feedbackIds: string[] }) {
  return (
    <span
      aria-hidden="true"
      data-feedback-range={feedbackIds.join(" ")}
    />
  );
}

function FeedbackRangeText({
  feedbackIds,
  selected,
  sourceStart,
  overtimeRanges,
  text
}: {
  feedbackIds: string[];
  selected: boolean;
  sourceStart: number;
  text: string;
  overtimeRanges?: WritingOvertimeRange[] | null;
}) {
  const content = <WritingOvertimeText ranges={overtimeRanges} sourceStart={sourceStart} text={text} />;
  if (feedbackIds.length === 0) return content;
  return (
    <span
      className={clsx(
        "border-b border-dashed border-student-primary/45",
        selected && "bg-violet-100"
      )}
      data-feedback-range={feedbackIds.join(" ")}
    >
      {content}
    </span>
  );
}

function LanguageEditMarker({
  edit,
  onSelect,
  overtimeRanges,
  selected,
  start
}: {
  edit: WorkingLanguageEdit;
  onSelect?: (edit: WorkingLanguageEdit, anchorRect?: DOMRect) => void;
  overtimeRanges?: WritingOvertimeRange[] | null;
  selected: boolean;
  start: number;
}) {
  const displayRange = languageEditDisplayRange(edit);
  return (
    <button
      className="inline appearance-none p-0 text-left align-baseline [font:inherit] [line-height:inherit]"
      data-edit-id={edit.edit_id}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(edit, event.currentTarget.getBoundingClientRect());
      }}
      type="button"
    >
      <WritingOvertimeText ranges={overtimeRanges} sourceStart={start} text={displayRange.prefix} />
      <span className={languageEditSeverityMarkerClass(edit.severity, selected)}>
        {displayRange.changedOriginal ? (
          <WritingOvertimeText ranges={overtimeRanges} sourceStart={displayRange.sourceStart} text={displayRange.changedOriginal} />
        ) : displayRange.insertion ? "\u200b" : ""}
      </span>
      <WritingOvertimeText ranges={overtimeRanges} sourceStart={displayRange.sourceEnd} text={displayRange.suffix} />
    </button>
  );
}
