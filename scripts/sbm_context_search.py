from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bhagavatam_rag.config import Settings
from bhagavatam_rag.service import BhagavatamQueryService


def emit(ok: bool, status: int, payload: dict) -> int:
    sys.stdout.write(
        json.dumps(
            {
                "ok": ok,
                "status": status,
                "payload": payload,
            },
            ensure_ascii=False,
        )
    )
    sys.stdout.flush()
    return 0


def read_json_stdin() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Query payload must be a JSON object.")
    return payload


def parse_bool(value: object, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise ValueError("use_llm must be a boolean.")


def parse_int(value: object, *, field_name: str, default: int, minimum: int, maximum: int) -> int:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer between {minimum} and {maximum}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be an integer between {minimum} and {maximum}.") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field_name} must be an integer between {minimum} and {maximum}.")
    return parsed


def parse_history(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("history must be an array of strings.")

    normalized = [str(item).strip() for item in value if str(item).strip()]
    if len(normalized) > 8:
        raise ValueError("history must contain at most 8 items.")
    return normalized


def build_service() -> BhagavatamQueryService:
    settings = Settings.from_env()
    has_chunk_data = settings.json_chunks_dir.exists() and any(settings.json_chunks_dir.glob("*.json"))
    has_remote_data = bool(settings.remote_verses_url)
    if not has_chunk_data and not has_remote_data and not settings.db_path.exists():
        raise RuntimeError(
            "Missing retrieval data. Configure BHAGAVATAM_REMOTE_VERSES_URL, add verse JSON chunks, or provide bhagavatam.db."
        )
    return BhagavatamQueryService(settings)


def handle_health() -> dict:
    service = build_service()
    return {
        "status": "ok",
        "verses_loaded": len(service.retriever.verses),
        "openai_enabled": service.answerer.enabled,
    }


def handle_query() -> dict:
    payload = read_json_stdin()
    query_text = str(payload.get("query", "")).strip()
    if not query_text:
        raise ValueError("query is required.")

    top_k = parse_int(payload.get("top_k"), field_name="top_k", default=8, minimum=1, maximum=20)
    neighbor_window = parse_int(
        payload.get("neighbor_window"),
        field_name="neighbor_window",
        default=1,
        minimum=0,
        maximum=3,
    )
    history = parse_history(payload.get("history"))
    use_llm = parse_bool(payload.get("use_llm"), default=True)

    service = build_service()
    return service.query(
        query_text=query_text,
        top_k=top_k,
        neighbor_window=neighbor_window,
        use_llm=use_llm,
        history=history,
    )


def main() -> int:
    if len(sys.argv) < 2:
        return emit(False, 400, {"error": "Missing action. Use health or query."})

    action = sys.argv[1].strip().lower()

    try:
        if action == "health":
            return emit(True, 200, handle_health())
        if action == "query":
            return emit(True, 200, handle_query())
        return emit(False, 400, {"error": f"Unsupported action: {action}"})
    except ValueError as exc:
        return emit(False, 400, {"error": str(exc)})
    except RuntimeError as exc:
        return emit(False, 500, {"error": str(exc)})
    except Exception as exc:  # pragma: no cover
        return emit(False, 500, {"error": f"Unexpected context search failure: {exc}"})


if __name__ == "__main__":
    raise SystemExit(main())
