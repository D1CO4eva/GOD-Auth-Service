from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass

from .models import RetrievalHit, VerseRecord

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover
    OpenAI = None


FOLLOW_UP_HINTS = {
    "again",
    "another",
    "else",
    "he",
    "her",
    "him",
    "it",
    "same",
    "that",
    "there",
    "they",
    "this",
    "those",
    "where",
    "which",
}


@dataclass(frozen=True)
class QueryPlan:
    original_query: str
    standalone_query: str
    lexical_queries: list[str]
    intent: str
    entities: list[str]


def render_context_block(verses: list[VerseRecord]) -> str:
    blocks: list[str] = []
    for verse in verses:
        blocks.append(
            "\n".join(
                [
                    f"Reference: {verse.reference}",
                    f"Chapter: {verse.chapter_title}",
                    f"Sanskrit: {verse.sanskrit}",
                    f"Translation: {verse.translation}",
                    f"Transliteration: {verse.transliteration}",
                ]
            )
        )
    return "\n\n".join(blocks)


def build_fallback_answer(query: str, hits: list[RetrievalHit]) -> str:
    if not hits:
        return (
            f'I could not find a strong Bhagavatam match for "{query}" in the local corpus. '
            "Try a more specific person, event, or phrase."
        )

    lead = hits[0].verse
    references = ", ".join(hit.verse.reference for hit in hits[:3])
    return (
        f'The strongest local match for "{query}" is {lead.reference} in "{lead.chapter_title}". '
        f"Other nearby candidates are {references}. Review the retrieved passages to confirm the exact context."
    )


def sanitize_queries(queries: list[str], fallback_query: str, limit: int = 4) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for query in [fallback_query, *queries]:
        normalized = " ".join(query.split()).strip()
        if not normalized:
            continue
        lowered = normalized.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        cleaned.append(normalized)
        if len(cleaned) >= limit:
            break
    return cleaned or [fallback_query]


def looks_like_follow_up(query: str) -> bool:
    tokens = re.findall(r"[a-zA-Z]+", query.lower())
    if not tokens:
        return False
    if len(tokens) <= 4:
        return True
    return any(token in FOLLOW_UP_HINTS for token in tokens[:4])


def extract_json_object(text: str) -> dict | None:
    text = text.strip()
    if not text:
        return None

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None

    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


@dataclass
class BhagavatamAnswerer:
    api_key: str | None
    model: str
    embedding_model: str | None
    base_url: str | None = None
    site_url: str | None = None
    app_name: str | None = None

    def __post_init__(self) -> None:
        self.client = None
        self.default_headers: dict[str, str] = {}
        if self.base_url and "openrouter.ai" in self.base_url.lower():
            if self.site_url:
                self.default_headers["HTTP-Referer"] = self.site_url
            if self.app_name:
                self.default_headers["X-Title"] = self.app_name

        if not self.api_key or OpenAI is None:
            return

        client_kwargs: dict[str, object] = {"api_key": self.api_key}
        if self.base_url:
            client_kwargs["base_url"] = self.base_url

        if self.default_headers:
            client_kwargs["default_headers"] = self.default_headers

        self.client = OpenAI(**client_kwargs)

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and (self.client is not None or self._chat_endpoint_url() is not None))

    @property
    def embeddings_enabled(self) -> bool:
        return self.enabled and bool(self.embedding_model)

    def _chat_completion(self, system_prompt: str, user_prompt: str, *, temperature: float = 0.1) -> str:
        if self.client:
            response = self.client.chat.completions.create(
                model=self.model,
                temperature=temperature,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            message = response.choices[0].message.content if response.choices else None
            return message.strip() if isinstance(message, str) else ""

        endpoint = self._chat_endpoint_url()
        if not endpoint or not self.api_key:
            raise RuntimeError("LLM client is not configured.")

        request_body = json.dumps(
            {
                "model": self.model,
                "temperature": temperature,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
        ).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.default_headers,
        }
        request = urllib.request.Request(endpoint, data=request_body, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
        choices = payload.get("choices", [])
        if not choices:
            return ""
        message = choices[0].get("message", {})
        content = message.get("content")
        return content.strip() if isinstance(content, str) else ""

    def plan_query(self, query: str, history: list[str] | None = None) -> QueryPlan:
        recent_history = [entry.strip() for entry in (history or []) if entry.strip()][-4:]
        fallback = self._fallback_query_plan(query, recent_history)
        if not self.enabled:
            return fallback

        try:
            output = self._chat_completion(
                system_prompt=(
                    "You rewrite Bhagavatam search questions into strong standalone retrieval queries. "
                    "Return JSON only with keys: standalone_query, lexical_queries, intent, entities. "
                    "lexical_queries must be an array of up to 4 short, high-recall search formulations. "
                    "intent must be one of: verse_lookup, event_lookup, teaching_lookup, summary_lookup, follow_up."
                ),
                user_prompt=(
                    "Recent user search history:\n"
                    f"{json.dumps(recent_history, ensure_ascii=False)}\n\n"
                    f"Current query:\n{query}\n\n"
                    "Resolve references like 'that', 'there', 'he', or 'else' using the recent history when possible."
                ),
            )
            payload = extract_json_object(output)
        except Exception:
            payload = None

        if not payload:
            return fallback

        standalone_query = str(payload.get("standalone_query") or fallback.standalone_query).strip()
        lexical_queries = [
            str(item).strip()
            for item in payload.get("lexical_queries", [])
            if isinstance(item, str) and item.strip()
        ]
        intent = str(payload.get("intent") or fallback.intent).strip() or fallback.intent
        entities = [
            str(item).strip()
            for item in payload.get("entities", [])
            if isinstance(item, str) and item.strip()
        ]

        return QueryPlan(
            original_query=query,
            standalone_query=standalone_query or fallback.standalone_query,
            lexical_queries=sanitize_queries(lexical_queries, standalone_query or fallback.standalone_query),
            intent=intent,
            entities=entities or fallback.entities,
        )

    def rerank_candidates(
        self,
        query: str,
        history: list[str] | None,
        candidates: list[dict[str, str]],
    ) -> dict[str, float]:
        if not self.enabled or not candidates:
            return {}

        payload_lines: list[str] = []
        for candidate in candidates:
            payload_lines.append(
                "\n".join(
                    [
                        f"ID: {candidate['id']}",
                        f"Type: {candidate['type']}",
                        f"Reference span: {candidate['reference']}",
                        f"Chapter: {candidate['chapter']}",
                        f"Excerpt: {candidate['excerpt']}",
                    ]
                )
            )

        try:
            output = self._chat_completion(
                system_prompt=(
                    "You rerank Bhagavatam retrieval candidates. "
                    "Return JSON only in the form {\"ranked\":[{\"id\":\"...\",\"score\":0.0}]} "
                    "where score is between 0 and 1. Prefer the exact occurrence or teaching passage, not generic summaries."
                ),
                user_prompt=(
                    "Recent user search history:\n"
                    f"{json.dumps((history or [])[-4:], ensure_ascii=False)}\n\n"
                    f"Current question:\n{query}\n\n"
                    "Candidates:\n"
                    + "\n\n---\n\n".join(payload_lines)
                ),
            )
            payload = extract_json_object(output) or {}
        except Exception:
            return {}

        ranked = payload.get("ranked", [])
        scores: dict[str, float] = {}
        if not isinstance(ranked, list):
            return scores

        for row in ranked:
            if not isinstance(row, dict):
                continue
            identifier = str(row.get("id") or "").strip()
            score_value = row.get("score")
            if not identifier:
                continue
            try:
                numeric_score = float(score_value)
            except (TypeError, ValueError):
                continue
            scores[identifier] = max(0.0, min(1.0, numeric_score))
        return scores

    def embed_texts(self, texts: list[str]) -> list[list[float]] | None:
        if not self.embeddings_enabled or not texts or not self.client or not self.embedding_model:
            return None

        response = self.client.embeddings.create(
            model=self.embedding_model,
            input=texts,
        )
        return [list(item.embedding) for item in response.data]

    def _chat_endpoint_url(self) -> str | None:
        if not self.api_key:
            return None
        base_url = (self.base_url or "https://api.openai.com/v1").rstrip("/")
        return f"{base_url}/chat/completions"

    def answer(
        self,
        query: str,
        context_groups: list[list[VerseRecord]],
        hits: list[RetrievalHit],
        *,
        use_llm: bool = True,
        rewritten_query: str | None = None,
    ) -> tuple[str, str]:
        if not use_llm or not self.enabled:
            return "retrieval_only", build_fallback_answer(query, hits)

        context_text = "\n\n---\n\n".join(render_context_block(group) for group in context_groups)
        output = self._chat_completion(
            system_prompt=(
                "You answer questions about the Srimad Bhagavatam using only the supplied passages. "
                "Be concise, cite references like SB 10.15.10, and clearly say when the retrieved context is inconclusive. "
                "Prefer the exact occurrence passage over a chapter summary."
            ),
            user_prompt=(
                f"Original user question:\n{query}\n\n"
                f"Search interpretation:\n{rewritten_query or query}\n\n"
                f"Retrieved Bhagavatam passages:\n{context_text}\n\n"
                "Answer using only those passages."
            ),
            temperature=0.2,
        )
        return "chat_completion", output

    def _fallback_query_plan(self, query: str, history: list[str]) -> QueryPlan:
        standalone = query.strip()
        if history and looks_like_follow_up(query):
            standalone = f"{history[-1]} {query}".strip()

        intent = "teaching_lookup"
        lowered = query.lower()
        if any(token in lowered for token in ("where", "happen", "happens", "happened", "appearance", "appear", "pastime")):
            intent = "event_lookup"
        elif any(token in lowered for token in ("which verse", "what verse", "sloka", "shloka", "text")):
            intent = "verse_lookup"
        elif any(token in lowered for token in ("summary", "summarize", "overview")):
            intent = "summary_lookup"
        elif history and looks_like_follow_up(query):
            intent = "follow_up"

        entities = re.findall(r"[A-Za-z][A-Za-z'-]{2,}", standalone)
        lexical_queries = [standalone]
        if history and looks_like_follow_up(query):
            lexical_queries.append(query.strip())

        return QueryPlan(
            original_query=query,
            standalone_query=standalone,
            lexical_queries=sanitize_queries(lexical_queries, standalone),
            intent=intent,
            entities=list(dict.fromkeys(entities))[:8],
        )
