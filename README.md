# GOD Auth Service

Secure Node.js (Express) backend that proxies booking form submissions to a Google Apps Script Web App using a shared secret. The frontend never contacts Google Apps Script directly.

## Environment variables

Set these **server-side only** (never expose to the frontend):

- `APPS_SCRIPT_URL` (required)
- `APPS_SCRIPT_SHARED_SECRET` (required)
- `RATE_LIMIT_WINDOW_SECONDS` (required)
- `RATE_LIMIT_MAX_REQUESTS` (required)
- `PORT` (optional, default 3000)

Example for local development (PowerShell):

```powershell
$env:APPS_SCRIPT_URL='https://script.google.com/macros/s/XXXX/exec'
$env:APPS_SCRIPT_SHARED_SECRET='change-me'
$env:RATE_LIMIT_WINDOW_SECONDS='60'
$env:RATE_LIMIT_MAX_REQUESTS='30'
$env:PORT='3000'
```

You can also create a local `.env` file for development:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
APPS_SCRIPT_SHARED_SECRET=change-me
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_REQUESTS=30
PORT=3000
```

## Running locally

```powershell
npm install
npm run start
```

Send requests to:

```
POST http://localhost:3000/api/bookings
```

Example payload:

```json
{
  "name": "Jane Doe",
  "address": "123 Main St",
  "phone": "+1 555 123 4567",
  "email": "jane@example.com",
  "programType": "Premium",
  "date": "2026-02-01",
  "notes": "Please call after 5pm",
  "company_name": ""
}
```

## Deployment (GoDaddy shared hosting)

1. **Node.js hosting**: Ensure your GoDaddy plan supports Node.js apps. If it does not, upgrade to a plan that supports it.
2. **Upload project files**: Upload the repository contents to your Node.js app directory (via cPanel File Manager, FTP, or Git).
3. **Set environment variables**:
   - In cPanel, go to **Setup Node.js App** ? select your app ? add environment variables.
   - Add the required variables listed above.
4. **Install dependencies**:
   - In the app's terminal (or via SSH), run:
     ```bash
     npm install --production
     ```
5. **Set the startup file**: Configure the app to run `server.mjs`.
6. **Restart the app**: Use the cPanel interface to restart the Node.js app.

## Security notes

- The backend is the only component allowed to talk to Google Apps Script.
- A shared secret is sent using the `X-INTERNAL-KEY` header server-to-server.
- IP-based rate limiting and strict input validation are enforced.
- Requests with a filled `company_name` honeypot field return `{ ok: true }` without forwarding.
