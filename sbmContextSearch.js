import fs from 'node:fs/promises';
import { semanticSearch } from './bhagavatamEmbeddings.mjs';

const DEFAULT_REMOTE_VERSES_URL =
  'https://atlanta.godivinity.org/srimad-bhagavatham-search/data/verses.json';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_ANSWER_TIMEOUT_MS = 15000;
const SEMANTIC_CONFIDENCE_THRESHOLD = 0.45;
const MAX_MULTI_REFERENCE_CANDIDATES = 256;
const MAX_MULTI_REFERENCE_HITS = 96;
const LOCAL_VERSES_CACHE_URL = new URL('./sbm_context_search_cache/remote_verses.json', import.meta.url);
const SEARCH_GUIDE_URL = new URL('./Bhagavatham-Search-Data/search-guide.json', import.meta.url);
const CONCEPT_INDEX_URL = new URL('./Bhagavatham-Search-Data/concept-index.json', import.meta.url);

const loadJsonIndex = async ({ url, label, collectionKey }) => {
  try {
    const raw = await fs.readFile(url, 'utf8');
    const payload = JSON.parse(raw);
    return {
      schemaVersion: Number(payload?.schema_version || 0),
      entries: Array.isArray(payload?.[collectionKey]) ? payload[collectionKey] : []
    };
  } catch (error) {
    console.error(`${label} unavailable:`, error);
    return {
      schemaVersion: 0,
      entries: []
    };
  }
};

const SEARCH_GUIDE = await loadJsonIndex({
  url: SEARCH_GUIDE_URL,
  label: 'Bhagavatam search guide',
  collectionKey: 'entries'
});
const CONCEPT_INDEX = await loadJsonIndex({
  url: CONCEPT_INDEX_URL,
  label: 'Bhagavatam concept index',
  collectionKey: 'concepts'
});
const SEARCH_GUIDE_ENTRIES = SEARCH_GUIDE.entries;
const CONCEPT_ENTRIES = CONCEPT_INDEX.entries;
const SEARCH_GUIDE_TERMS_BY_REFERENCE = new Map();
const CONCEPT_TERMS_BY_REFERENCE = new Map();

for (const entry of SEARCH_GUIDE_ENTRIES) {
  const guideText = [
    entry.display_name,
    entry.description,
    ...(entry.aliases || []),
    ...(entry.search_terms || [])
  ]
    .filter(Boolean)
    .join('\n');
  for (const reference of entry.indexed_references || entry.references || []) {
    const existing = SEARCH_GUIDE_TERMS_BY_REFERENCE.get(reference) || [];
    existing.push(guideText);
    SEARCH_GUIDE_TERMS_BY_REFERENCE.set(reference, existing);
  }
}

for (const concept of CONCEPT_ENTRIES) {
  const conceptText = [
    concept.display_name,
    concept.definition,
    ...(concept.aliases || []),
    ...(concept.search_terms || [])
  ]
    .filter(Boolean)
    .join('\n');
  for (const evidence of concept.evidence || []) {
    for (const reference of evidence.references || []) {
      const existing = CONCEPT_TERMS_BY_REFERENCE.get(reference) || [];
      existing.push(conceptText, evidence.description);
      CONCEPT_TERMS_BY_REFERENCE.set(reference, existing.filter(Boolean));
    }
  }
}

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
  'verses',
  'sloka',
  'slokha',
  'shloka',
  'shlokha',
  'vague',
  'vaguely',
  'remember',
  'remembered',
  'famous',
  'less',
  'detail',
  'details',
  'involving',
  'well',
  'known',
  'main',
  'point',
  'capture',
  'captures',
  'essence',
  'popular',
  'central',
  'teaching',
  'teachings'
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
  ['demigod', ['demigods', 'devata', 'devatas', 'deva', 'devas', 'suras']],
  ['demigods', ['demigod', 'devata', 'devatas', 'deva', 'devas', 'suras']],
  ['devotee', ['devotees', 'bhakta', 'bhaktas']],
  ['devotees', ['devotee', 'bhakta', 'bhaktas']],
  ['enthusiasm', ['eager', 'eagerness', 'inquisitive', 'inquisitiveness', 'questions']],
  ['hear', ['hearing', 'sravana', 'sravanam']],
  ['hearing', ['hear', 'sravana', 'sravanam']],
  ['krsna', ['krishna']],
  ['krishna', ['krsna']],
  ['learn', ['hear', 'inquire', 'question', 'questions']],
  ['narasimha', ['nrsimha', 'nrsimhadeva', 'narahari', 'prahlada', 'hiranyakasipu', 'pillar']],
  ['nrsimha', ['narasimha', 'nrsimhadeva', 'narahari', 'prahlada', 'hiranyakasipu', 'pillar']],
  ['putana', ['putana', 'poison', 'demoness', 'breast']],
  ['saranagati', ['surrender', 'surrendered', 'shelter', 'prayed', 'prayers']],
  ['sharanagati', ['surrender', 'surrendered', 'shelter', 'prayed', 'prayers']],
  ['varaha', ['boar', 'earth', 'nostril', 'tusk']]
]);

const QUERY_ALIAS_EXPANSIONS = [
  {
    aliases: ['narada muni', 'narad muni', 'narada rishi', 'narada rsi', 'devarshi narada', 'devarsi narada'],
    lexical_queries: ['Narada', 'Devarsi Narada']
  },
  {
    aliases: [
      'vyasa bhagavan',
      'bhagavan vyasa',
      'vyasa muni',
      'vyasa deva',
      'vyas bhagavan',
      'veda vyasa',
      'veda-vyasa',
      'vedavyasa'
    ],
    lexical_queries: ['Vyasadeva', 'Vedavyasa', 'Badarayana', 'Dvaipayana']
  },
  {
    aliases: [
      'shuka muni',
      'suka muni',
      'shukha muni',
      'sukha muni',
      'shukhamuni',
      'sukhamuni',
      'shuka rishi',
      'suka rishi',
      'shuka swami',
      'suka swami',
      'shukadeva swami',
      'sukadeva swami',
      'shukadev',
      'sukadev'
    ],
    lexical_queries: ['Sukadeva Gosvami', 'Sri Suka', 'Suka', 'Vyasa-sunu', 'son of Vyasadeva']
  },
  {
    aliases: ['parikshit', 'pariksit', 'maharaja parikshit', 'maharaja pariksit', 'king parikshit', 'king pariksit'],
    lexical_queries: ['Pariksit', 'Maharaja Pariksit', 'King Pariksit']
  },
  {
    aliases: ['krishna paramatma', 'krsna paramatma', 'krishna as paramatma', 'krsna as paramatma'],
    lexical_queries: ['Krishna Supersoul', 'Paramatma', 'Supersoul', "Lord in everyone's heart"]
  }
];

const TOKEN_EQUIVALENTS = new Map([
  ['bhagavatham', 'bhagavatam'],
  ['geeta', 'gita'],
  ['geetha', 'gita'],
  ['geetam', 'gita'],
  ['geetham', 'gita'],
  ['gitam', 'gita'],
  ['goswami', 'gosvami'],
  ['krsna', 'krishna'],
  ['parikshit', 'pariksit'],
  ['narasimha', 'nrsimha'],
  ['narsimha', 'nrsimha'],
  ['nrisimha', 'nrsimha'],
  ['nrsimhadeva', 'nrsimha'],
  ['avatharam', 'avatara'],
  ['avathara', 'avatara'],
  ['deva', 'demigod'],
  ['devas', 'demigods'],
  ['devata', 'demigod'],
  ['devatas', 'demigods'],
  ['geetham', 'gita'],
  ['roopa', 'rupa'],
  ['sathsang', 'satsanga'],
  ['sathsanga', 'satsanga'],
  ['sathsangam', 'satsanga'],
  ['satsang', 'satsanga'],
  ['satsangam', 'satsanga'],
  ['sharanaagathi', 'saranagati'],
  ['sharanaagati', 'saranagati'],
  ['sharanagathi', 'saranagati'],
  ['saranaagathi', 'saranagati'],
  ['saranagathi', 'saranagati'],
  ['sharanagati', 'saranagati'],
  ['samrakshanam', 'samrakshana'],
  ['viraham', 'viraha'],
  ['shlokha', 'sloka'],
  ['shloka', 'sloka'],
  ['slokha', 'sloka'],
  ['slokam', 'sloka'],
  ['sthuthi', 'stuti'],
  ['sthuti', 'stuti'],
  ['stuthi', 'stuti']
]);

const RETROSPECTIVE_CUES = [
  'previously',
  'formerly',
  'as mentioned',
  'as described',
  'has been described',
  'remembering',
  'remembered',
  'in the past',
  'later',
  'hearing of'
];

const EVENT_ACTION_GROUPS = [
  ['appear', 'appeared', 'appearance', 'birth', 'born'],
  ['kill', 'killed', 'killing', 'slay', 'slays', 'slain', 'defeat', 'defeated'],
  ['give', 'gave', 'given', 'name', 'named', 'naming', 'call', 'called', 'coronate', 'coronation'],
  ['pray', 'prayer', 'prayers', 'worship', 'worshiped', 'surrender', 'surrendered'],
  ['take', 'took', 'takes', 'lift', 'lifted', 'rescue', 'rescued', 'deliver', 'delivered'],
  ['meet', 'meets', 'meeting', 'arrive', 'arrives', 'arrival', 'visit', 'visits']
];

const OCCURRENCE_RULES = [
  {
    id: 'gajendra-prayer-opening',
    required_groups: [
      ['gajendra', 'elephant'],
      ['begin', 'beginning', 'start', 'steady', 'previous']
    ],
    references: ['SB 8.3.1'],
    display_name: 'Gajendra begins his remembered prayer',
    description: 'SB 8.3.1 is the opening moment where Gajendra steadies his mind and begins the remembered prayer.'
  },
  {
    id: 'gajendra-primary-prayer',
    required_groups: [
      ['gajendra', 'elephant'],
      ['pray', 'prayer', 'call', 'calling', 'surrender', 'narayana'],
      ['crocodile', 'held', 'trapped']
    ],
    references: ['SB 8.3.2'],
    display_name: 'Gajendra’s primary prayer to the Lord',
    description: 'The primary prayer occurrence is SB 8.3.2; later catalog or retrospective mentions must not replace it.'
  },
  {
    id: 'govinda-naming',
    required_groups: [
      ['govinda'],
      ['give', 'gave', 'given', 'name', 'named', 'naming', 'call', 'called', 'coronate', 'coronation']
    ],
    references: ['SB 10.27.22', 'SB 10.27.23'],
    display_name: 'Indra gives Kṛṣṇa the name Govinda',
    description: 'The naming/coronation event occurs in SB 10.27.22-23; SB 10.28.8 is only a later address.'
  },
  {
    id: 'narada-curse-occurrence',
    required_groups: [
      ['curse', 'cursed', 'sentence', 'sentenced'],
      ['nalakuvara', 'nalakubara', 'manigriva', 'trees', 'tree', 'kubera'],
      ['actual', 'actually', 'punish', 'punished', 'become']
    ],
    references: ['SB 10.10.21', 'SB 10.10.23'],
    display_name: 'Nārada curses Nalakūvara and Maṇigrīva',
    description: 'The actual curse occurs in SB 10.10.21-23; later references to the curse are not the primary occurrence.'
  }
];

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

const FOLLOW_UP_PREFIX_PATTERNS = [
  /^(?:what|how|where|who)\s+about\b/,
  /^(?:what|where|who)\s+else\b/,
  /^which\s+one\b/,
  /^(?:and|also|then)\b/,
  /^(?:again|another|else|same)\b/,
  /^(?:he|her|him|it|same|that|there|they|this|those)\b/
];

const NAMED_PASSAGE_ALIASES = [
  {
    aliases: [
      'venu gita',
      'venu gitam',
      'song of krishna flute',
      'song of krsna flute',
      "krishna's flute",
      'krishnas flute',
      'krishna flute',
      'his flute'
    ],
    display_name: 'Venu Gita',
    chapter_reference: 'SB 10.21',
    lead_reference: 'SB 10.21.3',
    chapter_title: "The Gopīs Glorify the Song of Kṛṣṇa’s Flute",
    references: ['SB 10.21.3', 'SB 10.21.5', 'SB 10.21.9']
  },
  {
    aliases: ['yugala gita', 'yugala gitam'],
    display_name: 'Yugala Gita',
    chapter_reference: 'SB 10.35',
    lead_reference: 'SB 10.35.1',
    chapter_title: 'The Gopīs Sing of Kṛṣṇa as He Wanders in the Forest',
    references: ['SB 10.35.1', 'SB 10.35.6', 'SB 10.35.15']
  },
  {
    aliases: [
      'pranaya gita',
      'pranaya gitam',
      'pranaya geeta',
      'pranaya geetha',
      'pranaya geetham',
      'song of love',
      'pranayagita',
      'pranayageetham'
    ],
    display_name: 'Pranaya Gita',
    chapter_reference: 'SB 10.29',
    lead_reference: 'SB 10.29.31',
    chapter_title: 'The Gopis Go to Krishna',
    references: ['SB 10.29.31', 'SB 10.29.32', 'SB 10.29.40']
  },
  {
    aliases: [
      'birth of krishna',
      'birth of sri krishna',
      'birth of lord krishna',
      'birth of krsna',
      'birth of sri krsna',
      'birth of lord krsna',
      'krishna is born',
      'krsna is born',
      'krishna born',
      'krsna born',
      'bhagavan sri krishna is born',
      'bhagavan sri krsna is born',
      'appearance of krishna',
      'appearance of lord krishna',
      'appearance of krsna',
      'appearance of lord krsna'
    ],
    display_name: 'The birth of Lord Kṛṣṇa',
    chapter_reference: 'SB 10.3',
    lead_reference: 'SB 10.3.8',
    chapter_title: 'The Birth of Lord Kṛṣṇa',
    references: ['SB 10.3.8', 'SB 10.3.9', 'SB 10.3.46']
  },
  {
    aliases: [
      'rama avatar',
      'rama avatara',
      'rama avathara',
      'rama avatharam',
      'ram avatar',
      'ram avatara',
      'ramachandra avatar',
      'ramachandra avatara',
      'ramacandra avatar',
      'ramacandra avatara',
      'appearance of rama',
      'appearance of lord rama',
      'appearance of ramachandra',
      'appearance of ramacandra',
      'lord rama appear',
      'lord rama appears',
      'rama appear',
      'rama appears',
      'birth of rama',
      'birth of lord rama',
      'rama avatar happen',
      'rama avatara happen'
    ],
    display_name: 'The appearance of Lord Rāmacandra',
    chapter_reference: 'SB 9.10',
    lead_reference: 'SB 9.10.2',
    chapter_title: 'The Pastimes of the Supreme Lord, Rāmacandra',
    references: ['SB 9.10.2', 'SB 9.10.3']
  },
  {
    aliases: [
      'narasimha avatar',
      'narsimha avatar',
      'nrsimha avatar',
      'narasimha avatara',
      'narsimha avatara',
      'nrsimha avatara',
      'appearance of narasimha',
      'appearance of narsimha',
      'appearance of nrsimha',
      'narasimha appears',
      'narsimha appears',
      'nrsimha appears',
      'lord narasimha appears',
      'lord nrsimha appears',
      'narasimha avatar happen',
      'nrsimha avatar happen'
    ],
    display_name: 'The appearance of Lord Nṛsiṁha',
    chapter_reference: 'SB 7.8',
    lead_reference: 'SB 7.8.17',
    chapter_title: 'Lord Nṛsiṁhadeva Slays the King of the Demons',
    references: ['SB 7.8.17', 'SB 7.8.18', 'SB 7.8.29']
  },
  {
    aliases: [
      'krishna lifts govardhana',
      'krishna lift govardhana',
      'krishna lifts govardhan',
      'krishna lift govardhan',
      'krishna lifts govardhana hill',
      'krishna lift govardhana hill',
      'krishna lifts govardana mountain',
      'krishna lift govardana mountain',
      'lifting govardhana hill',
      'lifting govardana mountain',
      'govardhana lifting',
      'govardhana lila'
    ],
    display_name: 'Kṛṣṇa lifts Govardhana Hill',
    chapter_reference: 'SB 10.25',
    lead_reference: 'SB 10.25.19',
    chapter_title: 'Lord Kṛṣṇa Lifts Govardhana Hill',
    references: ['SB 10.25.19', 'SB 10.25.20', 'SB 10.25.25']
  },
  {
    aliases: [
      'gopi gita',
      'gopi gitam',
      'gopika gita',
      'gopika gitam',
      'gopis sing in separation after krishna disappears from the rasa dance',
      'gopis sing in separation after krishna disappears from rasa dance',
      'gopis sing in separation after krishna disappears',
      'krishna disappears from the rasa dance',
      'krishna disappears from rasa dance',
      'after krishna disappears from the rasa dance',
      'after krishna disappears from rasa dance'
    ],
    display_name: 'Gopi Gita',
    chapter_reference: 'SB 10.31',
    lead_reference: 'SB 10.31.1',
    chapter_title: 'The Gopīs’ Songs of Separation',
    references: ['SB 10.31.1', 'SB 10.31.9', 'SB 10.31.19']
  },
  {
    aliases: [
      'gopis begin the rasa dance',
      'gopis begin rasa dance',
      'beginning of the rasa dance',
      'beginning of rasa dance',
      'rasa dance begins',
      'rasa dance begin',
      'gopis begin the rasa dance with krishna',
      'gopis begin rasa dance with krishna',
      'krishna begins the rasa dance'
    ],
    display_name: 'The beginning of the Rāsa dance',
    chapter_reference: 'SB 10.33',
    lead_reference: 'SB 10.33.2',
    chapter_title: 'The Rāsa Dance',
    references: ['SB 10.33.2', 'SB 10.33.3', 'SB 10.33.5']
  },
  {
    aliases: [
      'bhramara gita',
      'bhramara gitam',
      'bhramara geeta',
      'bhramara geetha',
      'bhramara geetham',
      'bramara gita',
      'bramara gitam',
      'bramara geeta',
      'bramara geetha',
      'bramara geetham',
      'song of the bee',
      'bee song'
    ],
    display_name: 'Bhramara Gita',
    chapter_reference: 'SB 10.47',
    lead_reference: 'SB 10.47.12',
    chapter_title: 'The Song of the Bee',
    references: ['SB 10.47.12', 'SB 10.47.17', 'SB 10.47.21']
  },
  {
    aliases: [
      'pancha geetham',
      'pancha geetam',
      'pancha gita',
      'pancha geethams',
      'panchageetham',
      'panchageetam',
      'panchagita',
      'five gitas'
    ],
    display_name: 'Pancha Geetham',
    answer_style: 'collection',
    reference_summary:
      'SB 10.21 (Venu Gita), SB 10.29.31-41 (Pranaya Gita), SB 10.31 (Gopi Gita), SB 10.35 (Yugala Gita), and SB 10.47.12-21 (Bhramara Gita)',
    lead_reference: 'SB 10.21.3',
    references: ['SB 10.21.3', 'SB 10.29.31', 'SB 10.31.1', 'SB 10.35.1', 'SB 10.47.12']
  },
  {
    aliases: [
      'prayers of queen kunti',
      'queen kunti prayers',
      'kunti prayers',
      'kunti stuti',
      'kunti sthuthi',
      'queen kuntis prayers'
    ],
    display_name: 'Kunti Stuti',
    chapter_reference: 'SB 1.8',
    lead_reference: 'SB 1.8.18',
    chapter_title: 'Prayers by Queen Kuntī and Parīkṣit Saved',
    references: ['SB 1.8.18', 'SB 1.8.26', 'SB 1.8.43']
  },
  {
    aliases: [
      'bhishma stuti',
      'bhishma sthuthi',
      'bhisma stuti',
      'bhisma sthuthi',
      'bhishmastuti',
      'bhismastuti',
      'bhishma prayers'
    ],
    display_name: 'Bhishma Stuti',
    chapter_reference: 'SB 1.9',
    lead_reference: 'SB 1.9.32',
    chapter_title: 'The Passing Away of Bhisma Deva in the Presence of Lord Krishna',
    references: ['SB 1.9.32', 'SB 1.9.38', 'SB 1.9.42']
  },
  {
    aliases: [
      'prahlada stuti',
      'prahalada stuti',
      'prahlada stuthi',
      'prahalada stuthi',
      'prahlada sthuthi',
      'prahalada sthuthi',
      'prahladastuti',
      'prahaladastuti',
      'prahlada prayers',
      'prahalada prayers',
      'prahlada stava',
      'prahalada stava'
    ],
    display_name: 'Prahlada Stuti',
    chapter_reference: 'SB 7.9',
    lead_reference: 'SB 7.9.8',
    chapter_title: 'Prahlada Pacifies Lord Nrsimhadeva with Prayers',
    references: ['SB 7.9.8', 'SB 7.9.24', 'SB 7.9.43']
  },
  {
    aliases: [
      'gajendra stuti',
      'gajendra sthuthi',
      'gajendra prayers',
      'gajendra moksha prayers',
      'gajendrastuti'
    ],
    display_name: 'Gajendra Stuti',
    chapter_reference: 'SB 8.3',
    lead_reference: 'SB 8.3.1',
    chapter_title: "Gajendra's Prayers of Surrender",
    references: ['SB 8.3.1', 'SB 8.3.2', 'SB 8.3.29']
  },
  {
    aliases: [
      'pancha stuti',
      'pancha sthuthi',
      'pancha stuthi',
      'panchastuti',
      'panchasthuthi',
      'five stutis',
      'five prayers'
    ],
    display_name: 'Pancha Stuti',
    answer_style: 'collection',
    reference_summary:
      'SB 1.8.18-43 (Kunti Stuti), SB 1.9.32-42 (Bhishma Stuti), SB 7.9.8-50 (Prahlada Stuti), SB 8.3.1-29 (Gajendra Stuti), and SB 10.14 (Brahma Stuti)',
    lead_reference: 'SB 1.8.18',
    references: ['SB 1.8.18', 'SB 1.9.32', 'SB 7.9.8', 'SB 8.3.1', 'SB 10.14.1']
  },
  {
    aliases: [
      'narayana kavacham',
      'narayana kavacha',
      'narayana kavach',
      'narayanakavacham',
      'narayanakavacha',
      'narayanakavach',
      'narayana kavaca',
      'narayanakavaca',
      'narayana kavaca shield',
      'the narayana kavaca shield'
    ],
    display_name: 'Narayana Kavacham',
    chapter_reference: 'SB 6.8',
    lead_reference: 'SB 6.8.4',
    chapter_title: 'The Narayana-kavaca Shield',
    references: ['SB 6.8.4', 'SB 6.8.7', 'SB 6.8.12']
  },
  {
    aliases: [
      'brahma stuti',
      'brahma prayers to krishna',
      'brahmas prayers to lord krishna',
      'brahma stuti to krishna',
      'brahma realizes krishnas supremacy after stealing the calves',
      'brahma realizes krishna supremacy after stealing the calves',
      'brahma realizes krsnas supremacy after stealing the calves',
      'brahma realizes krsna supremacy after stealing the calves',
      'brahma realizes krishnas supremacy after stealing the calves and cowherd boys',
      'brahma realizes krishna supremacy after stealing the calves and cowherd boys'
    ],
    display_name: 'Brahma Stuti',
    chapter_reference: 'SB 10.14',
    lead_reference: 'SB 10.14.1',
    chapter_title: 'Brahmā’s Prayers to Lord Kṛṣṇa',
    references: ['SB 10.14.1', 'SB 10.14.8', 'SB 10.14.14']
  },
  {
    aliases: [
      'brahma prayers for creative energy',
      "brahma's prayers for creative energy",
      'brahma stuti creative energy',
      'brahma prayers canto 3'
    ],
    display_name: "Brahmā's Prayers for Creative Energy",
    chapter_reference: 'SB 3.9',
    lead_reference: 'SB 3.9.11',
    chapter_title: 'Brahmā’s Prayers for Creative Energy',
    references: ['SB 3.9.11', 'SB 3.9.18', 'SB 3.9.24']
  },
  {
    aliases: [
      "krishna's beauty",
      'krishna beauty',
      "describe krishna's beauty",
      'describe krishna beauty',
      'beauty of krishna',
      'his beauty',
      'beautiful form of krishna',
      'verses describing krishna beauty',
      'slokas describing krishna beauty'
    ],
    display_name: "Kṛṣṇa's beauty",
    answer_style: 'theme',
    references: ['SB 10.21.5', 'SB 10.21.12', 'SB 10.44.14']
  },
  {
    aliases: [
      'vanabhojana',
      'vana bhojana',
      'krishna vanabhojana with all the gopas',
      'krishna did vanabhojana with all the gopas',
      'krishna vanabhojana with the gopas',
      'vanabhojana with the gopas',
      'forest picnic with krishna and the gopas',
      'krishna forest picnic with the gopas',
      'krishna taking lunch with the cowherd boys',
      'krishna takes lunch with the cowherd boys',
      'krishna lunch with the cowherd boys',
      'krishna eating lunch with the cowherd boys',
      'krishna lunch with the gopas',
      'krishna eating with the gopas in the forest'
    ],
    display_name: "Kṛṣṇa's forest picnic lunch with the gopas",
    chapter_reference: 'SB 10.13',
    lead_reference: 'SB 10.13.11',
    chapter_title: 'The Stealing of the Boys and Calves by Brahmā',
    references: ['SB 10.13.11', 'SB 10.13.10', 'SB 10.12.1']
  },
  {
    aliases: [
      'akrura first arrives in vrindavan',
      'akrura arrives in vrindavan',
      'akrura first arrives in vraja',
      'akrura arrives in vraja',
      'akrura first see krishna and balarama in vraja',
      'akrura first see krishna and balaram in vraja',
      'akrura first see krishna and balarama in vrindavan',
      'akrura first see krishna and balaram in vrindavan',
      'akrura first sees krishna and balarama in vraja',
      'akrura first sees krishna and balaram in vraja',
      'akrura first sees krishna and balarama in vrindavan',
      'akrura first sees krishna and balaram in vrindavan',
      'akrura meets krishna and balarama in vraja',
      'akrura meets krishna and balaram in vraja',
      'akrura meets krishna and balarama in vrindavan',
      'akrura meets krishna and balaram in vrindavan'
    ],
    display_name: 'Akrūra arrives in Vṛndāvana and meets Kṛṣṇa and Balarāma',
    chapter_reference: 'SB 10.38',
    lead_reference: 'SB 10.38.34',
    chapter_title: 'Akrūra’s Arrival in Vṛndāvana',
    references: ['SB 10.38.34', 'SB 10.38.36', 'SB 10.38.37']
  },
  {
    aliases: [
      'akrura go and get krishna and balaram to bring them to mathura',
      'akrura bring krishna and balaram to mathura',
      'akrura bring krishna and balarama to mathura',
      'akrura take krishna and balaram to mathura',
      'akrura take krishna and balarama to mathura',
      'akrura taking krishna and balaram to mathura',
      'akrura taking krishna and balarama to mathura',
      'akrura pick up krishna and balaram for mathura',
      'akrura pick up krishna and balarama for mathura',
      'akrura sent to bring krishna and balaram to mathura',
      'akrura sent to bring krishna and balarama to mathura',
      'akrura fetch krishna and balaram for mathura',
      'akrura fetch krishna and balarama for mathura',
      'akrura brings krishna and balaram to mathura',
      'akrura brings krishna and balarama to mathura'
    ],
    display_name: 'Akrūra fetching Kṛṣṇa and Balarāma for Mathurā',
    chapter_reference: 'SB 10.38',
    lead_reference: 'SB 10.38.1',
    chapter_title: 'Akrūra’s Arrival in Vṛndāvana',
    references: ['SB 10.38.1', 'SB 10.38.34', 'SB 10.39.40'],
    secondary_chapter_reference: 'SB 10.39',
    secondary_chapter_title: 'Akrūra’s Vision'
  },
  {
    aliases: [
      'krishna leaves for mathura with akrura',
      'krishna leave for mathura with akrura',
      'krishna leaves for mathura',
      'krishna leave for mathura',
      'krishna departs for mathura with akrura',
      'krishna departs for mathura',
      'krishna goes to mathura with akrura',
      'akrura takes krishna from vraja to mathura',
      'akrura takes krishna from vrindavan to mathura'
    ],
    display_name: 'Kṛṣṇa departs for Mathurā with Akrūra',
    chapter_reference: 'SB 10.39',
    lead_reference: 'SB 10.39.32',
    chapter_title: 'Akrūra’s Vision',
    references: ['SB 10.39.32', 'SB 10.39.33', 'SB 10.39.38']
  },
  {
    aliases: [
      'uddhava first comes to vrindavan',
      'uddhava first comes to vraja',
      'uddhava first arrives in vrindavan',
      'uddhava first arrives in vraja',
      'uddhava visits vrindavan',
      'uddhava comes to vrindavan',
      'uddhava comes to vraja'
    ],
    display_name: 'Uddhava first comes to Vṛndāvana',
    chapter_reference: 'SB 10.46',
    lead_reference: 'SB 10.46.8',
    chapter_title: 'Uddhava Visits Vṛndāvana',
    references: ['SB 10.46.8', 'SB 10.46.14', 'SB 10.46.15']
  },
  {
    aliases: [
      'vamana asks bali for three steps of land',
      'vamana asks bali for three paces of land',
      'vamana begs bali for three steps of land',
      'vamana begs bali for three paces of land',
      'vamanadeva asks bali for three steps of land',
      'vamanadeva asks bali for three paces of land',
      'vamanadeva begs charity from bali',
      'three steps of land from bali'
    ],
    display_name: 'Vāmanadeva asks Bali Mahārāja for three steps of land',
    chapter_reference: 'SB 8.19',
    lead_reference: 'SB 8.19.16',
    chapter_title: 'Lord Vāmanadeva Begs Charity from Bali Mahārāja',
    references: ['SB 8.19.16', 'SB 8.19.17', 'SB 8.19.20']
  },
  {
    aliases: [
      'krishna lifts the bow in mathura before killing kamsa',
      'krishna breaks the bow in mathura before killing kamsa',
      'krishna breaks the sacrificial bow in mathura',
      'krishna breaks the bow in mathura',
      'krishna lifts the sacrificial bow in mathura',
      'breaking of the sacrificial bow'
    ],
    display_name: 'Kṛṣṇa breaks the sacrificial bow in Mathurā',
    chapter_reference: 'SB 10.42',
    lead_reference: 'SB 10.42.17',
    chapter_title: 'The Breaking of the Sacrificial Bow',
    references: ['SB 10.42.17', 'SB 10.42.18', 'SB 10.42.21']
  },
  {
    aliases: [
      'krishna kills kamsa',
      'krishna kills kansa',
      'the killing of kamsa',
      'the killing of kansa',
      'where krishna kills kamsa',
      'where krishna kills kansa'
    ],
    display_name: 'Kṛṣṇa kills Kaṁsa',
    chapter_reference: 'SB 10.44',
    lead_reference: 'SB 10.44.37',
    chapter_title: 'The Killing of Kaṁsa',
    references: ['SB 10.44.34', 'SB 10.44.37', 'SB 10.44.38']
  },
  {
    aliases: [
      'krishna kills keshi',
      'krishna kills kesi',
      'the killing of keshi',
      'the killing of kesi',
      'keshi demon',
      'kesi demon'
    ],
    display_name: 'Kṛṣṇa kills Keśī',
    chapter_reference: 'SB 10.37',
    lead_reference: 'SB 10.37.7',
    chapter_title: 'The Killing of the Demons Keśi and Vyoma',
    references: ['SB 10.37.3', 'SB 10.37.5', 'SB 10.37.7']
  },
  {
    aliases: [
      'dhruva first meets narada',
      'dhruva meets narada',
      'narada first meets dhruva',
      'narada instructs dhruva'
    ],
    display_name: 'Dhruva first meets Nārada',
    chapter_reference: 'SB 4.8',
    lead_reference: 'SB 4.8.39',
    chapter_title: 'Dhruva Mahārāja Leaves Home for the Forest',
    references: ['SB 4.8.39', 'SB 4.8.40', 'SB 4.8.54']
  },
  {
    aliases: [
      'narada curses nalakuvara and manigriva',
      'narada curse nalakuvara and manigriva',
      'narada cursing nalakuvara and manigriva',
      'narada cursed nalakuvara and manigriva',
      'narada curses nalakubara and manigriva',
      'narada curse nalakubara and manigriva',
      'narada cursing nalakubara and manigriva',
      'narada cursed nalakubara and manigriva',
      'narada curses nalakuvara and manigreeva',
      'narada curse nalakuvara and manigreeva',
      'narada cursing nalakuvara and manigreeva',
      'narada cursed nalakuvara and manigreeva',
      'nalakuvara and manigriva cursed by narada',
      'nalakubara and manigriva cursed by narada',
      'nalakuvara and manigreeva cursed by narada',
      'narada curse on nalakuvara and manigriva',
      'narada curse on nalakubara and manigriva',
      'where does narada curse nalakuvara and manigriva',
      'where does narada curse nalakubara and manigriva',
      'where narada curses nalakuvara and manigriva',
      'where narada cursed nalakuvara and manigriva',
      'where narada curses nalakubara and manigriva',
      'where narada cursed nalakubara and manigriva',
      'which verse is narada cursing nalakuvara and manigriva',
      'which verse is narada cursing nalakubara and manigriva'
    ],
    display_name: 'Nārada curses Nalakūvara and Maṇigrīva',
    chapter_reference: 'SB 10.10',
    lead_reference: 'SB 10.10.21',
    chapter_title: 'The Deliverance of the Yamala-arjuna Trees',
    references: ['SB 10.10.20', 'SB 10.10.21', 'SB 10.10.23']
  }
];

const MULTI_REFERENCE_PRESETS = [
  {
    aliases: [
      'which shlokas does shukhamuni appreciate pariksits enthusiasm to learn more',
      'which shlokas does sukhamuni appreciate pariksits enthusiasm to learn more',
      'where does sukadeva appreciate pariksits eagerness to hear more',
      'where does sukadeva appreciate pariksits questions',
      'where does shukadeva appreciate pariksits questions',
      'pariksit asks the right questions',
      'parikshit asks the right questions',
      'please continue narrating bhagavatam',
      'soul surrendered unto you please impart full knowledge'
    ],
    display_name: "Śukadeva appreciating Parīkṣit's eagerness to hear more",
    references: ['SB 2.8.2', 'SB 2.8.3', 'SB 2.8.24', 'SB 2.8.29']
  },
  {
    aliases: [
      'where all do the devatas do saranagati to bhagavan to ask him to do an avatara',
      'where all do the devatas do sharanagati to bhagavan to ask him to do an avatara',
      'where all do the demigods pray to ask the lord to descend',
      'where all do the demigods surrender to bhagavan to ask him to appear',
      'all instances where the devatas surrender to bhagavan to ask him to do an avatara',
      'all instances where the devatas surrender to bhagavan to ask him to descend',
      'all instances where the demigods surrender to bhagavan to ask him to descend',
      'each place that the devatas surrender to bhagavan to ask him to descend',
      'each place where the devatas surrender to bhagavan to ask him to descend',
      'each place that the demigods surrender to bhagavan to ask him to descend',
      'demigods pray for the lord to descend',
      'demigods pray for krishna in the womb',
      'devatas ask bhagavan to remove the burden of the earth'
    ],
    display_name: 'Demigods surrendering to Bhagavan to request His descent',
    references: ['SB 10.1.19', 'SB 10.2.25', 'SB 10.2.26', 'SB 11.6.21', 'SB 11.6.28']
  }
];

const normalizeWhitespace = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const stripUiActionPhrases = (value) =>
  normalizeWhitespace(
    String(value ?? '')
      .replace(/\bopen\s+in\s+vedabase\b/gi, ' ')
  );

const coercePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeForSearch = (value) =>
  normalizeWhitespace(
    stripUiActionPhrases(value)
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/['’]/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .toLowerCase()
  );

const compactForSearch = (value) => normalizeForSearch(value).replace(/\s+/g, '');

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

  const normalized = normalizeForSearch(value);
  for (const entry of QUERY_ALIAS_EXPANSIONS) {
    if (!entry.aliases.some((alias) => normalized.includes(normalizeForSearch(alias)))) continue;
    for (const lexicalQuery of entry.lexical_queries) {
      for (const token of tokenize(lexicalQuery)) expanded.add(token);
    }
  }
  return [...expanded];
};

const uniqueList = (values) => [...new Set(values.filter(Boolean))];

const extractJsonObject = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  return null;
};

const buildContextSummaryFallback = ({ query, hits = [], contextGroups = [] }) => {
  const verses = contextGroups.flat().filter(Boolean);
  const leadVerse = hits[0]?.verse || verses[0] || null;
  if (!leadVerse) {
    return `No strong Bhagavatam context was retrieved for "${normalizeWhitespace(query)}".`;
  }

  const references = uniqueList(verses.map((verse) => verse.reference)).slice(0, 3);
  const referenceSummary =
    references.length <= 1
      ? `Retrieved context centers on ${leadVerse.reference}`
      : references.length === 2
        ? `Retrieved context spans ${references[0]} and ${references[1]}`
        : `Retrieved context spans ${references[0]}, ${references[1]}, and ${references[2]}`;
  const chapterSummary = leadVerse.chapter_title ? ` in "${leadVerse.chapter_title}"` : '';
  const translationSnippet = normalizeWhitespace(leadVerse.translation || '');
  const compactSnippet =
    translationSnippet.length > 220 ? `${translationSnippet.slice(0, 217).trimEnd()}...` : translationSnippet;
  const detailSummary = compactSnippet ? ` The lead passage describes: ${compactSnippet}` : '';

  return `${referenceSummary}${chapterSummary}.${detailSummary}`;
};

const findQueryAliasExpansions = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return [];

  return QUERY_ALIAS_EXPANSIONS.filter((entry) =>
    entry.aliases.some((alias) => normalized.includes(normalizeForSearch(alias)))
  );
};

const findBestAliasMatch = (entries, query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return null;
  const normalizedTokens = normalized.split(' ').filter(Boolean);

  let bestMatch = null;
  let bestIndex = -1;
  let bestAliasLength = -1;

  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizeForSearch(alias);
      if (!normalizedAlias) continue;
      const compactAlias = compactForSearch(alias);
      const rawAliasIndex = normalized.lastIndexOf(normalizedAlias);
      const aliasEndIndex = rawAliasIndex + normalizedAlias.length;
      const aliasIndex =
        rawAliasIndex !== -1 &&
        (rawAliasIndex === 0 || normalized[rawAliasIndex - 1] === ' ') &&
        (aliasEndIndex === normalized.length || normalized[aliasEndIndex] === ' ')
          ? rawAliasIndex
          : -1;
      const compactAliasIndex = compactAlias && normalizedTokens.includes(compactAlias)
        ? normalized.lastIndexOf(compactAlias)
        : -1;
      const matchIndex = aliasIndex !== -1 ? aliasIndex : compactAliasIndex;
      const matchLength = aliasIndex !== -1 ? normalizedAlias.length : compactAlias.length;
      if (matchIndex === -1) continue;
      if (matchIndex > bestIndex || (matchIndex === bestIndex && matchLength > bestAliasLength)) {
        bestMatch = entry;
        bestIndex = matchIndex;
        bestAliasLength = matchLength;
      }
    }
  }

  return bestMatch;
};

const containsConceptAlias = (normalizedQuery, alias) => {
  const normalizedAlias = normalizeForSearch(alias);
  if (!normalizedQuery || !normalizedAlias) return false;
  const paddedQuery = ` ${normalizedQuery} `;
  if (paddedQuery.includes(` ${normalizedAlias} `)) return true;
  const compactAlias = compactForSearch(alias);
  if (compactAlias && normalizedQuery.split(' ').includes(compactAlias)) return true;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean).map(normalizeToken);
  const aliasTokens = normalizedAlias.split(' ').filter(Boolean).map(normalizeToken);
  if (!aliasTokens.length || aliasTokens.length > queryTokens.length) return false;
  return queryTokens.some((_, startIndex) =>
    aliasTokens.every((aliasToken, offset) => queryTokens[startIndex + offset] === aliasToken)
  );
};

const findConceptMatches = (query) => {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return [];

  return CONCEPT_ENTRIES.map((concept) => {
    const matchedAliases = (concept.aliases || []).filter((alias) =>
      containsConceptAlias(normalizedQuery, alias)
    );
    if (!matchedAliases.length) return null;
    matchedAliases.sort((left, right) => normalizeForSearch(right).length - normalizeForSearch(left).length);
    return {
      concept,
      matched_aliases: matchedAliases,
      strongest_alias: matchedAliases[0]
    };
  })
    .filter(Boolean)
    .sort(
      (left, right) =>
        normalizeForSearch(right.strongest_alias).length - normalizeForSearch(left.strongest_alias).length
    );
};

const CONCEPT_SUBJECT_ALIASES = uniqueList(
  CONCEPT_ENTRIES.flatMap((concept) =>
    (concept.evidence || []).flatMap((evidence) => evidence.subject_aliases || [])
  )
).sort((left, right) => normalizeForSearch(right).length - normalizeForSearch(left).length);

const findMentionedConceptSubjects = (query) => {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return [];
  const matches = [];
  for (const alias of CONCEPT_SUBJECT_ALIASES) {
    if (!containsConceptAlias(normalizedQuery, alias)) continue;
    if (
      matches.some(
        (existing) =>
          containsConceptAlias(normalizeForSearch(existing), alias) ||
          containsConceptAlias(normalizeForSearch(alias), existing)
      )
    ) {
      continue;
    }
    matches.push(alias);
  }
  return matches;
};

const findConceptEvidenceMatch = (conceptMatches, query) => {
  const normalizedQuery = normalizeForSearch(query);
  let bestMatch = null;

  for (const match of conceptMatches) {
    for (const evidence of match.concept.evidence || []) {
      const subjectMatches = (evidence.subject_aliases || []).filter((alias) =>
        containsConceptAlias(normalizedQuery, alias)
      );
      if (!subjectMatches.length) continue;
      const excluded = (evidence.exclude_hints || []).some((hint) =>
        containsConceptAlias(normalizedQuery, hint)
      );
      if (excluded) continue;
      const intentMatches = (evidence.intent_hints || []).filter((hint) =>
        containsConceptAlias(normalizedQuery, hint)
      );
      const score =
        10 +
        intentMatches.length * 3 +
        Math.min(4, normalizeForSearch(match.strongest_alias).split(' ').length);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          concept: match.concept,
          matched_aliases: match.matched_aliases,
          evidence,
          subject_matches: subjectMatches,
          intent_matches: intentMatches,
          score
        };
      }
    }
  }

  return bestMatch;
};

const buildConceptLexicalQueries = (conceptMatches, originalQuery) =>
  uniqueList(
    conceptMatches.flatMap(({ concept }) =>
      [
        `${originalQuery} ${concept.display_name}`,
        `${originalQuery} ${concept.definition}`,
        ...(concept.search_terms || []).map((searchTerm) => `${originalQuery} ${searchTerm}`)
      ].filter(Boolean)
    )
  ).slice(0, 16);

const serializeConceptMatches = (conceptMatches) =>
  conceptMatches.map(({ concept, matched_aliases: matchedAliases }) => ({
    id: concept.id,
    display_name: concept.display_name,
    family: concept.family,
    definition: concept.definition,
    matched_aliases: matchedAliases,
    evidence_references: uniqueList(
      (concept.evidence || []).flatMap((evidence) => evidence.references || [])
    )
  }));

const serializeConceptEvidenceMatch = (match) =>
  match
    ? {
        concept_id: match.concept.id,
        display_name: match.concept.display_name,
        evidence_id: match.evidence.id,
        lead_reference: match.evidence.lead_reference,
        references: match.evidence.references,
        description: match.evidence.description
      }
    : null;

const findNamedPassageAlias = (query) => findBestAliasMatch(NAMED_PASSAGE_ALIASES, query);

const findMultiReferencePreset = (query) => findBestAliasMatch(MULTI_REFERENCE_PRESETS, query);

const GUIDE_LOW_SIGNAL_TOKENS = new Set([
  'avatar',
  'avatara',
  'bhagavatam',
  'chapter',
  'exact',
  'find',
  'gita',
  'incarnation',
  'location',
  'passage',
  'prayer',
  'search',
  'sloka',
  'song',
  'stuti',
  'verse'
]);

const SEARCH_GUIDE_INDEX = SEARCH_GUIDE_ENTRIES.map((entry) => {
  const searchableText = [
    entry.display_name,
    entry.description,
    ...(entry.aliases || []),
    ...(entry.search_terms || [])
  ]
    .filter(Boolean)
    .join(' ');
  const subjectTokens = uniqueList(tokenize(entry.display_name || '')).filter(
    (token) => !GUIDE_LOW_SIGNAL_TOKENS.has(token)
  );
  const searchTokens = uniqueList(tokenize(searchableText, { expandSynonyms: true })).filter(
    (token) => !GUIDE_LOW_SIGNAL_TOKENS.has(token)
  );
  return {
    entry,
    subjectTokens,
    searchTokenSet: new Set(searchTokens)
  };
});

const SEARCH_GUIDE_TOKEN_FREQUENCIES = new Map();
for (const indexedEntry of SEARCH_GUIDE_INDEX) {
  for (const token of indexedEntry.searchTokenSet) {
    SEARCH_GUIDE_TOKEN_FREQUENCIES.set(token, (SEARCH_GUIDE_TOKEN_FREQUENCIES.get(token) || 0) + 1);
  }
}

const guideTokenWeight = (token) => {
  const frequency = SEARCH_GUIDE_TOKEN_FREQUENCIES.get(token) || 0;
  return Math.log(1 + (SEARCH_GUIDE_INDEX.length + 1) / (frequency + 1));
};

const findFuzzySearchGuideEntry = (query) => {
  const queryTokens = uniqueList(tokenize(query, { expandSynonyms: true })).filter(
    (token) => !GUIDE_LOW_SIGNAL_TOKENS.has(token)
  );
  if (!queryTokens.length) return null;

  const totalQueryWeight = queryTokens.reduce((sum, token) => sum + guideTokenWeight(token), 0) || 1;
  let bestEntry = null;
  let bestScore = 0;

  for (const indexedEntry of SEARCH_GUIDE_INDEX) {
    const matchedTokens = queryTokens.filter((token) => indexedEntry.searchTokenSet.has(token));
    if (!matchedTokens.length) continue;
    const matchedWeight = matchedTokens.reduce((sum, token) => sum + guideTokenWeight(token), 0);
    const weightedCoverage = matchedWeight / totalQueryWeight;
    const subjectCoverage = indexedEntry.subjectTokens.length
      ? indexedEntry.subjectTokens.filter((token) => queryTokens.includes(token)).length /
        indexedEntry.subjectTokens.length
      : 0;
    const categoryHint = normalizeForSearch(query).includes(indexedEntry.entry.category.replace('_', ' '))
      ? 0.08
      : 0;
    const score = weightedCoverage + subjectCoverage * 0.35 + categoryHint;
    const enoughEvidence =
      (matchedTokens.length >= 2 && weightedCoverage >= 0.52) ||
      (subjectCoverage >= 0.8 && weightedCoverage >= 0.38);

    if (enoughEvidence && score > bestScore) {
      bestEntry = indexedEntry.entry;
      bestScore = score;
    }
  }

  return bestEntry;
};

const findExactSearchGuideEntry = (query) => {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return null;

  let bestEntry = null;
  let bestAliasLength = -1;
  for (const entry of SEARCH_GUIDE_ENTRIES) {
    for (const alias of entry.aliases || []) {
      const normalizedAlias = normalizeForSearch(alias);
      if (normalizedAlias !== normalizedQuery) continue;
      if (normalizedAlias.length > bestAliasLength) {
        bestEntry = entry;
        bestAliasLength = normalizedAlias.length;
      }
    }
  }
  return bestEntry;
};

const findSearchGuideEntry = (query) =>
  findExactSearchGuideEntry(query) ||
  findBestAliasMatch(SEARCH_GUIDE_ENTRIES, query) ||
  findFuzzySearchGuideEntry(query);

const PASSAGE_RANGE_GUIDE_ENTRIES = SEARCH_GUIDE_ENTRIES.filter(
  (entry) => Array.isArray(entry.passage_ranges) && entry.passage_ranges.length && entry.passage_range_summary
);

const wantsPassageRange = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  const pluralVerseNoun = '(?:verses|slokas|slokhas|shlokas|shlokhas|texts)';
  return (
    new RegExp(`\\b${pluralVerseNoun}\\b.*\\bspan(?:s|ned)?\\b`).test(normalized) ||
    new RegExp(`\\b(?:which|what)\\s+${pluralVerseNoun}\\b.*\\b(?:range|span)\\b`).test(normalized) ||
    /\b(?:full|complete)\s+(?:verse|sloka|slokha|shloka|shlokha|text)\s+range\b/.test(normalized) ||
    /\b(?:where|which\s+verse)\b.*\b(?:begin|start)(?:s)?\b.*\b(?:end|finish)(?:es)?\b/.test(normalized)
  );
};

const findPassageRangeGuideEntry = (query) => {
  if (!wantsPassageRange(query)) return null;
  const exactEntry = findExactSearchGuideEntry(query);
  if (exactEntry?.passage_range_summary) return exactEntry;
  const aliasEntry = findBestAliasMatch(PASSAGE_RANGE_GUIDE_ENTRIES, query);
  if (aliasEntry) return aliasEntry;
  const fuzzyEntry = findFuzzySearchGuideEntry(query);
  return fuzzyEntry?.passage_range_summary ? fuzzyEntry : null;
};

const extractExplicitReference = (query) => {
  const normalized = normalizeWhitespace(query);
  const match =
    normalized.match(/\bSB\s*(\d+)\.(\d+)\.(\d+)\b/i) ||
    normalized.match(/\bSrimad\s+Bhagavatam\s+(\d+)\.(\d+)\.(\d+)\b/i) ||
    normalized.match(/\bCanto\s+(\d+)\s+Chapter\s+(\d+)\s+Verse\s+(\d+)\b/i);

  if (!match) return null;
  return {
    canto: Number.parseInt(match[1], 10),
    chapter: Number.parseInt(match[2], 10),
    verse: Number.parseInt(match[3], 10),
    reference: `SB ${Number.parseInt(match[1], 10)}.${Number.parseInt(match[2], 10)}.${Number.parseInt(match[3], 10)}`
  };
};

const extractQuotedExcerpt = (query) => {
  const match = String(query ?? '').match(/"([^"]{12,})"/);
  return match ? normalizeWhitespace(match[1]) : '';
};

const detectRequestedOutputMode = (query) => {
  const normalized = normalizeForSearch(query);
  if (normalized.includes('which verse')) return 'verse_reference';
  if (normalized.includes('what verse')) return 'verse_reference';
  if (normalized.includes('what canto and chapter')) return 'chapter_reference';
  if (normalized.includes('which chapter')) return 'chapter_reference';
  if (normalized.includes('what chapter')) return 'chapter_reference';
  if (normalized.includes('sanskrit')) return 'sanskrit';
  if (normalized.includes('transliteration')) return 'transliteration';
  if (normalized.includes('translation')) return 'translation';
  return null;
};

const wantsSingleVerseReference = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  return (
    /\b(which|what)\s+(verse|sloka|shloka|text)\b/.test(normalized) ||
    /\bexact\s+(verse|sloka|shloka|text)\b/.test(normalized) ||
    /\bwhich\s+slokha\b/.test(normalized) ||
    /\bgive\s+me\s+(?:a|one)\s+(verse|sloka|slokha|shloka|text)\b/.test(normalized) ||
    /\b(?:a|one)\s+(sloka|slokha|shloka|verse)\b/.test(normalized)
  );
};

const wantsMultipleVerseList = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  return (
    /\b(verses|slokas|slokhas|shlokas|shlokhas|texts)\b/.test(normalized) ||
    (/\b(describe|describing|show|give)\b/.test(normalized) &&
      /\b(beauty|flute|form|prayer|song|gita|stuti|glories)\b/.test(normalized))
  );
};

const buildDirectFieldAnswer = (mode, verse) => {
  if (!verse) return null;
  if (mode === 'sanskrit') return normalizeWhitespace(verse.sanskrit);
  if (mode === 'transliteration') return normalizeWhitespace(verse.transliteration);
  if (mode === 'translation') return normalizeWhitespace(verse.translation);
  if (mode === 'verse_reference') return verse.reference;
  if (mode === 'chapter_reference') return `SB ${verse.canto}.${verse.chapter}`;
  return null;
};

const extractCitedReference = (value) => {
  const matches = [...String(value ?? '').matchAll(/\bSB\s*(\d+)\.(\d+)(?:\.(\d+))?\b/gi)];
  if (!matches.length) return null;

  const verseMatch = matches.find((match) => match[3]);
  const selected = verseMatch || matches[0];
  return {
    canto: Number.parseInt(selected[1], 10),
    chapter: Number.parseInt(selected[2], 10),
    verse: selected[3] ? Number.parseInt(selected[3], 10) : null,
    reference: selected[3]
      ? `SB ${Number.parseInt(selected[1], 10)}.${Number.parseInt(selected[2], 10)}.${Number.parseInt(selected[3], 10)}`
      : `SB ${Number.parseInt(selected[1], 10)}.${Number.parseInt(selected[2], 10)}`
  };
};

const createSyntheticHit = (verse) => ({
  verse,
  score: 1.0,
  lexical_score: 1.0,
  fuzzy_score: 1.0,
  semantic_score: 0,
  rerank_score: 0,
  matched_chunk_id: verse.uid,
  matched_chunk_type: 'verse',
  matched_verse_uids: [verse.uid]
});

const resolveCuratedVerses = (corpus, preset, topK) => {
  const orderedReferences = uniqueList([preset.lead_reference, ...(preset.references || [])]).filter(Boolean);
  const resolvedVerses = orderedReferences
    .map((reference) => corpus.findVerseByReference?.(reference) || null)
    .filter(Boolean);

  if (resolvedVerses.length) return resolvedVerses.slice(0, topK);

  const chapterReference = extractCitedReference(preset.chapter_reference);
  if (!chapterReference?.canto || !chapterReference?.chapter) return [];
  return corpus.findVersesByChapter?.(chapterReference.canto, chapterReference.chapter)?.slice(0, topK) || [];
};

const resolveConceptEvidenceVerses = (corpus, conceptEvidenceMatch, topK) => {
  if (!conceptEvidenceMatch) return [];
  const evidence = conceptEvidenceMatch.evidence;
  const orderedReferences = uniqueList([evidence.lead_reference, ...(evidence.references || [])]);
  return orderedReferences
    .map((reference) => corpus.findVerseByReference?.(reference) || null)
    .filter(Boolean)
    .slice(0, topK);
};

const buildConceptEvidenceAnswer = (conceptEvidenceMatch, verses) => {
  if (!conceptEvidenceMatch || !verses.length) return null;
  const leadReference = verses[0].reference;
  return `${leadReference} is the strongest evidence for ${conceptEvidenceMatch.concept.display_name} in this context. ${conceptEvidenceMatch.evidence.description}`;
};

const buildCuratedAnswer = (query, preset, verses) => {
  if (!verses.length) return null;

  const lead = verses[0];
  const displayName =
    preset.display_name ||
    preset.aliases[0]
      .split(' ')
      .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
      .join(' ');
  const references = verses.slice(0, 3).map((verse) => verse.reference);

  if (preset.answer_style === 'collection' && preset.reference_summary) {
    return `${displayName} spans ${preset.reference_summary}.`;
  }

  if (preset.answer_style === 'theme' || wantsMultipleVerseList(query)) {
    if (references.length === 1) return `A strong Bhagavatam verse for ${displayName} is ${references[0]}.`;
    if (references.length === 2) {
      return `Strong Bhagavatam verses for ${displayName} are ${references[0]} and ${references[1]}.`;
    }
    return `Strong Bhagavatam verses for ${displayName} are ${references[0]}, ${references[1]}, and ${references[2]}.`;
  }

  if (wantsSingleVerseReference(query)) {
    return `The strongest Bhagavatam verse for ${displayName} is ${lead.reference} in "${lead.chapter_title}".`;
  }

  const chapterReference = preset.chapter_reference || `SB ${lead.canto}.${lead.chapter}`;
  const continuation = preset.secondary_chapter_reference
    ? ` This continues in ${preset.secondary_chapter_reference}${preset.secondary_chapter_title ? `, "${preset.secondary_chapter_title}"` : ''}.`
    : '';
  return `${displayName} is in ${chapterReference}, especially ${lead.reference}, in "${lead.chapter_title}".${continuation}`;
};

const buildOccurrenceAnswer = (rule, verses) => {
  if (!rule || !verses.length) return null;
  const references = verses.map((verse) => verse.reference).join(', ');
  return `The primary occurrence for ${rule.display_name} is ${references}. ${rule.description}`;
};

const buildPassageRangeAnswer = (entry, leadReference) => {
  const displayName = entry.display_name || 'This passage';
  const rangeSummary = entry.passage_range_summary || entry.reference_summary;
  return `The opening slokha of ${displayName} is ${leadReference}. The passage spans ${rangeSummary}.`;
};

const serializeContextGroup = (group) =>
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
  }));

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
    queryTokens: uniqueList(expanded.filter((token) => !LOW_SIGNAL_TOKENS.has(token))),
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
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  if (FOLLOW_UP_PREFIX_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  const tokens = normalized.match(/[a-zA-Z]+/g) || [];
  if (!tokens.length) return false;
  if (tokens.length <= 2) return tokens.some((token) => FOLLOW_UP_HINTS.has(token));
  return false;
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
  const aliasExpansions = findQueryAliasExpansions(standalone);
  const lexicalQueries = [standalone, ...aliasExpansions.flatMap((entry) => entry.lexical_queries)];
  if (history.length && looksLikeFollowUp(query)) lexicalQueries.push(String(query ?? '').trim());

  return {
    original_query: query,
    standalone_query: standalone,
    lexical_queries: sanitizeQueries(lexicalQueries, standalone, 6),
    intent,
    entities
  };
};

const termSetMatches = (tokenSet, term) => {
  const normalizedTerm = normalizeToken(normalizeForSearch(term));
  if (!normalizedTerm) return false;
  if (tokenSet.has(normalizedTerm)) return true;
  return [...tokenSet].some(
    (token) => token.length > 3 && (token.startsWith(normalizedTerm) || normalizedTerm.startsWith(token))
  );
};

const findOccurrenceRule = (query) => {
  const normalized = normalizeForSearch(query);
  const tokenSet = new Set(tokenize(query, { expandSynonyms: true }));
  return (
    OCCURRENCE_RULES.find((rule) =>
      rule.required_groups.every((group) =>
        group.some((term) => termSetMatches(tokenSet, term) || normalized.includes(normalizeForSearch(term)))
      )
    ) || null
  );
};

const scoreChapterAffinity = (queryFeatures, verse) => {
  if (!queryFeatures.entityTokens.length || !Array.isArray(verse.title_tokens)) return 0;
  const titleTokenSet = new Set(verse.title_tokens);
  const titleCoverage = tokenCoverageScore(queryFeatures.entityTokens, titleTokenSet);
  const exactTitleOverlap = queryFeatures.entityTokens.filter((token) => titleTokenSet.has(token)).length;
  const titleRecall = tokenCoverageScore(verse.title_tokens, new Set(queryFeatures.rawTokens));
  const contiguousTitleRun = longestContiguousTokenRun(verse.title_tokens, queryFeatures.rawTokens);
  const phraseBonus = contiguousTitleRun >= 3 ? Math.min(2.2, contiguousTitleRun * 0.55) : 0;
  return Math.min(
    4.8,
    titleCoverage * 1.2 + titleRecall * 2.2 + phraseBonus + Math.min(0.6, exactTitleOverlap * 0.12)
  );
};

const isChapterEssenceQuery = (query) => {
  const normalized = normalizeForSearch(query);
  return /\b(main point|essence|well known|popular|central teaching|chapter(?:'s|s)? idea)\b/.test(normalized);
};

const scoreEventAlignment = (queryFeatures, verse) => {
  if (!queryFeatures.isEventQuery) return 0;
  const queryTokenSet = new Set(queryFeatures.rawTokens);
  const verseTokenSet = verse.translation_token_set instanceof Set
    ? verse.translation_token_set
    : new Set(tokenize(verse.translation));
  const matchedGroups = EVENT_ACTION_GROUPS.filter((group) =>
    group.some((term) => termSetMatches(queryTokenSet, term))
  );
  if (!matchedGroups.length) return 0;
  const alignedGroups = matchedGroups.filter((group) =>
    group.some((term) => termSetMatches(verseTokenSet, term))
  );
  return Math.min(1.8, (alignedGroups.length / matchedGroups.length) * 1.8);
};

const scoreRetrospectivePenalty = (queryFeatures, verse) => {
  if (!queryFeatures.isEventQuery) return 0;
  const translation = normalizeForSearch(verse.translation);
  const cueCount = RETROSPECTIVE_CUES.filter((cue) => translation.includes(cue)).length;
  return Math.min(1.1, cueCount * 0.28);
};

const buildFallbackAnswer = (query, hits) => {
  if (!hits.length) {
    return `I could not find a strong Bhagavatam match for "${query}" in the local corpus. Try a more specific person, event, or phrase.`;
  }

  return `I could not confidently identify the exact Bhagavatam reference for "${query}" from the retrieved context. Please refine the prompt with the event name, people involved, chapter range, or a short translation excerpt.`;
};

const isMultiReferenceQuery = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  const resultNouns =
    '(?:instances?|places?|occurrences?|passages?|references?|locations?|verses|shlokas|shlokhas|slokas|slokhas|texts)';
  return (
    /\bwhere all\b/.test(normalized) ||
    /\bwherever\b/.test(normalized) ||
    /\bwhich\s+(?:verses|shlokas|shlokhas|slokas|slokhas|texts)\b/.test(normalized) ||
    new RegExp(`\\ball\\s+(?:the\\s+)?${resultNouns}\\b`).test(normalized) ||
    new RegExp(`\\beach\\s+(?:and\\s+every\\s+)?${resultNouns}\\b`).test(normalized) ||
    new RegExp(`\\bevery\\s+(?:single\\s+)?${resultNouns}\\b`).test(normalized) ||
    new RegExp(`\\bmultiple\\s+${resultNouns}\\b`).test(normalized) ||
    /\b(?:find|show|list|give|return|identify|collect)\s+(?:me\s+)?(?:all|each|every)\b/.test(normalized)
  );
};

const buildQuerySubject = (query) =>
  normalizeWhitespace(
    String(query ?? '')
      .replace(/^[Ww]here\s+(?:all\s+)?(?:is|are|does|do)\s+/u, '')
      .replace(
        /^(?:show|find|list|give|return|identify|collect)(?:\s+me)?\s+(?:all|each|every|multiple)(?:\s+the)?\s+(?:instances?|places?|occurrences?|passages?|references?|locations?|verses|shlokas|slokas|texts)\s+(?:where|that|which)?\s*/iu,
        ''
      )
      .replace(/^(which|what)\s+(?:verse|verses|chapter|canto|sloka|slokas|shloka|shlokas|text|texts)\s+(?:is|are|contains|contain|describe|describes)\s+/iu, '')
      .replace(/\bplease\b/giu, '')
      .replace(/[?]+$/g, '')
  );

const takeSentences = (text, maxSentences = 2) => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return '';
  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [normalized];
  return sentences
    .slice(0, maxSentences)
    .map((sentence) => normalizeWhitespace(sentence))
    .join(' ')
    .trim();
};

const buildSingleResultSummary = (query, hits, subjectOverride = '') => {
  const lead = hits[0]?.verse || null;
  if (!lead) return '';
  const subject = normalizeWhitespace(subjectOverride) || buildQuerySubject(query);
  const subjectSentence = subject
    ? `${lead.reference} in "${lead.chapter_title}" directly addresses ${subject}.`
    : `${lead.reference} in "${lead.chapter_title}" is the strongest Bhagavatam match.`;
  const translationSentence = takeSentences(lead.translation, 1);
  return translationSentence ? `${subjectSentence} ${translationSentence}` : subjectSentence;
};

const uniqueVersesByReference = (verses) => {
  const seen = new Set();
  return verses.filter((verse) => {
    const key = normalizeWhitespace(verse.reference).toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildOccurrenceLabel = (verses) => {
  if (!verses.length) return '';
  if (verses.length === 1) return verses[0].reference;
  const first = verses[0];
  const last = verses[verses.length - 1];
  if (first.canto === last.canto && first.chapter === last.chapter) {
    return `SB ${first.canto}.${first.chapter}.${first.verse}-${last.verse}`;
  }
  return `${first.reference} - ${last.reference}`;
};

const groupVersesIntoOccurrences = (verses) => {
  if (!verses.length) return [];
  const ordered = uniqueVersesByReference([...verses]).sort(
    (left, right) => left.canto - right.canto || left.chapter - right.chapter || left.verse - right.verse
  );
  const groups = [];
  let current = [];
  for (const verse of ordered) {
    const previous = current[current.length - 1];
    const isAdjacent =
      previous &&
      previous.canto === verse.canto &&
      previous.chapter === verse.chapter &&
      verse.verse - previous.verse <= 1;
    if (!current.length || isAdjacent) {
      current.push(verse);
      continue;
    }
    groups.push(current);
    current = [verse];
  }
  if (current.length) groups.push(current);
  return groups;
};

const serializeOccurrence = (verses) => ({
  reference_range: buildOccurrenceLabel(verses),
  hit_count: verses.length,
  chapter_title: verses[0]?.chapter_title || '',
  references: verses.map((verse) => verse.reference),
  verses: verses.map((verse) => ({
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
});

const buildMultiResultSummary = (query, verses, subjectOverride = '') => {
  if (!verses.length) return '';
  const subject = normalizeWhitespace(subjectOverride) || buildQuerySubject(query) || 'this topic';
  const cantos = new Set(verses.map((verse) => verse.canto));
  const chapters = new Set(verses.map((verse) => `${verse.canto}.${verse.chapter}`));
  const occurrences = groupVersesIntoOccurrences(verses);
  const leadRanges = occurrences.slice(0, 3).map((group) => buildOccurrenceLabel(group));
  const sentenceOne = `I found ${verses.length} Bhagavatam reference${verses.length === 1 ? '' : 's'} across ${chapters.size} chapter${chapters.size === 1 ? '' : 's'} in ${cantos.size} canto${cantos.size === 1 ? '' : 's'} for ${subject}.`;
  const sentenceTwo = leadRanges.length
    ? `The main occurrences are ${leadRanges.join(', ')}.`
    : '';
  const sentenceThree = takeSentences(verses[0].translation, 1)
    ? `The lead occurrence says: ${takeSentences(verses[0].translation, 1)}`
    : '';
  return [sentenceOne, sentenceTwo, sentenceThree].filter(Boolean).slice(0, 3).join(' ');
};

const resolvePresetVerses = (corpus, preset, topLimit = 24) =>
  uniqueList(preset.references || [])
    .map((reference) => corpus.findVerseByReference?.(reference) || null)
    .filter(Boolean)
    .slice(0, topLimit);

const filterMultiReferenceHits = (query, hits, maxHits = 24) => {
  if (!hits.length) return [];
  const queryFeatures = buildQueryFeatures(query);
  const bestScore = hits[0].score || 1;
  const filtered = hits.filter((hit, index) => {
    const scoreRatio = hit.score / bestScore;
    const verseTokenSet =
      hit.verse.token_set instanceof Set
        ? hit.verse.token_set
        : new Set(tokenize([hit.verse.reference, hit.verse.chapter_title, hit.verse.translation].filter(Boolean).join(' ')));
    const verseTitleTokens = Array.isArray(hit.verse.title_tokens)
      ? hit.verse.title_tokens
      : tokenize(hit.verse.chapter_title || '');
    const tokenOverlap = queryFeatures.entityTokens.filter((token) => verseTokenSet.has(token)).length;
    const titleOverlap = queryFeatures.titleTokens.filter((token) => verseTitleTokens.includes(token)).length;
    return scoreRatio >= 0.58 && (index < 3 || tokenOverlap >= 1 || titleOverlap >= 1);
  });
  return filtered.slice(0, maxHits);
};

const buildSummaryPayload = ({ query, hits, displayMode = 'single_reference', subjectOverride = '' }) => {
  const verses = hits.map((hit) => hit.verse).filter(Boolean);
  if (!verses.length) {
    return {
      display_mode: displayMode,
      summary: '',
      summary_position: 'none',
      primary_reference: null,
      occurrences: []
    };
  }

  if (displayMode === 'multi_reference') {
    const uniqueVerses = uniqueVersesByReference(verses);
    return {
      display_mode: displayMode,
      summary: buildMultiResultSummary(query, uniqueVerses, subjectOverride),
      summary_position: 'before_hits',
      primary_reference: uniqueVerses[0]?.reference || null,
      occurrences: groupVersesIntoOccurrences(uniqueVerses).map((group) => serializeOccurrence(group))
    };
  }

  return {
    display_mode: displayMode,
    summary: buildSingleResultSummary(query, hits, subjectOverride),
    summary_position: 'after_primary_hit',
    primary_reference: verses[0]?.reference || null,
    occurrences: []
  };
};

const isReferenceLookupQuery = (query) => {
  const normalized = normalizeForSearch(query);
  if (!normalized) return false;
  const tokens = normalized.split(' ').filter(Boolean).map(normalizeToken);
  const referenceTokens = new Set(['verse', 'verses', 'chapter', 'canto', 'sloka', 'text']);

  if (
    /\b(which|what)\s+(verse|verses|chapter|canto|sloka|slokha|shloka|shlokha|text)\b/.test(normalized) ||
    /\bexact\s+(verse|sloka|shloka|text)\b/.test(normalized) ||
    /\bwhere\s+(can\s+i\s+find|do\s+i\s+find)\b/.test(normalized) ||
    /\b(find|locate|located)\b/.test(normalized)
  ) {
    return true;
  }

  if (tokens.includes('exact') && tokens.some((token) => referenceTokens.has(token))) {
    return true;
  }

  if ((tokens.includes('which') || tokens.includes('what')) && tokens.some((token) => referenceTokens.has(token))) {
    return true;
  }

  if (tokens.includes('where') && tokens.some((token) => referenceTokens.has(token))) {
    return true;
  }

  const subjectHints = new Set(['gita', 'song', 'prayer', 'stuti', 'stava', 'stotram', 'stotra']);
  return tokens.includes('where') && tokens.some((token) => subjectHints.has(token));
};

const buildReferenceAnswer = (query, hits, namedPassage = null) => {
  if (namedPassage) {
    const displayName =
      namedPassage.display_name ||
      namedPassage.aliases[0]
        .split(' ')
        .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
        .join(' ');
    return `${displayName} is in ${namedPassage.chapter_reference}, especially ${namedPassage.lead_reference}, in "${namedPassage.chapter_title}".`;
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

const renderContextBlock = (verses, primaryReference = '') =>
  verses
    .map((verse) =>
      [
        `Evidence role: ${verse.reference === primaryReference ? 'PRIMARY RETRIEVAL EVIDENCE' : 'SUPPORTING ADJACENT CONTEXT'}`,
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
    this.verseByReference = new Map();
    this.versesByChapter = new Map();
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
    corpus.verseByReference = new Map(corpus.verses.map((verse) => [normalizeWhitespace(verse.reference).toUpperCase(), verse]));
    corpus.versesByChapter = new Map();
    for (const verse of corpus.verses) {
      const key = `${verse.canto}.${verse.chapter}`;
      const list = corpus.versesByChapter.get(key) || [];
      list.push(verse);
      corpus.versesByChapter.set(key, list);
    }
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
    const guideSearchText = (SEARCH_GUIDE_TERMS_BY_REFERENCE.get(reference) || []).join('\n');
    const conceptSearchText = (CONCEPT_TERMS_BY_REFERENCE.get(reference) || []).join('\n');
    const searchText = [reference, chapterTitle, translation, transliteration, sanskrit, guideSearchText, conceptSearchText]
      .filter(Boolean)
      .join('\n');
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

  rankChapters(query, limit = 3) {
    const queryFeatures = buildQueryFeatures(query);
    const queryTokens = uniqueList([
      ...queryFeatures.rawTokens.filter((token) => isMeaningfulToken(token) && !LOW_SIGNAL_TOKENS.has(token)),
      ...queryFeatures.entityTokens
    ]);
    if (!queryTokens.length) return [];
    const queryTokenSet = new Set(queryTokens);
    const normalizedQuery = normalizeForSearch(query);
    const ranked = [];

    for (const [chapterKey, verses] of this.versesByChapter.entries()) {
      const representative = verses[0];
      const titleTokens = uniqueList(
        (representative?.title_tokens || []).filter((token) => !LOW_SIGNAL_TOKENS.has(token))
      );
      if (!titleTokens.length) continue;
      const titleTokenSet = new Set(titleTokens);
      const titleCoverage = tokenCoverageScore(titleTokens, queryTokenSet);
      const queryCoverage = tokenCoverageScore(queryTokens, titleTokenSet);
      const normalizedTitle = normalizeForSearch(titleTokens.join(' '));
      const phraseBonus = normalizedTitle.length >= 8 && normalizedQuery.includes(normalizedTitle) ? 3.5 : 0;
      const overlapCount = titleTokens.filter((token) => queryTokenSet.has(token)).length;
      const score = titleCoverage * 4.5 + queryCoverage * 2.5 + phraseBonus + Math.min(1.2, overlapCount * 0.2);
      if (score > 0) ranked.push({ chapterKey, score, title: representative.chapter_title });
    }

    return ranked
      .sort((left, right) => right.score - left.score || left.chapterKey.localeCompare(right.chapterKey))
      .slice(0, limit);
  }

  #candidateVerseUids(queryTokens, allowedChapterKeys = []) {
    const candidateUids = new Set();
    const allowed = new Set(allowedChapterKeys);
    for (const token of queryTokens) {
      for (const verseUid of this.postings.get(token) || []) {
        const verse = this.verseByUid.get(verseUid);
        if (!allowed.size || allowed.has(`${verse.canto}.${verse.chapter}`)) candidateUids.add(verseUid);
      }
    }
    if (candidateUids.size) return candidateUids;
    if (allowed.size) {
      return new Set(
        this.verses
          .filter((verse) => allowed.has(`${verse.canto}.${verse.chapter}`))
          .map((verse) => verse.uid)
      );
    }
    return new Set(this.verses.map((verse) => verse.uid));
  }

  #scoreVariant(query, topK, allowedChapterKeys = []) {
    const queryFeatures = buildQueryFeatures(query);
    if (!queryFeatures.queryTokens.length) return [];

    const hits = [];
    for (const verseUid of this.#candidateVerseUids(queryFeatures.queryTokens, allowedChapterKeys)) {
      const verse = this.verseByUid.get(verseUid);
      const lexicalScore = this.#bm25(queryFeatures.queryTokens, verseUid);
      const fuzzyScore = this.#fuzzyScore(queryFeatures, verse);
      const chapterScore = scoreChapterAffinity(queryFeatures, verse);
      const eventScore = scoreEventAlignment(queryFeatures, verse);
      const retrospectivePenalty = scoreRetrospectivePenalty(queryFeatures, verse);
      const combinedScore = lexicalScore + fuzzyScore * 1.5 + chapterScore + eventScore - retrospectivePenalty;
      if (combinedScore <= 0) continue;

      hits.push({
        verse,
        score: combinedScore,
        lexical_score: lexicalScore,
        fuzzy_score: fuzzyScore,
        semantic_score: 0,
        rerank_score: combinedScore,
        chapter_score: chapterScore,
        event_score: eventScore,
        retrospective_penalty: retrospectivePenalty,
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

  async retrieve(query, { topK = 8, lexicalQueries = [], candidatePool = 64, allowedChapterKeys = [] } = {}) {
    const variants = uniqueList([query, ...lexicalQueries].map((item) => normalizeWhitespace(item))).filter(Boolean);
    const aggregated = new Map();
    const variantMatches = new Map();
    const candidateLimit = Math.max(candidatePool, topK * 8, 64);

    for (const variant of variants) {
      const variantHits = this.#scoreVariant(variant, candidateLimit, allowedChapterKeys);
      for (const hit of variantHits) {
        variantMatches.set(hit.matched_chunk_id, (variantMatches.get(hit.matched_chunk_id) || 0) + 1);
        const existing = aggregated.get(hit.matched_chunk_id);
        if (!existing || hit.score > existing.score) aggregated.set(hit.matched_chunk_id, hit);
      }
    }

    const allowed = new Set(allowedChapterKeys);
    let semanticMatches = [];
    try {
      semanticMatches = await semanticSearch(query, { topK: candidateLimit });
    } catch (error) {
      console.error('Semantic search failed, continuing with lexical-only results:', error);
    }

    const semanticScoreByUid = new Map();
    for (const match of semanticMatches) {
      const verse = this.verseByUid.get(match.uid);
      if (!verse) continue;
      if (allowed.size && !allowed.has(`${verse.canto}.${verse.chapter}`)) continue;
      semanticScoreByUid.set(match.uid, Math.max(0, match.score));

      // Surface verses the lexical pass missed entirely, so paraphrased/open-ended
      // questions with little word overlap can still retrieve the right passage.
      if (!aggregated.has(match.uid)) {
        aggregated.set(match.uid, {
          verse,
          score: 0,
          lexical_score: 0,
          fuzzy_score: 0,
          semantic_score: 0,
          rerank_score: 0,
          matched_chunk_id: match.uid,
          matched_chunk_type: 'verse',
          matched_verse_uids: [match.uid]
        });
      }
    }

    const SEMANTIC_WEIGHT = 7;
    const queryFeatures = buildQueryFeatures(query);
    const finalHits = [];
    for (const [chunkUid, hit] of aggregated.entries()) {
      const matchBonus = Math.max(0, (variantMatches.get(chunkUid) || 0) - 1) * 0.45;
      const chapterScore = scoreChapterAffinity(queryFeatures, hit.verse);
      const eventScore = scoreEventAlignment(queryFeatures, hit.verse);
      const retrospectivePenalty = scoreRetrospectivePenalty(queryFeatures, hit.verse);
      const semanticScore = semanticScoreByUid.get(chunkUid) || 0;
      const rerankScore =
        hit.score +
        matchBonus +
        chapterScore * 0.8 +
        eventScore * 0.8 -
        retrospectivePenalty +
        semanticScore * SEMANTIC_WEIGHT;
      finalHits.push({
        ...hit,
        score: rerankScore,
        rerank_score: rerankScore,
        semantic_score: semanticScore,
        chapter_score: chapterScore,
        event_score: eventScore,
        retrospective_penalty: retrospectivePenalty
      });
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

  findVerseByReference(reference) {
    if (!reference) return null;
    return this.verseByReference.get(normalizeWhitespace(reference).toUpperCase()) || null;
  }

  findVersesByChapter(canto, chapter) {
    if (!Number.isFinite(canto) || !Number.isFinite(chapter)) return [];
    return this.versesByChapter.get(`${canto}.${chapter}`) || [];
  }

  findVersesByExcerpt(excerpt) {
    const normalizedExcerpt = normalizeForSearch(excerpt);
    if (!normalizedExcerpt) return [];

    const matches = [];
    for (const verse of this.verses) {
      const normalizedTranslation = normalizeForSearch(verse.translation);
      if (!normalizedTranslation.includes(normalizedExcerpt)) continue;
      matches.push(verse);
    }
    return matches;
  }

  findVerseByExcerpt(excerpt) {
    return this.findVersesByExcerpt(excerpt)[0] || null;
  }
}

class SbmContextSearchService {
  constructor(options = {}) {
    this.versesUrl = options.versesUrl || process.env.BHAGAVATAM_REMOTE_VERSES_URL || DEFAULT_REMOTE_VERSES_URL;
    this.preferLocalCorpus = options.preferLocalCorpus ?? !options.versesUrl;
    this.openRouterApiKey =
      options.openRouterApiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      '';
    this.openRouterModel =
      options.openRouterModel ||
      process.env.BHAGAVATAM_OPENAI_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.BHAGAVATAM_OPENROUTER_MODEL ||
      process.env.OPENROUTER_MODEL ||
      DEFAULT_OPENROUTER_MODEL;
    this.llmBaseUrl = (
      options.baseUrl ||
      process.env.BHAGAVATAM_OPENAI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.OPENROUTER_BASE_URL ||
      'https://openrouter.ai/api/v1'
    ).replace(/\/+$/, '');
    this.isOpenRouter = this.llmBaseUrl.toLowerCase().includes('openrouter.ai');
    this.openRouterApiUrl = options.openRouterApiUrl || `${this.llmBaseUrl}/chat/completions`;
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
    if (this.preferLocalCorpus) {
      const localRows = await this.#loadLocalRows();
      if (localRows.length) {
        return LightweightCorpus.fromRows(localRows);
      }
    }

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

  async #loadLocalRows() {
    try {
      const raw = await fs.readFile(LOCAL_VERSES_CACHE_URL, 'utf8');
      const payload = JSON.parse(raw);
      return Array.isArray(payload?.verses) ? payload.verses : [];
    } catch {
      return [];
    }
  }

  async health() {
    const corpus = await this.ensureCorpus();
    return {
      status: 'ok',
      verses_loaded: corpus.verses.length,
      search_guide_entries: SEARCH_GUIDE_ENTRIES.length,
      search_guide_schema_version: SEARCH_GUIDE.schemaVersion,
      concept_index_entries: CONCEPT_ENTRIES.length,
      concept_index_schema_version: CONCEPT_INDEX.schemaVersion,
      openai_enabled: Boolean(this.openRouterApiKey)
    };
  }

  async query({ query, top_k = 8, neighbor_window = 1, history = [], use_llm = true, request_origin = '' }) {
    const corpus = await this.ensureCorpus();
    const recentHistory = history.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(-6);
    const queryPlan = buildFallbackQueryPlan(query, recentHistory);
    const conceptMatches = findConceptMatches(queryPlan.standalone_query);
    const conceptEvidenceMatch = findConceptEvidenceMatch(conceptMatches, queryPlan.standalone_query);
    const mentionedConceptSubjects = findMentionedConceptSubjects(queryPlan.standalone_query);
    const orderedConceptMatches = conceptEvidenceMatch
      ? [
          ...conceptMatches.filter(({ concept }) => concept.id === conceptEvidenceMatch.concept.id),
          ...conceptMatches.filter(({ concept }) => concept.id !== conceptEvidenceMatch.concept.id)
        ]
      : conceptMatches;
    const conceptLexicalQueries = buildConceptLexicalQueries(
      orderedConceptMatches,
      queryPlan.standalone_query
    );
    const conceptMetadata = {
      concept_matches: serializeConceptMatches(orderedConceptMatches),
      concept_evidence_match: serializeConceptEvidenceMatch(conceptEvidenceMatch),
      concept_subject_matches: mentionedConceptSubjects
    };
    const requestedOutputMode = detectRequestedOutputMode(query);
    const explicitReference = extractExplicitReference(query);
    const quotedExcerpt = extractQuotedExcerpt(query);
    const multiReferencePreset =
      findMultiReferencePreset(queryPlan.standalone_query) || findMultiReferencePreset(query);
    const namedPassage =
      findNamedPassageAlias(queryPlan.standalone_query) || findNamedPassageAlias(query);
    const exactSearchGuideEntry =
      requestedOutputMode !== 'chapter_reference'
        ? findExactSearchGuideEntry(queryPlan.standalone_query) || findExactSearchGuideEntry(query)
        : null;
    const passageRangeEntry =
      findPassageRangeGuideEntry(queryPlan.standalone_query) || findPassageRangeGuideEntry(query);
    const searchGuideEntry =
      !multiReferencePreset &&
      requestedOutputMode !== 'chapter_reference' &&
      (!namedPassage || exactSearchGuideEntry?.category === 'multi_sloka')
        ? exactSearchGuideEntry ||
          findSearchGuideEntry(queryPlan.standalone_query) ||
          findSearchGuideEntry(query)
        : null;
    const exhaustiveQuery =
      searchGuideEntry?.category === 'multi_sloka' ||
      Boolean(multiReferencePreset) ||
      isMultiReferenceQuery(queryPlan.standalone_query) ||
      isMultiReferenceQuery(query) ||
      wantsMultipleVerseList(queryPlan.standalone_query) ||
      wantsMultipleVerseList(query);
    const chapterRouteCandidates = isChapterEssenceQuery(queryPlan.standalone_query)
      ? corpus.rankChapters?.(queryPlan.standalone_query, 3) || []
      : [];
    const chapterRouteTop = chapterRouteCandidates[0] || null;
    const chapterRouteSecond = chapterRouteCandidates[1] || null;
    const useChapterRoute = Boolean(
      !exhaustiveQuery &&
        chapterRouteTop &&
        chapterRouteTop.score >= 2.5 &&
        (!chapterRouteSecond || chapterRouteTop.score - chapterRouteSecond.score >= 0.35 || chapterRouteTop.score >= 5)
    );
    const chapterRoute = useChapterRoute
      ? {
          selected_chapters: [chapterRouteTop.chapterKey],
          candidates: chapterRouteCandidates
        }
      : null;

    if (explicitReference && requestedOutputMode) {
      const directVerse = corpus.findVerseByReference(explicitReference.reference);
      const directAnswer = buildDirectFieldAnswer(requestedOutputMode, directVerse);
      if (directVerse && directAnswer) {
        const directHit = createSyntheticHit(directVerse);
        const directContextGroups = [serializeContextGroup(corpus.expandContextGroup([directVerse.uid], neighbor_window))];
        const summaryPayload = buildSummaryPayload({ query, hits: [directHit] });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: explicitReference.reference,
          query_variants: [explicitReference.reference],
          answer_mode: 'direct_reference',
          answer: directAnswer,
          ...summaryPayload,
          context_summary: buildContextSummaryFallback({
            query,
            hits: [directHit],
            contextGroups: directContextGroups
          }),
          hit_count: 1,
          hits: [this.#serializeHit(directHit)],
          context_groups: directContextGroups
        };
      }
    }

    if (requestedOutputMode === 'verse_reference' && quotedExcerpt) {
      const excerptVerses =
        typeof corpus.findVersesByExcerpt === 'function'
          ? corpus.findVersesByExcerpt(quotedExcerpt)
          : [corpus.findVerseByExcerpt?.(quotedExcerpt)].filter(Boolean);
      if (excerptVerses.length) {
        const responseVerses = excerptVerses.slice(0, top_k);
        const answerText =
          responseVerses.length === 1
            ? responseVerses[0].reference
            : `This excerpt appears in ${responseVerses.map((verse) => verse.reference).join(', ')}.`;
        const excerptHits = responseVerses.map((verse) => createSyntheticHit(verse));
        const responseContextGroups = responseVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({ query, hits: excerptHits });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: quotedExcerpt,
          query_variants: [quotedExcerpt],
          answer_mode: 'direct_excerpt',
          answer: answerText,
          ...summaryPayload,
          context_summary: buildContextSummaryFallback({
            query,
            hits: excerptHits,
            contextGroups: responseContextGroups
          }),
          hit_count: responseVerses.length,
          hits: excerptHits.map((hit) => this.#serializeHit(hit)),
          context_groups: responseContextGroups
        };
      }
    }

    if (passageRangeEntry) {
      const leadVerse = corpus.findVerseByReference?.(passageRangeEntry.lead_reference) || null;
      if (leadVerse) {
        const leadHit = createSyntheticHit(leadVerse);
        const rangeAnswer = buildPassageRangeAnswer(passageRangeEntry, leadVerse.reference);
        const rangeContextGroups = [
          serializeContextGroup(corpus.expandContextGroup([leadVerse.uid], neighbor_window))
        ];
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([
            ...queryPlan.lexical_queries,
            ...(passageRangeEntry.search_terms || []).slice(0, 8),
            passageRangeEntry.lead_reference,
            passageRangeEntry.passage_range_summary
          ]),
          answer_mode: 'passage_range_lookup',
          answer: rangeAnswer,
          display_mode: 'single_reference',
          summary: rangeAnswer,
          summary_position: 'after_primary_hit',
          primary_reference: leadVerse.reference,
          occurrences: [],
          context_summary: rangeAnswer,
          passage_range: {
            display_name: passageRangeEntry.display_name,
            topic_slug: passageRangeEntry.topic_slug || null,
            opening_reference: leadVerse.reference,
            reference_summary: passageRangeEntry.passage_range_summary,
            ranges: passageRangeEntry.passage_ranges
          },
          search_guide_match: {
            id: passageRangeEntry.id,
            category: passageRangeEntry.category,
            display_name: passageRangeEntry.display_name,
            description: passageRangeEntry.description
          },
          hit_count: 1,
          hits: [this.#serializeHit(leadHit)],
          context_groups: rangeContextGroups
        };
      }
    }

    const occurrenceRule =
      findOccurrenceRule(queryPlan.standalone_query) || findOccurrenceRule(query);
    if (occurrenceRule && !multiReferencePreset) {
      const occurrenceVerses = occurrenceRule.references
        .map((reference) => corpus.findVerseByReference?.(reference) || null)
        .filter(Boolean);
      if (occurrenceVerses.length) {
        const occurrenceHits = occurrenceVerses.map((verse) => createSyntheticHit(verse));
        const occurrenceContextGroups = occurrenceVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const occurrenceAnswer = buildOccurrenceAnswer(occurrenceRule, occurrenceVerses);
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([
            ...queryPlan.lexical_queries,
            occurrenceRule.display_name,
            ...occurrenceRule.references
          ]),
          answer_mode: 'event_occurrence_lookup',
          answer: occurrenceAnswer,
          display_mode: occurrenceVerses.length > 1 ? 'multi_reference' : 'single_reference',
          summary: occurrenceAnswer,
          summary_position: 'after_primary_hit',
          primary_reference: occurrenceVerses[0].reference,
          occurrences: [serializeOccurrence(occurrenceVerses)],
          context_summary: occurrenceAnswer,
          event_occurrence: {
            id: occurrenceRule.id,
            display_name: occurrenceRule.display_name,
            references: occurrenceRule.references
          },
          hit_count: occurrenceHits.length,
          hits: occurrenceHits.map((hit) => this.#serializeHit(hit)),
          context_groups: occurrenceContextGroups
        };
      }
    }

    if (
      conceptEvidenceMatch &&
      !useChapterRoute &&
      !namedPassage &&
      !multiReferencePreset &&
      !exactSearchGuideEntry
    ) {
      const conceptTopK = wantsMultipleVerseList(query) ? top_k : 1;
      const conceptVerses = resolveConceptEvidenceVerses(corpus, conceptEvidenceMatch, conceptTopK);
      const conceptAnswer = buildConceptEvidenceAnswer(conceptEvidenceMatch, conceptVerses);
      if (conceptVerses.length && conceptAnswer) {
        const conceptHits = conceptVerses.map((verse) => createSyntheticHit(verse));
        const displayMode = conceptVerses.length > 1 ? 'multi_reference' : 'single_reference';
        const conceptContextGroups = conceptVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({
          query,
          hits: conceptHits,
          displayMode,
          subjectOverride: conceptEvidenceMatch.concept.display_name
        });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([
            ...queryPlan.lexical_queries,
            ...conceptLexicalQueries,
            ...(conceptEvidenceMatch.evidence.references || [])
          ]),
          answer_mode: 'concept_evidence_lookup',
          answer: conceptAnswer,
          ...summaryPayload,
          primary_reference: conceptVerses[0].reference,
          context_summary: conceptAnswer,
          hit_count: conceptHits.length,
          hits: conceptHits.map((hit) => this.#serializeHit(hit)),
          context_groups: conceptContextGroups
        };
      }
    }

    if (
      orderedConceptMatches.length &&
      !conceptEvidenceMatch &&
      !useChapterRoute &&
      mentionedConceptSubjects.length &&
      !namedPassage &&
      !multiReferencePreset &&
      !exactSearchGuideEntry
    ) {
      // A recognized-but-unlinked concept match used to refuse outright here. That's right for
      // ambiguous citation questions, but it also pre-empted genuinely answerable open-ended
      // questions (e.g. a paraphrase of Gajendra's crisis) before semantic search ever ran.
      // Only refuse if semantic search also has no confident candidate.
      let hasConfidentSemanticMatch = false;
      try {
        const semanticPreview = await semanticSearch(queryPlan.standalone_query, { topK: 1 });
        hasConfidentSemanticMatch = Boolean(
          semanticPreview[0] && semanticPreview[0].score >= SEMANTIC_CONFIDENCE_THRESHOLD
        );
      } catch (error) {
        console.error('Semantic confidence check failed:', error);
      }

      if (!hasConfidentSemanticMatch) {
        const displayNames = orderedConceptMatches.map(({ concept }) => concept.display_name).join(', ');
        const subjectNames = mentionedConceptSubjects.join(', ');
        const answer =
          `I recognized ${displayNames} and the named subject ${subjectNames}, but the concept index has no verified verse-level evidence tying them together. ` +
          'I will not substitute a verse about a different person.';
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([...queryPlan.lexical_queries, ...conceptLexicalQueries]),
          answer_mode: 'concept_evidence_inconclusive',
          answer,
          display_mode: 'single_reference',
          summary: answer,
          summary_position: 'before_hits',
          primary_reference: null,
          occurrences: [],
          context_summary: answer,
          hit_count: 0,
          hits: [],
          context_groups: []
        };
      }
    }

    if (searchGuideEntry && !useChapterRoute) {
      const guideTopK =
        searchGuideEntry.category === 'multi_sloka'
          ? Math.max(top_k, searchGuideEntry.references?.length || 0)
          : top_k;
      const guideVerses = resolveCuratedVerses(corpus, searchGuideEntry, guideTopK);
      const guideAnswer = buildCuratedAnswer(query, searchGuideEntry, guideVerses);
      if (guideVerses.length && guideAnswer) {
        const guideHits = guideVerses.map((verse) => createSyntheticHit(verse));
        const wantsMultiDisplay =
          searchGuideEntry.category === 'multi_sloka' ||
          searchGuideEntry.answer_style === 'collection' ||
          wantsMultipleVerseList(query);
        const displayMode = wantsMultiDisplay ? 'multi_reference' : 'single_reference';
        const answerMode = wantsMultiDisplay ? 'multi_reference_lookup' : 'reference_lookup';
        const guideContextGroups = guideVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({
          query,
          hits: guideHits,
          displayMode,
          subjectOverride: searchGuideEntry.display_name
        });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([
            ...queryPlan.lexical_queries,
            ...(searchGuideEntry.search_terms || []).slice(0, 8),
            ...(searchGuideEntry.references || [])
          ]),
          answer_mode: answerMode,
          answer: guideAnswer,
          ...summaryPayload,
          context_summary: buildContextSummaryFallback({
            query,
            hits: guideHits,
            contextGroups: guideContextGroups
          }),
          search_guide_match: {
            id: searchGuideEntry.id,
            category: searchGuideEntry.category,
            display_name: searchGuideEntry.display_name,
            description: searchGuideEntry.description
          },
          hit_count: guideHits.length,
          hits: guideHits.map((hit) => this.#serializeHit(hit)),
          context_groups: guideContextGroups
        };
      }
    }

    if (multiReferencePreset) {
      const presetVerses = resolvePresetVerses(corpus, multiReferencePreset, Math.max(top_k * 4, 24));
      if (presetVerses.length) {
        const presetHits = presetVerses.map((verse) => createSyntheticHit(verse));
        const presetContextGroups = presetVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({
          query,
          hits: presetHits,
          displayMode: 'multi_reference',
          subjectOverride: multiReferencePreset.display_name
        });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([...queryPlan.lexical_queries, ...(multiReferencePreset.references || [])]),
          answer_mode: 'multi_reference_lookup',
          answer: summaryPayload.summary,
          ...summaryPayload,
          context_summary: summaryPayload.summary,
          hit_count: presetHits.length,
          hits: presetHits.map((hit) => this.#serializeHit(hit)),
          context_groups: presetContextGroups
        };
      }
    }

    if (namedPassage && !useChapterRoute) {
      const curatedVerses = resolveCuratedVerses(corpus, namedPassage, top_k);
      const curatedAnswer = buildCuratedAnswer(query, namedPassage, curatedVerses);
      if (curatedVerses.length && curatedAnswer) {
        const curatedHits = curatedVerses.map((verse) => createSyntheticHit(verse));
        const wantsMultiDisplay =
          curatedVerses.length > 1 &&
          (exhaustiveQuery ||
            wantsMultipleVerseList(query) ||
            namedPassage.answer_style === 'collection' ||
            namedPassage.answer_style === 'theme');
        const displayMode = wantsMultiDisplay ? 'multi_reference' : 'single_reference';
        const answerMode = wantsMultiDisplay ? 'multi_reference_lookup' : 'reference_lookup';
        const curatedContextGroups = curatedVerses.map((verse) =>
          serializeContextGroup(corpus.expandContextGroup([verse.uid], neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({
          query,
          hits: curatedHits,
          displayMode,
          subjectOverride: namedPassage.display_name
        });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: uniqueList([
            ...queryPlan.lexical_queries,
            namedPassage.chapter_reference,
            ...(namedPassage.references || [])
          ]),
          answer_mode: answerMode,
          answer: answerMode === 'multi_reference_lookup' ? summaryPayload.summary : curatedAnswer,
          ...summaryPayload,
          context_summary: buildContextSummaryFallback({
            query,
            hits: curatedHits,
            contextGroups: curatedContextGroups
          }),
          hit_count: curatedHits.length,
          hits: curatedHits.map((hit) => this.#serializeHit(hit)),
          context_groups: curatedContextGroups
        };
      }
    }

    const lexicalQueries = namedPassage
      ? uniqueList([
          ...queryPlan.lexical_queries,
          ...conceptLexicalQueries,
          namedPassage.chapter_reference,
          namedPassage.lead_reference,
          namedPassage.chapter_title
        ])
      : uniqueList([...queryPlan.lexical_queries, ...conceptLexicalQueries]);
    const hits = await corpus.retrieve(queryPlan.standalone_query, {
      topK: exhaustiveQuery ? Math.max(top_k * 8, MAX_MULTI_REFERENCE_CANDIDATES) : top_k,
      lexicalQueries,
      allowedChapterKeys: chapterRoute?.selected_chapters || []
    });
    if (exhaustiveQuery) {
      const multiHits = filterMultiReferenceHits(
        queryPlan.standalone_query,
        hits,
        Math.max(top_k * 8, MAX_MULTI_REFERENCE_HITS)
      ).sort(
        (left, right) =>
          left.verse.canto - right.verse.canto ||
          left.verse.chapter - right.verse.chapter ||
          left.verse.verse - right.verse.verse
      );
      if (multiHits.length) {
        const multiContextGroups = multiHits.map((hit) =>
          serializeContextGroup(corpus.expandContextGroup(hit.matched_verse_uids, neighbor_window))
        );
        const summaryPayload = buildSummaryPayload({
          query,
          hits: multiHits,
          displayMode: 'multi_reference'
        });
        return {
          query,
          ...conceptMetadata,
          rewritten_query: queryPlan.standalone_query,
          query_variants: lexicalQueries,
          answer_mode: 'multi_reference_lookup',
          answer: summaryPayload.summary,
          ...summaryPayload,
          context_summary: summaryPayload.summary,
          hit_count: multiHits.length,
          hits: multiHits.map((hit) => this.#serializeHit(hit)),
          context_groups: multiContextGroups
        };
      }
    }
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
      conceptMatches: orderedConceptMatches,
      useLlm: use_llm,
      requestOrigin: request_origin
    });

    let answerText = answerResult.answerText;
    let responseHits = hits;
    let responseContextGroups = contextGroups;
    const citedReference = extractCitedReference(answerText);
    if (citedReference?.verse && answerResult.answerMode !== 'reference_lookup') {
      const resolvedVerse =
        typeof corpus.findVerseByReference === 'function'
          ? corpus.findVerseByReference(citedReference.reference)
          : (corpus.verses || []).find((verse) => verse.reference === citedReference.reference) || null;
      const citedPrimaryHit = hits.find((h) => h.verse.uid === resolvedVerse?.uid);
      if (resolvedVerse && citedPrimaryHit) {
        const resolvedHit = citedPrimaryHit;
        responseHits = [resolvedHit];
        responseContextGroups = [corpus.expandContextGroup([resolvedVerse.uid], neighbor_window)];
      } else if (resolvedVerse) {
        answerText = buildFallbackAnswer(query, hits);
      }
    } else if (citedReference) {
      const chapterHits = hits.filter(
        (hit) => hit.verse.canto === citedReference.canto && hit.verse.chapter === citedReference.chapter
      );
      if (chapterHits.length) {
        responseHits = chapterHits.slice(0, top_k);
        responseContextGroups = responseHits.map((hit) =>
          corpus.expandContextGroup(hit.matched_verse_uids, neighbor_window)
        );
      } else if (isReferenceLookupQuery(query)) {
        const chapterVerses =
          typeof corpus.findVersesByChapter === 'function'
            ? corpus.findVersesByChapter(citedReference.canto, citedReference.chapter)
            : (corpus.verses || []).filter(
                (verse) => verse.canto === citedReference.canto && verse.chapter === citedReference.chapter
              );
        const anchorVerse = chapterVerses[0] || null;
        if (anchorVerse) {
          responseHits = [createSyntheticHit(anchorVerse)];
          responseContextGroups = [corpus.expandContextGroup([anchorVerse.uid], neighbor_window)];
        }
      } else {
        answerText = buildFallbackAnswer(query, hits);
      }
    } else if (answerResult.answerMode === 'reference_lookup') {
      let resolvedVerse = null;
      if (namedPassage) {
        resolvedVerse = corpus.findVerseByReference(namedPassage.lead_reference);
      }
      if (resolvedVerse) {
        const resolvedHit = hits.find((h) => h.verse.uid === resolvedVerse.uid) || createSyntheticHit(resolvedVerse);
        responseHits = [resolvedHit];
        responseContextGroups = [corpus.expandContextGroup([resolvedVerse.uid], neighbor_window)];
      }
    }

    const summaryPayload = buildSummaryPayload({
      query,
      hits: responseHits,
      subjectOverride: namedPassage?.display_name || ''
    });
    return {
      query,
      ...conceptMetadata,
      rewritten_query: queryPlan.standalone_query,
      query_variants: lexicalQueries,
      chapter_route: chapterRoute,
      answer_mode: answerResult.answerMode,
      answer: answerText,
      ...summaryPayload,
      context_summary:
        answerResult.contextSummary ||
        buildContextSummaryFallback({
          query,
          hits: responseHits,
          contextGroups: responseContextGroups
        }),
      hit_count: responseHits.length,
      hits: responseHits.map((hit) => this.#serializeHit(hit)),
      context_groups: responseContextGroups.map((group) => serializeContextGroup(group))
    };
  }

  async #answer({
    query,
    rewrittenQuery,
    contextGroups,
    hits,
    referenceAnswer,
    conceptMatches,
    useLlm,
    requestOrigin
  }) {
    if (referenceAnswer) {
      return {
        answerMode: 'reference_lookup',
        answerText: referenceAnswer,
        contextSummary: buildContextSummaryFallback({ query, hits, contextGroups })
      };
    }

    if (!useLlm || !this.openRouterApiKey) {
      return {
        answerMode: 'retrieval_only',
        answerText: buildFallbackAnswer(query, hits),
        contextSummary: buildContextSummaryFallback({ query, hits, contextGroups })
      };
    }

    try {
      const contextText = contextGroups
        .map((group, index) => renderContextBlock(group, hits[index]?.verse?.reference || ''))
        .join('\n\n---\n\n');
      const conceptText = (conceptMatches || []).length
        ? conceptMatches
            .map(
              ({ concept }) =>
                `${concept.display_name}: ${concept.definition}\nEvidence cues: ${(concept.search_terms || []).join('; ')}\nExclusions: ${(concept.excludes || []).join('; ')}`
            )
            .join('\n\n')
        : 'No controlled-vocabulary concept was detected.';
      const response = await fetch(this.openRouterApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openRouterApiKey}`,
          ...(this.isOpenRouter
            ? {
                'HTTP-Referer': normalizeWhitespace(requestOrigin) || this.siteUrl,
                'X-Title': this.appName
              }
            : {})
        },
        body: JSON.stringify({
          model: this.openRouterModel,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You answer questions about the Srimad Bhagavatam using only the supplied passages and controlled-vocabulary concept definitions. Return JSON only with keys answer and context_summary. answer must be concise, lead with the single best PRIMARY reference like SB 10.15.10, add one short supporting sentence only when needed, and clearly say when the retrieved context is inconclusive. context_summary must be a short 1-2 sentence summary of what the retrieved passages cover, mention the main reference or chapter, and summarize the context rather than dumping verse text. Treat SUPPORTING ADJACENT CONTEXT as explanatory only: do not cite it as the answer location unless the user explicitly asks for neighboring verses or a range. Prefer the exact request or occurrence passage over a later response, fulfillment, summary, or retrospective mention. Do not broaden a defined concept beyond its definition or ignore its exclusions.'
            },
            {
              role: 'user',
              content:
                `Original user question:\n${query}\n\nSearch interpretation:\n${rewrittenQuery}\n\nControlled concept definitions:\n${conceptText}\n\nRetrieved Bhagavatam passages:\n${contextText}\n\n` +
                'Answer using only those passages. The returned context summary should summarize the retrieved passages, and the retrieved context itself includes Sanskrit, transliteration, and translation.'
            }
          ]
        }),
        signal: AbortSignal.timeout(this.answerTimeoutMs)
      });

      if (!response.ok) {
        throw new Error(`OpenRouter request failed with ${response.status}.`);
      }

      const payload = await response.json();
      const modelText = normalizeWhitespace(payload?.choices?.[0]?.message?.content || '');
      if (!modelText) throw new Error('OpenRouter returned an empty answer.');
      const parsed = extractJsonObject(modelText);
      const answerText = normalizeWhitespace(parsed?.answer || modelText);
      const contextSummary =
        normalizeWhitespace(parsed?.context_summary || '') ||
        buildContextSummaryFallback({ query, hits, contextGroups });
      if (!answerText) throw new Error('OpenRouter returned an empty answer.');
      return {
        answerMode: 'chat_completion',
        answerText,
        contextSummary
      };
    } catch (error) {
      console.error('Context search answer fallback:', error);
      return {
        answerMode: 'retrieval_only',
        answerText: buildFallbackAnswer(query, hits),
        contextSummary: buildContextSummaryFallback({ query, hits, contextGroups })
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
      semantic_score: Number((hit.semantic_score || 0).toFixed(4)),
      rerank_score: Number((hit.rerank_score || 0).toFixed(4)),
      chapter_score: Number((hit.chapter_score || 0).toFixed(4)),
      event_score: Number((hit.event_score || 0).toFixed(4)),
      retrospective_penalty: Number((hit.retrospective_penalty || 0).toFixed(4)),
      matched_chunk_type: hit.matched_chunk_type
    };
  }
}

export const createSbmContextSearchService = (options) => new SbmContextSearchService(options);
