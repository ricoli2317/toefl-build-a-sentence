const RDL_MATERIAL_ID_PATTERN = /^RDL-[0-9]{3}$/;
const READING_RDL_PREFIX = "reading/rdl";

declare const readingAssetObjectKeyBrand: unique symbol;
declare const resolvedReadingAssetUrlBrand: unique symbol;

export type ReadingAssetObjectKey = string & {
  readonly [readingAssetObjectKeyBrand]: true;
};

export type ResolvedReadingAssetUrl = string & {
  readonly [resolvedReadingAssetUrlBrand]: true;
};

export type ReadingRdlObjectKeys = {
  imageObjectKey: ReadingAssetObjectKey;
  selectionMapObjectKey: ReadingAssetObjectKey;
};

export function readingRdlObjectKeys(materialId: string): ReadingRdlObjectKeys {
  if (!RDL_MATERIAL_ID_PATTERN.test(materialId)) {
    throw new Error(`Invalid canonical RDL material ID: ${materialId}`);
  }
  return {
    imageObjectKey: asReadingAssetObjectKey(
      `${READING_RDL_PREFIX}/${materialId}/material_final.png`
    ),
    selectionMapObjectKey: asReadingAssetObjectKey(
      `${READING_RDL_PREFIX}/${materialId}/selection_map.json`
    )
  };
}

export function asReadingAssetObjectKey(value: string): ReadingAssetObjectKey {
  if (value.length === 0 || value.startsWith("/") || value.endsWith("/")) {
    throw new Error("Reading asset object key must not start or end with a slash");
  }
  if (value.includes("\\") || value.includes("?") || value.includes("#")) {
    throw new Error("Reading asset object key contains URL-only or filesystem characters");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Reading asset object key contains an invalid path segment");
  }
  return value as ReadingAssetObjectKey;
}

export function resolveReadingAssetUrl(
  objectKey: string,
  baseUrl = process.env.READING_ASSET_BASE_URL
): ResolvedReadingAssetUrl {
  const key = asReadingAssetObjectKey(objectKey);
  if (!baseUrl) {
    throw new Error("Missing READING_ASSET_BASE_URL");
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error("READING_ASSET_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (!['http:', 'https:'].includes(parsedBase.protocol)) {
    throw new Error("READING_ASSET_BASE_URL must use HTTP or HTTPS");
  }
  if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("READING_ASSET_BASE_URL must not contain credentials, query, or fragment");
  }

  const normalizedBase = parsedBase.toString().replace(/\/+$/, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${normalizedBase}/${encodedKey}` as ResolvedReadingAssetUrl;
}

