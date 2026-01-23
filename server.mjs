import express from 'express';
import dotenv from 'dotenv';
import { createRateLimiter } from './middleware/rateLimit.mjs';
import { validateBooking } from './middleware/validateBooking.mjs';
import { createBookingsRouter } from './routes/bookings.mjs';
import { sendError } from './utils/respond.mjs';

dotenv.config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const appsScriptUrl = requireEnv('APPS_SCRIPT_URL');
const sharedSecret = requireEnv('APPS_SCRIPT_SHARED_SECRET');
const windowSeconds = Number.parseInt(requireEnv('RATE_LIMIT_WINDOW_SECONDS'), 10);
const maxRequests = Number.parseInt(requireEnv('RATE_LIMIT_MAX_REQUESTS'), 10);

if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
  throw new Error('RATE_LIMIT_WINDOW_SECONDS must be a positive integer');
}

if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
  throw new Error('RATE_LIMIT_MAX_REQUESTS must be a positive integer');
}

const app = express();

// Trust the first proxy so req.ip reflects the real client on shared hosting.
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));

const rateLimiter = createRateLimiter({
  windowSeconds,
  maxRequests,
});

app.use('/api/bookings', rateLimiter, validateBooking, createBookingsRouter({
  appsScriptUrl,
  sharedSecret,
}));

app.use((req, res) => sendError(res, 404, 'not_found'));

// Generic error handler to avoid leaking stack traces.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'invalid_json');
  }

  return sendError(res, 500, 'server_error');
});

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
app.listen(port, () => {
  // Startup logs are safe; no secrets printed.
  console.log(`Booking proxy listening on port ${port}`);
});
