"use client";

import type {
  ReadingInsertionPositionReview,
  ReadingReviewVersion
} from "@/lib/reading/reviewPresentation";

export function ReadingFullContentComparison({ existing, incoming }: {
  existing: ReadingReviewVersion;
  incoming: ReadingReviewVersion;
}) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <ReadingVersion title="题库版本" version={existing} />
      <ReadingVersion title="来源 CSV" version={incoming} />
    </div>
  );
}

export function ReadingInsertionPosition({ position }: { position: ReadingInsertionPositionReview }) {
  return (
    <div className="rounded-lg border border-student-border bg-white p-3 text-sm">
      <p className="font-bold text-student-text">位置：{position.label}</p>
      <ContextLine label="前一句" sentence={position.previousSentence} />
      <ContextLine label="后一句" sentence={position.nextSentence} />
    </div>
  );
}

function ReadingVersion({ title, version }: { title: string; version: ReadingReviewVersion }) {
  return (
    <section className="rounded-xl border border-student-border bg-white p-4">
      <h3 className="font-bold text-student-text">{title}</h3>
      {version.material ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-student-text">{version.material.title ?? "无标题素材"}</p>
          {version.material.imageUrl ? (
            <a href={version.material.imageUrl} rel="noreferrer" target="_blank" title="点击放大素材图片">
              <img alt={`${title}素材`} className="mt-2 max-h-[32rem] w-full rounded-lg bg-white object-contain" loading="lazy" src={version.material.imageUrl} />
            </a>
          ) : null}
        </div>
      ) : null}
      {version.ctwParagraphs.length > 0 ? (
        <div className="mt-3 space-y-3 text-sm leading-7 text-student-text">
          {version.ctwParagraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      ) : null}
      {version.passage ? (
        <div className="mt-3">
          <h4 className="font-semibold text-student-text">{version.passage.title}</h4>
          <div className="mt-2 space-y-3 text-sm leading-7 text-student-text">
            {version.passage.paragraphs.map((paragraph) => (
              <PassageParagraph key={paragraph.paragraphOrder} paragraph={paragraph} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-4 space-y-4">
        {version.questions.map((question) => (
          <section className="rounded-lg bg-student-primary-soft/20 p-3 text-sm" key={question.questionOrder}>
            <h4 className="font-bold text-student-text">题目 {question.sourceQuestionNumber ?? question.questionOrder}</h4>
            <p className="mt-1 whitespace-pre-wrap text-student-text">{question.stem}</p>
            {question.detailLines.map((line, index) => <p className="mt-1 whitespace-pre-wrap text-student-muted" key={index}>{line}</p>)}
          </section>
        ))}
      </div>
    </section>
  );
}

function PassageParagraph({ paragraph }: {
  paragraph: ReadingReviewVersion["passage"] extends infer T
    ? T extends { paragraphs: Array<infer P> } ? P : never
    : never;
}) {
  if (paragraph.markers.length === 0 || paragraph.sentences.length === 0) {
    return <p>{paragraph.text}</p>;
  }
  const markersByBoundary = new Map<number, typeof paragraph.markers>();
  for (const marker of paragraph.markers) {
    markersByBoundary.set(marker.boundaryIndex, [...(markersByBoundary.get(marker.boundaryIndex) ?? []), marker]);
  }
  return (
    <p data-passage-text={paragraph.text}>
      <InsertionMarkers markers={markersByBoundary.get(0) ?? []} />
      {paragraph.sentences.map((sentence, index) => (
        <span key={sentence.sentenceOrder}>
          {index > 0 ? " " : ""}{sentence.text}
          <InsertionMarkers markers={markersByBoundary.get(index + 1) ?? []} />
        </span>
      ))}
    </p>
  );
}

function InsertionMarkers({ markers }: { markers: ReadingReviewVersion["passage"] extends infer T
  ? T extends { paragraphs: Array<{ markers: infer M }> } ? M : never
  : never }) {
  return (markers as ReadingReviewVersion["passage"] extends infer T
    ? T extends { paragraphs: Array<{ markers: infer M }> } ? M : never
    : never).map((marker) => (
    <span
      aria-label={`题目 ${marker.questionNumber} 插入位置：${marker.label}`}
      className="mx-1 inline-flex items-center gap-1 rounded bg-amber-200 px-1.5 py-0.5 font-bold text-amber-900 ring-2 ring-amber-400"
      data-boundary-index={marker.boundaryIndex}
      data-paragraph-order={marker.paragraphOrder}
      key={`${marker.questionNumber}-${marker.semanticKey}`}
      role="note"
    >
      <span aria-hidden="true">│</span>题目 {marker.questionNumber} 插入位置
    </span>
  ));
}

function ContextLine({ label, sentence }: {
  label: string;
  sentence: ReadingInsertionPositionReview["previousSentence"];
}) {
  return (
    <p className="mt-1 text-student-muted">
      <span className="font-semibold">{label}：</span>
      {sentence ? `第 ${sentence.paragraphOrder} 段第 ${sentence.sentenceOrder} 句 “${sentence.text}”` : "无"}
    </p>
  );
}
