export type CsvRecord = Record<string, string>;

export type ParsedCsv = {
  headers: string[];
  rows: CsvRecord[];
};

export function parseCsv(text: string): CsvRecord[] {
  return parseCsvDocument(text).rows;
}

export function parseCsvDocument(
  text: string,
  { trimValues = true }: { trimValues?: boolean } = {}
): ParsedCsv {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
  );
  const records = rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => {
          const value = row[index] ?? "";
          return [header, trimValues ? value.trim() : value];
        })
      )
    );

  return { headers, rows: records };
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}
