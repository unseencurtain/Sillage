Credentinas

```
info@lovely-perfume-store.com

Lovelyperfume123@!
```





# Product Feed

#### [ **Download Integration Documentation** ](https://www.btswholesaler.com/en/area/downloaddoc)

####  **Integration via URL**

To create the URL, you will require your account ID **(753252)** and your password.
Below is an example of a URL where ***my_user_id\*** is the account ID, ***my_pass\*** is the password and ***format_feed\*** is the feed format. If required, you can choose the language in which you wish the feed to be downloaded: ***my_language\***. If nothing is selected, the feed will download in the default language: English.

**https://www.btswholesaler.com/generatefeedbts?user_id=\*753252\*&pass=\*my_pass\*&format=\*format_feed\*&language_code=\*my_language\***

The available formats are as follows:

**JSON** | **XML** | **CSV**

The available languages are as follows:

**en-US** | **en-GB** | **fr-FR**| **it-IT**| **es-ES**| **de-DE**

####  **PHP Integration**

To be able to make the request, you will need your account ID **(753252)** and your password.
You have three format options:

**JSON** | **XML** | **CSV**

With regards to languages, there are 6 options available:

**en-US** | **en-GB** | **fr-FR**| **it-IT**| **es-ES**| **de-DE**

Connect your e-commerce or marketplace with **BTSWholesaler** automatically. Our REST API allows you to synchronize products, prices, stock and manage orders in real time with exceptional speed and stability.

What does our API?

1. #### Extreme Speed

   Responses in milliseconds. Complete catalog of +48,000 products synchronized in less than 2 minutes.

2. #### Delta Synchronization

   Only download changes since your last query. Save bandwidth and time with incremental updates.

3. #### Real-Time Stock

   Check the updated stock of any product instantly. No delays, no surprises.

4. #### JWT Security

   Authentication via JWT tokens with state-of-the-art encryption. Your data always protected.

5. ####  Multi-language

   Product data available in 5 languages: Spanish, English, German, French and Italian.

6. ####  Order Management

   Create orders automatically, check statuses and manage your dropshipping logistics without manual intervention.

```
<?php 
        $user_id = "user_id";
        $pass = "password";
        $language_code = "es-ES"; /* en-US | en-GB | fr-FR| it-IT| es-ES| de-DE */
        /*----------  Products Feed  ----------*/
        $url = "https://www.btswholesaler.com/generatefeedbts";
        /*----------  Categories Feed  ----------*/
        //$url = "https://www.btswholesaler.com/generatefeedcategoriesbts";
        $data = array("format"=>"xml", "user_id"=>$user_id, "pass"=>$pass, "language_code"=>$language_code);
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "POST");
        curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array(
            "Content-Type: application/x-www-form-urlencoded"));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        $data = curl_exec($ch);
        curl_close($ch); 
    ?>
```



Example of Integration

```
// URL proporcionada en tu panel de cliente
const API_ENDPOINT = yourApiEndpoint;

const getProducts = async () => {
    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwtToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({page: 1, limit: 500, lang: 'es'})
    });
    
    const products = await response.json();
    products.data.forEach(p => console.log(`${p.sku} - ${p.name}`));
};

getProducts();
```

Functions Available
```
POST getListProducts
Complete catalog with pagination. Up to 500 products per page.

POST getProductChanges
Only products modified since the last synchronization.

POST getProductStock
Real-time stock and prices for specific products.

POST getNewProducts
Products recently added to the catalog.

GET getFeedStatus
Catalog status: total products, last update.

POST createOrder
Create dropshipping orders automatically.

GET
getOrderStatus
Check the status and tracking of your orders.

POST
getShippingRates
Calculate shipping costs based on destination and weight.
```

```
 What's new in v2.1:
Server-side filtering in getListProducts with category_ids and manufacturer_names parameters
Faster sync — only matching products are returned, reducing bandwidth and processing time
 What's new in v2.0:
Mandatory pagination in getListProducts for better stability
New endpoint getFeedStatus to check catalog status
New endpoint getProductChanges for delta synchronization
New endpoint getProductStock for real-time stock checks
New endpoint getNewProducts for recently added products
Security limits: 3-minute timeout and max 500 products per page
Pagination metadata included in responses

```

##  1. Authentication

```
All API requests require JWT authentication via Bearer token in the HTTP header:

Authorization: Bearer your_jwt_token_here
To obtain your token:

Access your BTSWholesaler account
Go to the API section
Click "Create Account Service"
Copy the generated JWT token
 Important: Keep your token secure. If compromised, revoke it immediately and generate a new one.
```

## 2. Available Endpoints

| Method | Endpoint                    | Description                          |
| ------ | --------------------------- | ------------------------------------ |
| GET    | `/v1/api/getProducts`       | Get products by SKU (max 25)         |
| GET    | `/v1/api/getListProducts`   | Get full catalog (paginated)         |
| GET    | `/v1/api/getFeedStatus`     | Check feed status                    |
| GET    | `/v1/api/getProductChanges` | Get changed products (delta sync)    |
| GET    | `/v1/api/getProductStock`   | Real-time stock check (max 100 SKUs) |
| GET    | `/v1/api/getNewProducts`    | Recently added products              |
| GET    | `/v1/api/getListCategories` | Get category tree                    |
| GET    | `/v1/api/getShippingPrices` | Calculate shipping costs             |
| POST   | `/v1/api/setCreateOrder`    | Create new order                     |
| GET    | `/v1/api/getOrder`          | Get order details                    |
| GET    | `/v1/api/getTrackings`      | Get tracking numbers                 |
| GET    | `/v1/api/getCountries`      | List available countries             |

## 3. Product Functions

### 3.1 getListProducts UPDATED v2.0

## GET `/v1/api/getListProducts`

Returns the complete product catalog with **mandatory pagination**.

### Parameters

| Parameter            | Type    | Required | Default  | Description                                                  |
| -------------------- | ------- | -------- | -------- | ------------------------------------------------------------ |
| `page`               | Integer | No       | 1        | Page number (1+)                                             |
| `page_size`          | Integer | No       | 200      | Products per page (50-500)                                   |
| `format_file`        | String  | No       | json     | Output format: json, xml, csv                                |
| `language_code`      | String  | No       | Client's | es-ES, en-US, fr-FR, it-IT, de-DE                            |
| `category_ids`       | String  | No       | -        | Comma-separated category IDs to filter (e.g. "12,45,78"). Only products in these categories are returned. |
| `manufacturer_names` | String  | No       | -        | Comma-separated brand names to filter (e.g. "ADIDAS,CHANEL"). Only products from these manufacturers are returned. |

> **🔽 Server-side filtering (v2.1):**
> Use `category_ids` and/or `manufacturer_names` to filter products at the server level. This is much more efficient than downloading the entire catalog and filtering client-side, especially for stores that only sell specific brands or categories.

```
GET /v1/api/getListProducts?page=1&page_size=200&manufacturer_names=ADIDAS,CHANEL&category_ids=12,45
```

#### Response Example (JSON)

```
{
  "pagination": {
    "current_page": 1,
    "page_size": 200,
    "total_products": 15420,
    "total_pages": 78,
    "has_next_page": true,
    "has_previous_page": false
  },
  "products": [
    {
      "id": 12345,
      "ean": "8411061123456",
      "categories": "1/15/234",
      "manufacturer": "Carolina Herrera",
      "name": "Good Girl EDP 80ml",
      "description": "Feminine fragrance...",
      "recommended_price": 120.00,
      "price": 65.99,
      "stock": 150,
      "image": "https://cdn.btswholesaler.com/images/product.jpg",
      "delivery": 24,
      "gender": "female"
    }
  ]
}
```

### 3.2 getProducts

**GET** `/v1/api/getProducts?product_sku[0]=SKU1&product_sku[1]=SKU2`

Get specific products by SKU. Maximum 25 products per request.

## 3.3 getFeedStatus `NEW v2.0`

### GET `/v1/api/getFeedStatus`

Check the status of the product feed. Useful for monitoring and knowing if there's a cached feed available.

### Parameters

| Parameter       | Type   | Required | Default           | Description                       |
| --------------- | ------ | -------- | ----------------- | --------------------------------- |
| `language_code` | String | No       | Client's language | es-ES, en-US, fr-FR, it-IT, de-DE |

#### Response Example

```
{
  "status": "use_pagination",
  "message": "Use getlistproducts with pagination parameters (page, page_size) to fetch products.",
  "recommended_page_size": 200,
  "cached_file_exists": true,
  "cached_file_age_minutes": 45
}
```

### Response Fields

| Field                     | Type          | Description                                                  |
| ------------------------- | ------------- | ------------------------------------------------------------ |
| `status`                  | String        | Feed status: "use_pagination", "available", "stale", "not_available" |
| `message`                 | String        | Human-readable status message                                |
| `recommended_page_size`   | Integer       | Recommended page size for pagination (200)                   |
| `cached_file_exists`      | Boolean       | Whether a cached feed file exists                            |
| `cached_file_age_minutes` | Integer\|null | Age of cached file in minutes, null if not exists            |

### Use Cases

- **Check before sync:** Call this endpoint before starting a full catalog sync to know the current state
- **Monitor cache:** Use to monitor if the cached feed is fresh or stale
- **Debugging:** Helpful for troubleshooting feed-related issues

### Example Request

```bash
curl -X GET 'https://api.btswholesaler.com/v1/api/getFeedStatus?language_code=en-US' \
  -H "Authorization: Bearer your_jwt_token"
```



## 3.4 getProductChanges `NEW v2.0`

### GET `/v1/api/getProductChanges`

Get products that have been modified since a specific date. **Ideal for delta synchronization** - only sync products that have changed instead of the full catalog.

### Parameters

| Parameter       | Type    | Required | Default           | Description                                                  |
| --------------- | ------- | -------- | ----------------- | ------------------------------------------------------------ |
| `since`         | String  | Yes      | -                 | Date from which to check changes (Y-m-d or Y-m-d H:i:s). Max 30 days back. |
| `language_code` | String  | No       | Client's language | es-ES, en-US, fr-FR, it-IT, de-DE                            |
| `page`          | Integer | No       | 1                 | Page number                                                  |
| `page_size`     | Integer | No       | 200               | Products per page (50-500)                                   |

#### Response Example

```
{
  "query": {
    "since": "2025-11-20 00:00:00",
    "language_code": "en-US"
  },
  "pagination": {
    "current_page": 1,
    "page_size": 200,
    "total_products": 45,
    "total_pages": 1,
    "has_next_page": false,
    "has_previous_page": false
  },
  "products": [
    {
      "id": 12345,
      "product_sku": "SKU123456",
      "last_modified": "2025-11-25 14:30:00",
      "product_price": 45.99,
      "product_stock": 150,
      "recommended_price": 89.99
    }
  ]
}
```

#### Use Cases

- **Delta sync:** Run daily to get only changed products instead of full catalog
- **Price monitoring:** Track price changes in your inventory
- **Stock alerts:** Detect stock level changes

#### Example Request

```
curl -X GET "https://api.btswholesaler.com/v1/api/getProductChanges?since=2025-11-20&page_size=200" \
  -H "Authorization: Bearer your_jwt_token"
```

## 3.5 getProductStock `NEW v2.0`

### GET `/v1/api/getProductStock`

Get real-time stock and price information for specific products. **Lightweight endpoint** optimized for quick stock checks before placing orders.

### Parameters

| Parameter       | Type  | Required | Description                                      |
| --------------- | ----- | -------- | ------------------------------------------------ |
| `product_sku[]` | Array | Yes      | Array of SKUs to check. Maximum 100 per request. |

### Response Example

```
{
  "requested_skus": 3,
  "found_skus": 2,
  "timestamp": "2025-11-28 10:30:00",
  "products": {
    "SKU123456": {
      "stock": 150,
      "price": 45.99,
      "availability": "in_stock",
      "last_updated": "2025-11-28 09:15:00"
    },
    "SKU789012": {
      "stock": 0,
      "price": 29.99,
      "availability": "out_of_stock",
      "last_updated": "2025-11-27 18:00:00"
    },
    "INVALID_SKU": {
      "stock": 0,
      "price": null,
      "availability": "not_found",
      "last_updated": null
    }
  }
}
```



### Availability Values

| Value          | Description                   |
| -------------- | ----------------------------- |
| `in_stock`     | Product available (stock > 0) |
| `out_of_stock` | Product exists but no stock   |
| `not_found`    | SKU not found in catalog      |

### Use Cases

- **Pre-order validation:** Check stock before creating an order
- **Real-time inventory:** Update your e-commerce stock levels
- **Cart validation:** Verify availability when customer adds to cart

### Example Request

```bash
curl -X GET "https://api.btswholesaler.com/v1/api/getProductStock?product_sku[]=SKU123&product_sku[]=SKU456" \
  -H "Authorization: Bearer your_jwt_token"
```

## 3.6 getNewProducts `NEW v2.0`

### GET `/v1/api/getNewProducts`

Get products recently added to the catalog. **Perfect for featuring new arrivals** on your website or sending newsletters.

### Parameters

| Parameter       | Type    | Required | Default           | Description                          |
| --------------- | ------- | -------- | ----------------- | ------------------------------------ |
| `days`          | Integer | No       | 7                 | Number of days back to search (1-30) |
| `language_code` | String  | No       | Client's language | es-ES, en-US, fr-FR, it-IT, de-DE    |
| `page`          | Integer | No       | 1                 | Page number                          |
| `page_size`     | Integer | No       | 200               | Products per page (50-500)           |

#### Response Example

```
{
  "query": {
    "days": 7,
    "since": "2025-11-21 00:00:00",
    "language_code": "en-US"
  },
  "pagination": {
    "current_page": 1,
    "page_size": 200,
    "total_products": 85,
    "total_pages": 1,
    "has_next_page": false,
    "has_previous_page": false
  },
  "products": [
    {
      "id": 12345,
      "product_sku": "SKU123456",
      "published_date": "2025-11-25 10:00:00",
      "product_name": "Good Girl EDP 80ml",
      "manufacturer_name": "Carolina Herrera",
      "product_price": 65.99,
      "product_stock": 200,
      "recommended_price": 125.00
    }
  ]
}
```

#### Use Cases

- **New arrivals section:** Feature latest products on your website
- **Newsletter content:** Automatically include new products in emails
- **Catalog updates:** Keep your catalog fresh with new additions

#### Example Request

```
curl -X GET "https://api.btswholesaler.com/v1/api/getNewProducts?days=14&page_size=100" \
  -H "Authorization: Bearer your_jwt_token"
```



## 4. Order Functions

### 4.1 setCreateOrder

#### POST `/v1/api/setCreateOrder`

Create a new order. Body must be `application/x-www-form-urlencoded`.

#### Parameters

| Parameter               | Type    | Required    | Description                                                  |
| ----------------------- | ------- | ----------- | ------------------------------------------------------------ |
| `payment_method`        | String  | Yes         | wallet, banktransfer, btscredit                              |
| `products[i][sku]`      | String  | Yes         | Product SKU                                                  |
| `products[i][quantity]` | Integer | Yes         | Quantity                                                     |
| `shipping_cost_id`      | Integer | Yes         | From getShippingPrices                                       |
| `client_name`           | String  | Yes         | Customer name                                                |
| `address`               | String  | Yes*        | Delivery address                                             |
| `postal_code`           | String  | Yes*        | Postal code                                                  |
| `city`                  | String  | Yes*        | City                                                         |
| `country_code`          | String  | Yes*        | Destination country code (ISO 3166-1 alpha-2: ES, FR, DE, IT, PT, etc.). Must match the country used in `getShippingPrices`. |
| `telephone`             | String  | Yes         | Phone number                                                 |
| `dropshipping`          | Integer | No          | 0=No, 1=Yes                                                  |
| `state_code`            | String  | Conditional | Required only for US and CA orders (e.g. NY, CA, QC)         |

> **Note:** Not required if shipping method is Mondial Relay

#### Important

⚠️ **Important:** The `country_code` parameter is required and must match the country used when calling `getShippingPrices`. The `shipping_cost_id` is tied to a specific country and postal code combination.

#### Response Example

```json
{
  "order_number": "74379925696l",
  "order_total": "89.50",
  "order_status": "Paid",
  "expected_dispatch_date": "2026-02-20 10:00:00",
  "expected_dispatch_date_2": "2026-02-21 10:00:00",
  "expected_delivery_date": "2026-02-22 10:00:00",
  "expected_delivery_date_2": "2026-02-24 10:00:00"
}
```

#### Is there a test / sandbox mode?

⚠️ Currently the API **does not have a test or sandbox mode**. All orders sent to `setCreateOrder` are real and processed normally.

**Recommendations for integration testing:**

- Use `payment_method: banktransfer` to create orders that stay in **Pending Payment** status and are not automatically charged. These orders can be cancelled by your account manager.
- Test first with GET endpoints (`getListProducts`, `getShippingPrices`, `getCountries`) to validate your integration at no cost.
- Verify order data with `getOrder` after each creation.

#### Practical Example: Complete order creation flow

```
# STEP 1: Get available shipping methods
curl -X GET "https://api.btswholesaler.com/v1/api/getShippingPrices?\
address[country_code]=ES&address[postal_code]=28001&\
products[0][sku]=8411061123456&products[0][quantity]=2" \
  -H "Authorization: Bearer your_jwt_token"

# Response: shipping_cost_id = 145 (SEUR, €7.50)

# STEP 2: Create the order with customer data
curl -X POST "https://api.btswholesaler.com/v1/api/setCreateOrder" \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "payment_method=wallet\
&products[0][sku]=8411061123456\
&products[0][quantity]=2\
&shipping_cost_id=145\
&client_name=John Smith\
&address=15 High Street, Apt 2B\
&postal_code=28001\
&city=Madrid\
&country_code=ES\
&telephone=+34600123456\
&dropshipping=1"

# Response: order_number = 743799256961

# STEP 3: Verify the created order
curl -X GET "https://api.btswholesaler.com/v1/api/getOrder?order_number=743799256961" \
  -H "Authorization: Bearer your_jwt_token"

# STEP 4: Check tracking (after 24-72h)
curl -X GET "https://api.btswholesaler.com/v1/api/getTrackings?order_number[0]=743799256961" \
  -H "Authorization: Bearer your_jwt_token"
```

### 4.2 getOrder

#### GET `/v1/api/getOrder`

Get complete order details, including status, tracking, shipping address and products.

#### Parameters

| Parameter      | Type   | Required | Description                  |
| -------------- | ------ | -------- | ---------------------------- |
| `order_number` | String | Yes      | BTS order number (12 digits) |

#### Response Example

```
{
  "order_number": "743799256961",
  "order_status": "Shipped",
  "tracking": "GLS-9876543210",
  "order_total": "89.50",
  "client_name": "John Smith",
  "client_email": "john@myshop.com",
  "address": "15 High Street, Apt 2B",
  "postal_code": "28001",
  "city": "Madrid",
  "state_code": null,
  "country_code": "ES",
  "shipping_company": "SEUR",
  "shipping_cost": "5.99",
  "telephone": "+34600123456",
  "comments": "Leave at reception",
  "expected_delivery_date": "2026-02-22",
  "expected_delivery_date_2": "2026-02-24",
  "expected_dispatch_date": "2026-02-20",
  "expected_dispatch_date_2": null,
  "dropshipping": 1,
  "entry_date": "2026-02-19 14:30:00",
  "products": [
    {
      "product_sku": "8411061123456",
      "product_name": "Good Girl EDP 80ml",
      "quantity": 1,
      "unit_price": "65.99"
    }
  ]
}
```

#### Practical Example: Check order status

```
# Check if an order already has tracking
curl -X GET "https://api.btswholesaler.com/v1/api/getOrder?order_number=743799256961" \
  -H "Authorization: Bearer your_jwt_token"

# If order_status = "Shipped" and tracking is not empty,
# the order has been dispatched and you can update your shop.
```



### 4.3 getTrackings

#### GET `/v1/api/getTrackings`

Get tracking numbers for one or multiple orders at once. **Ideal for bulk tracking queries.**

#### Parameters

| Parameter        | Type  | Required | Description                |
| ---------------- | ----- | -------- | -------------------------- |
| `order_number[]` | Array | Yes      | Array of BTS order numbers |

#### Response Example

```json
[
  {
    "order_number": "743799256961",
    "tracking": "GLS-9876543210"
  },
  {
    "order_number": "743799256962",
    "tracking": "SEUR-1234567890"
  }
]
```

#### When is tracking available?

ℹ️ The tracking number is assigned **after the carrier picks up the package**. This typically happens between 24 and 72 hours after creating the order, depending on stock and destination.

**Recommendation:** Poll this endpoint periodically (every 2-4 hours) for orders pending tracking. If an order doesn't have tracking yet, you'll receive an `order_not_found` error.

#### Practical Example: Automatic tracking synchronization

```
# Query tracking for multiple orders at once
curl -X GET "https://api.btswholesaler.com/v1/api/getTrackings?order_number[0]=743799256961&order_number[1]=743799256962" \
  -H "Authorization: Bearer your_jwt_token"

# Recommended workflow for your shop:
# 1. Save order_numbers from orders created with setCreateOrder
# 2. Every 2-4 hours, query getTrackings with pending orders
# 3. When you receive a tracking, update the order in your shop
# 4. Send email to the customer with the tracking number
```



## 5. Shipping Functions

### 5.1 getShippingPrices

#### GET `/v1/api/getShippingPrices`

Calculate available shipping methods and costs for a given address and products.

#### Parameters

| Parameter               | Type    | Required | Description                                               |
| ----------------------- | ------- | -------- | --------------------------------------------------------- |
| `address[country_code]` | String  | Yes      | ISO 3166-1 alpha-2 country code (e.g. ES, FR, DE, AT, IT) |
| `address[postal_code]`  | String  | Yes      | Destination postal code                                   |
| `products[0][sku]`      | String  | Yes      | Product SKU/EAN                                           |
| `products[0][quantity]` | Integer | Yes      | Product quantity                                          |

#### Response Example

```
[
  {
    "id": 145,
    "delivery_time": 3,
    "company_name": "SEUR",
    "shipping_cost": 7.50,
    "free_shipping": 150.00
  },
  {
    "id": 148,
    "delivery_time": 5,
    "company_name": "GLS",
    "shipping_cost": 5.99,
    "free_shipping": 200.00
  }
]
```

#### Response Fields

| Field           | Type    | Description                                                  |
| --------------- | ------- | ------------------------------------------------------------ |
| `id`            | Integer | Shipping method ID. **Use this value as `shipping_cost_id` when creating an order.** |
| `delivery_time` | Integer | Estimated delivery time in business days                     |
| `company_name`  | String  | Carrier name (SEUR, GLS, FedEx, etc.)                        |
| `shipping_cost` | Decimal | Shipping cost in EUR                                         |
| `free_shipping` | Decimal | Minimum order amount for free shipping. If the order subtotal exceeds this value, shipping is free. |

#### How are shipping costs calculated?

📦 Shipping costs are determined by:

- **Destination country:** Determines available carriers and base rates
- **Postal code:** Regional pricing zones
- **Weight/volume:** Automatically calculated based on the order's products
- **Order amount:** If subtotal exceeds the `free_shipping` threshold, shipping is free
- **Product type:** Flammable products (perfumes) may have restrictions with some carriers

#### Practical Example: Calculate shipping to Austria

```
# Calculate shipping for 2 units of a product to Vienna, Austria
curl -X GET "https://api.btswholesaler.com/v1/api/getShippingPrices?\
address[country_code]=AT&address[postal_code]=1010&\
products[0][sku]=8411061123456&products[0][quantity]=2" \
  -H "Authorization: Bearer your_jwt_token"

# The response will give you the available carriers for Austria.
# Use the "id" field as shipping_cost_id when creating the order.
# If your order exceeds "free_shipping", the cost will be 0.
```



### 5.2 getCountries

**GET** `/v1/api/getCountries`

Returns the list of countries to which BTSWholesaler can ship.

#### Parameters

No parameters required.

#### Response Example

```
[
  {"country_code": "ES", "country_name": "Spain"},
  {"country_code": "FR", "country_name": "France"},
  {"country_code": "DE", "country_name": "Germany"},
  {"country_code": "IT", "country_name": "Italy"},
  {"country_code": "PT", "country_name": "Portugal"},
  {"country_code": "AT", "country_name": "Austria"},
  {"country_code": "BE", "country_name": "Belgium"},
  {"country_code": "NL", "country_name": "Netherlands"}
]
```

#### Practical Example: Verify shipping to a country

```
# Get the complete list of available countries
curl -X GET "https://api.btswholesaler.com/v1/api/getCountries" \
  -H "Authorization: Bearer your_jwt_token"

# Use this list to show only the countries we can ship to in your store.
```



### 5.3 getListCategories

#### GET `/v1/api/getListCategories`

Returns the complete product category tree with multi-language support.

#### Parameters

| Parameter       | Type   | Required | Default         | Description                       |
| --------------- | ------ | -------- | --------------- | --------------------------------- |
| `language_code` | String | No       | Client language | es-ES, en-US, fr-FR, it-IT, de-DE |
| `format_file`   | String | No       | json            | Format: json, xml, csv            |

#### Response Example

```json
[
  {"id": 14498, "name": "Perfumes", "parent_id": 0},
  {"id": 14499, "name": "Cosmetics", "parent_id": 0},
  {"id": 14500, "name": "Men", "parent_id": 0},
  {"id": 15008, "name": "PACO RABANNE", "parent_id": 14498},
  {"id": 15009, "name": "CAROLINA HERRERA", "parent_id": 14498},
  {"id": 15100, "name": "Facial Care", "parent_id": 14499}
]
```

#### Hierarchical structure:

📊 Categories with `parent_id: 0` are root categories (top level). The rest are subcategories. In products, the `categories` field is a path of IDs separated by `/` (e.g., `"14498/15008"` = Perfumes > PACO RABANNE).

#### Practical Example: Build category tree in your shop

```
# Get categories in English
curl -X GET "https://api.btswholesaler.com/v1/api/getListCategories?language_code=en-US" \
  -H "Authorization: Bearer your_jwt_token"

# Workflow to create categories in your shop:
# 1. Fetch all categories with this endpoint
# 2. Filter by parent_id=0 to get root categories
# 3. Build the tree respecting parent_id
# 4. For each product, parse "categories": "14498/15008"
#    and assign to the corresponding category
```

### 5.4 getProducts (by SKU)

#### GET `/v1/api/getProducts`

Get detailed information for specific products by their SKU/EAN. Maximum 25 products per request.

#### Parameters

| Parameter       | Type   | Required | Description                          |
| --------------- | ------ | -------- | ------------------------------------ |
| `product_sku[]` | Array  | Yes      | Array of SKUs/EANs to query. Max 25. |
| `language_code` | String | No       | es-ES, en-US, fr-FR, it-IT, de-DE    |

#### Response Example

```
[
  {
    "id": 12345,
    "ean": "8411061123456",
    "categories": "14498/15008",
    "manufacturer": "Carolina Herrera",
    "name": "Good Girl EDP 80ml",
    "description": "Eau de Parfum for women, 80ml",
    "recommended_price": 125.00,
    "price": 65.99,
    "stock": 150,
    "image": "https://cdn.btswholesaler.com/images/8411061123456.jpg",
    "leadtime_to_ship": "24",
    "gender": "woman",
    "flammable": true,
    "restricted_countries": ["US"]
  }
]
```

 **Note about getNewProducts vs getProducts:**

`getNewProducts` queries the database directly, while `getProducts` uses our search index. There may be a **brief delay** (minutes to a few hours) where a product appears in `getNewProducts` but is not yet available in `getProducts`. If this happens, simply retry later.



#### Practical Example: Verify product data before ordering

```
# Query updated data for 3 specific products
curl -X GET "https://api.btswholesaler.com/v1/api/getProducts?\
product_sku[0]=8411061123456&product_sku[1]=3614272049529&product_sku[2]=8005610711768" \
  -H "Authorization: Bearer your_jwt_token"

# Useful for:
# - Verifying price and stock before displaying in your shop
# - Getting description and image for a specific product
# - Checking country restrictions (restricted_countries)
```

## 5.5 Product Variants

 **About product variants:**

Currently, each product variant (different size, color, capacity) is treated as an **independent product** with its own unique EAN/SKU. The API does not expose a parent-child relationship between variants.

#### How to identify related variants?

To group variants of the same product in your shop, we recommend:

1. **By product name:** Products that are variants share the same base name with different capacity/size suffix. Example:
   - `"Good Girl EDP 30ml"` — EAN: 8411061123001
   - `"Good Girl EDP 50ml"` — EAN: 8411061123002
   - `"Good Girl EDP 80ml"` — EAN: 8411061123003
2. **By manufacturer + category:** Products from the same manufacturer in the same subcategory are usually variants.

#### Practical Example: Automatically group variants

```
# Strategy: Parse the product name to extract the base name
# Pseudocode example:
#
# "Good Girl EDP 80ml"  → base: "Good Girl EDP"  → variant: "80ml"
# "Good Girl EDP 50ml"  → base: "Good Girl EDP"  → variant: "50ml"
# "Good Girl EDP 30ml"  → base: "Good Girl EDP"  → variant: "30ml"
#
# Suggested regex to extract capacity:
#   /^(.+?)\s+(\d+(?:\.\d+)?\s*(?:ml|g|oz|cl|l|kg))\s*$/i
#
# Group products with the same "base" and "manufacturer"
# as variants of the same product.
```

 **Roadmap:** We are working on adding a `group_id` field to the API response to facilitate programmatic variant identification. We'll notify you when it's available.



## 6. Integration Examples

Select your preferred programming language:

PythonPHPJavaScriptC#JavaRubyGocURL

#### JavaScript/Node.js - Get Full Catalog

```
const axios = require('axios');

const BASE_URL = 'https://api.btswholesaler.com/v1/api';
const TOKEN = 'your_jwt_token';

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    timeout: 180000
});

async function getAllProducts() {
    const allProducts = [];
    let page = 1;
    
    while (true) {
        const { data } = await api.get('/getListProducts', {
            params: {
                page,
                page_size: 500,
                language_code: 'en-US'
            }
        });
        
        allProducts.push(...data.products);
        console.log(`Page ${page}/${data.pagination.total_pages}`);
        
        if (!data.pagination.has_next_page) break;
        page++;
    }
    
    return allProducts;
}

async function createOrder(products, shippingId, customer) {
    const params = new URLSearchParams();
    params.append('payment_method', 'wallet');
    params.append('shipping_cost_id', shippingId);
    params.append('client_name', customer.name);
    params.append('address', customer.address);
    params.append('postal_code', customer.postalCode);
    params.append('city', customer.city);
    params.append('country_code', customer.countryCode);
    params.append('telephone', customer.phone);
    params.append('dropshipping', '1');
    
    products.forEach((p, i) => {
        params.append(`products[${i}][sku]`, p.sku);
        params.append(`products[${i}][quantity]`, p.qty);
    });
    
    const { data } = await api.post('/setCreateOrder', params);
    return data;
}

// Usage
getAllProducts().then(products => {
    console.log(`Total: ${products.length} products`);
});
```

## 

## 7. Error Codes

| HTTP Code | Description         | Solution                        |
| --------- | ------------------- | ------------------------------- |
| 200       | Success             | -                               |
| 400       | Bad Request         | Check parameters                |
| 401       | Unauthorized        | Verify JWT token                |
| 404       | Not Found           | Check endpoint or feed disabled |
| 429       | Too Many Requests   | Wait before retrying            |
| 500       | Server Error        | Contact support                 |
| 503       | Service Unavailable | Try again later                 |

### 7.1 Order Error Messages (setCreateOrder)

When creating orders, the API may return these specific error messages in the response body:

| Error Message              | Description                                                 | Solution                                                     |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `country_code_is_required` | Missing country_code parameter                              | Add `country_code` parameter (e.g. FR, ES, DE)               |
| `shipping_cost_code_error` | The shipping_cost_id does not match the country/postal code | Call `getShippingPrices` with the same country_code and postal_code, then use a valid shipping_cost_id from the response |
| `state_code_error`         | Missing state_code for US/CA orders                         | Add `state_code` parameter (e.g. NY, CA, QC)                 |
| `payment_method_error`     | Invalid payment method                                      | Use one of: wallet, banktransfer, btscredit                  |
| `no_enough_money`          | Insufficient wallet balance                                 | Top up your wallet or use another payment method             |
| `no_enough_credit`         | Insufficient BTS credit                                     | Check your credit limit or use another payment method        |
| `product_error`            | Invalid product SKU                                         | Verify the product SKU exists in the catalog                 |
| `no_stock`                 | Product out of stock                                        | Check stock with `getProductStock` before ordering           |

---

📧 **Support:** For any questions, contact your Account Manager or email api@btswholesaler.com

Copyright © 2026. All rights reserved. BTSWholesaler. Nº RGSEAA: 40.081912/GR. Telephone: +34 858 826 059