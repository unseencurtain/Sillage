# SyncVendor - Multi-Vendor Order Management

Sync orders from ANY storefront to multiple fulfillment vendors. Customers place orders anywhere, your system routes them to the right vendor.

**Currently Integrated: BeautyFort ✅ | Next: BTS Wholesaler**

## Quick Start

### 1. Configure

Create `src/configs/beautyfortConfig.ts`:
```typescript
export default {
  user: "your-api-username",
  secret: "your-api-secret",
  endpoint: "https://api.beautyfort.com/soap",
  mode: true  // true = test, false = live
};
```

### 2. Use

```typescript
import Beautyfort from "./src/vendors/beautyfort/Beautyfort";
import config from "./src/configs/beautyfortConfig";

const beautyfort = new Beautyfort(config);

// 1. Create order (appears in BeautyFort dashboard immediately)
const result = await beautyfort.createOrder("Wholesale", "ORDER-123");
console.log("Order created! Reference:", result.orderReference);

// 2. Check order status anytime
const details = await beautyfort.getOrderDetail(Number(result.orderReference));
console.log("Status:", details.status);
console.log("Items:", details.orderItems);
console.log("Total:", details.orderCostSummary?.total);

// 3. Get tracking info (when order is dispatched)
console.log("Parcels:", details.parcels); // { boxNumber, courierName, trackingCode, trackingURL }

// 4. Cancel order if needed
const cancelled = await beautyfort.cancelOrder(Number(result.orderReference));
console.log("Cancelled:", cancelled.success);
```

### 3. Test

```bash
bun run test-beautyfort-lifecycle.ts
```

Tests complete order lifecycle with test credentials (no live API needed).

## Methods

### createOrder(orderType, yourReference?)
**Sends order to BeautyFort**
- Accepts: `"Wholesale"` or `"Direct Dispatch"`
- Returns: `{ orderReference, yourOrderReference, warnings }`
- **Order immediately appears in BeautyFort dashboard**

### getOrderDetail(orderRef?, yourRef?, includeItems?)
**Get real-time order status from BeautyFort**
- Returns: `{ orderReference, status, orderCostSummary, orderItems, parcels, warnings }`
- **Includes tracking info:**
  - `status`: "New", "Processing", "Dispatched", etc.
  - `parcels`: Array of packages with tracking codes & URLs
  - `orderItems`: Products in order
  - `orderCostSummary`: Subtotal, tax, shipping, total

### cancelOrder(orderRef?, yourRef?)
**Cancel order with fee handling**
- Returns: `{ success, cancellationFee, warnings }`
- Handles cancellation fees automatically
- Can't cancel if already dispatched

### getStockFile()
**Download product catalog from BeautyFort**
- Saves: `products.json`
- All products with prices, images, availability

## What You Can Do

✅ **Accept orders from ANY storefront** (WooCommerce, Shopify, custom, etc.)
✅ **Auto-route BeautyFort orders** to their system
✅ **Send orders to BeautyFort** with one line of code
✅ **Check real-time status** anytime - status updates as BeautyFort processes
✅ **Get tracking info** - courier name, tracking codes, delivery dates
✅ **Cancel orders** - with automatic fee handling
✅ **Download products** - sync product catalog from BeautyFort

## Features

✅ Backend-agnostic (any eCommerce platform)
✅ Type-safe TypeScript
✅ Test & live modes
✅ Production-ready
✅ Zero external dependencies
✅ Real-time vendor dashboard sync
✅ Full order tracking support
✅ Automatic order status updates

## File Structure

```
src/vendors/beautyfort/
├── Beautyfort.ts         # Main class
└── xml/xmlRequests.ts    # SOAP templates

src/configs/
└── beautyfortConfig.ts   # API credentials

test-beautyfort-lifecycle.ts  # Full lifecycle test
```

## How It Works

```
Your Storefront (any platform)
        ↓ Order placed
        ↓ Your system detects BeautyFort order
        ↓ Calls createOrder()
        ↓
BeautyFort Dashboard (order appears immediately)
        ↓ They process the order
        ↓ Status changes: New → Processing → Dispatched
        ↓ Tracking info added: Courier, Tracking Code, URL
        ↓
Your system calls getOrderDetail()
        ↓ Gets real-time status & tracking
        ↓ Display to customer: "Your order is dispatched with DPD"
```

## Important Rules

- **Create once:** Store the BeautyFort reference returned - use it for all future queries
- **Poll status:** Check every 5+ minutes (don't hammer API frequently)
- **Cancellation rules:**
  - Unplaced orders → can cancel
  - Placed Wholesale → cannot cancel
  - Placed Direct Dispatch → can cancel before dispatch (may have fees)
  - Dispatched orders → cannot cancel
- **Timing:** Nonce can't repeat within 5 minutes, timestamp within 5 min of their server

## Real-World Example

```typescript
// When customer places order in WooCommerce
async function onOrderCreated(wooOrder) {
  // If this order is for BeautyFort vendor
  if (wooOrder.vendor === "beautyfort") {
    const bf = new Beautyfort(config);
    
    // Send to BeautyFort
    const result = await bf.createOrder(
      "Direct Dispatch",
      `WC-${wooOrder.id}`
    );
    
    // Store their reference
    db.orders.update(wooOrder.id, {
      beautyfort_ref: result.orderReference,
      sync_date: new Date()
    });
    
    // Order now in BeautyFort dashboard
  }
}

// When customer checks order status
async function getOrderStatus(wooOrderId) {
  const order = db.orders.get(wooOrderId);
  const bf = new Beautyfort(config);
  
  const details = await bf.getOrderDetail(
    Number(order.beautyfort_ref)
  );
  
  return {
    status: details.status,           // "New", "Dispatched", etc.
    total: details.orderCostSummary?.total,
    items: details.orderItems,
    tracking: details.parcels         // Courier, tracking code, URL
  };
}
```

## Tracking Example Output

When order is dispatched by BeautyFort, `getOrderDetail()` returns:

```
status: "Dispatched"
parcels: [
  {
    boxNumber: "1",
    courierName: "DPD NL",
    trackingCode: "0516222933466",
    trackingURL: "https://tracking.dpd.nl/...",
    dateDispatched: "2024-08-19T12:30:00Z"
  }
]
```

Display to customer: "Order dispatched! Track with DPD: 0516222933466"

## Next: BTS Integration

Create `src/vendors/bts/BTSWholesaler.ts` following same pattern.

## Status

✅ **BeautyFort: TESTED & WORKING** with live API
- All 4 methods tested
- Orders successfully created (#646307, #646306, etc.)
- Status tracking working
- Tracking info ready

🚀 **BTS Wholesaler: PENDING**
- Need API documentation
- Then implement following BeautyFort pattern

## Support

- BeautyFort API: https://www.beautyfort.com/api/docs/
- WSDL: https://www.beautyfort.com/api/wsdl/v4/wsdl.wsdl