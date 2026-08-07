import { Router } from "express";
import type { Request, Response } from "express";
import {
  searchProducts,
  getProductByEan,
  getManufacturers,
  getCategories,
  getCart,
} from "../../db/database.js";
import { layout, esc, currency, paginate, stockBadge } from "../views.js";

export const productsRouter = Router();

// ─── Product list ─────────────────────────────────────────────

productsRouter.get("/", (req: Request, res: Response) => {
  const sid = req.cookies?.sid ?? "";
  const cartCount = getCart(sid).length;

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const pageSize = 24;
  const search = String(req.query.q ?? "");
  const manufacturer = String(req.query.brand ?? "");
  const categoryId = req.query.cat ? parseInt(String(req.query.cat), 10) : undefined;
  const inStockOnly = req.query.instock === "1";

  const { products, total } = searchProducts({ search, manufacturer, categoryId, inStockOnly, page, pageSize });
  const brands = getManufacturers();
  const categories = getCategories().filter((c) => c.parent_id === 0);

  // Build query string helper
  const buildQS = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (manufacturer) p.set("brand", manufacturer);
    if (categoryId) p.set("cat", String(categoryId));
    if (inStockOnly) p.set("instock", "1");
    Object.entries(extra).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    return p.toString() ? "?" + p.toString() : "";
  };

  const cards = products.map((p) => /* html */ `
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
          <div class="d-flex align-items-center justify-content-between mt-auto">
            <div>
              <div class="price">${currency(p.price)}</div>
              ${p.recommended_price > p.price ? `<div class="rrp">RRP ${currency(p.recommended_price)}</div>` : ""}
            </div>
            ${stockBadge(p.stock)}
          </div>
          <form action="/cart/add" method="POST" class="mt-2">
            <input type="hidden" name="sku" value="${esc(p.ean)}" />
            <input type="hidden" name="qty" value="1" />
            <button class="btn btn-sm btn-dark w-100" ${p.stock === 0 ? "disabled" : ""}>
              <i class="bi bi-cart-plus"></i> Add to Cart
            </button>
          </form>
        </div>
      </div>
    </div>
  `).join("");

  const sidebar = /* html */ `
    <div class="sidebar">
      <form method="GET" action="/products">
        <div class="card shadow-sm mb-3">
          <div class="card-header fw-semibold"><i class="bi bi-search"></i> Search</div>
          <div class="card-body">
            <input type="text" name="q" class="form-control form-control-sm" value="${esc(search)}" placeholder="Name, brand…" />
            <input type="hidden" name="cat" value="${categoryId ?? ""}" />
            <input type="hidden" name="brand" value="${esc(manufacturer)}" />
            ${inStockOnly ? `<input type="hidden" name="instock" value="1" />` : ""}
            <button class="btn btn-sm btn-dark w-100 mt-2">Search</button>
          </div>
        </div>

        <div class="card shadow-sm mb-3">
          <div class="card-header fw-semibold"><i class="bi bi-funnel"></i> Filters</div>
          <div class="card-body">
            <div class="form-check mb-2">
              <input class="form-check-input" type="checkbox" name="instock" value="1" id="instock"
                     ${inStockOnly ? "checked" : ""} onchange="this.form.submit()" />
              <label class="form-check-label small" for="instock">In stock only</label>
            </div>
            <hr class="my-2" />
            <div class="small fw-semibold mb-1">Brand</div>
            <div style="max-height:220px;overflow-y:auto">
              <a href="/products${buildQS({ brand: "", page: "1" })}" class="d-block small py-1 ${!manufacturer ? "fw-bold text-dark" : "text-muted"}">All brands</a>
              ${brands.map((b) => `<a href="/products${buildQS({ brand: b, page: "1" })}"
                class="d-block small py-1 text-truncate ${manufacturer === b ? "fw-bold text-dark" : "text-muted"}">${esc(b)}</a>`).join("")}
            </div>
            <hr class="my-2" />
            <div class="small fw-semibold mb-1">Category</div>
            <div style="max-height:220px;overflow-y:auto">
              <a href="/products${buildQS({ cat: "", page: "1" })}" class="d-block small py-1 ${!categoryId ? "fw-bold text-dark" : "text-muted"}">All categories</a>
              ${categories.map((c) => `<a href="/products${buildQS({ cat: String(c.id), page: "1" })}"
                class="d-block small py-1 ${categoryId === c.id ? "fw-bold text-dark" : "text-muted"}">${esc(c.name)}</a>`).join("")}
            </div>
          </div>
        </div>
      </form>
    </div>
  `;

  const currentUrl = "/products" + buildQS({ page: String(page) });
  const activeFilters = [
    search && `Search: "${esc(search)}"`,
    manufacturer && `Brand: ${esc(manufacturer)}`,
    categoryId && `Category: #${categoryId}`,
    inStockOnly && "In stock only",
  ].filter(Boolean);

  const body = /* html */ `
    <div class="row g-4">
      <div class="col-lg-3">${sidebar}</div>
      <div class="col-lg-9">
        <div class="d-flex align-items-center justify-content-between mb-3">
          <h5 class="mb-0">${total.toLocaleString()} products
            ${activeFilters.length ? `<small class="text-muted fs-6">&mdash; ${activeFilters.join(" · ")}</small>` : ""}
          </h5>
          ${activeFilters.length ? `<a href="/products" class="btn btn-sm btn-outline-secondary">Clear filters</a>` : ""}
        </div>
        ${products.length === 0 ? `<div class="alert alert-info">No products found. Try adjusting your filters or <a href="/sync">run a sync</a> first.</div>` : ""}
        <div class="row g-3">${cards}</div>
        <div class="mt-4">${paginate(currentUrl, page, total, pageSize)}</div>
      </div>
    </div>
  `;

  res.send(layout("Products", body, cartCount));
});

// ─── Product detail ───────────────────────────────────────────

productsRouter.get("/:ean", (req: Request, res: Response) => {
  const sid = req.cookies?.sid ?? "";
  const cartCount = getCart(sid).length;
  const product = getProductByEan(req.params["ean"] ?? "");

  if (!product) {
    res.status(404).send(layout("Not Found", `<div class="alert alert-danger">Product not found.</div>`, cartCount));
    return;
  }

  const restricted = (() => {
    try { return JSON.parse(product.restricted_countries) as string[]; } catch { return []; }
  })();

  const body = /* html */ `
    <nav aria-label="breadcrumb">
      <ol class="breadcrumb">
        <li class="breadcrumb-item"><a href="/products">Products</a></li>
        <li class="breadcrumb-item active">${esc(product.name)}</li>
      </ol>
    </nav>

    <div class="row g-4">
      <div class="col-md-4">
        <div class="card border-0 shadow-sm">
          <img src="${esc(product.image)}" class="card-img-top p-4"
               style="height:320px;object-fit:contain;background:#fff"
               onerror="this.src='https://placehold.co/400x320?text=No+Image'"
               alt="${esc(product.name)}" />
        </div>
      </div>
      <div class="col-md-8">
        <div class="text-muted small mb-1">${esc(product.manufacturer)}</div>
        <h2 class="fw-bold">${esc(product.name)}</h2>
        <div class="mb-3">${stockBadge(product.stock)}
          ${product.flammable ? `<span class="badge bg-warning text-dark ms-1"><i class="bi bi-fire"></i> Flammable</span>` : ""}
          ${product.gender ? `<span class="badge bg-info text-dark ms-1">${esc(product.gender)}</span>` : ""}
        </div>
        <div class="mb-3">
          <span class="price fs-3">${currency(product.price)}</span>
          ${product.recommended_price > product.price ? `<span class="rrp ms-2">RRP ${currency(product.recommended_price)}</span>` : ""}
        </div>
        ${product.description ? `<p class="text-muted">${esc(product.description)}</p>` : ""}

        <table class="table table-sm table-bordered w-auto mb-3">
          <tr><th>EAN / SKU</th><td>${esc(product.ean)}</td></tr>
          <tr><th>Lead time</th><td>${product.delivery}h</td></tr>
          ${product.leadtime_to_ship ? `<tr><th>Dispatch</th><td>${esc(product.leadtime_to_ship)}</td></tr>` : ""}
          ${restricted.length ? `<tr><th>Restricted</th><td>${restricted.join(", ")}</td></tr>` : ""}
        </table>

        <form action="/cart/add" method="POST" class="d-flex gap-2 align-items-center">
          <input type="hidden" name="sku" value="${esc(product.ean)}" />
          <input type="number" name="qty" class="form-control" style="width:80px" value="1" min="1" max="${product.stock}" />
          <button class="btn btn-dark" ${product.stock === 0 ? "disabled" : ""}>
            <i class="bi bi-cart-plus"></i> Add to Cart
          </button>
        </form>
      </div>
    </div>
  `;

  res.send(layout(product.name, body, cartCount));
});
