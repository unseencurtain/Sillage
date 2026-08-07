import express from "express";
import cookieParser from "cookie-parser";
import { productsRouter } from "./routes/products.js";
import { cartRouter } from "./routes/cart.js";
import { ordersRouter } from "./routes/orders.js";
import {
  getDb,
  getLastSync,
  getOrders,
  searchProducts,
  getCart,
} from "../db/database.js";
import { layout, esc, currency, stockBadge } from "./views.js";

// Initialise DB & schema on startup
getDb();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ─── Routes ───────────────────────────────────────────────────
app.use("/products", productsRouter);
app.use("/cart", cartRouter); // /cart/*, /cart/checkout, etc.
app.use("/orders", ordersRouter);

// Convenience redirect so /checkout → /cart/checkout
app.get("/checkout", (_req, res) => res.redirect("/cart/checkout"));
app.post("/checkout", (_req, res) => res.redirect(307, "/cart/checkout"));

// ─── Home ─────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  const sid = _req.cookies?.sid ?? "";
  const cartCount = getCart(sid).length;
  const lastSync = getLastSync();
  const { total: totalProducts } = searchProducts({});
  const { total: totalOrders } = getOrders(1, 1);

  // Featured: 8 random in-stock products
  const { products: featured } = searchProducts({
    inStockOnly: true,
    pageSize: 8,
  });

  const cards = featured
    .map(
      (p) => /* html */ `
    <div class="col-sm-6 col-md-4 col-lg-3">
      <div class="card product-card h-100 shadow-sm">
        <a href="/products/${esc(p.ean)}">
          <img src="${esc(p.image)}" class="card-img-top product-img" alt="${esc(p.name)}"
               onerror="this.src='https://placehold.co/300x200?text=No+Image'" loading="lazy" />
        </a>
        <div class="card-body d-flex flex-column p-3">
          <div class="small text-muted mb-1">${esc(p.manufacturer)}</div>
          <a href="/products/${esc(p.ean)}" class="text-decoration-none text-dark fw-semibold mb-2 flex-grow-1">
            ${esc(p.name)}
          </a>
          <div class="d-flex justify-content-between align-items-center mt-auto">
            <span class="price">${currency(p.price)}</span>
            ${stockBadge(p.stock)}
          </div>
        </div>
      </div>
    </div>
  `,
    )
    .join("");

  const body = /* html */ `
    <!-- Hero -->
    <div class="rounded-4 text-white p-5 mb-5 shadow"
         style="background:linear-gradient(135deg,#1a1a2e,#16213e)">
      <div class="row align-items-center">
        <div class="col-md-7">
          <h1 class="display-5 fw-bold">BTS Dropship Router</h1>
          <p class="lead opacity-75">
            Browse ${totalProducts.toLocaleString()} products from BTS Wholesaler.
            Order &amp; track — all in one place.
          </p>
          <div class="d-flex gap-2 mt-3">
            <a href="/products" class="btn btn-warning btn-lg fw-bold">Browse Products</a>
            <a href="/orders" class="btn btn-outline-light btn-lg">My Orders</a>
          </div>
        </div>
        <div class="col-md-5 text-center mt-4 mt-md-0">
          <i class="bi bi-bag-heart-fill" style="font-size:7rem;color:#6f42c1;opacity:.7"></i>
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div class="row g-3 mb-5">
      <div class="col-sm-4">
        <div class="card shadow-sm text-center p-3">
          <div class="display-6 fw-bold text-primary">${totalProducts.toLocaleString()}</div>
          <div class="text-muted small">Products in catalog</div>
        </div>
      </div>
      <div class="col-sm-4">
        <div class="card shadow-sm text-center p-3">
          <div class="display-6 fw-bold text-success">${totalOrders.toLocaleString()}</div>
          <div class="text-muted small">Orders placed</div>
        </div>
      </div>
      <div class="col-sm-4">
        <div class="card shadow-sm text-center p-3">
          <div class="display-6 fw-bold text-warning" style="font-size:1.4rem!important">
            ${lastSync ? new Date(lastSync.completed_at).toLocaleDateString() : "—"}
          </div>
          <div class="text-muted small">Last synced</div>
        </div>
      </div>
    </div>

    <!-- Featured products -->
    ${
      featured.length > 0
        ? /* html */ `
        <h4 class="mb-3"><i class="bi bi-stars text-warning"></i> Featured Products</h4>
        <div class="row g-3 mb-4">${cards}</div>
        <div class="text-center">
          <a href="/products" class="btn btn-outline-dark btn-lg">View all products →</a>
        </div>`
        : /* html */ `
        <div class="alert alert-warning d-flex align-items-center gap-2">
          <i class="bi bi-info-circle-fill fs-5"></i>
          <div>
            No products in the database yet.
            Run <code>bun run sync</code> to pull the full catalog from BTS Wholesaler.
          </div>
        </div>`
    }
  `;

  res.send(layout("Home", body, cartCount));
});

// ─── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).send(
    layout(
      "Not Found",
      /* html */ `
    <div class="text-center py-5">
      <i class="bi bi-emoji-dizzy" style="font-size:4rem;color:#adb5bd"></i>
      <h2 class="mt-3">404 — Page not found</h2>
      <a href="/" class="btn btn-dark mt-2">Go home</a>
    </div>`,
    ),
  );
});

// ─── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(
    `\x1b[32m✓\x1b[0m BTS Dropship → \x1b[4mhttp://localhost:${PORT}\x1b[0m`,
  );
  console.log(`  Products : http://localhost:${PORT}/products`);
  console.log(`  Cart     : http://localhost:${PORT}/cart`);
  console.log(`  Orders   : http://localhost:${PORT}/orders`);
  console.log(`  Sync     : bun run sync`);
});

export default app;
