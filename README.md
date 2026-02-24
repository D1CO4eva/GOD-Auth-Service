# GOD Auth Service

Small Express service intended to run on Google Cloud Run.

It proxies browser/app requests to a Google Apps Script web app that reads/writes bookings in Google Sheets.

## Endpoints

- `GET /`  
  Returns `{"status":"ok"}` if no frontend build is present.
- `GET /api/bookings`  
  Returns cached bookings from local `cache.json`.  
  If cache is empty, it reads from Apps Script once and seeds `cache.json`.
- `POST /api/bookings`  
  Forwards JSON to your Apps Script `APPS_SCRIPT_URL` with `token: APPS_SCRIPT_POST_TOKEN` merged into the body.  
  On successful write, appends/updates `cache.json` directly from the POST payload.
- `POST /api/reservations/verify`  
  Verifies whether a reservation exists for the provided `programType`, `date`, `time`, `email`, and `confirmationNumber`.
- `POST /api/reservations/update`  
  Forwards reservation update request to Apps Script and updates local cache on success.
- `POST /api/reservations/delete`  
  Forwards reservation cancellation request to Apps Script and removes matching entry from local cache on success.

If a frontend build exists at `dist/index.html`, this service also serves static files from `dist/` and routes all other paths to `dist/index.html`.

## Configuration

Required environment variables:

- `APPS_SCRIPT_URL`  
  The deployed Apps Script *web app* URL (typically `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`).
- `APPS_SCRIPT_GET_TOKEN`
- `APPS_SCRIPT_POST_TOKEN`

Optional:

- `PORT` (Cloud Run sets this automatically; defaults to `8080`)
- `CORS_ORIGINS`  
  Comma-separated list of allowed browser origins, or `*`.
  If omitted, defaults to:
  - `https://atlanta.godivinity.org`
  - `https://www.atlanta.godivinity.org`
  Example: `https://atlanta.godivinity.org,https://www.atlanta.godivinity.org`
- `CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS`  
  Interval for background full refresh from Apps Script to reconcile manual sheet edits/deletes.  
  Default: `300` seconds.

At startup the server logs a safe preview of the configured secrets (first 4 chars and last 4 chars).

## Booking Cache File

This service stores booking data in `cache.json` in the service root:

```json
{
  "updatedAt": "2026-02-19T00:00:00.000Z",
  "payload": "{...json from Apps Script...}"
}
```

Notes:

- `GET /api/bookings` serves from this file for fast responses.
- After successful `POST /api/bookings`, cache is updated directly from submitted payload (no full-sheet re-fetch).
- Cache stores booking records with `date`, `type`, `time`, `email`, `confirmationNumber`, and `occasion` when available.
- Cache is also reconciled from Apps Script in the background (startup + interval) so manual Google Sheet edits are reflected.

## Local Development

Node 20+ recommended.

PowerShell example:

```powershell
$env:APPS_SCRIPT_URL="https://script.google.com/macros/s/XXX/exec"
$env:APPS_SCRIPT_GET_TOKEN="..."
$env:APPS_SCRIPT_POST_TOKEN="..."

npm install
npm start
```

Quick checks:

```powershell
curl.exe -i http://127.0.0.1:8080/
curl.exe -i http://127.0.0.1:8080/api/bookings
```

## CORS (Browser Frontend On Another Domain)

If your `index.html` is hosted somewhere else (different origin) and calls this API, set `CORS_ORIGINS` on Cloud Run to your website origin(s).

Example:

```powershell
gcloud run services update god-auth-service `
  --region us-central1 `
  --set-env-vars CORS_ORIGINS=https://atlanta.godivinity.org,https://www.atlanta.godivinity.org
```

Notes:

- This service handles browser CORS preflight (`OPTIONS`) at the API layer.
- Using browser `mode: "no-cors"` is not recommended because responses are opaque and you cannot reliably read returned data.

## Deploy To Cloud Run (Container)

This repo includes a `Dockerfile` suitable for Cloud Run.

Build and deploy with Artifact Registry (one common path):

```powershell
$PROJECT="YOUR_GCP_PROJECT_ID"
$REGION="us-central1"
$SERVICE="god-auth-service"

gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/$SERVICE"
gcloud run deploy $SERVICE `
  --image "$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/$SERVICE" `
  --region $REGION `
  --allow-unauthenticated `
  --set-env-vars APPS_SCRIPT_URL=...,APPS_SCRIPT_GET_TOKEN=...,APPS_SCRIPT_POST_TOKEN=...
```

If your Cloud Run service should not be public, remove `--allow-unauthenticated` and call it with an identity token instead.
