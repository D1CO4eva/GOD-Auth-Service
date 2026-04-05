# Configuration

## Required Environment Variables

### Core bookings service

- `APPS_SCRIPT_URL`
- `APPS_SCRIPT_GET_TOKEN`
- `APPS_SCRIPT_POST_TOKEN`

### Menu write route

- `MENU_SCRIPT_URL`

### Generation route

- `OPENROUTER_API_KEY`

## Optional Environment Variables

- `PORT`  
  Default: `8080`

- `CORS_ORIGINS`  
  Comma-separated allowlist (or `*`).

- `CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS`  
  Default: `300`

- `MENU_SCRIPT_TOKEN`  
  Optional token for menu Apps Script.

- `GMAIL_PASSWORD`
  Gmail app password for `atlnd.admin.support@gmail.com`. Required only if you want
  booking failure alert emails to be sent.

- `GMAIL_USER`
  Optional SMTP login account. Defaults to `atlnd.admin.support@gmail.com`.

- `BOOKING_ALERT_SMTP_PASS`
  Legacy alias for `GMAIL_PASSWORD`.

- `BOOKING_ALERT_TO_EMAIL`
  Default: `atlantanamadwaar@gmail.com`

- `BOOKING_ALERT_FROM_EMAIL`
  Default: `atlnd.admin.support@gmail.com`

- `BOOKING_ALERT_SMTP_USER`
  Default: same value as `BOOKING_ALERT_FROM_EMAIL`

- `BOOKING_ALERT_SMTP_HOST`
  Default: `smtp.gmail.com`

- `BOOKING_ALERT_SMTP_PORT`
  Default: `465`

- `BOOKING_ALERT_SMTP_SECURE`
  Default: `true` when port is `465`

## Local Development Defaults

`scripts/local-dev.ps1` sets local defaults when not already defined:

- `APPS_SCRIPT_URL`
- `APPS_SCRIPT_GET_TOKEN`
- `APPS_SCRIPT_POST_TOKEN`
- `CORS_ORIGINS`
- `PORT`

Booking failure alert email is disabled locally unless `GMAIL_PASSWORD` is
provided in your shell.

## Secret Logging

At startup, the server logs partial secret previews (prefix/suffix), not full values.
