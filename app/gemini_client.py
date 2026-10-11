"""Online Gemini calls (live enrichment) via google-genai on Vertex AI."""
from __future__ import annotations

import asyncio
import os
import time

from google import genai
from google.genai import types

from .config import settings
from .pipeline import parse_json_text
from .prompts import gmc_prompt, stage1_prompt, stage3_prompt
from .schema import gmc_schema, stage1_schema, stage3_schema

# Cloudtop's enterprise-cert proxy breaks mTLS for some endpoints; plain TLS is fine.
os.environ.setdefault("GOOGLE_API_USE_CLIENT_CERTIFICATE", "false")

_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(vertexai=True, project=settings.project_id, location=settings.vertex_location)
    return _client


async def _call(prompt: str, schema: dict) -> dict:
    t0 = time.time()
    resp = await client().aio.models.generate_content(
        model=settings.gemini_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            response_schema=schema,
            thinking_config=(types.ThinkingConfig(thinking_level=settings.thinking_level)
                             if settings.thinking_level else None),
        ),
    )
    cand = resp.candidates[0] if resp.candidates else None
    usage = resp.usage_metadata
    return {
        "data": parse_json_text(resp.text),
        "raw_text": resp.text,
        "avg_logprobs": getattr(cand, "avg_logprobs", None) if cand else None,
        "input_tokens": getattr(usage, "prompt_token_count", 0) or 0,
        "output_tokens": (getattr(usage, "candidates_token_count", 0) or 0) + (getattr(usage, "thoughts_token_count", 0) or 0),
        "latency_ms": int((time.time() - t0) * 1000),
    }


async def run_stage1(p: dict) -> dict:
    return await _call(stage1_prompt(p, p["group"]), stage1_schema(p["group"]))


async def run_stage3(p: dict) -> dict:
    return await _call(stage3_prompt(p, p["group"]), stage3_schema(p["group"]))


async def run_gmc(p: dict) -> dict:
    return await _call(gmc_prompt(p, p["group"]), gmc_schema())


def run_sync(p: dict) -> tuple[dict, dict]:
    async def both():
        return await asyncio.gather(run_stage1(p), run_stage3(p))
    return tuple(asyncio.run(both()))  # type: ignore[return-value]

