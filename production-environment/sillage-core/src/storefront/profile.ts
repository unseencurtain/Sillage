/**
 * Per-instance storefront profile (retail vs wholesale) applied after migrate and at sync start.
 *
 * Do not encode this as a SQL migration: the same migration files run on both `sillage` and
 * `sillage_wpf`. Profile flips belong in code gated by SILLAGE_PROFILE.
 */
import { isWholesaleProfile, sil } from "../config/env.ts";
import { execute } from "../db/pool.ts";
import { logger } from "../lib/log.ts";

export { isWholesaleProfile };

const log = logger("profile");

const WHOLESALE_MIN_ORDER_EUR = 300;

export function wholesaleMinOrderEur(): number {
  return WHOLESALE_MIN_ORDER_EUR;
}

/** Wholesale instance must never place a live vendor order. Dashboard Live / CLI --live included. */
export function resolveDispatchDryRun(requested: boolean): boolean {
  if (isWholesaleProfile()) return true;
  return requested;
}

/**
 * Align sil_vendors + order rails with this process's profile.
 * Retail: do not flip BeautyFort/BTS active (operator-owned); WPF stays parked by sync.
 * Wholesale: WPF on with €300 MOQ; BF/BTS off; dry-run + auto-dispatch pinned.
 */
export async function applyStorefrontProfile(): Promise<void> {
  if (!isWholesaleProfile()) return;

  await execute(`UPDATE ${sil("sil_vendors")} SET active = 0 WHERE slug IN ('beautyfort', 'bts') AND active <> 0`);

  await execute(
    `UPDATE ${sil("sil_vendors")}
        SET active = 1,
            storefront_label = CASE
              WHEN storefront_label IS NULL OR storefront_label IN ('', 'LPS03') THEN 'Wholesale'
              ELSE storefront_label
            END,
            order_config = JSON_SET(
              COALESCE(order_config, JSON_OBJECT()),
              '$.min_order_value_eur',
              CAST(? AS UNSIGNED)
            )
      WHERE slug = 'wholesale-perfumes'`,
    [WHOLESALE_MIN_ORDER_EUR],
  );

  await execute(
    `INSERT INTO ${sil("sil_settings")} (setting_key, setting_value) VALUES
       ('orders_dry_run', '1'),
       ('orders_auto_dispatch', '0')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  );

  log.info(
    `wholesale profile: WPF active, min order €${WHOLESALE_MIN_ORDER_EUR}, BF/BTS parked, dispatch sandbox locked`,
  );
}
