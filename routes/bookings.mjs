import express from 'express';
import { sendError, sendOk } from '../utils/respond.mjs';
import { sendToAppsScript } from '../services/appsScriptClient.mjs';

export function createBookingsRouter({ appsScriptUrl, sharedSecret }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const payload = {
      // Apps Script enforces this action to limit allowed operations.
      action: 'append_booking',
      ...req.validatedBooking,
    };

    const result = await sendToAppsScript(payload, {
      url: appsScriptUrl,
      sharedSecret,
    });

    if (result.ok) {
      return sendOk(res);
    }

    const errorMap = {
      apps_script_auth_failed: 502,
      apps_script_error: 502,
      apps_script_timeout: 504,
      apps_script_unavailable: 503,
    };

    const status = errorMap[result.error] || 502;
    return sendError(res, status, result.error || 'apps_script_error');
  });

  return router;
}
