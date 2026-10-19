/**
 * Read and write for the two storefront message tables:
 *
 *   sil_contact_messages    — the Contact form
 *   sil_withdrawal_messages — the Right-of-Withdrawal form
 *
 * The tables share a spine (who wrote, how to reach them, the session, when it arrived, and where it
 * sits in the inbox) but not their fields, so this module keeps them apart rather than pretending
 * they are one thing: one table name and one column list per kind, and the shared operations —
 * list, mark, delete, counts, rate limit — switch on the kind. Nothing here merges the two.
 *
 * Rows are returned as stored (snake_case, DATETIME strings), like every other dashboard read; the
 * only translation is `signed_in`, a TINYINT in the table and a boolean the browser can use.
 */
import { sil } from "../config/env.ts";
import { execute, query, queryOne, type RowDataPacket } from "../db/pool.ts";

export type MessageKind = "contact" | "withdrawal";
export type MessageStatus = "new" | "read" | "archived";

/** The columns both tables have. `kind` is not a column — it is which table the row came from. */
interface MessageCommon {
  id: number;
  status: MessageStatus;
  name: string;
  email: string;
  order_ref: string;
  locale: string;
  signed_in: boolean;
  customer_id: number | null;
  ip: string;
  user_agent: string;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
}

export interface ContactMessage extends MessageCommon {
  kind: "contact";
  phone: string;
  subject: string;
  body: string | null;
}

export interface WithdrawalMessage extends MessageCommon {
  kind: "withdrawal";
  goods: string | null;
  ordered_on: string;
  received_on: string;
  address: string | null;
  comment: string | null;
}

export type StoreMessage = ContactMessage | WithdrawalMessage;

/** As the driver hands the row back, before `signed_in` is turned into a boolean. */
interface RawCommon extends RowDataPacket {
  id: number;
  status: MessageStatus;
  name: string;
  email: string;
  order_ref: string;
  locale: string;
  signed_in: number;
  customer_id: number | null;
  ip: string;
  user_agent: string;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
}

type RawContact = RawCommon & { phone: string; subject: string; body: string | null };
type RawWithdrawal = RawCommon & {
  goods: string | null;
  ordered_on: string;
  received_on: string;
  address: string | null;
  comment: string | null;
};

function toContact(row: RawContact): ContactMessage {
  const { signed_in, ...rest } = row;
  return { ...rest, kind: "contact", signed_in: signed_in === 1 };
}

function toWithdrawal(row: RawWithdrawal): WithdrawalMessage {
  const { signed_in, ...rest } = row;
  return { ...rest, kind: "withdrawal", signed_in: signed_in === 1 };
}

/** The two tables, named once. Everything else asks for a kind and gets this. */
const TABLES: Record<MessageKind, string> = {
  contact: "sil_contact_messages",
  withdrawal: "sil_withdrawal_messages",
};

const COLUMNS: Record<MessageKind, string> = {
  contact:
    "id, status, name, email, phone, order_ref, subject, body, locale, signed_in, customer_id, ip, user_agent, created_at, read_at, archived_at",
  withdrawal:
    "id, status, name, email, order_ref, goods, ordered_on, received_on, address, comment, locale, signed_in, customer_id, ip, user_agent, created_at, read_at, archived_at",
};

function table(kind: MessageKind): string {
  return sil(TABLES[kind]);
}

/* ---------------------------------- insert ---------------------------------- */

/** Everything a Contact submission needs. Only name, email and body are required. */
export interface NewContact {
  name: string;
  email: string;
  phone?: string;
  orderRef?: string;
  subject?: string;
  body?: string;
  locale?: string;
  signedIn?: boolean;
  customerId?: number | null;
  ip?: string;
  userAgent?: string;
}

/** Everything a Withdrawal submission needs. `goods` is the one withdrawal-only requirement. */
export interface NewWithdrawal {
  name: string;
  email: string;
  orderRef?: string;
  goods?: string;
  orderedOn?: string;
  receivedOn?: string;
  address?: string;
  comment?: string;
  locale?: string;
  signedIn?: boolean;
  customerId?: number | null;
  ip?: string;
  userAgent?: string;
}

export async function insertContact(message: NewContact): Promise<number> {
  const result = await execute(
    `INSERT INTO ${table("contact")}
       (name, email, phone, order_ref, subject, body, locale, signed_in, customer_id, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.name.slice(0, 191),
      message.email.slice(0, 191),
      (message.phone ?? "").slice(0, 64),
      (message.orderRef ?? "").slice(0, 64),
      (message.subject ?? "").slice(0, 255),
      message.body ?? null,
      (message.locale ?? "").slice(0, 8),
      message.signedIn ? 1 : 0,
      message.customerId ?? null,
      (message.ip ?? "").slice(0, 45),
      (message.userAgent ?? "").slice(0, 255),
    ],
  );
  return result.insertId;
}

export async function insertWithdrawal(message: NewWithdrawal): Promise<number> {
  const result = await execute(
    `INSERT INTO ${table("withdrawal")}
       (name, email, order_ref, goods, ordered_on, received_on, address, comment, locale,
        signed_in, customer_id, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.name.slice(0, 191),
      message.email.slice(0, 191),
      (message.orderRef ?? "").slice(0, 64),
      message.goods ?? null,
      (message.orderedOn ?? "").slice(0, 20),
      (message.receivedOn ?? "").slice(0, 20),
      message.address ?? null,
      message.comment ?? null,
      (message.locale ?? "").slice(0, 8),
      message.signedIn ? 1 : 0,
      message.customerId ?? null,
      (message.ip ?? "").slice(0, 45),
      (message.userAgent ?? "").slice(0, 255),
    ],
  );
  return result.insertId;
}

/* ----------------------------------- read ----------------------------------- */

/** Per-tab counts — the numbers on the two tab buttons, independent of the active filter. */
export interface MessageCounts {
  contact: number;
  withdrawal: number;
}

async function countByStatus(tableName: string, status: MessageStatus): Promise<number> {
  const row = await queryOne<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil(tableName)} WHERE status = ?`,
    [status],
  );
  return Number(row?.n) || 0;
}

/** Unread per tab: the badge on the tab button. */
export async function unreadCounts(): Promise<MessageCounts> {
  const [contact, withdrawal] = await Promise.all([
    countByStatus("sil_contact_messages", "new"),
    countByStatus("sil_withdrawal_messages", "new"),
  ]);
  return { contact, withdrawal };
}

/**
 * Archived per tab. "Empty archive" is only offered when the active tab holds something, so the
 * dashboard needs the number without listing the rows.
 */
export async function archivedCounts(): Promise<MessageCounts> {
  const [contact, withdrawal] = await Promise.all([
    countByStatus("sil_contact_messages", "archived"),
    countByStatus("sil_withdrawal_messages", "archived"),
  ]);
  return { contact, withdrawal };
}

export interface MessageQuery {
  kind: MessageKind;
  status?: MessageStatus | "all";
  page: number;
  limit: number;
}

export interface MessagePage {
  items: StoreMessage[];
  total: number;
  page: number;
  limit: number;
  counts: MessageCounts;
  /** Archived per tab, so the "Empty archive" button knows whether it has anything to do. */
  archived: MessageCounts;
}

export async function listMessages({ kind, status = "all", page, limit }: MessageQuery): Promise<MessagePage> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const tableName = table(kind);

  const [rows, totalRow, counts, archived] = await Promise.all([
    query<RawContact & RawWithdrawal>(
      `SELECT ${COLUMNS[kind]} FROM ${tableName} ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    ),
    queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM ${tableName} ${where}`,
      params,
    ),
    unreadCounts(),
    archivedCounts(),
  ]);

  const items: StoreMessage[] =
    kind === "contact"
      ? (rows as unknown as RawContact[]).map(toContact)
      : (rows as unknown as RawWithdrawal[]).map(toWithdrawal);

  return { items, total: Number(totalRow?.n) || 0, page, limit, counts, archived };
}

/* ---------------------------------- mutate ---------------------------------- */

/** Read / unread / archived in one move. Returns false when the id is unknown. */
export async function setMessageStatus(
  kind: MessageKind,
  id: number,
  status: MessageStatus,
): Promise<boolean> {
  const result = await execute(
    `UPDATE ${table(kind)}
        SET status = ?,
            read_at = CASE
                        WHEN ? = 'new' THEN NULL
                        WHEN read_at IS NULL THEN NOW()
                        ELSE read_at
                      END,
            archived_at = CASE WHEN ? = 'archived' THEN NOW() ELSE NULL END
      WHERE id = ?`,
    [status, status, status, id],
  );
  return result.affectedRows > 0;
}

export async function deleteMessage(kind: MessageKind, id: number): Promise<boolean> {
  const result = await execute(`DELETE FROM ${table(kind)} WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

/**
 * Delete many at once, from the one table the kind names. Ids are de-duplicated, filtered to real
 * positives and capped, so a malformed body can only ever narrow the statement.
 */
export async function deleteMessages(kind: MessageKind, ids: number[]): Promise<number> {
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).slice(0, 500);
  if (wanted.length === 0) return 0;
  const holes = wanted.map(() => "?").join(", ");
  const result = await execute(`DELETE FROM ${table(kind)} WHERE id IN (${holes})`, wanted);
  return result.affectedRows;
}

/** Empty one tab's archive. Read and unread rows are never touched. */
export async function deleteArchived(kind: MessageKind): Promise<number> {
  const result = await execute(`DELETE FROM ${table(kind)} WHERE status = 'archived'`);
  return result.affectedRows;
}

/**
 * How many messages one client has sent inside the window, counted across both forms — a limit that
 * a shopper could otherwise sidestep by alternating them.
 */
export async function countRecentFromIp(ip: string, minutes: number): Promise<number> {
  if (!ip) return 0;
  const row = await queryOne<RowDataPacket & { n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM ${sil("sil_contact_messages")}
          WHERE ip = ? AND created_at >= (NOW() - INTERVAL ? MINUTE)) +
       (SELECT COUNT(*) FROM ${sil("sil_withdrawal_messages")}
          WHERE ip = ? AND created_at >= (NOW() - INTERVAL ? MINUTE)) AS n`,
    [ip, minutes, ip, minutes],
  );
  return Number(row?.n) || 0;
}
