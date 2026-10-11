"""Gate 1 (rule-based validation) and Gate 2 (composite confidence score)."""
from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

from .schema import ATTR_BY_KEY

AUTO_APPROVED = "auto_approved"
NEEDS_REVIEW = "needs_review"
REJECTED = "rejected"
APPROVED = "approved"          # approved by a human (HITL)
EDITED = "edited"              # corrected + approved by a human
HUMAN_REJECTED = "human_rejected"

FINAL_OK = {AUTO_APPROVED, APPROVED, EDITED}


# ── Evidence grounding ───────────────────────────────────────────────────────

def _squash(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"[\s・、。,.:：()（）\[\]【】「」●◆■※/]", "", s).lower()


def evidence_match(evidence: str, source_text: str, raw_value: str = "") -> float:
    """1.0 exact substring, 0.8 match after NFKC/whitespace squash, 0.5 only the raw value is found, else 0."""
    if not evidence:
        return 0.0
    if evidence in source_text:
        return 1.0
    if _squash(evidence) and _squash(evidence) in _squash(source_text):
        return 0.8
    if raw_value and _squash(raw_value) and _squash(raw_value) in _squash(source_text):
        return 0.5
    return 0.0


def token_confidence(avg_logprobs: float | None) -> float | None:
    if avg_logprobs is None:
        return None
    try:
        return max(0.0, min(1.0, math.exp(float(avg_logprobs))))
    except (TypeError, ValueError, OverflowError):
        return None


def composite_score(ev: float, self_conf: float, tok: float | None) -> float:
    self_conf = max(0.0, min(1.0, float(self_conf or 0)))
    if tok is None:
        s = 0.6 * ev + 0.4 * self_conf
    else:
        s = 0.5 * ev + 0.3 * self_conf + 0.2 * tok
    return round(s, 3)


# ── Gate 1: rules ────────────────────────────────────────────────────────────

def check_limits(key: str, value: Any) -> str | None:
    d = ATTR_BY_KEY.get(key)
    if not d or d.limits is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    lo, hi = d.limits
    if value < lo or value > hi:
        return f"物理限界値外: {value}{d.unit}（許容 {lo}〜{hi}{d.unit}）"
    return None


def check_consistency(values: dict[str, Any]) -> dict[str, str]:
    """Cross-attribute consistency. Returns {attr_key: reason}."""
    issues: dict[str, str] = {}
    total = values.get("total_capacity_l")
    parts = [values.get(k) for k in ("freezer_capacity_l", "fridge_capacity_l", "vegetable_capacity_l")]
    parts = [p for p in parts if isinstance(p, (int, float))]
    if isinstance(total, (int, float)) and parts and sum(parts) > total * 1.05:
        for k in ("freezer_capacity_l", "fridge_capacity_l", "vegetable_capacity_l"):
            if k in values:
                issues[k] = f"区画容量の合計 {sum(parts):g}L が定格内容積 {total:g}L を超過"
    lo, hi = values.get("cooling_tatami_min"), values.get("cooling_tatami_max")
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo > hi:
        issues["cooling_tatami_min"] = f"畳数の下限 {lo:g} が上限 {hi:g} を超過"
    w, h = values.get("width_mm"), values.get("height_mm")
    if values.get("_group") == "fridge" and isinstance(w, (int, float)) and isinstance(h, (int, float)) and h < w * 0.5:
        issues["height_mm"] = f"冷蔵庫の高さ {h:g}mm が幅 {w:g}mm に対して不自然"
    return issues


# ── Gate decision ────────────────────────────────────────────────────────────

def decide(norm_ok: bool, norm_note: str, limit_issue: str | None, consistency_issue: str | None,
           ev: float, score: float, threshold: float) -> tuple[str, str, str]:
    """Returns (gate_status, gate, reason). gate ∈ {gate1, gate2, gate3}."""
    if limit_issue:
        return REJECTED, "gate1", limit_issue
    if not norm_ok:
        return NEEDS_REVIEW, "gate1", f"単位正規化に失敗: {norm_note}"
    if consistency_issue:
        return NEEDS_REVIEW, "gate1", consistency_issue
    if ev == 0:
        return NEEDS_REVIEW, "gate2", "根拠スニペットが原本に見つかりません（ハルシネーションの可能性）"
    if score >= threshold:
        return AUTO_APPROVED, "gate2", f"複合スコア {score:.2f} ≥ {threshold:.2f}"
    return NEEDS_REVIEW, "gate2", f"複合スコア {score:.2f} < {threshold:.2f}（確信度不足）"
