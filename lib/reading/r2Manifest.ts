import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readingRdlObjectKeys, type ReadingAssetObjectKey } from "./assets.ts";

export const READING_R2_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const READING_R2_CORS_ORIGINS = [
  "https://www.tuofubas.com",
  "https://toefl-build-a-sentence.vercel.app",
  "http://localhost:3000"
] as const;

export type RdlSelectionBindingStatus = "exact_image_sha256" | "accepted_legacy_selection_source";
export type RdlRemoteObjectStatus = "uploaded" | "verified_existing";

export type RdlRemoteObjectVerification = {
  status: RdlRemoteObjectStatus;
  sha256: string;
  size: number;
  contentType: string;
  cacheControl: string;
};

export type RdlAssetManifestMaterial = {
  materialId: string;
  canonicalImagePath: string;
  canonicalSelectionMapPath: string;
  imageObjectKey: ReadingAssetObjectKey;
  selectionMapObjectKey: ReadingAssetObjectKey;
  imageSha256: string;
  selectionMapSha256: string;
  imageSize: number;
  selectionMapSize: number;
  imageContentType: "image/png";
  selectionMapContentType: "application/json";
  cacheControl: typeof READING_R2_CACHE_CONTROL;
  sourceCanonicalIdentity: {
    materialIndexAssetId: string;
    canonicalSource: unknown;
    provenance: string | null;
  };
  selectionBinding: {
    status: RdlSelectionBindingStatus;
    selectionImageFile: string;
    selectionImageSha256: string;
    canonicalImageSha256: string;
  };
  remote: {
    image: RdlRemoteObjectVerification;
    selectionMap: RdlRemoteObjectVerification;
  } | null;
};

export type RdlAssetManifest = {
  schemaVersion: 1;
  protocol: "tps-reading-rdl-assets-v1";
  generatedAt: string;
  publishStatus: "prepared" | "verified";
  objectKeyConvention: "reading/rdl/<MATERIAL_ID>/<asset-file>";
  materialCount: number;
  objectCount: number;
  source: {
    materialIndexPath: "data/material-index.json";
    materialIndexSha256: string;
    selectionCatalogPath: "data/selection-assets.json";
    selectionCatalogSha256: string;
    integrityStatus: "COMPLETE";
  };
  publication: {
    bucketName: string | null;
    publicBaseUrlType: "custom_domain" | "temporary_r2_public_url" | null;
    checksumVerifiedCount: number;
    contentTypeVerifiedCount: number;
    cacheControlVerifiedCount: number;
    publicRuntimeVerifiedCount: number;
    corsVerified: boolean;
  };
  materials: RdlAssetManifestMaterial[];
};

type MaterialIndex = {
  statistics?: { unique_materials?: number };
  materials: Array<{
    asset_id: string;
    material_final: string;
    selection_map: string;
    canonical_source?: unknown;
    provenance?: string | null;
    selection_status?: string;
  }>;
};

type SelectionCatalog = {
  assets: Array<{
    asset_id: string;
    final_image: string;
    selection_map: string;
    sha256: string;
    selection_status: string;
  }>;
};

type SelectionMap = {
  image_file?: unknown;
  image_sha256?: unknown;
};

export async function buildRdlAssetManifest(input: {
  canonicalRoot: string;
  generatedAt?: string;
  integrityStatus: "COMPLETE";
}): Promise<RdlAssetManifest> {
  const indexPath = join(input.canonicalRoot, "data/material-index.json");
  const selectionCatalogPath = join(input.canonicalRoot, "data/selection-assets.json");
  const [indexBytes, selectionCatalogBytes] = await Promise.all([
    readFile(indexPath),
    readFile(selectionCatalogPath)
  ]);
  const index = JSON.parse(indexBytes.toString("utf8")) as MaterialIndex;
  const selectionCatalog = JSON.parse(selectionCatalogBytes.toString("utf8")) as SelectionCatalog;
  if (!Array.isArray(index.materials) || index.materials.length === 0) {
    throw new Error("Material index must contain canonical materials");
  }
  if (index.statistics?.unique_materials !== undefined
    && index.statistics.unique_materials !== index.materials.length) {
    throw new Error("Material index statistics do not match its canonical material rows");
  }
  const selectionByAsset = new Map(selectionCatalog.assets.map((asset) => [asset.asset_id, asset]));
  const seen = new Set<string>();
  const materials: RdlAssetManifestMaterial[] = [];

  for (const material of [...index.materials].sort((a, b) => a.asset_id.localeCompare(b.asset_id))) {
    if (seen.has(material.asset_id)) throw new Error(`Duplicate canonical material ID: ${material.asset_id}`);
    seen.add(material.asset_id);
    if (material.selection_status !== "passed") {
      throw new Error(`${material.asset_id}: selection status is not passed`);
    }
    const selectionAsset = selectionByAsset.get(material.asset_id);
    if (!selectionAsset || selectionAsset.selection_status !== "passed") {
      throw new Error(`${material.asset_id}: missing passed selection catalog entry`);
    }
    if (selectionAsset.selection_map !== material.selection_map) {
      throw new Error(`${material.asset_id}: material index and selection catalog map paths differ`);
    }

    const imagePath = join(input.canonicalRoot, material.material_final);
    const selectionMapPath = join(input.canonicalRoot, material.selection_map);
    const [imageBytes, selectionMapBytes, imageStat, selectionMapStat] = await Promise.all([
      readFile(imagePath),
      readFile(selectionMapPath),
      stat(imagePath),
      stat(selectionMapPath)
    ]);
    if (!isPng(imageBytes)) throw new Error(`${material.asset_id}: canonical image is not a PNG`);
    let selectionMap: SelectionMap;
    try {
      selectionMap = JSON.parse(selectionMapBytes.toString("utf8")) as SelectionMap;
    } catch {
      throw new Error(`${material.asset_id}: selection map is not valid JSON`);
    }
    if (typeof selectionMap.image_file !== "string" || typeof selectionMap.image_sha256 !== "string") {
      throw new Error(`${material.asset_id}: selection map image binding metadata is missing`);
    }

    const imageSha256 = sha256(imageBytes);
    if (selectionMap.image_sha256 !== imageSha256 && selectionMap.image_sha256 !== selectionAsset.sha256) {
      throw new Error(`${material.asset_id}: selection map is not bound to canonical or accepted legacy image`);
    }
    const selectionBindingStatus: RdlSelectionBindingStatus = selectionMap.image_sha256 === imageSha256
      ? "exact_image_sha256"
      : "accepted_legacy_selection_source";
    const keys = readingRdlObjectKeys(material.asset_id);
    materials.push({
      materialId: material.asset_id,
      canonicalImagePath: material.material_final,
      canonicalSelectionMapPath: material.selection_map,
      imageObjectKey: keys.imageObjectKey,
      selectionMapObjectKey: keys.selectionMapObjectKey,
      imageSha256,
      selectionMapSha256: sha256(selectionMapBytes),
      imageSize: imageStat.size,
      selectionMapSize: selectionMapStat.size,
      imageContentType: "image/png",
      selectionMapContentType: "application/json",
      cacheControl: READING_R2_CACHE_CONTROL,
      sourceCanonicalIdentity: {
        materialIndexAssetId: material.asset_id,
        canonicalSource: material.canonical_source ?? null,
        provenance: material.provenance ?? null
      },
      selectionBinding: {
        status: selectionBindingStatus,
        selectionImageFile: selectionMap.image_file,
        selectionImageSha256: selectionMap.image_sha256,
        canonicalImageSha256: imageSha256
      },
      remote: null
    });
  }

  return {
    schemaVersion: 1,
    protocol: "tps-reading-rdl-assets-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    publishStatus: "prepared",
    objectKeyConvention: "reading/rdl/<MATERIAL_ID>/<asset-file>",
    materialCount: materials.length,
    objectCount: materials.length * 2,
    source: {
      materialIndexPath: "data/material-index.json",
      materialIndexSha256: sha256(indexBytes),
      selectionCatalogPath: "data/selection-assets.json",
      selectionCatalogSha256: sha256(selectionCatalogBytes),
      integrityStatus: input.integrityStatus
    },
    publication: {
      bucketName: null,
      publicBaseUrlType: null,
      checksumVerifiedCount: 0,
      contentTypeVerifiedCount: 0,
      cacheControlVerifiedCount: 0,
      publicRuntimeVerifiedCount: 0,
      corsVerified: false
    },
    materials
  };
}

export function manifestObjects(manifest: RdlAssetManifest) {
  return manifest.materials.flatMap((material) => [
    {
      materialId: material.materialId,
      kind: "image" as const,
      canonicalPath: material.canonicalImagePath,
      objectKey: material.imageObjectKey,
      sha256: material.imageSha256,
      size: material.imageSize,
      contentType: material.imageContentType,
      cacheControl: material.cacheControl
    },
    {
      materialId: material.materialId,
      kind: "selectionMap" as const,
      canonicalPath: material.canonicalSelectionMapPath,
      objectKey: material.selectionMapObjectKey,
      sha256: material.selectionMapSha256,
      size: material.selectionMapSize,
      contentType: material.selectionMapContentType,
      cacheControl: material.cacheControl
    }
  ]);
}

export function validateRdlAssetManifest(value: unknown): RdlAssetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RDL asset manifest must be an object");
  }
  const manifest = value as Partial<RdlAssetManifest>;
  if (manifest.schemaVersion !== 1 || manifest.protocol !== "tps-reading-rdl-assets-v1") {
    throw new Error("Unsupported RDL production asset manifest");
  }
  if (manifest.source?.integrityStatus !== "COMPLETE") {
    throw new Error("RDL asset manifest canonical integrity is not COMPLETE");
  }
  if (!Array.isArray(manifest.materials) || manifest.materials.length === 0
    || manifest.materialCount !== manifest.materials.length
    || manifest.objectCount !== manifest.materials.length * 2) {
    throw new Error("RDL asset manifest material/object counts are inconsistent");
  }
  const seen = new Set<string>();
  for (const material of manifest.materials) {
    if (seen.has(material.materialId)) throw new Error(`Duplicate manifest material: ${material.materialId}`);
    seen.add(material.materialId);
    const expectedKeys = readingRdlObjectKeys(material.materialId);
    if (material.imageObjectKey !== expectedKeys.imageObjectKey
      || material.selectionMapObjectKey !== expectedKeys.selectionMapObjectKey) {
      throw new Error(`${material.materialId}: manifest object keys violate the frozen convention`);
    }
    if (!/^[a-f0-9]{64}$/.test(material.imageSha256)
      || !/^[a-f0-9]{64}$/.test(material.selectionMapSha256)
      || !Number.isInteger(material.imageSize) || material.imageSize <= 0
      || !Number.isInteger(material.selectionMapSize) || material.selectionMapSize <= 0) {
      throw new Error(`${material.materialId}: invalid manifest checksum or size`);
    }
    if (material.imageContentType !== "image/png"
      || material.selectionMapContentType !== "application/json"
      || material.cacheControl !== READING_R2_CACHE_CONTROL) {
      throw new Error(`${material.materialId}: invalid production asset metadata`);
    }
  }
  return manifest as RdlAssetManifest;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Uint8Array) {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}
