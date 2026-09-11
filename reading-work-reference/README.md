# RDL Global Dedup Reference Package

This lightweight package indexes 132 accepted May-June 2026 RDL source occurrences, grouped into 86 frozen canonical assets. It is a deduplication reference, not an asset backup. Original high-resolution images and full selection maps are intentionally excluded.

The JSON manifest is authoritative; the CSV is a convenience export. Each record includes the stable canonical asset ID, all source labels and occurrences, reviewed canonical title, text recovered directly from the existing selection map, normalized text and its SHA-256 fingerprint, exact file SHA-256, 64-bit perceptual image hash, source dimensions, preview path, original project-relative asset paths, and verification status.

In Work:

1. Compare `text_fingerprint` and `normalized_text` first.
2. Compare `perceptual_hash` next; treat it as a similarity signal, not proof.
3. For highly similar candidates, visually inspect the corresponding preview.
4. After confirming a duplicate, reuse its `canonical_asset_id`; do not re-HD the material or regenerate its selection map.
5. If this manifest is unavailable or obviously incomplete, do not claim a new RDL is globally unique. Mark it for later historical dedup review.
