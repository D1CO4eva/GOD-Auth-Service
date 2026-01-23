import { createHmac } from 'crypto';

const DEFAULT_TIMEOUT_MS = 8000;

function signPayload(sharedSecret, payload, timestamp) {
  // HMAC binds the timestamp and payload, preventing tampering and replay.
  return createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
}

export async function sendToAppsScript(booking, { url, sharedSecret, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = JSON.stringify(booking);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(sharedSecret, payload, timestamp);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // HMAC + timestamp provide integrity and replay protection.
        'X-SIGNATURE': signature,
        'X-TIMESTAMP': String(timestamp),
      },
      body: payload,
      signal: controller.signal,
    });

    let responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch {
      responsePayload = null;
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'apps_script_auth_failed' };
    }

    if (!response.ok) {
      return { ok: false, error: 'apps_script_error' };
    }

    if (!responsePayload || responsePayload.ok !== true) {
      if (responsePayload && responsePayload.error === 'unauthorized') {
        return { ok: false, error: 'apps_script_auth_failed' };
      }
      if (responsePayload && responsePayload.error === 'invalid_action') {
        return { ok: false, error: 'apps_script_auth_failed' };
      }
      return { ok: false, error: 'apps_script_error' };
    }

    return { ok: true };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, error: 'apps_script_timeout' };
    }
    return { ok: false, error: 'apps_script_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
