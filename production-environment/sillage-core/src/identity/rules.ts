/**
 * Identity rules that need no database or config. Kept apart from identity.ts so they can be
 * tested without loading the engine environment.
 */

/** Record field -> sil_settings key. */
export const IDENTITY_KEYS = {
  store_name: "identity_store_name",
  legal_name: "identity_legal_name",
  admin_email: "identity_admin_email",
  sender_email: "identity_sender_email",
  reply_to: "identity_reply_to",
  smtp_username: "identity_smtp_username",
  support_email: "identity_support_email",
} as const;

export type IdentityField = keyof typeof IDENTITY_KEYS;
export type Identity = Record<IdentityField, string>;

/** Fields that go to WordPress. legal_name is storefront footer copy only. */
export const WP_FIELDS: IdentityField[] = [
  "store_name",
  "admin_email",
  "sender_email",
  "reply_to",
  "smtp_username",
  "support_email",
];

export const EMAIL_FIELDS: IdentityField[] = [
  "admin_email",
  "sender_email",
  "reply_to",
  "smtp_username",
  "support_email",
];

export interface IdentityProblem {
  field: string;
  message: string;
}

export function emptyIdentity(): Identity {
  return { store_name: "", legal_name: "", admin_email: "", sender_email: "", reply_to: "", smtp_username: "", support_email: "" };
}

/** Validate a partial or full identity. Returns problems; empty means it can be saved. */
export function validateIdentity(values: Partial<Record<IdentityField, string>>): IdentityProblem[] {
  const problems: IdentityProblem[] = [];
  for (const [field, raw] of Object.entries(values) as [IdentityField, string][]) {
    if (!(field in IDENTITY_KEYS)) continue;
    const value = (raw ?? "").trim();
    if (value === "") continue;
    if (value.length > 120) problems.push({ field, message: "too long" });
    if (/[<>"]/.test(value)) problems.push({ field, message: "contains < > or quotes" });
    if (EMAIL_FIELDS.includes(field) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      problems.push({ field, message: "not a valid email address" });
    }
  }
  if (values.store_name !== undefined && (values.store_name ?? "").trim() === "") {
    problems.push({ field: "store_name", message: "store name cannot be empty" });
  }
  return problems;
}
