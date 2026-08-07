import { normalizeOrderStatus } from "./utils/orderStatus.js";

/** Server-side HTML template helpers — no external deps needed */

export function layout(title: string, body: string, cartCount = 0): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} – BTS Dropship</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
  <style>
    :root { --accent: #6f42c1; }
    body  { background: #f8f9fa; }
    .navbar-brand { font-weight: 700; letter-spacing: -.5px; }
    .product-card { transition: transform .15s, box-shadow .15s; border: none; }
    .product-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,.12); }
    .product-img  { height: 200px; object-fit: contain; padding: 12px; background: #fff; }
    .badge-stock-in  { background: #198754; }
    .badge-stock-out { background: #dc3545; }
    .sidebar { position: sticky; top: 80px; }
    .price { color: var(--accent); font-weight: 700; font-size: 1.1rem; }
    .rrp   { color: #adb5bd; text-decoration: line-through; font-size: .85rem; }
    .tracking-badge { font-size: .8rem; }
    .cart-count { font-size: .65rem; position: relative; top: -6px; }
  </style>
</head>
<body>
<nav class="navbar navbar-expand-lg navbar-dark bg-dark sticky-top shadow-sm">
  <div class="container">
    <a class="navbar-brand" href="/"><i class="bi bi-bag-heart-fill text-warning me-1"></i>BTS Dropship</a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#nav">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="nav">
      <ul class="navbar-nav me-auto">
        <li class="nav-item"><a class="nav-link" href="/products"><i class="bi bi-grid"></i> Products</a></li>
        <li class="nav-item"><a class="nav-link" href="/categories"><i class="bi bi-tags"></i> Categories</a></li>
        <li class="nav-item"><a class="nav-link" href="/orders"><i class="bi bi-receipt"></i> Orders</a></li>
      </ul>
      <a class="btn btn-outline-warning btn-sm" href="/cart">
        <i class="bi bi-cart3"></i> Cart
        ${cartCount > 0 ? `<span class="badge bg-danger cart-count">${cartCount}</span>` : ""}
      </a>
    </div>
  </div>
</nav>

<main class="container py-4">
  ${body}
</main>

<footer class="bg-dark text-secondary py-3 mt-5">
  <div class="container text-center small">
    BTS Dropship Router &copy; ${new Date().getFullYear()} &mdash;
    Powered by <strong class="text-light">BTS Wholesaler API</strong>
  </div>
</footer>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}

/** Escape HTML entities */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format currency (BTS Wholesaler prices are in EUR) */
export function currency(n: number | string): string {
  return `€${Number(n).toFixed(2)}`;
}

/** Pagination links */
export function paginate(
  baseUrl: string,
  page: number,
  total: number,
  pageSize: number,
): string {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return "";

  const url = (p: number) => {
    const u = new URL(baseUrl, "http://x");
    u.searchParams.set("page", String(p));
    return u.pathname + u.search;
  };

  const prev =
    page > 1
      ? `<li class="page-item"><a class="page-link" href="${url(page - 1)}">‹ Prev</a></li>`
      : "";
  const next =
    page < totalPages
      ? `<li class="page-item"><a class="page-link" href="${url(page + 1)}">Next ›</a></li>`
      : "";

  const pages = Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
    const p = Math.max(1, Math.min(totalPages - 6, page - 3)) + i;
    return `<li class="page-item ${p === page ? "active" : ""}">
      <a class="page-link" href="${url(p)}">${p}</a></li>`;
  });

  return `<nav><ul class="pagination justify-content-center flex-wrap">${prev}${pages.join("")}${next}</ul></nav>`;
}

/** Stock badge */
export function stockBadge(stock: number): string {
  return stock > 0
    ? `<span class="badge badge-stock-in">${stock} in stock</span>`
    : `<span class="badge badge-stock-out">Out of stock</span>`;
}

/** Order status badge */
export function statusBadge(status: string): string {
  const normalized = normalizeOrderStatus(status);
  const map: Record<string, string> = {
    Paid: "success",
    Shipped: "primary",
    Delivered: "info",
    Cancelled: "danger",
    "Pending Payment": "warning",
  };
  const color = map[normalized] ?? "secondary";
  return `<span class="badge bg-${color}">${esc(normalized)}</span>`;
}
