import Beautyfort from "./src/vendors/beautyfort/Beautyfort";
import config from "./src/configs/beautyfortConfig";
import rawProducts from "./products.json";

// ── Pick a product ────────────────────────────────────────────────────────────
// Sort by stock descending and pick the cheapest well-stocked item (StockLevel > 5)
// so the test doesn't deplete rare stock.
const products = rawProducts as Array<{
  FullName: string;
  StockCode: string;
  Price: string;
  StockLevel: number;
  Brand: string;
}>;

const product = products
  .filter((p) => Number(p.StockLevel) > 5)
  .sort((a, b) => parseFloat(a.Price) - parseFloat(b.Price))[0];

if (!product) {
  console.error(
    "❌ No suitable product found in products.json (need StockLevel > 5)",
  );
  process.exit(1);
}

const safeProduct = product as NonNullable<typeof product>;

// ── Addresses ─────────────────────────────────────────────────────────────────
const INVOICE = {
  firstName: "Lovely Perfume",
  lastName: "Store",
  address: {
    companyName: "Lovely Perfume Store B.V.",
    address1: "Industrieplein 1",
    town: "Hengelo",
    county: "OV",
    postcode: "7553 LL",
    countryCode: "NL",
  },
};

// For a lifecycle test we ship back to ourselves so nothing actually leaves the
// warehouse — the order will be cancelled before it is ever picked.
const DELIVERY = INVOICE;

const YOUR_ORDER_REF = `LIFECYCLE-TEST-${Date.now()}`;

// ── Banner ────────────────────────────────────────────────────────────────────
console.log("=".repeat(62));
console.log("  BeautyFort — Full Lifecycle Test (real product)");
console.log("=".repeat(62));
console.log(`\n📦 Product    : ${product.FullName}`);
console.log(`   StockCode  : ${product.StockCode}`);
console.log(`   Price      : £${product.Price}`);
console.log(`   StockLevel : ${product.StockLevel}`);
console.log(`\n🔖 Your Ref   : ${YOUR_ORDER_REF}`);
console.log(`🌐 Endpoint   : ${config.endpoint}`);
console.log(`👤 User       : ${config.user}`);
console.log(`🧪 TestMode   : ${config.mode}`);
console.log("\n" + "=".repeat(62) + "\n");

// ── Helpers ───────────────────────────────────────────────────────────────────
function step(n: number, label: string) {
  console.log(`▶ Step ${n} — ${label} ...`);
}

function ok(msg: string) {
  console.log(`   ✅ ${msg}`);
}

function warn(warnings: string[]) {
  for (const w of warnings) console.log(`   ⚠️  ${w}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  let orderReference: number | undefined;

  try {
    // ── 1: Get delivery options ───────────────────────────────────
    step(1, "Fetching account info & delivery options");

    const bf1 = new Beautyfort(config);
    const accountInfo = await bf1.getAccountInformation();
    const ddOptions = accountInfo.deliveryOptions;

    if (ddOptions.length === 0) {
      console.error("❌ No Direct Dispatch delivery options returned.");
      console.log("   Raw response:\n", accountInfo.raw);
      process.exit(1);
    }

    console.log(`   Found ${ddOptions.length} option(s):`);
    for (const o of ddOptions) {
      console.log(`      [${o.id}] ${o.name} — ${o.countryCode} — £${o.price}`);
    }

    // Prefer an NL option, otherwise fall back to the first one.
    const chosen =
      ddOptions.find((o) => o.countryCode === "NL") ?? ddOptions[0]!;
    const deliveryOptionId = Number(chosen.id);
    ok(`Using delivery option [${deliveryOptionId}] ${chosen.name}\n`);

    // ── 2: Create order ───────────────────────────────────────────
    step(2, "Creating Direct Dispatch order");

    const bf2 = new Beautyfort(config);
    const created = await bf2.createOrder("Direct Dispatch", YOUR_ORDER_REF);

    orderReference = Number(created.orderReference);
    ok(`Order created — BeautyFort ref: ${orderReference}`);
    console.log(`   Your ref  : ${created.yourOrderReference ?? "N/A"}`);
    warn(created.warnings);
    console.log();

    // ── 3: Add item ───────────────────────────────────────────────
    step(3, `Adding ${safeProduct.StockCode} × 1 to order #${orderReference}`);

    const bf3 = new Beautyfort(config);
    const added = await bf3.addOrderItem(
      safeProduct.StockCode,
      1,
      orderReference,
    );

    ok(
      `Item added — ItemRef: ${added.itemReference}, TotalQty: ${added.totalQuantity}`,
    );
    warn(added.warnings);
    console.log();

    // ── 4: Place order ────────────────────────────────────────────
    step(4, `Placing order #${orderReference}`);

    const bf4 = new Beautyfort(config);
    const placed = await bf4.placeOrder(
      deliveryOptionId,
      INVOICE.firstName,
      INVOICE.lastName,
      INVOICE.address,
      DELIVERY.firstName,
      DELIVERY.lastName,
      DELIVERY.address,
      orderReference,
      YOUR_ORDER_REF,
      false, // attemptAutomaticPayment — do NOT charge automatically
    );

    ok(`Placed — Status: ${placed.status}`);
    console.log(`   Order ref : ${placed.orderReference}`);
    warn(placed.warnings);
    console.log();

    // ── 5: Get order details ──────────────────────────────────────
    step(5, `Fetching order details for #${orderReference}`);

    const bf5 = new Beautyfort(config);
    const details = await bf5.getOrderDetail(orderReference, undefined, true);

    ok(`Status: ${details.status}`);

    if (details.orderCostSummary) {
      const s = details.orderCostSummary;
      console.log(`   💰 Cost summary:`);
      console.log(`      Subtotal : £${s.subtotal}`);
      console.log(`      Tax      : £${s.tax}`);
      console.log(`      Shipping : £${s.shipping}`);
      console.log(`      Total    : £${s.total}`);
    }

    if (details.orderItems && details.orderItems.length > 0) {
      console.log(`   📋 Items:`);
      for (const item of details.orderItems) {
        console.log(
          `      - ${item.stockCode} × ${item.quantity} @ £${item.price}`,
        );
      }
    }

    if (details.parcels && details.parcels.length > 0) {
      console.log(`   📬 Parcels:`);
      for (const p of details.parcels) {
        console.log(`      - Box ${p.boxNumber} via ${p.courierName}`);
        if (p.trackingCode) console.log(`        Tracking : ${p.trackingCode}`);
        if (p.trackingURL) console.log(`        URL      : ${p.trackingURL}`);
      }
    }

    warn(details.warnings);
    console.log();

    // ── 6: Cancel order (test cleanup) ────────────────────────────
    step(6, `Cancelling order #${orderReference} (test cleanup)`);

    const bf6 = new Beautyfort(config);
    const cancelled = await bf6.cancelOrder(orderReference, YOUR_ORDER_REF);

    if (cancelled.success) {
      ok("Order cancelled — no stock will be dispatched");
    } else {
      console.log(
        "   ⚠️  Cancel response received but success flag was not set",
      );
    }

    if (cancelled.cancellationFee !== null) {
      console.log(`   💸 Cancellation fee: £${cancelled.cancellationFee}`);
    } else {
      console.log(`   💸 No cancellation fee`);
    }

    warn(cancelled.warnings);
  } catch (err) {
    console.error("\n❌ Lifecycle test failed:", err);

    // Best-effort cleanup so we don't leave orphan orders on the account.
    if (orderReference !== undefined) {
      console.log(
        `\n🧹 Attempting emergency cancel of order #${orderReference} ...`,
      );
      try {
        const bfClean = new Beautyfort(config);
        await bfClean.cancelOrder(orderReference);
        console.log("   ✅ Emergency cancel succeeded");
      } catch (cleanupErr) {
        console.error("   ❌ Emergency cancel also failed:", cleanupErr);
        console.log(
          `   ⚠️  Manual action required — cancel order #${orderReference} on the BeautyFort dashboard`,
        );
      }
    }

    process.exit(1);
  }

  console.log("\n" + "=".repeat(62));
  console.log("  ✔ Lifecycle test complete — all steps passed");
  console.log("=".repeat(62) + "\n");
}

run();
