import { asReadingAssetObjectKey } from "./assets.ts";
import {
  parseRdlSelectionMap,
  type RdlSelectionMap
} from "./rdlSelection.ts";
import type { StudentRdlAssetLoaderInput } from "./studentPractice.ts";

type VerifiedWrongbookRdlAsset = {
  imageSha256: string;
  selectionMap: RdlSelectionMap;
};

const verifiedBindings = new Map<string, Promise<VerifiedWrongbookRdlAsset>>();
const MAX_VERIFIED_BINDINGS = 64;

/**
 * Full Set wrongbook-only RDL loader.
 *
 * reading_materials.binding_status is written only after the immutable R2 pair
 * has been publication-verified. The pair's object keys plus the row version
 * form the cache identity, so a repointed/rebound asset cannot reuse stale map
 * data. We still fetch and strictly parse the selection map, while the browser
 * is the sole consumer that downloads the immutable PNG bytes.
 */
export async function loadFullSetWrongbookRdlAssets(
  input: StudentRdlAssetLoaderInput
): Promise<VerifiedWrongbookRdlAsset> {
  const identity = immutableBindingIdentity(input);
  const cached = verifiedBindings.get(identity);
  input.profile?.record(
    cached ? "wrongbook RDL immutable binding cache hit" : "wrongbook RDL immutable binding cache miss",
    0,
    ["practice_asset_metadata"],
    cached ? 1 : 0
  );
  if (cached) return cached;

  const promise = loadSelectionBinding(input).catch((error) => {
    if (verifiedBindings.get(identity) === promise) verifiedBindings.delete(identity);
    throw error;
  });
  verifiedBindings.set(identity, promise);
  trimVerifiedBindings();
  return promise;
}

export function clearFullSetWrongbookRdlAssetCacheForTests() {
  verifiedBindings.clear();
}

async function loadSelectionBinding(
  input: StudentRdlAssetLoaderInput
): Promise<VerifiedWrongbookRdlAsset> {
  const selectionMapText = input.profile
    ? await input.profile.measure(
        "wrongbook RDL selection map fetch",
        ["wrongbook RDL immutable binding cache miss"],
        () => fetchSelectionMapText(input.selectionMapUrl),
        (value) => new TextEncoder().encode(value).length
      )
    : await fetchSelectionMapText(input.selectionMapUrl);
  const selectionMapJson = input.profile
    ? input.profile.measureSync(
        "wrongbook RDL selection map JSON parse",
        ["wrongbook RDL selection map fetch"],
        () => JSON.parse(selectionMapText) as unknown
      )
    : JSON.parse(selectionMapText) as unknown;
  const selectionMap = input.profile
    ? input.profile.measureSync(
        "wrongbook RDL selection map contract validation",
        ["wrongbook RDL selection map JSON parse"],
        () => parseRdlSelectionMap(selectionMapJson),
        (value) => value.lines.length
      )
    : parseRdlSelectionMap(selectionMapJson);
  const result = input.profile
    ? input.profile.measureSync(
        "wrongbook RDL immutable binding validation",
        ["wrongbook RDL selection map contract validation"],
        () => validateImmutableBinding(input, selectionMap),
        () => 1
      )
    : validateImmutableBinding(input, selectionMap);
  input.profile?.record(
    "wrongbook RDL server PNG fetch (not required)",
    0,
    ["wrongbook RDL immutable binding validation"],
    0
  );
  return result;
}

async function fetchSelectionMapText(url: string) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`RDL runtime selection map unavailable: ${response.status}`);
  }
  return response.text();
}

function immutableBindingIdentity(input: StudentRdlAssetLoaderInput) {
  const imageObjectKey = asReadingAssetObjectKey(input.imageObjectKey);
  const selectionMapObjectKey = asReadingAssetObjectKey(input.selectionMapObjectKey);
  const assetVersion = input.assetVersion.trim();
  if (!assetVersion || !Number.isFinite(Date.parse(assetVersion))) {
    throw new Error("RDL immutable binding has no valid row version");
  }
  const materialPrefix = `reading/rdl/${input.materialId}/`;
  if (!imageObjectKey.startsWith(materialPrefix) || !selectionMapObjectKey.startsWith(materialPrefix)) {
    throw new Error("RDL immutable binding object keys do not match the material identity");
  }
  if (!imageObjectKey.endsWith("/material_final.png") || !selectionMapObjectKey.endsWith("/selection_map.json")) {
    throw new Error("RDL immutable binding object keys do not identify the canonical asset pair");
  }
  return JSON.stringify([
    input.materialId,
    imageObjectKey,
    selectionMapObjectKey,
    assetVersion,
    input.imageUrl,
    input.selectionMapUrl
  ]);
}

function validateImmutableBinding(
  input: StudentRdlAssetLoaderInput,
  selectionMap: RdlSelectionMap
): VerifiedWrongbookRdlAsset {
  const imageFile = input.imageObjectKey.split("/").pop() ?? "";
  if (imageFile !== "material_final.png") {
    throw new Error("RDL immutable image object is not canonical");
  }
  return {
    imageSha256: selectionMap.imageSha256,
    selectionMap
  };
}

function trimVerifiedBindings() {
  while (verifiedBindings.size > MAX_VERIFIED_BINDINGS) {
    const oldest = verifiedBindings.keys().next().value as string | undefined;
    if (!oldest) return;
    verifiedBindings.delete(oldest);
  }
}
