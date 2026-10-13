#!/usr/bin/env bash
# 配布用の zip を dist/ に作成する
#   - mock-location-store-upload.zip : Chrome ウェブストアへのアップロード用（manifest.json が zip 直下）
#   - mock-location-extension.zip    : 解凍して「パッケージ化されていない拡張機能」として読み込む配布用
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
EXTENSION_FILES=(manifest.json background.js defaults.js control.html control.css control.js icons vendor LICENSE)

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/mock-location-extension"

cd "${ROOT_DIR}"
cp -R "${EXTENSION_FILES[@]}" "${DIST_DIR}/mock-location-extension/"
find "${DIST_DIR}" -name '.DS_Store' -delete

cd "${DIST_DIR}/mock-location-extension"
zip -rq "${DIST_DIR}/mock-location-store-upload.zip" .

cd "${DIST_DIR}"
zip -rq "${DIST_DIR}/mock-location-extension.zip" mock-location-extension
rm -rf "${DIST_DIR}/mock-location-extension"

echo "作成しました:"
ls -1 "${DIST_DIR}"
