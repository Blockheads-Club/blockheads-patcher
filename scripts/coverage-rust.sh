#!/usr/bin/env bash
# 100% line + function coverage gate for the Rust crates (cargo-llvm-cov). Never lower the limits.
#   cargo install cargo-llvm-cov   (once)
# app/src-tauri needs the frontend built once (tauri-build reads frontendDist): `bun run build`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

# Process entry glue that cannot run under unit tests (real generate_context!() + native event loop).
# Both files are logic-free by contract; see their module docs.
ignore='src/(main|entry)\.rs$'

echo "== tauri-plugin-apk-tools"
cargo llvm-cov --manifest-path "$root/plugins/tauri-plugin-apk-tools/Cargo.toml" \
  --fail-under-lines 100 --fail-under-functions 100 "$@"

echo "== blockheads-patcher (app/src-tauri)"
cargo llvm-cov --manifest-path "$root/app/src-tauri/Cargo.toml" \
  --ignore-filename-regex "$ignore" \
  --fail-under-lines 100 --fail-under-functions 100 "$@"
