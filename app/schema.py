"""Target (golden-record) attribute schema and Gemini responseSchema definitions."""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Category groups ──────────────────────────────────────────────────────────
CATEGORY_GROUPS = {
    "fridge": "冷蔵庫",
    "aircon": "エアコン",
    "fan": "扇風機・サーキュレーター",
    "handy": "ハンディファン・小型扇風機",
}


def category_group(category_path: str) -> str:
    """Map a product category path ('A > B > C') to a category group key."""
    p = category_path or ""
    if "エアコン" in p:
        return "aircon"
    if "冷蔵庫" in p or "冷凍庫" in p:
        return "fridge"
    if "ハンディファン" in p or "ミニ扇風機" in p or "壁掛け扇" in p:
        return "handy"
    return "fan"


@dataclass(frozen=True)
class AttrDef:
    key: str
    label: str
    type: str  # number | text | bool
    unit: str = ""
    kind: str = ""  # normalizer kind (length/weight/volume/...)
    groups: tuple[str, ...] = ("fridge", "aircon", "fan", "handy")
    limits: tuple[float, float] | None = None
    raw_keys: tuple[str, ...] = field(default_factory=tuple)  # source attribute keys that carry the same info


ALL = ("fridge", "aircon", "fan", "handy")
ATTRS: list[AttrDef] = [
    # common
    AttrDef("width_mm", "幅", "number", "mm", "dim_w", ALL, (10, 5000), ("dimensions", "indoor_unit_dimensions")),
    AttrDef("height_mm", "高さ", "number", "mm", "dim_h", ALL, (10, 5000), ("dimensions", "indoor_unit_dimensions")),
    AttrDef("depth_mm", "奥行", "number", "mm", "dim_d", ALL, (5, 5000), ("dimensions", "indoor_unit_dimensions")),
    AttrDef("weight_kg", "重量", "number", "kg", "weight", ALL, (0.03, 300), ("weight", "indoor_unit_weight")),
    AttrDef("power_consumption_w", "消費電力", "number", "W", "power_w", ("fridge", "fan", "handy"), (0.1, 3000), ("power_consumption",)),
    AttrDef("annual_power_kwh", "年間消費電力量", "number", "kWh/年", "kwh", ("fridge", "aircon"), (10, 10000), ("annual_power_consumption",)),
    AttrDef("annual_cost_jpy", "年間電気代", "number", "円", "yen", ("fridge", "aircon"), (100, 500000), ("annual_electricity_cost",)),
    AttrDef("energy_rating", "省エネ評価(多段階)", "number", "★", "rating", ("fridge", "aircon"), (1, 5), ("energy_saving_performance",)),
    AttrDef("power_supply_v", "電源電圧", "number", "V", "voltage", ALL, (3, 240), ("power_supply",)),
    # fridge
    AttrDef("total_capacity_l", "定格内容積", "number", "L", "volume", ("fridge",), (1, 1000), ("capacity",)),
    AttrDef("freezer_capacity_l", "冷凍室容量", "number", "L", "volume", ("fridge",), (0, 600), ("freezer_capacity",)),
    AttrDef("fridge_capacity_l", "冷蔵室容量", "number", "L", "volume", ("fridge",), (0, 800), ("refrigerator_capacity",)),
    AttrDef("vegetable_capacity_l", "野菜室容量", "number", "L", "volume", ("fridge",), (0, 300), ("vegetable_compartment_capacity",)),
    AttrDef("door_count", "ドア数", "number", "ドア", "count", ("fridge",), (1, 8), ()),
    AttrDef("door_type", "ドアタイプ", "text", "", "text", ("fridge",), None, ("door_type",)),
    AttrDef("household_size", "目安の世帯人数", "text", "", "text", ("fridge",), None, ()),
    # aircon
    AttrDef("cooling_tatami_min", "冷房 目安畳数(下限)", "number", "畳", "tatami_min", ("aircon",), (1, 60), ("cooling_area_coverage",)),
    AttrDef("cooling_tatami_max", "冷房 目安畳数(上限)", "number", "畳", "tatami_max", ("aircon",), (1, 80), ("cooling_area_coverage",)),
    AttrDef("cooling_capacity_kw", "冷房能力", "number", "kW", "kw", ("aircon",), (0.5, 20), ("cooling_capacity",)),
    AttrDef("heating_capacity_kw", "暖房能力", "number", "kW", "kw", ("aircon",), (0.5, 25), ("heating_capacity",)),
    AttrDef("apf", "通年エネルギー消費効率(APF)", "number", "", "plain", ("aircon",), (2, 10), ("apf",)),
    AttrDef("noise_db", "運転音", "number", "dB", "db", ("aircon", "fan", "handy"), (5, 80), ("cooling_noise_level", "noise_level")),
    # fans
    AttrDef("blade_count", "羽根枚数", "number", "枚", "count", ("fan", "handy"), (1, 20), ("number_of_blades",)),
    AttrDef("motor_type", "モーター方式", "text", "", "motor", ("fan", "handy"), None, ("motor_type",)),
    AttrDef("is_cordless", "コードレス(充電式)", "bool", "", "bool", ("fan", "handy"), None, ()),
    AttrDef("battery_hours", "連続使用時間(最大)", "number", "時間", "hours", ("fan", "handy"), (0.1, 100), ("continuous_use_time", "battery_life")),
    AttrDef("charging_hours", "充電時間", "number", "時間", "hours", ("fan", "handy"), (0.1, 48), ("charging_time",)),
    AttrDef("airflow_levels", "風量段階", "number", "段階", "count", ("fan", "handy"), (1, 120), ("airflow_control",)),
]
ATTR_BY_KEY = {a.key: a for a in ATTRS}
ALL_ATTRIBUTE_KEYS = [a.key for a in ATTRS]


def attrs_for_group(group: str) -> list[AttrDef]:
    return [a for a in ATTRS if group in a.groups]


# ── Standard feature tag dictionary (Stage 3) ─────────────────────────────────
FEATURE_TAGS: dict[str, list[str]] = {
    "fridge": ["自動製氷", "フレンチドア", "観音開き", "片開き", "ガラストップ", "大容量冷凍", "急速冷凍", "チルド/パーシャル",
               "野菜室まんなか", "真ん中冷凍", "スマホ連携", "省エネ", "薄型/スリム", "静音", "ポータブル/車載", "オリジナルモデル"],
    "aircon": ["自動お掃除", "フィルター自動清掃", "凍結洗浄", "空気清浄", "加湿", "除湿", "スマホ連携", "AI自動運転",
               "人感センサー", "寒冷地向け", "省エネ", "静音", "200V", "100V", "工事費込み", "オリジナルモデル"],
    "fan": ["DCモーター", "ACモーター", "首振り(左右)", "首振り(上下)", "3D首振り", "リモコン付き", "タイマー", "静音",
            "コードレス", "温度センサー", "マイナスイオン", "上下分割/高さ調整", "サーキュレーター兼用", "省エネ"],
    "handy": ["コードレス", "USB充電", "首掛け", "卓上スタンド", "クリップ", "折りたたみ", "冷却プレート", "静音",
              "大容量バッテリー", "モバイルバッテリー機能", "DCモーター", "ミスト", "軽量"],
}

# ── Gemini responseSchema (OpenAPI subset used by Vertex AI) ─────────────────


def stage1_schema(group: str) -> dict:
    keys = [a.key for a in attrs_for_group(group)]
    return {
        "type": "OBJECT",
        "properties": {
            "attributes": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "key": {"type": "STRING", "enum": keys},
                        "raw_value": {"type": "STRING", "description": "原文に書かれている値を単位込みでそのまま転記（換算しない）"},
                        "evidence": {"type": "STRING", "description": "根拠となる原文の連続した文字列を一字一句そのままコピー（30字以内）"},
                        "source_field": {"type": "STRING", "enum": ["title", "description", "attributes"]},
                        "confidence": {"type": "NUMBER", "description": "0.0〜1.0 の自己確信度"},
                    },
                    "required": ["key", "raw_value", "evidence", "source_field", "confidence"],
                },
            },
            "not_found": {"type": "ARRAY", "items": {"type": "STRING", "enum": keys},
                          "description": "原文に記載がなく抽出できなかった属性キー（推測で埋めない）"},
        },
        "required": ["attributes", "not_found"],
    }


def stage3_schema(group: str) -> dict:
    return {
        "type": "OBJECT",
        "properties": {
            "feature_tags": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "tag": {"type": "STRING", "enum": FEATURE_TAGS[group]},
                        "evidence": {"type": "STRING", "description": "根拠となる原文の文字列（一字一句コピー、30字以内）"},
                        "confidence": {"type": "NUMBER"},
                    },
                    "required": ["tag", "evidence", "confidence"],
                },
            },
            "search_keywords": {"type": "ARRAY", "items": {"type": "STRING"},
                                "description": "顧客が検索しそうな日本語キーワード（5〜8個、原文の事実に基づく）"},
            "ai_summary": {"type": "STRING", "description": "商品の特長を60〜90字で要約（原文にない事実は書かない）"},
        },
        "required": ["feature_tags", "search_keywords", "ai_summary"],
    }


def gmc_schema() -> dict:
    """Google Merchant Center Conversational Attributes schema (https://support.google.com/merchants/answer/17085370)."""
    return {
        "type": "OBJECT",
        "properties": {
            "item_group_id": {
                "type": "STRING",
                "description": "バリエーション共通のベース型番・シリーズID（色サフィックス等を除いた型番。例: JR-GX41E5、GR-W36SC）",
            },
            "item_group_title": {
                "type": "STRING",
                "description": "商品グループのタイトル [item_group_title]（色や細かな枝番を除いたシリーズ共通タイトル）",
            },
            "variant_options": {
                "type": "ARRAY",
                "description": "バリエーション オプション [variant_option]（色・容量・サイズ・開閉方向・電源などバリエーションを識別する name:value ペア）",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING", "description": "属性名（例: カラー、容量、ドア開閉、畳数目安、電源）"},
                        "value": {"type": "STRING", "description": "属性値（例: マットホワイト、356L、右開き、18畳、200V）"},
                        "evidence": {"type": "STRING", "description": "根拠となる原文の文字列（30字以内）"},
                    },
                    "required": ["name", "value", "evidence"],
                },
            },
            "questions_and_answers": {
                "type": "ARRAY",
                "description": "質問と回答 [question_and_answer]（購入検討者がAI検索で尋ねる具体的な質問と、原文の事実のみに基づく正確な回答 3〜5件）",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "question": {"type": "STRING", "description": "購入検討者からの自然な質問（？で終わる）"},
                        "answer": {"type": "STRING", "description": "原文の数値・仕様に基づく簡潔で正確な回答"},
                        "evidence": {"type": "STRING", "description": "回答の根拠となる原文の連続した文字列（一字一句コピー、30字以内）"},
                        "confidence": {"type": "NUMBER", "description": "0.0〜1.0 の自己確信度"},
                    },
                    "required": ["question", "answer", "evidence", "confidence"],
                },
            },
            "product_highlights": {
                "type": "ARRAY",
                "description": "商品に関する情報 [product_highlight]（商品の主なセールスポイント・特長 3〜5件、各40字以内）",
                "items": {"type": "STRING"},
            },
            "related_mentions": {
                "type": "ARRAY",
                "description": "関連商品 [related_product]（説明文中に記載されている別売品・アクセサリ・同時購入品・別バリエーション型番があれば抽出）",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "relationship_type": {
                            "type": "STRING",
                            "enum": ["often_bought_with", "accessory", "required_part", "similar_to", "substitute"],
                        },
                        "identifier_type": {"type": "STRING", "enum": ["id", "mpn", "gtin"]},
                        "identifier": {"type": "STRING", "description": "型番(MPN)または商品ID"},
                        "title": {"type": "STRING", "description": "関連商品の名称"},
                    },
                    "required": ["relationship_type", "identifier_type", "identifier", "title"],
                },
            },
            "document_link": {
                "type": "STRING",
                "description": "ドキュメントリンク [document_link]（原文にPDF URLがあれば記載、なければ空文字）",
            },
        },
        "required": [
            "item_group_id",
            "item_group_title",
            "variant_options",
            "questions_and_answers",
            "product_highlights",
            "related_mentions",
            "document_link",
        ],
    }

