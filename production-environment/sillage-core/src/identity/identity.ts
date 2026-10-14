/**
 * Store identity: the store name and the email addresses customers and staff see.
 *
 * The record lives in sil_settings (identity_*). It is the only place these values are edited.
 * pushIdentity() writes them into WordPress, WooCommerce and the Purelymail sender through the
 * bridge plugin; checkIdentity() reads them back and reports anything that differs. A database
 * restored from another box keeps its old options, so every save, deploy and adopt runs this.
 */
import { env, sil } from "../config/env.ts";
import { logger } from "../lib/log.ts";
import { signPayload } from "../lib/hmac.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import {
  emptyIdentity,
  IDENTITY_KEYS,
  type Identity,
  type IdentityField,
  validateIdentity,
  WP_FIELDS,
} from "./rules.ts";

export { IDENTITY_KEYS, validateIdentity, emptyIdentity };
export type { Identity, IdentityField };

const log = logger("identity");

/** Read the record. Missing keys come back empty. */
export async function loadIdentity(): Promise<Identity> {
  const keys = Object.values(IDENTITY_KEYS);
  const rows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")} WHERE setting_key IN (${keys.map(() => "?").join(",")})`,
    keys,
  );
  const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  const out = emptyIdentity();
  for (const field of Object.keys(IDENTITY_KEYS) as IdentityField[]) {
    out[field] = (map.get(IDENTITY_KEYS[field]) ?? "").trim();
  }
  return out;
}

/** Save the fields given. Throws with the problem list if any value is refused. */
export async function saveIdentity(values: Partial<Record<IdentityField, string>>): Promise<void> {
  const problems = validateIdentity(values);
  if (problems.length > 0) {
    throw new Error(problems.map((p) => `${p.field}: ${p.message}`).join("; "));
  }
  for (const [field, raw] of Object.entries(values) as [IdentityField, string][]) {
    if (!(field in IDENTITY_KEYS)) continue;
    await execute(
      `INSERT INTO ${sil("sil_settings")} (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [IDENTITY_KEYS[field], (raw ?? "").trim()],
    );
  }
}

/** WordPress base for the signed bridge calls. Same origin the finalize call uses. */
function bridgeOrigin(): string {
  return env.wordpress.internalUrl || env.wordpress.baseUrl;
}

export interface PushResult {
  ok: boolean;
  changed: Record<string, { from: string; to: string }>;
  warnings: string[];
  error?: string;
}

/** Write the record into WordPress. Sends only the WordPress fields. */
export async function pushIdentity(identity: Identity): Promise<PushResult> {
  const payload: Partial<Identity> = {};
  for (const field of WP_FIELDS) payload[field] = identity[field];
  const body = JSON.stringify(payload);
  const response = await fetch(`${bridgeOrigin()}/wp-json/sillage/v1/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sillage-Signature": signPayload(body, env.wordpress.sharedSecret) },
    body,
  });
  const json = (await response.json().catch(() => ({ ok: false, error: "non-JSON response" }))) as PushResult;
  if (!response.ok) {
    log.error(`identity push returned ${response.status}: ${json.error ?? "unknown"}`);
    return { ok: false, changed: {}, warnings: [], error: json.error ?? `HTTP ${response.status}` };
  }
  return json;
}

/** Read the identity WordPress currently holds, in record field names. */
export async function readWordPressIdentity(): Promise<Record<string, string>> {
  const response = await fetch(`${bridgeOrigin()}/wp-json/sillage/v1/identity`, {
    method: "GET",
    headers: { "X-Sillage-Signature": signPayload("", env.wordpress.sharedSecret) },
  });
  if (!response.ok) throw new Error(`identity read returned ${response.status}`);
  return (await response.json()) as Record<string, string>;
}

export interface Mismatch {
  field: string;
  record: string;
  wordpress: string;
}

/**
 * Compare the configurable identity record with WordPress.
 */
export async function checkIdentity(): Promise<{ mismatches: Mismatch[] }> {
  const record = await loadIdentity();
  const live = await readWordPressIdentity();
  const mismatches: Mismatch[] = [];
  for (const field of WP_FIELDS) {
    const want = record[field];
    if (want === "") continue;
    const have = live[field] ?? "";
    if (have !== want) mismatches.push({ field, record: want, wordpress: have });
  }
  // The POS and stock recipients always follow support_email, so they are checked with it.
  if (record.support_email !== "" && (live.pos_email ?? "") !== record.support_email) {
    mismatches.push({ field: "pos_email", record: record.support_email, wordpress: live.pos_email ?? "" });
  }
  return { mismatches };
}
