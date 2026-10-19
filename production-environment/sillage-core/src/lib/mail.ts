/**
 * Outbound mail for storefront notifications.
 *
 * WordPress already sends the shop's mail (the `purelymail-smtp` plugin), but the forms live in the
 * engine and the engine has no mailer, so this is a small one: a lazy SMTP transport. The shop has a
 * single provider, so the transport is fixed — Purelymail, `smtp.purelymail.com:465` over implicit
 * TLS — and the operator sets only the mailbox and password, both ordinary settings on
 * Settings → Email sending. Nothing here is site-specific: the caller supplies the From, the
 * recipients and the body.
 *
 * A missing configuration is not an error: `sendMail` reports `{ ok: false }` and the caller decides
 * what that means. The forms never fail a submission because mail is down; the row is already saved.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env.ts";
import { logger } from "./log.ts";

const log = logger("mail");

export interface OutgoingMail {
  from: string;
  fromName?: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
}

/** The credentials a message is sent with. */
export interface MailAuth {
  user: string;
  password: string;
}

/** Credentials from Settings → Email sending, falling back to the environment if those are empty. */
export function mailAuth(username: string | undefined, password: string | undefined): MailAuth {
  return {
    user: (username ?? "").trim() || env.mail.user || "",
    password: (password ?? "").trim() || env.mail.password || "",
  };
}

/** True once a mailbox and its password are both known. */
export function mailConfigured(auth: MailAuth): boolean {
  return Boolean(env.mail.host && auth.user && auth.password);
}

// One transporter per distinct configuration. Rebuilt when a value changes, so a password rotated in
// the dashboard takes effect on the next message without a container restart.
let cached: { key: string; transporter: Transporter } | undefined;

function transport(auth: MailAuth): Transporter {
  const { host, port, secure } = env.mail;
  const key = `${host}:${port}:${secure}:${auth.user}:${auth.password}`;
  if (cached?.key === key) return cached.transporter;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: auth.user, pass: auth.password },
    // A form submission must not hang behind a dead relay.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { key, transporter };
  return transporter;
}

export async function sendMail(
  mail: OutgoingMail,
  auth: MailAuth,
): Promise<{ ok: boolean; error?: string }> {
  if (!mailConfigured(auth)) return { ok: false, error: "mail is not configured" };

  const from = mail.fromName ? { name: mail.fromName, address: mail.from } : mail.from;

  try {
    await transport(auth).sendMail({
      from,
      to: mail.to,
      replyTo: mail.replyTo || undefined,
      subject: mail.subject,
      text: mail.text,
    });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`sendMail to ${mail.to.join(", ")} failed`, error);
    return { ok: false, error };
  }
}
