"""Tests for ① seasonal image studio and ② document extraction (offline: Gemini & GCS are stubbed)."""
import io
import json
import os
import tempfile

os.environ["OFFLINE"] = "true"
os.environ.setdefault("LOCAL_GCS_DIR", tempfile.mkdtemp(prefix="gcs_test_"))

from fastapi.testclient import TestClient  # noqa: E402

from app import doc_extract, image_presets, main  # noqa: E402
from app.config import settings  # noqa: E402
from app.repository import product_to_row, store  # noqa: E402

settings.offline = True

AIRCON = {
    "sku": "A001", "title": "ダイキン 14畳 エアコン S404ATRP-W", "brand": "ダイキン",
    "category": "エアコン・空気清浄機・加湿器・除湿機 > エアコン", "group": "aircon", "price": 248000,
    "description": "●パワフル冷房。●自動お掃除機能。", "product_url": "", "image_url": "",
    "raw_attributes": {"model_number": "S404ATRP-W", "cooling_capacity": "4.0(0.7～5.3)kW", "heating_capacity": "5.0kW"},
}
AIRCON_PM25 = {**AIRCON, "sku": "A002", "description": "●PM2.5フィルター搭載で花粉もキャッチ。",
               "raw_attributes": {"model_number": "AN40ZRP"}}
FAN = {"sku": "F001", "title": "扇風機 DC", "brand": "X", "category": "扇風機", "group": "fan", "price": 5000,
       "description": "", "product_url": "", "image_url": "", "raw_attributes": {}}

client = TestClient(main.app)


def setup_module(_):
    store.products.clear(); store.records.clear(); store.extras.clear(); store.images.clear()
    store.load([dict(AIRCON), dict(AIRCON_PM25), dict(FAN)])


def _ids(presets):
    return {p["id"]: p for p in presets}


def test_presets_gating_pollen_requires_evidence():
    p = _ids(image_presets.evaluate(AIRCON, []))
    assert p["summer-cooling"]["available"] and p["winter-heating"]["available"]
    assert not p["spring-pollen"]["available"]
    assert "花粉" in p["spring-pollen"]["reason"]
    q = _ids(image_presets.evaluate(AIRCON_PM25, []))
    assert q["spring-pollen"]["available"] and "PM2.5" in q["spring-pollen"]["evidence"]


def test_presets_category_filter():
    ids = set(_ids(image_presets.evaluate(FAN, [])))
    assert "winter-heating" not in ids and "summer-breeze" in ids and "ec-white" in ids


def test_generate_save_delete_flow():
    r = client.get("/api/images/presets", params={"sku": "A001"})
    assert r.status_code == 200 and r.json()["options"]["default_size"] == 300
    # unavailable preset is rejected
    bad = client.post("/api/products/A001/images/generate", json={"presets": ["spring-pollen"], "base": {"type": "none"}})
    assert bad.status_code == 400
    with client.stream("POST", "/api/products/A001/images/generate",
                       json={"presets": ["summer-cooling"], "base": {"type": "none"}, "n": 3, "size": 300}) as resp:
        evs = [json.loads(l[6:]) for l in resp.iter_lines() if l.startswith("data: ")]
    imgs = [e["image"] for e in evs if e["event"] == "image"]
    assert len(imgs) == 3 and evs[-1]["event"] == "complete"
    for im in imgs:
        assert im["gcs_uri"].startswith(f"gs://{settings.image_bucket}/A001/A001_summer-cooling_")
        assert im["gcs_uri"].endswith(".jpg") and (im["width"], im["height"]) == (300, 300)
        assert im["url"].startswith("/api/img/A001/")
    # proxy serves the JPEG
    g = client.get(imgs[0]["url"])
    assert g.status_code == 200 and g.headers["content-type"] == "image/jpeg"
    # save 2 (one primary)
    s = client.post("/api/products/A001/images/save",
                    json={"image_ids": [imgs[0]["image_id"], imgs[1]["image_id"]], "primary_id": imgs[1]["image_id"]})
    assert s.status_code == 200 and len(s.json()["saved"]) == 2
    lst = client.get("/api/products/A001/images").json()["images"]
    assert sum(1 for x in lst if x["status"] == "saved") == 2
    assert client.get("/api/products/A001").json()["product"]["images"][0]["is_primary"]
    # delete 1 candidate
    d = client.delete(f"/api/products/A001/images/{imgs[2]['image_id']}")
    assert d.status_code == 200 and d.json()["gcs_deleted"]
    assert client.get(imgs[2]["url"]).status_code == 404
    assert all(x["image_id"] != imgs[2]["image_id"] for x in client.get("/api/products/A001/images").json()["images"])


def test_size_option_non_square():
    with client.stream("POST", "/api/products/A001/images/generate",
                       json={"presets": ["ec-white"], "base": {"type": "none"}, "n": 2, "size": 600, "aspect": "16:9"}) as resp:
        evs = [json.loads(l[6:]) for l in resp.iter_lines() if l.startswith("data: ")]
    im = next(e["image"] for e in evs if e["event"] == "image")
    assert max(im["width"], im["height"]) == 600


def test_xlsx_to_text():
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = "価格表"
    ws.append(["型番", "冷房能力", "価格"]); ws.append(["S404ATRP-W", "4.0kW", 248000])
    buf = io.BytesIO(); wb.save(buf)
    t = doc_extract.xlsx_to_text(buf.getvalue())
    assert "### シート: 価格表" in t and "S404ATRP-W\t4.0kW\t248000" in t


def test_match_sku_by_model_number():
    m = doc_extract.match_sku({"model_number": "s404atrp w", "title": ""}, list(store.products.values()))
    assert m and m[0]["sku"] == "A001" and m[0]["why"] == "型番一致"


EX = {"idx": 0, "model_number": "S404ATRP-W", "title": "ダイキン エアコン", "description": "資料の説明",
      "price": 199800, "attributes": [
          {"key": "cooling_capacity", "label": "冷房能力", "value": "4.0kW", "evidence": "冷房能力 4.0kW", "page": 1},
          {"key": "pm25_filter", "label": "PM2.5フィルター", "value": "あり", "evidence": "PM2.5フィルター搭載", "page": 2}]}


def test_merge_fill_vs_overwrite():
    p, diff = doc_extract.merge(dict(AIRCON), EX, "fill", "A001", "spec.pdf", "gs://b/spec.pdf")
    acts = {d["field"]: d["action"] for d in diff}
    assert acts["attr:cooling_capacity"] == "keep" and p["raw_attributes"]["cooling_capacity"] == "4.0(0.7～5.3)kW"
    assert acts["attr:pm25_filter"] == "add" and p["raw_attributes"]["pm25_filter"] == "あり"
    assert p["doc_sources"][0]["file_name"] == "spec.pdf"
    p2, diff2 = doc_extract.merge(dict(AIRCON), EX, "overwrite", "A001", "spec.pdf", "gs://b/spec.pdf")
    assert p2["raw_attributes"]["cooling_capacity"] == "4.0kW" and p2["price"] == 199800
    new, d3 = doc_extract.merge(None, EX, "fill", "DOC-S404", "spec.pdf", "gs://b/spec.pdf")
    assert new["group"] == "aircon" or new["group"] in ("fan", "aircon")
    assert all(d["action"] == "new" for d in d3)


def test_docs_preview_and_apply():
    r = client.post("/api/docs/preview", json={"sku": "A001", "product": EX, "mode": "fill"})
    assert r.status_code == 200 and r.json()["changes"] >= 1
    with client.stream("POST", "/api/docs/apply", json={"items": [{"sku": "A001", "product": EX, "mode": "fill",
                                                                   "file_uri": "gs://b/spec.pdf", "file_name": "spec.pdf"}]}) as resp:
        evs = [json.loads(l[6:]) for l in resp.iter_lines() if l.startswith("data: ")]
    kinds = [e["event"] for e in evs]
    assert "merged" in kinds and "enriched" in kinds and kinds[-1] == "complete"
    assert evs[-1]["results"][0]["status"] == "ok"
    det = client.get("/api/products/A001").json()
    assert "【資料】" in det["source_text"] and "PM2.5フィルター" in det["source_text"]


def test_product_row_has_latest_columns():
    row = product_to_row({**AIRCON, "source": "doc", "doc_sources": [{"file_name": "x"}]})
    assert row["updated_at"] and row["source"] == "doc" and json.loads(row["doc_sources_json"])[0]["file_name"] == "x"


def test_presets_ignore_scrape_noise():
    noisy = {**AIRCON, "sku": "A003", "raw_attributes": {}, "description":
             "対象商品 日立 エアコン ￥301,100 お気に入り商品 YAMAZEN DCモーター扇風機（省エネ・静音に優れた） 総額： ￥301,100"}
    p = _ids(image_presets.evaluate(noisy, []))
    assert not p["night-quiet"]["available"]


def test_overwrite_keeps_identity_fields():
    p, diff = doc_extract.merge(dict(AIRCON), {**EX, "price": 248000.0}, "overwrite", "A001", "x.pdf", "gs://b/x.pdf")
    acts = {d["field"]: d["action"] for d in diff}
    assert acts["title"] == "keep" and p["title"] == AIRCON["title"]
    assert acts["price"] == "keep"
