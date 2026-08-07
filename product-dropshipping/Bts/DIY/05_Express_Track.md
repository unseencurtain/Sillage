# 05 - Express Track

## Why Express run first

Best for learning baseline architecture with familiar middleware and routing.

## Minimal structure

```text
src/
  server/app.ts
  server/routes/{products,cart,orders}.ts
  server/views.ts
  db/database.ts
  vendors/bts/BTSClient.ts
scripts/sync.ts
```

## Build order (Express)

1. `app.ts`: body parser, cookie parser, route mounting.
2. `products.ts`: list/detail from DB.
3. `cart.ts`: session cart + checkout POST.
4. `orders.ts`: local orders + refresh endpoints.
5. `scripts/sync.ts`: full/delta catalog jobs.

## Key middleware

1. Request logging
2. Error handler (render safe error page)
3. Session cookie initialization

## Routing style

1. `GET /products`
2. `GET /products/:ean`
3. `GET /cart`
4. `POST /cart/add|update|remove|clear`
5. `GET /cart/checkout`
6. `POST /cart/checkout`
7. `GET /orders`
8. `GET /orders/:orderNumber`
9. `GET /orders/:orderNumber/refresh`

## Notes

- Keep BTS API calls outside view templates.
- Use service/helper functions for checkout orchestration.
