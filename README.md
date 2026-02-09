# GOD Auth Service

Small Express service intended to run on Google Cloud Run.

It proxies browser/app requests to a Google Apps Script web app that reads/writes bookings in Google Sheets.

## Endpoints

- `GET /`  
  Returns `{"status":"ok"}` if no frontend build is present.
- `GET /api/bookings`  
  Forwards to your Apps Script `APPS_SCRIPT_URL` as a GET with `?token=APPS_SCRIPT_GET_TOKEN`.
- `POST /api/bookings`  
  Forwards JSON to your Apps Script `APPS_SCRIPT_URL` with `token: APPS_SCRIPT_POST_TOKEN` merged into the body.

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
  Example: `https://godivinity.org,https://www.godivinity.org`

At startup the server logs a safe preview of the configured secrets (first 4 chars and last 4 chars).

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
  --set-env-vars CORS_ORIGINS=https://godivinity.org,https://www.godivinity.org
```

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

