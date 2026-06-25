import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSbmContextSearchService } from '../sbmContextSearch.js';

const makeVerse = () => ({
  uid: 'sb-10-3-1',
  reference: 'SB 10.3.1',
  canto: 10,
  chapter: 3,
  verse: 1,
  chapter_title: 'The Birth of Lord Krishna',
  source_url: 'https://vedabase.io/en/library/sb/10/3/1/',
  sanskrit: 'sanskrit',
  transliteration: 'transliteration',
  translation: 'Krishna appears in Mathura.',
  previous_uid: null,
  next_uid: null
});

test('falls back quickly when the answer provider exceeds the timeout', async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Delayed answer' } }] }));
    }, 200);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const verse = makeVerse();
    const service = createSbmContextSearchService({
      versesUrl: 'http://127.0.0.1/unused.json',
      openRouterApiKey: 'test-key',
      openRouterApiUrl: `http://127.0.0.1:${server.address().port}/chat/completions`,
      answerTimeoutMs: 50
    });
    service.corpus = {
      verses: [verse],
      retrieve: () => [
        {
          verse,
          score: 1,
          lexical_score: 1,
          fuzzy_score: 0,
          semantic_score: 0,
          rerank_score: 0,
          matched_chunk_id: verse.uid,
          matched_chunk_type: 'verse',
          matched_verse_uids: [verse.uid]
        }
      ],
      expandContextGroup: () => [verse]
    };

    const startedAt = Date.now();
    const result = await service.query({
      query: 'Where is Krishna born?',
      top_k: 1,
      neighbor_window: 0,
      use_llm: true,
      request_origin: 'https://atlanta.godivinity.org'
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.answer_mode, 'retrieval_only');
    assert.match(result.answer, /strongest local match/i);
    assert.ok(elapsedMs < 500, `expected fallback under 500ms, got ${elapsedMs}ms`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('prefers the Bhagavatam-specific model override', () => {
  const previousValue = process.env.BHAGAVATAM_OPENROUTER_MODEL;

  try {
    process.env.BHAGAVATAM_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
    const service = createSbmContextSearchService({
      openRouterApiKey: 'test-key',
      openRouterModel: undefined
    });
    assert.equal(service.openRouterModel, 'openai/gpt-4o-mini');
  } finally {
    if (previousValue === undefined) {
      delete process.env.BHAGAVATAM_OPENROUTER_MODEL;
    } else {
      process.env.BHAGAVATAM_OPENROUTER_MODEL = previousValue;
    }
  }
});

test('retrieves SB 10.21.3 for Venu Gita instead of Venus verses', async () => {
  const rows = [
    [
      'sb-10-21-3',
      'SB 10.21.3',
      10,
      21,
      3,
      "The Gopis Glorify the Song of Krishna's Flute",
      'sanskrit',
      'tad vraja-striya asrutya venu-gitam smarodayam',
      "When the young ladies in the cowherd village of Vraja heard the song of Krishna's flute, they spoke about Him.",
      null,
      null
    ],
    [
      'sb-10-21-14',
      'SB 10.21.14',
      10,
      21,
      14,
      "The Gopis Glorify the Song of Krishna's Flute",
      'sanskrit',
      'kala-venu-gitam srnvanti',
      "The birds listen silently to the sweet vibrations of Krishna's flute.",
      null,
      null
    ],
    [
      'sb-5-22-12',
      'SB 5.22.12',
      5,
      22,
      12,
      'The Orbits of the Planets',
      'sanskrit',
      'tata uparistad usana dvi-laksa-yojanata upalabhyate',
      'Some 1,600,000 miles above this group of stars is the planet Venus.',
      null,
      null
    ]
  ];

  const server = http.createServer((req, res) => {
    if (req.url === '/verses.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verses: rows }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const service = createSbmContextSearchService({
      versesUrl: `http://127.0.0.1:${server.address().port}/verses.json`
    });

    const result = await service.query({
      query: 'Where is the Venu Gita?',
      top_k: 2,
      neighbor_window: 0,
      use_llm: true,
      request_origin: 'https://atlanta.godivinity.org'
    });

    assert.equal(result.answer_mode, 'reference_lookup');
    assert.equal(result.hits[0].chapter_title, "The Gopis Glorify the Song of Krishna's Flute");
    assert.ok(result.hit_count >= 1);
    assert.match(result.answer, /SB 10\.21/);
    assert.match(result.answer, /Gopis Glorify the Song of Krishna's Flute/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
