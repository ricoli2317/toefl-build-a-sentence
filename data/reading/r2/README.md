# Reading R2 asset protocol

> Historical scope: the local manifest preparation, publishing, database-reference switch, and verification commands below belong to the completed Batch 1B-R2 initialization. They are retained for audit and must not become the workflow for future Reading assets. Future assets are produced under `/Users/rico/Desktop/真题/阅读/_work`, frozen under `/Users/rico/Desktop/真题/阅读/production`, and handed off/published by the separate Reading project. TPS consumes the registered object keys through its runtime resolver only.

Production RDL assets use canonical material identity, never source date or title:

```text
reading/rdl/<MATERIAL_ID>/material_final.png
reading/rdl/<MATERIAL_ID>/selection_map.json
```

Supabase reuses `reading_materials.image_asset_path` and `hitbox_data_path` as stable object-key references. Full Cloudflare URLs are not stored. `resolveReadingAssetUrl` combines either key with the server-side `READING_ASSET_BASE_URL` configuration.

Prepare and validate the local manifest without Cloudflare credentials:

```bash
pnpm prepare:reading-r2
```

Once the bucket, credentials, public access, base URL, and read-only CORS are configured, publish all frozen objects, verify every remote SHA-256, and verify the public runtime endpoint:

```bash
pnpm publish:reading-r2
```

The normal publisher works with bucket-scoped Object Read & Write credentials and verifies the existing CORS policy through the public endpoint. If an Admin Read & Write credential is deliberately used, `--configure-cors` can also apply the frozen policy before verification; elevated credentials are not required for routine publishing.

The publisher is idempotent. It skips an existing object only after its bytes, Content-Type, and Cache-Control match. Any existing checksum or metadata mismatch fails without overwriting the object.

For local publishing, keep all five variables from `.env.example` in the untracked `.env.local`. R2 credentials are publishing-only and must not be configured as `NEXT_PUBLIC_*`. The deployed Vercel runtime needs only the server-side `READING_ASSET_BASE_URL`; resolved public URLs can then be passed to browser components without exposing upload credentials.

Only after the manifest reports a fully verified 86-material/172-object release may database references be changed:

```bash
pnpm sync:reading-r2
pnpm sync:reading-r2 -- --write
pnpm verify:reading-r2
```

The first sync command is a database read-only preview. The write uses one 86-row upsert and verifies every stored object key afterward.

## Batch 1C frozen interface

Future RDL CSV rows provide `material_id` only. They must not contain a bucket name, Cloudflare hostname, image URL, selection-map URL, or object key. Canonical publishing owns the `material_id` → object-key mapping; TPS resolves those references through `READING_ASSET_BASE_URL`.
