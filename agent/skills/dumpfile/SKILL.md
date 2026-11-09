---
name: dumpfile
description: Serve a local asset at a public URL. Use when media must be linked from a PR, issue, or other evidence.
disable-model-invocation: false
---

# Dumpfile

Run `cli/bin/dumpfile upload <path>` from this skill's directory to upload an asset to R2. The command prints a read-only public URL for sharing videos, images, and other files; `--json` adds the key, byte count, and content type. It installs its own dependencies with Bun on first run.

Uploads are public and subject to 30-day object-age retention once the bucket policy is provisioned. R2 deletes asynchronously, usually within 24 hours after eligibility; links are not permanent. Only upload things permitted to be shared, and keep a separate copy of evidence needed later. Expiration cannot recall downloaded copies.

For setup on a new machine, a missing or rejected config file, retention checks, or a cache-header mismatch after upload, read [README.md](README.md). Do not claim retention is deployed from a successful upload alone. Applying retention to existing uploads requires explicit owner approval.
