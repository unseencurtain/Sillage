import { Router } from "express";
import type { Request, Response } from "express";
import { BTSClient } from "../../vendors/bts/BTSClient.js";
import btsConfig from "../../vendors/bts/config.js";
import {
  getOrders, getOrderByNumber, updateOrderTracking, getCart,
} from "../../db/database.js";
import { normalizeOrderStatus } from "../../utils/orderStatus.js";
import { layout, esc, currency, paginate, statusBadge } from "../views.js";

export const ordersRouter = Router();
const client = new BTSClient(btsConfig);

// ─── Refresh ALL pending order trackings ─────────────────────

ordersRouter.get("/refresh-all", async (_req: Request, res: Response) => {
  const { orders } = getOrders(1, 200);
  const pending = orders.filter(
    (o) => !o.tracking && normalizeOrderStatus(o.order_status) !== "Delivered",
  );
  const numbers = pending.map((o) => o.order_number);

  if (numbers.length > 0) {
    try {
      const trackings = await client.getTrackings(numbers);
      for (const t of trackings) {
        if (t.tracking) updateOrderTracking(t.order_number, t.tracking, "Shipped");
      }
    } catch {}
  }
  res.redirect("/orders");
});

// ─── Refresh single order tracking ───────────────────────────

ordersRouter.get("/:orderNumber/refresh", async (req: Request, res: Response) => {
  const orderNumber = req.params["orderNumber"] ?? "";
  try {
    const [tracking] = await client.getTrackings([orderNumber]);
    if (tracking?.tracking) {
      updateOrderTracking(orderNumber, tracking.tracking, "Shipped");
    }
    // Also refresh status from getOrder
    const detail = await client.getOrder(orderNumber);
    updateOrderTracking(orderNumber, detail.tracking ?? "", detail.order_status);
  } catch {
    // Tracking might not be available yet — that's fine
  }
  res.redirect(`/orders/${orderNumber}`);
});

// ─── Order list ───────────────────────────────────────────────

ordersRouter.get("/", (req: Request, res: Response) => {
  const sid = req.cookies?.sid ?? "";
  const cartCount = getCart(sid).length;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const pageSize = 20;

  const { orders, total } = getOrders(page, pageSize);

  const rows = orders.length === 0
    ? `<tr><td colspan="7" class="text-center text-muted py-4">No orders yet. <a href="/products">Start shopping!</a></td></tr>`
    : orders.map((o) => /* html */ `
      <tr>
        <td><a href="/orders/${esc(o.order_number)}" class="fw-mono">${esc(o.order_number)}</a></td>
        <td>${statusBadge(o.order_status)}</td>
        <td>${esc(o.client_name)}</td>
        <td>${esc(o.city)}, ${esc(o.country_code)}</td>
        <td>${currency(o.order_total)}</td>
        <td>${o.tracking
          ? `<span class="badge bg-success tracking-badge"><i class="bi bi-geo-alt-fill"></i> ${esc(o.tracking)}</span>`
          : `<span class="text-muted small">Pending</span>`}</td>
        <td>${new Date(o.created_at ?? "").toLocaleDateString()}</td>
      </tr>
    `).join("");

  const body = /* html */ `
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h2 class="mb-0"><i class="bi bi-receipt"></i> Orders</h2>
      <a href="/orders/refresh-all" class="btn btn-sm btn-outline-secondary">
        <i class="bi bi-arrow-clockwise"></i> Refresh Tracking
      </a>
    </div>
    <div class="card shadow-sm">
      <div class="card-body p-0">
        <table class="table table-hover mb-0">
          <thead class="table-dark">
            <tr>
              <th>Order #</th><th>Status</th><th>Customer</th>
              <th>Destination</th><th>Total</th><th>Tracking</th><th>Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <div class="mt-3">${paginate("/orders", page, total, pageSize)}</div>
  `;

  res.send(layout("Orders", body, cartCount));
});

// ─── Order detail ─────────────────────────────────────────────

ordersRouter.get("/:orderNumber", async (req: Request, res: Response) => {
  const sid = req.cookies?.sid ?? "";
  const cartCount = getCart(sid).length;
  const orderNumber = req.params["orderNumber"] ?? "";
  const placed = req.query.placed === "1";

  const order = getOrderByNumber(orderNumber);
  if (!order) {
    res.status(404).send(layout("Not Found", `<div class="alert alert-danger">Order not found.</div>`, cartCount));
    return;
  }

  const itemRows = (order.items ?? []).map((i) => /* html */ `
    <tr>
      <td><a href="/products/${esc(i.product_sku)}">${esc(i.product_sku)}</a></td>
      <td>${esc(i.product_name)}</td>
      <td>${i.quantity}</td>
      <td>${currency(i.unit_price)}</td>
      <td>${currency(i.unit_price * i.quantity)}</td>
    </tr>
  `).join("");

  const trackingSection = order.tracking
    ? /* html */ `
      <div class="alert alert-success">
        <i class="bi bi-geo-alt-fill"></i> <strong>Tracking:</strong>
        <code class="ms-1">${esc(order.tracking)}</code>
        via ${esc(order.shipping_company)}
      </div>`
    : /* html */ `
      <div class="alert alert-info">
        <i class="bi bi-clock"></i> Tracking not yet available (usually 24–72h after dispatch).
        <a href="/orders/${esc(orderNumber)}/refresh" class="btn btn-sm btn-outline-primary ms-2">
          <i class="bi bi-arrow-clockwise"></i> Check now
        </a>
      </div>`;

  const body = /* html */ `
    ${placed ? `<div class="alert alert-success"><i class="bi bi-check-circle-fill"></i> <strong>Order placed successfully!</strong> Order number: <code>${esc(orderNumber)}</code></div>` : ""}

    <nav aria-label="breadcrumb">
      <ol class="breadcrumb">
        <li class="breadcrumb-item"><a href="/orders">Orders</a></li>
        <li class="breadcrumb-item active">${esc(orderNumber)}</li>
      </ol>
    </nav>

    <div class="row g-4">
      <div class="col-md-8">
        ${trackingSection}
        <div class="card shadow-sm mb-3">
          <div class="card-header fw-semibold"><i class="bi bi-box-seam"></i> Items</div>
          <div class="card-body p-0">
            <table class="table mb-0">
              <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr></thead>
              <tbody>${itemRows}</tbody>
              <tfoot class="table-light">
                <tr><td colspan="4" class="text-end fw-bold">Order Total</td>
                    <td class="fw-bold">${currency(order.order_total)}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      <div class="col-md-4">
        <div class="card shadow-sm mb-3">
          <div class="card-header fw-semibold"><i class="bi bi-info-circle"></i> Order Info</div>
          <div class="card-body">
            <dl class="row mb-0 small">
              <dt class="col-5">Status</dt>
              <dd class="col-7">${statusBadge(order.order_status)}</dd>
              <dt class="col-5">Payment</dt>
              <dd class="col-7">${esc(order.payment_method)}</dd>
              <dt class="col-5">Shipping</dt>
              <dd class="col-7">${esc(order.shipping_company)} (${currency(order.shipping_cost)})</dd>
              <dt class="col-5">Dispatch</dt>
              <dd class="col-7">${esc(order.expected_dispatch_date || "TBC")}</dd>
              <dt class="col-5">Delivery</dt>
              <dd class="col-7">${esc(order.expected_delivery_date || "TBC")}</dd>
              <dt class="col-5">Date</dt>
              <dd class="col-7">${new Date(order.created_at ?? "").toLocaleString()}</dd>
            </dl>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header fw-semibold"><i class="bi bi-geo"></i> Delivery Address</div>
          <div class="card-body small">
            <strong>${esc(order.client_name)}</strong><br />
            ${esc(order.address)}<br />
            ${esc(order.city)}, ${esc(order.postal_code)}<br />
            ${order.state_code ? esc(order.state_code) + ", " : ""}${esc(order.country_code)}<br />
            <i class="bi bi-telephone"></i> ${esc(order.telephone)}
          </div>
        </div>
      </div>
    </div>
  `;

  res.send(layout(`Order ${orderNumber}`, body, cartCount));
});
