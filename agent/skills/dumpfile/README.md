# Dumpfile client

`cli/` is the upload client for Dumpfile. A Cloudflare Worker (`dumpfile-sign`) authorizes one immutable object in the R2 bucket `dumpfile-prod`, the client uploads the bytes directly to R2, and it prints the public URL only after a `HEAD` request verifies the object's metadata.

This directory holds the client only. The Worker, the bucket, the setup wizard, token rotation, and retention live with the infrastructure source in the pi repository under `cli/dumpfile`, whose README is the operations runbook. `cli/src/cli.ts` and `cli/src/contract.ts` are copies of the files there.

## Set up a machine

1. Install [Bun](https://bun.sh). `cli/bin/dumpfile` runs the client with it and installs the client's one dependency, `typebox`, on first run.
2. Create `${XDG_CONFIG_HOME:-$HOME/.config}/dumpfile/config.env` with mode `0600`. Copy it from a machine that has it. Rotating the token with the setup wizard in the infrastructure repository replaces it on every machine:

   ```dotenv
   DUMPFILE_API_URL=https://upload.drsh4dow.dev
   DUMPFILE_R2_ACCOUNT_ID=<Cloudflare account ID>
   DUMPFILE_TOKEN=<bearer token>
   ```

   The token is a secret, so the file stays out of the pi harness repository. The client rejects a config file that group or other users can read; fix that with `chmod 600`. The `DUMPFILE_API_URL`, `DUMPFILE_R2_ACCOUNT_ID`, and `DUMPFILE_TOKEN` environment variables override the file, and `DUMPFILE_CONFIG_FILE` selects another file.

3. Optionally put the command on `PATH`: `ln -s ~/.pi/agent/skills/dumpfile/cli/bin/dumpfile ~/.local/bin/dumpfile`.
4. Check it: `cli/bin/dumpfile --help`, then upload a file that is safe to publish.

## Upload

```sh
cli/bin/dumpfile upload ./artifacts/checkout.png
cli/bin/dumpfile upload ./artifacts/checkout.webm --json
```

The plain command writes progress to stderr and one verified URL to stdout. JSON mode returns the key, URL, byte count, content type, and verification status.

PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, QuickTime, MP3, M4A, Ogg, WAV, FLAC, PDF, and plain text render inline. Every other extension uploads as `application/octet-stream` with `Content-Disposition: attachment`. The single-`PUT` limit is 5 GiB.

Inspect evidence for credentials and personal data before publishing it.

## Retention

Uploads are public and immutable, with a 30-day object-age retention policy once it is provisioned on the bucket. R2 normally deletes eligible objects within another 24 hours, but deletion can take longer. A successful upload does not prove the policy exists: checking it needs Wrangler credentials and the retention tool in the infrastructure repository. Applying retention to existing uploads deletes every object older than 30 days, so it needs the account owner's explicit approval first.

## Cache-header mismatch

New uploads carry `Cache-Control: no-store`, and the client verifies it after upload. When the upload succeeds but verification fails on that header, this client and the deployed Worker disagree on the contract. Do not retry: each attempt leaves another public object. Copy `src/cli.ts` and `src/contract.ts` again from the infrastructure repository, or redeploy the Worker from there, then run the tests.

## Tests

```sh
cd cli && bun install && node --test --test-reporter=dot test/*.test.ts
```

The tests need no credentials. They cover authentication, request parsing, key generation, SigV4 metadata binding, forced downloads, PUT retry, public verification, file permissions, size rejection, and secret redaction.
