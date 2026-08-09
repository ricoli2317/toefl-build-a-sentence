"use client";

import {
  formatOptionChunk,
  formatPlacedChunk,
  formatTemplateText,
  isBlankToken,
  isTemplatePartSentenceStart,
  splitSentenceTemplate
} from "@/lib/questionText";

export type QuestionWordBlock = {
  id: string;
  text: string;
};

export function QuestionDisplay({
  answers,
  disabled = false,
  hideQuestionNumber = false,
  locale = "en",
  onDropChunk,
  onRemoveAnswer,
  options,
  prompt,
  questionNumber,
  readOnly = false,
  template
}: {
  answers: Array<QuestionWordBlock | null>;
  disabled?: boolean;
  hideQuestionNumber?: boolean;
  locale?: "en" | "zh-CN";
  onDropChunk?: (blankIndex: number, chunkId: string) => void;
  onRemoveAnswer?: (blankIndex: number) => void;
  options: QuestionWordBlock[];
  prompt: string;
  questionNumber: number;
  readOnly?: boolean;
  template: string;
}) {
  const selectedIds = new Set(answers.flatMap((answer) => (answer ? [answer.id] : [])));

  return (
    <article className="student-card">
      {!hideQuestionNumber ? (
        <p className="text-sm font-semibold text-student-primary">
          {locale === "zh-CN" ? `第 ${questionNumber} 题` : `Question ${questionNumber}`}
        </p>
      ) : null}
      <h2 className="mt-1 text-xl font-bold">{prompt}</h2>
      <div className="mt-6 text-lg leading-10">
        <SentenceTemplateDisplay
          answers={answers}
          disabled={disabled}
          locale={locale}
          onDropChunk={onDropChunk}
          onRemoveAnswer={onRemoveAnswer}
          readOnly={readOnly}
          sizingChunks={options}
          template={template}
        />
      </div>
      <div className="mt-6">
        <div className="mt-3 flex flex-wrap justify-center gap-3 text-center">
          {options.map((chunk) => {
            const isUsed = selectedIds.has(chunk.id);
            const classes = `inline-flex min-h-12 items-center justify-center rounded-[10px] border px-4 py-2 text-base font-semibold transition ${
              isUsed
                ? "cursor-not-allowed border-student-primary-border bg-student-primary-soft text-student-muted opacity-70"
                : "border-student-border bg-white hover:border-student-primary disabled:cursor-not-allowed disabled:bg-student-bg disabled:text-student-muted"
            }`;

            if (readOnly) {
              return <span className={classes} key={chunk.id}>{formatOptionChunk(chunk.text)}</span>;
            }

            return (
              <button
                aria-disabled={isUsed || disabled}
                className={classes}
                disabled={disabled}
                draggable={!isUsed && !disabled}
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
    </article>
  );
}

export function SentenceTemplateDisplay({
  answers,
  disabled,
  locale = "en",
  onDropChunk,
  onRemoveAnswer,
  readOnly = false,
  sizingChunks,
  template
}: {
  answers: Array<QuestionWordBlock | null>;
  disabled: boolean;
  locale?: "en" | "zh-CN";
  onDropChunk?: (blankIndex: number, chunkId: string) => void;
  onRemoveAnswer?: (blankIndex: number) => void;
  readOnly?: boolean;
  sizingChunks: QuestionWordBlock[];
  template: string;
}) {
  const parts = splitSentenceTemplate(template);
  const blankSizingTexts = sizingChunks.flatMap((chunk) => [
    formatPlacedChunk(chunk.text, false),
    formatPlacedChunk(chunk.text, true)
  ]);
  let blankIndex = 0;

  function renderBlank(answer: QuestionWordBlock | null, currentBlankIndex: number, partIndex: number, key: string) {
    const content = answer
      ? formatPlacedChunk(answer.text, isTemplatePartSentenceStart(parts, partIndex))
      : <BlankWidthSizer texts={blankSizingTexts} />;
    const className = `practice-sentence-template__blank ${
      answer ? "practice-sentence-template__blank--filled" : "practice-sentence-template__blank--empty"
    }`;

    if (readOnly) return <span className={className} key={key}>{content}</span>;

    return (
      <button
        aria-disabled={disabled}
        aria-label={
          answer
            ? undefined
            : locale === "zh-CN"
              ? `第 ${currentBlankIndex + 1} 个空格`
              : `Blank ${currentBlankIndex + 1}`
        }
        className={className}
        key={key}
        onDoubleClick={() => onRemoveAnswer?.(currentBlankIndex)}
        onDragOver={(event) => {
          if (!disabled) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled) return;
          onDropChunk?.(currentBlankIndex, event.dataTransfer.getData("text/plain"));
        }}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <p className="practice-sentence-template">
      {parts.map((part, index) => {
        if (isBlankToken(part)) {
          const currentBlankIndex = blankIndex;
          const answer = answers[currentBlankIndex];
          blankIndex += 1;
          return renderBlank(answer, currentBlankIndex, index, `${part}-${index}`);
        }

        return part ? (
          <span key={`${part}-${index}`}>
            {formatTemplateText(part, isTemplatePartSentenceStart(parts, index))}
          </span>
        ) : null;
      })}
      {answers.slice(blankIndex).map((answer, index) => {
        const currentBlankIndex = blankIndex + index;
        return renderBlank(answer, currentBlankIndex, parts.length, `extra-blank-${currentBlankIndex}`);
      })}
    </p>
  );
}

function BlankWidthSizer({ texts }: { texts: string[] }) {
  return (
    <span aria-hidden="true" className="practice-sentence-template__blank-sizer">
      {(texts.length > 0 ? texts : ["\u00a0"]).map((text, index) => (
        <span className="practice-sentence-template__blank-sizer-text" key={`${text}-${index}`}>
          {text}
        </span>
      ))}
    </span>
  );
}
