# 07 - UI Tracks: HTML vs HTMX vs Alpine vs React

Use the same backend/domain and swap only UI approach.

## Track A: Regular server-rendered HTML

- Fastest to build.
- Form POST + redirect pattern.
- Best for learning backend-first architecture.

## Track B: HTML + HTMX

- Keep server rendering, add partial updates.
- Great for cart updates and order status polling without SPA complexity.
- Add endpoints returning partial HTML fragments.

## Track C: HTML + Alpine.js

- Small client-side state (quantity controls, toggles, optimistic UI labels).
- Still backend-first.
- Good midpoint before React.

## Track D: React frontend

- Backend becomes API-first.
- Add endpoints:
  - `GET /api/products`
  - `POST /api/cart/*`
  - `POST /api/checkout`
  - `GET /api/checkout/status/:id`
  - `GET /api/orders/:id`

## Comparison matrix

| Option | Complexity | Speed to ship | JS load | Best for |
|---|---:|---:|---:|---|
| SSR HTML | Low | High | Low | Backend mastery |
| HTMX | Low-Med | High | Low | Progressive enhancement |
| Alpine | Med | Med-High | Low-Med | Small interactions |
| React | High | Med | High | Rich client UX |

## Rebuild recommendation

1. Express + SSR HTML
2. Express + HTMX
3. Hono + SSR HTML
4. Hono + Alpine
5. Hono/Express API + React
