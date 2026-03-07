# 🎙️ 音声文字起こしアプリ

Cloudflare Workers上で動作する音声文字起こしアプリケーション。音声ファイルをアップロードすると、Cloudflare AIのWhisperモデルを使って自動で文字起こしを行います。

## プロジェクト概要

- **名前**: Audio Transcription App (webapp)
- **目的**: 音声ファイルを簡単に文字起こしできるWebアプリケーション
- **主な機能**:
  - 音声ファイルのアップロード
  - Cloudflare AI（Whisper）による自動文字起こし
  - 文字起こし履歴の表示と管理
  - 文字起こし結果の保存と削除

## 現在完了している機能

✅ 音声ファイルのアップロード機能  
✅ Cloudflare D1データベースでの文字起こし履歴管理  
✅ 文字起こし履歴の表示（日時、ファイル名、サイズ、ステータス）  
✅ 文字起こし結果の削除機能  
✅ レスポンシブなUIデザイン（Tailwind CSS使用）  
⚠️ ローカル環境でのテスト完了（D1のみ）

## URLとエンドポイント

### 開発環境URL
- **ローカル開発**: https://3000-ix5qmr41gfwhuu57bslru-ea026bf9.sandbox.novita.ai

### APIエンドポイント

#### 1. 音声ファイルのアップロードと文字起こし
```
POST /api/transcribe
Content-Type: multipart/form-data
Body: { audio: File }

Response (成功時):
{
  "id": 1,
  "status": "completed",
  "transcript": "文字起こし結果のテキスト..."
}

Response (エラー時):
{
  "error": "エラーメッセージ"
}
```

#### 2. 文字起こし履歴の取得
```
GET /api/transcriptions

Response:
{
  "transcriptions": [
    {
      "id": 1,
      "audio_file_name": "audio.mp3",
      "audio_file_size": 1234567,
      "transcript_text": "文字起こし結果...",
      "status": "completed",
      "created_at": "2026-03-07T07:00:00.000Z",
      "updated_at": "2026-03-07T07:00:01.000Z"
    }
  ]
}
```

#### 3. 特定の文字起こしの取得
```
GET /api/transcriptions/:id

Response:
{
  "id": 1,
  "audio_file_name": "audio.mp3",
  "audio_file_size": 1234567,
  "transcript_text": "文字起こし結果...",
  "status": "completed",
  "created_at": "2026-03-07T07:00:00.000Z",
  "updated_at": "2026-03-07T07:00:01.000Z"
}
```

#### 4. 文字起こしの削除
```
DELETE /api/transcriptions/:id

Response:
{
  "success": true
}
```

## データアーキテクチャ

### データモデル

#### transcriptions テーブル
```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audio_file_key TEXT NOT NULL,           -- R2に保存された音声ファイルのキー
  audio_file_name TEXT NOT NULL,          -- 元のファイル名
  audio_file_size INTEGER NOT NULL,       -- ファイルサイズ（バイト）
  transcript_text TEXT,                   -- 文字起こし結果
  status TEXT NOT NULL DEFAULT 'pending', -- ステータス: pending, processing, completed, failed
  error_message TEXT,                     -- エラーメッセージ（失敗時）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### ストレージサービス

1. **Cloudflare D1 Database** (`webapp-production`)
   - 文字起こし履歴の保存
   - SQLiteベースのグローバル分散データベース
   - ローカル開発時は `.wrangler/state/v3/d1` にローカルDBが作成される

2. **Cloudflare R2 Storage** (`webapp-audio-bucket`)
   - アップロードされた音声ファイルの保存
   - S3互換のオブジェクトストレージ
   - 本番環境でのみ使用

3. **Cloudflare AI** (Whisper モデル)
   - 音声ファイルの文字起こし処理
   - モデル: `@cf/openai/whisper`
   - 本番環境でのみ使用

### データフロー

1. ユーザーが音声ファイルをアップロード
2. サーバーがファイルをCloudflare R2に保存
3. D1データベースに文字起こしレコードを作成（status: 'processing'）
4. Cloudflare AIのWhisperモデルで文字起こしを実行
5. 文字起こし結果をD1に保存（status: 'completed'）
6. フロントエンドで結果を表示

## 使い方

### ローカル開発環境

#### 開発サーバーの起動

```bash
# ビルドして開発サーバーを起動（D1のみ）
npm run dev

# または、R2とAI含めた完全な環境（APIキー設定が必要）
npm run dev:full
```

開発サーバーが起動すると、以下のURLでアクセスできます：
- **ローカル**: http://localhost:3000
- **公開URL**: https://3000-ix5qmr41gfwhuu57bslru-ea026bf9.sandbox.novita.ai

#### 現在の状態

現在、ローカル開発環境ではD1データベースのみが動作しています。R2とAIを使用するには、Cloudflare APIキーの設定が必要です。

1. **アプリケーションにアクセス**
   - https://3000-ix5qmr41gfwhuu57bslru-ea026bf9.sandbox.novita.ai

2. **文字起こし履歴の確認**
   - 初回アクセス時は履歴が空です
   - 「更新」ボタンで履歴を再読み込みできます

3. **音声ファイルのアップロード（本番環境でのみ動作）**
   - 「音声ファイルをアップロード」セクションでファイルを選択
   - 「アップロードして文字起こし」ボタンをクリック
   - 文字起こしが完了すると、結果が表示されます

### 本番環境へのデプロイ（未実施）

本番環境にデプロイするには、以下の手順が必要です：

1. **Cloudflare APIキーの設定**
   - Deployタブからクラウドフレアアカウントを連携
   - APIトークンを設定

2. **D1データベースの作成**
   ```bash
   npx wrangler d1 create webapp-production
   # 出力されたdatabase_idをwrangler.jsoncに設定
   ```

3. **R2バケットの作成**
   ```bash
   npx wrangler r2 bucket create webapp-audio-bucket
   ```

4. **wrangler.jsoncの更新**
   - R2バケット設定を追加
   - AIバインディングを追加
   - database_idを設定

5. **マイグレーションの適用**
   ```bash
   npm run db:migrate:prod
   ```

6. **デプロイ**
   ```bash
   npm run deploy:prod
   ```

## デプロイ情報

- **プラットフォーム**: Cloudflare Pages / Workers
- **ステータス**: 🟡 ローカル開発完了（本番デプロイ未実施）
- **技術スタック**:
  - バックエンド: Hono v4 (Cloudflare Workers)
  - フロントエンド: HTML + JavaScript + Tailwind CSS
  - データベース: Cloudflare D1 (SQLite)
  - ストレージ: Cloudflare R2
  - AI: Cloudflare AI (Whisper)
  - 言語: TypeScript
- **最終更新**: 2026-03-07

## まだ実装されていない機能

❌ Cloudflare R2への音声ファイル保存（APIキー設定が必要）  
❌ Cloudflare AIによる実際の文字起こし処理（APIキー設定が必要）  
❌ 本番環境へのデプロイ  
❌ GitHub連携  
❌ 音声ファイルのダウンロード機能  
❌ 文字起こし結果のエクスポート機能（TXT、JSON形式）  
❌ 複数ファイルの一括アップロード  
❌ 進捗状況のリアルタイム表示  
❌ ユーザー認証機能

## 次の開発ステップ

### 優先度: 高

1. **Cloudflare APIキーの設定と本番環境デプロイ**
   - APIキーを設定してR2とAI機能を有効化
   - 本番環境へのデプロイ
   - 実際の音声文字起こし機能のテスト

2. **GitHub連携**
   - GitHubリポジトリの作成
   - コードのプッシュ

### 優先度: 中

3. **音声ファイルのダウンロード機能**
   - R2から音声ファイルを取得するAPIエンドポイント
   - ダウンロードボタンの追加

4. **文字起こし結果のエクスポート機能**
   - TXT形式でのエクスポート
   - JSON形式でのエクスポート

### 優先度: 低

5. **複数ファイルの一括アップロード**
   - ドラッグ&ドロップ対応
   - 複数ファイル同時処理

6. **進捗状況のリアルタイム表示**
   - WebSocketまたはServer-Sent Events
   - プログレスバーの表示

7. **ユーザー認証機能**
   - Cloudflare Access連携
   - 個人の文字起こし履歴管理

## プロジェクト構造

```
webapp/
├── src/
│   ├── index.tsx         # メインアプリケーション（Hono）
│   └── renderer.tsx      # HTMLレンダラー
├── public/
│   └── static/
│       ├── app.js        # フロントエンドJavaScript
│       └── style.css     # カスタムCSS
├── migrations/
│   └── 0001_initial_schema.sql  # D1データベースマイグレーション
├── .git/                 # Gitリポジトリ
├── .gitignore            # Git除外設定
├── wrangler.jsonc        # Cloudflare Workers設定
├── package.json          # 依存関係とスクリプト
├── tsconfig.json         # TypeScript設定
├── vite.config.ts        # Vite設定
└── README.md             # このファイル
```

## 開発コマンド

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# 開発サーバーの起動（D1のみ）
npm run dev

# 開発サーバーの起動（R2とAI含む、APIキー設定が必要）
npm run dev:full

# ローカルD1マイグレーション
npm run db:migrate:local

# 本番D1マイグレーション（APIキー設定後）
npm run db:migrate:prod

# 本番デプロイ（APIキー設定後）
npm run deploy:prod

# ポートクリーンアップ
npm run clean-port
```

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。
