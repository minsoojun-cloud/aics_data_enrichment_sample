"""Poll batch jobs and ingest finished results. Usage: PYTHONPATH=. venv/bin/python scripts/refresh_batch.py"""
import json
from app.repository import store
from app import batch
store.load()
for j in batch.refresh():
    print(json.dumps({k: j.get(k) for k in ("job_id", "state", "sku_count", "input_tokens", "output_tokens", "cost_jpy", "ingested", "ingested_skus")}, ensure_ascii=False))
store._pool.shutdown(wait=True)
