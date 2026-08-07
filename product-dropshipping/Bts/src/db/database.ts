/**
 * Database layer for BTS Dropship Router.
 * Uses bun:sqlite — fully synchronous, WAL-enabled.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

// ─── Row types (DB representation) ───────────────────────────

export type ProductRow = {
  id: number;
  ean: string;
  categories: string;
  manufacturer: string;
  name: string;
  description: string;
  recommended_price: number;
  price: number;
  stock: number;
  image: string;
  delivery: number;
  gender: string;
  flammable: number; // 0 | 1
  restricted_countries: string; // JSON array string
  leadtime_to_ship: string;
  synced_at?: string;
};

export type CategoryRow = {
  id: number;
  name: string;
  parent_id: number;
};

export type OrderRow = {
  order_number: string;
  order_total: number;
  order_status: string;
  payment_method: string;
  client_name: string;
  address: string;
  postal_code: string;
  city: string;
  state_code: string;
  country_code: string;
  telephone: string;
  shipping_company: string;
  shipping_cost: number;
  tracking: string;
  expected_dispatch_date: string;
  expected_delivery_date: string;
  dropshipping: number;
  created_at?: string;
  updated_at?: string;
};

export type OrderItemRow = {
  order_number: string;
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
};

export type CartItemRow = {
  session_id: string;
  product_sku: string;
  quantity: number;
  price: number;
  name: string;
  image: string;
};

export type SyncLogRow = {
  id?: number;
  type: string;
  products_synced: number;
  categories_synced: number;
  started_at: string;
  completed_at: string;
  error: string;
};

// ─── Singleton ────────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    const dataDir = join(process.cwd(), "data");
    mkdirSync(dataDir, { recursive: true });

    // strict:true would require dropping $ prefix everywhere — keep default
    _db = new Database(join(dataDir, "bts.sqlite"), { create: true });

    _db.run("PRAGMA journal_mode = WAL;");
    _db.run("PRAGMA foreign_keys = ON;");
    _db.run("PRAGMA synchronous = NORMAL;"); // safe with WAL, faster
    _db.run("PRAGMA cache_size = -32000;"); // 32 MB cache

    initSchema(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    _db.close(false);
    _db = null;
  }
}

// ─── Schema ───────────────────────────────────────────────────

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id                  INTEGER PRIMARY KEY,
      ean                 TEXT    UNIQUE NOT NULL,
      categories          TEXT    NOT NULL DEFAULT '',
      manufacturer        TEXT    NOT NULL DEFAULT '',
      name                TEXT    NOT NULL DEFAULT '',
      description         TEXT    NOT NULL DEFAULT '',
      recommended_price   REAL    NOT NULL DEFAULT 0,
      price               REAL    NOT NULL DEFAULT 0,
      stock               INTEGER NOT NULL DEFAULT 0,
      image               TEXT    NOT NULL DEFAULT '',
      delivery            INTEGER NOT NULL DEFAULT 0,
      gender              TEXT    NOT NULL DEFAULT '',
      flammable           INTEGER NOT NULL DEFAULT 0,
      restricted_countries TEXT   NOT NULL DEFAULT '[]',
      leadtime_to_ship    TEXT    NOT NULL DEFAULT '',
      synced_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      parent_id INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
      order_number          TEXT     UNIQUE NOT NULL,
      order_total           REAL     NOT NULL DEFAULT 0,
      order_status          TEXT     NOT NULL DEFAULT '',
      payment_method        TEXT     NOT NULL DEFAULT '',
      client_name           TEXT     NOT NULL DEFAULT '',
      address               TEXT     NOT NULL DEFAULT '',
      postal_code           TEXT     NOT NULL DEFAULT '',
      city                  TEXT     NOT NULL DEFAULT '',
      state_code            TEXT     NOT NULL DEFAULT '',
      country_code          TEXT     NOT NULL DEFAULT '',
      telephone             TEXT     NOT NULL DEFAULT '',
      shipping_company      TEXT     NOT NULL DEFAULT '',
      shipping_cost         REAL     NOT NULL DEFAULT 0,
      tracking              TEXT     NOT NULL DEFAULT '',
      expected_dispatch_date TEXT    NOT NULL DEFAULT '',
      expected_delivery_date TEXT    NOT NULL DEFAULT '',
      dropshipping          INTEGER  NOT NULL DEFAULT 1,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT    NOT NULL,
      product_sku  TEXT    NOT NULL,
      product_name TEXT    NOT NULL DEFAULT '',
      quantity     INTEGER NOT NULL DEFAULT 1,
      unit_price   REAL    NOT NULL DEFAULT 0,
      FOREIGN KEY (order_number) REFERENCES orders(order_number) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cart (
      id           INTEGER  PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT     NOT NULL,
      product_sku  TEXT     NOT NULL,
      quantity     INTEGER  NOT NULL DEFAULT 1,
      price        REAL     NOT NULL DEFAULT 0,
      name         TEXT     NOT NULL DEFAULT '',
      image        TEXT     NOT NULL DEFAULT '',
      added_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, product_sku)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id                INTEGER  PRIMARY KEY AUTOINCREMENT,
      type              TEXT     NOT NULL,
      products_synced   INTEGER  NOT NULL DEFAULT 0,
      categories_synced INTEGER  NOT NULL DEFAULT 0,
      started_at        DATETIME NOT NULL,
      completed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      error             TEXT     NOT NULL DEFAULT ''
    )
  `);

  // Indexes
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_products_categories  ON products(categories)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_products_stock       ON products(stock)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_products_price       ON products(price)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_cart_session         ON cart(session_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_order_items_order    ON order_items(order_number)",
  );
}

// ─── Products ─────────────────────────────────────────────────

/**
 * Bulk upsert products in a single transaction.
 * Uses INSERT OR REPLACE for full speed.
 */
export function upsertProducts(products: ProductRow[]): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO products
      (id, ean, categories, manufacturer, name, description,
       recommended_price, price, stock, image, delivery, gender,
       flammable, restricted_countries, leadtime_to_ship, synced_at)
    VALUES
      ($id, $ean, $categories, $manufacturer, $name, $description,
       $recommended_price, $price, $stock, $image, $delivery, $gender,
       $flammable, $restricted_countries, $leadtime_to_ship, $synced_at)
  `);

  const now = new Date().toISOString();
  const bulk = db.transaction((rows: ProductRow[]) => {
    for (const p of rows) {
      insert.run({
        $id: p.id,
        $ean: p.ean,
        $categories: p.categories ?? "",
        $manufacturer: p.manufacturer ?? "",
        $name: p.name ?? "",
        $description: p.description ?? "",
        $recommended_price: p.recommended_price ?? 0,
        $price: p.price ?? 0,
        $stock: p.stock ?? 0,
        $image: p.image ?? "",
        $delivery: p.delivery ?? 0,
        $gender: p.gender ?? "",
        $flammable: p.flammable ?? 0,
        $restricted_countries: p.restricted_countries ?? "[]",
        $leadtime_to_ship: p.leadtime_to_ship ?? "",
        $synced_at: now,
      });
    }
  });

  bulk(products);
}

export function getProductByEan(ean: string): ProductRow | null {
  return getDb()
    .query<ProductRow, [string]>("SELECT * FROM products WHERE ean = ?1")
    .get(ean);
}

export interface SearchOptions {
  search?: string;
  manufacturer?: string;
  categoryId?: number;
  inStockOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function searchProducts(opts: SearchOptions): {
  products: ProductRow[];
  total: number;
} {
  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 24));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.search) {
    conditions.push("(name LIKE ?  OR manufacturer LIKE ?)");
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts.manufacturer) {
    conditions.push("manufacturer = ?");
    params.push(opts.manufacturer);
  }
  if (opts.categoryId) {
    // categories stored as "14498/15008" — match any segment
    conditions.push("('/' || categories || '/') LIKE ?");
    params.push(`%/${opts.categoryId}/%`);
  }
  if (opts.inStockOnly) {
    conditions.push("stock > 0");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Use prepare() for dynamic SQL (don't pollute query cache)
  const countRow = db
    .prepare<
      { total: number },
      (string | number)[]
    >(`SELECT COUNT(*) as total FROM products ${where}`)
    .get(...params);
  const total = countRow?.total ?? 0;

  const products = db
    .prepare<
      ProductRow,
      (string | number)[]
    >(`SELECT * FROM products ${where} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  return { products, total };
}

export function getManufacturers(): string[] {
  const rows = getDb()
    .query<
      { manufacturer: string },
      []
    >("SELECT DISTINCT manufacturer FROM products WHERE manufacturer != '' ORDER BY manufacturer ASC")
    .all();
  return rows.map((r) => r.manufacturer);
}

export function updateProductStock(
  ean: string,
  stock: number,
  price: number,
): void {
  getDb()
    .query(
      "UPDATE products SET stock = $stock, price = $price, synced_at = CURRENT_TIMESTAMP WHERE ean = $ean",
    )
    .run({ $ean: ean, $stock: stock, $price: price });
}

// ─── Categories ───────────────────────────────────────────────

export function upsertCategories(cats: CategoryRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO categories (id, name, parent_id) VALUES ($id, $name, $parent_id)",
  );
  const bulk = db.transaction((rows: CategoryRow[]) => {
    for (const c of rows) {
      insert.run({ $id: c.id, $name: c.name, $parent_id: c.parent_id });
    }
  });
  bulk(cats);
}

export function getCategories(): CategoryRow[] {
  return getDb()
    .query<CategoryRow, []>("SELECT * FROM categories ORDER BY parent_id, name")
    .all();
}

export function getCategoryById(id: number): CategoryRow | null {
  return getDb()
    .query<CategoryRow, [number]>("SELECT * FROM categories WHERE id = ?1")
    .get(id);
}

// ─── Orders ───────────────────────────────────────────────────

export function saveOrder(order: OrderRow, items: OrderItemRow[]): void {
  const db = getDb();

  const insertOrder = db.prepare(`
    INSERT OR REPLACE INTO orders
      (order_number, order_total, order_status, payment_method, client_name,
       address, postal_code, city, state_code, country_code, telephone,
       shipping_company, shipping_cost, tracking,
       expected_dispatch_date, expected_delivery_date, dropshipping, updated_at)
    VALUES
      ($order_number, $order_total, $order_status, $payment_method, $client_name,
       $address, $postal_code, $city, $state_code, $country_code, $telephone,
       $shipping_company, $shipping_cost, $tracking,
       $expected_dispatch_date, $expected_delivery_date, $dropshipping, CURRENT_TIMESTAMP)
  `);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_number, product_sku, product_name, quantity, unit_price)
    VALUES ($order_number, $product_sku, $product_name, $quantity, $unit_price)
  `);

  db.transaction(() => {
    insertOrder.run({
      $order_number: order.order_number,
      $order_total: order.order_total,
      $order_status: order.order_status,
      $payment_method: order.payment_method,
      $client_name: order.client_name,
      $address: order.address,
      $postal_code: order.postal_code,
      $city: order.city,
      $state_code: order.state_code,
      $country_code: order.country_code,
      $telephone: order.telephone,
      $shipping_company: order.shipping_company,
      $shipping_cost: order.shipping_cost,
      $tracking: order.tracking,
      $expected_dispatch_date: order.expected_dispatch_date,
      $expected_delivery_date: order.expected_delivery_date,
      $dropshipping: order.dropshipping,
    });

    // delete old items then re-insert (for idempotency)
    db.prepare("DELETE FROM order_items WHERE order_number = $n").run({
      $n: order.order_number,
    });

    for (const item of items) {
      insertItem.run({
        $order_number: item.order_number,
        $product_sku: item.product_sku,
        $product_name: item.product_name,
        $quantity: item.quantity,
        $unit_price: item.unit_price,
      });
    }
  })();
}

export function getOrders(
  page = 1,
  pageSize = 20,
): { orders: OrderRow[]; total: number } {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const total =
    db
      .query<{ total: number }, []>("SELECT COUNT(*) as total FROM orders")
      .get()?.total ?? 0;
  const orders = db
    .query<
      OrderRow,
      [number, number]
    >("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")
    .all(pageSize, offset);
  return { orders, total };
}

export function getOrderByNumber(
  orderNumber: string,
): (OrderRow & { items: OrderItemRow[] }) | null {
  const db = getDb();
  const order = db
    .query<OrderRow, [string]>("SELECT * FROM orders WHERE order_number = ?1")
    .get(orderNumber);
  if (!order) return null;

  const items = db
    .query<
      OrderItemRow,
      [string]
    >("SELECT * FROM order_items WHERE order_number = ?1")
    .all(orderNumber);

  return { ...order, items };
}

export function updateOrderTracking(
  orderNumber: string,
  tracking: string,
  status: string,
): void {
  getDb()
    .query(
      "UPDATE orders SET tracking = $tracking, order_status = $status, updated_at = CURRENT_TIMESTAMP WHERE order_number = $n",
    )
    .run({ $n: orderNumber, $tracking: tracking, $status: status });
}

// ─── Cart ─────────────────────────────────────────────────────

export function getCart(sessionId: string): CartItemRow[] {
  return getDb()
    .query<
      CartItemRow,
      [string]
    >("SELECT * FROM cart WHERE session_id = ?1 ORDER BY added_at")
    .all(sessionId);
}

export function addToCart(
  sessionId: string,
  item: Omit<CartItemRow, "session_id">,
): void {
  getDb()
    .query(
      `
      INSERT INTO cart (session_id, product_sku, quantity, price, name, image)
      VALUES ($session_id, $product_sku, $quantity, $price, $name, $image)
      ON CONFLICT(session_id, product_sku)
      DO UPDATE SET quantity = quantity + excluded.quantity
    `,
    )
    .run({
      $session_id: sessionId,
      $product_sku: item.product_sku,
      $quantity: item.quantity,
      $price: item.price,
      $name: item.name,
      $image: item.image,
    });
}

export function updateCartQty(
  sessionId: string,
  sku: string,
  qty: number,
): void {
  if (qty <= 0) {
    removeFromCart(sessionId, sku);
    return;
  }
  getDb()
    .query(
      "UPDATE cart SET quantity = $qty WHERE session_id = $sid AND product_sku = $sku",
    )
    .run({ $sid: sessionId, $sku: sku, $qty: qty });
}

export function removeFromCart(sessionId: string, sku: string): void {
  getDb()
    .query("DELETE FROM cart WHERE session_id = $sid AND product_sku = $sku")
    .run({ $sid: sessionId, $sku: sku });
}

export function clearCart(sessionId: string): void {
  getDb()
    .query("DELETE FROM cart WHERE session_id = $sid")
    .run({ $sid: sessionId });
}

export function getCartTotal(sessionId: string): number {
  const row = getDb()
    .query<
      { total: number },
      [string]
    >("SELECT COALESCE(SUM(price * quantity), 0) as total FROM cart WHERE session_id = ?1")
    .get(sessionId);
  return row?.total ?? 0;
}

// ─── Sync Log ─────────────────────────────────────────────────

export function logSync(entry: Omit<SyncLogRow, "id">): void {
  getDb()
    .query(
      `
      INSERT INTO sync_log (type, products_synced, categories_synced, started_at, completed_at, error)
      VALUES ($type, $products_synced, $categories_synced, $started_at, $completed_at, $error)
    `,
    )
    .run({
      $type: entry.type,
      $products_synced: entry.products_synced,
      $categories_synced: entry.categories_synced,
      $started_at: entry.started_at,
      $completed_at: entry.completed_at,
      $error: entry.error,
    });
}

export function getLastSync(): SyncLogRow | null {
  return getDb()
    .query<
      SyncLogRow,
      []
    >("SELECT * FROM sync_log WHERE error = '' ORDER BY completed_at DESC LIMIT 1")
    .get();
}
