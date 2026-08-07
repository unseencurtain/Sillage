# Backend notes for dashboard UI

Assumed API extensions the frontend now calls. Implement in `src/server/routes/api.ts`.

## `GET /api/orders/:id` — add `address`

Extend the existing order detail response with a ship-to address object read from WooCommerce HPOS (`wp_wc_order_addresses`), using the same `destinationAddress()` logic as ingest (prefer shipping when populated, else billing).

```json
{
  "order": { "...existing vendor order fields..." },
  "address": {
    "firstName": "Jane",
    "lastName": "Doe",
    "company": "",
    "address1": "1 Main St",
    "address2": "",
    "city": "Berlin",
    "state": "",
    "postcode": "10115",
    "country": "DE",
    "email": "jane@example.com",
    "phone": "+49..."
  },
  "items": [ "..." ],
  "events": [ "..." ],
  "tracking": [ "..." ]
}
```

Field names are camelCase to match `OrderAddress` in `web/src/lib/api.ts`.

## `PUT /api/orders/:id/address` — new

Update the WooCommerce ship-to address for the vendor order's parent WC order.

**Request body:**

```json
{
  "address": {
    "firstName": "...",
    "lastName": "...",
    "company": "",
    "address1": "...",
    "address2": "",
    "city": "...",
    "state": "",
    "postcode": "...",
    "country": "DE",
    "email": "...",
    "phone": "..."
  }
}
```

**Behaviour:**

1. Load vendor order by `:id`; 404 if missing.
2. Resolve the WC order id from `wc_order_id`.
3. Upsert `wp_wc_order_addresses` rows for `address_type = 'shipping'` (and optionally mirror billing if shipping was empty).
4. Update `sil_vendor_orders.destination_country` from `address.country`.
5. Record a `sil_order_events` row (message e.g. `"ship-to address updated from dashboard"`).

**Response:** `{ "ok": true }` on success; `{ "error": "..." }` with 4xx/5xx on failure.

**Constraints:** Only allow when order status is still pre-submit (`received`, `approved`, `needs_attention`). Reject updates once `submitting` or later.

## Already implemented (no change needed)

- `PUT /api/settings` already returns `{ ok, updated, syncStarted }` — frontend toasts when `syncStarted: true`.
- `GET /api/sync/runs` — frontend polls every 2s while newest run has `finished_at` null or `status === "running"`.
