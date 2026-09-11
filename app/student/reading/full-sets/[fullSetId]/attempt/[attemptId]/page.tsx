import { ReadingFullSetRunner } from "@/components/reading/ReadingFullSetRunner";

export default function ReadingFullSetAttemptPage({
  params
}: {
  params: { attemptId: string; fullSetId: string };
}) {
  return (
    <ReadingFullSetRunner
      attemptId={params.attemptId}
      expectedFullSetId={params.fullSetId}
    />
  );
}
