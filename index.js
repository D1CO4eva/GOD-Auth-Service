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

const extractBookingsFromRow = (row, dateCol, programCol, timeCol) => {
  if (Array.isArray(row)) {
    const rawDate = dateCol >= 0 ? row[dateCol] : row[0];
    const rawType = programCol >= 0 ? row[programCol] : '';
    const rawTime = timeCol >= 0 ? row[timeCol] : '';
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{ date, type: normalizeText(rawType), time: normalizeText(rawTime) }];
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
    const date = normalizeDateString(rawDate);
    if (!date) return [];
    return [{ date, type: normalizeText(rawType), time: normalizeText(rawTime) }];
  }

  if (typeof row === 'string') {
    const date = normalizeDateString(row);
    return date ? [{ date, type: '', time: '' }] : [];
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
  }

  const bookings = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    bookings.push(...extractBookingsFromRow(rows[i], dateCol, programCol, timeCol));
  }

  return bookings;
};

const dedupeAndSortBookings = (bookings) => {
  const unique = Array.from(
    new Map(
      bookings.map((item) => [
        `${item.date}|${normalizeText(item.type).toLowerCase()}|${normalizeText(item.time).toLowerCase()}`,
        {
          date: item.date,
          type: normalizeText(item.type),
          time: normalizeText(item.time)
        }
      ])
    ).values()
  );

  unique.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    return left.time.localeCompare(right.time);
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

  const date = normalizeDateString(rawDate);
  if (!date) return;

  const cacheRecord = await readCacheRecord();
  const cachedData = cacheRecord.payload ? parseJsonSafely(cacheRecord.payload) : null;
  const existingBookings = extractBookings(cachedData);
  const nextBookings = dedupeAndSortBookings([
    ...existingBookings,
    { date, type: normalizeText(rawType), time: normalizeText(rawTime) }
  ]);

  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: toCanonicalPayload(nextBookings)
  });
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
    const payload = {
      ...req.body,
      token: process.env.APPS_SCRIPT_POST_TOKEN
    };

    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (response.ok) {
      try {
        await appendBookingToCache(req.body || {});
        void refreshCacheFromAppsScriptSafely('post-reconcile');
      } catch (cacheError) {
        console.error('Cache append after POST failed:', cacheError);
      }
    }
    res.status(response.ok ? 200 : response.status).type('application/json').send(text);
  } catch (error) {
    console.error('Write error:', error);
    res.status(500).json({ error: 'Failed to submit booking.' });
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
