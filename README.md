# cloudflare-transcription

音声文字起こしアプリ - Cloudflare Workers + Containers (FFmpeg) + D1 + R2 + AI (Whisper)

## Architecture

```
Browser → Worker (Hono) → Container (FFmpeg + Node.js)
                ↓                    ↓
            D1 / R2 ←───────── Whisper AI / GPT
```

### v2.0 - Cloudflare Containers 対応

音声処理をブラウザ側の Web Audio API / FFmpeg.wasm から、サーバーサイドの **Cloudflare Containers** に移行。

| コンポーネント | 役割 |
|---|---|
| **Worker (Hono)** | 認証、ファイルアップロード (R2)、Container へジョブ投入、ステータス API |
| **Container (FFmpeg)** | 音声フォーマット変換、無音検出分割、Whisper API 呼び出し、VTT 生成、要約生成 |
| **D1** | ユーザー、文字起こし結果の保存 |
| **R2** | 音声ファイルの保存 |
| **Workers AI** | Whisper (文字起こし)、GPT-OSS-120B (要約) |

## URLs

- **Production**: https://cloudflare-transcription.umemak.workers.dev
- **GitHub**: https://github.com/umemak/cloudflare-transcription

## Features

- ✅ ユーザー登録・ログイン
- ✅ 音声ファイルアップロード (全フォーマット対応 - FFmpegがサーバーで変換)
- ✅ FFmpeg による無音検出・高精度分割 (Container内)
- ✅ Cloudflare AI Whisper 文字起こし
- ✅ GPT-OSS-120B 要約生成
- ✅ VTT (字幕) 生成・編集・ダウンロード
- ✅ 音声プレーヤー (タイムスタンプクリックでシーク)
- ✅ 非同期処理 (ブラウザを閉じても処理継続)
- ✅ リアルタイム進捗表示 (ポーリング)
- ✅ インラインフォールバック (Container 未起動時)

## Project Structure

```
├── src/
│   ├── index.tsx          # Worker entry point (Hono API + Container class)
│   ├── renderer.tsx       # JSX HTML renderer
│   └── static/            # Generated TypeScript modules from public/
├── container/
│   ├── Dockerfile         # FFmpeg + Node.js container image
│   ├── server.js          # Container HTTP server (audio processing)
│   └── package.json       # Container dependencies
├── public/static/         # Static frontend files
│   ├── app.js             # Frontend JavaScript
│   ├── auth.js            # Authentication JavaScript
│   └── style.css          # CSS styles
├── migrations/            # D1 database migrations
├── wrangler.jsonc         # Cloudflare configuration
├── vite.config.ts         # Vite build configuration
└── package.json           # Worker dependencies
```

## Deployment

```bash
# Build and deploy (requires Docker for container image)
npm run deploy

# Database migrations
npm run db:migrate:prod
```

## Container Instance Type

- **basic**: 1/4 vCPU, 1 GiB Memory, 4 GB Disk
- Max instances: 3
- Sleep after: 5 minutes idle

## Tech Stack

- **Worker**: Hono, TypeScript, Cloudflare Workers
- **Container**: Node.js 20, FFmpeg, Hono (@hono/node-server)
- **Frontend**: Vanilla JS, Tailwind CSS (CDN)
- **Storage**: Cloudflare D1, R2
- **AI**: Cloudflare Workers AI (Whisper, GPT-OSS-120B)
