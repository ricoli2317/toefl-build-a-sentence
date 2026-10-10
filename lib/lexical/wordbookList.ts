export type WordbookDomain = "reading" | "writing";
export type WordbookItem = {
  wordbookEntryId: string; domain: WordbookDomain; expression: string;
  lexemeIdentity: { normalizedExpression: string; expressionType: string; identityVariant: string };
  firstSavedAt: string; lastActivityAt: string; sortActivityAt: string; sourceTypes: string[];
  senses: { senseId: string; contextPos: string | null; contextMeaningZh: string; contextDefinitionEn: string | null; exampleIds: string[];
    contextForms?: { occurrenceId: string; sourceType: string; expression: string; contextPos: string | null;
      contextMeaningZh: string; contextDefinitionEn: string | null; exampleIds: string[] }[] }[];
  examples: { exampleId: string; text: string; contextKind: string; sourceBlockKind: string; extractionMethod: string; sourceTypes: string[] }[];
  enrichmentSources: { lexicalEntryId: string; associationKind: string; canonicalStatus: string; enrichmentStatus: string;
    commonSenses: unknown[] | null; derivedWords: unknown[] | null; usefulPatterns: unknown[] | null }[];
  enrichmentItems: { field: string; value: unknown; lexicalEntryIds: string[]; hasConflict: boolean }[];
};
export type WordbookList = { items: WordbookItem[]; total: number; page: number; pageSize: number };

export const WORDBOOK_HEADERS = {
  reading: ["序号", "词条", "词性", "语境义", "例句", "派生"],
  writing: ["序号", "词条", "词性", "语境义", "例句", "常见搭配"]
} as const;

// Keep each POS/meaning next to ONLY its linked examples, never zip independent
// arrays by index. Multiple senses may legitimately illustrate the same text.
export function wordbookContextRows(item: WordbookItem) {
  const examples = new Map(item.examples.map(example => [example.exampleId, example]));
  return item.senses.flatMap(sense => {
    const linked = sense.exampleIds.map(id => examples.get(id)).filter(e => e !== undefined);
    const forms = sense.contextForms?.length ? sense.contextForms : [null];
    const groups = forms.map(form => ({ form, matched: form ? linked.filter(e => form.exampleIds.includes(e.exampleId)) : linked }));
    // Older saved examples with no recoverable form association remain visible;
    // do not invent a link to one of today's occurrences or drop the example.
    const unassigned = linked.filter(e => !groups.some(g => g.matched.includes(e)));
    if (unassigned.length) groups.push({ form: null, matched: unassigned });
    return groups.flatMap(({ form, matched }) => {
      return (matched.length ? matched : [null]).map((example, index) => ({
        sense: form ? { ...sense, contextPos: form.contextPos, contextMeaningZh: form.contextMeaningZh, contextDefinitionEn: form.contextDefinitionEn } : sense,
        expression: item.expression, sources: form ? [form.sourceType] : item.sourceTypes,
        contextId: form?.occurrenceId ?? sense.senseId, example, first: index === 0, span: Math.max(1, matched.length)
      }));
    });
  });
}

const dateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("无效日期。");
  const day = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) throw new Error("无效日期。");
  return day;
};
// Convert a calendar date to IANA local midnight, not server local midnight.
// Resolve offset at the boundary itself so spring/fall DST dates are correct.
export function zonedMidnight(value: string, timezone: string) {
  const target = dateKey(value).getTime();
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(p => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const next = utc + target - wall;
    if (next === utc) return new Date(utc).toISOString();
    utc = next;
  }
  throw new Error("该时区的日期边界无法确定。");
}
export function parseWordbookQuery(params: URLSearchParams) {
  const allowed = new Set(["domain", "page", "pageSize", "sort", "date", "start", "end", "timeZone", "month"]);
  params.forEach((_value, key) => { if (!allowed.has(key) || params.getAll(key).length > 1) throw new Error("无效查询参数。"); });
  const domain = params.get("domain") ?? "reading";
  const sort = params.get("sort") ?? "newest";
  if (!["reading", "writing"].includes(domain) || !["newest", "oldest"].includes(sort)) throw new Error("无效筛选。");
  const integer = (key: string, fallback: number, max: number) => {
    const value = params.get(key) ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new Error("无效分页。");
    return Number(value);
  };
  const timeZone = params.get("timeZone") ?? "Asia/Shanghai";
  new Intl.DateTimeFormat("en", { timeZone }); // Reject invalid, never silently shift a day.
  const date = params.get("date");
  let start = params.get("start"), end = params.get("end");
  if (date && (start || end)) throw new Error("单日与范围不能同时指定。");
  if (date) start = end = date;
  if (start && !end) end = start;
  if (end && !start) throw new Error("缺少开始日期。");
  if (start && end && end < start) [start, end] = [end, start];
  const next = end ? dateKey(end) : null;
  if (next) next.setUTCDate(next.getUTCDate() + 1);
  const month = params.get("month");
  if (month && (!/^\d{4}-\d{2}$/.test(month) || !dateKey(`${month}-01`))) throw new Error("无效月份。");
  return { domain: domain as WordbookDomain, sort, page: integer("page", 1, 100000), pageSize: integer("pageSize", 20, 50), timeZone,
    startAt: start ? zonedMidnight(start, timeZone) : null,
    endAt: next ? zonedMidnight(next.toISOString().slice(0, 10), timeZone) : null, month };
}
