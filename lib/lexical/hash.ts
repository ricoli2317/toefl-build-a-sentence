import { createHash } from "node:crypto";

/** SHA-256 over the UTF-8 bytes of the exact canonical JavaScript string. */
export function canonicalSourceTextHash(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
