from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict
from pathlib import Path

from .config import Settings
from .llm import BhagavatamAnswerer, QueryPlan
from .models import RetrievalHit, VerseRecord
from .retriever import BhagavatamRetriever


class EmbeddingCache:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._loaded = False
        self._entries: dict[str, dict] = {}

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(payload, dict):
            self._entries = payload

    def get(self, cache_key: str, fingerprint: str) -> list[float] | None:
        self._ensure_loaded()
        row = self._entries.get(cache_key)
        if not isinstance(row, dict):
            return None
        if row.get("fingerprint") != fingerprint:
            return None
        vector = row.get("vector")
        return vector if isinstance(vector, list) else None

    def set(self, cache_key: str, fingerprint: str, vector: list[float]) -> None:
        self._ensure_loaded()
        self._entries[cache_key] = {
            "fingerprint": fingerprint,
            "vector": vector,
        }

    def flush(self) -> None:
        self._ensure_loaded()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._entries), encoding="utf-8")


def cosine_similarity(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    left_magnitude = math.sqrt(sum(a * a for a in left))
    right_magnitude = math.sqrt(sum(b * b for b in right))
    if not left_magnitude or not right_magnitude:
        return 0.0
    return numerator / (left_magnitude * right_magnitude)


def normalize_by_max(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    max_value = max(values.values())
    if max_value <= 0:
        return {key: 0.0 for key in values}
    return {key: value / max_value for key, value in values.items()}


def build_candidate_excerpt(text: str, limit: int = 900) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3].rstrip()}..."


class BhagavatamQueryService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.retriever = BhagavatamRetriever(settings)
        self.answerer = BhagavatamAnswerer(
            api_key=settings.openai_api_key,
            model=settings.openai_model,
            base_url=settings.openai_base_url,
            embedding_model=settings.openai_embedding_model,
            site_url=settings.openrouter_site_url,
            app_name=settings.openrouter_app_name,
        )
        self.embedding_cache = EmbeddingCache(settings.cache_dir / "embeddings.json")

    def query(
        self,
        query_text: str,
        top_k: int = 8,
        neighbor_window: int = 1,
        use_llm: bool = True,
        history: list[str] | None = None,
    ) -> dict:
        recent_history = [item.strip() for item in (history or []) if item and item.strip()][-6:]
        query_plan = self.answerer.plan_query(query_text, recent_history)

        candidate_hits = self.retriever.retrieve(
            query_plan.standalone_query,
            top_k=max(top_k * 6, 24),
            lexical_queries=query_plan.lexical_queries,
        )

        semantic_scores = self._semantic_scores(query_plan, candidate_hits[:24])
        rerank_scores = self._rerank_scores(query_plan, recent_history, candidate_hits, semantic_scores)
        scored_hits = self._dedupe_hits(self._blend_scores(candidate_hits, semantic_scores, rerank_scores))[:top_k]

        context_groups = [
            self.retriever.expand_context_group(hit.matched_verse_uids, neighbor_window=neighbor_window)
            for hit in scored_hits
        ]

        answer_mode, answer_text = self.answerer.answer(
            query_text,
            context_groups,
            scored_hits,
            use_llm=use_llm,
            rewritten_query=query_plan.standalone_query,
        )

        return {
            "query": query_text,
            "rewritten_query": query_plan.standalone_query,
            "query_variants": query_plan.lexical_queries,
            "answer_mode": answer_mode,
            "answer": answer_text,
            "hit_count": len(scored_hits),
            "hits": [self._serialize_hit(hit) for hit in scored_hits],
            "context_groups": [self._serialize_context_group(group) for group in context_groups],
        }

    def _semantic_scores(self, query_plan: QueryPlan, hits: list[RetrievalHit]) -> dict[str, float]:
        if not hits or not self.answerer.embeddings_enabled:
            return {}

        chunk_vectors: dict[str, list[float]] = {}
        missing_texts: list[str] = []
        missing_keys: list[tuple[str, str]] = []

        for hit in hits:
            chunk = self.retriever.get_chunk(hit.matched_chunk_id)
            source_text = chunk.search_text
            fingerprint = hashlib.sha1(source_text.encode("utf-8")).hexdigest()
            cached = self.embedding_cache.get(hit.matched_chunk_id, fingerprint)
            if cached is not None:
                chunk_vectors[hit.matched_chunk_id] = cached
                continue
            missing_texts.append(source_text)
            missing_keys.append((hit.matched_chunk_id, fingerprint))

        try:
            query_and_missing = [query_plan.standalone_query, *missing_texts]
            embedded = self.answerer.embed_texts(query_and_missing)
        except Exception:
            embedded = None

        if not embedded:
            return {}

        query_vector = embedded[0]
        for (chunk_id, fingerprint), vector in zip(missing_keys, embedded[1:]):
            chunk_vectors[chunk_id] = vector
            self.embedding_cache.set(chunk_id, fingerprint, vector)

        if missing_keys:
            self.embedding_cache.flush()

        scores = {
            hit.matched_chunk_id: max(0.0, cosine_similarity(query_vector, chunk_vectors[hit.matched_chunk_id]))
            for hit in hits
            if hit.matched_chunk_id in chunk_vectors
        }
        return normalize_by_max(scores)

    def _rerank_scores(
        self,
        query_plan: QueryPlan,
        history: list[str],
        hits: list[RetrievalHit],
        semantic_scores: dict[str, float],
    ) -> dict[str, float]:
        if not hits or not self.answerer.enabled:
            return {}

        candidates = []
        for hit in self._blend_scores(hits, semantic_scores, {})[:10]:
            chunk = self.retriever.get_chunk(hit.matched_chunk_id)
            candidates.append(
                {
                    "id": hit.matched_chunk_id,
                    "type": hit.matched_chunk_type,
                    "reference": chunk.reference_label,
                    "chapter": chunk.chapter_title,
                    "excerpt": build_candidate_excerpt(chunk.search_text),
                }
            )
        return self.answerer.rerank_candidates(query_plan.standalone_query, history, candidates)

    def _blend_scores(
        self,
        hits: list[RetrievalHit],
        semantic_scores: dict[str, float],
        rerank_scores: dict[str, float],
    ) -> list[RetrievalHit]:
        lexical_scores = normalize_by_max({hit.matched_chunk_id: hit.score for hit in hits})
        reranked_hits: list[RetrievalHit] = []

        for hit in hits:
            lexical_score = lexical_scores.get(hit.matched_chunk_id, 0.0)
            semantic_score = semantic_scores.get(hit.matched_chunk_id, 0.0)
            rerank_score = rerank_scores.get(hit.matched_chunk_id, 0.0)

            weighted_components = [
                (lexical_score, 0.55),
                (semantic_score, 0.25 if semantic_scores else 0.0),
                (rerank_score, 0.20 if rerank_scores else 0.0),
            ]
            total_weight = sum(weight for _, weight in weighted_components if weight > 0)
            blended_score = (
                sum(component * weight for component, weight in weighted_components if weight > 0) / total_weight
                if total_weight
                else lexical_score
            )

            reranked_hits.append(
                RetrievalHit(
                    verse=hit.verse,
                    score=blended_score,
                    lexical_score=hit.lexical_score,
                    fuzzy_score=hit.fuzzy_score,
                    preview=hit.preview,
                    semantic_score=semantic_score,
                    rerank_score=rerank_score,
                    matched_chunk_id=hit.matched_chunk_id,
                    matched_chunk_type=hit.matched_chunk_type,
                    matched_verse_uids=hit.matched_verse_uids,
                )
            )

        reranked_hits.sort(key=lambda hit: (-hit.score, hit.verse.canto, hit.verse.chapter, hit.verse.verse))
        return reranked_hits

    def _dedupe_hits(self, hits: list[RetrievalHit]) -> list[RetrievalHit]:
        deduped: list[RetrievalHit] = []
        seen_anchor_uids: set[str] = set()
        for hit in hits:
            if hit.verse.uid in seen_anchor_uids:
                continue
            seen_anchor_uids.add(hit.verse.uid)
            deduped.append(hit)
        return deduped

    def _serialize_hit(self, hit: RetrievalHit) -> dict:
        verse = hit.verse
        return {
            "reference": verse.reference,
            "chapter_title": verse.chapter_title,
            "source_url": verse.source_url,
            "translation": verse.translation,
            "transliteration": verse.transliteration,
            "sanskrit": verse.sanskrit,
            "score": round(hit.score, 4),
            "lexical_score": round(hit.lexical_score, 4),
            "fuzzy_score": round(hit.fuzzy_score, 4),
            "semantic_score": round(hit.semantic_score, 4),
            "rerank_score": round(hit.rerank_score, 4),
            "matched_chunk_type": hit.matched_chunk_type,
        }

    def _serialize_context_group(self, group: list[VerseRecord]) -> list[dict]:
        return [asdict(verse) for verse in group]
