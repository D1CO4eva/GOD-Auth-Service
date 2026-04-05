# Security Notes

## Public Data Boundaries

- `GET /api/bookings` is public and intentionally limited to non-PII schedule fields:
  - `date`
  - `programType`
  - `time`

## Sensitive Flows

- Reservation verification/update/delete rely on confirmation-based Apps Script lookups.
- Verify can return booking details when confirmation is valid.

## Important Considerations

- CORS is not an auth mechanism.
- Any secret in frontend JavaScript is exposed to users.
- Keep Apps Script tokens server-side only.
- Keep `BOOKING_ALERT_SMTP_PASS` server-side only. The booking failure alert email
  includes host contact details and should only go to trusted admins.

## Recommended Hardening

- Add rate-limiting in front of reservation endpoints.
- Consider bot protection for public reservation actions.
- Consider Cloud Run IAM/private ingress for admin routes if needed.
- Ensure production `APPS_SCRIPT_POST_TOKEN` is set correctly to avoid unauthorized writes.
