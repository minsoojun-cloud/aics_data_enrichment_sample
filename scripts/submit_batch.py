"""Submit a Vertex AI Batch Prediction job for the PoC SKUs.
Usage: PYTHONPATH=. venv/bin/python scripts/submit_batch.py [--group fridge] [--limit 10]
"""
import argparse, json
from app.repository import store
from app import batch

ap = argparse.ArgumentParser()
ap.add_argument("--group"); ap.add_argument("--limit", type=int)
a = ap.parse_args()
store.load()
print(json.dumps(batch.submit(a.group, a.limit), ensure_ascii=False, indent=1))
store._pool.shutdown(wait=True)
