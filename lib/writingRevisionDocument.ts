/** Promoted verbatim from the accepted PoC paragraph/plain-text adapter. */
export function textDocument(text: string) {
  return { type: 'doc', content: text.split('\n').map(line => ({
    type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  })) };
}

export function exportDocument(doc: { forEach: (fn: (node: { textContent: string }) => void) => void }) {
  const lines: string[] = [];
  doc.forEach(node => lines.push(node.textContent));
  return lines.join('\n');
}

export function textPosition(text: string, offset: number) {
  let paragraphs = 0;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') paragraphs++;
  return 1 + offset + paragraphs;
}
