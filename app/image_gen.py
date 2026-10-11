"""Seasonal product image generation with Gemini image models (Nano Banana 2 / Pro) on Vertex AI.

- N candidates are generated in parallel (one request each) and streamed back as soon as each finishes.
- Output is resized with Pillow to the requested size (default 300x300) and saved as JPEG to
  gs://{image_bucket}/{SKU}/{SKU}_{preset}_{yyyymmdd-HHMMSS}_{n}.jpg
- A lightweight fidelity check (gemini-3.8-flash) compares base vs generated image (same product? invented specs?).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import io
import logging
import time
from typing import AsyncIterator

from .config import settings
from .image_presets import PRESET_BY_ID, verified_facts
from . import storage

log = logging.getLogger(__name__)
JST = dt.timezone(dt.timedelta(hours=9))
ASPECTS = ("1:1", "4:3", "3:4", "16:9")
TEXT_MODES = {"none": "文字なし", "copy": "キャッチコピーのみ", "spec": "スペック入り"}
SIZES = (300, 600, 1024, 0)


def model_options() -> list[dict]:
    return [{"id": settings.image_model, "label": "Flash（高速・標準）"},
            {"id": settings.image_model_pro, "label": "Pro（高品質・文字入れ向き）"}]


def options() -> dict:
    return {
        "models": model_options(), "default_model": settings.image_model,
        "sizes": [{"value": s, "label": f"{s}×{s}" if s else "元サイズ"} for s in SIZES],
        "default_size": settings.image_default_size,
        "aspects": list(ASPECTS), "default_aspect": "1:1",
        "text_modes": [{"id": k, "label": v} for k, v in TEXT_MODES.items()], "default_text_mode": "none",
        "counts": [2, 3, 4], "default_count": 3, "bucket": settings.image_bucket,
    }


def build_prompt(product: dict, recs: list[dict], preset_ids: list[str], extra_prompt: str,
                 aspect: str, text_mode: str, has_base: bool) -> tuple[str, list[dict]]:
    presets = [PRESET_BY_ID[i] for i in preset_ids if i in PRESET_BY_ID]
    fact_keys: list[str] = []
    for pr in presets:
        fact_keys += [k for k in pr.facts if k not in fact_keys]
    facts = verified_facts(tuple(fact_keys), recs)
    fact_txt = " / ".join(f"{f['label']} {f['value']}" for f in facts) or "（なし）"
    scene = "\n".join(f"- {pr.label}: {pr.prompt}" for pr in presets) or "- 商品の魅力が伝わる販促用の商品画像"
    text_rule = {
        "none": "画像内に文字・数字・ロゴ・透かしを一切入れない。",
        "copy": "短い日本語のキャッチコピー（15文字以内）を1つだけ入れてよい。性能の数値は入れない。",
        "spec": "日本語のキャッチコピーと、下の「検証済みスペック」にある数値だけを入れてよい。それ以外の数値は入れない。",
    }.get(text_mode, "画像内に文字を入れない。")
    base_rule = ("1. 入力画像の商品そのもの（形状・色・ロゴ・ボタン配置・比率）を変えない。別の商品や別の色にしない。商品は画面内に大きく、はっきり見えるように配置する。"
                 if has_base else
                 "1. 下の商品情報に合う、実在しそうな一般的な外観で描く（特定メーカーのロゴは描かない）。")
    from .image_search import fields
    from .schema import CATEGORY_GROUPS
    _f = fields(product)
    prompt = f"""あなたは総合EC・家電リテーラーの販促用画像デザイナーです。季節の販促に使う商品画像を1枚作成してください。

## 必ず守ること
{base_rule}
2. {text_rule}
3. 実在しない認証マーク・受賞ロゴ・価格表示・他社ロゴを描かない。
4. 写真のようにリアルで、明るく清潔感のある日本の住環境・生活シーンにする。

## 商品
{_f['brand']} {_f['title']}（カテゴリ: {CATEGORY_GROUPS.get(product.get('group'), product.get('group') or '')}）

## 検証済みスペック（承認済みの属性のみ）
{fact_txt}

## 訴求シーン（プリセット）
{scene}

## 担当者の追加指示
{extra_prompt.strip() or '（なし）'}

## 出力
アスペクト比 {aspect}。"""
    return prompt, facts


def _first_image(resp) -> bytes | None:
    for cand in resp.candidates or []:
        for part in (cand.content.parts if cand.content else []) or []:
            if getattr(part, "inline_data", None) and part.inline_data.data:
                return part.inline_data.data
    return None


def to_jpeg(data: bytes, size: int, aspect: str) -> tuple[bytes, int, int]:
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB")
        w, h = im.size
        if size:
            if aspect == "1:1":
                side = min(w, h)
                im = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
                im = im.resize((size, size), Image.LANCZOS)
            else:
                scale = size / max(w, h)
                im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90, optimize=True)
        return buf.getvalue(), im.size[0], im.size[1]


def _placeholder(label: str, i: int) -> bytes:
    """Offline mode image (tests)."""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (512, 512), (0, 64 + 40 * i % 160, 152))
    ImageDraw.Draw(im).text((20, 240), f"{label} #{i}", fill=(255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


async def fidelity_check(base: bytes, gen: bytes, facts: list[dict]) -> tuple[float | None, str]:
    if settings.offline:
        return 0.95, "オフライン（判定省略）"
    from google.genai import types

    from .gemini_client import client
    schema = {"type": "OBJECT", "properties": {
        "same_product_score": {"type": "NUMBER"}, "invented_numbers": {"type": "BOOLEAN"}, "note": {"type": "STRING"}},
        "required": ["same_product_score", "invented_numbers", "note"]}
    facts_txt = " / ".join(f"{f['label']} {f['value']}" for f in facts) or "なし"
    prompt = ("画像1は元の商品写真、画像2は生成された販促画像です。\n"
              "1) 画像2に写っている商品が画像1と同じ商品か（形状・色・ロゴ・ボタン配置）を 0.0〜1.0 で採点（same_product_score）。\n"
              f"2) 画像2の中の文字に、検証済みスペック（{facts_txt}）にない性能数値があれば invented_numbers=true。\n"
              "3) note に日本語で30字以内の所見。")
    try:
        resp = await client().aio.models.generate_content(
            model=settings.gemini_model,
            contents=[types.Part.from_bytes(data=base, mime_type="image/jpeg"),
                      types.Part.from_bytes(data=gen, mime_type="image/jpeg"), prompt],
            config=types.GenerateContentConfig(temperature=0.0, response_mime_type="application/json",
                                               response_schema=schema,
                                               thinking_config=types.ThinkingConfig(thinking_level="LOW")))
        import json
        d = json.loads(resp.text)
        score = max(0.0, min(1.0, float(d.get("same_product_score") or 0)))
        note = str(d.get("note") or "")
        if d.get("invented_numbers"):
            score = min(score, 0.6)
            note = ("⚠ スペック外の数値あり。" + note)[:60]
        return round(score, 3), note
    except Exception as e:  # pragma: no cover
        log.warning("fidelity check failed: %s", e)
        return None, "判定できませんでした"


def _to_jpeg_input(data: bytes) -> bytes:
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92)
        return buf.getvalue()


async def generate(product: dict, recs: list[dict], base_img: bytes | None, base_uri: str, base_kind: str,
                   source_url: str, preset_ids: list[str], extra_prompt: str, n: int, aspect: str,
                   text_mode: str, model: str, size: int) -> AsyncIterator[dict]:
    sku = product["sku"]
    n = max(1, min(4, int(n or 3)))
    aspect = aspect if aspect in ASPECTS else "1:1"
    size = int(size) if int(size or 0) in SIZES else settings.image_default_size
    model = model if model in (settings.image_model, settings.image_model_pro) else settings.image_model
    if base_img:
        base_img = _to_jpeg_input(base_img)
    prompt, facts = build_prompt(product, recs, preset_ids, extra_prompt, aspect, text_mode, bool(base_img))
    ts = dt.datetime.now(JST).strftime("%Y%m%d-%H%M%S")
    slug = (preset_ids[0] if preset_ids else "custom") + ("-mix" if len(preset_ids) > 1 else "")
    first = PRESET_BY_ID.get(preset_ids[0]) if preset_ids else None
    t0 = time.time()
    yield {"event": "start", "n": n, "model": model, "prompt": prompt, "facts": facts, "size": size, "aspect": aspect}

    async def one(i: int) -> dict:
        if settings.offline:
            raw = _placeholder(slug, i)
        else:
            from google.genai import types

            from .gemini_client import client
            parts = ([types.Part.from_bytes(data=base_img, mime_type="image/jpeg")] if base_img else []) + [
                prompt + f"\n（バリエーション {i}/{n}: 構図・アングル・小物を他の案と変えること）"]
            resp = await client().aio.models.generate_content(
                model=model, contents=parts,
                config=types.GenerateContentConfig(response_modalities=["IMAGE"], temperature=1.0,
                                                   image_config=types.ImageConfig(aspect_ratio=aspect)))
            raw = _first_image(resp)
            if not raw:
                reason = ""
                try:
                    reason = str(resp.candidates[0].finish_reason)
                except Exception:
                    pass
                raise RuntimeError(f"画像が返されませんでした {reason}".strip())
        jpg, w, h = to_jpeg(raw, size, aspect)
        image_id = f"{sku}_{slug}_{ts}_{i}"
        path = f"{sku}/{image_id}.jpg"
        uri = storage.upload_bytes(path, jpg, "image/jpeg", metadata={
            "sku": sku, "preset": ",".join(preset_ids), "model": model, "source_url": source_url,
            "prompt_hash": hashlib.sha1(prompt.encode()).hexdigest()[:12], "status": "candidate"})
        score, note = (await fidelity_check(base_img, jpg, facts)) if base_img else (None, "ベース画像なし（イメージ画像）")
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        return {
            "image_id": image_id, "sku": sku, "gcs_uri": uri, "url": storage.proxy_url(uri),
            "kind": "generated", "status": "candidate", "is_primary": False,
            "preset": ",".join(preset_ids), "preset_label": " + ".join(PRESET_BY_ID[p].label for p in preset_ids if p in PRESET_BY_ID) or "カスタム",
            "season": first.season if first else "", "prompt": prompt, "extra_prompt": extra_prompt or "",
            "base_image_uri": base_uri or "", "base_kind": base_kind, "source_url": source_url or "", "model": model,
            "width": w, "height": h, "aspect": aspect, "fidelity_score": score, "fidelity_note": note,
            "created_at": now, "updated_at": now,
        }

    async def wrapped(i: int):
        try:
            return i, await one(i), None
        except Exception as e:
            log.exception("image %d failed", i)
            return i, None, str(e)[:300]

    for i in range(1, n + 1):
        yield {"event": "progress", "index": i, "status": "generating"}
    count = 0
    for fut in asyncio.as_completed([wrapped(i) for i in range(1, n + 1)]):
        i, row, err = await fut
        if row:
            count += 1
            yield {"event": "image", "index": i, "image": row}
        else:
            yield {"event": "image_error", "index": i, "message": err}
    yield {"event": "complete", "count": count, "elapsed_ms": int((time.time() - t0) * 1000)}
