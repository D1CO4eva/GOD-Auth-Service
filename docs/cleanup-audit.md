# Cleanup Audit

This document summarizes the cleanup pass performed for this codebase.

## Findings

- Confirmed single runtime entrypoint (`index.js`) with broad responsibility.
- Identified and removed stale reservation helper code no longer used by active route flows.
- Verified reservations now use confirmation-based Apps Script lookup paths consistently.
- Verified public bookings output remains restricted to non-PII fields.

## Cleanup Changes

- Removed unused utility:
  - `normalizeTokenForMatch`
- Removed dead reservation matcher/cache mutation helpers:
  - `findMatchingBookingIndex`
  - `loadBookingsFromCacheOrSource`
  - `updateReservationInCache`
  - `deleteReservationFromCache`

## Remaining Technical Debt

- `index.js` is still large and multi-concern.  
  Recommended future split:
  - `routes/`
  - `services/`
  - `lib/normalize.js`
  - `lib/cache.js`

- No test framework is currently present.
  Recommended:
  - add route-level smoke tests for reservations and bookings responses.
