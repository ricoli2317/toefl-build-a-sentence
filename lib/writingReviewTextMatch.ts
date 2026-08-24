function isAsciiWordCharacter(value: string | undefined) {
  return Boolean(value && /[A-Za-z0-9]/.test(value));
}

/**
 * Finds exact, case-sensitive occurrences without treating letters embedded in
 * a larger ASCII word as occurrences of a standalone word or phrase.
 *
 * For example, the standalone `i` in `i miss meeting` is a match, while the
 * `i` inside `meeting` is not. Punctuation and whitespace inside the selected
 * text remain exact and unchanged.
 */
export function findReadableExactTextOccurrences(
  source: string,
  exactText: string
) {
  if (!exactText) return [];
  const startsWithWord = isAsciiWordCharacter(exactText[0]);
  const endsWithWord = isAsciiWordCharacter(exactText.at(-1));
  const matches: number[] = [];

  for (
    let at = source.indexOf(exactText);
    at >= 0;
    at = source.indexOf(exactText, at + 1)
  ) {
    const before = at > 0 ? source[at - 1] : undefined;
    const after =
      at + exactText.length < source.length
        ? source[at + exactText.length]
        : undefined;
    if (startsWithWord && isAsciiWordCharacter(before)) continue;
    if (endsWithWord && isAsciiWordCharacter(after)) continue;
    matches.push(at);
  }

  return matches;
}
