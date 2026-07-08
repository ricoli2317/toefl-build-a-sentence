"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  formatOptionChunk,
  formatPlacedChunk,
  formatTemplateText,
  isBlankToken,
  isTemplatePartSentenceStart,
  joinTextItems,
  splitSentenceTemplate,
  splitTextItems
} from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { PublicQuestion, SubmitResponse } from "@/lib/types";

type SavedAnswer = {
  chunks: string[];
  questionTimeSeconds: number;
};

type SavedAnswers = Record<string, SavedAnswer>;

type OptionChunk = {
  id: string;
  text: string;
};

const DEFAULT_TIME_SECONDS = 6 * 60 + 50;

export function PracticeSession({ setId }: { setId: string }) {
  const router = useRouter();
  const [questions, setQuestions] = useState<PublicQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentAnswer, setCurrentAnswer] = useState<Array<OptionChunk | null>>([]);
  const [savedAnswers, setSavedAnswers] = useState<SavedAnswers>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [questionStartedAt, setQuestionStartedAt] = useState(() => Date.now());
  const [remainingSeconds, setRemainingSeconds] = useState(DEFAULT_TIME_SECONDS);

  const currentQuestion = questions[currentIndex];
  const currentQuestionId = currentQuestion?.question_id;
  const currentBlankCount = currentQuestion?.blank_count ?? 0;

  useEffect(() => {
    async function loadQuestions() {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();

      const response = await fetch(`/api/sets/${setId}/questions`, {
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ""}`
        }
      });
      const responseText = await response.text();
      let payload: { questions?: PublicQuestion[]; error?: string };
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "The questions API returned an empty response." };
      } catch {
        payload = { error: "The questions API returned invalid JSON." };
      }

      if (!response.ok) {
        setError(payload.error ?? "Could not load questions.");
      } else {
        setQuestions((payload.questions ?? []) as PublicQuestion[]);
      }

      setLoading(false);
    }

    loadQuestions();
  }, [setId]);

  const submitAll = useCallback(
    async (answersToSubmit: SavedAnswers, forcedTimeSpentSeconds?: number) => {
      setSubmitting(true);
      setError("");

      try {
        const supabase = createBrowserSupabase();
        const {
          data: { session }
        } = await supabase.auth.getSession();

        const response = await fetch("/api/submissions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`
          },
          body: JSON.stringify({
            setId,
            answers: questions.map((question) => ({
              questionId: question.question_id,
              submittedOrderText: joinTextItems(
                answersToSubmit[question.question_id]?.chunks ?? []
              ),
              question_time_seconds:
                answersToSubmit[question.question_id]?.questionTimeSeconds ?? 0
            })),
            timeSpentSeconds:
              forcedTimeSpentSeconds ??
              Math.min(
                DEFAULT_TIME_SECONDS,
                Math.max(0, Math.round((Date.now() - startedAt) / 1000))
              )
          })
        });

        const responseText = await response.text();
        let payload: { attemptId?: string; error?: string } & Partial<SubmitResponse>;
        try {
          payload = responseText
            ? JSON.parse(responseText)
            : { error: "The submit API returned an empty response." };
        } catch {
          payload = { error: "The submit API returned invalid JSON." };
        }

        if (!response.ok) {
          setError(payload.error ?? "Submit failed.");
        } else if (isSubmitResponse(payload)) {
          setResult(payload);
          router.push(`/student/results/${payload.attemptId}`);
        } else {
          setError("Submit succeeded but no attempt id was returned.");
        }
      } catch {
        setError("Submit failed before the server returned a response.");
      } finally {
        setSubmitting(false);
      }
    },
    [questions, router, setId, startedAt]
  );

  useEffect(() => {
    if (loading || result || submitting || questions.length === 0) return;

    const timer = window.setInterval(() => {
      setRemainingSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading, questions.length, result, submitting]);

  useEffect(() => {
    if (remainingSeconds !== 0 || loading || result || submitting || questions.length === 0) {
      return;
    }

    const timeoutAnswers =
      currentQuestionId && !savedAnswers[currentQuestionId]
        ? {
            ...savedAnswers,
            [currentQuestionId]: {
              chunks: [],
              questionTimeSeconds: elapsedQuestionSeconds(questionStartedAt)
            }
          }
        : savedAnswers;

    submitAll(timeoutAnswers, DEFAULT_TIME_SECONDS);
  }, [
    currentQuestionId,
    loading,
    questions.length,
    questionStartedAt,
    remainingSeconds,
    result,
    savedAnswers,
    submitting,
    submitAll
  ]);

  const optionChunks = useMemo(
    () =>
      currentQuestion
        ? splitTextItems(currentQuestion.options_text).map((text, index) => ({
            id: `${currentQuestion.question_id}-${index}`,
            text
          }))
        : [],
    [currentQuestion]
  );

  useEffect(() => {
    if (!currentQuestionId) return;
    setCurrentAnswer(Array.from({ length: currentBlankCount }, () => null));
    setQuestionStartedAt(Date.now());
  }, [currentQuestionId, currentBlankCount]);

  const selectedIds = new Set(
    currentAnswer.flatMap((chunk) => (chunk ? [chunk.id] : []))
  );
  const isCurrentFilled =
    Boolean(currentQuestion) &&
    currentAnswer.length === currentQuestion.blank_count &&
    currentAnswer.every(Boolean);
  const isLastQuestion = currentIndex === questions.length - 1;

  function dropChunk(blankIndex: number, chunkId: string) {
    if (!currentQuestion || result || submitting) return;
    const chunk = optionChunks.find((item) => item.id === chunkId);
    if (!chunk) return;

    setCurrentAnswer((answer) => {
      const usedInAnotherBlank = answer.some(
        (item, index) => index !== blankIndex && item?.id === chunk.id
      );
      if (usedInAnotherBlank) return answer;

      const next = [...answer];
      next[blankIndex] = chunk;
      return next;
    });
  }

  function removeAnswer(index: number) {
    if (result || submitting) return;
    setCurrentAnswer((answer) => {
      const next = [...answer];
      next[index] = null;
      return next;
    });
  }

  async function confirmCurrentQuestion() {
    if (!currentQuestion || !isCurrentFilled) return;

    const nextAnswers = {
      ...savedAnswers,
      [currentQuestion.question_id]: {
        chunks: currentAnswer.map((chunk) => chunk?.text ?? ""),
        questionTimeSeconds: elapsedQuestionSeconds(questionStartedAt)
      }
    };

    setSavedAnswers(nextAnswers);

    if (isLastQuestion) {
      await submitAll(nextAnswers);
      return;
    }

    setCurrentIndex((index) => index + 1);
  }

  if (loading) {
    return <p className="text-sm text-ink/70">Loading questions...</p>;
  }

  if (error && questions.length === 0) {
    return <p className="font-semibold text-coral">{error}</p>;
  }

  if (!currentQuestion) {
    return <p className="rounded-lg border border-line bg-white p-5">No questions found.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-white px-4 py-3 shadow-sm">
        <div>
          <p className="text-sm font-semibold text-ocean">
            Question {currentIndex + 1}/{questions.length}
          </p>
          {result ? (
            <p className="mt-1 text-lg font-bold">
              Score: {result.correctCount}/{result.total}
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-line bg-paper px-4 py-2 text-right">
          <p className="text-xs font-semibold uppercase text-ink/50">Time left</p>
          <p className="font-mono text-xl font-bold">{formatTime(remainingSeconds)}</p>
        </div>
      </div>

      {error ? <p className="font-semibold text-coral">{error}</p> : null}

      <article className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gold">
          Question {currentQuestion.question_order}
        </p>
        <h2 className="mt-1 text-xl font-bold">{currentQuestion.prompt}</h2>

        <div className="mt-6 text-lg leading-10">
          <SentenceTemplate
            answers={currentAnswer}
            disabled={Boolean(result) || submitting}
            onDropChunk={dropChunk}
            onRemoveAnswer={removeAnswer}
            template={currentQuestion.sentence_template}
          />
        </div>

        <div className="mt-6">
          <div className="mt-3 flex flex-wrap justify-center gap-3 text-center">
            {optionChunks.map((chunk) => {
              const isUsed = selectedIds.has(chunk.id);

              return (
                <button
                  aria-disabled={isUsed || result !== null || submitting}
                  className={`inline-flex min-h-12 items-center justify-center rounded-md border px-4 py-2 text-base font-semibold ${
                    isUsed
                      ? "cursor-not-allowed border-ocean/30 bg-paper text-ink/55 opacity-70 shadow-inner"
                      : "border-line bg-white hover:border-ocean disabled:cursor-not-allowed disabled:bg-paper disabled:text-ink/35"
                  }`}
                  disabled={result !== null || submitting}
                  draggable={!isUsed && !result && !submitting}
                  key={chunk.id}
                  onDragStart={(event) => {
                    if (isUsed) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData("text/plain", chunk.id);
                  }}
                  type="button"
                >
                  {formatOptionChunk(chunk.text)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-7 flex justify-end">
          <button
            className="rounded-md bg-ink px-5 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!isCurrentFilled || submitting || Boolean(result)}
            onClick={confirmCurrentQuestion}
            type="button"
          >
            {submitting
              ? "Submitting..."
              : isLastQuestion
                ? "Submit set"
                : "Confirm question"}
          </button>
        </div>
      </article>
    </div>
  );
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function elapsedQuestionSeconds(startedAt: number) {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

function isSubmitResponse(value: Partial<SubmitResponse>): value is SubmitResponse {
  return (
    typeof value.attemptId === "string" &&
    typeof value.correctCount === "number" &&
    typeof value.total === "number" &&
    typeof value.accuracy === "number" &&
    typeof value.timeSpentSeconds === "number" &&
    Array.isArray(value.results)
  );
}

function SentenceTemplate({
  template,
  answers,
  disabled,
  onDropChunk,
  onRemoveAnswer
}: {
  template: string;
  answers: Array<OptionChunk | null>;
  disabled: boolean;
  onDropChunk: (blankIndex: number, chunkId: string) => void;
  onRemoveAnswer: (blankIndex: number) => void;
}) {
  const parts = splitSentenceTemplate(template);
  let blankIndex = 0;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {parts.map((part, index) => {
        if (isBlankToken(part)) {
          const currentBlankIndex = blankIndex;
          const answer = answers[currentBlankIndex];
          blankIndex += 1;

          return (
            <button
              aria-disabled={disabled}
              className={`inline-flex min-h-11 min-w-32 items-center justify-center rounded-md border px-4 text-base font-semibold ${
                answer
                  ? "border-ocean bg-ocean/10 text-ink"
                  : "border-dashed border-ink/40 bg-paper text-ink/40"
              }`}
              key={`${part}-${index}`}
              onDoubleClick={() => onRemoveAnswer(currentBlankIndex)}
              onDragOver={(event) => {
                if (!disabled) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (disabled) return;
                onDropChunk(currentBlankIndex, event.dataTransfer.getData("text/plain"));
              }}
              type="button"
            >
              {answer
                ? formatPlacedChunk(
                    answer.text,
                    isTemplatePartSentenceStart(parts, index)
                  )
                : `Blank ${currentBlankIndex + 1}`}
            </button>
          );
        }

        return part ? (
          <span className="whitespace-pre-wrap" key={`${part}-${index}`}>
            {formatTemplateText(part, isTemplatePartSentenceStart(parts, index))}
          </span>
        ) : null;
      })}
      {answers.slice(blankIndex).map((answer, index) => {
        const currentBlankIndex = blankIndex + index;

        return (
          <button
            aria-disabled={disabled}
            className={`inline-flex min-h-11 min-w-32 items-center justify-center rounded-md border px-4 text-base font-semibold ${
              answer
                ? "border-ocean bg-ocean/10 text-ink"
                : "border-dashed border-ink/40 bg-paper text-ink/40"
            }`}
            key={`extra-blank-${currentBlankIndex}`}
            onDoubleClick={() => onRemoveAnswer(currentBlankIndex)}
            onDragOver={(event) => {
              if (!disabled) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (disabled) return;
              onDropChunk(currentBlankIndex, event.dataTransfer.getData("text/plain"));
            }}
            type="button"
          >
            {answer
              ? formatPlacedChunk(
                  answer.text,
                  isTemplatePartSentenceStart(parts, parts.length)
                )
              : `Blank ${currentBlankIndex + 1}`}
          </button>
        );
      })}
    </p>
  );
}
