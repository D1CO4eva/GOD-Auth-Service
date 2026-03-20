# GOD Auth Service

Small Express service intended to run on Google Cloud Run.

It proxies browser/app requests to a Google Apps Script web app that reads/writes bookings in Google Sheets.

## Endpoints

- `GET /`  
  Returns `{"status":"ok"}` if no frontend build is present.
- `GET /api/bookings`  
  Returns cached bookings from local `cache.json` with public fields only: `date`, `programType`, `time`.  
  If cache is empty, it reads from Apps Script once and seeds `cache.json`.
- `POST /api/bookings`  
  Forwards JSON to your Apps Script `APPS_SCRIPT_URL` with `token: APPS_SCRIPT_POST_TOKEN` merged into the body.  
  On successful write, appends/updates `cache.json` directly from the POST payload.
- `POST /api/reservations/verify`  
  Verifies whether a reservation exists for the provided `confirmationNumber`.
  On success, returns `{"message":"Booking Exists","booking":{...}}` with booking details from Apps Script.
- `POST /api/reservations/update`  
  Updates a reservation using `confirmationNumber` (required) and `newDate` (required; optional `newTime`).
  The service first looks up booking details from Apps Script by confirmation, then forwards a reschedule request.
- `POST /api/reservations/delete`  
  Cancels a reservation using `confirmationNumber` (required).
  The service first looks up booking details from Apps Script by confirmation, then forwards a cancel request.
- `POST /api/cache/reset` (alias: `POST /cache/reset`)  
  Manually clears local cache files.  
  Optional JSON body: `{"target":"all"}` (default), `{"target":"bookings"}`, or `{"target":"menu"}`.
- `POST /generate` (alias: `POST /api/generate`)  
  Proxies LLM generation calls to OpenRouter using server-side secret `OPENROUTER_API_KEY`.
- `GET /menu`  
  Returns menu history from local `menu_cache.json` only (no Google Drive read).
- `POST /menu`  
  Forwards menu planner JSON payload to the menu Apps Script endpoint, then appends that payload to local `menu_cache.json`.
  Keeps only the latest 6 menu posts and removes older entries automatically.
  Cache stores only food item names from `courses[].items[].name`.

If a frontend build exists at `dist/index.html`, this service also serves static files from `dist/` and routes all other paths to `dist/index.html`.

## Configuration

Required environment variables:

- `APPS_SCRIPT_URL`  
  The deployed Apps Script *web app* URL (typically `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`).
- `APPS_SCRIPT_GET_TOKEN`
- `APPS_SCRIPT_POST_TOKEN`

Required for `/menu` POST endpoint:

- `MENU_SCRIPT_URL`  
  The deployed menu Apps Script web app URL (typically `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`).

Required for `/generate` endpoint:

- `OPENROUTER_API_KEY`  
  OpenRouter API key used server-side for menu generation requests.

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
- `MENU_SCRIPT_TOKEN`  
  Optional shared token for menu Apps Script POST calls.

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
- Cache stores public booking records only: `date`, `programType`, and `time`.
- Cache is also reconciled from Apps Script in the background (startup + interval) so manual Google Sheet edits are reflected.

This service also stores menu post history in `menu_cache.json`:

```json
{
  "updatedAt": "2026-03-02T00:00:00.000Z",
  "posts": [
    {
      "createdAt": "2026-03-02T00:00:00.000Z",
      "foods": ["Sambar Rice", "Curd Rice", "Kesari"]
    }
  ]
}
```

## Local Development

Node 20+ recommended.

PowerShell example:

```powershell
$env:APPS_SCRIPT_URL="https://script.google.com/macros/s/XXX/exec"
$env:APPS_SCRIPT_GET_TOKEN="..."
$env:APPS_SCRIPT_POST_TOKEN="..."
$env:MENU_SCRIPT_URL="https://script.google.com/macros/s/YYY/exec"
# Optional:
# $env:MENU_SCRIPT_TOKEN="..."
# $env:OPENROUTER_API_KEY="..."

npm install
npm start
```

Quick checks:

```powershell
curl.exe -i http://localhost:8080/
curl.exe -i http://localhost:8080/api/bookings
```

Local bookings-only workflow:

```powershell
# Run server with local defaults (Ctrl+C to stop)
npm run bookings:dev
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
  --set-env-vars APPS_SCRIPT_URL=...,APPS_SCRIPT_GET_TOKEN=...,APPS_SCRIPT_POST_TOKEN=...,MENU_SCRIPT_URL=...,OPENROUTER_API_KEY=...
```

If your Cloud Run service should not be public, remove `--allow-unauthenticated` and call it with an identity token instead.
