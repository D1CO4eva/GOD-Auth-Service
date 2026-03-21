# Operations and Deployment

## Local Run

```powershell
npm install
npm run bookings:dev
```

Default local base URL:

- `http://localhost:8080`

## Quick Manual Checks

```powershell
curl.exe -i http://localhost:8080/
curl.exe -i "http://localhost:8080/api/bookings?year=2026"
curl.exe -i "http://localhost:8080/api/bookings?year=2027"
curl.exe -i -X POST http://localhost:8080/api/reservations/verify `
  -H "Content-Type: application/json" `
  -d "{\"confirmationNumber\":\"12345678\"}"
```

## Cloud Run Deployment Notes

- Build via Cloud Build + Artifact Registry image.
- Deploy with required env vars.
- Public or private access depends on IAM/invoker settings.

## Runtime Behaviors

- Startup:
  - ensures cache files exist
  - triggers bookings refresh when core env vars are present
- Background:
  - periodic refresh based on configured interval

## Failure Handling

- Upstream Apps Script failures produce propagated/non-200 responses depending on route.
- Reservation verify can return 502 when upstream verification fails.
- Menu and generate routes return explicit 500 class responses on missing config/failures.
