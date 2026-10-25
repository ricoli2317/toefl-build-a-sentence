/** UUID for a business request ID; never falls back to insecure randomness. */
export function createBrowserUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("当前浏览器无法生成练习请求编号，请更换浏览器后重试。");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let diagnosticSequence = 0;

/** Non-security performance metadata must not prevent a page from rendering. */
export function createDiagnosticId() {
  try {
    return createBrowserUuid();
  } catch {
    diagnosticSequence += 1;
    return `diag-${Date.now().toString(36)}-${diagnosticSequence.toString(36)}`;
  }
}
