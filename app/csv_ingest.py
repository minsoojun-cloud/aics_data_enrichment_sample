"""CSV parsing and sample CSV generation for Live Enrichment testing."""
from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

from .schema import CATEGORY_GROUPS, category_group

# Flexible header aliases (Japanese & English)
HEADER_MAP = {
    "sku": {"sku", "id", "p_cd", "product_id", "item_id", "商品コード", "商品id", "品番", "jan"},
    "title": {"title", "name", "product_name", "商品名", "タイトル", "品名"},
    "brand": {"brand", "brands", "maker", "ブランド", "メーカー"},
    "category": {"category", "categories", "category_path", "カテゴリ", "カテゴリー", "分類"},
    "description": {"description", "desc", "body", "説明文", "商品説明", "商品の説明", "詳細説明"},
    "price": {"price", "sale_price", "価格", "販売価格", "税込価格"},
    "product_url": {"product_url", "uri", "url", "link", "商品url", "リンク"},
    "image_url": {"image_url", "image", "image_link", "thumbnail", "画像url", "商品画像"},
    "group": {"group", "category_group", "カテゴリグループ"},
    "raw_attributes_json": {"raw_attributes_json", "raw_attributes", "attributes_json"},
}

SAMPLE_PRODUCTS = [
    {
        "sku": "CSV-FRIDGE-001",
        "title": "パナソニック 【右開き】 365L 3ドアノンフロン冷蔵庫 うす型スリム グレイスゴールド NR-C374C-N",
        "brand": "パナソニック",
        "category": "冷蔵庫・洗濯機・家事・掃除機 > 冷蔵庫 > 2〜4人向け冷蔵庫（300〜399L）",
        "description": "奥行60cmのうす型設計でシステムキッチンにすっきり収まる365L 3ドア冷蔵庫。よく使う野菜室が真ん中にあるから出し入れラクラク。急凍機能と自動製氷システム（洗える製氷皿）を搭載。AIエコナビが部屋の明るさや開閉回数を学習して自動で節電運転。定格内容積365L（冷蔵室212L・野菜室87L・冷凍室66L）。年間消費電力量341kWh/年、年間電気代目安 約9,210円。省エネ基準達成率102%（多段階評価 2.2）。",
        "price": 128000,
        "product_url": "https://store.example.com/detail.html?p_cd=CSV-FRIDGE-001",
        "image_url": "https://store.example.com/CSfLastGenGoodsPage_001/img/noimage_l.jpg",
        "dimensions": "W59.0×H180.2×D60.0cm",
        "weight": "68kg",
        "capacity": "365L",
        "refrigerator_capacity": "212L",
        "freezer_capacity": "66L",
        "vegetable_compartment_capacity": "87L",
        "door_type": "右開き",
        "annual_power_consumption": "341kWh",
        "annual_electricity_cost": "約9,210円",
        "energy_saving_performance": "多段階評価 2.2",
        "power_supply": "AC100V",
    },
    {
        "sku": "CSV-AIRCON-002",
        "title": "ダイキン 「工事代金別」 14畳 プレミアムエアコン うるさらX RXシリーズ ホワイト S404ATRP-W",
        "brand": "ダイキン",
        "category": "エアコン・空気清浄機・季節家電 > エアコン > おもに14畳用",
        "description": "無給水加湿「うるる加湿」と換気・除湿・冷暖房を1台に凝縮したフラッグシップエアコン（おもに14畳用）。AI快適自動運転が床・壁温度を検知して気流を制御。水内部クリーン（結露水洗浄）とフィルター自動お掃除機能で内部も清潔。スマホアプリ「Daikin Smart APP」対応。冷房目安11〜17畳（冷房能力4.0kW）、暖房目安11〜14畳（暖房能力5.0kW）。単相200V 20A、通年エネルギー消費効率(APF) 6.7、期間消費電力量1,066kWh、年間電気代 約28,800円、多段階評価 ★★★★☆。別売無線LANアダプター不要（内蔵）。",
        "price": 248000,
        "product_url": "https://store.example.com/detail.html?p_cd=CSV-AIRCON-002",
        "image_url": "https://store.example.com/CSfLastGenGoodsPage_001/img/noimage_l.jpg",
        "indoor_unit_dimensions": "W79.8×H29.5×D37.0cm",
        "indoor_unit_weight": "16.0kg",
        "cooling_area_coverage": "11～17畳",
        "cooling_capacity": "4.0(0.7～5.3)kW",
        "heating_capacity": "5.0(0.6～11.7)kW",
        "apf": "6.7",
        "annual_power_consumption": "1,066kWh",
        "annual_electricity_cost": "約28,800円",
        "energy_saving_performance": "★★★★☆",
        "power_supply": "単相200V 20A",
        "cooling_noise_level": "59dB",
    },
    {
        "sku": "CSV-FAN-003",
        "title": "シロカ DC音声操作サーキュレーター扇風機 ポチタマ扇 ホワイト SF-V191(W)",
        "brand": "シロカ",
        "category": "エアコン・空気清浄機・季節家電 > 扇風機・サーキュレーター > リビング扇風機",
        "description": "「ポチ、お願い」「タマ、風強く」など声だけで操作できるDCモーター搭載リビング扇風機。独自の「ふわビューン技術」でやさしい微風からパワフルな直進風まで8段階の風量調節に対応。左右首振り・上下首振りの3D立体首振り機能、リモコン付き、おやすみタイマー搭載。静音モード時は木の葉のふれあう音より静かな約13dB。消費電力24W、羽根枚数7枚。",
        "price": 16800,
        "product_url": "https://store.example.com/detail.html?p_cd=CSV-FAN-003",
        "image_url": "https://store.example.com/CSfLastGenGoodsPage_001/img/noimage_l.jpg",
        "dimensions": "W36.0×H88.0×D30.0cm",
        "weight": "約4.2kg",
        "power_consumption": "24W",
        "number_of_blades": "7枚",
        "motor_type": "DCモーター",
        "airflow_control": "8段階",
        "noise_level": "13dB",
        "power_supply": "AC100V",
    },
]

SAMPLE_CSV_COLUMNS = [
    "sku", "title", "brand", "category", "description", "price", "product_url", "image_url",
    "dimensions", "indoor_unit_dimensions", "weight", "indoor_unit_weight", "capacity",
    "refrigerator_capacity", "freezer_capacity", "vegetable_compartment_capacity", "door_type",
    "cooling_area_coverage", "cooling_capacity", "heating_capacity", "apf",
    "annual_power_consumption", "annual_electricity_cost", "energy_saving_performance",
    "power_supply", "power_consumption", "number_of_blades", "motor_type", "airflow_control", "noise_level",
]


def sample_csv_text() -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.DictWriter(buf, fieldnames=SAMPLE_CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for p in SAMPLE_PRODUCTS:
        writer.writerow({k: p.get(k, "") for k in SAMPLE_CSV_COLUMNS})
    return buf.getvalue()


def decode_csv_bytes(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _norm_header(h: str) -> str:
    return re.sub(r"[\s_\-]+", "_", (h or "").strip().lower())


def _parse_price(val: Any) -> float | None:
    if val is None:
        return None
    s = re.sub(r"[^\d.]", "", str(val))
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_csv_text(text: str) -> tuple[list[dict], list[str]]:
    """Parse CSV text into normalized product dicts ready for enrichment."""
    text = (text or "").lstrip("\ufeff").strip()
    if not text:
        raise ValueError("CSVデータが空です")

    reader = csv.DictReader(io.StringIO(text))
    headers = [h for h in (reader.fieldnames or []) if h]
    if not headers:
        raise ValueError("CSVヘッダー行が見つかりません")

    # Map each column to canonical field or raw_attribute
    col_map: dict[str, str] = {}
    for h in headers:
        nh = _norm_header(h)
        matched = None
        for canon, aliases in HEADER_MAP.items():
            if nh in aliases or h.strip() in aliases:
                matched = canon
                break
        if matched and matched not in col_map.values():
            col_map[h] = matched
        else:
            col_map[h] = f"raw:{h.strip()}"

    products: list[dict] = []
    for idx, row in enumerate(reader, start=1):
        if not row or not any((v or "").strip() for v in row.values()):
            continue
        p: dict[str, Any] = {
            "sku": "",
            "title": "",
            "brand": "",
            "category": "",
            "description": "",
            "price": None,
            "product_url": "",
            "image_url": "",
            "group": "",
            "raw_attributes": {},
        }
        for h, val in row.items():
            if not h:
                continue
            v = (val or "").strip()
            if not v:
                continue
            target = col_map.get(h, f"raw:{h}")
            if target == "price":
                p["price"] = _parse_price(v)
            elif target == "raw_attributes_json":
                try:
                    parsed = json.loads(v)
                    if isinstance(parsed, list):
                        for kv in parsed:
                            if isinstance(kv, dict) and kv.get("k"):
                                p["raw_attributes"][str(kv["k"])] = str(kv.get("v", ""))
                    elif isinstance(parsed, dict):
                        for rk, rv in parsed.items():
                            p["raw_attributes"][str(rk)] = str(rv)
                except Exception:
                    p["raw_attributes"]["raw_attributes_json"] = v
            elif target.startswith("raw:"):
                rk = target[4:]
                p["raw_attributes"][rk] = v
            else:
                p[target] = v

        if not p["sku"]:
            p["sku"] = f"CSV-{idx:04d}"
        if not p["title"]:
            p["title"] = p["raw_attributes"].get("title") or f"商品 {p['sku']}"
        if p["group"] not in CATEGORY_GROUPS:
            p["group"] = category_group(f"{p['category']} {p['title']}")
        if not p["category"]:
            p["category"] = CATEGORY_GROUPS.get(p["group"], "家電")
        products.append(p)

    if not products:
        raise ValueError("有効な商品行が見つかりませんでした")
    return products, headers
