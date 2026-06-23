from __future__ import annotations

import json
import sqlite3
import unicodedata
from pathlib import Path
from typing import Iterable

from .config import Settings
from .models import VerseRecord


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

DROP TABLE IF EXISTS verses;
DROP TABLE IF EXISTS verse_fts;

CREATE TABLE verses (
    uid TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    canto INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    verse INTEGER NOT NULL,
    group_slug TEXT NOT NULL,
    group_label TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    source_url TEXT NOT NULL,
    sanskrit TEXT NOT NULL,
    transliteration TEXT NOT NULL,
    translation TEXT NOT NULL,
    search_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    previous_uid TEXT,
    next_uid TEXT
);

CREATE VIRTUAL TABLE verse_fts USING fts5(
    uid UNINDEXED,
    reference,
    chapter_title,
    search_text,
    normalized_text,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


def normalize_for_search(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    cleaned_chars: list[str] = []
    for char in text.lower():
        if char.isalnum():
            cleaned_chars.append(char)
        else:
            cleaned_chars.append(" ")
    return " ".join("".join(cleaned_chars).split())


def build_reference(canto: int, chapter: int, verse: int) -> str:
    return f"SB {canto}.{chapter}.{verse}"


def build_uid(canto: int, chapter: int, verse: int) -> str:
    return f"sb-{canto}-{chapter}-{verse}"


def build_search_text(record: dict, chapter_title: str, reference: str) -> str:
    parts = [
        reference,
        record["group_label"],
        record["group_slug"],
        chapter_title,
        record["translation"],
        record["transliteration"],
        record["sanskrit"],
    ]
    return "\n".join(part for part in parts if part)


def iter_chapter_files(corpus_dir: Path) -> Iterable[Path]:
    yield from sorted(corpus_dir.rglob("chapter.json"))


def flatten_corpus(corpus_dir: Path) -> list[VerseRecord]:
    records: list[VerseRecord] = []

    for chapter_path in iter_chapter_files(corpus_dir):
        chapter_data = json.loads(chapter_path.read_text(encoding="utf-8"))
        chapter_title = chapter_data["chapter_title"]

        for verse in chapter_data["verses"]:
            canto = int(chapter_data["canto_number"])
            chapter = int(chapter_data["chapter_number"])
            verse_number = int(verse["verse_number"])
            reference = build_reference(canto, chapter, verse_number)
            uid = build_uid(canto, chapter, verse_number)
            search_text = build_search_text(verse, chapter_title, reference)
            normalized_text = normalize_for_search(search_text)

            records.append(
                VerseRecord(
                    uid=uid,
                    reference=reference,
                    canto=canto,
                    chapter=chapter,
                    verse=verse_number,
                    group_slug=verse["group_slug"],
                    group_label=verse["group_label"],
                    chapter_title=chapter_title,
                    source_url=verse["group_source_url"],
                    sanskrit=verse["sanskrit"],
                    transliteration=verse["transliteration"],
                    translation=verse["translation"],
                    search_text=search_text,
                    normalized_text=normalized_text,
                    previous_uid=None,
                    next_uid=None,
                )
            )

    records.sort(key=lambda record: (record.canto, record.chapter, record.verse))

    linked_records: list[VerseRecord] = []
    for index, record in enumerate(records):
        previous_uid = records[index - 1].uid if index > 0 else None
        next_uid = records[index + 1].uid if index + 1 < len(records) else None
        linked_records.append(
            VerseRecord(
                uid=record.uid,
                reference=record.reference,
                canto=record.canto,
                chapter=record.chapter,
                verse=record.verse,
                group_slug=record.group_slug,
                group_label=record.group_label,
                chapter_title=record.chapter_title,
                source_url=record.source_url,
                sanskrit=record.sanskrit,
                transliteration=record.transliteration,
                translation=record.translation,
                search_text=record.search_text,
                normalized_text=record.normalized_text,
                previous_uid=previous_uid,
                next_uid=next_uid,
            )
        )

    return linked_records


def write_jsonl(records: list[VerseRecord], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record.__dict__, ensure_ascii=False) + "\n")


def write_sqlite(records: list[VerseRecord], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA_SQL)

        connection.executemany(
            """
            INSERT INTO verses (
                uid, reference, canto, chapter, verse, group_slug, group_label, chapter_title,
                source_url, sanskrit, transliteration, translation, search_text, normalized_text,
                previous_uid, next_uid
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    record.uid,
                    record.reference,
                    record.canto,
                    record.chapter,
                    record.verse,
                    record.group_slug,
                    record.group_label,
                    record.chapter_title,
                    record.source_url,
                    record.sanskrit,
                    record.transliteration,
                    record.translation,
                    record.search_text,
                    record.normalized_text,
                    record.previous_uid,
                    record.next_uid,
                )
                for record in records
            ],
        )

        connection.executemany(
            """
            INSERT INTO verse_fts (uid, reference, chapter_title, search_text, normalized_text)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    record.uid,
                    record.reference,
                    record.chapter_title,
                    record.search_text,
                    record.normalized_text,
                )
                for record in records
            ],
        )
        connection.commit()
    finally:
        connection.close()


def build_index(settings: Settings) -> tuple[int, Path, Path]:
    records = flatten_corpus(settings.corpus_dir)
    write_jsonl(records, settings.jsonl_path)
    write_sqlite(records, settings.db_path)
    return len(records), settings.jsonl_path, settings.db_path
