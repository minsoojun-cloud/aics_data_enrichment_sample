"""Application settings (env-overridable)."""
import os
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    project_id: str = ""
    bq_dataset: str = "product_enrichment"
    bq_source_dataset: str = "ai_commerce_search_dataset"
    bq_source_table_name: str = "products_aics"
    bq_source_table: str = ""
    bq_location: str = "US"

    # Online (live) enrichment
    gemini_model: str = "gemini-3.8-flash"
    vertex_location: str = "global"
    # Gemini 3.x thinking level (MINIMAL/LOW/MEDIUM/HIGH, "" = model default).
    # Extraction is not reasoning-heavy: LOW keeps accuracy while cutting thought tokens.
    thinking_level: str = "LOW"

    # Batch prediction
    batch_model: str = "gemini-3.8-flash"
    batch_location: str = "global"

    # Governance
    auto_approve_threshold: float = 0.90

    # Cost model (JPY) – Batch = 50% of online list price.
    # Slide 7 reference value: 0.061 JPY / SKU.
    usd_jpy: float = 150.0
    price_input_per_mtok_usd: float = 0.30
    price_output_per_mtok_usd: float = 2.50
    batch_discount: float = 0.5
    slide_cost_per_sku_jpy: float = 0.061

    # Use in-memory demo data (no GCP) – for tests / offline dev
    offline: bool = False

    # ── Seasonal image generation (Gemini image models on Vertex AI, global) ──
    image_model: str = "gemini-3.1-flash-image"      # Nano Banana 2 (fast, default)
    image_model_pro: str = "gemini-3-pro-image"      # Nano Banana Pro (high quality / text rendering)
    image_bucket: str = ""
    docs_prefix: str = "_docs_uploads"               # document uploads live in the same bucket under this prefix
    image_default_size: int = 300                    # output px (square => size x size); 0 = model output as-is
    image_fidelity_threshold: float = 0.7
    # Public base URL used for image URIs written to the AICS catalog (products_aics.images[].uri)
    public_base_url: str = ""
    # Update the original AICS catalog table (bq_source_table) on image save / document apply
    update_aics: bool = True

    @model_validator(mode="after")
    def _derive_defaults(self) -> "Settings":
        if not self.project_id:
            self.project_id = os.environ.get("GOOGLE_CLOUD_PROJECT") or "your-gcp-project-id"
        if not self.bq_source_table:
            self.bq_source_table = f"{self.project_id}.{self.bq_source_dataset}.{self.bq_source_table_name}"
        if not self.image_bucket:
            self.image_bucket = f"products_images_{self.project_id}"
        return self

    @property
    def dataset_ref(self) -> str:
        return f"{self.project_id}.{self.bq_dataset}"


settings = Settings()
