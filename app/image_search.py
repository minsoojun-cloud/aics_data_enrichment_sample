"""Find product images on the web when a SKU has no registered image.

No Custom Search API key is available, so we use Gemini with Google Search grounding to locate product pages
(maker / retailer), then read `og:image` / `twitter:image` / large <img> from those pages.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import re
from urllib.parse import urljoin

import httpx

from .config import settings

log = logging.getLogger(__name__)
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept-Language": "ja,en;q=0.8"}
_META_RE = re.compile(r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\'][^>]*>', re.I)
_CONTENT_RE = re.compile(r'content=["\']([^"\']+)["\']', re.I)
_IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+\.(?:jpe?g|png|webp)(?:\?[^"\']*)?)["\']', re.I)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
NOIMAGE_RE = re.compile(r"noimage|no_image|no-image|placeholder|logo|icon|sprite|banner", re.I)


def _clean(v) -> str:
    """Brand/category may arrive as JSON list strings (CSV ingest): '["ダイキン"]' -> 'ダイキン'."""
    t = str(v or "").strip()
    if t.startswith("["):
        try:
            x = json.loads(t)
            if isinstance(x, list) and x:
                return str(x[0])
        except ValueError:
            pass
    return t


def fields(p: dict) -> dict:
    raw = p.get("raw_attributes") or {}
    title = p.get("title") or ""
    if (not title or title == p.get("sku")) and raw.get("title"):
        title = str(raw["title"])
    blob = " ".join(str(v) for v in raw.values()) + " " + (p.get("description") or "")
    mn = str(raw.get("model_number") or "").strip()
    if not mn:
        m = re.search(r'model_number[^\]]*?text[^\[]*\[\s*\\?"([A-Za-z0-9\-()/]+)', blob)
        mn = m.group(1) if m else ""
    if not mn:
        m = re.findall(r"[A-Z0-9][A-Z0-9\-]{4,}[A-Z0-9]", title)
        mn = max(m, key=len) if m else ""
    base = re.search(r"型番[:：]\s*([A-Za-z0-9\-()/]+)", p.get("description") or "")
    bm = base.group(1) if base else ""
    while bm.endswith(")") and bm.count(")") > bm.count("("):
        bm = bm[:-1]
    return {"title": title, "brand": _clean(p.get("brand")), "model": mn, "base_model": bm}


def model_number(p: dict) -> str:
    return fields(p)["model"]


def search_query(p: dict) -> str:
    f = fields(p)
    return " ".join(x for x in [f["brand"], f["model"] or f["title"][:40]] if x).strip()


def image_size(data: bytes) -> tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            return im.size
    except Exception:
        return 0, 0


async def _page_images(cli: httpx.AsyncClient, page_url: str) -> tuple[str, str, list[str]]:
    try:
        r = await cli.get(page_url, headers=UA, timeout=8)
        html = r.text[:600_000]
        final = str(r.url)
    except Exception as e:
        log.info("page fetch failed %s: %s", page_url, e)
        return page_url, "", []
    title = ""
    m = _TITLE_RE.search(html)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()[:120]
    urls = []
    for tag in _META_RE.findall(html):
        c = _CONTENT_RE.search(tag)
        if c:
            urls.append(urljoin(final, c.group(1)))
    for src in _IMG_RE.findall(html)[:40]:
        urls.append(urljoin(final, src))
    seen, out = set(), []
    for u in urls:
        if u not in seen and u.startswith("http") and not NOIMAGE_RE.search(u):
            seen.add(u)
            out.append(u)
    return final, title, out[:8]


async def _probe(cli: httpx.AsyncClient, url: str) -> tuple[int, int] | None:
    try:
        r = await cli.get(url, headers=UA, timeout=8)
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
            return None
        w, h = image_size(r.content)
        return (w, h) if min(w, h) >= 300 else None
    except Exception:
        return None


async def _grounded_pages(p: dict) -> tuple[list[str], list[str]]:
    """Ask Gemini (google_search tool) for product page URLs and direct image URLs."""
    from google.genai import types

    from .gemini_client import client
    q = search_query(p)
    f = fields(p)
    prompt = f"""次の家電商品の公式商品ページ（メーカー）または大手通販の商品ページを Google 検索で探してください。
商品: {f['title']}
ブランド: {f['brand']}
型番: {f['model']}""" + (f"\nベースモデルの型番: {f['base_model']}（量販店オリジナルモデルのため、ベースモデルのメーカーページでもよい）" if f["base_model"] else "") + """
回答は JSON のみ: {"pages": ["商品ページURL", ...最大5件], "images": ["商品画像の直接URL(jpg/png/webp)", ...最大5件]}"""
    resp = None
    # gemini-3.8-flash (thinking LOW) first; fall back to the lighter model when busy (503) or slow.
    for model, think, tmo in ((settings.gemini_model, "LOW", 40), ("gemini-3.1-flash-lite", None, 30)):
        try:
            resp = await asyncio.wait_for(client().aio.models.generate_content(
                model=model, contents=prompt,
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())], temperature=0.0,
                    thinking_config=types.ThinkingConfig(thinking_level=think) if think else None)), timeout=tmo)
            break
        except Exception as e:
            log.warning("grounded search with %s failed: %s", model, repr(e)[:200])
    if resp is None:
        raise RuntimeError("Google 検索グラウンディングが応答しませんでした（時間をおいて再試行してください）")
    pages, images = [], []
    # The model's answer shape varies (list of URLs / list of objects) – collect every URL in the text.
    for u in re.findall(r"https?://[^\s\"'<>\]\)、]+", resp.text or ""):
        u = u.rstrip(".,;")
        (images if re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", u, re.I) else pages).append(u)
    try:
        gm = resp.candidates[0].grounding_metadata
        for ch in (gm.grounding_chunks or []) if gm else []:
            if ch.web and ch.web.uri:
                pages.append(ch.web.uri)   # vertexaisearch redirect URLs – followed by httpx
    except Exception:
        pass
    log.info("image search q=%s pages=%d images=%d", q, len(pages), len(images))
    return list(dict.fromkeys(pages))[:8], list(dict.fromkeys(images))[:6]


async def find_candidates(p: dict, limit: int = 6) -> dict:
    q = search_query(p)
    if settings.offline:
        return {"query": q, "candidates": [], "message": "オフラインモードでは Web 検索は使えません"}
    pages, direct = await _grounded_pages(p)
    cands: list[dict] = []
    async with httpx.AsyncClient(follow_redirects=True) as cli:
        try:
            page_res = await asyncio.wait_for(asyncio.gather(*[_page_images(cli, u) for u in pages]), timeout=25)
        except asyncio.TimeoutError:
            page_res = []
        pool: list[tuple[str, str, str]] = [(u, "", "") for u in direct]
        for final, title, imgs in page_res:
            pool += [(u, final, title) for u in imgs[:3]]
        seen = set()
        uniq = [x for x in pool if not (x[0] in seen or seen.add(x[0]))][:24]
        try:
            sizes = await asyncio.wait_for(asyncio.gather(*[_probe(cli, u) for u, _, _ in uniq]), timeout=25)
        except asyncio.TimeoutError:
            sizes = [None] * len(uniq)
        for (u, page, title), sz in zip(uniq, sizes):
            if sz:
                cands.append({"url": u, "page_url": page, "title": title, "width": sz[0], "height": sz[1], "via": "grounding"})
            if len(cands) >= limit:
                break
    msg = "" if cands else "Web 上で使える商品画像が見つかりませんでした。アップロードまたは「ベース画像なし」で生成してください。"
    return {"query": q, "candidates": cands, "message": msg}


async def fetch_image(url: str) -> bytes:
    async with httpx.AsyncClient(follow_redirects=True) as cli:
        r = await cli.get(url, headers=UA, timeout=15)
        r.raise_for_status()
        if not r.headers.get("content-type", "").startswith("image/"):
            raise ValueError(f"画像ではありません: {url}")
        return r.content
