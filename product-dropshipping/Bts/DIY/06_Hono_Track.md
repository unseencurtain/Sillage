# 06 - Hono Track

## Why Hono run second

You reuse the same domain model, but practice a smaller, typed framework.

## Migration mindset (Express -> Hono)

Keep these unchanged:
1. DB layer
2. BTS client
3. Sync scripts
4. Business services (checkout/sync/tracking)

Swap only:
1. Router + context objects
2. Middleware APIs
3. Rendering layer wiring

## Suggested structure

```text
src/
  hono/app.ts
  hono/routes/{products,cart,orders}.ts
  services/{checkout,sync,tracking}.ts
```

## Hono-oriented rules

1. Put validation near route boundary.
2. Keep orchestration in service functions.
3. Return typed JSON for async polling endpoints.

## Typical route split

1. SSR endpoints (HTML pages)
2. API endpoints (`/api/checkout/status/:jobId`, `/api/orders/:id/refresh`)

## Notes

- Hono makes it easy to separate page routes and API routes cleanly.
- You can run same UI with server-rendered HTML or frontend framework.
