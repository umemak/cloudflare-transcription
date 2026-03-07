#!/bin/bash

# FFmpeg.wasmファイルをダウンロードしてpublic/static/ffmpegに配置

FFMPEG_DIR="public/static/ffmpeg"
FFMPEG_VERSION="0.12.6"
BASE_URL="https://unpkg.com/@ffmpeg/core@${FFMPEG_VERSION}/dist/umd"

echo "📦 Downloading FFmpeg.wasm files..."

# ディレクトリ作成
mkdir -p "$FFMPEG_DIR"

# ffmpeg-core.js をダウンロード
echo "⬇️  Downloading ffmpeg-core.js..."
curl -L "${BASE_URL}/ffmpeg-core.js" -o "${FFMPEG_DIR}/ffmpeg-core.js"

# ffmpeg-core.wasm をダウンロード
echo "⬇️  Downloading ffmpeg-core.wasm..."
curl -L "${BASE_URL}/ffmpeg-core.wasm" -o "${FFMPEG_DIR}/ffmpeg-core.wasm"

# ffmpeg-core.worker.js をダウンロード（必要な場合）
echo "⬇️  Downloading ffmpeg-core.worker.js..."
curl -L "${BASE_URL}/ffmpeg-core.worker.js" -o "${FFMPEG_DIR}/ffmpeg-core.worker.js"

echo "✅ FFmpeg.wasm files downloaded successfully!"
echo "📁 Files are in ${FFMPEG_DIR}/"
ls -lh "$FFMPEG_DIR"
