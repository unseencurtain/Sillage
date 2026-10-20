/**
 * The public forms app is mounted at `/api/public` beside the reviews app. Its old wildcard body
 * limit therefore also ran for `/api/public/reviews` and capped a photo upload at 64 KB, long before
 * the review route's own 32 MB limit could see it. Keep the form limit on the form posts only.
 */
import { describe, expect, test } from "bun:test";
import { forms } from "../src/server/routes/forms.ts";

describe("public form body limit", () => {
  test("does not cap a request routed to another public app", async () => {
    const response = await forms.request("/reviews", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=review" },
      body: new Uint8Array(100 * 1024),
    });

    // There is no `/reviews` route in this app; the point is that the form limit did not answer
    // 413 before the request could fall through to the reviews app.
    expect(response.status).toBe(404);
  });

  test("still refuses an oversized form post", async () => {
    const response = await forms.request("/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(100 * 1024) }),
    });

    expect(response.status).toBe(413);
  });
});
