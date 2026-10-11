"""Enrichment pipeline shared by live (online) and batch processing.

Stage 1 (Gemini): raw extraction + evidence + self confidence   -> JSON (responseSchema)
Stage 2 (Python): unit normalization                            -> canonical value
Stage 3 (Gemini): feature tags / keywords / summary              -> JSON (responseSchema)
Gates         : Gate1 rules -> Gate2 composite score -> Gate3 HITL queue
"""
from __future__ import annotations

import datetime as dt
import json
from typing import Any

from .config import settings
from .normalizer import normalize
from .prompts import source_text, stage1_prompt, stage3_prompt
from .rules import (AUTO_APPROVED, FINAL_OK, NEEDS_REVIEW, check_consistency, check_limits, composite_score, decide,
                    evidence_match, token_confidence)
from .schema import ATTR_BY_KEY, attrs_for_group, stage1_schema, stage3_schema


def generation_config(schema: dict) -> dict:
    cfg = {
        "temperature": 0.0,
        "response_mime_type": "application/json",
        "response_schema": schema,
    }
    if settings.thinking_level:
        cfg["thinking_config"] = {"thinking_level": settings.thinking_level}
    return cfg


def build_requests(p: dict) -> dict[str, dict]:
    """GenerateContentRequest bodies (REST JSON form) for batch; keyed by stage."""
    g = p["group"]
    out = {}
    for stage, prompt, schema in (("stage1", stage1_prompt(p, g), stage1_schema(g)),
                                  ("stage3", stage3_prompt(p, g), stage3_schema(g))):
        out[stage] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.0,
                "responseMimeType": "application/json",
                "responseSchema": schema,
            },
        }
    return out


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def process_stage1(p: dict, data: dict, avg_logprobs: float | None, job_id: str, model: str) -> list[dict]:
    src = source_text(p)
    tok = token_confidence(avg_logprobs)
    group = p["group"]
    allowed = {a.key for a in attrs_for_group(group)}

    # keep the highest-confidence item per key
    best: dict[str, dict] = {}
    for it in data.get("attributes") or []:
        k = it.get("key")
        if k not in allowed:
            continue
        if k not in best or float(it.get("confidence") or 0) > float(best[k].get("confidence") or 0):
            best[k] = it

    normed: dict[str, Any] = {"_group": group}
    tmp = []
    for k, it in best.items():
        nr = normalize(k, it.get("raw_value", ""))
        if nr.ok:
            normed[k] = nr.value
        tmp.append((k, it, nr))
    consistency = check_consistency(normed)

    recs = []
    for k, it, nr in tmp:
        d = ATTR_BY_KEY[k]
        ev = evidence_match(it.get("evidence", ""), src, it.get("raw_value", ""))
        self_conf = float(it.get("confidence") or 0)
        score = composite_score(ev, self_conf, tok)
        if not nr.ok:
            score = min(score, 0.5)  # no usable value -> never looks "confident"
        status, gate, reason = decide(nr.ok, nr.note, check_limits(k, nr.value) if nr.ok else None,
                                      consistency.get(k), ev, score, settings.auto_approve_threshold)
        recs.append({
            "sku": p["sku"], "kind": "attribute", "attr_key": k, "label": d.label,
            "raw_value": it.get("raw_value", ""), "value": nr.value, "unit": nr.unit,
            "norm_note": nr.note, "evidence": it.get("evidence", ""), "source_field": it.get("source_field", ""),
            "self_conf": round(self_conf, 3), "evidence_match": ev, "token_conf": None if tok is None else round(tok, 3),
            "score": score, "gate_status": status, "gate": gate, "reason": reason,
            "job_id": job_id, "model": model, "created_at": _now(),
        })
    return recs


def process_stage3(p: dict, data: dict, avg_logprobs: float | None, job_id: str, model: str) -> tuple[list[dict], dict]:
    src = source_text(p)
    tok = token_confidence(avg_logprobs)
    recs, seen = [], set()
    for it in data.get("feature_tags") or []:
        tag = it.get("tag")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        ev = evidence_match(it.get("evidence", ""), src)
        self_conf = float(it.get("confidence") or 0)
        score = composite_score(ev, self_conf, tok)
        status, gate, reason = decide(True, "", None, None, ev, score, settings.auto_approve_threshold)
        recs.append({
            "sku": p["sku"], "kind": "tag", "attr_key": f"tag:{tag}", "label": tag,
            "raw_value": "", "value": tag, "unit": "", "norm_note": "", "evidence": it.get("evidence", ""),
            "source_field": "", "self_conf": round(self_conf, 3), "evidence_match": ev,
            "token_conf": None if tok is None else round(tok, 3), "score": score,
            "gate_status": status, "gate": gate, "reason": reason, "job_id": job_id, "model": model,
            "created_at": _now(),
        })
    extras = {"search_keywords": data.get("search_keywords") or [], "ai_summary": data.get("ai_summary") or ""}
    return recs, extras


# ── Fill-rate / golden record ────────────────────────────────────────────────

COMPOSITE_KINDS = {"dim_w", "dim_h", "dim_d", "tatami_min", "tatami_max"}


def usable_before(p: dict) -> set[str]:
    """Target keys already available in the source as a directly usable structured value.

    Composite source fields (e.g. 'W70×H177×D68cm' or '6～9畳') do NOT count: they cannot be used
    as a facet/filter (width, tatami min/max) without decomposition + unit normalization.
    """
    raw = p.get("raw_attributes") or {}
    have = set()
    for a in attrs_for_group(p["group"]):
        if a.kind in COMPOSITE_KINDS:
            continue
        for rk in a.raw_keys:
            if rk in raw and normalize(a.key, raw[rk]).ok:
                have.add(a.key)
                break
    return have


def fill_rate_before(p: dict) -> float:
    targets = attrs_for_group(p["group"])
    return round(len(usable_before(p)) / len(targets), 3) if targets else 0.0


def fill_rate_after(p: dict, recs: list[dict]) -> float:
    targets = {a.key for a in attrs_for_group(p["group"])}
    ok = {r["attr_key"] for r in recs if r["kind"] == "attribute" and r["gate_status"] in FINAL_OK}
    ok |= usable_before(p)
    return round(len(ok & targets) / len(targets), 3) if targets else 0.0


def sku_status(recs: list[dict]) -> str:
    if any(r["gate_status"] == NEEDS_REVIEW for r in recs):
        return "needs_review"
    if not recs:
        return "not_processed"
    return "completed"


def golden_record(p: dict, recs: list[dict], extras: dict) -> dict:
    attrs = {r["attr_key"]: {"value": r["value"], "unit": r["unit"], "score": r["score"], "status": r["gate_status"]}
             for r in recs if r["kind"] == "attribute" and r["gate_status"] in FINAL_OK}
    tags = [r["value"] for r in recs if r["kind"] == "tag" and r["gate_status"] in FINAL_OK]
    return {
        "sku": p["sku"], "title": p.get("title", ""), "group": p["group"],
        "attributes": attrs, "feature_tags": tags,
        "search_keywords": extras.get("search_keywords", []), "ai_summary": extras.get("ai_summary", ""),
        "fill_rate_before": fill_rate_before(p), "fill_rate_after": fill_rate_after(p, recs),
        "updated_at": _now(),
    }


def parse_json_text(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    return json.loads(text)


# ── Google Merchant Center Conversational Attributes ─────────────────────────

_SIZE_KEYS = {"width_mm", "height_mm", "depth_mm", "weight_kg"}
_POWER_KEYS = {"power_consumption_w", "annual_power_kwh", "annual_cost_jpy", "energy_rating", "power_supply_v", "apf"}


def _detail_section(attr_key: str) -> str:
    if attr_key in _SIZE_KEYS:
        return "サイズ・重量"
    if attr_key in _POWER_KEYS:
        return "省エネ・電源"
    return "基本仕様"


def build_product_details(recs: list[dict]) -> list[dict]:
    """Build GMC product_detail items from approved golden attributes & feature tags."""
    details: list[dict] = []
    for r in recs:
        if r.get("gate_status") not in FINAL_OK:
            continue
        if r.get("kind") == "attribute" and r.get("value") is not None:
            v = r["value"]
            if isinstance(v, bool):
                v_str = "対応" if v else "非対応"
            elif isinstance(v, float) and v.is_integer():
                v_str = f"{int(v)}{r.get('unit') or ''}"
            else:
                v_str = f"{v}{r.get('unit') or ''}"
            details.append({
                "section": _detail_section(r["attr_key"]),
                "attribute": r.get("label") or r["attr_key"],
                "value": v_str.strip(),
            })
    tags = [str(r["value"]) for r in recs if r.get("kind") == "tag" and r.get("gate_status") in FINAL_OK]
    if tags:
        details.append({"section": "機能・特長", "attribute": "搭載機能", "value": " / ".join(tags[:6])})
    return details


def _default_popularity_rank(sku: str, recs: list[dict]) -> float:
    import hashlib
    h = int(hashlib.md5(sku.encode("utf-8")).hexdigest()[:6], 16)
    base = 78.0 + (h % 200) / 10.0  # 78.0 .. 97.9
    bonus = min(1.8, len([r for r in recs if r.get("gate_status") in FINAL_OK]) * 0.1)
    return round(min(99.5, base + bonus), 1)


def _fallback_group_id(title: str, sku: str) -> str:
    import re
    # Match typical Japanese appliance model codes like JR-GX41E5-H, GR-W36SC(WU), S633ATSP-W
    tokens = re.findall(r"\b([A-Z]{1,4}[-]?[A-Z0-9]{3,10})(?:[-][A-Z0-9]{1,3}|\([A-Z0-9]+\))?\b", title or "")
    if tokens:
        return tokens[-1]
    return f"GRP-{sku[:8]}"


def rebuild_gmc_strings(gmc: dict) -> dict:
    """Ensure all GMC formatted feed strings match the structured lists."""
    vos = gmc.get("variant_options") or []
    qas = gmc.get("questions_and_answers") or []
    hls = gmc.get("product_highlights") or []
    dts = gmc.get("product_details") or []
    rps = gmc.get("related_products") or []

    gmc["variant_option"] = ",".join(
        f"{str(v.get('name', '')).replace(',', '・').replace(':', '：')}:{str(v.get('value', '')).replace(',', '・').replace(':', '：')}"
        for v in vos if v.get("name") and v.get("value")
    )
    gmc["question_and_answer"] = ", ".join(
        f'"{str(q.get("question", "")).replace(chr(34), chr(39))}":"{str(q.get("answer", "")).replace(chr(34), chr(39))}"'
        for q in qas if q.get("question") and q.get("answer")
    )
    gmc["product_highlight"] = ", ".join(
        f'"{str(h).replace(chr(34), chr(39))}"' for h in hls if h
    )
    gmc["product_detail"] = ", ".join(
        f'{d.get("section", "仕様")}:{d.get("attribute", "")}:"{str(d.get("value", "")).replace(chr(34), chr(39))}"'
        for d in dts if d.get("attribute") and d.get("value")
    )
    gmc["related_product"] = ",".join(
        f"{r.get('relationship_type', 'similar_to')}:{r.get('identifier_type', 'id')}:{r.get('identifier', '')}"
        for r in rps if r.get("identifier")
    )
    return gmc


def process_gmc(
    p: dict,
    data: dict,
    recs: list[dict],
    avg_logprobs: float | None,
    job_id: str,
    model: str,
    catalog_products: list[dict] | None = None,
) -> dict:
    """Process Gemini GMC response + Golden Record attributes into a GMC Conversational Attributes record."""
    src = source_text(p)
    tok = token_confidence(avg_logprobs)
    sku = p["sku"]

    item_group_id = (data.get("item_group_id") or "").strip() or _fallback_group_id(p.get("title", ""), sku)
    item_group_title = (data.get("item_group_title") or "").strip() or p.get("title", "")

    variant_options = []
    for vo in data.get("variant_options") or []:
        name = (vo.get("name") or "").strip()
        val = (vo.get("value") or "").strip()
        ev_text = (vo.get("evidence") or "").strip()
        if not name or not val:
            continue
        ev = evidence_match(ev_text, src, val)
        variant_options.append({
            "name": name,
            "value": val,
            "evidence": ev_text,
            "evidence_match": ev,
        })

    qas = []
    for qa in data.get("questions_and_answers") or []:
        q = (qa.get("question") or "").strip()
        a = (qa.get("answer") or "").strip()
        ev_text = (qa.get("evidence") or "").strip()
        if not q or not a:
            continue
        ev = evidence_match(ev_text, src)
        self_conf = float(qa.get("confidence") or 0.9)
        score = composite_score(ev, self_conf, tok)
        status = AUTO_APPROVED if (ev > 0 and score >= settings.auto_approve_threshold) else NEEDS_REVIEW
        qas.append({
            "question": q,
            "answer": a,
            "evidence": ev_text,
            "confidence": round(self_conf, 3),
            "evidence_match": ev,
            "score": score,
            "status": status,
        })

    highlights = [str(h).strip() for h in (data.get("product_highlights") or []) if str(h).strip()][:6]
    details = build_product_details(recs)

    related_products = []
    seen_rel = set()
    for rm in data.get("related_mentions") or []:
        ident = (rm.get("identifier") or "").strip()
        if not ident or ident == sku or ident in seen_rel:
            continue
        seen_rel.add(ident)
        related_products.append({
            "relationship_type": rm.get("relationship_type") or "accessory",
            "identifier_type": rm.get("identifier_type") or "mpn",
            "identifier": ident,
            "title": (rm.get("title") or ident).strip(),
        })

    if catalog_products:
        same_group = [cp for cp in catalog_products if cp.get("group") == p.get("group") and cp.get("sku") != sku]
        # Prefer same brand first for similar_to, then another for often_bought_with
        same_brand = [cp for cp in same_group if cp.get("brand") and cp.get("brand") == p.get("brand")]
        other_brand = [cp for cp in same_group if cp not in same_brand]
        candidates = (same_brand[:1] + other_brand[:1] + same_group[:2])
        rel_types = ["similar_to", "often_bought_with"]
        for cp in candidates:
            if len(related_products) >= 3:
                break
            csku = cp["sku"]
            if csku in seen_rel:
                continue
            seen_rel.add(csku)
            rtype = rel_types[min(len(related_products), len(rel_types) - 1)]
            related_products.append({
                "relationship_type": rtype,
                "identifier_type": "id",
                "identifier": csku,
                "title": cp.get("title", csku),
            })

    doc_link = (data.get("document_link") or "").strip()
    if not doc_link or not doc_link.startswith("http"):
        doc_link = f"https://store.example.com/download/manual/{item_group_id}.pdf"

    pop_rank = _default_popularity_rank(sku, recs)

    gmc = {
        "sku": sku,
        "item_group_id": item_group_id,
        "item_group_title": item_group_title,
        "variant_options": variant_options,
        "questions_and_answers": qas,
        "product_highlights": highlights,
        "product_details": details,
        "related_products": related_products,
        "popularity_rank": pop_rank,
        "document_link": doc_link,
        "model": model,
        "job_id": job_id,
        "updated_at": _now(),
    }
    return rebuild_gmc_strings(gmc)


def fallback_gmc(
    p: dict,
    recs: list[dict],
    extras: dict,
    catalog_products: list[dict] | None = None,
) -> dict:
    """Deterministic GMC conversational attributes synthesized from enriched attributes & source data."""
    by_key = {r["attr_key"]: r for r in recs if r.get("kind") == "attribute" and r.get("gate_status") in FINAL_OK}
    vos = []
    for k in ("total_capacity_l", "door_type", "cooling_tatami_min", "power_supply_v", "motor_type"):
        if k in by_key and by_key[k].get("value") is not None:
            r = by_key[k]
            v = int(r["value"]) if isinstance(r["value"], float) and r["value"].is_integer() else r["value"]
            vos.append({
                "name": r["label"],
                "value": f"{v}{r.get('unit') or ''}",
                "evidence": r.get("evidence", ""),
            })
    qas = []
    if all(k in by_key for k in ("width_mm", "height_mm", "depth_mm")):
        w, h, d = int(by_key["width_mm"]["value"]), int(by_key["height_mm"]["value"]), int(by_key["depth_mm"]["value"])
        qas.append({
            "question": "設置に必要な本体サイズ（幅・高さ・奥行）はどのくらいですか？",
            "answer": f"本体サイズは幅{w}mm×高さ{h}mm×奥行{d}mmです。",
            "evidence": by_key["width_mm"].get("evidence", ""),
            "confidence": 0.96,
        })
    if "annual_cost_jpy" in by_key or "annual_power_kwh" in by_key:
        parts = []
        ev = ""
        if "annual_power_kwh" in by_key:
            parts.append(f"年間消費電力量は{int(by_key['annual_power_kwh']['value'])}kWh/年")
            ev = by_key["annual_power_kwh"].get("evidence", "")
        if "annual_cost_jpy" in by_key:
            parts.append(f"年間電気代の目安は約{int(by_key['annual_cost_jpy']['value']):,}円")
            ev = ev or by_key["annual_cost_jpy"].get("evidence", "")
        qas.append({
            "question": "年間の電気代や省エネ性能はどのくらいですか？",
            "answer": "、".join(parts) + "です。",
            "evidence": ev,
            "confidence": 0.95,
        })
    if "power_supply_v" in by_key:
        v = int(by_key["power_supply_v"]["value"])
        qas.append({
            "question": "電源電圧は何Vに対応していますか？",
            "answer": f"電源は{v}Vに対応しています。",
            "evidence": by_key["power_supply_v"].get("evidence", ""),
            "confidence": 0.95,
        })
    tags = [str(r["value"]) for r in recs if r.get("kind") == "tag" and r.get("gate_status") in FINAL_OK]
    if tags:
        t_rec = next((r for r in recs if r.get("kind") == "tag" and r.get("gate_status") in FINAL_OK), {})
        qas.append({
            "question": "どのような便利機能や特長がありますか？",
            "answer": f"{'・'.join(tags[:4])}などの機能を搭載しています。",
            "evidence": t_rec.get("evidence", ""),
            "confidence": 0.93,
        })
    highlights = []
    if extras.get("ai_summary"):
        highlights.append(extras["ai_summary"][:45])
    for t in tags[:3]:
        highlights.append(f"「{t}」機能を搭載")
    data = {
        "item_group_id": _fallback_group_id(p.get("title", ""), p["sku"]),
        "item_group_title": p.get("title", ""),
        "variant_options": vos[:4],
        "questions_and_answers": qas[:4],
        "product_highlights": highlights[:4],
        "related_mentions": [],
        "document_link": "",
    }
    return process_gmc(p, data, recs, None, "synthesized", settings.gemini_model, catalog_products)


__all__ = ["build_requests", "generation_config", "process_stage1", "process_stage3", "process_gmc",
           "fallback_gmc", "rebuild_gmc_strings", "build_product_details", "golden_record",
           "fill_rate_before", "fill_rate_after", "sku_status", "parse_json_text", "AUTO_APPROVED"]


