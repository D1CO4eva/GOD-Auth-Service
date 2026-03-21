# Code Map

Main code file: `index.js`

## Sections

1. Bootstrapping and paths
2. CORS middleware
3. Environment validation helpers
4. Cache file read/write/reset helpers
5. Normalization and extraction utilities
6. Booking dedupe/sort/canonicalization
7. Apps Script fetch/post helpers
8. Cache refresh orchestration
9. Route handlers
10. Static fallback and server start

## Primary Route Groups

- Bookings:
  - `/api/bookings`
    - supports `?year=2026|2027`
  - `/api/bookings/refresh`
    - supports `?year=2026|2027`
  - `/api/bookings` (POST)
- Reservations:
  - `/api/reservations/verify`
  - `/api/reservations/update`
  - `/api/reservations/delete`
- Menu:
  - `/menu`, `/api/menu`
- Generation:
  - `/generate`, `/api/generate`
- Cache reset:
  - `/api/cache/reset`, `/cache/reset`

## Supporting Scripts

- `scripts/local-dev.ps1`  
  Local development launcher with default env values.
