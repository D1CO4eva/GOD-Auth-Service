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

const normalizeEmail = (value) => {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || 'N/A';
};

const normalizeProgramTypeForMatch = (value) => normalizeText(value).toLowerCase();
const normalizeTimeForMatch = (value) => normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
const asStringOrEmpty = (value) => normalizeText(value);

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

const extractBookingsFromRow = (row, dateCol, programCol, timeCol, emailCol, occasionCol) => {
  if (Array.isArray(row)) {
    const rawDate = dateCol >= 0 ? row[dateCol] : row[0];
    const rawType = programCol >= 0 ? row[programCol] : '';
    const rawTime = timeCol >= 0 ? row[timeCol] : '';
    const rawEmail = emailCol >= 0 ? row[emailCol] : '';
    const rawOccasion = occasionCol >= 0 ? row[occasionCol] : '';
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{
      date,
      type: normalizeText(rawType),
      time: normalizeText(rawTime),
      email: normalizeEmail(rawEmail),
      occasion: normalizeText(rawOccasion)
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
      obj.email ||
      obj.Email ||
      obj.hostEmail ||
      obj.host_email ||
      obj['Host email'] ||
      obj['Host Email'] ||
      obj['Email Address'];
    const rawOccasion =
      obj.occasion ||
      obj.Occasion ||
      obj['Occasion / Reason'] ||
      obj['Occasion'];
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{
      date,
      type: normalizeText(rawType),
      time: normalizeText(rawTime),
      email: normalizeEmail(rawEmail),
      occasion: normalizeText(rawOccasion)
    }];
  }

  if (typeof row === 'string') {
    const date = normalizeDateString(row);
    return date ? [{ date, type: '', time: '', email: 'N/A', occasion: '' }] : [];
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
    emailCol = headerStrings.findIndex((cell) => cell.includes('email'));
    occasionCol = headerStrings.findIndex((cell) => cell.includes('occasion'));
  }

  const bookings = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    bookings.push(
      ...extractBookingsFromRow(rows[i], dateCol, programCol, timeCol, emailCol, occasionCol)
    );
  }

  return bookings;
};

const dedupeAndSortBookings = (bookings) => {
  const unique = Array.from(
    new Map(
      bookings.map((item) => [
        [
          item.date,
          normalizeProgramTypeForMatch(item.type),
          normalizeTimeForMatch(item.time),
          normalizeEmail(item.email)
        ].join('|'),
        {
          date: item.date,
          type: normalizeText(item.type),
          time: normalizeText(item.time),
          email: normalizeEmail(item.email),
          occasion: normalizeText(item.occasion)
        }
      ])
    ).values()
  );

  unique.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    if (left.time !== right.time) return left.time.localeCompare(right.time);
    return left.email.localeCompare(right.email);
  });

  return unique;
};

const toCanonicalPayload = (bookings) => JSON.stringify({ bookings: dedupeAndSortBookings(bookings) });

const appendBookingToCache = async (postBody) => {
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
    postBody.email ||
    postBody.Email ||
    postBody.hostEmail;
  const rawOccasion = postBody.Occasion || postBody.occasion || postBody['Occasion / Reason'] || '';

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
      occasion: normalizeText(rawOccasion)
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
    body['Host email'] ||
    body['Host Email'] ||
    body.hostEmail ||
    '';

  return {
    programType: normalizeText(rawProgramType),
    date: normalizeDateString(rawDate),
    time: normalizeText(rawTime),
    email: normalizeEmail(rawEmail)
  };
};

const findMatchingBookingIndex = (bookings, lookup) => {
  const normalizedProgramType = normalizeProgramTypeForMatch(lookup.programType);
  const normalizedLookupTime = normalizeTimeForMatch(lookup.time);
  const normalizedLookupEmail = normalizeEmail(lookup.email);
  const isNamaBhiksha = normalizedProgramType === 'nama bhiksha';

  return bookings.findIndex((booking) => {
    if (normalizeDateString(booking.date) !== lookup.date) return false;
    if (normalizeProgramTypeForMatch(booking.type) !== normalizedProgramType) return false;
    if (normalizeEmail(booking.email) !== normalizedLookupEmail) return false;

    const bookingTime = normalizeTimeForMatch(booking.time);
    if (isNamaBhiksha) {
      return bookingTime.length > 0 && bookingTime === normalizedLookupTime;
    }

    if (bookingTime.length > 0 && normalizedLookupTime.length > 0) {
      return bookingTime === normalizedLookupTime;
    }

    return true;
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
    time: normalizeText(updates.time || current.time),
    occasion: normalizeText(updates.occasion || current.occasion || '')
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
    'Occasion',
    'Additional Notes',
    'Current Date',
    'Current Time',
    'Current Email',
    'New Date',
    'New Time',
    'New Occasion',
    'action',
    'operation'
  ];
  for (const key of expectedStringKeys) {
    if (payload[key] === undefined || payload[key] === null) {
      payload[key] = '';
    }
  }

  const response = await fetch(process.env.APPS_SCRIPT_URL, {
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
  const canonicalPayload =
    parsed === null
      ? result.text
      : toCanonicalPayload(extractBookings(parsed));

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
        await appendBookingToCache(req.body || {});
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
    if (!lookup.programType || !lookup.date || !lookup.time || !lookup.email) {
      return res.status(400).json({ error: 'Program type, date, time-slot, and email are required.' });
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
        email: booking.email || 'N/A',
        occasion: booking.occasion || ''
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
    const nextTime = normalizeText(
      updatesSource.newTime || updatesSource.time || updatesSource.Time || updatesSource['New Time']
    );
    const nextOccasion = normalizeText(
      updatesSource.occasion || updatesSource.newOccasion || updatesSource['New Occasion'] || ''
    );

    if (!lookup.programType || !lookup.date || !lookup.time || !lookup.email) {
      return res.status(400).json({ error: 'Current reservation details are required.' });
    }
    if (!nextDate || !nextTime) {
      return res.status(400).json({ error: 'New date and new time-slot are required.' });
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
      action: 'updateReservation',
      operation: 'updateReservation',
      reservationLookup: lookup,
      reservationUpdate: {
        date: nextDate,
        time: nextTime,
        occasion: nextOccasion
      },
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(lookup.date),
      Time: asStringOrEmpty(lookup.time),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(lookup.email),
      Occasion: asStringOrEmpty(nextOccasion),
      // Explicit current/new keys for reservation update flows.
      'Current Date': asStringOrEmpty(lookup.date),
      'Current Time': asStringOrEmpty(lookup.time),
      'Current Email': asStringOrEmpty(lookup.email),
      'New Date': asStringOrEmpty(nextDate),
      'New Time': asStringOrEmpty(nextTime),
      'New Occasion': asStringOrEmpty(nextOccasion)
    });

    if (result.ok) {
      try {
        await updateReservationInCache(lookup, {
          date: nextDate,
          time: nextTime,
          occasion: nextOccasion
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
    if (!lookup.programType || !lookup.date || !lookup.time || !lookup.email) {
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
      action: 'deleteReservation',
      operation: 'deleteReservation',
      reservationLookup: lookup,
      // Legacy/common booking keys kept for Apps Script compatibility.
      Date: asStringOrEmpty(lookup.date),
      Time: asStringOrEmpty(lookup.time),
      'Type of Program': asStringOrEmpty(lookup.programType),
      'Host email': asStringOrEmpty(lookup.email),
      Occasion: '',
      // Explicit keys for reservation delete flows.
      'Current Date': asStringOrEmpty(lookup.date),
      'Current Time': asStringOrEmpty(lookup.time),
      'Current Email': asStringOrEmpty(lookup.email)
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
