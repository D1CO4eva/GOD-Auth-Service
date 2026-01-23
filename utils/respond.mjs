export function sendOk(res) {
  return res.status(200).json({ ok: true });
}

export function sendError(res, status, code, details) {
  const body = { ok: false, error: code };
  if (details && typeof details === 'object') {
    body.details = details;
  }
  return res.status(status).json(body);
}
