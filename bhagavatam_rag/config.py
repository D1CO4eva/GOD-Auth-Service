from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS_DIR = PROJECT_ROOT / "Bhagavatam"
DEFAULT_CACHE_DIR = PROJECT_ROOT / "cache"
DEFAULT_DB_PATH = DEFAULT_CACHE_DIR / "bhagavatam.db"
DEFAULT_JSONL_PATH = DEFAULT_CACHE_DIR / "verses.jsonl"
DEFAULT_JSON_CHUNKS_DIR = PROJECT_ROOT / "sbm_context_search_data"
DEFAULT_REMOTE_VERSES_URL = "https://atlanta.godivinity.org/srimad-bhagavatham-search/data/verses.json"


@dataclass(frozen=True)
class Settings:
    corpus_dir: Path = DEFAULT_CORPUS_DIR
    cache_dir: Path = DEFAULT_CACHE_DIR
    db_path: Path = DEFAULT_DB_PATH
    jsonl_path: Path = DEFAULT_JSONL_PATH
    json_chunks_dir: Path = DEFAULT_JSON_CHUNKS_DIR
    remote_verses_url: str = DEFAULT_REMOTE_VERSES_URL
    openai_api_key: str | None = None
    openai_model: str = "gpt-5.5"
    openai_base_url: str | None = None
    openai_embedding_model: str | None = "text-embedding-3-small"
    openrouter_site_url: str | None = None
    openrouter_app_name: str | None = None
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:3000",
        "http://localhost:3000",
    )

    @classmethod
    def from_env(cls) -> "Settings":
        corpus_dir = Path(os.environ.get("BHAGAVATAM_CORPUS_DIR", DEFAULT_CORPUS_DIR))
        cache_dir = Path(os.environ.get("BHAGAVATAM_CACHE_DIR", DEFAULT_CACHE_DIR))
        db_path = Path(os.environ.get("BHAGAVATAM_DB_PATH", cache_dir / "bhagavatam.db"))
        jsonl_path = Path(os.environ.get("BHAGAVATAM_JSONL_PATH", cache_dir / "verses.jsonl"))
        json_chunks_dir = Path(
            os.environ.get("BHAGAVATAM_JSON_CHUNKS_DIR", DEFAULT_JSON_CHUNKS_DIR)
        )
        remote_verses_url = (
            os.environ.get("BHAGAVATAM_REMOTE_VERSES_URL", DEFAULT_REMOTE_VERSES_URL).strip()
        )
        openai_api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
        openai_base_url = (
            os.environ.get("BHAGAVATAM_OPENAI_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("OPENROUTER_BASE_URL")
        )
        openai_model = (
            os.environ.get("BHAGAVATAM_OPENAI_MODEL")
            or os.environ.get("OPENAI_MODEL")
            or os.environ.get("OPENROUTER_MODEL")
            or "gpt-5.5"
        )
        openai_embedding_model = os.environ.get("BHAGAVATAM_OPENAI_EMBEDDING_MODEL")
        if openai_embedding_model is not None:
            openai_embedding_model = openai_embedding_model.strip() or None
        elif openai_base_url and "openrouter.ai" in openai_base_url.lower():
            openai_embedding_model = None
        else:
            openai_embedding_model = "text-embedding-3-small"
        openrouter_site_url = os.environ.get("OPENROUTER_SITE_URL")
        openrouter_app_name = os.environ.get("OPENROUTER_APP_NAME")
        allowed_origins = tuple(
            origin.strip()
            for origin in os.environ.get(
                "BHAGAVATAM_ALLOWED_ORIGINS",
                "http://127.0.0.1:3000,http://localhost:3000",
            ).split(",")
            if origin.strip()
        )
        return cls(
            corpus_dir=corpus_dir,
            cache_dir=cache_dir,
            db_path=db_path,
            jsonl_path=jsonl_path,
            json_chunks_dir=json_chunks_dir,
            remote_verses_url=remote_verses_url,
            openai_api_key=openai_api_key,
            openai_model=openai_model,
            openai_base_url=openai_base_url,
            openai_embedding_model=openai_embedding_model,
            openrouter_site_url=openrouter_site_url,
            openrouter_app_name=openrouter_app_name,
            allowed_origins=allowed_origins,
        )
