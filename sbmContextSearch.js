const DEFAULT_REMOTE_VERSES_URL =
  'https://atlanta.godivinity.org/srimad-bhagavatham-search/data/verses.json';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'about',
  'at',
  'by',
  'does',
  'do',
  'for',
  'from',
  'happen',
  'happens',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'text',
  'texts',
  'verse',
  'verses',
  'what',
  'where',
  'which',
  'who',
  'why'
]);

const LOW_SIGNAL_TOKENS = new Set([
  'avatar',
  'avatara',
  'bhagavatam',
  'bhagavatham',
  'canto',
  'chapter',
  'incarnation',
  'incarnations',
  'quote',
  'quoted',
  'sanskrit',
  'sloka',
  'slokam',
  'summary',
  'text',
  'texts',
  'transliteration',
  'translation',
  'verse',
  'verses'
]);

const EVENT_QUERY_HINTS = new Set([
  'appear',
  'appearance',
  'appeared',
  'avatar',
  'avatara',
  'birth',
  'born',
  'episode',
  'happen',
  'happened',
  'happening',
  'occurs',
  'pastime',
  'place',
  'story',
  'takes',
  'where'
]);

const QUERY_SYNONYMS = new Map([
  ['bird', ['birds', 'cuckoo', 'swans', 'swan', 'parrot']],
  ['birds', ['bird', 'cuckoo', 'swans', 'swan', 'parrot']],
  ['devotee', ['devotees', 'bhakta', 'bhaktas']],
  ['devotees', ['devotee', 'bhakta', 'bhaktas']],
  ['hear', ['hearing', 'sravana', 'sravanam']],
  ['hearing', ['hear', 'sravana', 'sravanam']],
  ['krsna', ['krishna']],
  ['krishna', ['krsna']],
  ['narasimha', ['nrsimha', 'nrsimhadeva', 'narahari', 'prahlada', 'hiranyakasipu', 'pillar']],
  ['nrsimha', ['narasimha', 'nrsimhadeva', 'narahari', 'prahlada', 'hiranyakasipu', 'pillar']],
  ['putana', ['putana', 'poison', 'demoness', 'breast']],
  ['varaha', ['boar', 'earth', 'nostril', 'tusk']]
]);

const TOKEN_EQUIVALENTS = new Map([
  ['bhagavatham', 'bhagavatam'],
  ['krsna', 'krishna'],
  ['narasimha', 'nrsimha'],
  ['narsimha', 'nrsimha'],
  ['nrisimha', 'nrsimha'],
  ['nrsimhadeva', 'nrsimha'],
  ['shloka', 'sloka'],
  ['slokam', 'sloka']
]);

const FOLLOW_UP_HINTS = new Set([
  'again',
  'another',
  'else',
  'he',
  'her',
  'him',
  'it',
  'same',
  'that',
  'there',
  'they',
  'this',
  'those',
  'where',
  'which'
]);

const normalizeWhitespace = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeForSearch = (value) =>
  normalizeWhitespace(
    String(value ?? '')
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/['’]/g, '')
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      .toLowerCase()
  );

const normalizeToken = (value) => {
  let token = String(value);
  if (/^\d+$/.test(token)) return token;
  if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
  else if (token.length > 4 && token.endsWith('es')) token = token.slice(0, -2);
  else if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) token = token.slice(0, -1);
  return TOKEN_EQUIVALENTS.get(token) || token;
};

const isMeaningfulToken = (token) => /^\d+$/.test(token) || token.length > 1;

const tokenize = (value, { expandSynonyms = false } = {}) => {
  const baseTokens = normalizeForSearch(value)
    .split(' ')
    .filter(Boolean)
    .map(normalizeToken)
    .filter((token) => isMeaningfulToken(token) && !STOPWORDS.has(token));

  if (!expandSynonyms) return baseTokens;

  const expanded = new Set(baseTokens);
  for (const token of baseTokens) {
    for (const synonym of QUERY_SYNONYMS.get(token) || []) expanded.add(synonym);
  }
  return [...expanded];
};

const uniqueList = (values) => [...new Set(values.filter(Boolean))];

const countTokens = (tokens) => {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
};

const referenceSpan = (verses) => {
  if (!verses.length) return '';
  if (verses.length === 1) return verses[0].reference;
  return `${verses[0].reference} - ${verses[verses.length - 1].reference}`;
};

const tokenCoverageScore = (tokens, tokenSet) => {
  const uniqueTokens = uniqueList(tokens);
  if (!uniqueTokens.length) return 0;
  let overlap = 0;
  for (const token of uniqueTokens) {
    if (tokenSet.has(token)) overlap += 1;
  }
  return overlap / uniqueTokens.length;
};

const proximityScore = (queryTokens, verseTokens) => {
  const uniqueTokens = uniqueList(queryTokens);
  if (uniqueTokens.length < 2 || !verseTokens.length) return 0;

  const positions = new Map();
  verseTokens.forEach((token, index) => {
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token).push(index);
  });

  const matched = uniqueTokens.filter((token) => positions.has(token));
  if (matched.length < 2) return 0;

  let bestSpan = null;
  for (let leftIndex = 0; leftIndex < matched.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < matched.length; rightIndex += 1) {
      for (const leftPosition of positions.get(matched[leftIndex])) {
        for (const rightPosition of positions.get(matched[rightIndex])) {
          const span = Math.abs(leftPosition - rightPosition);
          if (bestSpan === null || span < bestSpan) bestSpan = span;
        }
      }
    }
  }

  if (bestSpan === null) return 0;
  const coverage = matched.length / uniqueTokens.length;
  return coverage * (1 / (1 + bestSpan)) * 2.0;
};

const longestContiguousTokenRun = (queryTokens, fieldTokens) => {
  if (!queryTokens.length || !fieldTokens.length) return 0;
  let bestRun = 0;
  for (let fieldIndex = 0; fieldIndex < fieldTokens.length; fieldIndex += 1) {
    let run = 0;
    while (
      fieldIndex + run < fieldTokens.length &&
      run < queryTokens.length &&
      fieldTokens[fieldIndex + run] === queryTokens[run]
    ) {
      run += 1;
    }
    if (run > bestRun) bestRun = run;
  }
  return bestRun;
};

const phraseMatchScore = (queryTokens, normalizedField, fieldTokens) => {
  const uniqueTokens = uniqueList(queryTokens).filter((token) => !LOW_SIGNAL_TOKENS.has(token));
  if (!uniqueTokens.length) return 0;

  const phrase = uniqueTokens.join(' ');
  if (phrase.length >= 5 && normalizedField.includes(phrase)) {
    return 1.5 + Math.min(0.4, uniqueTokens.length * 0.08);
  }

  const fieldTokenSet = new Set(fieldTokens);
  const overlapCount = uniqueTokens.filter((token) => fieldTokenSet.has(token)).length;
  if (!overlapCount) return 0;

  const orderedRatio = longestContiguousTokenRun(uniqueTokens, fieldTokens) / Math.max(uniqueTokens.length, 1);
  const overlapRatio = overlapCount / Math.max(uniqueTokens.length, 1);
  return orderedRatio * 0.9 + overlapRatio * 0.45;
};

const buildQueryFeatures = (query) => {
  const rawTokens = normalizeForSearch(query).split(' ').filter(Boolean).map(normalizeToken);
  const filtered = rawTokens.filter((token) => isMeaningfulToken(token) && !STOPWORDS.has(token));
  const expanded = tokenize(query, { expandSynonyms: true });
  const entityTokens = filtered.filter((token) => !LOW_SIGNAL_TOKENS.has(token) && token.length > 2);
  const phraseTokens = filtered.filter((token) => !LOW_SIGNAL_TOKENS.has(token));
  const titleTokens = uniqueList([
    ...entityTokens,
    ...expanded.filter((token) => !LOW_SIGNAL_TOKENS.has(token))
  ]);

  const relationalExpansions = new Set();
  const hearingTerms = new Set(['hear', 'hearing', 'sravana', 'sravanam']);
  const devoteeTerms = new Set(['devotee', 'devotees', 'bhakta', 'bhaktas']);
  if (filtered.some((token) => hearingTerms.has(token)) && filtered.some((token) => devoteeTerms.has(token))) {
    ['association', 'glory', 'glories', 'message', 'messages', 'pure', 'service'].forEach((token) =>
      relationalExpansions.add(token)
    );
  }

  return {
    rawTokens,
    queryTokens: uniqueList([...expanded, ...[...relationalExpansions].sort()]),
    phraseTokens,
    proximityTokens: uniqueList([...filtered, ...[...relationalExpansions].sort()]),
    entityTokens,
    titleTokens,
    isEventQuery: rawTokens.some((token) => EVENT_QUERY_HINTS.has(token)) && entityTokens.length > 0,
    isVerseQuery: rawTokens.some((token) =>
      ['sloka', 'verse', 'text', 'transliteration', 'sanskrit'].includes(token)
    )
  };
};

const sanitizeQueries = (queries, fallbackQuery, limit = 4) => {
  const cleaned = [];
  const seen = new Set();
  for (const rawQuery of [fallbackQuery, ...queries]) {
    const normalized = normalizeWhitespace(rawQuery);
    if (!normalized) continue;
    const lowered = normalized.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    cleaned.push(normalized);
    if (cleaned.length >= limit) break;
  }
  return cleaned.length ? cleaned : [fallbackQuery];
};

const looksLikeFollowUp = (query) => {
  const tokens = String(query ?? '').toLowerCase().match(/[a-zA-Z]+/g) || [];
  if (!tokens.length) return false;
  if (tokens.length <= 4) return true;
  return tokens.slice(0, 4).some((token) => FOLLOW_UP_HINTS.has(token));
};

const buildFallbackQueryPlan = (query, history) => {
  let standalone = String(query ?? '').trim();
  if (history.length && looksLikeFollowUp(query)) standalone = `${history[history.length - 1]} ${query}`.trim();

  let intent = 'teaching_lookup';
  const lowered = standalone.toLowerCase();
  if (['where', 'happen', 'happens', 'happened', 'appearance', 'appear', 'pastime'].some((token) => lowered.includes(token))) {
    intent = 'event_lookup';
  } else if (['which verse', 'what verse', 'sloka', 'shloka', 'text'].some((token) => lowered.includes(token))) {
    intent = 'verse_lookup';
  } else if (['summary', 'summarize', 'overview'].some((token) => lowered.includes(token))) {
    intent = 'summary_lookup';
  } else if (history.length && looksLikeFollowUp(query)) {
    intent = 'follow_up';
  }

  const entities = uniqueList((standalone.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []).map((item) => item.trim())).slice(0, 8);
  const lexicalQueries = [standalone];
  if (history.length && looksLikeFollowUp(query)) lexicalQueries.push(String(query ?? '').trim());

  return {
    original_query: query,
    standalone_query: standalone,
    lexical_queries: sanitizeQueries(lexicalQueries, standalone),
    intent,
    entities
  };
};

const buildFallbackAnswer = (query, hits) => {
  if (!hits.length) {
    return `I could not find a strong Bhagavatam match for "${query}" in the local corpus. Try a more specific person, event, or phrase.`;
  }

  const lead = hits[0].verse;
  const references = hits.slice(0, 3).map((hit) => hit.verse.reference).join(', ');
  return `The strongest local match for "${query}" is ${lead.reference} in "${lead.chapter_title}". Other nearby candidates are ${references}. Review the retrieved passages to confirm the exact context.`;
};

const buildCandidateExcerpt = (text, limit = 900) => {
  const compact = normalizeWhitespace(text);
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 3).trimEnd()}...`;
};

const renderContextBlock = (verses) =>
  verses
    .map((verse) =>
      [
        `Reference: ${verse.reference}`,
        `Chapter: ${verse.chapter_title}`,
        `Sanskrit: ${verse.sanskrit}`,
        `Translation: ${verse.translation}`,
        `Transliteration: ${verse.transliteration}`
      ].join('\n')
    )
    .join('\n\n');

class BhagavatamCorpus {
  constructor({ versesUrl }) {
    this.versesUrl = versesUrl || DEFAULT_REMOTE_VERSES_URL;
    this.verses = [];
    this.verseByUid = new Map();
    this.chunks = [];
    this.chunkByUid = new Map();
    this.docLengths = new Map();
    this.docTerms = new Map();
    this.postings = new Map();
    this.documentCount = 0;
    this.averageDocLength = 0;
  }

  static fromRows(rows, options) {
    const corpus = new BhagavatamCorpus(options);
    corpus.verses = rows
      .filter((row) => Array.isArray(row) && row.length >= 11)
      .map((row) => corpus.#verseFromRow(row))
      .sort((left, right) => left.canto - right.canto || left.chapter - right.chapter || left.verse - right.verse);
    corpus.verseByUid = new Map(corpus.verses.map((verse) => [verse.uid, verse]));
    corpus.chunks = corpus.#buildChunks();
    corpus.chunkByUid = new Map(corpus.chunks.map((chunk) => [chunk.uid, chunk]));
    corpus.#buildTermStats();
    return corpus;
  }

  #verseFromRow(row) {
    const uid = String(row[0]);
    const reference = String(row[1]);
    const canto = Number(row[2]);
    const chapter = Number(row[3]);
    const verse = Number(row[4]);
    const chapterTitle = String(row[5] || '');
    const sanskrit = String(row[6] || '');
    const transliteration = String(row[7] || '');
    const translation = String(row[8] || '');
    const previousUid = row[9] ? String(row[9]) : null;
    const nextUid = row[10] ? String(row[10]) : null;
    const groupSlug = String(verse);
    const groupLabel = `Text ${verse}`;
    const sourceUrl = `https://vedabase.io/en/library/sb/${canto}/${chapter}/${verse}/`;
    const searchText = [
      reference,
      groupLabel,
      groupSlug,
      chapterTitle,
      translation,
      transliteration,
      sanskrit
    ].join('\n');

    return {
      uid,
      reference,
      canto,
      chapter,
      verse,
      group_slug: groupSlug,
      group_label: groupLabel,
      chapter_title: chapterTitle,
      source_url: sourceUrl,
      sanskrit,
      transliteration,
      translation,
      search_text: searchText,
      normalized_text: normalizeForSearch(searchText),
      previous_uid: previousUid,
      next_uid: nextUid
    };
  }

  #buildChunks() {
    const chunks = [];
    const grouped = new Map();

    for (const verse of this.verses) {
      const groupedKey = `${verse.canto}:${verse.chapter}:${verse.group_slug}`;
      if (!grouped.has(groupedKey)) grouped.set(groupedKey, []);
      grouped.get(groupedKey).push(verse);
      chunks.push(this.#buildChunk('verse', [verse], verse.uid));
    }

    for (let index = 0; index < this.verses.length; index += 1) {
      const verse = this.verses[index];
      const window = this.verses.slice(Math.max(0, index - 1), Math.min(this.verses.length, index + 2));
      chunks.push(this.#buildChunk('window', window, verse.uid));
    }

    for (const groupedVerses of grouped.values()) {
      if (groupedVerses.length <= 1) continue;
      const anchorVerse = groupedVerses[Math.floor(groupedVerses.length / 2)];
      chunks.push(this.#buildChunk('group', groupedVerses, anchorVerse.uid));
    }

    return chunks;
  }

  #buildChunk(chunkType, verses, anchorUid) {
    let chapterTitle = verses[0]?.chapter_title || '';
    if (chunkType === 'group' && verses.length) chapterTitle = `${chapterTitle} | ${verses[0].group_label}`;

    const searchText = [
      referenceSpan(verses),
      chapterTitle,
      ...verses.map((verse) => [verse.reference, verse.translation, verse.transliteration, verse.sanskrit].join('\n'))
    ].join('\n\n');
    const normalizedText = normalizeForSearch(searchText);
    const tokens = tokenize(normalizedText);
    const titleTokens = tokenize(chapterTitle);
    const contentTokens = tokenize(verses.map((verse) => verse.translation).join('\n'));
    const firstReference = verses[0]?.reference || anchorUid;
    return {
      uid: `${chunkType}:${anchorUid}:${verses.length}`,
      chunk_type: chunkType,
      anchor_uid: anchorUid,
      verse_uids: verses.map((verse) => verse.uid),
      reference_label: verses.length === 1 ? firstReference : referenceSpan(verses),
      chapter_title: chapterTitle,
      search_text: searchText,
      normalized_text: normalizedText,
      title_tokens: titleTokens,
      token_set: new Set(tokens),
      content_token_set: new Set(contentTokens)
    };
  }

  #buildTermStats() {
    let totalLength = 0;
    for (const chunk of this.chunks) {
      const tokens = tokenize(chunk.normalized_text);
      const counter = countTokens(tokens);
      this.docTerms.set(chunk.uid, counter);
      const docLength = [...counter.values()].reduce((sum, value) => sum + value, 0);
      this.docLengths.set(chunk.uid, docLength);
      totalLength += docLength;
      for (const token of counter.keys()) {
        if (!this.postings.has(token)) this.postings.set(token, new Set());
        this.postings.get(token).add(chunk.uid);
      }
    }
    this.documentCount = this.chunks.length;
    this.averageDocLength = this.documentCount ? totalLength / this.documentCount : 0;
  }

  #idf(token) {
    const docFreq = this.postings.get(token)?.size || 0;
    if (!docFreq) return 0;
    return Math.log(1 + (this.documentCount - docFreq + 0.5) / (docFreq + 0.5));
  }

  #bm25(queryTokens, chunkUid, k1 = 1.5, b = 0.75) {
    if (!queryTokens.length) return 0;
    const termCounts = this.docTerms.get(chunkUid) || new Map();
    const docLength = this.docLengths.get(chunkUid) || 1;
    let score = 0;
    for (const token of queryTokens) {
      const frequency = termCounts.get(token) || 0;
      if (!frequency) continue;
      const idf = this.#idf(token);
      const numerator = frequency * (k1 + 1);
      const denominator = frequency + k1 * (1 - b + (b * docLength) / Math.max(this.averageDocLength, 1));
      score += idf * (numerator / denominator);
    }
    return score;
  }

  #fuzzyScore(queryFeatures, chunk) {
    if (!queryFeatures.queryTokens.length) return 0;
    const chunkTokenList = tokenize(chunk.normalized_text);
    const overlap = queryFeatures.queryTokens.filter((token) => chunk.token_set.has(token)).length;
    const overlapRatio = overlap / Math.max(queryFeatures.queryTokens.length, 1);

    const titleTokenSet = new Set(chunk.title_tokens);
    const titleOverlapCount = queryFeatures.titleTokens.filter((token) => titleTokenSet.has(token)).length;
    const titleOverlapRatio = queryFeatures.titleTokens.length
      ? titleOverlapCount / Math.max(queryFeatures.titleTokens.length, 1)
      : 0;

    let chunkTypeBonus = 0;
    if (queryFeatures.isEventQuery) {
      chunkTypeBonus = chunk.chunk_type === 'group' ? 1.1 : chunk.chunk_type === 'window' ? 0.65 : 0.2;
    } else if (queryFeatures.isVerseQuery) {
      chunkTypeBonus = chunk.chunk_type === 'verse' ? 1.0 : 0.45;
    } else {
      chunkTypeBonus = chunk.chunk_type === 'window' ? 0.75 : chunk.chunk_type === 'group' ? 0.5 : 0.25;
    }

    const titleCoverageBonus = titleOverlapRatio * 3.0;
    const phraseBonus = phraseMatchScore(queryFeatures.phraseTokens, chunk.normalized_text, chunkTokenList);
    const proximityBonus = proximityScore(queryFeatures.proximityTokens, chunkTokenList);
    const entityBonus = tokenCoverageScore(queryFeatures.entityTokens, chunk.content_token_set) * 4.0;

    return overlapRatio + chunkTypeBonus + titleCoverageBonus + phraseBonus + proximityBonus + entityBonus;
  }

  #candidateChunkUids(queryTokens) {
    const candidateUids = new Set();
    for (const token of queryTokens) {
      for (const chunkUid of this.postings.get(token) || []) candidateUids.add(chunkUid);
    }
    return candidateUids.size ? candidateUids : new Set(this.chunks.map((chunk) => chunk.uid));
  }

  #scoreVariant(query, topK) {
    const queryFeatures = buildQueryFeatures(query);
    if (!queryFeatures.queryTokens.length) return [];

    const hits = [];
    for (const chunkUid of this.#candidateChunkUids(queryFeatures.queryTokens)) {
      const chunk = this.chunkByUid.get(chunkUid);
      const lexicalScore = this.#bm25(queryFeatures.queryTokens, chunkUid);
      const fuzzyScore = this.#fuzzyScore(queryFeatures, chunk);
      const combinedScore = lexicalScore + fuzzyScore * 1.4;
      if (combinedScore <= 0) continue;

      const anchorVerse = this.verseByUid.get(chunk.anchor_uid);
      hits.push({
        verse: anchorVerse,
        score: combinedScore,
        lexical_score: lexicalScore,
        fuzzy_score: fuzzyScore,
        semantic_score: 0,
        rerank_score: 0,
        matched_chunk_id: chunk.uid,
        matched_chunk_type: chunk.chunk_type,
        matched_verse_uids: chunk.verse_uids
      });
    }

    hits.sort(
      (left, right) =>
        right.score - left.score ||
        left.verse.canto - right.verse.canto ||
        left.verse.chapter - right.verse.chapter ||
        left.verse.verse - right.verse.verse
    );
    return hits.slice(0, topK);
  }

  retrieve(query, { topK = 8, lexicalQueries = [] } = {}) {
    const variants = uniqueList([query, ...lexicalQueries].map((item) => normalizeWhitespace(item))).filter(Boolean);
    const aggregated = new Map();
    const variantMatches = new Map();

    for (const variant of variants) {
      const variantHits = this.#scoreVariant(variant, Math.max(topK * 3, 24));
      for (const hit of variantHits) {
        variantMatches.set(hit.matched_chunk_id, (variantMatches.get(hit.matched_chunk_id) || 0) + 1);
        const existing = aggregated.get(hit.matched_chunk_id);
        if (!existing || hit.score > existing.score) aggregated.set(hit.matched_chunk_id, hit);
      }
    }

    const finalHits = [];
    for (const [chunkUid, hit] of aggregated.entries()) {
      const matchBonus = Math.max(0, (variantMatches.get(chunkUid) || 0) - 1) * 0.45;
      finalHits.push({ ...hit, score: hit.score + matchBonus });
    }

    finalHits.sort(
      (left, right) =>
        right.score - left.score ||
        left.verse.canto - right.verse.canto ||
        left.verse.chapter - right.verse.chapter ||
        left.verse.verse - right.verse.verse
    );
    return finalHits.slice(0, topK);
  }

  expandContextGroup(verseUids, neighborWindow = 1) {
    if (!Array.isArray(verseUids) || !verseUids.length) return [];
    const ordered = verseUids.map((uid) => this.verseByUid.get(uid)).filter(Boolean);
    if (!ordered.length) return [];

    let previousUid = ordered[0].previous_uid;
    for (let index = 0; index < neighborWindow && previousUid; index += 1) {
      const previous = this.verseByUid.get(previousUid);
      if (!previous) break;
      ordered.unshift(previous);
      previousUid = previous.previous_uid;
    }

    let nextUid = ordered[ordered.length - 1].next_uid;
    for (let index = 0; index < neighborWindow && nextUid; index += 1) {
      const next = this.verseByUid.get(nextUid);
      if (!next) break;
      ordered.push(next);
      nextUid = next.next_uid;
    }

    const seen = new Set();
    return ordered.filter((verse) => {
      if (seen.has(verse.uid)) return false;
      seen.add(verse.uid);
      return true;
    });
  }
}

class SbmContextSearchService {
  constructor(options = {}) {
    this.versesUrl = options.versesUrl || process.env.BHAGAVATAM_REMOTE_VERSES_URL || DEFAULT_REMOTE_VERSES_URL;
    this.openRouterApiKey = options.openRouterApiKey || process.env.OPENROUTER_API_KEY || '';
    this.openRouterModel = options.openRouterModel || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    this.openRouterApiUrl = options.openRouterApiUrl || 'https://openrouter.ai/api/v1/chat/completions';
    this.siteUrl = options.siteUrl || 'https://atlanta.godivinity.org';
    this.appName = options.appName || 'Bhagavatam Context Search';
    this.corpus = null;
    this.loadPromise = null;
  }

  async ensureCorpus() {
    if (this.corpus) return this.corpus;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.#loadCorpus();
    try {
      this.corpus = await this.loadPromise;
      return this.corpus;
    } finally {
      this.loadPromise = null;
    }
  }

  async #loadCorpus() {
    const response = await fetch(this.versesUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      throw new Error(`Failed to load verses corpus (${response.status} ${response.statusText}).`);
    }
    const payload = await response.json();
    const rows = Array.isArray(payload?.verses) ? payload.verses : [];
    if (!rows.length) throw new Error('Verses corpus is empty.');
    return BhagavatamCorpus.fromRows(rows, { versesUrl: this.versesUrl });
  }

  async health() {
    const corpus = await this.ensureCorpus();
    return {
      status: 'ok',
      verses_loaded: corpus.verses.length,
      openai_enabled: Boolean(this.openRouterApiKey)
    };
  }

  async query({ query, top_k = 8, neighbor_window = 1, history = [], use_llm = true, request_origin = '' }) {
    const corpus = await this.ensureCorpus();
    const recentHistory = history.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(-6);
    const queryPlan = buildFallbackQueryPlan(query, recentHistory);
    const hits = corpus.retrieve(queryPlan.standalone_query, {
      topK: top_k,
      lexicalQueries: queryPlan.lexical_queries
    });
    const contextGroups = hits.map((hit) => corpus.expandContextGroup(hit.matched_verse_uids, neighbor_window));
    const answerResult = await this.#answer({
      query,
      rewrittenQuery: queryPlan.standalone_query,
      contextGroups,
      hits,
      useLlm: use_llm,
      requestOrigin: request_origin
    });

    return {
      query,
      rewritten_query: queryPlan.standalone_query,
      query_variants: queryPlan.lexical_queries,
      answer_mode: answerResult.answerMode,
      answer: answerResult.answerText,
      hit_count: hits.length,
      hits: hits.map((hit) => this.#serializeHit(hit)),
      context_groups: contextGroups.map((group) => group.map((verse) => ({ ...verse })))
    };
  }

  async #answer({ query, rewrittenQuery, contextGroups, hits, useLlm, requestOrigin }) {
    if (!useLlm || !this.openRouterApiKey) {
      return {
        answerMode: 'retrieval_only',
        answerText: buildFallbackAnswer(query, hits)
      };
    }

    try {
      const contextText = contextGroups.map((group) => renderContextBlock(group)).join('\n\n---\n\n');
      const response = await fetch(this.openRouterApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openRouterApiKey}`,
          'HTTP-Referer': normalizeWhitespace(requestOrigin) || this.siteUrl,
          'X-Title': this.appName
        },
        body: JSON.stringify({
          model: this.openRouterModel,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You answer questions about the Srimad Bhagavatam using only the supplied passages. Be concise, cite references like SB 10.15.10, and clearly say when the retrieved context is inconclusive. Prefer the exact occurrence passage over a chapter summary.'
            },
            {
              role: 'user',
              content: `Original user question:\n${query}\n\nSearch interpretation:\n${rewrittenQuery}\n\nRetrieved Bhagavatam passages:\n${contextText}\n\nAnswer using only those passages.`
            }
          ]
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) {
        throw new Error(`OpenRouter request failed with ${response.status}.`);
      }

      const payload = await response.json();
      const answerText = normalizeWhitespace(payload?.choices?.[0]?.message?.content || '');
      if (!answerText) throw new Error('OpenRouter returned an empty answer.');
      return {
        answerMode: 'chat_completion',
        answerText
      };
    } catch (error) {
      console.error('Context search answer fallback:', error);
      return {
        answerMode: 'retrieval_only',
        answerText: buildFallbackAnswer(query, hits)
      };
    }
  }

  #serializeHit(hit) {
    return {
      reference: hit.verse.reference,
      chapter_title: hit.verse.chapter_title,
      source_url: hit.verse.source_url,
      translation: hit.verse.translation,
      transliteration: hit.verse.transliteration,
      sanskrit: hit.verse.sanskrit,
      score: Number(hit.score.toFixed(4)),
      lexical_score: Number(hit.lexical_score.toFixed(4)),
      fuzzy_score: Number(hit.fuzzy_score.toFixed(4)),
      semantic_score: 0,
      rerank_score: 0,
      matched_chunk_type: hit.matched_chunk_type,
      excerpt: buildCandidateExcerpt(hit.verse.translation)
    };
  }
}

export const createSbmContextSearchService = (options) => new SbmContextSearchService(options);
