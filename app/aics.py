"""Safe updates to the original AI Commerce Search catalog table (Retail API product schema).

Safety:
1. A daily zero-copy CLONE backup `<table_name>_backup_YYYYMMDD` is created before the first write of the day.
2. Changed rows are loaded into a staging table (same schema, WRITE_TRUNCATE) and applied with a single MERGE
   keyed on `id` (atomic; never appends duplicates).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading

from .config import settings

log = logging.getLogger(__name__)
_lock = threading.Lock()
_backup_done: set[str] = set()
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_]{0,127}$")
UPDATE_COLS = ("title", "brands", "categories", "description", "attributes", "images", "priceInfo", "uri")


def table() -> str:
    return settings.bq_source_table


def _staging() -> str:
    return f"{settings.dataset_ref}._aics_staging"


def _bq():
    from .repository import store
    return store.bq


def ensure_backup() -> str:
    day = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y%m%d")
    proj_ds, _, name = table().rpartition(".")
    bk = f"{proj_ds}.{name}_backup_{day}"
    if bk in _backup_done:
        return bk.rsplit(".", 1)[-1]
    _bq().query(f"CREATE TABLE IF NOT EXISTS `{bk}` CLONE `{table()}`").result()
    _backup_done.add(bk)
    log.info("AICS catalog backup ensured: %s", bk)
    return bk.rsplit(".", 1)[-1]


def fetch(ids: list[str]) -> dict[str, dict]:
    from google.cloud import bigquery
    if not ids:
        return {}
    job = _bq().query(f"SELECT TO_JSON_STRING(t) j FROM `{table()}` t WHERE id IN UNNEST(@ids)",
                      job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter("ids", "STRING", ids)]))
    out = {}
    for r in job.result():
        row = json.loads(r.j)
        out[row["id"]] = row
    return out


def merge_rows(rows: list[dict]) -> dict:
    """Upsert full rows (Retail product schema) into the AICS catalog table via staging + MERGE."""
    from google.cloud import bigquery
    if not rows:
        return {"updated": 0, "inserted": 0}
    with _lock:
        backup = ensure_backup()
        src = _bq().get_table(table())
        cfg = bigquery.LoadJobConfig(schema=src.schema, write_disposition="WRITE_TRUNCATE")
        _bq().load_table_from_json(rows, _staging(), job_config=cfg).result()
        existing = set(fetch([r["id"] for r in rows]).keys())
        sets = ", ".join(f"T.{c} = S.{c}" for c in UPDATE_COLS)
        _bq().query(f"""MERGE `{table()}` T USING `{_staging()}` S ON T.id = S.id
                       WHEN MATCHED THEN UPDATE SET {sets}
                       WHEN NOT MATCHED THEN INSERT ROW""").result()
    ins = sum(1 for r in rows if r["id"] not in existing)
    return {"updated": len(rows) - ins, "inserted": ins, "backup": backup}


def _attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"text": [str(value)[:256]], "numbers": []}}


def product_row(p: dict, existing: dict | None) -> tuple[dict, int]:
    """Build the updated catalog row from the merged in-app product. Returns (row, changed_attr_count)."""
    row = json.loads(json.dumps(existing)) if existing else {
        "name": p["sku"], "id": p["sku"], "type": "PRIMARY", "collectionMemberIds": [], "categories": [],
        "title": p.get("title") or p["sku"], "brands": [], "languageCode": "ja", "attributes": [], "tags": [],
        "availability": "IN_STOCK", "fulfillmentInfo": [], "images": [], "sizes": [], "materials": [],
        "patterns": [], "conditions": [], "promotions": [],
    }
    if p.get("title"):
        row["title"] = p["title"]
    if p.get("brand"):
        row["brands"] = [p["brand"]]
    if p.get("category") and not row.get("categories"):
        row["categories"] = [p["category"]]
    if p.get("description"):
        row["description"] = p["description"]
    if p.get("product_url") and not row.get("uri"):
        row["uri"] = p["product_url"]
    if p.get("price") is not None:
        pi = row.get("priceInfo") or {"currencyCode": "JPY"}
        pi["price"] = float(p["price"])
        pi.setdefault("originalPrice", float(p["price"]))
        pi.setdefault("currencyCode", "JPY")
        row["priceInfo"] = pi
    attrs = {a["key"]: a for a in row.get("attributes") or [] if a.get("key")}
    changed = 0
    for k, v in (p.get("raw_attributes") or {}).items():
        if not KEY_RE.match(str(k)) or v in (None, ""):
            continue
        cur = attrs.get(k)
        cur_txt = " / ".join((cur or {}).get("value", {}).get("text") or []) if cur else None
        if cur_txt != str(v):
            attrs[k] = _attr(k, v)
            changed += 1
    row["attributes"] = list(attrs.values())
    if not existing and p.get("image_url") and "noimage" not in p["image_url"]:
        row["images"] = [{"uri": p["image_url"], "height": 300, "width": 300}]
    return row, changed


def apply_products(products: list[dict]) -> dict:
    if settings.offline or not settings.update_aics:
        return {"table": table(), "updated": 0, "inserted": 0, "backup": "", "message": "スキップ（オフライン/無効）"}
    cur = fetch([p["sku"] for p in products])
    rows, attrs = [], 0
    for p in products:
        row, n = product_row(p, cur.get(p["sku"]))
        rows.append(row)
        attrs += n
    res = merge_rows(rows)
    return {"table": table(), **res, "attributes_changed": attrs, "message": ""}


def add_images(sku: str, images: list[dict], primary_uri: str | None = None) -> dict:
    """Append images [{uri,width,height}] to the catalog row (primary => moved to the front)."""
    if settings.offline or not settings.update_aics:
        return {"table": table(), "updated": False, "images_total": 0, "backup": "", "message": "スキップ（オフライン/無効）"}
    cur = fetch([sku]).get(sku)
    if not cur:
        return {"table": table(), "updated": False, "images_total": 0, "backup": "",
                "message": f"AICS カタログに SKU {sku} が存在しないため画像は追加していません"}
    imgs = [i for i in cur.get("images") or [] if i.get("uri")]
    have = {i["uri"] for i in imgs}
    for im in images:
        if im["uri"] not in have:
            imgs.append({"uri": im["uri"], "width": im.get("width"), "height": im.get("height")})
    if primary_uri:
        imgs.sort(key=lambda i: i["uri"] != primary_uri)
    cur["images"] = imgs
    res = merge_rows([cur])
    return {"table": table(), "updated": True, "images_total": len(imgs), "backup": res.get("backup", ""), "message": ""}


def remove_image(sku: str, uri: str) -> dict | None:
    if settings.offline or not settings.update_aics:
        return None
    cur = fetch([sku]).get(sku)
    if not cur or not any(i.get("uri") == uri for i in cur.get("images") or []):
        return None
    cur["images"] = [i for i in cur.get("images") or [] if i.get("uri") != uri]
    res = merge_rows([cur])
    return {"table": table(), "updated": True, "images_total": len(cur["images"]), "backup": res.get("backup", ""), "message": ""}
