import json
import os

os.environ["OFFLINE"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.config import settings  # noqa: E402
from app.pipeline import process_stage1, process_stage3  # noqa: E402
from app.repository import store  # noqa: E402

settings.offline = True

FRIDGE = {
    "sku": "T001", "title": "ハイアール 406L 4ドア冷蔵庫 JR-GX41E5-H", "brand": "ハイアール",
    "category": "冷蔵庫・洗濯機 > 冷蔵庫 > 3～5人向け冷蔵庫", "group": "fridge", "price": 139800,
    "description": "●冷凍室142Lのジャイアントフリーザー。●自動製氷機能搭載。●ガラストップドア。",
    "product_url": "https://store.example.com/detail.html?p_cd=T001", "image_url": "",
    "raw_attributes": {"dimensions": "W70.0×H177.5×D68.0cm", "weight": "110kg", "capacity": "406L",
                       "freezer_capacity": "142L", "refrigerator_capacity": "264L"},
}

STAGE1 = {"attributes": [
    {"key": "width_mm", "raw_value": "W70.0×H177.5×D68.0cm", "evidence": "W70.0×H177.5×D68.0cm", "source_field": "attributes", "confidence": 0.98},
    {"key": "weight_kg", "raw_value": "110kg", "evidence": "110kg", "source_field": "attributes", "confidence": 0.95},
    {"key": "total_capacity_l", "raw_value": "406L", "evidence": "406L", "source_field": "title", "confidence": 0.97},
    {"key": "freezer_capacity_l", "raw_value": "142L", "evidence": "冷凍室142L", "source_field": "description", "confidence": 0.9},
    {"key": "door_count", "raw_value": "4ドア", "evidence": "4ドア冷蔵庫", "source_field": "title", "confidence": 0.95},
    {"key": "household_size", "raw_value": "3～5人", "evidence": "4人家族におすすめ", "source_field": "description", "confidence": 0.7},
], "not_found": ["apf"]}
STAGE3 = {"feature_tags": [{"tag": "自動製氷", "evidence": "自動製氷機能搭載", "confidence": 0.95},
                           {"tag": "スマホ連携", "evidence": "アプリで操作", "confidence": 0.6}],
          "search_keywords": ["406L 冷蔵庫"], "ai_summary": "大容量冷凍室と自動製氷を備えた406Lの4ドア冷蔵庫。"}


def setup_module(_):
    store.products.clear(); store.records.clear(); store.extras.clear(); store.reviews.clear()
    store.load([FRIDGE])
    recs = process_stage1(FRIDGE, STAGE1, None, "job-test", "m")
    tags, extras = process_stage3(FRIDGE, STAGE3, None, "job-test", "m")
    store.save_enrichment("T001", recs + tags, extras, "job-test")


client = TestClient(main.app)


def test_pipeline_gates():
    recs = {r["attr_key"]: r for r in store.records["T001"]}
    assert recs["width_mm"]["value"] == 700.0 and recs["width_mm"]["gate_status"] == "auto_approved"
    assert recs["household_size"]["gate_status"] == "needs_review"          # evidence not in source
    assert recs["tag:スマホ連携"]["gate_status"] == "needs_review"
    assert recs["tag:自動製氷"]["gate_status"] == "auto_approved"


def test_config_and_dashboard():
    cfg = client.get("/api/config").json()
    assert cfg["threshold"] == 0.9
    assert cfg["model"] == "gemini-3.8-flash"
    d = client.get("/api/dashboard").json()
    assert d["totals"]["skus"] == 1 and d["totals"]["needs_review"] >= 2
    assert 0 <= d["fill_rate"]["before"] <= d["fill_rate"]["after"] <= 1
    assert {"extracted", "auto_approved", "needs_review"} <= set(d["funnel"])


def test_products_and_detail():
    items = client.get("/api/products").json()["items"]
    assert items[0]["sku"] == "T001" and items[0]["status"] == "needs_review"
    d = client.get("/api/products/T001").json()
    assert d["product"]["group_label"] == "冷蔵庫"
    assert any(t["key"] == "width_mm" for t in d["targets"])
    assert "W70.0×H177.5×D68.0cm" in d["source_text"]
    assert "gmc" in d and "question_and_answer" in d["gmc"]
    assert client.get("/api/products/NOPE").status_code == 404


def test_review_flow():
    q = client.get("/api/reviews").json()
    assert q["count"] >= 2
    r = client.post("/api/reviews/T001/household_size", json={"action": "edit", "value": "3～5人", "comment": "確認済"})
    assert r.status_code == 200 and r.json()["record"]["gate_status"] == "edited"
    r = client.post("/api/reviews/T001/tag%3Aスマホ連携", json={"action": "reject"})
    assert r.status_code == 200 and r.json()["record"]["gate_status"] == "human_rejected"
    assert r.json()["remaining"] == client.get("/api/reviews").json()["count"]
    assert client.post("/api/reviews/T001/width_mm", json={"action": "bogus"}).status_code == 400


def test_golden_and_csv():
    g = client.get("/api/golden").json()["items"][0]
    assert g["attributes"]["width_mm"]["value"] == 700.0
    assert "自動製氷" in g["feature_tags"] and "スマホ連携" not in g["feature_tags"]
    csv_text = client.get("/api/golden/export.csv").text
    assert "width_mm" in csv_text.splitlines()[0]


def test_csv_live_test_endpoints():
    samp = client.get("/api/csv/sample").json()
    assert samp["count"] == 3
    assert samp["items"][0]["sku"].startswith("CSV-")
    dl = client.get("/api/csv/sample.csv")
    assert dl.status_code == 200 and "CSV-FRIDGE-001" in dl.text

    parsed = client.post("/api/csv/parse", json={"csv_text": samp["csv_text"]}).json()
    assert parsed["count"] == 3
    assert parsed["items"][0]["group"] == "fridge"

    # Run SSE live enrichment on 1 CSV product in offline mode
    res = client.post("/api/csv/enrich", json={"products": [parsed["items"][0]], "save_to_bq": True})
    assert res.status_code == 200
    events = [json.loads(line[5:].strip()) for line in res.text.splitlines() if line.startswith("data:")]
    ev_names = [e["event"] for e in events]
    assert "start" in ev_names and "sku_done" in ev_names and "complete" in ev_names
    comp = [e for e in events if e["event"] == "complete"][0]
    assert comp["processed"] == 1 and comp["model"] == "gemini-3.8-flash"


def test_gmc_conversational_endpoints():
    gl = client.get("/api/gmc").json()
    assert "17085370" in gl["spec_url"]
    assert gl["total"] >= 1
    sku = gl["items"][0]["sku"]

    det = client.get(f"/api/gmc/{sku}").json()
    assert det["gmc"]["sku"] == sku
    assert det["gmc"]["item_group_title"]
    assert det["feed_row"]["id"] == sku

    gen = client.post(f"/api/gmc/{sku}/generate").json()
    assert gen["gmc"]["model"] == "gemini-3.8-flash"

    upd = client.put(f"/api/gmc/{sku}", json={
        "item_group_title": "ハイアール 406L 4ドア冷蔵庫 JR-GX41E5",
        "popularity_rank": 96.5,
        "variant_options": [{"name": "カラー", "value": "ガラストップグレー", "evidence": "ガラストップドア"}],
        "questions_and_answers": [
            {"question": "冷凍室の容量は？", "answer": "冷凍室は142Lの大容量です。", "evidence": "冷凍室142L", "confidence": 0.98}
        ],
    }).json()
    assert upd["gmc"]["item_group_title"] == "ハイアール 406L 4ドア冷蔵庫 JR-GX41E5"
    assert "カラー:ガラストップグレー" in upd["gmc"]["variant_option"]
    assert '"冷凍室の容量は？":"冷凍室は142Lの大容量です。"' in upd["gmc"]["question_and_answer"]

    tsv = client.get("/api/gmc/export.tsv")
    assert tsv.status_code == 200 and "question_and_answer\tproduct_highlight" in tsv.text.splitlines()[0]
    csv_res = client.get("/api/gmc/export.csv")
    assert csv_res.status_code == 200 and "question_and_answer" in csv_res.text.splitlines()[0]


def test_cost_estimate_and_index():
    c = client.get("/api/cost/estimate?skus=200000").json()
    assert c["total_jpy_slide"] == round(0.061 * 200000, 1)
    assert client.get("/").status_code == 200


def test_response_schema_shapes():
    from app.schema import stage1_schema, stage3_schema, gmc_schema, CATEGORY_GROUPS
    for g in CATEGORY_GROUPS:
        s1 = stage1_schema(g)
        item = s1["properties"]["attributes"]["items"]
        assert set(item["required"]) == {"key", "raw_value", "evidence", "source_field", "confidence"}
        assert item["properties"]["key"]["enum"]
        assert stage3_schema(g)["properties"]["feature_tags"]["items"]["properties"]["tag"]["enum"]
        sg = gmc_schema()
        assert "questions_and_answers" in sg["properties"] and "variant_options" in sg["properties"]
        json.dumps(s1, ensure_ascii=False)
        json.dumps(sg, ensure_ascii=False)

