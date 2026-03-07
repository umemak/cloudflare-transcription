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
✅ Cloudflare R2ストレージへの音声ファイル保存  
✅ Cloudflare AI（Whisper）による文字起こし機能  
✅ 文字起こし履歴の表示（日時、ファイル名、サイズ、ステータス）  
✅ 文字起こし結果の削除機能  
✅ レスポンシブなUIデザイン（Tailwind CSS使用）  
✅ ローカル環境でのテスト完了（D1 + R2）  
⚠️ AIを含む完全なテストにはCloudflare APIキーが必要

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
   - **✅ ローカルで動作**

2. **Cloudflare R2 Storage** (`webapp-audio-bucket`)
   - アップロードされた音声ファイルの保存
   - S3互換のオブジェクトストレージ
   - ローカル開発時は `.wrangler/state/v3/r2` にローカルストレージが作成される
   - **✅ ローカルで動作**

3. **Cloudflare AI** (Whisper モデル)
   - 音声ファイルの文字起こし処理
   - モデル: `@cf/openai/whisper`
   - **⚠️ リモートサービス（ローカルでもAPIキーがあれば使用可能）**

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
# D1 + R2のみをローカルで使用（AIなし）
npm run dev

# D1 + R2 + AI（Cloudflare APIキーが必要）
npm run dev:ai
```

開発サーバーが起動すると、以下のURLでアクセスできます：
- **ローカル**: http://localhost:3000
- **公開URL**: https://3000-ix5qmr41gfwhuu57bslru-ea026bf9.sandbox.novita.ai

#### ローカルで動作するもの

**`npm run dev` の場合:**
- ✅ **D1データベース** - SQLiteのローカルインスタンス
- ✅ **R2ストレージ** - ローカルファイルシステム
- ❌ **AI文字起こし** - 含まれていない

**`npm run dev:ai` の場合（APIキー設定後）:**
- ✅ **D1データベース** - SQLiteのローカルインスタンス
- ✅ **R2ストレージ** - ローカルファイルシステム
- ✅ **AI文字起こし** - Cloudflareのリモートサービスに接続

#### 現在の状態

**`npm run dev` の場合:**
ローカル開発環境では、音声ファイルのアップロードとR2への保存は動作しますが、文字起こし（AI）は含まれていません。

**`npm run dev:ai` の場合（APIキー設定後）:**
Cloudflare APIキーを設定すると、ローカル開発環境でも完全な文字起こし機能をテストできます。D1とR2はローカル、AIはCloudflareのリモートサービスを使用します。

1. **アプリケーションにアクセス**
   - https://3000-ix5qmr41gfwhuu57bslru-ea026bf9.sandbox.novita.ai

2. **音声ファイルのアップロード（ローカルでテスト可能）**
   - 「音声ファイルをアップロード」セクションでファイルを選択
   - 「アップロードして文字起こし」ボタンをクリック
   - ファイルはローカルR2に保存されます
   - 文字起こしは失敗しますが（AI未設定）、ファイル保存は成功します

3. **文字起こし履歴の確認**
   - アップロードした音声ファイルの履歴が表示されます
   - 「更新」ボタンで履歴を再読み込みできます

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
   # ローカルでは自動作成されるため、本番用のみ作成
   npx wrangler r2 bucket create webapp-audio-bucket
   ```

4. **wrangler.jsoncの更新**
   - database_idの設定
   - AIバインディングのコメント解除（コード内のコメントアウトを削除）

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

❌ 本番環境へのデプロイ  
❌ GitHub連携  
❌ 音声ファイルのダウンロード機能  
❌ 文字起こし結果のエクスポート機能（TXT、JSON形式）  
❌ 複数ファイルの一括アップロード  
❌ 進捗状況のリアルタイム表示  
❌ ユーザー認証機能

## 次の開発ステップ

### 優先度: 高

1. **Cloudflare APIキーの設定とローカルテスト**
   - APIキーを設定して`npm run dev:ai`で完全なローカルテスト
   - 音声文字起こし機能の動作確認
   - 本番環境へのデプロイ

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
