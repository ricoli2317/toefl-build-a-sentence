import type { LexicalExpressionType } from "./generationTypes.ts";

export function normalizeLexicalSurface(value: string) {
  return value
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function normalizeLexicalExpression(value: string, expressionType: LexicalExpressionType) {
  const whitespaceNormalized = value.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  return expressionType === "proper_noun"
    ? whitespaceNormalized.toLocaleLowerCase("en-US")
    : whitespaceNormalized.toLocaleLowerCase("en-US");
}
