import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function fileExists(file: string) {
  return stat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRequiredJson<T = unknown>(file: string): Promise<T> {
  const value = await readJson<T>(file);
  if (value === null) throw new Error(`Missing required JSON artifact ${file}.`);
  return value;
}

export async function readJsonl<T = unknown>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as T) : [];
}

export function jsonl(values: unknown[]) {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}

export async function writeAtomic(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, file);
}

export async function writeJsonAtomic(file: string, value: unknown) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonlAtomic(file: string, values: unknown[]) {
  await writeAtomic(file, jsonl(values));
}

export async function sha256File(file: string) {
  return sha256(await readFile(file));
}

/**
 * Deterministic corpus-serialization used by both the plan-time JS snapshot and the
 * import-time SQL recomputation. Field order and the 0x1f separator are part of the contract.
 */
export const BASELINE_FIELD_SEPARATOR = "\u001f";

export function baselineLine(fields: Array<string | number | null | undefined>) {
  return fields.map((value) => (value === null || value === undefined ? "" : String(value))).join(BASELINE_FIELD_SEPARATOR);
}

/** Compatibility with the initial in-progress plan only; never label this digest SHA-256. */
export function legacyBaselineLinesMd5(lines: string[]) {
  return createHash("md5").update(lines.join("\n"), "utf8").digest("hex");
}
