# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7`.

Installed with `skills/install-anti-slop/scripts/install.mjs` from that commit, which copies `skills/install-anti-slop/assets/anti-slop/` unchanged.

Plugins:

- `anti-slop`: `./tools/oxlint/anti-slop/index.ts`
- `anti-slop-effect`: `./tools/oxlint/anti-slop/effect/index.ts`

## Local deviations

- None in these files. `tsconfig.json` excludes this directory because its code does not pass `noPropertyAccessFromIndexSignature` and `exactOptionalPropertyTypes`, which upstream does not enable.
