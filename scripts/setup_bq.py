"""Create BigQuery tables and sample the PoC SKU set (4 groups x 25 SKU).

Usage:  PYTHONPATH=. venv/bin/python scripts/setup_bq.py [--per-group 25]
"""
from __future__ import annotations

import argparse
import os

os.environ.setdefault("GOOGLE_API_USE_CLIENT_CERTIFICATE", "false")

from google.cloud import bigquery  # noqa: E402

from app.config import settings  # noqa: E402

DS = settings.dataset_ref

DDL = f"""
CREATE TABLE IF NOT EXISTS `{DS}.enriched_attributes` (
  sku STRING, kind STRING, attr_key STRING, label STRING, raw_value STRING, value_json STRING, unit STRING,
  norm_note STRING, evidence STRING, source_field STRING, self_conf FLOAT64, evidence_match FLOAT64,
  token_conf FLOAT64, score FLOAT64, gate_status STRING, gate STRING, reason STRING, job_id STRING,
  model STRING, created_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `{DS}.sku_extras` (
  sku STRING, job_id STRING, search_keywords ARRAY<STRING>, ai_summary STRING, created_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `{DS}.review_log` (
  sku STRING, attr_key STRING, action STRING, before_value STRING, after_value STRING, comment STRING,
  reviewer STRING, reviewed_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `{DS}.golden_records` (
  sku STRING, title STRING, category_group STRING, attributes_json STRING, feature_tags ARRAY<STRING>,
  search_keywords ARRAY<STRING>, ai_summary STRING, fill_rate_before FLOAT64, fill_rate_after FLOAT64,
  updated_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `{DS}.batch_jobs` (
  job_id STRING, display_name STRING, model STRING, state STRING, sku_count INT64, request_count INT64,
  input_tokens INT64, output_tokens INT64, cost_jpy FLOAT64, src STRING, dest STRING,
  created_at TIMESTAMP, updated_at TIMESTAMP, ingested BOOL, ingested_skus INT64);
CREATE TABLE IF NOT EXISTS `{DS}.gmc_conversational` (
  sku STRING, item_group_id STRING, item_group_title STRING,
  variant_option STRING, variant_options_json STRING,
  question_and_answer STRING, qa_json STRING,
  product_highlight STRING, highlights_json STRING,
  product_detail STRING, details_json STRING,
  related_product STRING, related_json STRING,
  popularity_rank FLOAT64, document_link STRING,
  model STRING, job_id STRING, updated_at TIMESTAMP);
"""

# Seasonal image studio + document extraction (idempotent migration; never drops data).
MIGRATION = f"""
CREATE TABLE IF NOT EXISTS `{DS}.product_images` (
  image_id STRING, sku STRING, gcs_uri STRING, url STRING, kind STRING, status STRING, is_primary BOOL,
  preset STRING, preset_label STRING, season STRING, prompt STRING, extra_prompt STRING,
  base_image_uri STRING, base_kind STRING, source_url STRING, model STRING, width INT64, height INT64,
  aspect STRING, fidelity_score FLOAT64, fidelity_note STRING, created_at TIMESTAMP, updated_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `{DS}.doc_extractions` (
  job_id STRING, file_uri STRING, file_name STRING, document_type STRING, product_index INT64,
  applied_sku STRING, is_new BOOL, merge_mode STRING, changes INT64, extracted_json STRING, diff_json STRING,
  model STRING, created_at TIMESTAMP);
ALTER TABLE `{DS}.source_products` ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
ALTER TABLE `{DS}.source_products` ADD COLUMN IF NOT EXISTS source STRING;
ALTER TABLE `{DS}.source_products` ADD COLUMN IF NOT EXISTS doc_sources_json STRING;
"""


def sample_sql(per_group: int) -> str:
    return f"""
CREATE OR REPLACE TABLE `{DS}.source_products` AS
WITH base AS (
  SELECT
    id AS sku, title, brands[SAFE_OFFSET(0)] AS brand, categories[SAFE_OFFSET(0)] AS category,
    description, uri AS product_url, images[SAFE_OFFSET(0)].uri AS image_url,
    priceInfo.price AS price,
    TO_JSON_STRING(ARRAY(
      SELECT AS STRUCT a.key AS k, ARRAY_TO_STRING(a.value.text, ' / ') AS v
      FROM UNNEST(attributes) a
      WHERE a.key NOT IN ('jan_code') AND ARRAY_LENGTH(a.value.text) > 0)) AS raw_attributes_json,
    CASE
      WHEN categories[SAFE_OFFSET(0)] LIKE '%エアコン%' THEN 'aircon'
      WHEN categories[SAFE_OFFSET(0)] LIKE '%冷蔵庫%' THEN 'fridge'
      WHEN categories[SAFE_OFFSET(0)] LIKE '%ハンディファン%' THEN 'handy'
      ELSE 'fan' END AS category_group,
    ARRAY_LENGTH(attributes) AS attr_count,
    CAST(NULL AS TIMESTAMP) AS updated_at, 'aics' AS source, '[]' AS doc_sources_json
  FROM `{settings.bq_source_table}`
  WHERE LENGTH(IFNULL(description, '')) >= 120
    AND NOT REGEXP_CONTAINS(title, r'(用|フィルター|交換|部品|パーツ|カバー|シート|ホース|パイプ|リモコン|延長|据付)')
    AND IFNULL(priceInfo.price, 0) >= 1500
)
SELECT * EXCEPT(rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY category_group ORDER BY FARM_FINGERPRINT(sku)) AS rn FROM base
) WHERE rn <= {per_group}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-group", type=int, default=25)
    ap.add_argument("--migrate-only", action="store_true",
                    help="only create new tables / add columns (keeps source_products data)")
    args = ap.parse_args()
    bq = bigquery.Client(project=settings.project_id, location=settings.bq_location)
    bq.query(DDL).result()
    if args.migrate_only:
        bq.query(MIGRATION).result()
        print("migration done")
        return
    bq.query(sample_sql(args.per_group)).result()
    bq.query(MIGRATION).result()
    rows = bq.query(f"SELECT category_group, COUNT(*) n, ROUND(AVG(attr_count),1) a FROM `{DS}.source_products` GROUP BY 1 ORDER BY 1").result()
    for r in rows:
        print(dict(r))


if __name__ == "__main__":
    main()
