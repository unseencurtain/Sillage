import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { BTSClient } from "../../vendors/bts/BTSClient.js";
import btsConfig from "../../vendors/bts/config.js";
import {
  getCart, addToCart, updateCartQty, removeFromCart, clearCart,
  getCartTotal, getProductByEan, saveOrder,
} from "../../db/database.js";
import { layout, esc, currency } from "../views.js";

export const cartRouter = Router();
const client = new BTSClient(btsConfig);

type CheckoutJob = {
  status: "processing" | "success" | "error";
  createdAt: number;
  orderNumber?: string;
  error?: string;
};

const checkoutJobs = new Map<string, CheckoutJob>();
const CHECKOUT_JOB_TTL_MS = 30 * 60 * 1000;

/** Ensure session cookie exists and return it */
function getSession(req: Request, res: Response): string {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie("sid", sid, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  }
  return sid;
}

function cleanupCheckoutJobs(): void {
  const now = Date.now();
  for (const [id, job] of checkoutJobs.entries()) {
    if (now - job.createdAt > CHECKOUT_JOB_TTL_MS) {
      checkoutJobs.delete(id);
    }
  }
}

// ─── View cart ────────────────────────────────────────────────

cartRouter.get("/", (req: Request, res: Response) => {
  const sid = getSession(req, res);
  const items = getCart(sid);
  const total = getCartTotal(sid);

  if (items.length === 0) {
    const body = /* html */ `
      <div class="text-center py-5">
        <i class="bi bi-cart-x" style="font-size:4rem;color:#adb5bd"></i>
        <h3 class="mt-3 text-muted">Your cart is empty</h3>
        <a href="/products" class="btn btn-dark mt-2">Browse Products</a>
      </div>`;
    res.send(layout("Cart", body, 0));
    return;
  }

  const rows = items.map((item) => /* html */ `
    <tr>
      <td>
        <a href="/products/${esc(item.product_sku)}" class="text-dark fw-semibold">${esc(item.name)}</a>
        <div class="text-muted small">${esc(item.product_sku)}</div>
      </td>
      <td>${currency(item.price)}</td>
      <td>
        <form action="/cart/update" method="POST" class="d-flex gap-1" style="width:120px">
          <input type="hidden" name="sku" value="${esc(item.product_sku)}" />
          <input type="number" name="qty" class="form-control form-control-sm" value="${item.quantity}" min="1" max="99" />
          <button class="btn btn-sm btn-outline-secondary">↵</button>
        </form>
      </td>
      <td class="fw-bold">${currency(item.price * item.quantity)}</td>
      <td>
        <form action="/cart/remove" method="POST">
          <input type="hidden" name="sku" value="${esc(item.product_sku)}" />
          <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i></button>
        </form>
      </td>
    </tr>
  `).join("");

  const body = /* html */ `
    <h2 class="mb-4"><i class="bi bi-cart3"></i> Your Cart</h2>
    <div class="row g-4">
      <div class="col-lg-8">
        <div class="card shadow-sm">
          <div class="card-body p-0">
            <table class="table mb-0">
              <thead class="table-dark">
                <tr>
                  <th>Product</th><th>Price</th><th>Qty</th><th>Subtotal</th><th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        <div class="mt-2">
          <form action="/cart/clear" method="POST">
            <button class="btn btn-sm btn-outline-danger"><i class="bi bi-trash"></i> Clear cart</button>
          </form>
        </div>
      </div>
      <div class="col-lg-4">
        <div class="card shadow-sm">
          <div class="card-body">
            <h5 class="card-title">Order Summary</h5>
            <div class="d-flex justify-content-between mb-1">
              <span>Subtotal</span><strong>${currency(total)}</strong>
            </div>
            <div class="text-muted small mb-3">Shipping calculated at checkout</div>
            <a href="/checkout" class="btn btn-dark w-100">
              <i class="bi bi-lock"></i> Proceed to Checkout
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
  res.send(layout("Cart", body, items.length));
});

// ─── Add to cart ──────────────────────────────────────────────

cartRouter.post("/add", (req: Request, res: Response) => {
  const sid = getSession(req, res);
  const sku = String(req.body?.sku ?? "");
  const qty = Math.max(1, parseInt(String(req.body?.qty ?? "1"), 10));

  const product = getProductByEan(sku);
  if (!product) { res.redirect("/products"); return; }

  addToCart(sid, {
    product_sku: product.ean,
    quantity: qty,
    price: product.price,
    name: product.name,
    image: product.image,
  });

  res.redirect("/cart");
});

// ─── Update qty ───────────────────────────────────────────────

cartRouter.post("/update", (req: Request, res: Response) => {
  const sid = getSession(req, res);
  const sku = String(req.body?.sku ?? "");
  const qty = parseInt(String(req.body?.qty ?? "0"), 10);
  updateCartQty(sid, sku, qty);
  res.redirect("/cart");
});

// ─── Remove item ──────────────────────────────────────────────

cartRouter.post("/remove", (req: Request, res: Response) => {
  const sid = getSession(req, res);
  removeFromCart(sid, String(req.body?.sku ?? ""));
  res.redirect("/cart");
});

// ─── Clear cart ───────────────────────────────────────────────

cartRouter.post("/clear", (req: Request, res: Response) => {
  clearCart(getSession(req, res));
  res.redirect("/cart");
});

// ─── Checkout GET ─────────────────────────────────────────────

cartRouter.get("/checkout", async (req: Request, res: Response) => {
  const sid = getSession(req, res);
  const items = getCart(sid);
  if (items.length === 0) { res.redirect("/cart"); return; }

  const cartCount = items.length;
  const total = getCartTotal(sid);
  const countries = await client.getCountries().catch(() => []);
  const countryOptions = countries
    .map(
      (c) =>
        `<option value="${esc(c.country_code)}"${c.country_code === "ES" ? " selected" : ""}>${esc(c.country_code)} — ${esc(c.country_name)}</option>`,
    )
    .join("");

  const summary = items.map((i) => /* html */ `
    <div class="d-flex justify-content-between small py-1 border-bottom">
      <span>${esc(i.name)} <span class="text-muted">×${i.quantity}</span></span>
      <span>${currency(i.price * i.quantity)}</span>
    </div>
  `).join("");

  const body = /* html */ `
    <h2 class="mb-4"><i class="bi bi-bag-check"></i> Checkout</h2>
    <div class="row g-4">
      <div class="col-lg-7">
        <form action="/cart/checkout" method="POST" class="card shadow-sm">
          <div class="card-header fw-semibold"><i class="bi bi-person"></i> Delivery Details</div>
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label">Full Name *</label>
              <input type="text" name="client_name" class="form-control" required />
            </div>
            <div class="mb-3">
              <label class="form-label">Address *</label>
              <input type="text" name="address" class="form-control" required />
            </div>
            <div class="row g-2 mb-3">
              <div class="col-4">
                <label class="form-label">Postcode *</label>
                <input type="text" name="postal_code" class="form-control" required />
              </div>
              <div class="col-8">
                <label class="form-label">City *</label>
                <input type="text" name="city" class="form-control" required />
              </div>
            </div>
            <div class="row g-2 mb-3">
              <div class="col-6">
                <label class="form-label">Country code *</label>
                <select name="country_code" class="form-select" required>
                  ${countryOptions || `<option value="ES" selected>ES — Spain</option>`}
                </select>
              </div>
              <div class="col-6">
                <label class="form-label">Phone *</label>
                <input type="tel" name="telephone" class="form-control" required />
              </div>
            </div>
            <div class="mb-3">
              <label class="form-label">State/Province (US & CA only)</label>
              <input type="text" name="state_code" class="form-control" placeholder="e.g. NY, CA, QC" />
            </div>
            <div class="mb-3">
              <label class="form-label">Payment method *</label>
              <select name="payment_method" class="form-select" required>
                <option value="banktransfer">Bank Transfer (test — stays Pending)</option>
                <option value="wallet">Wallet</option>
                <option value="btscredit">BTS Credit</option>
              </select>
            </div>
            <div class="form-check mb-3">
              <input class="form-check-input" type="checkbox" name="dropshipping" value="1" id="ds" checked />
              <label class="form-check-label" for="ds">Dropshipping (ship directly to customer)</label>
            </div>
            <button type="submit" class="btn btn-dark w-100 btn-lg">
              <i class="bi bi-bag-check"></i> Place Order
            </button>
            <div class="text-muted small mt-2 text-center">
              ⚠️ Orders are real — no sandbox. Use Bank Transfer to test.
            </div>
          </div>
        </form>
      </div>
      <div class="col-lg-5">
        <div class="card shadow-sm">
          <div class="card-header fw-semibold"><i class="bi bi-receipt"></i> Order Summary</div>
          <div class="card-body">
            ${summary}
            <div class="d-flex justify-content-between fw-bold mt-2">
              <span>Total (excl. shipping)</span><span>${currency(total)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  res.send(layout("Checkout", body, cartCount));
});

// ─── Checkout POST — place order ──────────────────────────────

cartRouter.post("/checkout", async (req: Request, res: Response) => {
  const sid = getSession(req, res);
  const items = getCart(sid);
  if (items.length === 0) { res.redirect("/cart"); return; }

  const {
    client_name, address, postal_code, city, country_code,
    telephone, state_code, payment_method, dropshipping,
  } = req.body as Record<string, string>;
  const normalizedCountry = String(country_code ?? "").trim().toUpperCase();
  const normalizedPostal = String(postal_code ?? "").trim();

  cleanupCheckoutJobs();
  const jobId = randomUUID();
  checkoutJobs.set(jobId, { status: "processing", createdAt: Date.now() });

  void (async () => {
    try {
      if (!normalizedCountry || normalizedCountry.length !== 2) {
        throw new Error("Please select a valid destination country.");
      }
      if (!normalizedPostal) {
        throw new Error("Please enter a postal code.");
      }

      // Step 1: Get shipping prices for the cheapest option
      const shippingOptions = await client.getShippingPrices(
        { country_code: normalizedCountry, postal_code: normalizedPostal },
        items.map((i) => ({ sku: i.product_sku, quantity: i.quantity })),
      );

      if (!shippingOptions.length) {
        throw new Error(
          `No shipping options available for ${normalizedCountry} ${normalizedPostal}. Select a different country/postal code from the list BTS supports.`,
        );
      }

      // Pick cheapest
      const shipping = shippingOptions.sort(
        (a, b) => a.shipping_cost - b.shipping_cost,
      )[0]!;
      const itemsSubtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

      // Step 2: Create order
      const order = await client.setCreateOrder({
        payment_method:
          (payment_method as "wallet" | "banktransfer" | "btscredit") ??
          "banktransfer",
        products: items.map((i) => ({ sku: i.product_sku, quantity: i.quantity })),
        shipping_cost_id: shipping.id,
        client_name,
        address,
        postal_code: normalizedPostal,
        city,
        country_code: normalizedCountry,
        telephone,
        dropshipping: dropshipping === "1" ? 1 : 0,
        ...(state_code ? { state_code } : {}),
      });

      // Step 3: Save to local DB
      saveOrder(
        {
          order_number: order.order_number,
          order_total:
            Number.isFinite(parseFloat(order.order_total)) &&
            parseFloat(order.order_total) > 0
              ? parseFloat(order.order_total)
              : itemsSubtotal + shipping.shipping_cost,
          order_status: order.order_status || "Pending Payment",
          payment_method: payment_method ?? "banktransfer",
          client_name,
          address,
          postal_code: normalizedPostal,
          city,
          state_code: state_code ?? "",
          country_code: normalizedCountry,
          telephone,
          shipping_company: shipping.company_name,
          shipping_cost: shipping.shipping_cost,
          tracking: "",
          expected_dispatch_date: order.expected_dispatch_date ?? "",
          expected_delivery_date: order.expected_delivery_date ?? "",
          dropshipping: dropshipping === "1" ? 1 : 0,
        },
        items.map((i) => ({
          order_number: order.order_number,
          product_sku: i.product_sku,
          product_name: i.name,
          quantity: i.quantity,
          unit_price: i.price,
        })),
      );

      clearCart(sid);
      checkoutJobs.set(jobId, {
        status: "success",
        createdAt: Date.now(),
        orderNumber: order.order_number,
      });
    } catch (e: unknown) {
      checkoutJobs.set(jobId, {
        status: "error",
        createdAt: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  res.redirect(`/cart/checkout/status/${jobId}`);
});

cartRouter.get("/checkout/status/:jobId", (req: Request, res: Response) => {
  cleanupCheckoutJobs();
  const sid = getSession(req, res);
  const cartCount = getCart(sid).length;
  const jobId = req.params["jobId"] ?? "";
  const job = checkoutJobs.get(jobId);

  if (!job) {
    res.status(404).send(
      layout(
        "Checkout",
        `<div class="alert alert-warning">Checkout session expired. Please try again.</div>
         <a href="/cart/checkout" class="btn btn-dark">Back to checkout</a>`,
        cartCount,
      ),
    );
    return;
  }

  if (job.status === "success" && job.orderNumber) {
    checkoutJobs.delete(jobId);
    res.redirect(`/orders/${job.orderNumber}?placed=1`);
    return;
  }

  if (job.status === "error") {
    checkoutJobs.delete(jobId);
    const body = /* html */ `
      <div class="alert alert-danger">
        <strong>Order failed:</strong> ${esc(job.error ?? "Unknown error")}
      </div>
      <a href="/cart/checkout" class="btn btn-dark">Try again</a>`;
    res.status(500).send(layout("Order Failed", body, cartCount));
    return;
  }

  const body = /* html */ `
    <div class="alert alert-success">
      <h5 class="mb-2"><i class="bi bi-check-circle-fill"></i> Order submission received</h5>
      <div>We sent your order request to BTS and are finalizing confirmation.</div>
    </div>
    <div class="card shadow-sm">
      <div class="card-body">
        <div class="d-flex align-items-center gap-2 mb-2">
          <div class="spinner-border spinner-border-sm text-dark" role="status" aria-hidden="true"></div>
          <strong>Finalizing with BTS...</strong>
        </div>
        <div class="text-muted small">
          This can take 10–20 seconds on BTS side. If it takes longer, you can open Orders and refresh.
        </div>
        <div class="mt-3 d-flex gap-2">
          <a href="/orders" class="btn btn-outline-dark btn-sm">Open Orders</a>
          <a href="/cart" class="btn btn-outline-secondary btn-sm">Back to Cart</a>
        </div>
      </div>
    </div>
    <script>
      const poll = async () => {
        try {
          const r = await fetch('/cart/checkout/status/${jobId}/json', { cache: 'no-store' });
          if (!r.ok) return setTimeout(poll, 1500);
          const data = await r.json();
          if (data.status === 'success' && data.orderNumber) {
            window.location.href = '/orders/' + encodeURIComponent(data.orderNumber) + '?placed=1';
            return;
          }
          if (data.status === 'error') {
            window.location.reload();
            return;
          }
        } catch {}
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 700);
    </script>
  `;
  res.send(layout("Placing order", body, cartCount));
});

cartRouter.get("/checkout/status/:jobId/json", (req: Request, res: Response) => {
  cleanupCheckoutJobs();
  const jobId = req.params["jobId"] ?? "";
  const job = checkoutJobs.get(jobId);

  if (!job) {
    res.status(404).json({ status: "expired" });
    return;
  }

  res.json({
    status: job.status,
    orderNumber: job.orderNumber ?? null,
    error: job.error ?? null,
  });
});
