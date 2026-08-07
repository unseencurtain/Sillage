import Beautyfort from "./src/vendors/beautyfort/Beautyfort";
import config from "./src/configs/beautyfortConfig";

// Simulated in-memory database for this test
const testDatabase: Record<string, any> = {};

/**
 * Test 1: Order is placed in the system
 * Simulates: Customer places order → Order stored in database
 */
async function testOrderPlacement() {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 1: ORDER PLACEMENT");
  console.log("════════════════════════════════════════════");

  const order = {
    id: "ORDER-" + Date.now(),
    customer: "John Doe",
    email: "john@example.com",
    items: [
      { sku: "J33455", name: "Jasper Conran Naked Man 40ml", quantity: 1 },
    ],
    total: 30.73,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  testDatabase[order.id] = order;

  console.log(`✓ Order created in system`);
  console.log(`  Order ID: ${order.id}`);
  console.log(`  Customer: ${order.customer}`);
  console.log(`  Status: ${order.status}`);
  console.log(`  Total: €${order.total}`);

  return order;
}

/**
 * Test 2: Order is synced to BeautyFort
 * Simulates: Code calls createOrder() → Order appears in BeautyFort dashboard
 */
async function testSyncOrderToBeautyFort(order: any) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 2: SYNC TO BEAUTYFORT");
  console.log("════════════════════════════════════════════");

  try {
    const beautyfort = new Beautyfort(config);

    console.log(`→ Calling beautyfort.createOrder()...`);
    const result = await beautyfort.createOrder("Wholesale", order.id);

    console.log(`✓ Order successfully synced to BeautyFort!`);
    console.log(`  BeautyFort Reference: ${result.orderReference}`);
    console.log(`  Your Reference: ${result.yourOrderReference}`);

    if (result.warnings.length > 0) {
      console.log(`  ⚠ Warnings:`, result.warnings);
    }

    // Store BeautyFort reference in our database
    testDatabase[order.id].beautyfort_ref = result.orderReference;
    testDatabase[order.id].sync_status = "synced";
    testDatabase[order.id].sync_date = new Date().toISOString();

    console.log(`✓ BeautyFort reference stored in local database`);
    console.log(`  Order now visible in BeautyFort dashboard`);

    return result;
  } catch (error: any) {
    console.error(`✗ SYNC FAILED: ${error.message}`);
    testDatabase[order.id].sync_status = "failed";
    testDatabase[order.id].sync_error = error.message;
    throw error;
  }
}

/**
 * Test 3: Check order status in BeautyFort
 * Simulates: Customer/Admin requests order status → Pull from BeautyFort
 */
async function testGetOrderStatus(orderId: string) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 3: CHECK ORDER STATUS");
  console.log("════════════════════════════════════════════");

  try {
    const localOrder = testDatabase[orderId];

    if (!localOrder.beautyfort_ref) {
      throw new Error("Order not synced to BeautyFort yet");
    }

    const beautyfort = new Beautyfort(config);

    console.log(`→ Fetching order details from BeautyFort...`);
    const details = await beautyfort.getOrderDetail(
      Number(localOrder.beautyfort_ref),
      undefined,
      true, // include items
    );

    console.log(`✓ Order details retrieved from BeautyFort`);
    console.log(`  BeautyFort Order: ${details.orderReference}`);
    console.log(`  Status: ${details.status}`);

    if (details.orderCostSummary) {
      console.log(`  Cost Breakdown:`);
      console.log(`    Subtotal: €${details.orderCostSummary.subtotal}`);
      console.log(`    Tax: €${details.orderCostSummary.tax}`);
      console.log(`    Shipping: €${details.orderCostSummary.shipping}`);
      console.log(`    Total: €${details.orderCostSummary.total}`);
    }

    if (details.orderItems && details.orderItems.length > 0) {
      console.log(`  Items:`);
      details.orderItems.forEach((item, idx) => {
        console.log(
          `    ${idx + 1}. ${item.stockCode} - Qty: ${item.quantity} @ €${item.price}`,
        );
      });
    }

    // Update local database with status
    testDatabase[orderId].beautyfort_status = details.status;
    testDatabase[orderId].beautyfort_last_check = new Date().toISOString();

    return details;
  } catch (error: any) {
    console.error(`✗ STATUS CHECK FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Test 4: Order gets dispatched in BeautyFort
 * Simulates: BeautyFort processes and ships order
 * Note: In real scenario, order status would change in BeautyFort's system
 */
async function testOrderDispatched(orderId: string) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 4: ORDER DISPATCHED (Simulated)");
  console.log("════════════════════════════════════════════");

  console.log(`→ In real scenario, BeautyFort would process the order`);
  console.log(`  Order status would change to 'Dispatched' in BeautyFort`);
  console.log(`  Tracking information would become available`);

  // Simulate checking status after some time
  console.log(`\n→ Checking updated status from BeautyFort...`);

  try {
    const localOrder = testDatabase[orderId];
    const beautyfort = new Beautyfort(config);

    const details = await beautyfort.getOrderDetail(
      Number(localOrder.beautyfort_ref),
      undefined,
      false,
    );

    console.log(`✓ Updated order status: ${details.status}`);

    testDatabase[orderId].beautyfort_status = details.status;

    if (details.status === "Dispatched") {
      console.log(`✓ Order has been dispatched!`);
      console.log(`  Tracking information available in BeautyFort dashboard`);
      testDatabase[orderId].status = "dispatched";
    }

    return details;
  } catch (error: any) {
    console.error(`✗ STATUS UPDATE FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Test 5: Customer cancels order (if still allowed)
 * Simulates: Customer requests cancellation → Cancel in BeautyFort
 */
async function testCancelOrder(orderId: string) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 5: CANCEL ORDER");
  console.log("════════════════════════════════════════════");

  try {
    const localOrder = testDatabase[orderId];

    if (!localOrder.beautyfort_ref) {
      throw new Error("Order not synced to BeautyFort");
    }

    const beautyfort = new Beautyfort(config);

    console.log(`→ Requesting order cancellation...`);
    const result = await beautyfort.cancelOrder(
      Number(localOrder.beautyfort_ref),
      undefined,
    );

    if (result.success) {
      console.log(`✓ Order successfully cancelled!`);

      if (result.cancellationFee) {
        console.log(`  ⚠ Cancellation Fee Applied: €${result.cancellationFee}`);
        const refundAmount =
          localOrder.total - parseFloat(result.cancellationFee);
        console.log(`  Original Total: €${localOrder.total}`);
        console.log(`  Refund Amount: €${refundAmount}`);
      } else {
        console.log(`  Full refund: €${localOrder.total}`);
      }

      testDatabase[orderId].status = "cancelled";
      testDatabase[orderId].beautyfort_status = "Cancelled";
      testDatabase[orderId].cancellation_fee = result.cancellationFee || null;
    } else {
      console.log(`✗ Cancellation was not successful`);
      console.log(`  Reason: Order may already be dispatched or processed`);
    }

    if (result.warnings.length > 0) {
      console.log(`  ⚠ Warnings:`, result.warnings);
    }

    return result;
  } catch (error: any) {
    console.error(`✗ CANCELLATION FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Test 6: Order completion
 * Simulates: Order is delivered → Customer confirms receipt
 */
async function testOrderCompletion(orderId: string) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 6: ORDER COMPLETION");
  console.log("════════════════════════════════════════════");

  try {
    const localOrder = testDatabase[orderId];

    if (localOrder.status === "cancelled") {
      console.log(`ℹ Order was cancelled, skipping completion`);
      return;
    }

    const beautyfort = new Beautyfort(config);

    console.log(`→ Checking final order status...`);
    const details = await beautyfort.getOrderDetail(
      Number(localOrder.beautyfort_ref),
      undefined,
      false,
    );

    console.log(`✓ Final Order Status: ${details.status}`);

    testDatabase[orderId].status = "completed";
    testDatabase[orderId].completed_at = new Date().toISOString();

    if (details.status === "Dispatched") {
      console.log(`✓ Order has been dispatched and delivered`);
      console.log(`  Check BeautyFort dashboard for tracking details`);
    }

    return details;
  } catch (error: any) {
    console.error(`✗ COMPLETION CHECK FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Test 7: View full order lifecycle in local database
 */
function testViewOrderLifecycle(orderId: string) {
  console.log("\n════════════════════════════════════════════");
  console.log("TEST 7: FULL ORDER LIFECYCLE");
  console.log("════════════════════════════════════════════");

  const order = testDatabase[orderId];

  console.log(`Order ID: ${order.id}`);
  console.log(`Customer: ${order.customer}`);
  console.log(`Email: ${order.email}`);
  console.log(`Total: €${order.total}`);
  console.log(`\nOrder Lifecycle:`);
  console.log(`  Created At: ${order.createdAt}`);
  console.log(`  System Status: ${order.status}`);
  console.log(`  Sync Status: ${order.sync_status || "not_synced"}`);

  if (order.beautyfort_ref) {
    console.log(`  BeautyFort Reference: ${order.beautyfort_ref}`);
    console.log(`  BeautyFort Status: ${order.beautyfort_status || "unknown"}`);
    console.log(`  Synced At: ${order.sync_date}`);
    console.log(
      `  Last Checked: ${order.beautyfort_last_check || "not_checked"}`,
    );
  }

  if (order.cancellation_fee) {
    console.log(`  Cancellation Fee: €${order.cancellation_fee}`);
  }

  if (order.completed_at) {
    console.log(`  Completed At: ${order.completed_at}`);
  }

  if (order.sync_error) {
    console.log(`  Sync Error: ${order.sync_error}`);
  }

  console.log(`\nOrder Items:`);
  order.items.forEach((item: any) => {
    console.log(`  - ${item.name} (${item.sku}): ${item.quantity} unit(s)`);
  });
}

/**
 * Main test runner - complete order lifecycle
 */
async function runCompleteLifecycleTest() {
  console.log("\n\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  BEAUTYFORT INTEGRATION - COMPLETE ORDER LIFECYCLE TEST    ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  try {
    // Test 1: Order is placed
    const order = await testOrderPlacement();

    // Test 2: Order is synced to BeautyFort
    const syncResult = await testSyncOrderToBeautyFort(order);

    // Small delay to simulate time passing
    console.log(`\n⏳ Waiting 2 seconds...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Test 3: Check order status
    const statusResult = await testGetOrderStatus(order.id);

    // Small delay
    console.log(`\n⏳ Waiting 2 seconds...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Test 4: Order gets dispatched (simulated)
    const dispatchedResult = await testOrderDispatched(order.id);

    // Test 5: (Optional) Cancel order or Test 6: Complete order
    // For this test, let's show both scenarios are possible

    console.log("\n════════════════════════════════════════════");
    console.log("SCENARIO A: Order Completes Successfully");
    console.log("════════════════════════════════════════════");
    const completionResult = await testOrderCompletion(order.id);

    // Test 7: View complete lifecycle
    testViewOrderLifecycle(order.id);

    console.log("\n\n════════════════════════════════════════════");
    console.log("✅ ALL TESTS PASSED");
    console.log("════════════════════════════════════════════");
    console.log(`\nSummary:`);
    console.log(`  ✓ Order created in system`);
    console.log(`  ✓ Order synced to BeautyFort (appears in their dashboard)`);
    console.log(`  ✓ Order status retrieved from BeautyFort`);
    console.log(`  ✓ Order tracking/dispatch simulated`);
    console.log(`  ✓ Order completion tracked`);
    console.log(`  ✓ Full lifecycle logged and stored`);
    console.log(`\nNote: In a real scenario with a live BeautyFort account,`);
    console.log(`      the order would actually appear in their dashboard`);
    console.log(`      and you could see real tracking information.`);
  } catch (error: any) {
    console.error("\n\n❌ TEST FAILED");
    console.error(`Error: ${error.message}`);
    console.error(
      "\nNote: If using test credentials, some API calls may fail.",
    );
    console.error(
      "Switch to live credentials to test with real BeautyFort account.",
    );
  }
}

/**
 * Alternative test: Cancellation scenario
 */
async function runCancellationScenarioTest() {
  console.log("\n\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  BEAUTYFORT INTEGRATION - CANCELLATION SCENARIO TEST       ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  try {
    // Test 1: Order is placed
    const order = await testOrderPlacement();

    // Test 2: Order is synced to BeautyFort
    const syncResult = await testSyncOrderToBeautyFort(order);

    // Test 3: Check order status
    const statusResult = await testGetOrderStatus(order.id);

    console.log("\n════════════════════════════════════════════");
    console.log("SCENARIO B: Customer Cancels Order");
    console.log("════════════════════════════════════════════");

    // Test 5: Cancel order
    const cancelResult = await testCancelOrder(order.id);

    // Test 7: View complete lifecycle with cancellation
    testViewOrderLifecycle(order.id);

    console.log("\n✅ CANCELLATION TEST COMPLETED");
  } catch (error: any) {
    console.error("\n❌ CANCELLATION TEST FAILED");
    console.error(`Error: ${error.message}`);
  }
}

// Run the main lifecycle test
runCompleteLifecycleTest().catch(console.error);

// Uncomment to run cancellation scenario instead:
// runCancellationScenarioTest().catch(console.error);
