import {
  isGrammarPracticeSetId,
  isWrongQuestionsSetId
} from "@/lib/studentNavigation";

export function shouldShowCorrectAnswer({
  isCorrect,
  setId
}: {
  isCorrect: boolean;
  setId: string;
}) {
  if (isWrongQuestionsSetId(setId)) return !isCorrect;
  if (isGrammarPracticeSetId(setId)) return true;
  return false;
}
