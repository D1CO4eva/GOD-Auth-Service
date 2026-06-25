const DEFAULT_REMOTE_VERSES_URL =
  'https://atlanta.godivinity.org/srimad-bhagavatham-search/data/verses.json';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_ANSWER_TIMEOUT_MS = 15000;

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
  'bhagavatam',
  'bhagavatham',
  'canto',
  'chapter',
  'sanskrit',
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
  'birth',
  'born',
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
  ['geeta', 'gita'],
  ['geetam', 'gita'],
  ['gitam', 'gita'],
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

const NAMED_PASSAGE_ALIASES = [
  {
    aliases: ['venu gita', 'venu gitam', 'song of krishna flute', 'song of krsna flute'],
    chapter_reference: 'SB 10.21',
    lead_reference: 'SB 10.21.3',
    chapter_title: "The Gopīs Glorify the Song of Kṛṣṇa’s Flute"
  },
  {
    aliases: ['yugala gita', 'yugala gitam'],
    chapter_reference: 'SB 10.35',
    lead_reference: 'SB 10.35.1',
    chapter_title: 'The Gopīs Sing of Kṛṣṇa as He Wanders in the Forest'
  }
];

const normalizeWhitespace = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const coercePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeForSearch = (value) =>
  normalizeWhitespace(
    String(value ?? '')
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/['’]/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .toLowerCase()
  );

const normalizeToken = (value) => {
  let token = String(value);
  if (/^\d+$/.test(token)) return token;
  if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
  else if (token.length > 4 && token.endsWith('es')) token = token.slice(0, -2);
  else if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    token = token.slice(0, -1);
  }
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

const findNamedPassageAlias = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return null;

  return (
    NAMED_PASSAGE_ALIASES.find((entry) =>
      entry.aliases.some((alias) => normalized.includes(normalizeForSearch(alias)))
    ) || null
  );
};

const countTokens = (tokens) => {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
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

  return {
    rawTokens,
    queryTokens: uniqueList(expanded),
    phraseTokens,
    proximityTokens: filtered,
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

const isReferenceLookupQuery = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;

  if (
    /\b(which|what)\s+(verse|verses|chapter|canto|sloka|shloka|text)\b/.test(normalized) ||
    /\bwhere\s+(can\s+i\s+find|do\s+i\s+find)\b/.test(normalized) ||
    /\b(find|locate|located)\b/.test(normalized)
  ) {
    return true;
  }

  const tokens = normalized.split(' ').filter(Boolean).map(normalizeToken);
  const subjectHints = new Set(['gita', 'song', 'prayer', 'stuti', 'stava', 'stotram', 'stotra']);
  return tokens.includes('where') && tokens.some((token) => subjectHints.has(token));
};

const buildReferenceAnswer = (query, hits, namedPassage = null) => {
  if (namedPassage) {
    return `${namedPassage.aliases[0]
      .split(' ')
      .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
      .join(' ')} is in ${namedPassage.chapter_reference}, especially ${namedPassage.lead_reference}, in "${namedPassage.chapter_title}".`;
  }

  if (!hits.length) return null;

  const chapterCounts = new Map();
  for (const hit of hits.slice(0, 5)) {
    const key = `${hit.verse.canto}.${hit.verse.chapter}`;
    chapterCounts.set(key, (chapterCounts.get(key) || 0) + 1);
  }

  const lead = hits[0].verse;
  const leadChapterKey = `${lead.canto}.${lead.chapter}`;
  const leadChapterCount = chapterCounts.get(leadChapterKey) || 0;
  if (leadChapterCount < 2) return null;

  const chapterReference = `SB ${lead.canto}.${lead.chapter}`;
  const subject = normalizeWhitespace(
    String(query ?? '')
      .replace(/^[Ww]here\s+(?:is|are)\s+/u, '')
      .replace(/^[Ww]here\s+can\s+i\s+find\s+/u, '')
      .replace(/^(which|what)\s+(?:verse|verses|chapter|canto|sloka|shloka|text)\s+(?:is|are|contains|describe|describes)\s+/iu, '')
      .replace(/[?]+$/g, '')
  );
  const formattedSubject = subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : 'This passage';
  if (leadChapterCount >= 3) {
    return `${formattedSubject} is in ${chapterReference}, especially ${lead.reference}, in "${lead.chapter_title}".`;
  }

  return `The strongest Bhagavatam reference is ${lead.reference} in "${lead.chapter_title}" (${chapterReference}).`;
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

class LightweightCorpus {
  constructor() {
    this.verses = [];
    this.verseByUid = new Map();
    this.docTerms = new Map();
    this.docLengths = new Map();
    this.postings = new Map();
    this.documentCount = 0;
    this.averageDocLength = 0;
  }

  static fromRows(rows) {
    const corpus = new LightweightCorpus();
    corpus.verses = rows
      .filter((row) => Array.isArray(row) && row.length >= 11)
      .map((row) => corpus.#verseFromRow(row))
      .sort((left, right) => left.canto - right.canto || left.chapter - right.chapter || left.verse - right.verse);
    corpus.verseByUid = new Map(corpus.verses.map((verse) => [verse.uid, verse]));
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
    const sourceUrl = `https://vedabase.io/en/library/sb/${canto}/${chapter}/${verse}/`;
    const searchText = [reference, chapterTitle, translation, transliteration, sanskrit].join('\n');
    const normalizedText = normalizeForSearch(searchText);
    const tokens = tokenize(normalizedText);
    const titleTokens = tokenize(chapterTitle);
    const translationTokens = tokenize(translation);

    return {
      uid,
      reference,
      canto,
      chapter,
      verse,
      chapter_title: chapterTitle,
      source_url: sourceUrl,
      sanskrit,
      transliteration,
      translation,
      search_text: searchText,
      normalized_text: normalizedText,
      tokens,
      token_set: new Set(tokens),
      title_tokens: titleTokens,
      translation_token_set: new Set(translationTokens),
      previous_uid: previousUid,
      next_uid: nextUid
    };
  }

  #buildTermStats() {
    let totalLength = 0;
    for (const verse of this.verses) {
      const counter = countTokens(verse.tokens);
      this.docTerms.set(verse.uid, counter);
      const docLength = [...counter.values()].reduce((sum, value) => sum + value, 0);
      this.docLengths.set(verse.uid, docLength);
      totalLength += docLength;
      for (const token of counter.keys()) {
        if (!this.postings.has(token)) this.postings.set(token, new Set());
        this.postings.get(token).add(verse.uid);
      }
    }
    this.documentCount = this.verses.length;
    this.averageDocLength = this.documentCount ? totalLength / this.documentCount : 0;
  }

  #idf(token) {
    const docFreq = this.postings.get(token)?.size || 0;
    if (!docFreq) return 0;
    return Math.log(1 + (this.documentCount - docFreq + 0.5) / (docFreq + 0.5));
  }

  #bm25(queryTokens, verseUid, k1 = 1.5, b = 0.75) {
    if (!queryTokens.length) return 0;
    const termCounts = this.docTerms.get(verseUid) || new Map();
    const docLength = this.docLengths.get(verseUid) || 1;
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

  #fuzzyScore(queryFeatures, verse) {
    if (!queryFeatures.queryTokens.length) return 0;

    const overlap = queryFeatures.queryTokens.filter((token) => verse.token_set.has(token)).length;
    const overlapRatio = overlap / Math.max(queryFeatures.queryTokens.length, 1);
    const titleOverlapCount = queryFeatures.titleTokens.filter((token) => verse.title_tokens.includes(token)).length;
    const titleOverlapRatio = queryFeatures.titleTokens.length
      ? titleOverlapCount / Math.max(queryFeatures.titleTokens.length, 1)
      : 0;

    const phraseBonus = phraseMatchScore(queryFeatures.phraseTokens, verse.normalized_text, verse.tokens);
    const proximityBonus = proximityScore(queryFeatures.proximityTokens, verse.tokens);
    const entityBonus = tokenCoverageScore(queryFeatures.entityTokens, verse.translation_token_set) * 3.5;
    const eventBonus = queryFeatures.isEventQuery ? 0.6 : 0.2;

    return overlapRatio + titleOverlapRatio * 2.5 + phraseBonus + proximityBonus + entityBonus + eventBonus;
  }

  #candidateVerseUids(queryTokens) {
    const candidateUids = new Set();
    for (const token of queryTokens) {
      for (const verseUid of this.postings.get(token) || []) candidateUids.add(verseUid);
    }
    return candidateUids.size ? candidateUids : new Set(this.verses.map((verse) => verse.uid));
  }

  #scoreVariant(query, topK) {
    const queryFeatures = buildQueryFeatures(query);
    if (!queryFeatures.queryTokens.length) return [];

    const hits = [];
    for (const verseUid of this.#candidateVerseUids(queryFeatures.queryTokens)) {
      const verse = this.verseByUid.get(verseUid);
      const lexicalScore = this.#bm25(queryFeatures.queryTokens, verseUid);
      const fuzzyScore = this.#fuzzyScore(queryFeatures, verse);
      const combinedScore = lexicalScore + fuzzyScore * 1.5;
      if (combinedScore <= 0) continue;

      hits.push({
        verse,
        score: combinedScore,
        lexical_score: lexicalScore,
        fuzzy_score: fuzzyScore,
        semantic_score: 0,
        rerank_score: 0,
        matched_chunk_id: verse.uid,
        matched_chunk_type: 'verse',
        matched_verse_uids: [verse.uid]
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
    this.openRouterModel =
      options.openRouterModel ||
      process.env.BHAGAVATAM_OPENROUTER_MODEL ||
      process.env.OPENROUTER_MODEL ||
      DEFAULT_OPENROUTER_MODEL;
    this.openRouterApiUrl = options.openRouterApiUrl || 'https://openrouter.ai/api/v1/chat/completions';
    this.siteUrl = options.siteUrl || 'https://atlanta.godivinity.org';
    this.appName = options.appName || 'Bhagavatam Context Search';
    this.answerTimeoutMs = coercePositiveInteger(
      options.answerTimeoutMs ?? process.env.BHAGAVATAM_OPENROUTER_TIMEOUT_MS,
      DEFAULT_ANSWER_TIMEOUT_MS
    );
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
    return LightweightCorpus.fromRows(rows);
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
    const namedPassage = findNamedPassageAlias(queryPlan.standalone_query) || findNamedPassageAlias(query);
    const lexicalQueries = namedPassage
      ? uniqueList([
          ...queryPlan.lexical_queries,
          namedPassage.chapter_reference,
          namedPassage.lead_reference,
          namedPassage.chapter_title
        ])
      : queryPlan.lexical_queries;
    const hits = corpus.retrieve(queryPlan.standalone_query, {
      topK: top_k,
      lexicalQueries
    });
    const contextGroups = hits.map((hit) => corpus.expandContextGroup(hit.matched_verse_uids, neighbor_window));
    const referenceAnswer =
      isReferenceLookupQuery(queryPlan.standalone_query) || isReferenceLookupQuery(query)
        ? buildReferenceAnswer(query, hits, namedPassage)
        : null;
    const answerResult = await this.#answer({
      query,
      rewrittenQuery: queryPlan.standalone_query,
      contextGroups,
      hits,
      referenceAnswer,
      useLlm: use_llm,
      requestOrigin: request_origin
    });

    return {
      query,
      rewritten_query: queryPlan.standalone_query,
      query_variants: lexicalQueries,
      answer_mode: answerResult.answerMode,
      answer: answerResult.answerText,
      hit_count: hits.length,
      hits: hits.map((hit) => this.#serializeHit(hit)),
      context_groups: contextGroups.map((group) =>
        group.map((verse) => ({
          uid: verse.uid,
          reference: verse.reference,
          canto: verse.canto,
          chapter: verse.chapter,
          verse: verse.verse,
          chapter_title: verse.chapter_title,
          source_url: verse.source_url,
          sanskrit: verse.sanskrit,
          transliteration: verse.transliteration,
          translation: verse.translation,
          previous_uid: verse.previous_uid,
          next_uid: verse.next_uid
        }))
      )
    };
  }

  async #answer({ query, rewrittenQuery, contextGroups, hits, referenceAnswer, useLlm, requestOrigin }) {
    if (referenceAnswer) {
      return {
        answerMode: 'reference_lookup',
        answerText: referenceAnswer
      };
    }

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
                'You answer questions about the Srimad Bhagavatam using only the supplied passages. Be concise, lead with the single best reference like SB 10.15.10, add one short supporting sentence only when needed, and clearly say when the retrieved context is inconclusive. Prefer the exact occurrence passage over a chapter summary.'
            },
            {
              role: 'user',
              content: `Original user question:\n${query}\n\nSearch interpretation:\n${rewrittenQuery}\n\nRetrieved Bhagavatam passages:\n${contextText}\n\nAnswer using only those passages.`
            }
          ]
        }),
        signal: AbortSignal.timeout(this.answerTimeoutMs)
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
      matched_chunk_type: hit.matched_chunk_type
    };
  }
}

export const createSbmContextSearchService = (options) => new SbmContextSearchService(options);
