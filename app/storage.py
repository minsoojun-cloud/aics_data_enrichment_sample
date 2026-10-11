"""Thin GCS wrapper (products_images_… bucket). Offline mode stores objects in a local temp dir."""
from __future__ import annotations

import mimetypes
import os
import tempfile
from pathlib import Path

from .config import settings

os.environ.setdefault("GOOGLE_API_USE_CLIENT_CERTIFICATE", "false")

_client = None
_LOCAL = Path(os.environ.get("LOCAL_GCS_DIR") or Path(tempfile.gettempdir()) / "aics_local_gcs")


def client():
    global _client
    if _client is None:
        from google.cloud import storage
        _client = storage.Client(project=settings.project_id)
    return _client


def split_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise ValueError(f"GCS URI ではありません: {uri}")
    rest = uri[5:]
    bucket, _, path = rest.partition("/")
    if not bucket:
        raise ValueError(f"不正な GCS URI: {uri}")
    return bucket, path


def guess_mime(name: str) -> str:
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    return {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
            "pdf": "application/pdf", "csv": "text/csv",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}.get(
        ext, mimetypes.guess_type(name)[0] or "application/octet-stream")


def upload_bytes(path: str, data: bytes, content_type: str, metadata: dict | None = None,
                 bucket: str | None = None) -> str:
    bucket = bucket or settings.image_bucket
    if settings.offline:
        f = _LOCAL / bucket / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        return f"gs://{bucket}/{path}"
    blob = client().bucket(bucket).blob(path)
    if metadata:
        blob.metadata = {k: str(v)[:1000] for k, v in metadata.items() if v is not None}
    blob.cache_control = "public, max-age=86400"
    blob.upload_from_string(data, content_type=content_type)
    return f"gs://{bucket}/{path}"


def download(uri: str) -> tuple[bytes, str]:
    bucket, path = split_uri(uri)
    if settings.offline:
        f = _LOCAL / bucket / path
        if not f.exists():
            raise FileNotFoundError(uri)
        return f.read_bytes(), guess_mime(path)
    blob = client().bucket(bucket).blob(path)
    data = blob.download_as_bytes()
    return data, blob.content_type or guess_mime(path)


def delete(uri: str) -> bool:
    bucket, path = split_uri(uri)
    if settings.offline:
        f = _LOCAL / bucket / path
        if f.exists():
            f.unlink()
            return True
        return False
    try:
        client().bucket(bucket).blob(path).delete()
        return True
    except Exception:  # NotFound etc.
        return False


def list_prefix(uri: str, limit: int = 200) -> list[dict]:
    bucket, path = split_uri(uri)
    out = []
    if settings.offline:
        base = _LOCAL / bucket
        for f in sorted(base.rglob("*")):
            rel = str(f.relative_to(base))
            if f.is_file() and rel.startswith(path):
                out.append({"uri": f"gs://{bucket}/{rel}", "name": f.name, "size": f.stat().st_size,
                            "mime": guess_mime(f.name)})
        return out[:limit]
    for b in client().list_blobs(bucket, prefix=path, max_results=limit):
        if b.name.endswith("/"):
            continue
        out.append({"uri": f"gs://{bucket}/{b.name}", "name": b.name.rsplit("/", 1)[-1], "size": b.size or 0,
                    "mime": b.content_type or guess_mime(b.name)})
    return out


def stat(uri: str) -> dict | None:
    bucket, path = split_uri(uri)
    if settings.offline:
        f = _LOCAL / bucket / path
        return {"uri": uri, "name": f.name, "size": f.stat().st_size, "mime": guess_mime(f.name)} if f.exists() else None
    b = client().bucket(bucket).get_blob(path)
    if b is None:
        return None
    return {"uri": uri, "name": path.rsplit("/", 1)[-1], "size": b.size or 0, "mime": b.content_type or guess_mime(path)}


def proxy_url(uri: str) -> str:
    """Browser URL for an object in the image bucket (served by GET /api/img/{path})."""
    bucket, path = split_uri(uri)
    if bucket != settings.image_bucket:
        return ""
    return f"/api/img/{path}"


def public_url(uri: str) -> str:
    u = proxy_url(uri)
    return f"{settings.public_base_url.rstrip('/')}{u}" if u else uri
