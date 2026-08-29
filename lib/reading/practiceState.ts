import { calculateActiveWritingTimer } from "../writingTimer.ts";
import type { ReadingModule } from "./types.ts";

export type CtwCharacterPositions = string[];
export type CtwSlotAnswers = Record<string, CtwCharacterPositions>;

export type CtwSlotModel = {
  slotId: string;
  slotOrder: number;
  missingLength: number;
};

export type CtwPosition = {
  slotId: string;
  characterIndex: number;
};

export type ReadingAnswer =
  | { kind: "ctw"; slots: CtwSlotAnswers }
  | { kind: "choice"; optionId: string | null }
  | { kind: "insertion"; anchorId: string | null }
  | { kind: "sentence_selection"; sentenceId: string | null };

export type ReadingAnswerState = Record<string, ReadingAnswer>;

export function setReadingAnswer(
  state: ReadingAnswerState,
  questionId: string,
  answer: ReadingAnswer
): ReadingAnswerState {
  return { ...state, [questionId]: answer };
}

export function createCtwSlotAnswers(slots: CtwSlotModel[]): CtwSlotAnswers {
  return Object.fromEntries(slots.map((slot) => [slot.slotId, Array<string>(slot.missingLength).fill("")]));
}

export function orderedCtwPositions(slots: CtwSlotModel[]): CtwPosition[] {
  return [...slots]
    .sort((left, right) => left.slotOrder - right.slotOrder)
    .flatMap((slot) => Array.from(
      { length: slot.missingLength },
      (_, characterIndex) => ({ slotId: slot.slotId, characterIndex })
    ));
}

export function firstCtwPosition(slots: CtwSlotModel[]): CtwPosition | null {
  return orderedCtwPositions(slots)[0] ?? null;
}

export type CtwEditResult = {
  accepted: boolean;
  slots: CtwSlotAnswers;
  focus: CtwPosition;
};

export function enterCtwLetter(
  slotModels: CtwSlotModel[],
  currentSlots: CtwSlotAnswers,
  position: CtwPosition,
  input: string
): CtwEditResult {
  const positions = orderedCtwPositions(slotModels);
  const positionIndex = findCtwPositionIndex(positions, position);
  if (!/^[A-Za-z]$/.test(input) || positionIndex < 0) {
    return { accepted: false, slots: currentSlots, focus: position };
  }
  const slots = replaceCtwCharacter(slotModels, currentSlots, position, input);
  return {
    accepted: true,
    slots,
    focus: positions[(positionIndex + 1) % positions.length]
  };
}

export function backspaceCtwLetter(
  slotModels: CtwSlotModel[],
  currentSlots: CtwSlotAnswers,
  position: CtwPosition
): CtwEditResult {
  const positions = orderedCtwPositions(slotModels);
  const positionIndex = findCtwPositionIndex(positions, position);
  if (positionIndex < 0) return { accepted: false, slots: currentSlots, focus: position };

  const currentCharacter = currentSlots[position.slotId]?.[position.characterIndex] ?? "";
  if (currentCharacter) {
    return {
      accepted: true,
      slots: replaceCtwCharacter(slotModels, currentSlots, position, ""),
      focus: position
    };
  }
  if (positionIndex === 0) return { accepted: true, slots: currentSlots, focus: position };

  const previousPosition = positions[positionIndex - 1];
  return {
    accepted: true,
    slots: replaceCtwCharacter(slotModels, currentSlots, previousPosition, ""),
    focus: previousPosition
  };
}

export function deleteCtwLetter(
  slotModels: CtwSlotModel[],
  currentSlots: CtwSlotAnswers,
  position: CtwPosition
): CtwEditResult {
  const positions = orderedCtwPositions(slotModels);
  if (findCtwPositionIndex(positions, position) < 0) {
    return { accepted: false, slots: currentSlots, focus: position };
  }
  return {
    accepted: true,
    slots: replaceCtwCharacter(slotModels, currentSlots, position, ""),
    focus: position
  };
}

function findCtwPositionIndex(positions: CtwPosition[], target: CtwPosition) {
  return positions.findIndex(
    (position) => position.slotId === target.slotId && position.characterIndex === target.characterIndex
  );
}

function replaceCtwCharacter(
  slotModels: CtwSlotModel[],
  currentSlots: CtwSlotAnswers,
  position: CtwPosition,
  character: string
): CtwSlotAnswers {
  const slot = slotModels.find((candidate) => candidate.slotId === position.slotId);
  if (!slot || position.characterIndex < 0 || position.characterIndex >= slot.missingLength) return currentSlots;
  const characters = Array.from(
    { length: slot.missingLength },
    (_, index) => currentSlots[position.slotId]?.[index] ?? ""
  );
  characters[position.characterIndex] = character;
  return { ...currentSlots, [position.slotId]: characters };
}

export type ReadingNavigationState = {
  currentIndex: number;
  workspaceCount: number;
  scoringPointCount: number;
};

export function createReadingNavigation(
  module: ReadingModule,
  questionCount: number,
  scoringPointCount: number
): ReadingNavigationState {
  return {
    currentIndex: 0,
    workspaceCount: module === "ctw" ? 1 : Math.max(1, questionCount),
    scoringPointCount: Math.max(1, scoringPointCount)
  };
}

export function moveReadingNavigation(
  state: ReadingNavigationState,
  direction: -1 | 1
): ReadingNavigationState {
  return {
    ...state,
    currentIndex: Math.max(0, Math.min(state.workspaceCount - 1, state.currentIndex + direction))
  };
}

export function calculateReadingElapsedSeconds(sessionStartedAtMs: number, nowMs = Date.now()) {
  return calculateActiveWritingTimer({
    persistedElapsedSeconds: 0,
    persistedRemainingSeconds: 0,
    sessionStartedAtMs,
    writingMode: "practice",
    nowMs
  }).elapsedSeconds;
}
