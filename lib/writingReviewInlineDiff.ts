export type InlineRevisionDiff = {
  prefix: string;
  originalChanged: string;
  replacementChanged: string;
  suffix: string;
};

/**
 * Computes a compact visual-only diff without changing the persisted edit span.
 * Character-level common edges are expanded to word boundaries when they would
 * otherwise leave fragments such as `event` + deleted `s`.
 */
export function computeInlineRevisionDiff(
  originalText: string,
  replacementText: string
): InlineRevisionDiff {
  try {
    let prefixLength = commonPrefixLength(originalText, replacementText);
    let suffixLength = commonSuffixLength(
      originalText,
      replacementText,
      prefixLength
    );

    if (splitsWordAtPrefix(originalText, prefixLength, replacementText)) {
      prefixLength = previousTokenBoundary(
        originalText.slice(0, prefixLength)
      );
      suffixLength = commonSuffixLength(
        originalText,
        replacementText,
        prefixLength
      );
    }

    if (
      splitsWordAtSuffix(originalText, originalText.length - suffixLength) ||
      splitsWordAtSuffix(replacementText, replacementText.length - suffixLength)
    ) {
      suffixLength = shrinkSuffixToTokenBoundary(
        originalText,
        replacementText,
        suffixLength
      );
    }

    const originalEnd = originalText.length - suffixLength;
    const replacementEnd = replacementText.length - suffixLength;
    return {
      prefix: originalText.slice(0, prefixLength),
      originalChanged: originalText.slice(prefixLength, originalEnd),
      replacementChanged: replacementText.slice(prefixLength, replacementEnd),
      suffix: originalText.slice(originalEnd)
    };
  } catch {
    return {
      prefix: "",
      originalChanged: originalText,
      replacementChanged: replacementText,
      suffix: ""
    };
  }
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number) {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (
    length < limit &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function splitsWordAtPrefix(left: string, index: number, right: string) {
  if (index <= 0) return false;
  return [left, right].some(
    (value) =>
      index < value.length &&
      isWordCharacter(value[index - 1]) &&
      isWordCharacter(value[index])
  );
}

function splitsWordAtSuffix(value: string, index: number) {
  return (
    index > 0 &&
    index < value.length &&
    isWordCharacter(value[index - 1]) &&
    isWordCharacter(value[index])
  );
}

function previousTokenBoundary(prefix: string) {
  let index = prefix.length;
  while (index > 0 && isWordCharacter(prefix[index - 1])) index -= 1;
  return index;
}

function shrinkSuffixToTokenBoundary(
  originalText: string,
  replacementText: string,
  suffixLength: number
) {
  let length = suffixLength;
  while (length > 0) {
    const originalIndex = originalText.length - length;
    const replacementIndex = replacementText.length - length;
    if (
      !splitsWordAtSuffix(originalText, originalIndex) &&
      !splitsWordAtSuffix(replacementText, replacementIndex)
    ) {
      break;
    }
    length -= 1;
  }
  return length;
}

function isWordCharacter(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9_'-]/.test(value);
}
