import { describe, expect, test } from "bun:test";
import { validateIdentity } from "../src/identity/rules.ts";

describe("identity validation", () => {
  test("accepts a complete valid record", () => {
    expect(
      validateIdentity({
        store_name: "PrinsCosmetic",
        admin_email: "hello@aiyuco.com",
        sender_email: "hello@aiyuco.com",
        reply_to: "hello@aiyuco.com",
        smtp_username: "hello@aiyuco.com",
        support_email: "hello@aiyuco.com",
      }),
    ).toEqual([]);
  });

  test("allows identity values to be changed between stores", () => {
    expect(validateIdentity({ admin_email: "operator@example.org" })).toEqual([]);
  });

  test("refuses a bad email and an empty store name", () => {
    expect(validateIdentity({ sender_email: "not-an-email" })[0]?.message).toBe("not a valid email address");
    expect(validateIdentity({ store_name: "  " })[0]?.field).toBe("store_name");
  });

  test("refuses markup in names", () => {
    expect(validateIdentity({ store_name: "<b>Shop</b>" })[0]?.message).toContain("< > or quotes");
  });
});
