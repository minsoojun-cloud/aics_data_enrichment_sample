"""Stage 2: deterministic unit normalization.

The LLM only transcribes raw values ("約W70.0×H177.5×D68.0cm"); all unit
conversions happen here in plain Python so that the result is reproducible
and auditable (slide: 抽出と単位正規化の分離).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from .schema import ATTR_BY_KEY

NUM = r"(\d+(?:\.\d+)?)"


@dataclass
class NormResult:
    value: Any
    unit: str
    ok: bool
    note: str = ""


def clean(raw: str) -> str:
    s = unicodedata.normalize("NFKC", str(raw or ""))
    s = s.replace(",", "").replace("，", "")
    s = re.sub(r"(約|およそ|最大|最長|≒|~?程度)", "", s)
    s = s.replace("～", "~").replace("〜", "~")
    s = s.replace("×", "x").replace("*", "x").replace("X", "x")
    return s.strip()


def _first_number(s: str) -> float | None:
    m = re.search(NUM, s)
    return float(m.group(1)) if m else None


def _to_mm(v: float, unit: str) -> float:
    unit = (unit or "mm").lower()
    return round(v * {"mm": 1, "cm": 10, "m": 1000}.get(unit, 1), 1)


DIM_LABELED = re.compile(
    r"(?:W|幅)\s*" + NUM + r".*?(?:H|高さ)\s*" + NUM + r".*?(?:D|奥行き?)\s*" + NUM + r"\s*(mm|cm|m)?", re.I)
DIM_PLAIN = re.compile(NUM + r"\s*x\s*" + NUM + r"\s*x\s*" + NUM + r"\s*(mm|cm|m)", re.I)


def parse_dimensions(raw: str) -> dict[str, float] | None:
    """'約W70.0×H177.5×D68.0cm' -> {'w': 700, 'h': 1775, 'd': 680} (mm)."""
    s = clean(raw)
    m = DIM_LABELED.search(s)
    if m:
        unit = m.group(4) or ("cm" if "cm" in s else "mm")
        w, h, d = (float(m.group(i)) for i in (1, 2, 3))
        return {"w": _to_mm(w, unit), "h": _to_mm(h, unit), "d": _to_mm(d, unit)}
    m = DIM_PLAIN.search(s)
    if m:
        unit = m.group(4)
        w, h, d = (float(m.group(i)) for i in (1, 2, 3))
        return {"w": _to_mm(w, unit), "h": _to_mm(h, unit), "d": _to_mm(d, unit)}
    return None


def _single_length(s: str) -> float | None:
    m = re.search(NUM + r"\s*(mm|cm|m)\b", s, re.I) or re.search(NUM + r"\s*(mm|cm|m)", s, re.I)
    if not m:
        return None
    return _to_mm(float(m.group(1)), m.group(2))


def _hours(s: str) -> float | None:
    h = re.search(NUM + r"\s*(時間|h\b|hr)", s, re.I)
    mi = re.search(NUM + r"\s*分", s)
    if h:
        total = float(h.group(1))
        # "4時間30分"
        tail = s[h.end():]
        mm = re.match(r"\s*" + NUM + r"\s*分", tail)
        if mm:
            total += float(mm.group(1)) / 60
        return round(total, 2)
    if mi:
        return round(float(mi.group(1)) / 60, 2)
    return None


def _tatami(s: str) -> tuple[float, float] | None:
    m = re.search(NUM + r"\s*~\s*" + NUM + r"\s*畳", s)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(NUM + r"\s*畳", s)
    if m:
        v = float(m.group(1))
        return v, v
    # model already split the range and returned a bare number (e.g. "17")
    m = re.fullmatch(r"\s*" + NUM + r"\s*", s)
    if m:
        v = float(m.group(1))
        return v, v
    return None


def normalize(key: str, raw_value: str) -> NormResult:
    """Normalize a raw transcribed value into the canonical unit for `key`."""
    r = _normalize(key, raw_value)
    if not r.ok and not r.note:
        r.note = f"値「{str(raw_value)[:30]}」を解釈できません"
    return r


def _normalize(key: str, raw_value: str) -> NormResult:
    d = ATTR_BY_KEY.get(key)
    if d is None:
        return NormResult(None, "", False, f"未定義の属性キー: {key}")
    s = clean(raw_value)
    if not s:
        return NormResult(None, d.unit, False, "値が空です")
    kind = d.kind
    try:
        if kind in ("dim_w", "dim_h", "dim_d"):
            dims = parse_dimensions(s)
            if dims:
                return NormResult(dims[kind[-1]], "mm", True, "W×H×D 表記を分解し mm に換算")
            v = _single_length(s)
            if v is not None:
                return NormResult(v, "mm", True, "mm に換算")
            return NormResult(None, "mm", False, "寸法を解釈できません")
        if kind == "weight":
            m = re.search(NUM + r"\s*(kg|g)\b", s, re.I) or re.search(NUM + r"\s*(kg|g)", s, re.I)
            if not m:
                return NormResult(None, "kg", False, "重量の単位がありません")
            v = float(m.group(1)) / (1000 if m.group(2).lower() == "g" else 1)
            return NormResult(round(v, 3), "kg", True, "kg に換算" if m.group(2).lower() == "g" else "")
        if kind == "volume":
            m = re.search(NUM + r"\s*(ml|mL|L|l|ℓ|リットル)", s)
            if not m:
                return NormResult(None, "L", False, "容量の単位がありません")
            v = float(m.group(1))
            if m.group(2).lower() == "ml":
                v = v / 1000
            return NormResult(round(v, 2), "L", True, "")
        if kind == "power_w":
            m = re.search(NUM + r"\s*(kW|W)(?!h)", s)
            if not m:
                return NormResult(None, "W", False, "消費電力の単位がありません")
            v = float(m.group(1)) * (1000 if m.group(2) == "kW" else 1)
            return NormResult(v, "W", True, "")
        if kind == "kwh":
            m = re.search(NUM + r"\s*kWh", s, re.I)
            return NormResult(float(m.group(1)), "kWh/年", True, "") if m else NormResult(None, "kWh/年", False, "kWh 表記がありません")
        if kind == "yen":
            m = re.search(NUM + r"\s*円", s)
            return NormResult(float(m.group(1)), "円", True, "") if m else NormResult(None, "円", False, "円表記がありません")
        if kind == "rating":
            v = _first_number(s)
            if v is None and "★" in s:
                return NormResult(float(s.count("★")), "★", True, "★の数を数値化")
            return NormResult(v, "★", v is not None, "")
        if kind == "voltage":
            m = re.search(NUM + r"\s*V\b", s) or re.search(NUM + r"\s*V", s) or re.search(NUM + r"\s*ボルト", s)
            return NormResult(float(m.group(1)), "V", True, "") if m else NormResult(None, "V", False, "電圧表記がありません")
        if kind in ("tatami_min", "tatami_max"):
            t = _tatami(s)
            if not t:
                return NormResult(None, "畳", False, "畳数を解釈できません")
            return NormResult(t[0] if kind == "tatami_min" else t[1], "畳", True, "範囲表記を分解")
        if kind == "kw":
            m = re.search(NUM + r"\s*(?:\([^)]*\))?\s*kW", s, re.I)
            v = float(m.group(1)) if m else _first_number(s)
            return NormResult(v, "kW", v is not None, "" if m else "単位なし数値を kW とみなしました")
        if kind == "db":
            m = re.search(NUM + r"\s*dB", s, re.I)
            v = float(m.group(1)) if m else None
            return NormResult(v, "dB", v is not None, "" if m else "dB 表記がありません")
        if kind == "count":
            v = _first_number(s)
            return NormResult(int(v) if v is not None else None, d.unit, v is not None, "")
        if kind == "hours":
            v = _hours(s)
            return NormResult(v, "時間", v is not None, "" if v is not None else "時間表記を解釈できません")
        if kind == "plain":
            v = _first_number(s)
            return NormResult(v, d.unit, v is not None, "")
        if kind == "motor":
            u = s.upper()
            if "DC" in u:
                return NormResult("DCモーター", "", True, "")
            if "AC" in u:
                return NormResult("ACモーター", "", True, "")
            return NormResult(s, "", True, "標準表記に未変換")
        if kind == "bool":
            neg = re.search(r"(なし|無し|非対応|不可|×|いいえ|false|コード式)", s, re.I)
            return NormResult(not bool(neg), "", True, "")
        # text
        return NormResult(s, "", True, "")
    except Exception as e:  # pragma: no cover - defensive
        return NormResult(None, d.unit, False, f"正規化エラー: {e}")
