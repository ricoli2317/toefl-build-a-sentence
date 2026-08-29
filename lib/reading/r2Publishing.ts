import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveReadingAssetUrl } from "./assets.ts";
import {
  manifestObjects,
  READING_R2_CORS_ORIGINS,
  sha256,
  type RdlAssetManifest,
  type RdlRemoteObjectVerification
} from "./r2Manifest.ts";

export type ReadingR2StoredObject = {
  bytes: Uint8Array;
  contentType: string | null;
  cacheControl: string | null;
};

export type ReadingR2ObjectStore = {
  getObject(objectKey: string): Promise<ReadingR2StoredObject | null>;
  putObject(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: string;
    cacheControl: string;
    sha256: string;
  }): Promise<void>;
};

export async function publishRdlAssetManifest(input: {
  canonicalRoot: string;
  bucketName: string;
  manifest: RdlAssetManifest;
  store: ReadingR2ObjectStore;
}): Promise<RdlAssetManifest> {
  const remoteByKey = new Map<string, RdlRemoteObjectVerification>();

  for (const object of manifestObjects(input.manifest)) {
    const canonicalBytes = await readFile(join(input.canonicalRoot, object.canonicalPath));
    assertLocalObject(object, canonicalBytes);
    let remote = await input.store.getObject(object.objectKey);
    let status: RdlRemoteObjectVerification["status"] = "verified_existing";
    if (remote === null) {
      await input.store.putObject({
        objectKey: object.objectKey,
        bytes: canonicalBytes,
        contentType: object.contentType,
        cacheControl: object.cacheControl,
        sha256: object.sha256
      });
      status = "uploaded";
      remote = await input.store.getObject(object.objectKey);
      if (remote === null) throw new Error(`${object.objectKey}: object missing immediately after upload`);
    }
    assertRemoteObject(object, remote);
    remoteByKey.set(object.objectKey, {
      status,
      sha256: sha256(remote.bytes),
      size: remote.bytes.byteLength,
      contentType: normalizeContentType(remote.contentType),
      cacheControl: remote.cacheControl ?? ""
    });
  }

  // Re-read every source after remote work so a concurrent canonical change cannot
  // produce a manifest that claims verification against stale local bytes.
  for (const object of manifestObjects(input.manifest)) {
    assertLocalObject(object, await readFile(join(input.canonicalRoot, object.canonicalPath)));
  }

  return {
    ...input.manifest,
    publishStatus: "verified",
    publication: {
      ...input.manifest.publication,
      bucketName: input.bucketName,
      checksumVerifiedCount: input.manifest.objectCount,
      contentTypeVerifiedCount: input.manifest.objectCount,
      cacheControlVerifiedCount: input.manifest.objectCount
    },
    materials: input.manifest.materials.map((material) => ({
      ...material,
      remote: {
        image: requiredRemote(remoteByKey, material.imageObjectKey),
        selectionMap: requiredRemote(remoteByKey, material.selectionMapObjectKey)
      }
    }))
  };
}

export async function verifyPublicRdlAssets(input: {
  manifest: RdlAssetManifest;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
}): Promise<{ verifiedCount: number; corsVerified: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const objects = manifestObjects(input.manifest);
  await mapWithConcurrency(objects, input.concurrency ?? 6, async (object) => {
    const response = await fetchImpl(resolveReadingAssetUrl(object.objectKey, input.baseUrl), {
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`${object.objectKey}: public GET returned ${response.status}`);
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (contentType !== object.contentType) {
      throw new Error(`${object.objectKey}: public Content-Type ${contentType || "missing"}`);
    }
    if (response.headers.get("cache-control") !== object.cacheControl) {
      throw new Error(`${object.objectKey}: public Cache-Control is missing or incorrect`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== object.size || sha256(bytes) !== object.sha256) {
      throw new Error(`${object.objectKey}: public bytes do not match canonical SHA-256`);
    }
    if (object.kind === "selectionMap") JSON.parse(new TextDecoder().decode(bytes));
  });

  const sampleKey = objects[0]?.objectKey;
  if (!sampleKey) throw new Error("Cannot verify CORS for an empty manifest");
  for (const origin of READING_R2_CORS_ORIGINS) {
    const response = await fetchImpl(resolveReadingAssetUrl(sampleKey, input.baseUrl), {
      method: "HEAD",
      headers: { Origin: origin },
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`CORS HEAD for ${origin} returned ${response.status}`);
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    if (allowedOrigin !== origin && allowedOrigin !== "*") {
      throw new Error(`CORS does not allow ${origin}`);
    }
  }
  return { verifiedCount: objects.length, corsVerified: true };
}

function assertLocalObject(
  object: ReturnType<typeof manifestObjects>[number],
  bytes: Uint8Array
) {
  if (bytes.byteLength !== object.size || sha256(bytes) !== object.sha256) {
    throw new Error(`${object.materialId}: canonical source changed after manifest preparation`);
  }
}

function assertRemoteObject(
  object: ReturnType<typeof manifestObjects>[number],
  remote: ReadingR2StoredObject
) {
  if (remote.bytes.byteLength !== object.size || sha256(remote.bytes) !== object.sha256) {
    throw new Error(`${object.objectKey}: existing remote content differs; refusing to overwrite`);
  }
  if (normalizeContentType(remote.contentType) !== object.contentType) {
    throw new Error(`${object.objectKey}: existing remote Content-Type is incorrect; refusing metadata overwrite`);
  }
  if (remote.cacheControl !== object.cacheControl) {
    throw new Error(`${object.objectKey}: existing remote Cache-Control is incorrect; refusing metadata overwrite`);
  }
}

function normalizeContentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function requiredRemote(map: Map<string, RdlRemoteObjectVerification>, key: string) {
  const remote = map.get(key);
  if (!remote) throw new Error(`${key}: missing remote verification result`);
  return remote;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

