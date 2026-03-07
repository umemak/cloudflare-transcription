#!/bin/bash

# FFmpeg.wasmファイルをダウンロードしてpublic/staticに配置

FFMPEG_DIR="public/static/ffmpeg"
FFMPEG_MAIN_DIR="public/static"
FFMPEG_VERSION="0.12.6"
FFMPEG_MAIN_VERSION="0.12.10"
BASE_URL="https://unpkg.com/@ffmpeg/core@${FFMPEG_VERSION}/dist/umd"
MAIN_URL="https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_MAIN_VERSION}/dist/umd"

echo "📦 Downloading FFmpeg.wasm files..."

# ディレクトリ作成
mkdir -p "$FFMPEG_DIR"

# ffmpeg-core.js をダウンロード
echo "⬇️  Downloading ffmpeg-core.js..."
curl -L "${BASE_URL}/ffmpeg-core.js" -o "${FFMPEG_DIR}/ffmpeg-core.js"

# ffmpeg-core.wasm をダウンロード
echo "⬇️  Downloading ffmpeg-core.wasm..."
curl -L "${BASE_URL}/ffmpeg-core.wasm" -o "${FFMPEG_DIR}/ffmpeg-core.wasm"

# ffmpeg-core.worker.js をダウンロード
echo "⬇️  Downloading ffmpeg-core.worker.js..."
curl -L "${BASE_URL}/ffmpeg-core.worker.js" -o "${FFMPEG_DIR}/ffmpeg-core.worker.js"

# FFmpegメインスクリプトをダウンロード
echo "⬇️  Downloading ffmpeg.js (main)..."
curl -L "${MAIN_URL}/ffmpeg.js" -o "${FFMPEG_MAIN_DIR}/ffmpeg.js"

# FFmpeg Workerをダウンロード
echo "⬇️  Downloading 814.ffmpeg.js (worker)..."
curl -L "${MAIN_URL}/814.ffmpeg.js" -o "${FFMPEG_MAIN_DIR}/814.ffmpeg.js"

# FFmpegユーティリティをダウンロード
echo "⬇️  Downloading ffmpeg util (index.js)..."
curl -L "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js" -o "${FFMPEG_MAIN_DIR}/ffmpeg-util.js"

echo "✅ FFmpeg.wasm files downloaded successfully!"
echo "📁 Core files are in ${FFMPEG_DIR}/"
ls -lh "$FFMPEG_DIR"
echo "📁 Main files are in ${FFMPEG_MAIN_DIR}/"
ls -lh "$FFMPEG_MAIN_DIR" | grep ffmpeg
