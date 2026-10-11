"""Fallback: enrich the sample SKUs with ONLINE Gemini calls (bounded concurrency).

Used when a Vertex AI Batch Prediction job sits in JOB_STATE_PENDING (queueing can take hours).
Results are stored exactly like a batch ingestion (enriched_attributes / sku_extras / golden_records)
under job_id "online-<stamp>" and registered in batch_jobs so the UI & cost KPIs pick it up.
If the real batch finishes later, its (newer) records supersede these automatically.

    PYTHONPATH=. venv/bin/python scripts/run_online.py [--concurrency 8] [--group fridge] [--limit 100] [--only-missing]
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import logging
import time

from app.batch import cost_jpy
from app.config import settings
from app.gemini_client import run_gmc, run_stage1, run_stage3
from app.pipeline import process_gmc, process_stage1, process_stage3
from app.repository import store

logging.basicConfig(level=logging.WARNING)


async def enrich_all(products: list[dict], job_id: str, concurrency: int, gmc_only: bool = False):
    sem = asyncio.Semaphore(concurrency)
    stats = {"in": 0, "out": 0, "ok": 0, "fail": 0}
    items = []
    gmc_items = []
    all_prods = list(store.products.values())

    async def one(p):
        async with sem:
            for attempt in range(3):
                try:
                    if gmc_only:
                        sg = await run_gmc(p)
                        s1 = s3 = None
                    else:
                        s1, s3, sg = await asyncio.gather(run_stage1(p), run_stage3(p), run_gmc(p))
                    break
                except Exception as e:  # retry transient 429/5xx
                    if attempt == 2:
                        stats["fail"] += 1
                        print(f"  ✗ {p['sku']}: {e}")
                        return
                    await asyncio.sleep(4 * (attempt + 1))
            if gmc_only:
                all_recs = store.records.get(p["sku"], [])
                gmc = process_gmc(p, sg["data"], all_recs, sg["avg_logprobs"], job_id, settings.gemini_model, all_prods)
                gmc_items.append((p["sku"], gmc))
                stats["in"] += sg["input_tokens"]
                stats["out"] += sg["output_tokens"]
            else:
                recs = process_stage1(p, s1["data"], s1["avg_logprobs"], job_id, settings.gemini_model)
                tags, extras = process_stage3(p, s3["data"], s3["avg_logprobs"], job_id, settings.gemini_model)
                all_recs = recs + tags
                gmc = process_gmc(p, sg["data"], all_recs, sg["avg_logprobs"], job_id, settings.gemini_model, all_prods)
                items.append((p["sku"], all_recs, extras, gmc))
                stats["in"] += s1["input_tokens"] + s3["input_tokens"] + sg["input_tokens"]
                stats["out"] += s1["output_tokens"] + s3["output_tokens"] + sg["output_tokens"]
            stats["ok"] += 1
            if stats["ok"] % 10 == 0:
                print(f"  … {stats['ok']}/{len(products)} done")

    await asyncio.gather(*(one(p) for p in products))
    return items, gmc_items, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--group")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only-missing", action="store_true", help="skip SKUs that already have records")
    ap.add_argument("--gmc-only", action="store_true", help="only generate GMC conversational attributes")
    ap.add_argument("--skus", help="comma separated SKU list")
    a = ap.parse_args()

    store.load()
    products = [p for p in store.products.values() if not a.group or p["group"] == a.group]
    if a.skus:
        wanted = set(a.skus.split(","))
        products = [p for p in products if p["sku"] in wanted]
    if a.only_missing:
        if a.gmc_only:
            products = [p for p in products if not store.gmc.get(p["sku"])]
        else:
            products = [p for p in products if not store.records.get(p["sku"])]
    products = products[: a.limit] if a.limit else products
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    job_id = f"online-{stamp}"
    print(f"{job_id}: {len(products)} SKUs, model={settings.gemini_model}, gmc_only={a.gmc_only}, thinking={settings.thinking_level or 'default'}")
    t0 = time.time()
    items, gmc_items, st = asyncio.run(enrich_all(products, job_id, a.concurrency, gmc_only=a.gmc_only))
    if a.gmc_only:
        for sku, gmc in gmc_items:
            store.gmc[sku] = gmc
        if gmc_items:
            store._append("gmc_conversational", [store.gmc_to_row(g) for _, g in gmc_items])
    elif items:
        store.save_many(items, job_id)
        store.upsert_job({
            "job_id": job_id, "display_name": f"online-3.8-flash-{stamp}", "model": settings.gemini_model,
            "state": "JOB_STATE_SUCCEEDED", "sku_count": len(products), "request_count": len(products) * 3,
            "input_tokens": st["in"], "output_tokens": st["out"], "cost_jpy": cost_jpy(st["in"], st["out"], batch=False),
            "src": "online (generateContent)", "dest": f"{settings.dataset_ref}.enriched_attributes",
            "ingested": True, "ingested_skus": len(items),
        })
    store._pool.shutdown(wait=True)  # flush background BQ load jobs
    el = time.time() - t0
    print(f"done in {el:.0f}s ok={st['ok']} fail={st['fail']} in={st['in']} out={st['out']} "
          f"online={cost_jpy(st['in'], st['out'], False):.2f}円 batch換算={cost_jpy(st['in'], st['out'], True):.2f}円 "
          f"({cost_jpy(st['in'], st['out'], True) / max(st['ok'], 1):.4f}円/SKU)")


if __name__ == "__main__":
    main()

