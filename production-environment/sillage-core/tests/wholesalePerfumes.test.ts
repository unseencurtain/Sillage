import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeWholesalePerfumesName,
  formatWholesalePerfumesVolume,
  joinCatalogAndStore,
  mapWholesalePerfumesGender,
  WholesalePerfumesConnector,
} from "../src/vendors/wholesale-perfumes/connector.ts";
import { parseCatalogXml, parseStoreXml } from "../src/vendors/wholesale-perfumes/WholesalePerfumesClient.ts";

const fixtures = join(import.meta.dir, "fixtures");

describe("wholesale-perfumes XML parse + normalize", () => {
  test("multi-EAN fan-out preserves leading-zero EANs as strings", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");

    const joined = joinCatalogAndStore(catalog, store);
    const first = connector.normalize(joined[0]!);
    expect(first).not.toBeNull();
    expect(first!.eans).toEqual(["01231231231234", "4564564564567", "7897897897891"]);
    expect(first!.eans[0]).toBe("01231231231234");
    expect(typeof first!.eans[0]).toBe("string");

    const leading = connector.normalize(joined.find((p) => p.id === "4")!);
    expect(leading!.eans).toEqual(["0000123456789"]);
    expect(leading!.eans[0]!.startsWith("0000")).toBe(true);
  });

  test("composes name from brand, series, model and name_addon", () => {
    expect(
      composeWholesalePerfumesName({
        brand: "Giorgio Armani",
        series: "Emporio RED White",
        model: "Intense",
        nameAddon: "For Men",
      }),
    ).toBe("Giorgio Armani Emporio RED White Intense For Men");
    expect(
      composeWholesalePerfumesName({ brand: "Dior", series: "Sauvage", model: null, nameAddon: null }),
    ).toBe("Dior Sauvage");
  });

  test("parses volume with unit and maps gender / type attributes", async () => {
    expect(formatWholesalePerfumesVolume("100", "ml")).toBe("100 ml");
    expect(mapWholesalePerfumesGender("M")).toBe("Men");
    expect(mapWholesalePerfumesGender("F")).toBe("Women");
    expect(mapWholesalePerfumesGender("U")).toBe("Unisex");
    expect(mapWholesalePerfumesGender("W")).toBe("Women");

    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const p = connector.normalize(joinCatalogAndStore(catalog, store)[0]!);
    expect(p!.attributes["volume"]).toBe("100 ml");
    expect(p!.attributes["gender"]).toBe("Men");
    expect(p!.attributes["type"]).toBe("Eau de Toilette");
    expect(p!.sku).toBe("WPF-1");
    expect(p!.vendorPrice).toBe(125.64);
    expect(p!.stock).toBe(10);
    expect(p!.imageUrl).toContain("HQlgckCAqXUZdlXzHgtlzQ");
  });

  test("product missing flask_front has null imageUrl", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const joined = joinCatalogAndStore(catalog, store);

    // id 3 has only <other>, no flask_front
    const noFlask = connector.normalize(joined.find((p) => p.id === "3")!);
    expect(noFlask!.imageUrl).toBeNull();

    // id 4 has empty <pictures>
    const emptyPics = connector.normalize(joined.find((p) => p.id === "4")!);
    expect(emptyPics!.imageUrl).toBeNull();
  });

  test("joins catalog to store on id and drops rows without a positive price", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const normalized = joinCatalogAndStore(catalog, store)
      .map((r) => connector.normalize(r))
      .filter((p) => p !== null);
    expect(normalized.length).toBe(4);
    expect(normalized.every((p) => p.sku.startsWith("WPF-"))).toBe(true);
  });
});
