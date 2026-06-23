from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VerseRecord:
    uid: str
    reference: str
    canto: int
    chapter: int
    verse: int
    group_slug: str
    group_label: str
    chapter_title: str
    source_url: str
    sanskrit: str
    transliteration: str
    translation: str
    search_text: str
    normalized_text: str
    previous_uid: str | None
    next_uid: str | None


@dataclass
class RetrievalHit:
    verse: VerseRecord
    score: float
    lexical_score: float
    fuzzy_score: float
    preview: str
    semantic_score: float = 0.0
    rerank_score: float = 0.0
    matched_chunk_id: str = ""
    matched_chunk_type: str = "verse"
    matched_verse_uids: tuple[str, ...] = ()
