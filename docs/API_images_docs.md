# API 契約：① 季節別 商品画像生成 ② 非構造ファイルからの情報抽出

すべて JSON（UTF-8）。SSE は `POST` + `text/event-stream`、各行 `data: {json}\n\n`、`event` フィールドでイベント種別を表す（既存 `/api/products/{sku}/enrich` と同じ形式。フロントは既存の `postStream()` を使う）。
エラーは `{"detail": "..."}`（HTTP 4xx/5xx）。

---

## ① 画像生成

### `GET /api/images/presets?sku={sku}`
```json
{
  "sku": "00049890716",
  "product": {"sku": "...", "title": "...", "brand": "...", "group": "aircon", "group_label": "エアコン", "image_url": "https://...300x300...jpg", "has_image": true},
  "presets": [
    {"id": "summer-cooling", "label": "夏：冷房パワー", "season": "summer", "season_label": "夏", "icon": "☀️",
     "available": true, "reason": "", "evidence": "冷房能力 4.0kW",
     "facts": [{"label": "冷房能力", "value": "4.0 kW"}],
     "prompt": "真夏の強い日差しのリビング…"},
    {"id": "spring-pollen", "label": "春：花粉・空気清浄", "season": "spring", "season_label": "春", "icon": "🌸",
     "available": false, "reason": "この商品には花粉・空気清浄・フィルターに関する記載がありません", "evidence": "", "facts": [], "prompt": "..."}
  ],
  "options": {
    "models": [{"id": "gemini-3.1-flash-image", "label": "Flash（高速・標準）"}, {"id": "gemini-3-pro-image", "label": "Pro（高品質・文字入れ向き）"}],
    "default_model": "gemini-3.1-flash-image",
    "sizes": [{"value": 300, "label": "300×300"}, {"value": 600, "label": "600×600"}, {"value": 1024, "label": "1024×1024"}, {"value": 0, "label": "元サイズ"}],
    "default_size": 300,
    "aspects": ["1:1", "4:3", "3:4", "16:9"], "default_aspect": "1:1",
    "text_modes": [{"id": "none", "label": "文字なし"}, {"id": "copy", "label": "キャッチコピーのみ"}, {"id": "spec", "label": "スペック入り"}],
    "default_text_mode": "none",
    "counts": [2, 3, 4], "default_count": 3,
    "bucket": "products_images_<PROJECT_ID>"
  }
}
```
- `presets` はその商品のカテゴリに関係するものだけ（＋全カテゴリ共通）。`available=false` は UI でグレー＋`reason` をツールチップ。
- `size`: 出力画像は正方形なら `size×size`、それ以外のアスペクト比は長辺 = `size`。`0` はモデル出力のまま。

### `GET /api/products/{sku}/images`
```json
{
  "sku": "...",
  "registered": [{"url": "https://store.example.com/...300x300.jpg", "kind": "original", "label": "登録画像（カタログ）"}],
  "images": [ImageRow, ...]   // status != deleted、新しい順
}
```
`ImageRow`:
```json
{"image_id": "00049890716_summer-cooling_20261002-143012_1", "sku": "00049890716",
 "gcs_uri": "gs://products_images_<PROJECT_ID>/00049890716/00049890716_summer-cooling_20261002-143012_1.jpg",
 "url": "/api/img/00049890716/00049890716_summer-cooling_20261002-143012_1.jpg",
 "kind": "generated", "status": "candidate|saved|deleted", "is_primary": false,
 "preset": "summer-cooling", "preset_label": "夏：冷房パワー", "season": "summer",
 "prompt": "...", "extra_prompt": "...", "base_image_uri": "...", "source_url": "",
 "model": "gemini-3.1-flash-image", "width": 300, "height": 300, "aspect": "1:1",
 "fidelity_score": 0.92, "fidelity_note": "同一商品。文字なし。",
 "created_at": "2026-10-02T05:30:12+00:00", "updated_at": "..."}
```

### `POST /api/products/{sku}/images/upload`（multipart, field `file`）
ベース画像のアップロード（jpg/png/webp, ≤10MB）。→ `{"base": {"type": "upload", "uri": "gs://.../{sku}/base/{sku}_base_{ts}.jpg", "url": "/api/img/{sku}/base/..."}}`

### `POST /api/products/{sku}/images/search`
body `{}` → Gemini Google 検索グラウンディングで商品画像候補を探す（数秒〜20秒）。
```json
{"query": "ダイキン S404ATRP-W", "candidates": [{"url": "https://maker.example/img.jpg", "page_url": "https://maker.example/product", "title": "ページタイトル", "width": 800, "height": 800, "via": "grounding"}], "message": ""}
```

### `POST /api/products/{sku}/images/generate`（SSE）
body:
```json
{"base": {"type": "registered|gcs|upload|web|none", "uri": "https://... | gs://..."},
 "presets": ["summer-cooling"], "extra_prompt": "リビングは和室で",
 "n": 3, "aspect": "1:1", "text_mode": "none", "model": "gemini-3.1-flash-image", "size": 300}
```
- `registered`: `uri` 省略時は商品の登録画像。`gcs`: `gs://` パス。`upload`: upload API の `uri`。`web`: 検索候補の `url`。`none`: ベース画像なし（テキストのみで生成。結果に「イメージ」注記）。
- events:
  - `{"event":"start","n":3,"model":"...","base_url":"...","prompt":"最終プロンプト全文","facts":[...]}`
  - `{"event":"progress","index":1,"status":"generating|checking"}`
  - `{"event":"image","index":1,"image": ImageRow}`（`status=candidate`、GCS 保存済み）
  - `{"event":"image_error","index":2,"message":"..."}`
  - `{"event":"complete","count":3,"elapsed_ms":18000}`
  - `{"event":"error","message":"..."}`

### `POST /api/products/{sku}/images/save`
body `{"image_ids": ["..."], "primary_id": "...|null", "update_aics": true}`
```json
{"saved": [ImageRow...],
 "bq": {"table": "<PROJECT_ID>.product_enrichment.product_images", "rows": 2},
 "aics": {"table": "<PROJECT_ID>.ai_commerce_search_dataset.products_aics", "updated": true, "images_total": 4, "backup": "products_aics_backup_20261002", "message": ""}}
```

### `DELETE /api/products/{sku}/images/{image_id}`
→ `{"deleted": true, "image_id": "...", "gcs_deleted": true, "aics": {...}|null}`（保存済み画像を削除した場合は products_aics からも外す）

### `GET /api/img/{path}`
GCS オブジェクト（`products_images_…` バケット内）のプロキシ。`<img src>` にそのまま使える。

---

## ② 資料からの抽出（#/docs）

### `POST /api/docs/upload`（multipart, field `file`、1 リクエスト 1 ファイル、≤30MB）
→ `{"file": {"uri": "gs://products_images_…/_docs_uploads/20261002/{uuid}_{name}", "name": "spec.pdf", "mime": "application/pdf", "size": 123456, "url": "/api/img/_docs_uploads/..."}}`

### `POST /api/docs/list`
body `{"gcs_uri": "gs://bucket/prefix/" | "gs://bucket/file.pdf"}` → `{"files": [{"uri","name","mime","size"}], "skipped": 0}`（対応形式: jpg/jpeg/png/webp/pdf/xlsx/csv、最大 20 件）

### `POST /api/docs/extract`（SSE）
body `{"files": [{"uri","name","mime"}]}`
- `{"event":"start","count":2,"model":"gemini-3.8-flash"}`
- `{"event":"file_start","index":0,"name":"spec.pdf"}`
- `{"event":"file_done","index":0,"name":"spec.pdf","uri":"gs://...","mime":"...","document_type":"spec_sheet","latency_ms":8000,"input_tokens":3000,"output_tokens":800,"products":[ExtractedProduct...]}`
- `{"event":"file_error","index":1,"name":"...","message":"..."}`
- `{"event":"complete","files":2,"products":3}`

`ExtractedProduct`:
```json
{"idx": 0, "model_number": "S404ATRP-W", "jan": "4548…", "title": "...", "brand": "ダイキン", "category": "エアコン",
 "price": 248000, "description": "原文の説明文",
 "attributes": [{"key": "cooling_capacity", "label": "冷房能力", "value": "4.0(0.7～5.3)kW", "evidence": "冷房能力 4.0(0.7～5.3)kW", "page": 2}],
 "confidence": 0.93,
 "matches": [{"sku": "00049890716", "title": "...", "image_url": "...", "score": 0.98, "why": "型番一致"}],
 "suggested_sku": "00049890716"}
```

### `POST /api/docs/preview`
body `{"sku": "00049890716" | null, "new_sku": "DOC-S404ATRP-W" | null, "product": ExtractedProduct, "mode": "fill|overwrite"}`
```json
{"sku": "...", "is_new": false,
 "diff": [{"field": "description", "label": "説明文", "before": "...", "after": "...", "action": "add|overwrite|keep|new"},
          {"field": "attr:冷房能力", "label": "冷房能力", "before": "", "after": "4.0(0.7～5.3)kW", "action": "add"}],
 "changes": 3}
```
- `fill`（既定）= 空欄の項目だけ埋める、`overwrite` = 資料の値で上書き。

### `POST /api/docs/apply`（SSE）
body:
```json
{"items": [{"sku": "00049890716", "new_sku": null, "product": ExtractedProduct, "mode": "fill",
            "file_uri": "gs://...", "file_name": "spec.pdf"}],
 "enrich": true, "update_aics": true}
```
- `{"event":"start","count":1}`
- `{"event":"item_start","index":0,"sku":"..."}`
- `{"event":"merged","index":0,"sku":"...","changes":3,"diff":[...]}`
- `{"event":"enriched","index":0,"sku":"...","attr_count":12,"tag_count":4,"status":"completed|needs_review","fill_before":0.4,"fill_after":0.9,"latency_ms":9000}`
- `{"event":"item_error","index":0,"sku":"...","message":"..."}`
- `{"event":"saved","bq":{"dataset":"...","tables":{"…source_products":1,...,"…doc_extractions":1}}}`
- `{"event":"aics","result":{"table":"…products_aics","updated":1,"inserted":0,"backup":"products_aics_backup_20261002","message":""}}`
- `{"event":"complete","results":[{"sku":"...","status":"ok|error","changes":3}],"elapsed_ms":15000}`
