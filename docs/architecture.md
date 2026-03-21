# Architecture

## Service Summary

`GOD-Auth-Service` is a single-process Express API deployed on Cloud Run.
It integrates with:

- Google Apps Script (bookings read/write)
- Google Apps Script (menu write)
- OpenRouter (menu generation proxy)

## Runtime Components

- HTTP server: Express app in `index.js`
- Local cache files:
  - `cache_2026.json` for 2026 bookings (public fields only)
  - `cache_2027.json` for 2027 bookings (public fields only)
  - `menu_cache.json` for recent menu posts
- Background bookings refresh:
  - Startup refresh
  - Interval refresh (`CACHE_BACKGROUND_REFRESH_INTERVAL_SECONDS`)

## Request Flow (Bookings)

1. Client calls API route.
2. Service validates required environment variables.
3. Service either:
   - serves from cache (public bookings GET), or
   - calls Apps Script directly (verify/update/delete flows).
4. Service normalizes/parses payloads and returns JSON response.

## Cache Strategy

- Bookings cache stores only public booking fields:
  - `date`
  - `programType`
  - `time`
- Cache is updated via:
  - successful refresh from Apps Script
  - successful booking POST reconciliation
  - startup and interval reconciliation

## Reservation Strategy

- `verify`, `update`, `delete` use confirmation-based lookup against Apps Script.
- `verify` returns booking details when found.
- `update` and `delete` perform Apps Script POST operations after confirmation lookup.

## Static Frontend Behavior

- If `dist/index.html` exists:
  - static assets are served
  - unknown paths fallback to SPA index
- Otherwise:
  - `GET /` returns `{"status":"ok"}`
