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

- ユーザー登録・ログイン
- 音声ファイルアップロード (全フォーマット対応 - FFmpegがサーバーで変換)
- FFmpeg による無音検出・高精度分割 (Container内)
- Cloudflare AI Whisper 文字起こし
- GPT-OSS-120B 要約生成
- VTT (字幕) 生成・編集・ダウンロード
- 音声プレーヤー (タイムスタンプクリックでシーク)
- 非同期処理 (ブラウザを閉じても処理継続)
- リアルタイム進捗表示 (ポーリング)
- インラインフォールバック (Container 未起動時)

## CI/CD - GitHub Actions

`main` ブランチへの push で自動デプロイされます。

### ワークフロー概要 (`.github/workflows/deploy.yml`)

```
push to main
  → npm ci (Worker deps)
  → npm run build (Vite SSR bundle)
  → wrangler deploy
      → Docker build (container/Dockerfile → FFmpeg + Node.js image)
      → Push image to Cloudflare managed registry
      → Deploy Worker + bind Container
```

### 必要な GitHub Secrets

| Secret | 説明 | 取得方法 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API トークン | Cloudflare Dashboard → My Profile → API Tokens → Create Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID | Cloudflare Dashboard → Workers & Pages → Account ID (右サイドバー) |

#### API Token に必要な権限

- **Account** - Cloudflare Container Registry: Edit
- **Account** - Workers Scripts: Edit
- **Account** - Workers R2 Storage: Edit
- **Account** - Workers KV Storage: Edit (使用する場合)
- **Account** - D1: Edit
- **Zone** - Workers Routes: Edit (カスタムドメイン使用時)

### 手動デプロイ

GitHub Actions の **Actions** タブから `Build & Deploy to Cloudflare` を選択し、`Run workflow` をクリック。

## Project Structure

```
├── .github/workflows/
│   └── deploy.yml         # GitHub Actions CI/CD
├── src/
│   ├── index.tsx          # Worker entry point (Hono API + Container class)
│   ├── renderer.tsx       # JSX HTML renderer
│   └── static/            # Generated TypeScript modules from public/
├── container/
│   ├── Dockerfile         # FFmpeg + Node.js container image
│   ├── .dockerignore      # Docker build exclusions
│   ├── server.js          # Container HTTP server (audio processing)
│   ├── package.json       # Container dependencies
│   └── package-lock.json  # Container dependency lock
├── public/static/         # Static frontend files
│   ├── app.js             # Frontend JavaScript
│   ├── auth.js            # Authentication JavaScript
│   └── style.css          # CSS styles
├── migrations/            # D1 database migrations
├── wrangler.jsonc         # Cloudflare configuration
├── vite.config.ts         # Vite build configuration
└── package.json           # Worker dependencies
```

## Local Development

```bash
# Install dependencies
npm install

# Database migrations (local)
npm run db:migrate:local

# Build and run locally
npm run dev
```

## Deployment

### Automatic (recommended)

Push to `main` branch - GitHub Actions handles everything.

### Manual

```bash
# Build and deploy (requires Docker for container image)
npm run deploy

# Database migrations (production)
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
- **CI/CD**: GitHub Actions + wrangler-action
