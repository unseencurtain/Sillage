import { describe, expect, test } from "bun:test";
import { dispatchDryRun } from "../src/storefront/profile.ts";

/**
 * The dev box runs the same code against the same wholesalers with the same credentials, and
 * neither vendor offers a sandbox. Pressing Live there would buy real stock and ship it to
 * whatever address the test order carried.
 */
describe("dev box dispatch rail", () => {
  test("refuses Live on the dev box", () => {
    expect(dispatchDryRun(false, true)).toBe(true);
  });

  test("production honours the operator's choice", () => {
    expect(dispatchDryRun(false, false)).toBe(false);
  });

  test("dry-run stays dry-run on either box", () => {
    expect(dispatchDryRun(true, true)).toBe(true);
    expect(dispatchDryRun(true, false)).toBe(true);
  });
});
