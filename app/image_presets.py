"""Seasonal / promotional image presets and rule-based availability ("only if the product has the feature").

Availability is decided by rules only (approved attributes, approved feature tags, raw catalog attributes and
keyword evidence in the source text) – deterministic, fast and explainable. Gemini is not used here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .prompts import source_text
from .rules import FINAL_OK
from .schema import ATTR_BY_KEY

ALL_GROUPS = frozenset({"fridge", "aircon", "fan", "handy"})
SEASON_LABEL = {"spring": "春", "rainy": "梅雨", "summer": "夏", "autumn": "秋", "winter": "冬",
                "yearend": "年末", "newlife": "新生活", "all": "通年"}


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    season: str
    icon: str
    groups: frozenset
    prompt: str
    attrs: tuple[str, ...] = ()        # approved golden attribute keys that satisfy the requirement
    raw_keys: tuple[str, ...] = ()     # raw catalog attribute keys that satisfy the requirement
    tags: tuple[str, ...] = ()         # approved feature tags that satisfy the requirement
    text_regex: str = ""               # keyword evidence in the source text
    facts: tuple[str, ...] = ()        # verified spec keys allowed in the image text
    need_label: str = ""               # used in the "not available" reason
    always: bool = False               # no requirement

    @property
    def requires_any(self) -> bool:
        return not self.always


PRESETS: list[Preset] = [
    # ── Aircon ────────────────────────────────────────────────────────────
    Preset("summer-cooling", "夏：冷房パワー", "summer", "☀️", frozenset({"aircon"}),
           "真夏の強い日差しが差し込む明るいリビング。エアコンから涼しい風が部屋いっぱいに広がる爽快感。青と白を基調にした涼しげなトーン。",
           attrs=("cooling_capacity_kw", "cooling_tatami_max"), raw_keys=("cooling_capacity", "cooling_area_coverage"),
           facts=("cooling_capacity_kw", "cooling_tatami_min", "cooling_tatami_max"), need_label="冷房能力"),
    Preset("spring-pollen", "春：花粉・空気清浄", "spring", "🌸", frozenset({"aircon"}),
           "春のやわらかな光。窓の外には桜と舞う花粉、室内はフィルターで澄んだきれいな空気。パステルグリーンと白の清潔感あるトーン。",
           tags=("空気清浄",), text_regex=r"花粉|PM2\.5|空気清浄|集じん|集塵|脱臭フィルター|清浄フィルター",
           need_label="花粉・空気清浄・フィルター"),
    Preset("rainy-dehumid", "梅雨：除湿・カラッと快適", "rainy", "☔", frozenset({"aircon"}),
           "梅雨の雨の日、窓の外は雨でも室内はカラッと快適。部屋干しの洗濯物、さわやかな水色とグレーのトーン。",
           tags=("除湿",), text_regex=r"除湿|ドライ|再熱", need_label="除湿機能"),
    Preset("autumn-clean", "秋：お手入れ・清潔", "autumn", "🍂", frozenset({"aircon"}),
           "秋の穏やかな午後。清潔に保たれたエアコンと整った室内。暖かみのあるベージュとオレンジのトーン。",
           tags=("自動お掃除", "フィルター自動清掃", "凍結洗浄"), raw_keys=("auto_filter_cleaning",),
           text_regex=r"お掃除|自動清掃|凍結洗浄|内部クリーン", need_label="自動お掃除・洗浄機能"),
    Preset("winter-heating", "冬：暖房パワー", "winter", "❄️", frozenset({"aircon"}),
           "雪の降る冬の夜、暖かいオレンジ色の光に包まれた家族団らんのリビング。足元までぽかぽかの雰囲気。",
           attrs=("heating_capacity_kw",), raw_keys=("heating_capacity", "low_temp_heating_capacity"),
           facts=("heating_capacity_kw",), need_label="暖房能力"),
    # ── Fridge ────────────────────────────────────────────────────────────
    Preset("summer-ice", "夏：冷たい飲み物・自動製氷", "summer", "🧊", frozenset({"fridge"}),
           "夏のキッチン。冷えた飲み物と氷がたっぷり。爽やかな水色と白のトーン。",
           tags=("自動製氷",), text_regex=r"製氷", need_label="製氷機能"),
    Preset("yearend-freezer", "年末：大容量・まとめ買い", "yearend", "🎍", frozenset({"fridge"}),
           "年末の買い出し後、食材がたっぷり収まった冷蔵庫。華やかで温かみのある年末の雰囲気（赤と金のアクセント）。",
           tags=("大容量冷凍",), attrs=("total_capacity_l", "freezer_capacity_l"), raw_keys=("capacity", "freezer_capacity"),
           facts=("total_capacity_l", "freezer_capacity_l"), need_label="容量情報"),
    Preset("newlife-slim", "新生活：スリム設置", "newlife", "🌱", frozenset({"fridge"}),
           "春の新生活。すっきりしたワンルーム・新居のキッチンにぴったり収まる様子。明るい若草色のトーン。",
           tags=("薄型/スリム",), attrs=("width_mm",), raw_keys=("dimensions",), facts=("width_mm", "depth_mm"),
           need_label="サイズ情報"),
    # ── Fans ──────────────────────────────────────────────────────────────
    Preset("summer-breeze", "夏：涼しい風", "summer", "🌬️", frozenset({"fan", "handy"}),
           "真夏の日差し、心地よい風で涼む人。青空と白い雲、爽やかなブルーのトーン。",
           always=True),
    Preset("outdoor-handy", "夏のおでかけ：持ち運び", "summer", "🎒", frozenset({"handy"}),
           "夏のおでかけ（街歩き・フェス・通勤）で手軽に使う様子。明るく元気な色合い。",
           tags=("コードレス", "USB充電", "首掛け"), attrs=("is_cordless", "battery_hours"), text_regex=r"充電|コードレス|USB",
           facts=("battery_hours",), need_label="コードレス・充電式"),
    Preset("winter-circulate", "冬：暖房の空気循環", "winter", "🔄", frozenset({"fan"}),
           "冬のリビングでサーキュレーターが暖房の暖かい空気を循環させる様子。暖かいオレンジとクリーム色。",
           tags=("サーキュレーター兼用",), text_regex=r"サーキュレーター|循環", need_label="サーキュレーター機能"),
    # ── Shared ────────────────────────────────────────────────────────────
    Preset("night-quiet", "夏の夜：静音", "summer", "🌙", frozenset({"aircon", "fan", "handy", "fridge"}),
           "静かな夜の寝室。月明かりの中、家族がぐっすり眠る落ち着いた雰囲気。紺と柔らかな黄色のトーン。",
           tags=("静音",), text_regex=r"静音|静か|低騒音", facts=("noise_db",), need_label="静音性"),
    Preset("eco", "通年：省エネ・電気代", "all", "🍃", frozenset({"aircon", "fridge", "fan"}),
           "省エネで家計にやさしい暮らし。緑と白の明るくクリーンなトーン、葉のモチーフ。",
           tags=("省エネ", "DCモーター"), attrs=("annual_power_kwh", "annual_cost_jpy", "apf", "energy_rating"),
           raw_keys=("annual_power_consumption", "annual_electricity_cost"),
           facts=("annual_power_kwh", "annual_cost_jpy", "apf"), need_label="省エネ情報"),
    Preset("ec-white", "EC用：白背景", "all", "⬜", ALL_GROUPS,
           "純白の背景、商品を中央に大きく配置、柔らかい接地影。EC 商品ページ用のクリーンな商品写真。", always=True),
    Preset("lifestyle", "ライフスタイル", "all", "🏠", ALL_GROUPS,
           "日本の一般的な住まいに自然に設置された使用シーン。明るく清潔感のある写真。", always=True),
    Preset("sale-banner", "セール・キャンペーン", "all", "🏷️", ALL_GROUPS,
           "家電量販店の店頭キャンペーン風の華やかな背景（ブランドカラーのブルーと赤のアクセント）。商品は中央で大きく。", always=True),
]
PRESET_BY_ID = {p.id: p for p in PRESETS}


def _approved(recs: list[dict]) -> tuple[dict[str, dict], set[str]]:
    attrs = {r["attr_key"]: r for r in recs if r.get("kind") == "attribute" and r.get("gate_status") in FINAL_OK
             and r.get("value") not in (None, "", False)}
    tags = {str(r.get("value")) for r in recs if r.get("kind") == "tag" and r.get("gate_status") in FINAL_OK}
    return attrs, tags


def _fmt(rec: dict) -> str:
    v = rec.get("value")
    if isinstance(v, bool):
        return "あり" if v else "なし"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    unit = rec.get("unit") or ""
    return f"{v} {unit}".strip()


def verified_facts(keys: tuple[str, ...], recs: list[dict]) -> list[dict]:
    attrs, _ = _approved(recs)
    out = []
    for k in keys:
        if k in attrs:
            d = ATTR_BY_KEY.get(k)
            out.append({"key": k, "label": d.label if d else k, "value": _fmt(attrs[k])})
    return out


# EC page scrapes sometimes append unrelated "recommended items" after these markers.
_NOISE_RE = re.compile(r"(お気に入り商品|総額：|この商品を見た人|おすすめ商品|関連商品).*$", re.S)


def evidence_view(product: dict) -> dict:
    """Product copy with page-scrape noise (other products' names) removed from the description."""
    d = product.get("description") or ""
    m = re.search(r"お気に入り商品|総額：", d)
    if d.startswith("対象商品") and m:
        d = ""   # the whole description is a cart/recommendation snippet, not product copy
    else:
        d = _NOISE_RE.sub("", d)
    return {**product, "description": d}


def evaluate_one(pr: Preset, product: dict, recs: list[dict]) -> dict:
    attrs, tags = _approved(recs)
    raw = product.get("raw_attributes") or {}
    evidence, ok = "", pr.always
    if not ok:
        hit_tag = next((t for t in pr.tags if t in tags), None)
        hit_attr = next((k for k in pr.attrs if k in attrs), None)
        hit_raw = next((k for k in pr.raw_keys if str(raw.get(k) or "").strip()), None)
        if hit_tag:
            ok, evidence = True, f"承認済みタグ「{hit_tag}」"
        elif hit_attr:
            d = ATTR_BY_KEY.get(hit_attr)
            ok, evidence = True, f"{d.label if d else hit_attr} {_fmt(attrs[hit_attr])}"
        elif hit_raw:
            ok, evidence = True, f"{hit_raw}: {str(raw[hit_raw])[:40]}"
        elif pr.text_regex:
            # category paths (e.g. 「エアコン・空気清浄機・加湿器・除湿機」) are not product evidence
            src = "\n".join(l for l in source_text(evidence_view(product)).splitlines() if not l.startswith("【カテゴリ】"))
            m = re.search(pr.text_regex, src)
            if m:
                s, e = max(0, m.start() - 12), min(len(src), m.end() + 12)
                ok, evidence = True, src[s:e].replace("\n", " ").strip()
    return {
        "id": pr.id, "label": pr.label, "season": pr.season, "season_label": SEASON_LABEL.get(pr.season, ""),
        "icon": pr.icon, "available": ok,
        "reason": "" if ok else f"この商品には{pr.need_label}に関する記載がありません",
        "evidence": evidence, "facts": [{"label": f["label"], "value": f["value"]} for f in verified_facts(pr.facts, recs)],
        "prompt": pr.prompt,
    }


def evaluate(product: dict, recs: list[dict]) -> list[dict]:
    g = product.get("group") or "fan"
    return [evaluate_one(p, product, recs) for p in PRESETS if g in p.groups]
