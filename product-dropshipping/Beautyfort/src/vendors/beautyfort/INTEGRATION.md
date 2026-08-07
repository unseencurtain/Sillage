# BeautyFort API — Integration Reference

## Auth (every request)
SHA1 hash → base64: `base64(sha1(nonce + createdAt + secret))`
Endpoint: `https://www.beautyfort.com/api/soap/v4`
TestMode `false` = live, `true` = test (must match credentials).

---

## Flows

### Create & Place a Direct Dispatch Order
1. **CreateOrder** → returns `OrderReference`
2. **AddOrderItem** (once per product) → uses `OrderReference`
3. **PlaceOrder** → needs `OrderReference` + invoice/delivery addresses + `DeliveryOption.ID`

```xml
<!-- 1. CreateOrder -->
<bf:CreateOrderRequest>
  <bf:TestMode>false</bf:TestMode>
  <bf:Type>Direct Dispatch</bf:Type>
  <bf:YourOrderReference>YOUR-REF-123</bf:YourOrderReference>
</bf:CreateOrderRequest>

<!-- 2. AddOrderItem -->
<bf:AddOrderItemRequest>
  <bf:TestMode>false</bf:TestMode>
  <bf:OrderReference>646323</bf:OrderReference>
  <bf:StockCode>P407231</bf:StockCode>
  <bf:Quantity>1</bf:Quantity>
</bf:AddOrderItemRequest>

<!-- 3. PlaceOrder -->
<bf:PlaceOrderRequest>
  <bf:TestMode>false</bf:TestMode>
  <bf:OrderReference>646323</bf:OrderReference>
  <bf:AttemptAutomaticPayment>false</bf:AttemptAutomaticPayment>
  <bf:InvoiceFirstName>Lovely Perfume</bf:InvoiceFirstName>
  <bf:InvoiceLastName>Store</bf:InvoiceLastName>
  <bf:InvoiceAddress>
    <bf:CompanyName>Lovely Perfume Store B.V.</bf:CompanyName>
    <bf:Address1>Industrieplein 1</bf:Address1>
    <bf:Town>Hengelo</bf:Town>
    <bf:Postcode>7553 LL</bf:Postcode>
    <bf:CountryCode>NL</bf:CountryCode>
  </bf:InvoiceAddress>
  <bf:DeliveryFirstName>Daniel</bf:DeliveryFirstName>
  <bf:DeliveryLastName>de Vries</bf:DeliveryLastName>
  <bf:DeliveryAddress>
    <bf:Address1>Herengracht 182</bf:Address1>
    <bf:Town>Amsterdam</bf:Town>
    <bf:Postcode>1016 BS</bf:Postcode>
    <bf:CountryCode>NL</bf:CountryCode>
  </bf:DeliveryAddress>
  <bf:DeliveryOption>
    <bf:ID>132</bf:ID> <!-- get IDs from GetAccountInformation -->
  </bf:DeliveryOption>
</bf:PlaceOrderRequest>
```

### Cancel an Order
```xml
<bf:CancelOrderRequest>
  <bf:TestMode>false</bf:TestMode>
  <bf:OrderReference>646323</bf:OrderReference>
  <!-- OR use YourOrderReference instead -->
</bf:CancelOrderRequest>
```

---

## Get Delivery Option IDs
Call **GetAccountInformation** once — response contains `DirectDispatchDeliveryOption` entries with `ID`, `Name`, `CountryCode`, `Price`.

```xml
<bf:GetAccountInformationRequest>
  <bf:TestMode>false</bf:TestMode>
</bf:GetAccountInformationRequest>
```

Known NL option: `ID 132` — Standardversand NL — £7.65

---

## Order Statuses
| Status | Meaning |
|---|---|
| Saved | Created, not yet placed |
| Payment Hold / Abandoned | Placed, awaiting payment |
| Processing | Paid, being picked/packed |
| Dispatched | Shipped — tracking available |
| Cancelled | Cancelled |

---

## Key Rules
- `YourOrderReference` must be **unique across test + live**.
- Order `Type` **cannot be changed** after creation.
- Items are added via `AddOrderItem`, **not** inside `CreateOrderRequest`.
- Shipping list & invoice tabs populate only **after dispatch**.
- `AttemptAutomaticPayment` only applies to Wholesale orders.

## Cancellation Fees
BeautyFort may apply a cancellation fee if the order has progressed past **Payment Hold** into **Aufgegeben** (Submitted/Processing). Cancel while the order is still in Payment Hold and there is no fee.

The fee is **not** always returned in the dedicated `<CancellationFee>` XML field — it can arrive as a `<Warning>` with code `5010` and a description such as `"Cancellation fee of 0.85 EUR applied"`. The `cancelOrder()` method handles both cases and surfaces the amount in `result.cancellationFee`.

---

## Code Entry Points (this repo)
| Action | File |
|---|---|
| Place an order (CLI) | `place-order.ts` |
| Cancel an order (CLI) | `cancel-order.ts` |
| Full lifecycle test | `test-lifecycle-real.ts` |
| Beautyfort class | `src/vendors/beautyfort/Beautyfort.ts` |
| XML builders | `src/vendors/beautyfort/xml/xmlRequests.ts` |
| Config (credentials) | `src/configs/beautyfortConfig.ts` |