import { sendError, sendOk } from '../utils/respond.mjs';

const MAX_LENGTHS = {
  name: 100,
  address: 200,
  phone: 30,
  email: 254,
  programType: 100,
  date: 30,
  notes: 1000,
  company_name: 100,
};

const REQUIRED_FIELDS = ['name', 'address', 'phone', 'email', 'programType', 'date'];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'notes', 'company_name']);

function sanitizeString(value) {
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  return /^[0-9+()\-\s]{7,30}$/.test(value);
}

function isValidDate(value) {
  if (value.length > MAX_LENGTHS.date) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function validateBooking(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return sendError(res, 400, 'invalid_json');
  }

  const keys = Object.keys(req.body);
  const unexpected = keys.filter((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected.length > 0) {
    // Reject extra fields to reduce abuse surface and data injection.
    return sendError(res, 400, 'unexpected_field', { fields: unexpected });
  }

  if (req.body.company_name !== undefined) {
    if (typeof req.body.company_name !== 'string') {
      // Treat non-string honeypot content as filled to keep responses uniform.
      return sendOk(res);
    }

    const rawCompany = sanitizeString(req.body.company_name);
    // Honeypot: respond with success to avoid tipping off automated abuse.
    if (rawCompany.length > 0) {
      return sendOk(res);
    }
  }

  const sanitized = {};
  const errors = {};

  for (const field of REQUIRED_FIELDS) {
    const value = req.body[field];
    if (typeof value !== 'string') {
      errors[field] = 'required';
      continue;
    }

    const cleaned = sanitizeString(value);
    if (!cleaned) {
      errors[field] = 'required';
      continue;
    }

    if (cleaned.length > MAX_LENGTHS[field]) {
      errors[field] = 'too_long';
      continue;
    }

    sanitized[field] = cleaned;
  }

  if (typeof req.body.notes === 'string') {
    const cleaned = sanitizeString(req.body.notes);
    if (cleaned.length > MAX_LENGTHS.notes) {
      errors.notes = 'too_long';
    } else {
      sanitized.notes = cleaned;
    }
  } else if (req.body.notes !== undefined) {
    errors.notes = 'invalid';
  }

  if (sanitized.email && !isValidEmail(sanitized.email)) {
    errors.email = 'invalid';
  }

  if (sanitized.phone && !isValidPhone(sanitized.phone)) {
    errors.phone = 'invalid';
  }

  if (sanitized.date && !isValidDate(sanitized.date)) {
    errors.date = 'invalid';
  }

  if (Object.keys(errors).length > 0) {
    return sendError(res, 400, 'validation_error', { fields: errors });
  }

  req.validatedBooking = sanitized;
  return next();
}
