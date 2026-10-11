"""② Extract product information from unstructured files (image / PDF / Excel / CSV) API."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re
import time
import uuid

from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from . import doc_extract, storage
from .config import settings
from .pipeline import fill_rate_after, fill_rate_before
from .repository import store

log = logging.getLogger(__name__)
router = APIRouter()
JST = dt.timezone(dt.timedelta(hours=9))


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _safe_name(name: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\s]+", "_", name or "file").strip("._") or "file"
    return name[-120:]


@router.post("/api/docs/upload")
async def docs_upload(file: UploadFile = File(...)):
    name = file.filename or "file"
    if not doc_extract.is_supported(name):
        raise HTTPException(400, "対応形式: jpg / png / webp / pdf / xlsx / csv")
    data = await file.read()
    if len(data) > doc_extract.MAX_BYTES:
        raise HTTPException(413, "1 ファイル 30MB 以下にしてください（大きな PDF は GCS パス指定で処理できます）")
    day = dt.datetime.now(JST).strftime("%Y%m%d")
    path = f"{settings.docs_prefix}/{day}/{uuid.uuid4().hex[:8]}_{_safe_name(name)}"
    mime = storage.guess_mime(name)
    uri = await asyncio.to_thread(storage.upload_bytes, path, data, mime, {"original_name": name})
    return {"file": {"uri": uri, "name": name, "mime": mime, "size": len(data), "url": storage.proxy_url(uri)}}


@router.post("/api/docs/list")
async def docs_list(body: dict = Body(...)):
    uri = (body.get("gcs_uri") or "").strip()
    if not uri.startswith("gs://"):
        raise HTTPException(400, "gs:// から始まる GCS パスを入力してください")
    try:
        st = None if uri.endswith("/") else await asyncio.to_thread(storage.stat, uri)
        items = [st] if st else await asyncio.to_thread(storage.list_prefix, uri, 500)
    except Exception as e:
        raise HTTPException(400, f"GCS を読み取れません: {str(e)[:200]}")
    ok = [f for f in items if doc_extract.is_supported(f["name"]) and f["size"] <= doc_extract.MAX_BYTES]
    return {"files": ok[:doc_extract.MAX_FILES], "skipped": len(items) - len(ok[:doc_extract.MAX_FILES])}


@router.post("/api/docs/extract")
async def docs_extract(body: dict = Body(...)):
    files = (body.get("files") or [])[:doc_extract.MAX_FILES]
    if not files:
        raise HTTPException(400, "ファイルを指定してください")
    products = list(store.products.values())

    async def gen():
        yield _sse({"event": "start", "count": len(files), "model": settings.gemini_model})
        sem = asyncio.Semaphore(4)

        async def run(i, f):
            async with sem:
                try:
                    return i, f, await doc_extract.extract_file(f, products), None
                except Exception as e:
                    log.exception("doc extract failed")
                    return i, f, None, str(e)[:300]

        for i, f in enumerate(files):
            yield _sse({"event": "file_start", "index": i, "name": f.get("name")})
        total = 0
        for fut in asyncio.as_completed([run(i, f) for i, f in enumerate(files)]):
            i, f, res, err = await fut
            if err:
                yield _sse({"event": "file_error", "index": i, "name": f.get("name"), "message": err})
                continue
            items = []
            for k, ex in enumerate(res["products"]):
                matches = doc_extract.match_sku(ex, products)
                items.append({"idx": k, **{x: ex.get(x) for x in ("model_number", "jan", "sku_hint", "title", "brand",
                                                                   "category", "price", "description", "attributes",
                                                                   "confidence")},
                              "matches": matches,
                              "suggested_sku": matches[0]["sku"] if matches and matches[0]["score"] >= 0.8 else None})
            total += len(items)
            yield _sse({"event": "file_done", "index": i, "name": f.get("name"), "uri": f.get("uri"),
                        "mime": f.get("mime"), "document_type": res["document_type"], "latency_ms": res["latency_ms"],
                        "input_tokens": res["input_tokens"], "output_tokens": res["output_tokens"], "products": items})
        yield _sse({"event": "complete", "files": len(files), "products": total})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _target(item: dict) -> tuple[str, dict | None]:
    sku = (item.get("sku") or "").strip()
    new_sku = (item.get("new_sku") or "").strip()
    if sku:
        if sku not in store.products:
            raise HTTPException(404, f"SKU {sku} が見つかりません")
        return sku, store.products[sku]
    if new_sku:
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$", new_sku):
            raise HTTPException(400, "新規 SKU は英数字・ハイフン・アンダースコアで入力してください")
        return new_sku, store.products.get(new_sku)
    raise HTTPException(400, "商品 ID（既存 SKU または新規 SKU）を指定してください")


@router.post("/api/docs/preview")
def docs_preview(body: dict = Body(...)):
    sku, cur = _target(body)
    merged, diff = doc_extract.merge(cur, body.get("product") or {}, body.get("mode") or "fill", sku,
                                     body.get("file_name") or "", body.get("file_uri") or "")
    return {"sku": sku, "is_new": cur is None, "diff": diff,
            "changes": sum(1 for d in diff if d["action"] in ("add", "overwrite", "new")),
            "group": merged.get("group")}


@router.post("/api/docs/apply")
async def docs_apply(body: dict = Body(...)):
    items = body.get("items") or []
    if not items:
        raise HTTPException(400, "反映する商品がありません")
    targets = [_target(it) for it in items]   # validate up-front (raises 4xx)
    enrich = body.get("enrich", True)
    update_aics = body.get("update_aics", True)

    async def gen():
        from .main import _enrich_single_product
        t0 = time.time()
        job_id = f"doc-{dt.datetime.now(JST).strftime('%Y%m%d%H%M%S')}"
        yield _sse({"event": "start", "count": len(items), "job_id": job_id})
        results, done_skus, merged_products, logs = [], [], [], []
        for i, (it, (sku, cur)) in enumerate(zip(items, targets)):
            yield _sse({"event": "item_start", "index": i, "sku": sku})
            try:
                cur = store.products.get(sku)   # may have been updated by a previous item
                before = fill_rate_before(cur) if cur else 0.0
                merged, diff = doc_extract.merge(cur, it.get("product") or {}, it.get("mode") or "fill", sku,
                                                 it.get("file_name") or "", it.get("file_uri") or "")
                changes = sum(1 for d in diff if d["action"] in ("add", "overwrite", "new"))
                store.save_source_products([merged], persist_bq=False)
                yield _sse({"event": "merged", "index": i, "sku": sku, "changes": changes, "diff": diff})
                if enrich:
                    recs, extras, gmc, stats = await _enrich_single_product(merged, job_id)
                    store.save_enrichment(sku, recs, extras, job_id, gmc=gmc, persist_bq=False)
                    store.live_runs.append({"sku": sku, "input_tokens": stats["input_tokens"],
                                            "output_tokens": stats["output_tokens"]})
                    yield _sse({"event": "enriched", "index": i, "sku": sku, "attr_count": stats["attr_count"],
                                "tag_count": stats["tag_count"], "status": store.status_of(sku),
                                "fill_before": round(before, 3), "fill_after": round(fill_rate_after(merged, recs), 3),
                                "latency_ms": stats["latency_ms"]})
                done_skus.append(sku)
                merged_products.append(merged)
                logs.append({"job_id": job_id, "file_uri": it.get("file_uri") or "", "file_name": it.get("file_name") or "",
                             "document_type": it.get("document_type") or "", "product_index": int((it.get("product") or {}).get("idx") or 0),
                             "applied_sku": sku, "is_new": cur is None, "merge_mode": it.get("mode") or "fill",
                             "changes": changes, "extracted_json": json.dumps(it.get("product") or {}, ensure_ascii=False),
                             "diff_json": json.dumps(diff, ensure_ascii=False), "model": settings.gemini_model,
                             "created_at": dt.datetime.now(dt.timezone.utc).isoformat()})
                results.append({"sku": sku, "status": "ok", "changes": changes})
            except Exception as e:
                log.exception("doc apply failed")
                results.append({"sku": sku, "status": "error", "message": str(e)[:300]})
                yield _sse({"event": "item_error", "index": i, "sku": sku, "message": str(e)[:300]})
        bq = None
        if done_skus:
            try:
                bq = await asyncio.to_thread(store.persist_skus_to_bq, list(dict.fromkeys(done_skus)))
                await asyncio.to_thread(store.log_doc_extractions, logs, True)
                bq["tables"][f"{settings.dataset_ref}.doc_extractions"] = len(logs)
                yield _sse({"event": "saved", "bq": bq})
            except Exception as e:
                log.exception("bq persist failed")
                yield _sse({"event": "error", "message": f"BigQuery 保存に失敗: {str(e)[:250]}"})
            if update_aics:
                from . import aics
                try:
                    latest = {p["sku"]: store.products[p["sku"]] for p in merged_products}
                    res = await asyncio.to_thread(aics.apply_products, list(latest.values()))
                except Exception as e:
                    log.exception("aics update failed")
                    res = {"table": aics.table(), "updated": 0, "inserted": 0, "backup": "", "message": str(e)[:300]}
                yield _sse({"event": "aics", "result": res})
        yield _sse({"event": "complete", "results": results, "elapsed_ms": int((time.time() - t0) * 1000)})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
