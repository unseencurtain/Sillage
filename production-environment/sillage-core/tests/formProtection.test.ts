/**
 * The two form guards that can turn away a real customer: the spam filter and the time-trap.
 *
 * The filter is the dangerous one — a false positive silently refuses someone who only wanted to ask
 * a question — so the cases that must pass (an order number, a price, an email address written into
 * the message, the shop's own .eu domain) are pinned beside the ones that must not.
 */
import { describe, expect, test } from "bun:test";
import { looksLikeSpam, tooFast } from "../src/server/routes/forms.ts";

describe("looksLikeSpam — passes real messages", () => {
  test("plain question", () => {
    expect(looksLikeSpam(["Maria", "Order question", "Where is my order #10231? It has been a week."])).toBe(false);
  });

  test("an email address written into the message body", () => {
    expect(
      looksLikeSpam([
        "Maria",
        "",
        "Please reach me at jane.doe@example.com or call, I am usually home in the afternoon.",
      ]),
    ).toBe(false);
  });

  test("the shop's own .eu address", () => {
    expect(looksLikeSpam(["Kostas", "", "I read the note on prinscosmetic.eu but could not find the shade."])).toBe(
      false,
    );
  });

  test("prices, sizes and decimals", () => {
    expect(looksLikeSpam(["Ana", "Return", "I bought 2 x 30.5ml for 19.90 EUR and one bottle leaked."])).toBe(false);
  });

  test("empty input", () => {
    expect(looksLikeSpam(["", "", ""])).toBe(false);
  });
});

describe("looksLikeSpam — refuses junk", () => {
  test("an http link", () => {
    expect(looksLikeSpam(["", "", "Buy cheap here https://spam.example/xyz now"])).toBe(true);
  });

  test("a bare .com domain", () => {
    expect(looksLikeSpam(["", "", "Visit best-deals.com for offers"])).toBe(true);
  });

  test("the seo pitch", () => {
    expect(looksLikeSpam(["", "", "We can rank your website with quality backlinks"])).toBe(true);
  });

  test("a link in the name field", () => {
    expect(looksLikeSpam(["seo.agency.top", "", "hello"])).toBe(true);
  });
});

describe("tooFast", () => {
  test("a submission that never measured itself is refused", () => {
    expect(tooFast({})).toBe(true);
    expect(tooFast({ elapsedMs: "abc" })).toBe(true);
  });

  test("an instant submit is refused", () => {
    expect(tooFast({ elapsedMs: 120 })).toBe(true);
  });

  test("a form that sat open for a while is allowed", () => {
    expect(tooFast({ elapsedMs: 2500 })).toBe(false);
    expect(tooFast({ elapsedMs: 45_000 })).toBe(false);
  });
});
