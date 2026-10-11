#!/bin/bash
# Deploy Product Data Enrichment Studio to Cloud Run
set -e

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${PROJECT_ID:?Set PROJECT_ID in environment or .env before deploying}"
REGION="${REGION:-asia-northeast1}"
SERVICE_NAME="${SERVICE_NAME:-aics-data-enrichment}"
BQ_DATASET="${BQ_DATASET:-product_enrichment}"
BQ_SOURCE_TABLE_NAME="${BQ_SOURCE_TABLE_NAME:-products_aics}"
BQ_SOURCE_TABLE="${BQ_SOURCE_TABLE:-${PROJECT_ID}.ai_commerce_search_dataset.${BQ_SOURCE_TABLE_NAME}}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
IMAGE_BUCKET="${IMAGE_BUCKET:-products_images_${PROJECT_ID}}"
IMAGE_MODEL="${IMAGE_MODEL:-gemini-3.1-flash-image}"
IMAGE_MODEL_PRO="${IMAGE_MODEL_PRO:-gemini-3-pro-image}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

echo "🚀 Deploying ${SERVICE_NAME} to ${PROJECT_ID}/${REGION} (model: ${GEMINI_MODEL})"
# max-instances=1: the demo keeps an in-memory cache (persisted to BigQuery), so a single instance keeps state consistent.
$GCLOUD_BIN run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --no-invoker-iam-check \
  --min-instances 0 --max-instances 1 \
  --memory 2Gi --cpu 2 --timeout 900 \
  --set-env-vars "PROJECT_ID=${PROJECT_ID},BQ_DATASET=${BQ_DATASET},BQ_SOURCE_TABLE=${BQ_SOURCE_TABLE},GEMINI_MODEL=${GEMINI_MODEL},VERTEX_LOCATION=global,BATCH_MODEL=${GEMINI_MODEL},BATCH_LOCATION=global,IMAGE_BUCKET=${IMAGE_BUCKET},IMAGE_MODEL=${IMAGE_MODEL},IMAGE_MODEL_PRO=${IMAGE_MODEL_PRO},PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
echo "✅ Done: $($GCLOUD_BIN run services describe ${SERVICE_NAME} --project ${PROJECT_ID} --region ${REGION} --format='value(status.url)')"
