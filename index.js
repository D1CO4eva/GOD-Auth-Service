import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, 'dist');
const indexHtmlPath = path.join(distPath, 'index.html');
const cacheFilePath = path.join(__dirname, 'cache.json');
const menuCacheFilePath = path.join(__dirname, 'menu_cache.json');
const emptyCacheRecord = {
  updatedAt: null,
  payload: null
};
const emptyMenuCacheRecord = {
  updatedAt: null,
  posts: []
};
const MENU_CACHE_LIMIT = 6;
const CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS = Number(
  process.env.CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS || 300
);
const backgroundRefreshIntervalMs =
  Number.isFinite(CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS) &&
  CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS > 0
    ? Math.floor(CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS * 1000)
    : 300000;
let refreshInFlight = null;

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for browser-based frontends hosted on another origin.
// Set `CORS_ORIGINS` to a comma-separated list, or `*` to allow all origins.
// If unset, default to the production website origins.
const DEFAULT_CORS_ORIGINS = [
  'https://atlanta.godivinity.org',
  'https://www.atlanta.godivinity.org'
];

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const effectiveCorsOrigins = corsOrigins.length > 0 ? corsOrigins : DEFAULT_CORS_ORIGINS;
const corsAllowAll = effectiveCorsOrigins.includes('*');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowedOrigin =
    !origin || corsAllowAll || effectiveCorsOrigins.includes(origin);

  if (req.method === 'OPTIONS' && !isAllowedOrigin) {
    return res.sendStatus(403);
  }

  if (origin && isAllowedOrigin) {
    if (corsAllowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Avoid cache poisoning when allowing a subset of origins.
      res.setHeader('Vary', 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const REQUIRED_ENV_KEYS = [
  'APPS_SCRIPT_URL',
  'APPS_SCRIPT_GET_TOKEN',
  'APPS_SCRIPT_POST_TOKEN'
];
const MENU_REQUIRED_ENV_KEYS = ['MENU_SCRIPT_URL'];
const OPENROUTER_REQUIRED_ENV_KEYS = ['OPENROUTER_API_KEY'];
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const previewSecret = (value) => {
  if (!value) return '(missing)';
  const s = String(value);
  const n = Math.min(4, s.length);
  return `${s.slice(0, n)}...${s.slice(-n)}`;
};

const missingRequiredEnv = () => REQUIRED_ENV_KEYS.filter((k) => !process.env[k]);
const hasAllRequiredEnv = () => missingRequiredEnv().length === 0;
const missingMenuEnv = () => MENU_REQUIRED_ENV_KEYS.filter((k) => !process.env[k]);
const hasAllMenuEnv = () => missingMenuEnv().length === 0;
const missingOpenRouterEnv = () => OPENROUTER_REQUIRED_ENV_KEYS.filter((k) => !process.env[k]);
const hasAllOpenRouterEnv = () => missingOpenRouterEnv().length === 0;

const logSecretPreviews = (label = 'Secret previews') => {
  console.log(
    [
      `${label}:`,
      `APPS_SCRIPT_URL=${previewSecret(process.env.APPS_SCRIPT_URL)}`,
      `APPS_SCRIPT_GET_TOKEN=${previewSecret(process.env.APPS_SCRIPT_GET_TOKEN)}`,
      `APPS_SCRIPT_POST_TOKEN=${previewSecret(process.env.APPS_SCRIPT_POST_TOKEN)}`,
      `MENU_SCRIPT_URL=${previewSecret(process.env.MENU_SCRIPT_URL)}`,
      `MENU_SCRIPT_TOKEN=${previewSecret(process.env.MENU_SCRIPT_TOKEN)}`,
      `OPENROUTER_API_KEY=${previewSecret(process.env.OPENROUTER_API_KEY)}`
    ].join(' ')
  );
};

const normalizeCacheRecord = (value) => {
  if (!value || typeof value !== 'object') {
    return { ...emptyCacheRecord };
  }

  const raw = value;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const payload = typeof raw.payload === 'string' ? raw.payload : null;

  return {
    updatedAt,
    payload
  };
};

const normalizeMenuCacheRecord = (value) => {
  if (!value || typeof value !== 'object') {
    return { ...emptyMenuCacheRecord };
  }

  const raw = value;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const rawPosts = Array.isArray(raw.posts)
    ? raw.posts
    : Array.isArray(raw.archives)
      ? raw.archives
      : [];
  const posts = rawPosts
    .map((entry, index) => normalizeMenuCachePostEntry(entry, index))
    .filter(Boolean)
    .slice(0, MENU_CACHE_LIMIT);

  return {
    updatedAt,
    posts
  };
};

const normalizeMenuCachePostEntry = (entry, index = 0) => {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry;
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt.trim()
      ? raw.createdAt
      : new Date(Date.now() - index).toISOString();
  const foods = extractFoodItemsFromEntry_(raw);
  if (foods.length === 0) return null;

  return {
    createdAt,
    foods
  };
};

const extractFoodItemsFromEntry_ = (entry) => {
  if (!entry || typeof entry !== 'object') return [];
  const directFoods = Array.isArray(entry.foods)
    ? entry.foods
    : Array.isArray(entry.items)
      ? entry.items
      : null;
  if (directFoods) {
    return dedupeFoodNames_(directFoods.map((item) => normalizeText(item)));
  }

  const payload = entry.payload && typeof entry.payload === 'object'
    ? entry.payload
    : entry.archive && typeof entry.archive === 'object'
      ? entry.archive
      : entry;

  return extractFoodItemsFromMenuPayload_(payload);
};

const extractFoodItemsFromMenuPayload_ = (payload) => {
  if (!payload || typeof payload !== 'object') return [];
  const courses = Array.isArray(payload.courses) ? payload.courses : [];
  const names = [];

  for (const course of courses) {
    const items = Array.isArray(course && course.items) ? course.items : [];
    for (const item of items) {
      const name = normalizeText(item && item.name);
      if (name) names.push(name);
    }
  }

  return dedupeFoodNames_(names);
};

const dedupeFoodNames_ = (items) => {
  const seen = new Set();
  const next = [];
  for (const raw of items) {
    const name = normalizeText(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(name);
  }
  return next;
};

const isCacheStale = (cacheRecord) => {
  if (!cacheRecord.updatedAt) return true;
  const updatedAtMs = Date.parse(cacheRecord.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return Date.now() - updatedAtMs >= backgroundRefreshIntervalMs;
};

const ensureCacheFile = async () => {
  try {
    await fsPromises.access(cacheFilePath, fs.constants.F_OK);
  } catch {
    await fsPromises.writeFile(cacheFilePath, `${JSON.stringify(emptyCacheRecord, null, 2)}\n`, 'utf8');
  }
};

const ensureMenuCacheFile = async () => {
  try {
    await fsPromises.access(menuCacheFilePath, fs.constants.F_OK);
  } catch {
    await fsPromises.writeFile(
      menuCacheFilePath,
      `${JSON.stringify(emptyMenuCacheRecord, null, 2)}\n`,
      'utf8'
    );
  }
};

const readCacheRecord = async () => {
  await ensureCacheFile();

  try {
    const content = await fsPromises.readFile(cacheFilePath, 'utf8');
    const parsed = JSON.parse(content);
    return normalizeCacheRecord(parsed);
  } catch (error) {
    console.error('Cache read failed. Resetting cache file.', error);
    await fsPromises.writeFile(cacheFilePath, `${JSON.stringify(emptyCacheRecord, null, 2)}\n`, 'utf8');
    return { ...emptyCacheRecord };
  }
};

const readMenuCacheRecord = async () => {
  await ensureMenuCacheFile();

  try {
    const content = await fsPromises.readFile(menuCacheFilePath, 'utf8');
    const parsed = JSON.parse(content);
    const normalized = normalizeMenuCacheRecord(parsed);

    // Self-heal legacy or oversized cache files by rewriting normalized structure.
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      await writeMenuCacheRecord(normalized);
    }

    return normalized;
  } catch (error) {
    console.error('Menu cache read failed. Resetting menu cache file.', error);
    await fsPromises.writeFile(
      menuCacheFilePath,
      `${JSON.stringify(emptyMenuCacheRecord, null, 2)}\n`,
      'utf8'
    );
    return { ...emptyMenuCacheRecord };
  }
};

const writeCacheRecord = async (record) => {
  const normalized = normalizeCacheRecord(record);
  const tmpPath = `${cacheFilePath}.tmp`;
  await fsPromises.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fsPromises.rename(tmpPath, cacheFilePath);
};

const writeMenuCacheRecord = async (record) => {
  const normalized = normalizeMenuCacheRecord(record);
  const tmpPath = `${menuCacheFilePath}.tmp`;
  await fsPromises.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fsPromises.rename(tmpPath, menuCacheFilePath);
};

const resetLocalCaches = async (target) => {
  const normalizedTarget = normalizeText(target).toLowerCase() || 'all';

  if (normalizedTarget === 'all' || normalizedTarget === 'bookings') {
    await writeCacheRecord({ ...emptyCacheRecord });
  }
  if (normalizedTarget === 'all' || normalizedTarget === 'menu') {
    await writeMenuCacheRecord({ ...emptyMenuCacheRecord });
  }

  if (
    normalizedTarget !== 'all' &&
    normalizedTarget !== 'bookings' &&
    normalizedTarget !== 'menu'
  ) {
    throw new Error('Invalid cache target. Use one of: all, bookings, menu.');
  }

  return normalizedTarget;
};

const parseJsonSafely = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const normalizeDateString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  const isoMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) return isoMatch[0];

  const usMatch = text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  if (usMatch) {
    const [monthStr, dayStr, yearStr] = usMatch[0].split('/');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
};

const normalizeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const normalizeProgramTypeForMatch = (value) => normalizeText(value).toLowerCase();
const normalizeTimeForMatch = (value) => normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
const normalizeEmailForMatch = (value) => normalizeText(value).toLowerCase();
const normalizeTokenForMatch = (value) => normalizeText(value).toLowerCase();
const normalizeConfirmationForMatch = (value) =>
  normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const asStringOrEmpty = (value) => normalizeText(value);
const normalizeMaybeUnknown = (value, fallback = 'N/A') => {
  const normalized = normalizeText(value);
  if (!normalized) return fallback;
  const lowered = normalized.toLowerCase();
  if (lowered === 'n/a' || lowered === 'na' || lowered === 'none' || lowered === 'null') {
    return fallback;
  }
  return normalized;
};
const normalizeEmail = (value) => normalizeMaybeUnknown(value, 'N/A');
const normalizeConfirmation = (value) => normalizeMaybeUnknown(value, 'N/A');
const normalizeOccasion = (value) => normalizeText(value);
const isKnownValue = (value) => normalizeMaybeUnknown(value, 'N/A') !== 'N/A';
const isInternalCommentsFieldKey = (value) => {
  const key = normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return key === 'internal comments' || key === 'internal comment';
};
const toCamelCaseKey = (value) => {
  const key = normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!key) return '';
  const parts = key.split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join('');
};
const flattenObjectToFieldMap = (value, prefix = '', out = {}) => {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = '';
    return out;
  }

  if (Array.isArray(value)) {
    if (prefix) out[prefix] = value.map((item) => normalizeText(item)).join(', ');
    return out;
  }

  if (typeof value !== 'object') {
    if (prefix) out[prefix] = value;
    return out;
  }

  for (const [rawKey, child] of Object.entries(value)) {
    const key = normalizeText(rawKey);
    if (!key) continue;
    const nextPrefix = prefix ? `${prefix} ${key}` : key;
    flattenObjectToFieldMap(child, nextPrefix, out);
  }
  return out;
};
const findObjectValuesByKeyHints = (obj, hints, options = {}) => {
  if (!obj || typeof obj !== 'object') return [];
  const loweredHints = hints.map((hint) => normalizeText(hint).toLowerCase()).filter(Boolean);
  const excludeHints = (options.excludeHints || [])
    .map((hint) => normalizeText(hint).toLowerCase())
    .filter(Boolean);
  if (!loweredHints.length) return [];

  const preferredMatches = [];
  const fallbackMatches = [];
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = normalizeText(rawKey).toLowerCase();
    if (!key) continue;
    if (!loweredHints.some((hint) => key.includes(hint))) continue;

    if (excludeHints.some((hint) => key.includes(hint))) {
      fallbackMatches.push(rawValue);
      continue;
    }
    preferredMatches.push(rawValue);
  }

  return [...preferredMatches, ...fallbackMatches];
};
const collectValuesByFieldHints = (fieldMap, hints, options = {}) => {
  const loweredHints = hints.map((hint) => normalizeText(hint).toLowerCase()).filter(Boolean);
  const excludeHints = (options.excludeHints || [])
    .map((hint) => normalizeText(hint).toLowerCase())
    .filter(Boolean);
  if (!loweredHints.length) return [];

  const preferred = [];
  const fallback = [];
  for (const [rawKey, rawValue] of Object.entries(fieldMap || {})) {
    const key = normalizeText(rawKey).toLowerCase();
    if (!key) continue;
    if (!loweredHints.some((hint) => key.includes(hint))) continue;
    if (excludeHints.some((hint) => key.includes(hint))) {
      fallback.push(rawValue);
      continue;
    }
    preferred.push(rawValue);
  }

  return [...preferred, ...fallback];
};
const pickPreferredKnownValue = (values) => {
  const list = Array.isArray(values) ? values : [];
  for (const value of list) {
    if (isKnownValue(value)) return value;
  }
  return list.find((value) => value !== undefined && value !== null) ?? '';
};
const buildPublicBookingFields = (fieldMap) => {
  const next = {};
  for (const [rawKey, rawValue] of Object.entries(fieldMap || {})) {
    if (isInternalCommentsFieldKey(rawKey)) continue;
    const key = toCamelCaseKey(rawKey);
    if (!key) continue;
    next[key] = normalizeText(rawValue);
  }
  return next;
};
const bookingKey = (item) => {
  const date = normalizeDateString(item?.date) || '';
  const type = normalizeProgramTypeForMatch(item?.type);
  const time = normalizeTimeForMatch(item?.time);
  const email = normalizeEmailForMatch(normalizeEmail(item?.email));
  const confirmation = normalizeConfirmationForMatch(normalizeConfirmation(item?.confirmationNumber));
  return `${date}|${type}|${time}|${email}|${confirmation}`;
};
const looseBookingKey = (item) => {
  const date = normalizeDateString(item?.date) || '';
  return `${date}|${normalizeProgramTypeForMatch(item?.type)}|${normalizeTimeForMatch(item?.time)}`;
};
const mergeBookingMetadata = (incoming, prior) => {
  const incomingEmail = normalizeEmail(incoming?.email);
  const priorEmail = normalizeEmail(prior?.email);
  const incomingConfirmation = normalizeConfirmation(incoming?.confirmationNumber);
  const priorConfirmation = normalizeConfirmation(prior?.confirmationNumber);
  const incomingOccasion = normalizeOccasion(incoming?.occasion);
  const priorOccasion = normalizeOccasion(prior?.occasion);

  return {
    date: normalizeDateString(incoming?.date) || normalizeDateString(prior?.date) || '',
    type: normalizeText(incoming?.type) || normalizeText(prior?.type),
    time: normalizeText(incoming?.time) || normalizeText(prior?.time),
    email: isKnownValue(incomingEmail) ? incomingEmail : priorEmail,
    confirmationNumber: isKnownValue(incomingConfirmation) ? incomingConfirmation : priorConfirmation,
    occasion: incomingOccasion || priorOccasion
  };
};

const sanitizeForAppsScript = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(sanitizeForAppsScript);
  if (typeof value === 'object') {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = sanitizeForAppsScript(child);
    }
    return next;
  }
  return value;
};

const extractBookingsFromRow = (
  row,
  dateCol,
  programCol,
  timeCol,
  emailCols,
  confirmationCols,
  occasionCol
) => {
  if (Array.isArray(row)) {
    const headerRow = Array.isArray(dateCol) ? dateCol : null;
    const resolvedDateCol = Array.isArray(dateCol)
      ? headerRow.findIndex((cell) => String(cell).toLowerCase().includes('date'))
      : dateCol;
    const resolvedProgramCol =
      typeof programCol === 'number'
        ? programCol
        : headerRow
          ? headerRow.findIndex((cell) => {
              const text = String(cell).toLowerCase();
              return (
                text.includes('type of program') ||
                text.includes('program type') ||
                text.includes('program')
              );
            })
          : -1;
    const resolvedTimeCol =
      typeof timeCol === 'number'
        ? timeCol
        : headerRow
          ? headerRow.findIndex((cell) => String(cell).toLowerCase().includes('time'))
          : -1;
    const resolvedOccasionCol =
      typeof occasionCol === 'number'
        ? occasionCol
        : headerRow
          ? headerRow.findIndex((cell) => String(cell).toLowerCase().includes('occasion'))
          : -1;
    const pickPreferredCellValue = (candidateCols) => {
      const validCandidates = Array.isArray(candidateCols)
        ? candidateCols.filter((col) => Number.isInteger(col) && col >= 0 && col < row.length)
        : [];
      if (!validCandidates.length) return '';

      // Prefer an actual value over blank/N/A when multiple matching headers exist.
      for (const col of validCandidates) {
        const value = row[col];
        if (isKnownValue(value)) return value;
      }
      return row[validCandidates[0]];
    };

    const fieldMap = {};
    if (headerRow) {
      for (let i = 0; i < headerRow.length; i += 1) {
        const header = normalizeText(headerRow[i]);
        if (!header) continue;
        fieldMap[header] = row[i];
      }
    }

    const rawDate = resolvedDateCol >= 0 ? row[resolvedDateCol] : row[0];
    const rawType = resolvedProgramCol >= 0 ? row[resolvedProgramCol] : '';
    const rawTime = resolvedTimeCol >= 0 ? row[resolvedTimeCol] : '';
    const rawEmail = pickPreferredCellValue(emailCols);
    const rawConfirmation = pickPreferredCellValue(confirmationCols);
    const rawOccasion = resolvedOccasionCol >= 0 ? row[resolvedOccasionCol] : '';
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    const publicFields = buildPublicBookingFields(fieldMap);
    return [{
      ...publicFields,
      date,
      type: normalizeText(rawType),
      time: normalizeText(rawTime),
      email: normalizeEmail(rawEmail),
      confirmationNumber: normalizeConfirmation(rawConfirmation),
      occasion: normalizeOccasion(rawOccasion)
    }];
  }

  if (row && typeof row === 'object') {
    const obj = row;
    const fieldMap = flattenObjectToFieldMap(obj);
    const rawDate = pickPreferredKnownValue([
      ...collectValuesByFieldHints(fieldMap, [
        'date of program',
        'program date',
        'date'
      ], { excludeHints: ['updated'] }),
      obj.date,
      obj.Date
    ]);
    const rawType = pickPreferredKnownValue([
      ...collectValuesByFieldHints(fieldMap, [
        'type of program',
        'program type',
        'program'
      ]),
      obj.type,
      obj.Type
    ]);
    const rawTime = pickPreferredKnownValue([
      ...collectValuesByFieldHints(fieldMap, ['time slot', 'program time', 'time']),
      obj.time,
      obj.Time
    ]);
    const rawEmail = pickPreferredKnownValue([
      ...collectValuesByFieldHints(
        fieldMap,
        ['host email', 'email address', 'email'],
        { excludeHints: ['current', 'new'] }
      ),
      ...findObjectValuesByKeyHints(obj, ['email'], {
        excludeHints: ['current', 'new']
      })
    ]);
    const rawConfirmation = pickPreferredKnownValue([
      ...collectValuesByFieldHints(
        fieldMap,
        [
          'rk number',
          'rk',
          'confirmation number',
          'conformation number',
          'confirmation',
          'conformation',
          'reservation number',
          'reservation id',
          'booking id',
          'reference number',
          'reference id',
          'ref number',
          'ref id'
        ],
        { excludeHints: ['current', 'new'] }
      ),
      ...findObjectValuesByKeyHints(
        obj,
        [
          'rk number',
          'rk',
          'confirmation',
          'conformation',
          'confirm',
          'reservation number',
          'reservation id',
          'booking id',
          'reference number',
          'reference id',
          'ref number',
          'ref id'
        ],
        { excludeHints: ['current', 'new'] }
      )
    ]);
    const rawOccasion = pickPreferredKnownValue([
      ...collectValuesByFieldHints(fieldMap, ['occasion']),
      obj.occasion,
      obj.Occasion
    ]);
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    const publicFields = buildPublicBookingFields(fieldMap);
    return [{
      ...publicFields,
      date,
      type: normalizeText(rawType),
      time: normalizeText(rawTime),
      email: normalizeEmail(rawEmail),
      confirmationNumber: normalizeConfirmation(rawConfirmation),
      occasion: normalizeOccasion(rawOccasion)
    }];
  }

  if (typeof row === 'string') {
    const date = normalizeDateString(row);
    return date
      ? [{ date, type: '', time: '', email: 'N/A', confirmationNumber: 'N/A', occasion: '' }]
      : [];
  }

  return [];
};

const extractBookings = (data) => {
  if (!data) return [];

  const rows = [];
  if (Array.isArray(data)) {
    rows.push(...data);
  } else if (typeof data === 'object') {
    const obj = data;
    const container =
      (Array.isArray(obj.data) && obj.data) ||
      (Array.isArray(obj.bookings) && obj.bookings) ||
      (Array.isArray(obj.rows) && obj.rows);
    if (container) rows.push(...container);
  }

  if (!rows.length) return [];

  const headerRow = Array.isArray(rows[0]) ? rows[0] : null;
  let startIndex = 0;
  let dateCol = -1;
  let programCol = -1;
  let timeCol = -1;
  let emailCols = [];
  let confirmationCols = [];
  let occasionCol = -1;

  if (headerRow) {
    const headerStrings = headerRow.map((cell) => String(cell).toLowerCase());
    if (headerStrings.some((cell) => cell.includes('date'))) {
      startIndex = 1;
    }
    dateCol = headerStrings.findIndex((cell) => cell.includes('date'));
    programCol = headerStrings.findIndex(
      (cell) => cell.includes('type of program') || cell.includes('program type') || cell.includes('program')
    );
    timeCol = headerStrings.findIndex((cell) => cell.includes('time'));
    const appendHeaderIndexes = (matcher) => {
      const indexes = [];
      for (let i = 0; i < headerStrings.length; i += 1) {
        if (matcher(headerStrings[i])) indexes.push(i);
      }
      return indexes;
    };
    const uniqueIndexes = (indexes) => [...new Set(indexes)].filter((index) => index >= 0);
    emailCols = uniqueIndexes([
      ...appendHeaderIndexes(
        (cell) =>
          (cell.includes('host email') || cell === 'email' || cell.includes('email address')) &&
          !cell.includes('current')
      ),
      ...appendHeaderIndexes((cell) => cell.includes('email') && !cell.includes('current')),
      ...appendHeaderIndexes((cell) => cell.includes('email'))
    ]);
    confirmationCols = uniqueIndexes([
      ...appendHeaderIndexes(
        (cell) =>
          (cell.includes('rk number') || cell === 'rk' || (cell.includes('rk') && cell.includes('number'))) &&
          !cell.includes('current') &&
          !cell.includes('new')
      ),
      ...appendHeaderIndexes(
        (cell) =>
          cell.includes('confirmation number') && !cell.includes('current') && !cell.includes('new')
      ),
      ...appendHeaderIndexes(
        (cell) => cell.includes('confirmation') && !cell.includes('current') && !cell.includes('new')
      ),
      ...appendHeaderIndexes(
        (cell) => cell.includes('conformation') && !cell.includes('current') && !cell.includes('new')
      ),
      ...appendHeaderIndexes(
        (cell) =>
          (cell.includes('confirm') || cell.includes('reservation') || cell.includes('reference')) &&
          !cell.includes('current') &&
          !cell.includes('new')
      ),
      ...appendHeaderIndexes((cell) => cell.includes('confirmation') || cell.includes('confirm'))
    ]);
    occasionCol = headerStrings.findIndex((cell) => cell.includes('occasion'));
  }

  const bookings = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    bookings.push(
      ...extractBookingsFromRow(
        rows[i],
        headerRow,
        programCol,
        timeCol,
        emailCols,
        confirmationCols,
        occasionCol
      )
    );
  }

  return bookings;
};

const dedupeAndSortBookings = (bookings) => {
  const byKey = new Map();
  for (const item of bookings) {
    const key = bookingKey(item);
    if (!key || key.startsWith('|')) continue;

    const normalized = {
      date: normalizeDateString(item.date) || '',
      type: normalizeText(item.type),
      time: normalizeText(item.time),
      email: normalizeEmail(item.email),
      confirmationNumber: normalizeConfirmation(item.confirmationNumber),
      occasion: normalizeOccasion(item.occasion)
    };

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalized);
      continue;
    }

    byKey.set(key, mergeBookingMetadata(normalized, existing));
  }

  const unique = Array.from(byKey.values());

  unique.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    if (left.time !== right.time) return left.time.localeCompare(right.time);
    if (left.email !== right.email) return left.email.localeCompare(right.email);
    return left.confirmationNumber.localeCompare(right.confirmationNumber);
  });

  return unique;
};

const dedupeAndSortPublicBookings = (bookings) => {
  const byKey = new Map();
  for (const item of bookings || []) {
    const date = normalizeDateString(item?.date) || '';
    if (!date) continue;
    const programType = normalizeText(item?.programType || item?.type);
    const time = normalizeText(item?.time);
    const key = `${date}|${normalizeProgramTypeForMatch(programType)}|${normalizeTimeForMatch(time)}`;
    if (!byKey.has(key)) {
      byKey.set(key, { date, programType, time });
    }
  }

  const unique = Array.from(byKey.values());
  unique.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    if (left.programType !== right.programType) return left.programType.localeCompare(right.programType);
    return left.time.localeCompare(right.time);
  });
  return unique;
};

const toCanonicalPayload = (bookings) => JSON.stringify({ bookings: dedupeAndSortPublicBookings(bookings) });

const appendBookingToCache = async (postBody, postResult) => {
  const rawDate =
    postBody.Date ||
    postBody.date ||
    postBody.programDate ||
    postBody.program_date ||
    postBody['Program Date'];
  const rawType =
    postBody['Type of Program'] ||
    postBody.typeOfProgram ||
    postBody.type ||
    postBody['Program Type'] ||
    postBody.program;
  const rawTime = postBody.Time || postBody.time || postBody['Time Slot'] || postBody.programTime;
  const rawEmail =
    postBody['Host email'] ||
    postBody['Host Email'] ||
    postBody.hostEmail ||
    postBody.email ||
    postBody.Email;
  const rawConfirmation =
    postBody['Confirmation Number'] ||
    postBody.confirmationNumber ||
    postBody.confirmation ||
    postResult?.confirmationNumber ||
    postResult?.['Confirmation Number'] ||
    postBody['confirmation number'];
  const rawOccasion =
    postBody.Occasion ||
    postBody.occasion ||
    postBody['Occasion / Reason'] ||
    '';

  const date = normalizeDateString(rawDate);
  if (!date) return;

  const cacheRecord = await readCacheRecord();
  const cachedData = cacheRecord.payload ? parseJsonSafely(cacheRecord.payload) : null;
  const existingBookings = extractBookings(cachedData);
  const nextBookings = dedupeAndSortBookings([
    ...existingBookings,
    {
      date,
      type: normalizeText(rawType),
      time: normalizeText(rawTime),
      email: normalizeEmail(rawEmail),
      confirmationNumber: normalizeConfirmation(rawConfirmation),
      occasion: normalizeOccasion(rawOccasion)
    }
  ]);

  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: toCanonicalPayload(nextBookings)
  });
};

const parseReservationLookup = (body) => {
  const rawProgramType =
    body.programType ||
    body.typeOfProgram ||
    body.type ||
    body['Type of Program'] ||
    body['Program Type'] ||
    '';
  const rawDate = body.date || body.Date || body.programDate || body['Program Date'] || '';
  const rawTime = body.time || body.Time || body['Time Slot'] || body.programTime || '';
  const rawEmail =
    body.email ||
    body.Email ||
    body.hostEmail ||
    body['Host email'] ||
    body['Host Email'] ||
    '';
  const rawConfirmation =
    body.confirmationNumber ||
    body.confirmation ||
    body['Confirmation Number'] ||
    body['confirmation number'] ||
    '';

  return {
    programType: normalizeText(rawProgramType),
    date: normalizeDateString(rawDate),
    time: normalizeText(rawTime),
    email: normalizeEmail(rawEmail),
    confirmationNumber: normalizeConfirmation(rawConfirmation)
  };
};

const findMatchingBookingIndex = (bookings, lookup) => {
  const normalizedProgramType = normalizeProgramTypeForMatch(lookup.programType);
  const normalizedLookupTime = normalizeTimeForMatch(lookup.time);
  const normalizedLookupEmail = normalizeEmailForMatch(normalizeEmail(lookup.email));
  const normalizedLookupConfirmation = normalizeConfirmationForMatch(
    normalizeConfirmation(lookup.confirmationNumber)
  );

  return bookings.findIndex((booking) => {
    if (normalizeDateString(booking.date) !== lookup.date) return false;
    if (normalizeProgramTypeForMatch(booking.type) !== normalizedProgramType) return false;
    if (normalizedLookupTime && normalizeTimeForMatch(booking.time) !== normalizedLookupTime) return false;
    if (normalizeEmailForMatch(normalizeEmail(booking.email)) !== normalizedLookupEmail) return false;
    return (
      normalizeConfirmationForMatch(normalizeConfirmation(booking.confirmationNumber)) ===
      normalizedLookupConfirmation
    );
  });
};

const loadBookingsFromCacheOrSource = async (reason) => {
  const refreshResult = await refreshCacheFromAppsScriptSafely(reason);
  if (!refreshResult?.ok) {
    const error = new Error('Failed to refresh bookings from Apps Script.');
    error.status = refreshResult?.status || 502;
    throw error;
  }

  const parsed = parseJsonSafely(refreshResult.rawText || refreshResult.text);
  return dedupeAndSortBookings(extractBookings(parsed));
};

const updateReservationInCache = async (lookup, updates) => {
  const cacheRecord = await readCacheRecord();
  if (!cacheRecord.payload) return false;

  const parsed = parseJsonSafely(cacheRecord.payload);
  const bookings = dedupeAndSortBookings(extractBookings(parsed));
  const matchIndex = findMatchingBookingIndex(bookings, lookup);
  if (matchIndex < 0) return false;

  const next = [...bookings];
  const current = next[matchIndex];
  next[matchIndex] = {
    ...current,
    date: updates.date || current.date,
    time: normalizeText(updates.time || current.time)
  };

  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: toCanonicalPayload(next)
  });
  return true;
};

const deleteReservationFromCache = async (lookup) => {
  const cacheRecord = await readCacheRecord();
  if (!cacheRecord.payload) return false;

  const parsed = parseJsonSafely(cacheRecord.payload);
  const bookings = dedupeAndSortBookings(extractBookings(parsed));
  const matchIndex = findMatchingBookingIndex(bookings, lookup);
  if (matchIndex < 0) return false;

  const next = bookings.filter((_, index) => index !== matchIndex);
  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: toCanonicalPayload(next)
  });
  return true;
};

const fetchBookingsFromAppsScript = async () => {
  const readUrl = new URL(process.env.APPS_SCRIPT_URL);
  readUrl.searchParams.set('token', process.env.APPS_SCRIPT_GET_TOKEN);

  const response = await fetch(readUrl.toString(), {
    method: 'GET',
    cache: 'no-cache'
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text
  };
};

const verifyConfirmationWithAppsScript = async (confirmationNumber) => {
  const readUrl = new URL(process.env.APPS_SCRIPT_URL);
  readUrl.searchParams.set('token', process.env.APPS_SCRIPT_GET_TOKEN);
  readUrl.searchParams.set('confirmation', normalizeText(confirmationNumber));

  const response = await fetch(readUrl.toString(), {
    method: 'GET',
    cache: 'no-cache'
  });

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      exists: false,
      text
    };
  }

  const parsed = parseJsonSafely(text);
  if (parsed === null) {
    const lowered = normalizeText(text).toLowerCase();
    if (!lowered) return { ok: true, status: response.status, exists: false, text };
    if (
      lowered.includes('not found') ||
      lowered.includes('no booking') ||
      lowered.includes('no reservation')
    ) {
      return { ok: true, status: response.status, exists: false, text };
    }
    return { ok: true, status: response.status, exists: true, text };
  }

  const normalizedLookup = normalizeConfirmationForMatch(confirmationNumber);
  const extracted = extractBookings(parsed);
  if (
    extracted.some(
      (item) =>
        normalizeConfirmationForMatch(normalizeConfirmation(item?.confirmationNumber)) ===
        normalizedLookup
    )
  ) {
    return { ok: true, status: response.status, exists: true, text };
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.bookings)
        ? parsed.bookings
        : Array.isArray(parsed.rows)
          ? parsed.rows
          : [];
  return {
    ok: true,
    status: response.status,
    exists: rows.length > 0,
    text
  };
};

const postToAppsScript = async (body) => {
  const payload = sanitizeForAppsScript({
    ...(body || {}),
    token: process.env.APPS_SCRIPT_POST_TOKEN
  });
  const expectedStringKeys = [
    'Date',
    'Time',
    'Type of Program',
    'Program Type',
    'Host Name',
    'Host Address',
    'Host Phone Number',
    'Host email',
    'Host Email',
    'Email',
    'Confirmation Number',
    'confirmationNumber',
    'confirmation',
    'Occasion',
    'Additional Notes',
    'Current Date',
    'Current Time',
    'Current Email',
    'Current Confirmation Number',
    'New Date',
    'New Time',
    'newDate',
    'action',
    'operation'
  ];
  for (const key of expectedStringKeys) {
    if (payload[key] === undefined || payload[key] === null) {
      payload[key] = '';
    }
  }

  const postUrl = new URL(process.env.APPS_SCRIPT_URL);
  // Send key fields as query params too, so Apps Script implementations that use
  // e.parameter.* instead of JSON body still receive non-null strings.
  for (const key of expectedStringKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      postUrl.searchParams.set(key, value);
    }
  }

  const response = await fetch(postUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text
  };
};

const refreshCacheFromAppsScript = async () => {
  const result = await fetchBookingsFromAppsScript();
  if (!result.ok) {
    return result;
  }

  const parsed = parseJsonSafely(result.text);
  if (parsed === null) {
    await writeCacheRecord({
      updatedAt: new Date().toISOString(),
      payload: result.text
    });
    return {
      ...result,
      text: result.text,
      rawText: result.text
    };
  }

  const incomingBookings = extractBookings(parsed);
  const existingCacheRecord = await readCacheRecord();
  const existingParsed = existingCacheRecord.payload ? parseJsonSafely(existingCacheRecord.payload) : null;
  const existingBookings = existingParsed ? extractBookings(existingParsed) : [];
  const existingLooseMap = new Map();
  for (const item of existingBookings) {
    const key = looseBookingKey(item);
    const prior = existingLooseMap.get(key);
    existingLooseMap.set(key, prior ? mergeBookingMetadata(item, prior) : item);
  }

  const enrichedIncoming = incomingBookings.map((item) => {
    const prior = existingLooseMap.get(looseBookingKey(item));
    return mergeBookingMetadata(item, prior || {});
  });

  const canonicalPayload = toCanonicalPayload(enrichedIncoming);

  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: canonicalPayload
  });

  return {
    ...result,
    text: canonicalPayload,
    rawText: result.text
  };
};

const refreshCacheFromAppsScriptSafely = async (reason) => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const refreshResult = await refreshCacheFromAppsScript();
      if (!refreshResult.ok) {
        console.error(`Cache refresh failed (${reason}):`, refreshResult.status);
      } else {
        console.log(`Cache refreshed (${reason}).`);
      }
      return refreshResult;
    } catch (error) {
      console.error(`Cache refresh error (${reason}):`, error);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};

const buildMenuScriptUrl = (action, params = {}) => {
  const url = new URL(process.env.MENU_SCRIPT_URL);
  if (action) {
    url.searchParams.set('action', action);
  }
  if (process.env.MENU_SCRIPT_TOKEN) {
    url.searchParams.set('token', process.env.MENU_SCRIPT_TOKEN);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    url.searchParams.set(key, text);
  }
  return url;
};

const postMenuToAppsScript = async (body) => {
  const payload = sanitizeForAppsScript(body || {});
  const hasIncomingToken =
    payload &&
    typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'token') &&
    normalizeText(payload.token).length > 0;

  if (process.env.MENU_SCRIPT_TOKEN && !hasIncomingToken) {
    payload.token = process.env.MENU_SCRIPT_TOKEN;
  }

  const postUrl = buildMenuScriptUrl('');
  if (process.env.MENU_SCRIPT_TOKEN && !postUrl.searchParams.get('token')) {
    postUrl.searchParams.set('token', process.env.MENU_SCRIPT_TOKEN);
  }

  const response = await fetch(postUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text
  };
};

const buildGenerateRequestPayload = (body) => {
  const raw = body && typeof body === 'object' ? body : {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const payload = {
    model: normalizeText(raw.model) || 'openai/gpt-4o-mini',
    messages
  };

  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    payload.temperature = raw.temperature;
  }
  if (typeof raw.max_tokens === 'number' && Number.isFinite(raw.max_tokens)) {
    payload.max_tokens = Math.max(1, Math.floor(raw.max_tokens));
  }
  if (
    raw.response_format &&
    typeof raw.response_format === 'object' &&
    !Array.isArray(raw.response_format)
  ) {
    payload.response_format = raw.response_format;
  }
  if (typeof raw.top_p === 'number' && Number.isFinite(raw.top_p)) {
    payload.top_p = raw.top_p;
  }
  if (typeof raw.presence_penalty === 'number' && Number.isFinite(raw.presence_penalty)) {
    payload.presence_penalty = raw.presence_penalty;
  }
  if (typeof raw.frequency_penalty === 'number' && Number.isFinite(raw.frequency_penalty)) {
    payload.frequency_penalty = raw.frequency_penalty;
  }

  return payload;
};

const generateWithOpenRouter = async (payload, requestOrigin) => {
  const origin = normalizeText(requestOrigin) || 'https://atlanta.godivinity.org';
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': origin,
      'X-Title': 'GOD Menu Planner'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text
  };
};

const appendMenuPostToCache = async (menuPayload, _appsScriptResponse) => {
  const existing = await readMenuCacheRecord();
  const foods = extractFoodItemsFromMenuPayload_(menuPayload || {});
  if (foods.length === 0) {
    throw new Error('No menu food items found in payload.courses[].items[].name.');
  }

  const entry = normalizeMenuCachePostEntry({
    createdAt: new Date().toISOString(),
    foods
  });

  const nextPosts = [entry, ...(existing.posts || [])].slice(0, MENU_CACHE_LIMIT);
  const nextRecord = {
    updatedAt: new Date().toISOString(),
    posts: nextPosts
  };
  await writeMenuCacheRecord(nextRecord);
  return nextRecord;
};

app.post(['/api/cache/reset', '/cache/reset'], async (req, res) => {
  try {
    const body = req.body || {};
    const target = body.target || body.cache || 'all';
    const appliedTarget = await resetLocalCaches(target);

    return res.status(200).json({
      ok: true,
      message: 'Cache reset completed.',
      target: appliedTarget
    });
  } catch (error) {
    console.error('Cache reset error:', error);
    return res.status(400).json({
      ok: false,
      error: error && error.message ? error.message : 'Failed to reset cache.'
    });
  }
});

app.post(['/generate', '/api/generate'], async (req, res) => {
  if (!hasAllOpenRouterEnv()) {
    return res.status(500).json({
      error: 'Server is missing required OpenRouter secrets.',
      missing: missingOpenRouterEnv()
    });
  }

  try {
    const payload = buildGenerateRequestPayload(req.body || {});
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty messages array.' });
    }

    const result = await generateWithOpenRouter(payload, req.headers.origin);
    return res.status(result.status || (result.ok ? 200 : 500)).type('application/json').send(result.text);
  } catch (error) {
    console.error('Generate route error:', error);
    return res.status(500).json({ error: 'Failed to generate menu.' });
  }
});

app.get('/api/bookings', async (_req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const cacheRecord = await readCacheRecord();
    if (cacheRecord.payload) {
      const parsedCachedPayload = parseJsonSafely(cacheRecord.payload);
      if (parsedCachedPayload !== null) {
        const normalizedPayload = toCanonicalPayload(extractBookings(parsedCachedPayload));
        if (normalizedPayload !== cacheRecord.payload) {
          await writeCacheRecord({
            updatedAt: cacheRecord.updatedAt || new Date().toISOString(),
            payload: normalizedPayload
          });
        }
        if (isCacheStale(cacheRecord)) {
          void refreshCacheFromAppsScriptSafely('stale-get');
        }
        res.setHeader('X-Bookings-Source', 'cache-file');
        return res.status(200).type('application/json').send(normalizedPayload);
      }

      const refreshResult = await refreshCacheFromAppsScriptSafely('invalid-cache-get');
      if (refreshResult?.ok) {
        res.setHeader('X-Bookings-Source', 'apps-script');
        return res.status(200).type('application/json').send(refreshResult.text);
      }
      return res.status(500).json({ error: 'Failed to load bookings.' });
    }

    const refreshResult = await refreshCacheFromAppsScriptSafely('cache-empty-get');
    if (refreshResult?.ok) {
      res.setHeader('X-Bookings-Source', 'apps-script');
      return res.status(200).type('application/json').send(refreshResult.text);
    }

    res
      .status(refreshResult?.status || 500)
      .type('application/json')
      .send(refreshResult?.text || JSON.stringify({ error: 'Failed to load bookings.' }));
  } catch (error) {
    console.error('Read error:', error);
    res.status(500).json({ error: 'Failed to load bookings.' });
  }
});

const handleBookingsRefresh = async (_req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const refreshResult = await refreshCacheFromAppsScriptSafely('manual-refresh');
    if (!refreshResult?.ok) {
      return res
        .status(refreshResult?.status || 500)
        .type('application/json')
        .send(refreshResult?.text || JSON.stringify({ error: 'Failed to refresh bookings cache.' }));
    }

    const parsed = parseJsonSafely(refreshResult.text);
    const bookings = Array.isArray(parsed?.bookings) ? parsed.bookings : [];
    return res.status(200).json({
      ok: true,
      message: 'Bookings cache refreshed from Google Sheets.',
      bookingsCount: bookings.length,
      bookings
    });
  } catch (error) {
    console.error('Manual bookings refresh error:', error);
    return res.status(500).json({ error: 'Failed to refresh bookings cache.' });
  }
};

app.get(['/bookings/refresh', '/api/bookings/refresh'], handleBookingsRefresh);
app.post(['/bookings/refresh', '/api/bookings/refresh'], handleBookingsRefresh);

app.post('/api/bookings', async (req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const result = await postToAppsScript(req.body || {});
    if (result.ok) {
      try {
        const parsedResult = parseJsonSafely(result.text) || {};
        await appendBookingToCache(req.body || {}, parsedResult);
        void refreshCacheFromAppsScriptSafely('post-reconcile');
      } catch (cacheError) {
        console.error('Cache append after POST failed:', cacheError);
      }
    }
    res.status(result.ok ? 200 : result.status).type('application/json').send(result.text);
  } catch (error) {
    console.error('Write error:', error);
    res.status(500).json({ error: 'Failed to submit booking.' });
  }
});

app.post('/api/reservations/verify', async (req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const body = req.body || {};
    const rawConfirmation =
      body.confirmationNumber ||
      body.confirmation ||
      body['Confirmation Number'] ||
      body['confirmation number'] ||
      '';
    const confirmationNumber = normalizeConfirmation(rawConfirmation);
    if (!isKnownValue(confirmationNumber)) {
      return res.status(400).json({
        error: 'confirmationNumber is required.'
      });
    }

    const verifyResult = await verifyConfirmationWithAppsScript(confirmationNumber);
    if (!verifyResult.ok) {
      return res.status(502).json({
        error: 'Unable to verify booking right now. Please try again shortly.'
      });
    }

    if (!verifyResult.exists) {
      return res.status(404).json({
        message: 'Sorry, could not find your booking'
      });
    }

    return res.status(200).json({
      message: 'Booking Exists'
    });
  } catch (error) {
    console.error('Reservation verify error:', error);
    return res.status(500).json({ error: 'Failed to verify reservation.' });
  }
});

app.post('/api/reservations/update', async (req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const body = req.body || {};
    const lookup = parseReservationLookup(body.lookup || body.current || body);
    const updatesSource = body.updates || body.next || body;
    const nextDate = normalizeDateString(
      updatesSource.newDate || updatesSource.date || updatesSource.Date || updatesSource['New Date']
    );
    const nextTime = normalizeText(
      updatesSource.newTime ||
        updatesSource.time ||
        updatesSource.Time ||
        updatesSource['New Time'] ||
        updatesSource['Time Slot']
    );

    if (
      !lookup.programType ||
      !lookup.date ||
      !isKnownValue(lookup.email) ||
      !isKnownValue(lookup.confirmationNumber)
    ) {
      return res.status(400).json({ error: 'Current reservation details are required.' });
    }
    if (!nextDate) {
      return res.status(400).json({ error: 'New date is required.' });
    }

    const bookings = await loadBookingsFromCacheOrSource('reservation-update-verify');
    const matchIndex = findMatchingBookingIndex(bookings, lookup);
    if (matchIndex < 0) {
      return res.status(404).json({
        found: false,
        message: 'Sorry! Could not find your Reservation! Please try again.'
      });
    }
    const matchedBooking = bookings[matchIndex];
    const matchedEmail = normalizeEmail(matchedBooking.email || lookup.email);
    const matchedConfirmation = normalizeConfirmation(
      matchedBooking.confirmationNumber || lookup.confirmationNumber
    );
    const matchedDate = normalizeDateString(matchedBooking.date) || lookup.date;
    const matchedTime = normalizeText(matchedBooking.time || lookup.time);

    const result = await postToAppsScript({
      ...body,
      action: 'reschedule',
      operation: 'reschedule',
      reservationLookup: lookup,
      reservationUpdate: {
        date: nextDate,
        ...(nextTime ? { time: nextTime } : {})
      },
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(matchedDate),
      Time: asStringOrEmpty(matchedTime),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(matchedEmail),
      'Confirmation Number': asStringOrEmpty(matchedConfirmation),
      newDate: asStringOrEmpty(nextDate),
      ...(nextTime ? { newTime: asStringOrEmpty(nextTime) } : {}),
      // Explicit current/new keys for reservation update flows.
      'Current Date': asStringOrEmpty(matchedDate),
      'Current Time': asStringOrEmpty(matchedTime),
      'Current Email': asStringOrEmpty(matchedEmail),
      'Current Confirmation Number': asStringOrEmpty(matchedConfirmation),
      'New Date': asStringOrEmpty(nextDate),
      ...(nextTime ? { 'New Time': asStringOrEmpty(nextTime) } : {})
    });

    if (result.ok) {
      try {
        await updateReservationInCache(lookup, {
          date: nextDate,
          ...(nextTime ? { time: nextTime } : {})
        });
        void refreshCacheFromAppsScriptSafely('reservation-update-reconcile');
      } catch (cacheError) {
        console.error('Cache update after reservation update failed:', cacheError);
      }
    }

    return res.status(result.ok ? 200 : result.status).type('application/json').send(result.text);
  } catch (error) {
    console.error('Reservation update error:', error);
    return res.status(500).json({ error: 'Failed to update reservation.' });
  }
});

app.post('/api/reservations/delete', async (req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const body = req.body || {};
    const lookup = parseReservationLookup(body.lookup || body.current || body);
    if (
      !lookup.programType ||
      !lookup.date ||
      !isKnownValue(lookup.email) ||
      !isKnownValue(lookup.confirmationNumber)
    ) {
      return res.status(400).json({ error: 'Reservation details are required.' });
    }

    const bookings = await loadBookingsFromCacheOrSource('reservation-delete-verify');
    const matchIndex = findMatchingBookingIndex(bookings, lookup);
    if (matchIndex < 0) {
      return res.status(404).json({
        found: false,
        message: 'Sorry! Could not find your Reservation! Please try again.'
      });
    }
    const matchedBooking = bookings[matchIndex];
    const matchedEmail = normalizeEmail(matchedBooking.email || lookup.email);
    const matchedConfirmation = normalizeConfirmation(
      matchedBooking.confirmationNumber || lookup.confirmationNumber
    );
    const matchedDate = normalizeDateString(matchedBooking.date) || lookup.date;

    const result = await postToAppsScript({
      ...body,
      action: 'cancel',
      operation: 'cancel',
      reservationLookup: lookup,
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(matchedDate),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(matchedEmail),
      'Confirmation Number': asStringOrEmpty(matchedConfirmation),
      // Explicit keys for reservation delete flows.
      'Current Date': asStringOrEmpty(matchedDate),
      'Current Email': asStringOrEmpty(matchedEmail),
      'Current Confirmation Number': asStringOrEmpty(matchedConfirmation)
    });

    if (result.ok) {
      try {
        await deleteReservationFromCache(lookup);
        void refreshCacheFromAppsScriptSafely('reservation-delete-reconcile');
      } catch (cacheError) {
        console.error('Cache delete after reservation cancel failed:', cacheError);
      }
    }

    return res.status(result.ok ? 200 : result.status).type('application/json').send(result.text);
  } catch (error) {
    console.error('Reservation delete error:', error);
    return res.status(500).json({ error: 'Failed to cancel reservation.' });
  }
});

app.get(['/menu', '/api/menu'], async (_req, res) => {
  try {
    const cacheRecord = await readMenuCacheRecord();
    res.setHeader('X-Menu-Source', 'menu-cache-file');
    return res.status(200).json(cacheRecord);
  } catch (error) {
    console.error('Menu GET error:', error);
    return res.status(500).json({ error: 'Failed to load menu cache.' });
  }
});

app.post(['/menu', '/api/menu'], async (req, res) => {
  if (!hasAllMenuEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required menu secrets.', missing: missingMenuEnv() });
  }

  try {
    const postResult = await postMenuToAppsScript(req.body || {});
    if (!postResult.ok) {
      return res
        .status(postResult.status || 500)
        .type('application/json')
        .send(postResult.text || JSON.stringify({ error: 'Menu write failed.' }));
    }

    const upstream = parseJsonSafely(postResult.text);
    const nextMenuCache = await appendMenuPostToCache(req.body || {}, upstream || postResult.text);
    return res.status(200).json({
      ok: true,
      appsScriptResponse: upstream || postResult.text,
      menuCacheUpdated: true,
      menuCache: nextMenuCache
    });
  } catch (error) {
    console.error('Menu POST error:', error);
    return res.status(500).json({ error: 'Failed to submit menu.' });
  }
});

if (fs.existsSync(indexHtmlPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(indexHtmlPath);
  });
} else {
  app.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
}

const PORT = process.env.PORT || 8080;

logSecretPreviews();
Promise.all([ensureCacheFile(), ensureMenuCacheFile()])
  .then(async () => {
    if (hasAllRequiredEnv()) {
      void refreshCacheFromAppsScriptSafely('startup');
      setInterval(() => {
        void refreshCacheFromAppsScriptSafely('interval');
      }, backgroundRefreshIntervalMs);
    }
  })
  .catch((error) => {
    console.error('Cache initialization failed:', error);
  });

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
