import { sil, wp } from "../config/env.ts";
import { execute, query, transaction, type PoolConnection, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";
import { foldKey, slugify, uniqueTermSlug } from "../lib/slugify.ts";
import type { VendorCategoryNode } from "../vendors/types.ts";

const log = logger("taxonomy");

export interface TermRef {
  termId: number;
  ttId: number;
}

/** Attribute key in NormalizedProduct.attributes -> WooCommerce global attribute taxonomy. */
export const ATTRIBUTE_TAXONOMIES: Record<string, string> = {
  gender: "pa_gender",
  // Slugged `item-type`, not `type`: WordPress reserves `type` as a public query variable, so
  // wc_create_attribute() rejects it and the attribute never gets registered at all.
  type: "pa_item-type",
  volume: "pa_volume",
  /** Storefront browse filter: BeautyFort vs BTS. */
  vendor: "pa_vendor",
};

/**
 * Singular. WooCommerce registers `product_brand` — see `get_taxonomy( 'product_brand' )` in
 * `class-wc-brands.php`. Terms written to `product_brands` are stored happily and read by nothing.
 */
export const BRAND_TAXONOMY = "product_brand";
export const CATEGORY_TAXONOMY = "product_cat";

interface TermRow extends RowDataPacket {
  term_id: number;
  term_taxonomy_id: number;
  slug: string;
  name: string;
  parent: number;
}

interface MapRow extends RowDataPacket {
  vendor_category_key: string;
  wp_term_id: number;
  wp_term_taxonomy_id: number;
}

interface SimpleMapRow extends RowDataPacket {
  source_key: string;
  wp_term_id: number;
  wp_term_taxonomy_id: number;
}

interface SlugRow extends RowDataPacket {
  slug: string;
}

/** Every slug already in wp_terms. WordPress expects term slugs to be globally unique. */
async function loadTakenSlugs(): Promise<Set<string>> {
  const rows = await query<SlugRow>(`SELECT slug FROM ${wp("terms")}`);
  return new Set(rows.map((r) => r.slug));
}

async function insertTerm(
  conn: PoolConnection,
  name: string,
  slug: string,
  taxonomy: string,
  parentTermId: number,
): Promise<TermRef> {
  const [termResult] = await conn.query(
    `INSERT INTO ${wp("terms")} (name, slug, term_group) VALUES (?, ?, 0)`,
    [name.slice(0, 200), slug.slice(0, 200)],
  );
  const termId = (termResult as { insertId: number }).insertId;

  const [ttResult] = await conn.query(
    `INSERT INTO ${wp("term_taxonomy")} (term_id, taxonomy, description, parent, count)
     VALUES (?, ?, '', ?, 0)`,
    [termId, taxonomy, parentTermId],
  );
  const ttId = (ttResult as { insertId: number }).insertId;

  return { termId, ttId };
}

/**
 * Create the WordPress `product_cat` terms a vendor's feed needs.
 *
 * Only categories actually referenced by products, plus their ancestors, are created — BTS
 * publishes 4,103 nodes but products reference only 1,834 of them, and the rest would be
 * permanently empty terms cluttering the storefront.
 */
export async function syncCategories(
  vendorId: number,
  nodes: VendorCategoryNode[],
  referencedKeys: Set<string>,
): Promise<{ map: Map<string, TermRef>; created: number }> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  // Expand to the ancestor closure so no term is created without its parent.
  const needed = new Set<string>();
  for (const key of referencedKeys) {
    let cursor: string | null = key;
    let guard = 0;
    while (cursor && !needed.has(cursor) && guard++ < 32) {
      const node: VendorCategoryNode | undefined = byKey.get(cursor);
      if (!node) break;
      needed.add(cursor);
      cursor = node.parentKey;
    }
  }

  const map = new Map<string, TermRef>();
  for (const row of await query<MapRow>(
    `SELECT vendor_category_key, wp_term_id, wp_term_taxonomy_id
       FROM ${sil("sil_category_map")} WHERE vendor_id = ?`,
    [vendorId],
  )) {
    map.set(row.vendor_category_key, { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
  }

  // Adopt terms an operator may have created by hand, matching on slug within product_cat.
  const existingBySlug = new Map<string, TermRow>();
  for (const row of await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = ?`,
    [CATEGORY_TAXONOMY],
  )) {
    existingBySlug.set(row.slug, row);
  }

  const missing = [...needed].filter((k) => !map.has(k));
  if (missing.length === 0) return { map, created: 0 };

  // Depth order guarantees a parent is resolved before its children. The live BTS tree is only
  // four deep and acyclic, but this is computed rather than assumed.
  const depthOf = (key: string): number => {
    let d = 0;
    let cursor: string | null = key;
    let guard = 0;
    while (cursor && guard++ < 32) {
      const node: VendorCategoryNode | undefined = byKey.get(cursor);
      if (!node?.parentKey) break;
      cursor = node.parentKey;
      d++;
    }
    return d;
  };
  missing.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));

  const takenSlugs = await loadTakenSlugs();
  let created = 0;

  await transaction(async (conn) => {
    const pending: Array<[string, TermRef, number, boolean]> = [];

    for (const key of missing) {
      const node = byKey.get(key);
      if (!node) continue;

      const parentTermId = node.parentKey ? (map.get(node.parentKey)?.termId ?? 0) : 0;

      // A term with this slug may already exist from a previous vendor or a manual edit; reuse it
      // rather than creating a near-duplicate category.
      const baseSlug = slugify(node.name) || `cat-${key}`;
      const adoptable = existingBySlug.get(baseSlug);

      let ref: TermRef;
      if (adoptable && adoptable.parent === parentTermId) {
        ref = { termId: adoptable.term_id, ttId: adoptable.term_taxonomy_id };
      } else {
        const slug = uniqueTermSlug(node.name, takenSlugs, `cat-${key}`);
        ref = await insertTerm(conn, node.name, slug, CATEGORY_TAXONOMY, parentTermId);
        existingBySlug.set(slug, {
          term_id: ref.termId,
          term_taxonomy_id: ref.ttId,
          slug,
          name: node.name,
          parent: parentTermId,
        } as TermRow);
        created++;
      }

      map.set(key, ref);
      const isLeaf = !nodes.some((n) => n.parentKey === key && needed.has(n.key));
      pending.push([key, ref, depthOf(key), isLeaf]);
    }

    for (let i = 0; i < pending.length; i += 500) {
      const slice = pending.slice(i, i + 500);
      await conn.query(
        `INSERT INTO ${sil("sil_category_map")}
           (vendor_id, vendor_category_key, wp_term_id, wp_term_taxonomy_id, depth, is_leaf)
         VALUES ${slice.map(() => "(?,?,?,?,?,?)").join(",")}
         ON DUPLICATE KEY UPDATE
           wp_term_id = VALUES(wp_term_id),
           wp_term_taxonomy_id = VALUES(wp_term_taxonomy_id),
           depth = VALUES(depth),
           is_leaf = VALUES(is_leaf)`,
        slice.flatMap(([key, ref, depth, isLeaf]) => [
          vendorId,
          key,
          ref.termId,
          ref.ttId,
          depth,
          isLeaf ? 1 : 0,
        ]),
      );
    }
  });

  log.info(`vendor ${vendorId}: ${created} product_cat terms created, ${map.size} mapped`);
  return { map, created };
}

/**
 * Top-level shop categories so customers can browse "all BeautyFort" / "all BTS" as normal
 * WooCommerce category pages (in addition to the pa_vendor attribute filter).
 */
export async function ensureVendorShopCategories(
  vendors: Array<{ slug: string; name: string }>,
  labels: Record<string, string>,
): Promise<{ bySlug: Map<string, TermRef>; created: number }> {
  const names = new Set(vendors.map((v) => labels[v.slug] ?? v.name));
  const { map, created } = await syncFlatTerms(CATEGORY_TAXONOMY, names);
  const bySlug = new Map<string, TermRef>();
  for (const v of vendors) {
    const label = labels[v.slug] ?? v.name;
    const ref = map.get(foldKey(label));
    if (ref) bySlug.set(v.slug, ref);
  }
  if (created > 0) log.info(`vendor shop categories: ${created} product_cat terms created`);
  return { bySlug, created };
}

/**
 * Create flat terms for a non-hierarchical taxonomy — brands and the `pa_*` attributes.
 *
 * Keyed by `foldKey`, which matches how the database's own collation compares strings, so "DIOR",
 * "Dior" and "Diór" all resolve to a single term instead of fighting each other run after run.
 */
export async function syncFlatTerms(
  taxonomy: string,
  values: Iterable<string>,
): Promise<{ map: Map<string, TermRef>; created: number }> {
  const map = new Map<string, TermRef>();
  for (const row of await query<SimpleMapRow>(
    `SELECT source_key, wp_term_id, wp_term_taxonomy_id FROM ${sil("sil_term_map")} WHERE taxonomy = ?`,
    [taxonomy],
  )) {
    map.set(foldKey(row.source_key), { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
  }

  // Existing WordPress terms, indexed both by folded name and by slug so a term created by an
  // operator, an earlier vendor, or an older version of this code is adopted rather than
  // duplicated.
  const existingByFold = new Map<string, TermRow>();
  const existingBySlug = new Map<string, TermRow>();
  for (const row of await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = ?`,
    [taxonomy],
  )) {
    existingBySlug.set(row.slug, row);
    const folded = foldKey(row.name);
    if (!existingByFold.has(folded)) existingByFold.set(folded, row);
  }

  const wanted = new Map<string, string>();
  for (const raw of values) {
    const label = String(raw ?? "").trim();
    if (!label) continue;
    const key = foldKey(label);
    if (!key) continue;
    // Deterministic winner when two spellings fold together, so the chosen label does not flip
    // between runs depending on feed order.
    const existing = wanted.get(key);
    if (existing === undefined || label < existing) wanted.set(key, label);
  }

  const missing = [...wanted].filter(([key]) => !map.has(key));
  if (missing.length === 0) return { map, created: 0 };

  const takenSlugs = await loadTakenSlugs();
  let created = 0;

  await transaction(async (conn) => {
    const pending: Array<[string, string, TermRef]> = [];

    for (const [key, label] of missing) {
      const adoptable = existingByFold.get(key) ?? existingBySlug.get(slugify(label));

      let ref: TermRef;
      if (adoptable) {
        ref = { termId: adoptable.term_id, ttId: adoptable.term_taxonomy_id };
      } else {
        const slug = uniqueTermSlug(label, takenSlugs, "term");
        ref = await insertTerm(conn, label, slug, taxonomy, 0);
        const row = {
          term_id: ref.termId,
          term_taxonomy_id: ref.ttId,
          slug,
          name: label,
          parent: 0,
        } as TermRow;
        existingBySlug.set(slug, row);
        existingByFold.set(key, row);
        created++;
      }

      map.set(key, ref);
      pending.push([key, label, ref]);
    }

    for (let i = 0; i < pending.length; i += 500) {
      const slice = pending.slice(i, i + 500);
      await conn.query(
        `INSERT INTO ${sil("sil_term_map")}
           (taxonomy, source_key, wp_term_id, wp_term_taxonomy_id, label)
         VALUES ${slice.map(() => "(?,?,?,?,?)").join(",")}
         ON DUPLICATE KEY UPDATE
           -- Rewrite source_key too. The collation can match a row whose stored key is a
           -- different spelling of the same word; without this the row never converges on the
           -- folded form and the lookup misses again next run.
           source_key = VALUES(source_key),
           wp_term_id = VALUES(wp_term_id),
           wp_term_taxonomy_id = VALUES(wp_term_taxonomy_id),
           label = VALUES(label)`,
        slice.flatMap(([key, label, ref]) => [taxonomy, key, ref.termId, ref.ttId, label.slice(0, 200)]),
      );
    }
  });

  log.info(`${taxonomy}: ${created} terms created, ${map.size} mapped`);
  return { map, created };
}

/**
 * The install's `product_visibility` term ids. These are per-install and must never be hardcoded,
 * even though they happen to be 6-9 here.
 */
export async function loadVisibilityTerms(): Promise<Record<string, TermRef>> {
  const rows = await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = 'product_visibility'`,
  );
  const out: Record<string, TermRef> = {};
  for (const row of rows) out[row.slug] = { termId: row.term_id, ttId: row.term_taxonomy_id };

  for (const required of ["exclude-from-catalog", "exclude-from-search", "outofstock"]) {
    if (!out[required]) {
      throw new Error(
        `product_visibility term "${required}" is missing — is WooCommerce fully installed?`,
      );
    }
  }
  return out;
}

/** WooCommerce's `product_type` terms, needed so products register as simple products. */
export async function loadProductTypeTerm(type = "simple"): Promise<TermRef> {
  const rows = await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = 'product_type' AND t.slug = ?`,
    [type],
  );
  const row = rows[0];
  if (!row) throw new Error(`product_type term "${type}" is missing — is WooCommerce installed?`);
  return { termId: row.term_id, ttId: row.term_taxonomy_id };
}

/** True when the WooCommerce global attribute taxonomy has been registered by the plugin. */
export async function attributeTaxonomyExists(taxonomy: string): Promise<boolean> {
  const name = taxonomy.replace(/^pa_/, "");
  const rows = await query<RowDataPacket>(
    `SELECT 1 FROM ${wp("woocommerce_attribute_taxonomies")} WHERE attribute_name = ? LIMIT 1`,
    [name],
  );
  return rows.length > 0;
}

/**
 * Recount terms once per run rather than per row.
 *
 * WooCommerce counts only published products, and the storefront hides products carrying
 * `exclude-from-catalog`, so those are excluded here too — otherwise category counts overstate
 * what a shopper can actually see.
 */
export async function recountTerms(taxonomies: string[]): Promise<void> {
  if (taxonomies.length === 0) return;
  const placeholders = taxonomies.map(() => "?").join(",");

  const excluded = await query<RowDataPacket & { term_taxonomy_id: number }>(
    `SELECT tt.term_taxonomy_id FROM ${wp("term_taxonomy")} tt
       JOIN ${wp("terms")} t ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-catalog'`,
  );
  const hiddenTtId = excluded[0]?.term_taxonomy_id ?? 0;

  await execute(
    `UPDATE ${wp("term_taxonomy")} tt
        SET tt.count = (
          SELECT COUNT(DISTINCT p.ID)
            FROM ${wp("term_relationships")} tr
            JOIN ${wp("posts")} p ON p.ID = tr.object_id
           WHERE tr.term_taxonomy_id = tt.term_taxonomy_id
             AND p.post_type = 'product'
             AND p.post_status = 'publish'
             AND NOT EXISTS (
               SELECT 1 FROM ${wp("term_relationships")} hidden
                WHERE hidden.object_id = p.ID AND hidden.term_taxonomy_id = ?
             )
        )
      WHERE tt.taxonomy IN (${placeholders})`,
    [hiddenTtId, ...taxonomies],
  );

  log.info(`recounted ${taxonomies.join(", ")}`);
}

/**
 * Rebuild `wp_wc_category_lookup`, WooCommerce's product_cat closure table. Without it category
 * filtering and counts silently return wrong results, because nothing else maintains it when the
 * CRUD layer is bypassed.
 */
export async function rebuildCategoryLookup(): Promise<number> {
  await execute(`DELETE FROM ${wp("wc_category_lookup")}`);
  const result = await execute(
    `INSERT INTO ${wp("wc_category_lookup")} (category_tree_id, category_id)
     WITH RECURSIVE tree AS (
       SELECT tt.term_id AS root_id, tt.term_id AS node_id
         FROM ${wp("term_taxonomy")} tt
        WHERE tt.taxonomy = 'product_cat'
       UNION ALL
       SELECT tree.root_id, child.term_id
         FROM tree
         JOIN ${wp("term_taxonomy")} child
           ON child.parent = tree.node_id AND child.taxonomy = 'product_cat'
     )
     SELECT DISTINCT root_id, node_id FROM tree`,
  );
  log.info(`rebuilt wc_category_lookup (${result.affectedRows} rows)`);
  return result.affectedRows;
}
