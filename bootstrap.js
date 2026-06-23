import { spawn } from 'child_process';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const helperPath = path.join(__dirname, 'scripts', 'sbm_context_search.py');
const routePrefix = '/sbm/context-search';
const helperPythonBin =
  String(process.env.SBM_CONTEXT_SEARCH_PYTHON_BIN || '').trim() ||
  (process.platform === 'win32' ? 'python' : 'python3');
const helperTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.SBM_CONTEXT_SEARCH_TIMEOUT_MS || '180000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180000;
})();
const registrationFlag = Symbol.for('sbm-context-search-registered');

const normalizeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const parseJsonSafely = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const createHttpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const runHelper = (action, payload = null) =>
  new Promise((resolve, reject) => {
    const child = spawn(helperPythonBin, [helperPath, action], {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUTF8: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      handler(value);
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finalize(reject, new Error(`Context search helper timed out after ${helperTimeoutMs}ms.`));
    }, helperTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finalize(reject, error);
    });

    child.on('close', (code) => {
      const parsed = parseJsonSafely(stdout);
      if (isPlainObject(parsed) && 'ok' in parsed && 'status' in parsed) {
        finalize(resolve, parsed);
        return;
      }

      const errorDetails = normalizeText(stderr) || normalizeText(stdout);
      finalize(
        reject,
        new Error(
          `Context search helper failed with exit code ${code ?? 'unknown'}${
            errorDetails ? `: ${errorDetails}` : '.'
          }`
        )
      );
    });

    if (payload !== null && payload !== undefined) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();
  });

const coerceInteger = (value, fallback, { fieldName, min, max }) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw createHttpError(400, `${fieldName} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
};

const coerceRequestBody = (body) => {
  if (!isPlainObject(body)) {
    throw createHttpError(400, 'JSON body is required.');
  }

  const query = normalizeText(body.query);
  if (!query) {
    throw createHttpError(400, 'query is required.');
  }

  const top_k = coerceInteger(body.top_k, 8, {
    fieldName: 'top_k',
    min: 1,
    max: 20
  });
  const neighbor_window = coerceInteger(body.neighbor_window, 1, {
    fieldName: 'neighbor_window',
    min: 0,
    max: 3
  });

  let history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) {
      throw createHttpError(400, 'history must be an array of strings.');
    }

    history = body.history.map((entry) => normalizeText(entry)).filter(Boolean);
    if (history.length > 8) {
      throw createHttpError(400, 'history must contain at most 8 items.');
    }
  }

  let use_llm = true;
  if (body.use_llm !== undefined) {
    if (typeof body.use_llm !== 'boolean') {
      throw createHttpError(400, 'use_llm must be a boolean.');
    }
    use_llm = body.use_llm;
  }

  return {
    query,
    top_k,
    neighbor_window,
    history,
    use_llm
  };
};

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalListen = express.application.listen;

const registerContextSearchRoutes = (app) => {
  if (app[registrationFlag]) return;
  app[registrationFlag] = true;

  originalGet.call(app, `${routePrefix}/health`, async (_req, res) => {
    try {
      const result = await runHelper('health');
      return res.status(result.status || 200).json(result.payload);
    } catch (error) {
      console.error('Context search health error:', error);
      return res.status(500).json({ error: 'Failed to load context search health.' });
    }
  });

  originalPost.call(app, `${routePrefix}/query`, async (req, res) => {
    try {
      const payload = coerceRequestBody(req.body);
      const result = await runHelper('query', payload);
      return res.status(result.status || 200).json(result.payload);
    } catch (error) {
      if (error && Number.isInteger(error.status)) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('Context search query error:', error);
      return res.status(500).json({ error: 'Failed to execute context search query.' });
    }
  });
};

express.application.get = function patchedGet(...args) {
  if (
    !this[registrationFlag] &&
    args.length >= 2 &&
    (args[0] === '*' || args[0] === '/')
  ) {
    registerContextSearchRoutes(this);
  }

  return originalGet.apply(this, args);
};

express.application.listen = function patchedListen(...args) {
  registerContextSearchRoutes(this);
  return originalListen.apply(this, args);
};

await import('./index.js');
