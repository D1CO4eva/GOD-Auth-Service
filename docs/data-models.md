# Data Models and Cache

## Bookings Cache Files (`cache_2026.json`, `cache_2027.json`)

Stored shape:

```json
{
  "updatedAt": "2026-03-20T00:00:00.000Z",
  "payload": "{\"bookings\":[{\"date\":\"2026-05-10\",\"programType\":\"Radha Kalyanam\",\"time\":\"10:00 AM - 1:00 PM\"}]}"
}
```

Notes:

- `payload` is a JSON string.
- Year-specific files are maintained independently.
- Public payload fields are intentionally limited to:
  - `date`
  - `programType`
  - `time`

## Menu Cache File (`menu_cache.json`)

Stored shape:

```json
{
  "updatedAt": "2026-03-20T00:00:00.000Z",
  "posts": [
    {
      "createdAt": "2026-03-20T00:00:00.000Z",
      "foods": ["Item A", "Item B"]
    }
  ]
}
```

Notes:

- Only latest 6 posts are retained.
- Only compact food names are stored (no full upstream payload history).

## Reservation Lookup Data

Reservation routes normalize many alias fields internally, but currently:

- `verify`: confirmation-based
- `update`: confirmation + new date (+ optional new time)
- `delete`: confirmation-based

Apps Script responses are normalized and mapped before forwarding.
