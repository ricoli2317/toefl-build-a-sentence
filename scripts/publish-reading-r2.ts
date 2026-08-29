// Historical Batch 1B-R2 initialization publisher. Future Reading asset
// production/publishing belongs to the separate Reading project; TPS consumes
// only registered object keys through its runtime resolver.
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildRdlAssetManifest, type RdlAssetManifest } from "../lib/reading/r2Manifest.ts";
import {
  publishRdlAssetManifest,
  verifyPublicRdlAssets,
  type ReadingR2ObjectStore,
  type ReadingR2StoredObject
} from "../lib/reading/r2Publishing.ts";
import { READING_R2_CORS_ORIGINS } from "../lib/reading/r2Manifest.ts";

const execFileAsync = promisify(execFile);
const defaultCanonicalRoot = "/Users/rico/Desktop/真题/阅读/rdl-image-hitbox-prototype";
const defaultManifestPath = "data/reading/r2/rdl-asset-manifest.json";

async function main() {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish");
  const configureCors = args.includes("--configure-cors");
  const canonicalRoot = resolve(argument(args, "--canonical-root") ?? defaultCanonicalRoot);
  const manifestPath = resolve(process.cwd(), argument(args, "--manifest") ?? defaultManifestPath);
  const integrity = await canonicalIntegrity(canonicalRoot);
  let manifest = await buildRdlAssetManifest({
    canonicalRoot,
    integrityStatus: integrity.batch_completion
  });

  if (publish) {
    const config = cloudflareConfig();
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
    if (configureCors) {
      await client.send(new PutBucketCorsCommand({
        Bucket: config.bucketName,
        CORSConfiguration: {
          CORSRules: [{
            AllowedOrigins: [...READING_R2_CORS_ORIGINS],
            AllowedMethods: ["GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 86400
          }]
        }
      }));
    }
    manifest = await publishRdlAssetManifest({
      canonicalRoot,
      bucketName: config.bucketName,
      manifest,
      store: awsObjectStore(client, config.bucketName)
    });
    const publicQa = await verifyPublicRdlAssets({
      manifest,
      baseUrl: config.baseUrl
    });
    manifest = {
      ...manifest,
      publication: {
        ...manifest.publication,
        publicBaseUrlType: new URL(config.baseUrl).hostname.endsWith(".r2.dev")
          ? "temporary_r2_public_url"
          : "custom_domain",
        publicRuntimeVerifiedCount: publicQa.verifiedCount,
        corsVerified: publicQa.corsVerified
      }
    };
  }

  await writeJsonAtomic(manifestPath, manifest);
  const legacyBindings = manifest.materials.filter(
    (material) => material.selectionBinding.status === "accepted_legacy_selection_source"
  ).length;
  console.log(JSON.stringify({
    status: manifest.publishStatus,
    manifestPath,
    integrityStatus: manifest.source.integrityStatus,
    materialCount: manifest.materialCount,
    objectCount: manifest.objectCount,
    exactSelectionBindings: manifest.materialCount - legacyBindings,
    acceptedLegacySelectionBindings: legacyBindings,
    publication: manifest.publication
  }, null, 2));
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function canonicalIntegrity(canonicalRoot: string): Promise<{ batch_completion: "COMPLETE" }> {
  const { stdout } = await execFileAsync("python3", ["scripts/check_material_index_integrity.py"], {
    cwd: canonicalRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  const report = JSON.parse(stdout) as { batch_completion?: string };
  if (report.batch_completion !== "COMPLETE") {
    throw new Error(`Canonical RDL integrity is ${report.batch_completion ?? "unknown"}, not COMPLETE`);
  }
  return report as { batch_completion: "COMPLETE" };
}

function cloudflareConfig() {
  const variables = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    READING_ASSET_BASE_URL: process.env.READING_ASSET_BASE_URL
  };
  const missing = Object.entries(variables).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  }
  return {
    accountId: variables.CLOUDFLARE_ACCOUNT_ID,
    accessKeyId: variables.R2_ACCESS_KEY_ID,
    secretAccessKey: variables.R2_SECRET_ACCESS_KEY,
    bucketName: variables.R2_BUCKET_NAME,
    baseUrl: variables.READING_ASSET_BASE_URL
  } as Record<"accountId" | "accessKeyId" | "secretAccessKey" | "bucketName" | "baseUrl", string>;
}

function awsObjectStore(client: S3Client, bucketName: string): ReadingR2ObjectStore {
  return {
    async getObject(objectKey): Promise<ReadingR2StoredObject | null> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
        if (!response.Body) throw new Error(`${objectKey}: remote response has no body`);
        return {
          bytes: await response.Body.transformToByteArray(),
          contentType: response.ContentType ?? null,
          cacheControl: response.CacheControl ?? null
        };
      } catch (error) {
        const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (candidate.name === "NoSuchKey" || candidate.name === "NotFound"
          || candidate.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async putObject(input) {
      await client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: input.objectKey,
        Body: input.bytes,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
        Metadata: { sha256: input.sha256 }
      }));
    }
  };
}

async function writeJsonAtomic(path: string, value: RdlAssetManifest) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
