from __future__ import annotations

import json
import math
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from urllib.request import urlopen

from .config import Settings
from .indexer import normalize_for_search
from .models import RetrievalHit, VerseRecord


STOPWORDS = {
    "a",
    "an",
    "and",
    "about",
    "at",
    "by",
    "does",
    "do",
    "for",
    "from",
    "happen",
    "happens",
    "how",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "text",
    "texts",
    "verse",
    "verses",
    "what",
    "where",
    "which",
    "who",
    "why",
}

LOW_SIGNAL_TOKENS = {
    "avatar",
    "avatara",
    "bhagavatam",
    "bhagavatham",
    "canto",
    "chapter",
    "incarnation",
    "incarnations",
    "quote",
    "quoted",
    "sanskrit",
    "sloka",
    "slokam",
    "summary",
    "text",
    "texts",
    "transliteration",
    "translation",
    "verse",
    "verses",
}

EVENT_QUERY_HINTS = {
    "appear",
    "appearance",
    "appeared",
    "avatar",
    "avatara",
    "birth",
    "born",
    "episode",
    "happen",
    "happened",
    "happening",
    "occurs",
    "pastime",
    "place",
    "story",
    "takes",
    "where",
}

QUERY_SYNONYMS = {
    "bird": {"birds", "cuckoo", "swans", "swan", "parrot"},
    "birds": {"bird", "cuckoo", "swans", "swan", "parrot"},
    "devotee": {"devotees", "bhakta", "bhaktas"},
    "devotees": {"devotee", "bhakta", "bhaktas"},
    "hear": {"hearing", "sravana", "sravanam"},
    "hearing": {"hear", "sravana", "sravanam"},
    "krsna": {"krishna"},
    "krishna": {"krsna"},
    "narasimha": {"nrsimha", "nrsimhadeva", "narahari", "prahlada", "hiranyakasipu", "pillar"},
    "nrsimha": {"narasimha", "nrsimhadeva", "narahari", "prahlada", "hiranyakasipu", "pillar"},
    "putana": {"putana", "poison", "demoness", "breast"},
    "varaha": {"boar", "earth", "nostril", "tusk"},
}

TOKEN_EQUIVALENTS = {
    "bhagavatham": "bhagavatam",
    "krsna": "krishna",
    "narasimha": "nrsimha",
    "narsimha": "nrsimha",
    "nrisimha": "nrsimha",
    "nrsimhadeva": "nrsimha",
    "shloka": "sloka",
    "slokam": "sloka",
}


@dataclass(frozen=True)
class QueryFeatures:
    raw_tokens: list[str]
    query_tokens: list[str]
    phrase_tokens: list[str]
    proximity_tokens: list[str]
    entity_tokens: list[str]
    title_tokens: list[str]
    is_event_query: bool
    is_verse_query: bool


@dataclass(frozen=True)
class ChunkRecord:
    uid: str
    chunk_type: str
    anchor_uid: str
    verse_uids: tuple[str, ...]
    reference_label: str
    chapter_title: str
    search_text: str
    normalized_text: str
    title_tokens: tuple[str, ...]
    token_set: frozenset[str]
    content_token_set: frozenset[str]


def normalize_token(token: str) -> str:
    if token.isdigit():
        return token
    if len(token) > 5 and token.endswith("ing"):
        token = token[:-3]
    elif len(token) > 4 and token.endswith("ies"):
        token = token[:-3] + "y"
    elif len(token) > 4 and token.endswith("es"):
        token = token[:-2]
    elif len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        token = token[:-1]
    return TOKEN_EQUIVALENTS.get(token, token)


def is_meaningful_token(token: str) -> bool:
    return token.isdigit() or len(token) > 1


def tokenize(text: str, *, expand_synonyms: bool = False) -> list[str]:
    base_tokens = [normalize_token(token) for token in normalize_for_search(text).split() if token]
    filtered = [token for token in base_tokens if is_meaningful_token(token) and token not in STOPWORDS]
    if not expand_synonyms:
        return filtered

    expanded = set(filtered)
    for token in filtered:
        expanded.update(QUERY_SYNONYMS.get(token, set()))
    return list(expanded)


def build_query_features(query: str) -> QueryFeatures:
    raw_tokens = [normalize_token(token) for token in normalize_for_search(query).split() if token]
    filtered = [token for token in raw_tokens if is_meaningful_token(token) and token not in STOPWORDS]
    expanded = tokenize(query, expand_synonyms=True)
    entity_tokens = [token for token in filtered if token not in LOW_SIGNAL_TOKENS and len(token) > 2]
    phrase_tokens = [token for token in filtered if token not in LOW_SIGNAL_TOKENS]
    title_tokens = list(dict.fromkeys(entity_tokens + [token for token in expanded if token not in LOW_SIGNAL_TOKENS]))

    relational_expansions: set[str] = set()
    hearing_terms = {"hear", "hearing", "sravana", "sravanam"}
    devotee_terms = {"devotee", "devotees", "bhakta", "bhaktas"}
    if hearing_terms.intersection(filtered) and devotee_terms.intersection(filtered):
        relational_expansions.update({"association", "glory", "glories", "message", "messages", "pure", "service"})

    query_tokens = list(dict.fromkeys(expanded + sorted(relational_expansions)))
    proximity_tokens = list(dict.fromkeys(filtered + sorted(relational_expansions)))
    return QueryFeatures(
        raw_tokens=raw_tokens,
        query_tokens=query_tokens,
        phrase_tokens=phrase_tokens,
        proximity_tokens=proximity_tokens,
        entity_tokens=entity_tokens,
        title_tokens=title_tokens,
        is_event_query=any(token in EVENT_QUERY_HINTS for token in raw_tokens) and bool(entity_tokens),
        is_verse_query=any(token in {"sloka", "verse", "text", "transliteration", "sanskrit"} for token in raw_tokens),
    )


def count_tokens(tokens: list[str]) -> Counter[str]:
    return Counter(tokens)


def token_coverage_score(tokens: list[str], token_set: frozenset[str]) -> float:
    unique = list(dict.fromkeys(token for token in tokens if token))
    if not unique:
        return 0.0
    overlap = sum(1 for token in unique if token in token_set)
    return overlap / len(unique)


def proximity_score(query_tokens: list[str], verse_tokens: list[str]) -> float:
    unique_tokens = [token for token in dict.fromkeys(query_tokens) if token]
    if len(unique_tokens) < 2 or not verse_tokens:
        return 0.0

    positions: dict[str, list[int]] = defaultdict(list)
    for index, token in enumerate(verse_tokens):
        positions[token].append(index)

    matched = [token for token in unique_tokens if token in positions]
    if len(matched) < 2:
        return 0.0

    best_span: int | None = None
    for left_index, left_token in enumerate(matched):
        for right_token in matched[left_index + 1 :]:
            for left_position in positions[left_token]:
                for right_position in positions[right_token]:
                    span = abs(left_position - right_position)
                    if best_span is None or span < best_span:
                        best_span = span

    if best_span is None:
        return 0.0

    coverage = len(matched) / len(unique_tokens)
    return coverage * (1 / (1 + best_span)) * 2.0


def longest_contiguous_token_run(query_tokens: list[str], field_tokens: list[str]) -> int:
    if not query_tokens or not field_tokens:
        return 0

    best_run = 0
    for field_index in range(len(field_tokens)):
        run = 0
        while (
            field_index + run < len(field_tokens)
            and run < len(query_tokens)
            and field_tokens[field_index + run] == query_tokens[run]
        ):
            run += 1
        best_run = max(best_run, run)
    return best_run


def phrase_match_score(query_tokens: list[str], normalized_field: str, field_tokens: list[str]) -> float:
    unique_tokens = [token for token in dict.fromkeys(query_tokens) if token not in LOW_SIGNAL_TOKENS]
    if not unique_tokens:
        return 0.0

    phrase = " ".join(unique_tokens)
    if len(phrase) >= 5 and phrase in normalized_field:
        return 1.5 + min(0.4, len(unique_tokens) * 0.08)

    field_token_set = set(field_tokens)
    overlap_count = sum(1 for token in unique_tokens if token in field_token_set)
    if not overlap_count:
        return 0.0

    ordered_ratio = longest_contiguous_token_run(unique_tokens, field_tokens) / max(len(unique_tokens), 1)
    overlap_ratio = overlap_count / max(len(unique_tokens), 1)
    return ordered_ratio * 0.9 + overlap_ratio * 0.45


def reference_span(verses: list[VerseRecord]) -> str:
    if not verses:
        return ""
    if len(verses) == 1:
        return verses[0].reference
    return f"{verses[0].reference} - {verses[-1].reference}"


class BhagavatamRetriever:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.db_path = settings.db_path
        self.verses = self._load_verses()
        self.verse_by_uid = {verse.uid: verse for verse in self.verses}
        self.chunks = self._build_chunks()
        self.chunk_by_uid = {chunk.uid: chunk for chunk in self.chunks}
        self.doc_lengths: dict[str, int] = {}
        self.doc_terms: dict[str, Counter[str]] = {}
        self.postings: dict[str, set[str]] = defaultdict(set)
        self.document_count = len(self.chunks)
        self.average_doc_length = 0.0
        self._build_term_stats()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _load_verses(self) -> list[VerseRecord]:
        chunk_dir = self.settings.json_chunks_dir
        if chunk_dir.exists():
            chunk_paths = sorted(chunk_dir.glob("*.json"))
            if chunk_paths:
                return self._load_verses_from_chunks(chunk_paths)

        if self.settings.remote_verses_url:
            return self._load_verses_from_remote(self.settings.remote_verses_url)

        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT uid, reference, canto, chapter, verse, group_slug, group_label, chapter_title,
                       source_url, sanskrit, transliteration, translation, search_text, normalized_text,
                       previous_uid, next_uid
                FROM verses
                ORDER BY canto, chapter, verse
                """
            ).fetchall()
        finally:
            connection.close()

        return [
            VerseRecord(
                uid=row["uid"],
                reference=row["reference"],
                canto=row["canto"],
                chapter=row["chapter"],
                verse=row["verse"],
                group_slug=row["group_slug"],
                group_label=row["group_label"],
                chapter_title=row["chapter_title"],
                source_url=row["source_url"],
                sanskrit=row["sanskrit"],
                transliteration=row["transliteration"],
                translation=row["translation"],
                search_text=row["search_text"],
                normalized_text=row["normalized_text"],
                previous_uid=row["previous_uid"],
                next_uid=row["next_uid"],
            )
            for row in rows
        ]

    def _load_verses_from_chunks(self, chunk_paths: list[Path]) -> list[VerseRecord]:
        verses: list[VerseRecord] = []
        for chunk_path in chunk_paths:
            payload = json.loads(chunk_path.read_text(encoding="utf-8"))
            if not isinstance(payload, list):
                continue
            for row in payload:
                if not isinstance(row, list) or len(row) < 11:
                    continue
                verses.append(self._verse_from_chunk_row(row))

        verses.sort(key=lambda verse: (verse.canto, verse.chapter, verse.verse))
        return verses

    def _load_verses_from_remote(self, url: str) -> list[VerseRecord]:
        cache_path = self.settings.cache_dir / "remote_verses.json"
        payload = None

        if cache_path.exists():
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
        else:
            with urlopen(url, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(payload), encoding="utf-8")

        rows = payload.get("verses", []) if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            return []

        verses = [
            self._verse_from_chunk_row(row)
            for row in rows
            if isinstance(row, list) and len(row) >= 11
        ]
        verses.sort(key=lambda verse: (verse.canto, verse.chapter, verse.verse))
        return verses

    def _verse_from_chunk_row(self, row: list) -> VerseRecord:
        uid = str(row[0])
        reference = str(row[1])
        canto = int(row[2])
        chapter = int(row[3])
        verse = int(row[4])
        chapter_title = str(row[5])
        sanskrit = str(row[6] or "")
        transliteration = str(row[7] or "")
        translation = str(row[8] or "")
        previous_uid = str(row[9]) if row[9] else None
        next_uid = str(row[10]) if row[10] else None
        group_slug = str(verse)
        group_label = f"Text {verse}"
        source_url = f"https://vedabase.io/en/library/sb/{canto}/{chapter}/{verse}/"
        search_text = "\n".join(
            [
                reference,
                group_label,
                group_slug,
                chapter_title,
                translation,
                transliteration,
                sanskrit,
            ]
        )
        normalized_text = normalize_for_search(search_text)
        return VerseRecord(
            uid=uid,
            reference=reference,
            canto=canto,
            chapter=chapter,
            verse=verse,
            group_slug=group_slug,
            group_label=group_label,
            chapter_title=chapter_title,
            source_url=source_url,
            sanskrit=sanskrit,
            transliteration=transliteration,
            translation=translation,
            search_text=search_text,
            normalized_text=normalized_text,
            previous_uid=previous_uid,
            next_uid=next_uid,
        )

    def _build_chunks(self) -> list[ChunkRecord]:
        chunks: list[ChunkRecord] = []
        grouped: dict[tuple[int, int, str], list[VerseRecord]] = defaultdict(list)

        for verse in self.verses:
            grouped[(verse.canto, verse.chapter, verse.group_slug)].append(verse)
            chunks.append(self._build_chunk("verse", [verse], anchor_uid=verse.uid))

        for index, verse in enumerate(self.verses):
            window = self.verses[max(0, index - 1) : min(len(self.verses), index + 2)]
            chunks.append(self._build_chunk("window", window, anchor_uid=verse.uid))

        for grouped_verses in grouped.values():
            if len(grouped_verses) <= 1:
                continue
            anchor_uid = grouped_verses[len(grouped_verses) // 2].uid
            chunks.append(self._build_chunk("group", grouped_verses, anchor_uid=anchor_uid))

        return chunks

    def _build_chunk(self, chunk_type: str, verses: list[VerseRecord], *, anchor_uid: str) -> ChunkRecord:
        chapter_title = verses[0].chapter_title if verses else ""
        if chunk_type == "group" and verses:
            chapter_title = f"{chapter_title} | {verses[0].group_label}"

        search_text = "\n\n".join(
            [
                reference_span(verses),
                chapter_title,
                *[
                    "\n".join(
                        [
                            verse.reference,
                            verse.translation,
                            verse.transliteration,
                            verse.sanskrit,
                        ]
                    )
                    for verse in verses
                ],
            ]
        )
        normalized_text = normalize_for_search(search_text)
        tokens = tokenize(normalized_text)
        title_tokens = tuple(tokenize(chapter_title))
        content_tokens = tokenize("\n".join(verse.translation for verse in verses))
        first_reference = verses[0].reference if verses else anchor_uid
        chunk_uid = f"{chunk_type}:{anchor_uid}:{len(verses)}"
        return ChunkRecord(
            uid=chunk_uid,
            chunk_type=chunk_type,
            anchor_uid=anchor_uid,
            verse_uids=tuple(verse.uid for verse in verses),
            reference_label=first_reference if len(verses) == 1 else reference_span(verses),
            chapter_title=chapter_title,
            search_text=search_text,
            normalized_text=normalized_text,
            title_tokens=title_tokens,
            token_set=frozenset(tokens),
            content_token_set=frozenset(content_tokens),
        )

    def _build_term_stats(self) -> None:
        total_length = 0
        for chunk in self.chunks:
            tokens = tokenize(chunk.normalized_text)
            counter = count_tokens(tokens)
            self.doc_terms[chunk.uid] = counter
            self.doc_lengths[chunk.uid] = sum(counter.values())
            total_length += self.doc_lengths[chunk.uid]
            for token in counter:
                self.postings[token].add(chunk.uid)

        self.average_doc_length = total_length / self.document_count if self.document_count else 0.0

    def get_chunk(self, chunk_uid: str) -> ChunkRecord:
        return self.chunk_by_uid[chunk_uid]

    def _idf(self, token: str) -> float:
        doc_freq = len(self.postings.get(token, ()))
        if doc_freq == 0:
            return 0.0
        return math.log(1 + (self.document_count - doc_freq + 0.5) / (doc_freq + 0.5))

    def _bm25(self, query_tokens: list[str], chunk_uid: str, k1: float = 1.5, b: float = 0.75) -> float:
        if not query_tokens:
            return 0.0

        term_counts = self.doc_terms[chunk_uid]
        doc_length = self.doc_lengths[chunk_uid] or 1
        score = 0.0

        for token in query_tokens:
            frequency = term_counts.get(token, 0)
            if frequency == 0:
                continue
            idf = self._idf(token)
            numerator = frequency * (k1 + 1)
            denominator = frequency + k1 * (1 - b + b * doc_length / max(self.average_doc_length, 1))
            score += idf * (numerator / denominator)
        return score

    def _fuzzy_score(self, query_features: QueryFeatures, chunk: ChunkRecord) -> float:
        if not query_features.query_tokens:
            return 0.0

        chunk_token_list = tokenize(chunk.normalized_text)
        overlap = sum(1 for token in query_features.query_tokens if token in chunk.token_set)
        overlap_ratio = overlap / max(len(query_features.query_tokens), 1)

        title_token_set = set(chunk.title_tokens)
        title_overlap_count = sum(1 for token in query_features.title_tokens if token in title_token_set)
        title_overlap_ratio = title_overlap_count / max(len(query_features.title_tokens), 1) if query_features.title_tokens else 0.0

        chunk_type_bonus = 0.0
        if query_features.is_event_query:
            chunk_type_bonus = 1.1 if chunk.chunk_type == "group" else 0.65 if chunk.chunk_type == "window" else 0.2
        elif query_features.is_verse_query:
            chunk_type_bonus = 1.0 if chunk.chunk_type == "verse" else 0.45
        else:
            chunk_type_bonus = 0.75 if chunk.chunk_type == "window" else 0.5 if chunk.chunk_type == "group" else 0.25

        title_coverage_bonus = title_overlap_ratio * 3.0
        phrase_bonus = phrase_match_score(query_features.phrase_tokens, chunk.normalized_text, chunk_token_list)
        proximity_bonus = proximity_score(query_features.proximity_tokens, chunk_token_list)
        entity_bonus = token_coverage_score(query_features.entity_tokens, chunk.content_token_set) * 4.0

        return overlap_ratio + chunk_type_bonus + title_coverage_bonus + phrase_bonus + proximity_bonus + entity_bonus

    def _candidate_chunk_uids(self, query_tokens: list[str]) -> set[str]:
        candidate_uids: set[str] = set()
        for token in query_tokens:
            candidate_uids.update(self.postings.get(token, ()))
        if candidate_uids:
            return candidate_uids
        return {chunk.uid for chunk in self.chunks}

    def _score_variant(self, query: str, top_k: int) -> list[RetrievalHit]:
        query_features = build_query_features(query)
        if not query_features.query_tokens:
            return []

        hits: list[RetrievalHit] = []
        for chunk_uid in self._candidate_chunk_uids(query_features.query_tokens):
            chunk = self.chunk_by_uid[chunk_uid]
            lexical_score = self._bm25(query_features.query_tokens, chunk_uid)
            fuzzy_score = self._fuzzy_score(query_features, chunk)
            combined_score = lexical_score + (fuzzy_score * 1.4)
            if combined_score <= 0:
                continue

            anchor_verse = self.verse_by_uid[chunk.anchor_uid]
            hits.append(
                RetrievalHit(
                    verse=anchor_verse,
                    score=combined_score,
                    lexical_score=lexical_score,
                    fuzzy_score=fuzzy_score,
                    preview=anchor_verse.translation,
                    matched_chunk_id=chunk.uid,
                    matched_chunk_type=chunk.chunk_type,
                    matched_verse_uids=chunk.verse_uids,
                )
            )

        hits.sort(key=lambda hit: (-hit.score, hit.verse.canto, hit.verse.chapter, hit.verse.verse))
        return hits[:top_k]

    def retrieve(self, query: str, top_k: int = 8, lexical_queries: list[str] | None = None) -> list[RetrievalHit]:
        variants = [variant for variant in dict.fromkeys([query, *(lexical_queries or [])]) if variant.strip()]
        aggregated: dict[str, RetrievalHit] = {}
        variant_matches: Counter[str] = Counter()

        for variant in variants:
            variant_hits = self._score_variant(variant, max(top_k * 3, 24))
            for hit in variant_hits:
                variant_matches[hit.matched_chunk_id] += 1
                existing = aggregated.get(hit.matched_chunk_id)
                if existing is None or hit.score > existing.score:
                    aggregated[hit.matched_chunk_id] = hit

        final_hits: list[RetrievalHit] = []
        for chunk_uid, hit in aggregated.items():
            match_bonus = max(0, variant_matches[chunk_uid] - 1) * 0.45
            hit.score += match_bonus
            final_hits.append(hit)

        final_hits.sort(key=lambda hit: (-hit.score, hit.verse.canto, hit.verse.chapter, hit.verse.verse))
        return final_hits[:top_k]

    def expand_context_group(self, verse_uids: tuple[str, ...], neighbor_window: int = 1) -> list[VerseRecord]:
        if not verse_uids:
            return []

        ordered = [self.verse_by_uid[uid] for uid in verse_uids if uid in self.verse_by_uid]
        if not ordered:
            return []

        first = ordered[0]
        previous_uid = first.previous_uid
        for _ in range(neighbor_window):
            if not previous_uid:
                break
            previous = self.verse_by_uid[previous_uid]
            ordered.insert(0, previous)
            previous_uid = previous.previous_uid

        last = ordered[-1]
        next_uid = last.next_uid
        for _ in range(neighbor_window):
            if not next_uid:
                break
            following = self.verse_by_uid[next_uid]
            ordered.append(following)
            next_uid = following.next_uid

        deduped: list[VerseRecord] = []
        seen: set[str] = set()
        for verse in ordered:
            if verse.uid in seen:
                continue
            seen.add(verse.uid)
            deduped.append(verse)
        return deduped
