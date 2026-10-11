"""Data access: in-memory state backed by append-only BigQuery tables.

The demo runs on a single Cloud Run instance (max-instances=1) so an in-memory
cache gives an instant UI while every change is persisted to BigQuery with
load jobs (no streaming buffer => tables stay DML/MERGE friendly).
"""
from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
import logging
import os
import threading
from typing import Any

from .config import settings
from .pipeline import build_product_details, fallback_gmc, golden_record, rebuild_gmc_strings, sku_status
from .rules import APPROVED, EDITED, HUMAN_REJECTED
from .schema import ATTR_BY_KEY

os.environ.setdefault("GOOGLE_API_USE_CLIENT_CERTIFICATE", "false")
log = logging.getLogger(__name__)
DS = settings.dataset_ref


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def rec_to_row(r: dict) -> dict:
    row = {k: r.get(k) for k in ("sku", "kind", "attr_key", "label", "raw_value", "unit", "norm_note", "evidence",
                                 "source_field", "self_conf", "evidence_match", "token_conf", "score", "gate_status",
                                 "gate", "reason", "job_id", "model", "created_at")}
    row["value_json"] = json.dumps(r.get("value"), ensure_ascii=False)
    return row


def row_to_rec(row: dict) -> dict:
    r = dict(row)
    try:
        r["value"] = json.loads(r.pop("value_json") or "null")
    except (TypeError, ValueError):
        r["value"] = None
    for k in ("created_at",):
        if isinstance(r.get(k), dt.datetime):
            r[k] = r[k].isoformat()
    return r


def gmc_to_row(g: dict) -> dict:
    g = rebuild_gmc_strings(dict(g))
    return {
        "sku": g["sku"],
        "item_group_id": g.get("item_group_id") or "",
        "item_group_title": g.get("item_group_title") or "",
        "variant_option": g.get("variant_option") or "",
        "variant_options_json": json.dumps(g.get("variant_options") or [], ensure_ascii=False),
        "question_and_answer": g.get("question_and_answer") or "",
        "qa_json": json.dumps(g.get("questions_and_answers") or [], ensure_ascii=False),
        "product_highlight": g.get("product_highlight") or "",
        "highlights_json": json.dumps(g.get("product_highlights") or [], ensure_ascii=False),
        "product_detail": g.get("product_detail") or "",
        "details_json": json.dumps(g.get("product_details") or [], ensure_ascii=False),
        "related_product": g.get("related_product") or "",
        "related_json": json.dumps(g.get("related_products") or [], ensure_ascii=False),
        "popularity_rank": float(g.get("popularity_rank") or 85.0),
        "document_link": g.get("document_link") or "",
        "model": g.get("model") or settings.gemini_model,
        "job_id": g.get("job_id") or "",
        "updated_at": g.get("updated_at") or _now(),
    }


def row_to_gmc(row: dict) -> dict:
    def _j(col):
        try:
            return json.loads(row.get(col) or "[]")
        except (TypeError, ValueError):
            return []

    updated = row.get("updated_at")
    if isinstance(updated, dt.datetime):
        updated = updated.isoformat()
    g = {
        "sku": row["sku"],
        "item_group_id": row.get("item_group_id") or "",
        "item_group_title": row.get("item_group_title") or "",
        "variant_options": _j("variant_options_json"),
        "questions_and_answers": _j("qa_json"),
        "product_highlights": _j("highlights_json"),
        "product_details": _j("details_json"),
        "related_products": _j("related_json"),
        "popularity_rank": float(row.get("popularity_rank") or 85.0),
        "document_link": row.get("document_link") or "",
        "model": row.get("model") or settings.gemini_model,
        "job_id": row.get("job_id") or "",
        "updated_at": updated or _now(),
    }
    return rebuild_gmc_strings(g)


def product_to_row(p: dict) -> dict:
    raw = p.get("raw_attributes") or {}
    raw_arr = [{"k": str(k), "v": str(v)} for k, v in raw.items() if v is not None and str(v) != ""]
    return {
        "sku": p["sku"],
        "title": p.get("title") or "",
        "brand": p.get("brand") or "",
        "category": p.get("category") or "",
        "description": p.get("description") or "",
        "product_url": p.get("product_url") or "",
        "image_url": p.get("image_url") or "",
        "price": float(p["price"]) if p.get("price") is not None else None,
        "raw_attributes_json": json.dumps(raw_arr, ensure_ascii=False),
        "category_group": p.get("group") or "fridge",
        "attr_count": len(raw_arr),
        "updated_at": _now(),
        "source": p.get("source") or "app",
        "doc_sources_json": json.dumps(p.get("doc_sources") or [], ensure_ascii=False),
    }


IMAGE_COLS = ("image_id", "sku", "gcs_uri", "url", "kind", "status", "is_primary", "preset", "preset_label", "season",
              "prompt", "extra_prompt", "base_image_uri", "base_kind", "source_url", "model", "width", "height",
              "aspect", "fidelity_score", "fidelity_note", "created_at", "updated_at")


def image_to_row(img: dict) -> dict:
    return {k: img.get(k) for k in IMAGE_COLS}


def _json_list(v) -> list:
    try:
        x = json.loads(v or "[]")
        return x if isinstance(x, list) else []
    except (TypeError, ValueError):
        return []


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.products: dict[str, dict] = {}
        self.records: dict[str, list[dict]] = {}
        self.extras: dict[str, dict] = {}
        self.gmc: dict[str, dict] = {}
        self.reviews: list[dict] = []
        self.jobs: list[dict] = []
        self.live_runs: list[dict] = []   # token/cost stats for live calls
        self.images: dict[str, dict[str, dict]] = {}   # sku -> image_id -> latest product_images row
        self._pool = cf.ThreadPoolExecutor(max_workers=2)
        self._bq = None

    # ── BigQuery helpers ────────────────────────────────────────────────────
    @property
    def bq(self):
        if self._bq is None:
            from google.cloud import bigquery
            self._bq = bigquery.Client(project=settings.project_id, location=settings.bq_location)
        return self._bq

    def query(self, sql: str) -> list[dict]:
        return [dict(r) for r in self.bq.query(sql).result()]

    def _append(self, table: str, rows: list[dict], sync: bool = False):
        if settings.offline or not rows:
            return
        from google.cloud import bigquery

        def job():
            try:
                cfg = bigquery.LoadJobConfig(write_disposition="WRITE_APPEND")
                self.bq.load_table_from_json(rows, f"{DS}.{table}", job_config=cfg).result()
            except Exception as e:  # pragma: no cover
                log.exception("BigQuery append to %s failed: %s", table, e)
                if sync:
                    raise

        if sync:
            job()
        else:
            self._pool.submit(job)

    # ── Load ────────────────────────────────────────────────────────────────
    def load(self, products: list[dict] | None = None):
        with self.lock:
            if products is not None or settings.offline:
                for p in products or []:
                    self.products[p["sku"]] = p
                return
            try:
                src_rows = self.query(f"""SELECT * EXCEPT(rk) FROM (
                    SELECT *, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY updated_at DESC NULLS LAST) rk
                    FROM `{DS}.source_products`) WHERE rk = 1 ORDER BY category_group, sku""")
            except Exception as e:  # table without updated_at (before setup_bq migration)
                log.warning("latest-row source_products query failed (%s); falling back", e)
                src_rows = self.query(f"SELECT * FROM `{DS}.source_products` ORDER BY category_group, sku")
            for row in src_rows:
                self.products[row["sku"]] = self._product_from_row(row)
            self.images = {}
            try:
                for row in self.query(f"""SELECT * EXCEPT(rk) FROM (
                        SELECT *, ROW_NUMBER() OVER (PARTITION BY image_id ORDER BY updated_at DESC) rk
                        FROM `{DS}.product_images`) WHERE rk = 1 ORDER BY created_at DESC"""):
                    for k in ("created_at", "updated_at"):
                        if isinstance(row.get(k), dt.datetime):
                            row[k] = row[k].isoformat()
                    self.images.setdefault(row["sku"], {})[row["image_id"]] = row
            except Exception as e:
                log.warning("load product_images skipped: %s", e)
            # records of the latest job per SKU
            latest_job: dict[str, str] = {}
            for r in self.query(f"""SELECT sku, ARRAY_AGG(job_id ORDER BY created_at DESC LIMIT 1)[OFFSET(0)] job_id
                                     FROM `{DS}.enriched_attributes` GROUP BY sku"""):
                latest_job[r["sku"]] = r["job_id"]
            rows = self.query(f"SELECT * FROM `{DS}.enriched_attributes`")
            recs: dict[str, list[dict]] = {}
            seen: set[tuple[str, str]] = set()
            for row in rows:
                if latest_job.get(row["sku"]) == row["job_id"] and (row["sku"], row["attr_key"]) not in seen:
                    seen.add((row["sku"], row["attr_key"]))
                    rec = row_to_rec(row)
                    recs.setdefault(row["sku"], []).append(rec)
            self.records = recs
            for r in self.query(f"""SELECT sku, ARRAY_AGG(STRUCT(search_keywords, ai_summary) ORDER BY created_at DESC LIMIT 1)[OFFSET(0)] x
                                     FROM `{DS}.sku_extras` GROUP BY sku"""):
                self.extras[r["sku"]] = {"search_keywords": list(r["x"]["search_keywords"] or []), "ai_summary": r["x"]["ai_summary"] or ""}
            # replay reviews (in order)
            self.reviews = []
            for rv in self.query(f"SELECT * FROM `{DS}.review_log` ORDER BY reviewed_at"):
                rv["reviewed_at"] = rv["reviewed_at"].isoformat() if rv.get("reviewed_at") else None
                self._apply_review_memory(rv)
                self.reviews.append(rv)
            # load GMC conversational attributes (latest per SKU)
            self.gmc = {}
            try:
                for g in self.query(f"""SELECT * EXCEPT(rk) FROM (
                                          SELECT *, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY updated_at DESC) rk
                                          FROM `{DS}.gmc_conversational`
                                        ) WHERE rk=1"""):
                    self.gmc[g["sku"]] = row_to_gmc(g)
            except Exception as e:
                log.warning("load gmc_conversational skipped: %s", e)
            self.jobs = []
            for j in self.query(f"""SELECT * EXCEPT(rk) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY updated_at DESC) rk
                                      FROM `{DS}.batch_jobs`) WHERE rk=1 ORDER BY created_at DESC"""):
                for k in ("created_at", "updated_at"):
                    if isinstance(j.get(k), dt.datetime):
                        j[k] = j[k].isoformat()
                self.jobs.append(j)

    @staticmethod
    def _product_from_row(row: dict) -> dict:
        raw = {}
        for kv in json.loads(row.get("raw_attributes_json") or "[]"):
            raw[kv["k"]] = kv["v"]
        return {
            "sku": row["sku"], "title": row.get("title") or "", "brand": row.get("brand") or "",
            "category": row.get("category") or "", "description": row.get("description") or "",
            "product_url": row.get("product_url") or "", "image_url": row.get("image_url") or "",
            "price": row.get("price"), "group": row.get("category_group"), "raw_attributes": raw,
            "source": row.get("source") or "aics", "doc_sources": _json_list(row.get("doc_sources_json")),
        }

    # ── Mutations ───────────────────────────────────────────────────────────
    def save_source_products(self, products: list[dict], persist_bq: bool = True, sync: bool = False):
        rows = []
        with self.lock:
            for p in products:
                self.products[p["sku"]] = p
                rows.append(product_to_row(p))
        if persist_bq and rows:
            self._append("source_products", rows, sync=sync)

    def get_gmc(self, sku: str) -> dict:
        with self.lock:
            p = self.products.get(sku)
            if not p:
                return {}
            recs = self.records.get(sku, [])
            extras = self.extras.get(sku, {})
            g = self.gmc.get(sku)
            if g is None:
                g = fallback_gmc(p, recs, extras, list(self.products.values()))
                self.gmc[sku] = g
            else:
                g = dict(g)
                g["product_details"] = build_product_details(recs)
                rebuild_gmc_strings(g)
                self.gmc[sku] = g
            return g

    def save_gmc(self, sku: str, gmc: dict, persist_bq: bool = True, sync: bool = False) -> dict:
        with self.lock:
            recs = self.records.get(sku, [])
            gmc = dict(gmc)
            gmc["sku"] = sku
            gmc["product_details"] = build_product_details(recs)
            gmc["updated_at"] = _now()
            rebuild_gmc_strings(gmc)
            self.gmc[sku] = gmc
        if persist_bq:
            self._append("gmc_conversational", [gmc_to_row(gmc)], sync=sync)
        return gmc

    def save_enrichment(self, sku: str, recs: list[dict], extras: dict, job_id: str,
                        gmc: dict | None = None, persist_bq: bool = True, sync: bool = False):
        with self.lock:
            self.records[sku] = recs
            self.extras[sku] = extras
            if gmc is not None:
                gmc = dict(gmc)
                gmc["product_details"] = build_product_details(recs)
                rebuild_gmc_strings(gmc)
                self.gmc[sku] = gmc
            else:
                p = self.products.get(sku)
                if p:
                    self.gmc[sku] = fallback_gmc(p, recs, extras, list(self.products.values()))
        if persist_bq:
            self._append("enriched_attributes", [rec_to_row(r) for r in recs], sync=sync)
            self._append("sku_extras", [{"sku": sku, "job_id": job_id, "search_keywords": extras.get("search_keywords", []),
                                          "ai_summary": extras.get("ai_summary", ""), "created_at": _now()}], sync=sync)
            self._persist_golden(sku, sync=sync)
            if sku in self.gmc:
                self._append("gmc_conversational", [gmc_to_row(self.gmc[sku])], sync=sync)

    def save_many(self, items: list[tuple], job_id: str,
                  gmc_items: dict[str, dict] | None = None):
        rows, xrows, grows, mrows = [], [], [], []
        with self.lock:
            for item in items:
                if len(item) == 4:
                    sku, recs, extras, g_inline = item
                else:
                    sku, recs, extras = item
                    g_inline = None
                self.records[sku] = recs
                self.extras[sku] = extras
                rows += [rec_to_row(r) for r in recs]
                xrows.append({"sku": sku, "job_id": job_id, "search_keywords": extras.get("search_keywords", []),
                              "ai_summary": extras.get("ai_summary", ""), "created_at": _now()})
                grows.append(self._golden_row(sku))
                g_src = g_inline or (gmc_items.get(sku) if gmc_items else None)
                if g_src:
                    g = dict(g_src)
                    g["product_details"] = build_product_details(recs)
                    rebuild_gmc_strings(g)
                    self.gmc[sku] = g
                    mrows.append(gmc_to_row(g))
        self._append("enriched_attributes", rows)
        self._append("sku_extras", xrows)
        self._append("golden_records", grows)
        if mrows:
            self._append("gmc_conversational", mrows)

    def persist_skus_to_bq(self, skus: list[str]) -> dict:
        """Synchronously persist the given SKUs across all BigQuery tables and return row counts."""
        prows, rrows, xrows, grows, mrows = [], [], [], [], []
        now = _now()
        with self.lock:
            for sku in skus:
                p = self.products.get(sku)
                if not p:
                    continue
                prows.append(product_to_row(p))
                recs = self.records.get(sku, [])
                rrows += [rec_to_row(r) for r in recs]
                ex = self.extras.get(sku, {})
                job_id = recs[0]["job_id"] if recs else f"manual-{now[:10]}"
                xrows.append({
                    "sku": sku,
                    "job_id": job_id,
                    "search_keywords": ex.get("search_keywords", []),
                    "ai_summary": ex.get("ai_summary", ""),
                    "created_at": now,
                })
                grows.append(self._golden_row(sku))
                g = self.get_gmc(sku)
                if g:
                    mrows.append(gmc_to_row(g))
        self._append("source_products", prows, sync=True)
        self._append("enriched_attributes", rrows, sync=True)
        self._append("sku_extras", xrows, sync=True)
        self._append("golden_records", grows, sync=True)
        self._append("gmc_conversational", mrows, sync=True)
        return {
            "dataset": DS,
            "skus": len(prows),
            "tables": {
                f"{DS}.source_products": len(prows),
                f"{DS}.enriched_attributes": len(rrows),
                f"{DS}.sku_extras": len(xrows),
                f"{DS}.golden_records": len(grows),
                f"{DS}.gmc_conversational": len(mrows),
            },
        }

    def _apply_review_memory(self, rv: dict) -> dict | None:
        for r in self.records.get(rv["sku"], []):
            if r["attr_key"] == rv["attr_key"]:
                action = rv["action"]
                if action == "approve":
                    r["gate_status"] = APPROVED
                elif action == "edit":
                    r["gate_status"] = EDITED
                    try:
                        v = json.loads(rv.get("after_value") or "null")
                    except ValueError:
                        v = rv.get("after_value")
                    d = ATTR_BY_KEY.get(r["attr_key"])
                    if d is not None and d.type == "number" and isinstance(v, str):
                        try:
                            v = float(v)
                        except ValueError:
                            pass
                    r["value"] = v
                elif action == "reject":
                    r["gate_status"] = HUMAN_REJECTED
                r["reviewed"] = {"action": action, "comment": rv.get("comment"), "at": rv.get("reviewed_at")}
                return r
        return None

    def apply_review(self, sku: str, attr_key: str, action: str, value: Any = None, comment: str = "",
                     reviewer: str = "demo-user") -> dict | None:
        with self.lock:
            cur = next((r for r in self.records.get(sku, []) if r["attr_key"] == attr_key), None)
            if cur is None:
                return None
            rv = {"sku": sku, "attr_key": attr_key, "action": action,
                  "before_value": json.dumps(cur.get("value"), ensure_ascii=False),
                  "after_value": json.dumps(value if action == "edit" else cur.get("value"), ensure_ascii=False),
                  "comment": comment, "reviewer": reviewer, "reviewed_at": _now()}
            updated = self._apply_review_memory(rv)
            self.reviews.append(rv)
            if sku in self.gmc:
                self.gmc[sku]["product_details"] = build_product_details(self.records.get(sku, []))
                rebuild_gmc_strings(self.gmc[sku])
        self._append("review_log", [rv])
        self._persist_golden(sku)
        return updated

    def _golden_row(self, sku: str) -> dict:
        g = golden_record(self.products[sku], self.records.get(sku, []), self.extras.get(sku, {}))
        return {"sku": sku, "title": g["title"], "category_group": g["group"],
                "attributes_json": json.dumps(g["attributes"], ensure_ascii=False),
                "feature_tags": g["feature_tags"], "search_keywords": g["search_keywords"],
                "ai_summary": g["ai_summary"], "fill_rate_before": g["fill_rate_before"],
                "fill_rate_after": g["fill_rate_after"], "updated_at": g["updated_at"]}

    def _persist_golden(self, sku: str, sync: bool = False):
        with self.lock:
            row = self._golden_row(sku)
        self._append("golden_records", [row], sync=sync)

    def upsert_job(self, job: dict):
        with self.lock:
            job = {**job, "updated_at": _now()}
            job.setdefault("created_at", job["updated_at"])
            self.jobs = [j for j in self.jobs if j["job_id"] != job["job_id"]]
            self.jobs.insert(0, job)
        self._append("batch_jobs", [job])

    # ── Product images (append-only, latest row per image_id wins) ──────────
    def images_of(self, sku: str, include_deleted: bool = False) -> list[dict]:
        with self.lock:
            rows = list(self.images.get(sku, {}).values())
        rows = [r for r in rows if include_deleted or r.get("status") != "deleted"]
        return sorted(rows, key=lambda r: (not r.get("is_primary"), r.get("status") != "saved", r.get("created_at") or ""),
                      reverse=False)

    def put_images(self, rows: list[dict], sync: bool = False):
        now = _now()
        out = []
        with self.lock:
            for r in rows:
                r = {**r, "updated_at": now}
                r.setdefault("created_at", now)
                self.images.setdefault(r["sku"], {})[r["image_id"]] = r
                out.append(image_to_row(r))
        self._append("product_images", out, sync=sync)
        return out

    def log_doc_extractions(self, rows: list[dict], sync: bool = True):
        self._append("doc_extractions", rows, sync=sync)

    # ── Queries ─────────────────────────────────────────────────────────────
    def status_of(self, sku: str) -> str:
        return sku_status(self.records.get(sku, []))


store = Store()

