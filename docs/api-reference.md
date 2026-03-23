# API Reference

## Health and Static

### `GET /`

- Returns `{"status":"ok"}` when no frontend build is present.

## Bookings

### `GET /api/bookings`

- Returns public bookings cache for a requested year.
- Query param:
  - `year` -> `2026` or `2027` (default: `2026`)
- Response shape:
  - `{ "bookings": [{ "date": "...", "programType": "...", "time": "..." }] }`

### `POST /api/bookings`

- Forwards booking write payload to Apps Script with server token.
- Reconciles cache in background after successful write.

### `GET|POST /api/bookings/refresh` and `/bookings/refresh`

- Refreshes bookings cache from Apps Script for the requested year.
- Query param:
  - `year` -> `2026` or `2027` (default: `2026`)
- Returns:
  - `ok`
  - `message`
  - `year`
  - `bookingsCount`
  - `bookings` (public fields only)

## Reservations

### `GET /api/reservations/verify`

- Required query param:
  - `confirmationNumber`
- Behavior:
  - Calls Apps Script with `token` + `confirmation`.
  - Returns details when found.
- Method restrictions:
  - `POST /api/reservations/verify` returns `405 Method Not Allowed`.
- Success example:
  - `{ "message": "Booking Exists", "booking": { ... } }`
- Not found:
  - `{ "message": "Sorry, could not find your booking" }`

### `POST /api/reservations/update`

- Required body:
  - `confirmationNumber`
  - `newDate`
- Optional body:
  - `newTime`
- Behavior:
  - Looks up booking details via confirmation.
  - Sends reschedule payload to Apps Script.
  - Returns Apps Script response/status.

### `POST /api/reservations/delete`

- Required body:
  - `confirmationNumber`
- Behavior:
  - Looks up booking details via confirmation.
  - Sends cancellation payload to Apps Script.
  - Returns Apps Script response/status.

## Cache Admin

### `POST /api/cache/reset` and `/cache/reset`

- Optional body:
  - `{"target":"all"}` (default)
  - `{"target":"bookings"}`
  - `{"target":"menu"}`

## Menu

### `GET /menu` and `/api/menu`

- Returns menu cache from local file only.

### `POST /menu` and `/api/menu`

- Forwards payload to menu Apps Script.
- Stores compact local menu history (max 6 posts).

## Generation

### `POST /generate` and `/api/generate`

- Proxies request to OpenRouter chat completion endpoint.
- Requires `OPENROUTER_API_KEY`.
