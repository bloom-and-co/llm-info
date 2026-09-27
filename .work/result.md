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
