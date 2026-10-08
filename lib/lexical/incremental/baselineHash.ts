import { sha256 } from "./artifacts.ts";

function decimalNumber(value: number) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? "-" : ""}${expanded}`;
}

/** Unambiguous, UTF-8 framed encoding, shared with the transaction's SQL implementation. */
export function baselineValue(value: unknown): string {
  if (value == null) return "n";
  if (typeof value === "string") return `s${Buffer.byteLength(value, "utf8")}:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite baseline number.");
    return `d${decimalNumber(value)}`;
  }
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (Array.isArray(value)) return `a${value.length}:${value.map(baselineValue).join("")}`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `o${keys.length}:${keys.map((key) => baselineValue(key) + baselineValue(record[key])).join("")}`;
  }
  throw new Error(`Unsupported baseline value ${typeof value}.`);
}

const timestampFields = new Set(["created_at", "updated_at", "last_attempted_at", "generated_at"]);

/** Match UTC Postgres JSON timestamp spelling without dropping sub-millisecond precision. */
export function normalizeBaselineRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!timestampFields.has(key) || typeof value !== "string") return [key, value];
    const match = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
    if (!match) throw new Error(`Invalid baseline timestamp ${key}.`);
    const seconds = new Date(`${match[1]}${match[3]}`).toISOString().slice(0, 19);
    const fraction = (match[2] ?? "").replace(/0+$/, "");
    return [key, `${seconds}${fraction ? `.${fraction}` : ""}+00:00`];
  }));
}

export const baselineRowsSha256 = (rows: unknown[]) => sha256(rows.map(row => baselineValue(normalizeBaselineRow(row))).join("\n"));

export const BASELINE_HASH_SQL = `
CREATE OR REPLACE FUNCTION pg_temp.lexical_baseline_value(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE kind text := jsonb_typeof(v); answer text; pair record;
BEGIN
  IF v IS NULL OR kind = 'null' THEN RETURN 'n'; END IF;
  IF kind = 'string' THEN
    answer := v #>> '{}'; RETURN 's' || octet_length(answer)::text || ':' || answer;
  END IF;
  IF kind = 'number' THEN
    answer := (v #>> '{}')::numeric::text;
    IF position('.' in answer) > 0 THEN answer := rtrim(rtrim(answer, '0'), '.'); END IF;
    IF answer::numeric = 0 THEN answer := '0'; END IF;
    RETURN 'd' || answer;
  END IF;
  IF kind = 'boolean' THEN RETURN CASE WHEN v = 'true'::jsonb THEN 'b1' ELSE 'b0' END; END IF;
  IF kind = 'array' THEN
    answer := 'a' || jsonb_array_length(v)::text || ':';
    FOR pair IN SELECT value FROM jsonb_array_elements(v) LOOP
      answer := answer || pg_temp.lexical_baseline_value(pair.value);
    END LOOP;
    RETURN answer;
  END IF;
  answer := 'o' || (SELECT count(*) FROM jsonb_object_keys(v))::text || ':';
  FOR pair IN SELECT key, value FROM jsonb_each(v) ORDER BY key COLLATE "C" LOOP
    answer := answer || pg_temp.lexical_baseline_value(to_jsonb(pair.key)) || pg_temp.lexical_baseline_value(pair.value);
  END LOOP;
  RETURN answer;
END $fn$;
`;

export function baselineRowsHashSql(table: string, alias: string, order: string, where = "true") {
  return `SELECT encode(sha256(convert_to(coalesce(string_agg(pg_temp.lexical_baseline_value(to_jsonb(${alias})), E'\\n' ORDER BY ${order}), ''), 'UTF8')), 'hex') FROM ${table} ${alias} WHERE ${where}`;
}
