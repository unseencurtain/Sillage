import { describe, expect, test } from "bun:test";
import { BTSRequestError, isBtsEmptyCatalog } from "../src/vendors/bts/BtsClient.ts";

describe("BTS empty-catalog 404 (v2.1)", () => {
  test("recognizes the documented no-products payload", () => {
    const err = new BTSRequestError(
      'BTS API 404 Not Found: {"name":"Not Found","message":"no products found","code":0,"status":404}',
      404,
      '{"name":"Not Found","message":"no products found","code":0,"status":404}',
    );
    expect(isBtsEmptyCatalog(err)).toBe(true);
  });

  test("does not swallow other 404s or 500s", () => {
    expect(isBtsEmptyCatalog(new BTSRequestError("BTS API 404", 404, "order missing"))).toBe(
      false,
    );
    expect(isBtsEmptyCatalog(new BTSRequestError("BTS API 500", 500, "no products found"))).toBe(
      false,
    );
    expect(isBtsEmptyCatalog(new Error("no products found"))).toBe(false);
  });
});
