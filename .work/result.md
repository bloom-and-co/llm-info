STATUS: DONE

# 実装結果

LiteLLM と models.dev のライブデータから、4 プロバイダーの料金表を生成した。両ソースが異なる場合は高い料金を採用し、差分を `conflicts` に記録する。genai-prices 0.1.9 の JS/Python 両 SDK で生成データを検証した。JS/Python のローカルキャッシュ、再取得、レスポンスからの使用量抽出、トークン・1時間キャッシュ・画像・動画の料金計算を実装した。npm/Python の Git インストール用パッケージ構成、6時間おきの更新 workflow、CI、MIT ライセンスと帰属表示も追加した。

生成済み `data/prices.json` のモデル数: openai 149、anthropic 20、google 90、x-ai 47。`conflicts` は 8 件。出典の価格のみを使い、genai-prices からはプロバイダーの非価格メタデータと extractor の形を利用した。

# ファイル案内

- `builder/core.mjs`, `builder/build.mjs`, `builder/validate.py`: ソース統合、ティア・追加料金の変換、検証、再現可能な出力。
- `data/prices.json`: 公開する単一 JSON。
- `src/index.ts`, `src/file.ts`: JS API と Node 専用ファイルストア。
- `python/llm_prices/__init__.py`, `python/llm_prices/_sdk.py`: Python API と SDK 内部アダプター。
- `tests/`, `python/tests/`, `builder/core.test.ts`: 受け入れテストとレスポンス fixtures。
- `.github/workflows/`: CI と定期更新。
- `README.md`, `NOTICE`, `LICENSE`: 利用方法、帰属、ライセンス。

# テスト実行結果

以下は同一結果の再実行も含め、実行順に要約行をそのまま記録したもの。途中の失敗は動画料金の resolution 既定値処理を追加した直後の回帰で、修正後の再実行に成功した。また、SDK extractor の追加検証で Google 画像トークンの二重集計と OpenAI Images extractor の重複を発見し、修正した。

1. JS: `Test Files  2 passed (2)` / `Tests  13 passed (13)`
2. Python: `9 passed in 0.17s`
3. JS: `Test Files  2 passed (2)` / `Tests  14 passed (14)`; Python: `10 passed in 0.15s`
4. JS: `Test Files  2 passed (2)` / `Tests  14 passed (14)`; Python: `10 passed in 0.44s`
5. JS: `Test Files  2 passed (2)` / `Tests  14 passed (14)`; Python: `10 passed in 0.15s`
6. JS: `Test Files  2 passed (2)` / `Tests  14 passed (14)`; Python: `10 passed in 0.46s`
7. `npm ci` 後の JS: `Test Files  2 passed (2)` / `Tests  14 passed (14)`; Python: `10 passed in 0.46s`
8. 回帰検出時の JS: `Test Files  1 failed | 1 passed (2)` / `Tests  2 failed | 13 passed (15)`
9. 修正後の JS: `Test Files  2 passed (2)` / `Tests  15 passed (15)`; Python: `11 passed in 0.48s`
10. JS: `Test Files  2 passed (2)` / `Tests  15 passed (15)`; Python: `11 passed in 0.48s`
11. JS: `Test Files  2 passed (2)` / `Tests  15 passed (15)`
12. Python: `11 passed in 0.49s`
13. JS: `Test Files  2 passed (2)` / `Tests  15 passed (15)`
14. JS: `Test Files  2 passed (2)` / `Tests  16 passed (16)`
15. JS: `Test Files  2 passed (2)` / `Tests  16 passed (16)`; Python: `11 passed in 0.48s`
16. 最終変更後の JS: `Test Files  2 passed (2)` / `Tests  16 passed (16)`; Python: `11 passed in 0.52s`
17. ファイルストア検証後の JS: `Test Files  2 passed (2)` / `Tests  16 passed (16)`; Python: `11 passed in 0.48s`
18. Google 画像 extractor 修正後の JS: `Test Files  2 passed (2)` / `Tests  18 passed (18)`; Python: `11 passed in 0.47s`
19. Python SDK extractor 回帰テスト後: `12 passed in 0.48s`
20. OpenAI Images extractor 重複修正後の JS: `Test Files  2 passed (2)` / `Tests  18 passed (18)`; Python: `12 passed in 0.48s`
21. 最終再確認の JS: `Test Files  2 passed (2)` / `Tests  18 passed (18)`; Python: `12 passed in 0.48s`

ビルダー最終実行: `python SDK validation: 4 providers passed` / `builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=47; conflicts=8`

パッケージと実行環境の最終確認:

```text
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
Worker main entry smoke: PASS
```

# 推定を置いた箇所と制約

- LiteLLM のサイズ別 `input_cost_per_pixel` は画像生成単価として、幅×高さを掛けて `per_image` に変換した。品質キーは Images API の `size/quality` として表した。
- LiteLLM の `output_cost_per_second` は `video_generation` モードだけ動画単価と解釈し、解像度別キーがある場合は基本単価を `default` に置いた。
- SDK が画像トークンと一般キャッシュ料金の併用に要求する複合単価は、より一般的なキャッシュ単価から補った。ソースに専用単価がない場合の推定である。
- OpenAI Images の `data` 件数、Gemini/Imagen の `generatedImages` 件数、Veo/Sora の request の `duration`/`resolution` を画像・動画出力に対応させた。fixture の形は各社 API 文書を参照し、`tests/fixtures/README.md` に URL を記載した。
- 画像出力トークン数があるレスポンスでは、同じ出力への画像1枚単価を重ねないようにした。サービスティア別料金は採用せず警告する。
- GitHub リポジトリの作成・push・公開は指示どおり行っていない。そのため GitHub からの直接インストールと Actions の本番実行は未実施。npm tarball と Python wheel を一時環境へインストールして検証した。

## Follow-up 2

1 時間キャッシュ書き込み料金の生成・抽出・加算を削除した。Anthropic のキャッシュ書き込みは通常のキャッシュ書き込み料金で計算する。genai-prices 由来の extractor に残っていた 1 時間用の対応も全プロバイダーから除去した。

画像出力モデルでは models.dev の `cost.output` を `output_image_mtok` に統合し、LiteLLM のテキスト出力料金を `output_mtok` に保持するよう修正した。両ソースの画像出力料金が 0.5% 以上異なれば高い方を採用して `conflicts` に記録する。以前の `gpt-image-2` で衝突記録がなかった理由は、当時のビルドで LiteLLM のテキスト出力料金が欠けており、models.dev の画像料金が別フィールドの `output_mtok` に入ったためである。今回のライブ LiteLLM データも `gpt-image-2` のテキスト出力料金を含まないため、SDK が必要とする親フィールド `output_mtok` は構造上の 0 とした。LiteLLM がテキスト料金を提供する場合に値が保持されることはビルダーテストで確認した。

Prettier を開発依存に追加し、JS/TS を整形した。Python は Ruff で整形した。CI に両フォーマット検査と明示的なビルダーテストを追加した。生成データのモデル数は `openai=149 anthropic=20 google=90 x-ai=47`、`conflicts=2`。

最終実行の要約行（原文）:

```text
All matched files use Prettier code style!
4 files already formatted
 Test Files  1 passed (1)
      Tests  9 passed (9)
 Test Files  2 passed (2)
      Tests  22 passed (22)
13 passed in 0.52s
python SDK validation: 4 providers passed
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=47; conflicts=2
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
Worker main entry smoke: PASS
```

生成データの最終変更を含む再ビルドでは `builder: updated; models openai=149 anthropic=20 google=90 x-ai=47; conflicts=2`、直後の再実行では上記の `unchanged` となった。GitHub への push とレジストリへの公開は行っていない。

## Follow-up 3

予算超過を防ぐため、料金表の親単価、SDK に渡すモデル行、レスポンスの使用量抽出を修正した。先に回帰テストをコミット（`ee253c2`）して実行した時点の要約は `Test Files  2 failed (2)` / `Tests  7 failed | 23 passed (30)`、Python は `1 failed, 13 passed in 0.58s` だった。項目 9 の旧 Worker エントリを別途 browser 向けに bundle した結果は `baseline worker bundle: FAIL`、`Could not resolve "node:fs/promises"`、`Could not resolve "node:path"`、`Could not resolve "node:os"` だった。

| 項目 | テスト名 | 修正前（原文） | 修正後（原文） | 原因と修正 |
|---|---|---|---|---|
| 0 | `charges exact dated rows and image-only output tokens` | `FAIL  tests/prices.test.ts > charges exact dated rows and image-only output tokens` | `Tests  40 passed (40)` | 画像出力専用モデルで SDK の親 `output_mtok` を 0 にしていた。画像出力単価で補完した。 |
| 1 | 同上、`never matches a published request ID to differently priced rows` | `FAIL  tests/prices.test.ts > charges exact dated rows and image-only output tokens` | `Tests  40 passed (40)` | wrapper が日付付き行を選んだ後、SDK が alias に再一致した。選んだ 1 行だけを SDK に渡し、builder の alias 正規表現から既存の日付付き ID を除外した。 |
| 2 | `accounts for Gemini audio, tool input, and image reasoning` | `FAIL  tests/prices.test.ts > accounts for Gemini audio, tool input, and image reasoning` | `Tests  40 passed (40)` | 独自 extractor が AUDIO を読まなかった。入力、キャッシュ、出力、ツール入力の AUDIO 内訳を復元した。 |
| 3 | 同上 | `FAIL  tests/prices.test.ts > accounts for Gemini audio, tool input, and image reasoning` | `Tests  40 passed (40)` | `toolUsePromptTokenCount` を入力合計に加えていなかった。 |
| 4 | `charges video counts and warns when duration is unknown` | `FAIL  tests/prices.test.ts > charges video counts and warns when duration is unknown` | `Tests  40 passed (40)` | Sora の文字列秒数と Veo の `parameters.durationSeconds`、生成本数を無視していた。Veo の既定 8 秒は [Google の文書](https://ai.google.dev/gemini-api/docs/veo) に従い、秒数不明の動画には `missing_param:duration` を付ける。 |
| 5 | `accounts for Gemini audio, tool input, and image reasoning`、`fills image reasoning and audio cache from their own modalities` | `FAIL  tests/prices.test.ts > accounts for Gemini audio, tool input, and image reasoning` | `Tests  40 passed (40)` | 画像思考出力を入力単価から、音声キャッシュをテキストキャッシュから補っていた。各出力単価、音声入力単価へ修正し、SDK が要求する交差使用量を保守的な 0 で明示した。 |
| 6 | `charges xAI reasoning and Anthropic web searches` | `FAIL  tests/prices.test.ts > charges xAI reasoning and Anthropic web searches` | `Tests  40 passed (40)` | xAI の `completion_tokens` は最終テキスト、`reasoning_tokens` は別計上という [公式説明](https://docs.x.ai/developers/tools/tool-usage-details) に従い、後者を出力トークンに加えた。 |
| 7 | `survives null usage fields and counts Vertex predictions`、`test_dated_image_audio_video_null_and_tools` | `1 failed, 13 passed in 0.58s` | `16 passed in 0.69s` | Python の `None.get` と `None` の加算を避け、JS にも同じ null fixture を追加した。 |
| 8 | 同上、`matches Python totals and warnings for every fixture` | `1 failed, 13 passed in 0.58s` | `16 passed in 0.69s` | Python の Imagen `predictions` を数えていなかった。全 fixture と追加 null/predictions ケースで JS/Python の合計と警告を比較した。 |
| 9 | `bundles and imports a memory-store Worker without Node modules` | `baseline worker bundle: FAIL` | `Tests  1 passed (1)` | main entry の動的 import が Node のファイルモジュールを bundle に取り込んだ。`/file` を明示 import する構成にし、browser platform の実 bundle と import 実行で検証した。環境に workerd / miniflare はなかった。 |
| 10 | `skips one malformed model and includes flat image prices` | `FAIL  builder/core.test.ts > skips one malformed model and includes flat image prices` | `Tests  18 passed (18)` | 単一モデルの SDK キー補完失敗で全体が中断した。理由付きで `skipped` に記録し、そのモデルだけ除外する。20% 減少ガードは維持した。 |
| 11 | `merges duplicate LiteLLM ids by higher price independent of order`、`takes the higher duplicate per-image price and records its source`、`records duplicate LiteLLM tier conflicts with source IDs` | `FAIL  builder/core.test.ts > merges duplicate LiteLLM ids by higher price independent of order` | `Tests  18 passed (18)` | 正規化後の重複行が後勝ちだった。単価ごとに高い方を選び、元の LiteLLM ID を衝突記録に残す。入力順を変えても同じ結果を確認した。 |
| 12 | `interprets xAI image-only flat prices as generated-image charges`、`charges xAI reasoning and Anthropic web searches`、`warns on unpriced web searches`、`uses the conservative default for xAI generated images without size metadata` | `FAIL  tests/prices.test.ts > charges xAI reasoning and Anthropic web searches` | `Tests  40 passed (40)` | LiteLLM の xAI `input_cost_per_image` は [xAI の料金表](https://docs.x.ai/developers/pricing) では生成画像単価なので `per_image` に変換した。Anthropic 検索回数はソースの検索単価があれば加算し、なければ警告する。サイズ別画像料金がある場合も基準の 1 枚単価を `default` として残し、サイズ未指定時の 0 円評価を防いだ。更新 workflow は concurrency、credential 非永続化、別 push step を追加した。 |

旧データで `output_mtok: 0` を合成していた画像モデルの修正前→修正後（USD / 100 万トークン）:

| モデル | 前 | 後 |
|---|---:|---:|
| gpt-image-1 | 0 | 40 |
| gpt-image-1-mini | 0 | 8 |
| gpt-image-2 | 0 | 30 |
| gpt-image-2-2026-04-21 | 0 | 30 |
| gpt-image-2.5-flare | 0 | 30 |
| gpt-image-2.5-flare-2026-09-08 | 0 | 30 |
| gpt-image-2.5-sunburst | 0 | 30 |
| gpt-image-2.5-sunburst-2026-09-08 | 0 | 30 |

models.dev のライブ `modalities.output` は `gpt-image-1` と `gpt-image-2` が `['image']`、`gpt-image-1-mini` は `['text','image']`、flare / sunburst は掲載なしだった。後者も LiteLLM の画像出力料金があり、テキスト出力単価がない場合は親単価に画像料金を使用した。

最終再実行の要約行（原文）:

```text
All matched files use Prettier code style!
5 files already formatted
 Test Files  1 passed (1)
      Tests  18 passed (18)
 Test Files  4 passed (4)
      Tests  40 passed (40)
16 passed in 0.69s
python SDK validation: 4 providers passed
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=6; skipped=0
 Test Files  1 passed (1)
      Tests  1 passed (1)
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
```

生成データは openai 149、anthropic 20、google 90、x-ai 54 モデル。衝突 6 件、スキップ 0 件。npm tarball と Python wheel はそれぞれ一時環境へインストールして、日付付き `gpt-4o-2024-05-13` の $5/M を確認した。GitHub への push と公開は行っていない。

## Task 4

`llm-info` に名称を統一した。GitHub URL、npm パッケージ、Python distribution/import/class、JS factory、公開 JSON、キャッシュのパスと環境変数を更新し、旧名の検索結果は `.work/` を除いて 0 件だった。公開前なので旧 factory/class の alias は残していない。変更は `66ebc99` にコミットした。push・公開はしていない。

各モデルへ `x_capabilities` と field ごとの `sources` を付けた。models.dev の effort リストを優先し、欠ける場合は LiteLLM の明示リスト、さらに明示的に true の effort flag のみを採用する。`supports_reasoning` だけから low/medium/high を推測せず、不明なら null とした。真偽値は true 優先、モダリティは正規化した和集合、制限値は小さい方を採用する。相違点は `capability_conflicts` に保存する。JS/Python に `capabilities` と `models` を追加した。genai-prices 0.1.9 で拡張キー付きデータを activate/calc できることを builder と wrapper テストで確認した。

`x_modes` は models.dev の `experimental.modes.*.cost` と request body/headers、LiteLLM の `provider_specific_entry.fast` 倍率と `*_priority`、`*_flex`、`*_batches` 単価を反映する。`x_region_uplift` は LiteLLM の US/EU 倍率を反映する。`calc` / `fromResponse` は mode/region を受け取り、OpenAI のレスポンス `service_tier` と Anthropic の `usage.speed` から mode を推定する。明示指定が優先される。モード単価のないモデルには既知の最高単価を使い `missing_price:mode:<mode>` を返す。地域倍率が画像・動画単価に適用される範囲をソースが明記していないため、総額全体に適用した。根拠: https://platform.openai.com/docs/api-reference/responses 、https://platform.claude.com/docs/en/build-with-claude/fast-mode 。

生成データ: openai=149、anthropic=20、google=90、x-ai=54（合計 313）。`conflicts=14`、`capability_conflicts=180`、`skipped=0`。`gpt-6-luna` effort は none/low/medium/high/xhigh/max、`gemini-3.8-flash` は low/medium/high、`grok-4.7` web_search は true、`claude-opus-5-5` temperature は false。手計算した 1000 input + 1000 output は Opus fast $0.048、Luna priority $0.0012、Luna US 標準 $0.00066 だった。

最終実行の要約行（原文）:

```text
All matched files use Prettier code style!
5 files already formatted
 Test Files  4 passed (4)
      Tests  43 passed (43)
17 passed in 0.86s
 Test Files  1 passed (1)
      Tests  19 passed (19)
python SDK validation: 4 providers passed
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=14; skipped=0
 Test Files  1 passed (1)
      Tests  1 passed (1)
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
```

## Task 5

`@pydantic/genai-prices` / `genai-prices` への依存を完全に除去した。公開データを schema 2 のフラットな `models` 配列へ変更し、provider、ID、名前、alias、match、source、USD/100万 token の単価、tier、mode、地域倍率、capability を各行に持たせた。builder は LiteLLM と models.dev のデータから直接この形式を作る。旧 SDK の provider metadata、extractor 配列、単価キー補完、エラー文の正規表現パース、Python private API、JS singleton 制限を削除した。model 数減少、旗艦 model、負数・NaN、tier 順序の検証を残した。schema 1 の旧ファイルからの model 数比較にも対応する。生成データは openai=149、anthropic=20、google=90、x-ai=54（計313）、価格衝突14、capability 衝突180、skipped 0。

JS と Python の独立した計算エンジンを実装した。input/cache/modality/output/reasoning を重複のない bucket へ割り当て、曖昧な cache×modality の重なりでは実現可能な最大額を選ぶ。たとえば input 100万、audio 60万、cached 50万では audio cache が最低10万必要で、テスト用単価による最大額 $5.24 を両言語で確認した。矛盾する usage は clamp して `inconsistent_usage` を返す。専用単価のない bucket は最も高い適用可能な fallback を使い、`fallback_price:<key>` または `missing_price:<key>` を返す。tier は threshold を超えた場合だけ、mode は token cost、地域倍率は総額へ適用する。JS の金額は最後に 1e-10 USD へ丸め、Python は Decimal を使う。既存の手計算合計や response fixture の期待金額は変更していない。

review の問題は失敗する回帰テストを先にコミットした（`cdfa27e`、`2aac517`）。gpt-image-1 の output token がある Images response は `per_image` を重ねて加算しない。Google の cache/audio および xAI の cache/image 重複では throw せず、最大額となる割当を使う。Veo の `config.durationSeconds` / `config.numberOfVideos`、Vertex `videos`、Gemini REST `generateVideoResponse.generatedSamples` と operation wrapper を数える。xAI Chat Completions は reasoning が completion の外側だが、Responses の公式例では `total_tokens = input_tokens + output_tokens` かつ `output_tokens_details.reasoning_tokens` が示されるため、Responses では reasoning を足し直さない。根拠: https://docs.x.ai/developers/rest-api-reference/inference/chat-completions 、https://docs.x.ai/developers/rest-api-reference/inference/responses 、https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing 。Worker テストは `dist/index.js` を build 後に bundle する。

README に schema 2、bucket 割当、fallback と warning、capability、mode、region、store hook、D1 Worker 例、GitHub からの install を記した。NOTICE は LiteLLM と models.dev だけにした。`.work/` の外で `rg -i 'genai' .` は結果 0 件。GitHub への push、repository 作成、公開は行っていない。

最終実行の要約行（原文）:

```text
All matched files use Prettier code style!
 Test Files  5 passed (5)
      Tests  41 passed (41)
 Test Files  1 passed (1)
      Tests  9 passed (9)
All checks passed!
21 passed in 0.05s
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=14; skipped=0
 Test Files  1 passed (1)
      Tests  1 passed (1)
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
```

## Task 6

予算計算での過少請求を優先して修正した。Major の再現テストを先に追加し、`8f509ab` にコミットした。その時点の原文要約は `Tests  5 failed (5)`。公開 JSON からモデル別の `source`、capability の `sources`、価格と capability の `conflicts` を除いた。builder は高い価格を採用し、衝突の詳細を `conflict: {...}` としてログに出す。`sources` はソースごとに一行で `fetched_at`、`ref`/`etag`、`latest_new_model_at` を持つ。前回公開モデル ID に新 ID がない場合、最後の時刻を維持する。

| 項目 | 修正前 | 修正後 |
|---|---|---|
| A. 公開情報と1時間キャッシュ | モデルと Cost に `source`、capability に `sources`、公開 JSON に衝突配列があった。 | 公開 JSON は `schema,sources,models,skipped,generated_at,version` のみ。1時間 cache write は5分単価のままとし、最大37.5%の過少推計を README の Known limitations に明記した。 |
| 1. CI | 削除済み `builder/validate.py` と旧依存を指定していた。 | 両 workflow の Python コマンドを修正。`.work/` 以外の `rg --hidden -i genai` は0件。CI の `run:` コマンドを順にローカル実行し成功。更新 workflow のテストまで実行し、指示により commit/push step は実行していない。 |
| 2. mode tier | 40万 input / 1万 output の `gpt-5.4 priority` は $2.30、`gpt-6-luna fast` は $0.09、`gemini-2.5-pro batch` は $0.30。 | 基本 tier の倍率を mode 単価へ適用し、それぞれ $4.45、$0.175、$0.575。mode 自身の tier がある場合はその明示単価を使う。 |
| 4. mutation coverage | 初回は builder 14件、engine 9件が生存。旧コード位置の5件は probe が `NOTFOUND`。 | probe の対象文字列とテスト経路を現行コードに合わせ、builder 19件、engine 20件を全て kill。最後の実行では `SURVIVED` と `NOTFOUND` は0件。 |
| 5. publishability / skipped | `skipped=[]` で、入力・出力単価が欠けた text 行も公開された。 | 必須価格と非数値価格を検査して理由付きで skip。ライブビルドでは13行を `missing_required_price` で skip、313行を公開。 |
| 6. tier 下限 | base $3/M に tier $2/M を重ねると長文側が $2/M だった。 | tier は各キーで `max(tier, merged base)`。0または空の tier は削除。 |
| 7. 欠けた mode | 既知 mode の価格を一律に上乗せした。 | `flex`/`batch` は標準単価、`priority`/`fast` は provider の既知の最高倍率、モデルの既知倍率、2倍の順で選び、警告する。 |
| 8. 不正入力と region | JS は数値文字列を0扱いし、Python は bool/文字列で例外になり得た。地域の大文字を認識しなかった。 | 数値文字列を数値化し、それ以外は0と `invalid_usage:<field>`。地域は大文字小文字を同一視し、未知の地域と倍率未設定を警告。 |
| 9. JS/Python parity | cache と modality の通常の重なりを `inconsistent_usage` とした。allocation の警告に差が出た。 | 真に合計を超える subcount のみ警告し、割当後に使われた bucket のみ価格警告を出す。tie は同じ順序で解決。20,000ケースの差は金額0件、警告0件。 |
| 10. 画像・動画数 | Imagen の request 件数を無視し、Sora の秒数欠落は0円だった。 | `parameters.sampleCount` / `config.numberOfImages` を採用。枚数不明の per-image は1枚を加算して警告。Sora は[OpenAI Videos API](https://platform.openai.com/docs/api-reference/videos) に記載された既定4秒で計算し警告。 |
| 11. capabilities | `context_window` に `max_input_tokens` を代入し、検索単価があっても `web_search` が false の場合があった。 | LiteLLM の context 系フィールドまたは models.dev の `limit.context` を使用。`max_input_tokens` は別に保持。`per_web_search` があれば `web_search=true`。 |
| 12. matching | Vertex `-001/-002`、Anthropic `@YYYYMMDD` と `anthropic.`、provider 大文字が一致しなかった。 | 既存の完全一致を優先し、各形式を追加。Bedrock prefix は一致先が一意の場合だけ採用。README に `null` は「未知のモデルであり無料扱いしない」と明記。 |

最終確認の原文要約:

```text
All matched files use Prettier code style!
4 files already formatted
All checks passed!
 Test Files  6 passed (6)
      Tests  66 passed (66)
 Test Files  1 passed (1)
      Tests  16 passed (16)
22 passed in 0.07s
builder: updated; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=265; skipped=13
 Test Files  1 passed (1)
      Tests  1 passed (1)
KILLED  model-without-price guard off
KILLED  input clamp removed
total diffs 0 warning diffs 0 of 20000
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
```

`npm ci`、`npm ci --ignore-scripts`、`npm run build`、`npm run test:worker` も成功。Worker は `dist` を browser platform で bundle/import して確認した。`det.mjs` は両データセットで `det true`、逆順ソースで `order-indep true`。生成データの `eq committed false` は取得時刻を更新する `sources` フィールドが異なるため。GitHub repo 作成・push・公開はしていない。

## Task 7

Anthropic の 1 時間キャッシュ書き込み料金を復活した。LiteLLM の `cache_creation_input_token_cost_above_1hr` を `cache_write_1h`（USD/100 万 token）へ変換し、models.dev に同名の料金があれば高い方を採用する。今回の models.dev のライブ `cost` には対応キーがなく、LiteLLM の値を採用した。ティア、モード、地域倍率は他の token 単価と同様に扱う。公開データの `claude-opus-5-5` は `cache_write_1h: 8`、fast は 16 となった。

JS/Python の両エンジンに独立した `cache_write_1h_tokens` bucket を追加した。Anthropic のレスポンス `usage.cache_creation.ephemeral_5m_input_tokens` と `ephemeral_1h_input_tokens` を分け、total だけがある旧形式では 5 分へ割り当てる。1 時間単価がないモデルは Anthropic の [料金表](https://platform.claude.com/docs/en/about-claude/pricing) に従って active input 単価の 2 倍で見積もり、`fallback_price:cache_write_1h` を返す。使用量の形は [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) を参照した。Opus 5.5 の 100 万 1 時間 write は $8、5 分と 1 時間を各 50 万なら $6.50、total だけなら $5 を JS/Python とも確認した。README の旧制約を削除した。

公開 JSON の変更判定を `models` と `skipped` のみにした。両者が同じなら `sources` の取得時刻・ref/etag、`generated_at`、`version` をすべて保持する。新モデル ID を含む内容変更時は従来どおり `latest_new_model_at` を更新する。取得の実行時刻は workflow の builder ログに出し、6 時間ごとの無変更 commit を避ける。異なる fetch metadata による二つのビルドがバイト単位で一致する回帰テストと、ライブ再ビルドの SHA-256 一致を確認した。

回帰テストを先にコミットした（`31fa84d`）。最初の実行は JS `Tests  4 failed | 51 passed (55)`、Python `1 failed, 21 passed in 0.11s` で、1 時間 bucket と安定した公開 metadata の欠落を再現した。mutation script に 1 時間料金の変換、fallback、allocation、mode tier と metadata の分岐を追加し、fuzz に新 field を追加した。

最終確認の原文要約:

```text
All matched files use Prettier code style!
4 files already formatted
All checks passed!
 Test Files  6 passed (6)
      Tests  70 passed (70)
 Test Files  1 passed (1)
      Tests  18 passed (18)
 Test Files  1 passed (1)
      Tests  1 passed (1)
23 passed in 0.05s
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=265; skipped=13
builder: unchanged; models openai=149 anthropic=20 google=90 x-ai=54; conflicts=265; skipped=13
byte identity: PASS
KILLED  one-hour cache price mapping dropped
KILLED  one-hour models.dev price mapping dropped
KILLED  source metadata enters content hash
KILLED  one-hour write allocation dropped
KILLED  one-hour fallback uses five-minute rate
KILLED  one-hour mode tier ratio dropped
total diffs 0 warning diffs 0 of 20000
npm pack/install smoke: PASS
Python wheel/install smoke: PASS
```

Builder mutation は 22 件、engine mutation は 23 件すべて kill し、`SURVIVED` と `NOTFOUND` は 0 件。`npm run build` と `npm run test:worker` で dist Worker bundle も成功した。GitHub repo 作成・push・公開はしていない。
