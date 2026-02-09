import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Optional CORS for browser-based frontends hosted on a different origin.
// Set `CORS_ORIGINS` to a comma-separated list of allowed origins, or `*` to allow all.
// Example: CORS_ORIGINS=https://godivinity.org,https://www.godivinity.org
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsAllowAll = corsOrigins.includes('*');

if (corsOrigins.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (corsAllowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Avoid cache poisoning when allowing a subset of origins.
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

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

app.get('/api/bookings', async (_req, res) => {
  if (!hasAllRequiredEnv()) {
    return res
      .status(500)
      .json({ error: 'Server is missing required secrets.', missing: missingRequiredEnv() });
  }

  try {
    const readUrl = new URL(process.env.APPS_SCRIPT_URL);
    readUrl.searchParams.set('token', process.env.APPS_SCRIPT_GET_TOKEN);

    const response = await fetch(readUrl.toString(), {
      method: 'GET',
      cache: 'no-cache'
    });

    const text = await response.text();
    res.status(response.ok ? 200 : response.status).type('application/json').send(text);
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
    res.status(response.ok ? 200 : response.status).type('application/json').send(text);
  } catch (error) {
    console.error('Write error:', error);
    res.status(500).json({ error: 'Failed to submit booking.' });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, 'dist');
const indexHtmlPath = path.join(distPath, 'index.html');

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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
