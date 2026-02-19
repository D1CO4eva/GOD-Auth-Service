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

  await writeCacheRecord({
    updatedAt: new Date().toISOString(),
    payload: result.text
  });

  return result;
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
      res.setHeader('X-Bookings-Source', 'cache-file');
      return res.status(200).type('application/json').send(cacheRecord.payload);
    }

    const refreshResult = await refreshCacheFromAppsScript();
    if (refreshResult.ok) {
      res.setHeader('X-Bookings-Source', 'apps-script');
      return res.status(200).type('application/json').send(refreshResult.text);
    }

    res
      .status(refreshResult.status)
      .type('application/json')
      .send(refreshResult.text || JSON.stringify({ error: 'Failed to load bookings.' }));
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
        await refreshCacheFromAppsScript();
      } catch (cacheError) {
        console.error('Cache refresh after POST failed:', cacheError);
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
    const cacheRecord = await readCacheRecord();
    if (!cacheRecord.payload) {
      try {
        await refreshCacheFromAppsScript();
        console.log('Cache warmed from Apps Script.');
      } catch (error) {
        console.error('Initial cache warm failed:', error);
      }
    }
  })
  .catch((error) => {
    console.error('Cache initialization failed:', error);
  });

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
