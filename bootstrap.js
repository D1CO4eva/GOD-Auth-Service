import express from 'express';
import { createSbmContextSearchService } from './sbmContextSearch.js';

const routePrefix = '/sbm/context-search';
const registrationFlag = Symbol.for('sbm-context-search-registered');

const normalizeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const createHttpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

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

const contextSearchService = createSbmContextSearchService({
  versesUrl: process.env.BHAGAVATAM_REMOTE_VERSES_URL,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterModel: process.env.OPENROUTER_MODEL,
  siteUrl: 'https://atlanta.godivinity.org',
  appName: 'Bhagavatam Context Search'
});

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalListen = express.application.listen;

const registerContextSearchRoutes = (app) => {
  if (app[registrationFlag]) return;
  app[registrationFlag] = true;

  originalGet.call(app, `${routePrefix}/health`, async (_req, res) => {
    try {
      const result = await contextSearchService.health();
      return res.status(200).json(result);
    } catch (error) {
      console.error('Context search health error:', error);
      return res.status(503).json({
        error: 'Failed to load context search health.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });

  originalPost.call(app, `${routePrefix}/query`, async (req, res) => {
    try {
      const payload = coerceRequestBody(req.body);
      const result = await contextSearchService.query({
        ...payload,
        request_origin: req.headers.origin || ''
      });
      return res.status(200).json(result);
    } catch (error) {
      if (error && Number.isInteger(error.status)) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('Context search query error:', error);
      return res.status(503).json({
        error: 'Failed to execute context search query.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });
};

express.application.get = function patchedGet(...args) {
  if (!this[registrationFlag] && args.length >= 2 && (args[0] === '*' || args[0] === '/')) {
    registerContextSearchRoutes(this);
  }

  return originalGet.apply(this, args);
};

express.application.listen = function patchedListen(...args) {
  registerContextSearchRoutes(this);
  return originalListen.apply(this, args);
};

await import('./index.js');
