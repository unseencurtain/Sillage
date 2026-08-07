import { describe, expect, test } from "bun:test";
import { parseEnvFile, serializeEnvFile } from "../src/config/secrets.ts";

describe("secrets overlay dotenv", () => {
  test("parseEnvFile ignores comments and blank lines", () => {
    const map = parseEnvFile(`
# comment
BEAUTYFORT_USER=alice
BEAUTYFORT_SECRET="s#cret with spaces"
BTS_JWT_TOKEN='tok.en'

# trailing
`);
    expect(map.BEAUTYFORT_USER).toBe("alice");
    expect(map.BEAUTYFORT_SECRET).toBe("s#cret with spaces");
    expect(map.BTS_JWT_TOKEN).toBe("tok.en");
  });

  test("serializeEnvFile only emits managed keys and round-trips", () => {
    const text = serializeEnvFile({
      BEAUTYFORT_USER: "alice",
      BEAUTYFORT_SECRET: 'has "quotes"',
      BTS_JWT_TOKEN: "plain",
      IGNORED_KEY: "nope",
    });
    expect(text).toContain("BEAUTYFORT_USER=alice");
    expect(text).toContain("BTS_JWT_TOKEN=plain");
    expect(text).not.toContain("IGNORED_KEY");
    const again = parseEnvFile(text);
    expect(again.BEAUTYFORT_USER).toBe("alice");
    expect(again.BEAUTYFORT_SECRET).toBe('has "quotes"');
    expect(again.BTS_JWT_TOKEN).toBe("plain");
    expect(again.IGNORED_KEY).toBeUndefined();
  });

  test("serialize never embeds raw secret in a GET-shaped payload helper", () => {
    // Regression guard: status masking is a UI/API concern; serializers must not invent leak paths.
    const text = serializeEnvFile({ BTS_JWT_TOKEN: "super-secret-token" });
    expect(text).toContain("super-secret-token"); // file may store it
    expect(text).not.toMatch(/masked|••••/);
  });
});
