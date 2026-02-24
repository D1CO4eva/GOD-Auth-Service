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
const emptyCacheRecord = {
  updatedAt: null,
  payload: null
};
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

const previewSecret = (value) => {
  if (!value) return '(missing)';
  const s = String(value);
  const n = Math.min(4, s.length);
  return `${s.slice(0, n)}...${s.slice(-n)}`;
};

const missingRequiredEnv = () => REQUIRED_ENV_KEYS.filter((k) => !process.env[k]);
const hasAllRequiredEnv = () => missingRequiredEnv().length === 0;

const logSecretPreviews = (label = 'Secret previews') => {
  console.log(
    [
      `${label}:`,
      `APPS_SCRIPT_URL=${previewSecret(process.env.APPS_SCRIPT_URL)}`,
      `APPS_SCRIPT_GET_TOKEN=${previewSecret(process.env.APPS_SCRIPT_GET_TOKEN)}`,
      `APPS_SCRIPT_POST_TOKEN=${previewSecret(process.env.APPS_SCRIPT_POST_TOKEN)}`
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

const writeCacheRecord = async (record) => {
  const normalized = normalizeCacheRecord(record);
  const tmpPath = `${cacheFilePath}.tmp`;
  await fsPromises.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fsPromises.rename(tmpPath, cacheFilePath);
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
const bookingKey = (item) => {
  const date = normalizeDateString(item?.date) || '';
  const type = normalizeProgramTypeForMatch(item?.type);
  const time = normalizeTimeForMatch(item?.time);
  const email = normalizeEmailForMatch(normalizeEmail(item?.email));
  const confirmation = normalizeTokenForMatch(normalizeConfirmation(item?.confirmationNumber));
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
  emailCol,
  confirmationCol,
  occasionCol
) => {
  if (Array.isArray(row)) {
    const rawDate = dateCol >= 0 ? row[dateCol] : row[0];
    const rawType = programCol >= 0 ? row[programCol] : '';
    const rawTime = timeCol >= 0 ? row[timeCol] : '';
    const rawEmail = emailCol >= 0 ? row[emailCol] : '';
    const rawConfirmation = confirmationCol >= 0 ? row[confirmationCol] : '';
    const rawOccasion = occasionCol >= 0 ? row[occasionCol] : '';
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{
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
    const rawDate =
      obj.date ||
      obj.Date ||
      obj.programDate ||
      obj.program_date ||
      obj['Program Date'] ||
      obj['Date of Program'] ||
      obj['Date of Program (YYYY-MM-DD)'];
    const rawType =
      obj.type ||
      obj.Type ||
      obj.programType ||
      obj.program_type ||
      obj['Type of Program'] ||
      obj['Program Type'] ||
      obj.program ||
      obj.Program;
    const rawTime =
      obj.time ||
      obj.Time ||
      obj.programTime ||
      obj.program_time ||
      obj['Time Slot'] ||
      obj['Time'];
    const rawEmail =
      obj.hostEmail ||
      obj.host_email ||
      obj.email ||
      obj.Email ||
      obj['Host email'] ||
      obj['Host Email'] ||
      obj['Email Address'];
    const rawConfirmation =
      obj.confirmationNumber ||
      obj.confirmation_number ||
      obj.confirmation ||
      obj.Confirmation ||
      obj['Confirmation Number'] ||
      obj['confirmation number'];
    const rawOccasion =
      obj.occasion ||
      obj.Occasion ||
      obj['Occasion'] ||
      obj['Occasion / Reason'];
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{
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
  let emailCol = -1;
  let confirmationCol = -1;
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
    emailCol = headerStrings.findIndex((cell) =>
      cell.includes('host email') || cell === 'email' || cell.includes('email')
    );
    confirmationCol = headerStrings.findIndex((cell) =>
      cell.includes('confirmation number') || cell.includes('confirmation')
    );
    occasionCol = headerStrings.findIndex((cell) => cell.includes('occasion'));
  }

  const bookings = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    bookings.push(
      ...extractBookingsFromRow(
        rows[i],
        dateCol,
        programCol,
        timeCol,
        emailCol,
        confirmationCol,
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

const toCanonicalPayload = (bookings) => JSON.stringify({ bookings: dedupeAndSortBookings(bookings) });

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
  const normalizedLookupConfirmation = normalizeTokenForMatch(normalizeConfirmation(lookup.confirmationNumber));

  return bookings.findIndex((booking) => {
    if (normalizeDateString(booking.date) !== lookup.date) return false;
    if (normalizeProgramTypeForMatch(booking.type) !== normalizedProgramType) return false;
    if (normalizedLookupTime && normalizeTimeForMatch(booking.time) !== normalizedLookupTime) return false;
    if (normalizeEmailForMatch(normalizeEmail(booking.email)) !== normalizedLookupEmail) return false;
    return (
      normalizeTokenForMatch(normalizeConfirmation(booking.confirmationNumber)) ===
      normalizedLookupConfirmation
    );
  });
};

const loadBookingsFromCacheOrSource = async (reason) => {
  const cacheRecord = await readCacheRecord();
  if (cacheRecord.payload) {
    const parsed = parseJsonSafely(cacheRecord.payload);
    return dedupeAndSortBookings(extractBookings(parsed));
  }

  const refreshResult = await refreshCacheFromAppsScriptSafely(reason);
  if (!refreshResult?.ok) return [];

  const parsed = parseJsonSafely(refreshResult.text);
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
      text: result.text
    };
  }

  const incomingBookings = extractBookings(parsed);
  const existingCacheRecord = await readCacheRecord();
  const existingParsed = existingCacheRecord.payload ? parseJsonSafely(existingCacheRecord.payload) : null;
  const existingBookings = existingParsed ? extractBookings(existingParsed) : [];
  const existingLooseMap = new Map();
  for (const item of existingBookings) {
    existingLooseMap.set(looseBookingKey(item), item);
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
    text: canonicalPayload
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

      if (isCacheStale(cacheRecord)) {
        void refreshCacheFromAppsScriptSafely('stale-get');
      }
      res.setHeader('X-Bookings-Source', 'cache-file');
      return res.status(200).type('application/json').send(cacheRecord.payload);
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
    const lookup = parseReservationLookup(req.body || {});
    if (
      !lookup.programType ||
      !lookup.date ||
      !isKnownValue(lookup.email) ||
      !isKnownValue(lookup.confirmationNumber)
    ) {
      return res.status(400).json({
        error: 'Program type, date, email, and confirmation number are required.'
      });
    }

    const bookings = await loadBookingsFromCacheOrSource('reservation-verify');
    const matchIndex = findMatchingBookingIndex(bookings, lookup);
    if (matchIndex < 0) {
      return res.status(404).json({
        found: false,
        message: 'Sorry! Could not find your Reservation! Please try again.'
      });
    }

    const booking = bookings[matchIndex];
    return res.status(200).json({
      found: true,
      reservation: {
        programType: booking.type,
        date: booking.date,
        time: booking.time,
        email: normalizeEmail(booking.email),
        confirmationNumber: normalizeConfirmation(booking.confirmationNumber),
        occasion: normalizeOccasion(booking.occasion)
      }
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

    const result = await postToAppsScript({
      ...body,
      action: 'reschedule',
      operation: 'reschedule',
      reservationLookup: lookup,
      reservationUpdate: {
        date: nextDate
      },
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(lookup.date),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(lookup.email),
      'Confirmation Number': asStringOrEmpty(lookup.confirmationNumber),
      newDate: asStringOrEmpty(nextDate),
      // Explicit current/new keys for reservation update flows.
      'Current Date': asStringOrEmpty(lookup.date),
      'Current Email': asStringOrEmpty(lookup.email),
      'Current Confirmation Number': asStringOrEmpty(lookup.confirmationNumber),
      'New Date': asStringOrEmpty(nextDate)
    });

    if (result.ok) {
      try {
        await updateReservationInCache(lookup, {
          date: nextDate
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

    const result = await postToAppsScript({
      ...body,
      action: 'cancel',
      operation: 'cancel',
      reservationLookup: lookup,
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(lookup.date),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(lookup.email),
      'Confirmation Number': asStringOrEmpty(lookup.confirmationNumber),
      // Explicit keys for reservation delete flows.
      'Current Date': asStringOrEmpty(lookup.date),
      'Current Email': asStringOrEmpty(lookup.email),
      'Current Confirmation Number': asStringOrEmpty(lookup.confirmationNumber)
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
ensureCacheFile()
  .then(async () => {
    if (!hasAllRequiredEnv()) return;
    void refreshCacheFromAppsScriptSafely('startup');
    setInterval(() => {
      void refreshCacheFromAppsScriptSafely('interval');
    }, backgroundRefreshIntervalMs);
  })
  .catch((error) => {
    console.error('Cache initialization failed:', error);
  });

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
