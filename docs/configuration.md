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

## Local Development Defaults

`scripts/local-dev.ps1` sets local defaults when not already defined:

- `APPS_SCRIPT_URL`
- `APPS_SCRIPT_GET_TOKEN`
- `APPS_SCRIPT_POST_TOKEN`
- `CORS_ORIGINS`
- `PORT`

## Secret Logging

At startup, the server logs partial secret previews (prefix/suffix), not full values.
