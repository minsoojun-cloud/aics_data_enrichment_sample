"""① Seasonal product image studio API."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging

from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from . import image_gen, image_presets, storage
from .config import settings
from .repository import store
from .schema import CATEGORY_GROUPS

log = logging.getLogger(__name__)
router = APIRouter()
JST = dt.timezone(dt.timedelta(hours=9))
MAX_UPLOAD = 10 * 1024 * 1024


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _product(sku: str) -> dict:
    p = store.products.get(sku)
    if not p:
        raise HTTPException(404, "SKU not found")
    return p


def has_image(p: dict) -> bool:
    u = p.get("image_url") or ""
    return bool(u) and "noimage" not in u.lower()


def registered_images(p: dict) -> list[dict]:
    return [{"url": p["image_url"], "kind": "original", "label": "登録画像（カタログ）"}] if has_image(p) else []


def _public(row: dict) -> dict:
    r = dict(row)
    if r.get("gcs_uri"):
        r["url"] = storage.proxy_url(r["gcs_uri"])
    return r


@router.get("/api/images/presets")
def presets(sku: str):
    p = _product(sku)
    return {
        "sku": sku,
        "product": {"sku": sku, "title": p.get("title"), "brand": p.get("brand"), "group": p.get("group"),
                    "group_label": CATEGORY_GROUPS.get(p.get("group"), p.get("group")), "image_url": p.get("image_url"),
                    "has_image": has_image(p), "category": p.get("category")},
        "presets": image_presets.evaluate(p, store.records.get(sku, [])),
        "options": image_gen.options(),
    }


@router.get("/api/products/{sku}/images")
def product_images(sku: str):
    p = _product(sku)
    return {"sku": sku, "registered": registered_images(p), "images": [_public(r) for r in store.images_of(sku)]}


@router.post("/api/products/{sku}/images/upload")
async def upload_base(sku: str, file: UploadFile = File(...)):
    _product(sku)
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "画像は 10MB 以下にしてください")
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, "画像ファイル（jpg/png/webp）を選択してください")
    from .image_gen import to_jpeg
    try:
        jpg, w, h = to_jpeg(data, 0, "free")
    except Exception:
        raise HTTPException(400, "画像を読み込めませんでした")
    ts = dt.datetime.now(JST).strftime("%Y%m%d-%H%M%S")
    uri = storage.upload_bytes(f"{sku}/base/{sku}_base_{ts}.jpg", jpg, "image/jpeg",
                               metadata={"sku": sku, "kind": "uploaded", "original_name": file.filename})
    return {"base": {"type": "upload", "uri": uri, "url": storage.proxy_url(uri), "width": w, "height": h}}


@router.post("/api/products/{sku}/images/search")
async def search(sku: str):
    from .image_search import find_candidates
    p = _product(sku)
    try:
        return await find_candidates(p)
    except Exception as e:
        log.exception("image search failed")
        return {"query": "", "candidates": [], "message": f"検索に失敗しました: {str(e)[:200]}"}


async def resolve_base(p: dict, base: dict) -> tuple[bytes | None, str, str, str]:
    """Returns (bytes, base_uri, kind, source_url)."""
    t = (base or {}).get("type") or "registered"
    uri = ((base or {}).get("uri") or "").strip()
    from .image_search import fetch_image
    if t == "none":
        return None, "", "none", ""
    if t == "registered":
        uri = uri or (p.get("image_url") if has_image(p) else "")
        if not uri:
            raise ValueError("この商品には登録画像がありません。Web検索・アップロード・GCSパスのいずれかを選んでください")
    if uri.startswith("gs://"):
        data, _ = storage.download(uri)
        return data, uri, "gcs" if t == "gcs" else t, ""
    if uri.startswith("/api/img/"):
        guri = f"gs://{settings.image_bucket}/{uri[len('/api/img/'):]}"
        data, _ = storage.download(guri)
        return data, guri, t, ""
    if uri.startswith("http"):
        data = await fetch_image(uri)
        return data, uri, t, uri if t == "web" else ""
    raise ValueError(f"ベース画像を解決できません: {uri or t}")


@router.post("/api/products/{sku}/images/generate")
async def generate(sku: str, body: dict = Body(...)):
    p = _product(sku)
    preset_ids = [i for i in body.get("presets") or [] if i in image_presets.PRESET_BY_ID]
    avail = {x["id"]: x for x in image_presets.evaluate(p, store.records.get(sku, []))}
    blocked = [i for i in preset_ids if not avail.get(i, {}).get("available")]
    if blocked:
        raise HTTPException(400, f"この商品では使えないプリセットです: {', '.join(blocked)}")

    async def gen():
        try:
            data, base_uri, kind, source_url = await resolve_base(p, body.get("base") or {})
        except Exception as e:
            yield _sse({"event": "error", "message": str(e)[:300]})
            return
        try:
            async for ev in image_gen.generate(
                    p, store.records.get(sku, []), data, base_uri, kind, source_url, preset_ids,
                    body.get("extra_prompt") or "", body.get("n") or 3, body.get("aspect") or "1:1",
                    body.get("text_mode") or "none", body.get("model") or settings.image_model,
                    body.get("size") if body.get("size") is not None else settings.image_default_size):
                if ev["event"] == "start":
                    ev["base_url"] = (storage.proxy_url(base_uri) if base_uri.startswith("gs://") else base_uri)
                if ev["event"] == "image":
                    store.put_images([ev["image"]])
                yield _sse(ev)
        except Exception as e:
            log.exception("image generation failed")
            yield _sse({"event": "error", "message": str(e)[:300]})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/api/products/{sku}/images/save")
async def save(sku: str, body: dict = Body(...)):
    p = _product(sku)
    ids = list(dict.fromkeys(body.get("image_ids") or []))
    primary = body.get("primary_id")
    if primary and primary not in ids:
        ids.append(primary)
    cur = store.images.get(sku, {})
    missing = [i for i in ids if i not in cur or cur[i].get("status") == "deleted"]
    if not ids or missing:
        raise HTTPException(400, f"保存できない画像があります: {', '.join(missing) or '未選択'}")
    rows = []
    for iid in ids:
        r = dict(cur[iid])
        r["status"] = "saved"
        r["is_primary"] = iid == primary
        rows.append(r)
    if primary:  # demote other primaries
        for iid, r in cur.items():
            if iid not in ids and r.get("is_primary"):
                rows.append({**r, "is_primary": False})
    await asyncio.to_thread(store.put_images, rows, True)
    aics_res = None
    if body.get("update_aics", True):
        from . import aics
        try:
            aics_res = await asyncio.to_thread(
                aics.add_images, sku,
                [{"uri": storage.public_url(r["gcs_uri"]), "width": r.get("width"), "height": r.get("height")}
                 for r in rows if r["image_id"] in ids],
                storage.public_url(cur[primary]["gcs_uri"]) if primary else None)
        except Exception as e:
            log.exception("aics image update failed")
            aics_res = {"table": aics.table(), "updated": False, "images_total": 0, "backup": "", "message": str(e)[:300]}
    if primary:
        p["primary_image_url"] = storage.proxy_url(cur[primary]["gcs_uri"])
    return {"saved": [_public(r) for r in rows if r["image_id"] in ids],
            "bq": {"table": f"{settings.dataset_ref}.product_images", "rows": len(rows)},
            "aics": aics_res}


@router.delete("/api/products/{sku}/images/{image_id}")
async def delete(sku: str, image_id: str):
    _product(sku)
    r = store.images.get(sku, {}).get(image_id)
    if not r or r.get("status") == "deleted":
        raise HTTPException(404, "画像が見つかりません")
    was_saved = r.get("status") == "saved"
    ok = await asyncio.to_thread(storage.delete, r["gcs_uri"]) if r.get("gcs_uri") else False
    await asyncio.to_thread(store.put_images, [{**r, "status": "deleted", "is_primary": False}], True)
    aics_res = None
    if was_saved:
        from . import aics
        try:
            aics_res = await asyncio.to_thread(aics.remove_image, sku, storage.public_url(r["gcs_uri"]))
        except Exception as e:
            log.exception("aics image remove failed")
            aics_res = {"updated": False, "message": str(e)[:300]}
    return {"deleted": True, "image_id": image_id, "gcs_deleted": ok, "aics": aics_res}


@router.get("/api/img/{path:path}")
def img_proxy(path: str):
    if ".." in path:
        raise HTTPException(400, "bad path")
    try:
        data, mime = storage.download(f"gs://{settings.image_bucket}/{path}")
    except Exception:
        raise HTTPException(404, "not found")
    return Response(content=data, media_type=mime, headers={"Cache-Control": "public, max-age=86400"})
