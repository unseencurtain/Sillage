/**
 * Ocean (wholesale-perfumes.eu) HTTP Basic client.
 *
 * Feeds: catalog XML (daily) and store XML (hourly price/stock).
 * Order API: account-global cart → submit. There is no sandbox — callers must honour dry-run.
 *
 * Never call this against the live host from tests. Use parseCatalogXml / parseStoreXml on fixtures.
 */
import { XMLParser } from "fast-xml-parser";

export interface OceanClientConfig {
  /** E-shop login email. */
  user: string;
  /** API token from user settings (not the shop password). */
  token: string;
  catalogUrl: string;
  storeUrl: string;
  /** Base for cart/order API, e.g. https://www.wholesale-perfumes.eu/api/v1 */
  apiBaseUrl: string;
  timeout?: number;
}

export interface OceanCatalogProduct {
  id: string;
  ean: string;
  allEans: string[];
  typeId: string | null;
  typeName: string | null;
  brandId: string | null;
  brand: string | null;
  series: string | null;
  model: string | null;
  gender: string | null;
  volume: string | null;
  volumeUnit: string | null;
  typeInfo: string | null;
  nameAddon: string | null;
  setComposition: string | null;
  flaskFront: string | null;
  pictureUrls: string[];
  scents: { top: string[]; middle: string[]; base: string[] };
  params: Record<string, string[]>;
  /** Joined from the store feed when available. */
  priceNoVat?: number;
  quantity?: number;
}

export interface OceanStoreProduct {
  id: string;
  priceNoVat: number;
  quantity: number;
}

export interface OceanCartLine {
  code: string | number;
  quantity: number;
}

export class OceanRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OceanRequestError";
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep numeric-looking EANs and ids as strings — leading zeros matter.
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    name === "product" ||
    name === "ean" ||
    name === "scent" ||
    name === "value" ||
    name === "param",
});

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (typeof value === "object" && value !== null && "#text" in value) {
    return String((value as { "#text": unknown })["#text"] ?? "").trim();
  }
  return "";
}

function asAttr(value: unknown, attr: string): string {
  if (!value || typeof value !== "object") return "";
  return String((value as Record<string, unknown>)[`@_${attr}`] ?? "").trim();
}

function textList(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const one = asText(value);
  return one ? [one] : [];
}

function firstPicture(pictures: unknown): { flaskFront: string | null; urls: string[] } {
  if (!pictures || typeof pictures !== "object") return { flaskFront: null, urls: [] };
  const obj = pictures as Record<string, unknown>;
  const urls: string[] = [];
  let flaskFront: string | null = null;
  for (const [slot, raw] of Object.entries(obj)) {
    const url = asText(raw);
    if (!url || url === "...") continue;
    urls.push(url);
    if (slot === "flask_front") flaskFront = url;
  }
  return { flaskFront, urls };
}

function parseScents(raw: unknown): OceanCatalogProduct["scents"] {
  const empty = { top: [] as string[], middle: [] as string[], base: [] as string[] };
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  return {
    top: textList((obj.top as { scent?: unknown } | undefined)?.scent ?? obj.top),
    middle: textList((obj.middle as { scent?: unknown } | undefined)?.scent ?? obj.middle),
    base: textList((obj.base as { scent?: unknown } | undefined)?.scent ?? obj.base),
  };
}

function parseParams(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  const params = (raw as { param?: unknown }).param;
  const list = Array.isArray(params) ? params : params ? [params] : [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const name = asAttr(p, "name") || asText((p as { name?: unknown }).name);
    if (!name) continue;
    out[name] = textList((p as { value?: unknown }).value);
  }
  return out;
}

export function parseCatalogXml(xml: string): OceanCatalogProduct[] {
  const doc = xmlParser.parse(xml) as { catalog?: { product?: unknown } };
  const products = doc?.catalog?.product;
  const list = Array.isArray(products) ? products : products ? [products] : [];
  const out: OceanCatalogProduct[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = asText(r.id);
    if (!id) continue;

    const allEansNode = r.all_eans as { ean?: unknown } | undefined;
    const fromAll = textList(allEansNode?.ean);
    const primary = asText(r.ean);
    const allEans = [...new Set([...(primary ? [primary] : []), ...fromAll].filter((e) => /^\d+$/.test(e)))];

    const typeRaw = r.type;
    const brandRaw = r.brand;
    const volumeRaw = r.volume;
    const pics = firstPicture(r.pictures);
    const setRaw = r.set as { composition?: unknown } | undefined;

    out.push({
      id,
      ean: primary,
      allEans,
      typeId: asAttr(typeRaw, "id") || null,
      typeName: asText(typeRaw) || null,
      brandId: asAttr(brandRaw, "id") || null,
      brand: asText(brandRaw) || null,
      series: asText(r.series) || null,
      model: asText(r.model) || null,
      gender: asText(r.gender) || null,
      volume: asText(volumeRaw) || null,
      volumeUnit: asAttr(volumeRaw, "unit") || null,
      typeInfo: asText(r.type_info) || null,
      nameAddon: asText(r.name_addon) || null,
      setComposition: asText(setRaw?.composition) || null,
      flaskFront: pics.flaskFront,
      pictureUrls: pics.urls,
      scents: parseScents(r.scents),
      params: parseParams(r.params),
    });
  }
  return out;
}

export function parseStoreXml(xml: string): OceanStoreProduct[] {
  const doc = xmlParser.parse(xml) as { store?: { product?: unknown } };
  const products = doc?.store?.product;
  const list = Array.isArray(products) ? products : products ? [products] : [];
  const out: OceanStoreProduct[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = asText(r.id);
    if (!id) continue;
    const priceNoVat = Number.parseFloat(asText(r.price_no_vat));
    const quantity = Number.parseInt(asText(r.quantity), 10);
    out.push({
      id,
      priceNoVat: Number.isFinite(priceNoVat) ? priceNoVat : 0,
      quantity: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
    });
  }
  return out;
}

export class OceanClient {
  private readonly user: string;
  private readonly token: string;
  private readonly catalogUrl: string;
  private readonly storeUrl: string;
  private readonly apiBaseUrl: string;
  private readonly timeout: number;

  constructor(config: OceanClientConfig) {
    if (!config.user || !config.token) {
      throw new OceanRequestError("OCEAN_USER and OCEAN_TOKEN are required for live Ocean calls");
    }
    this.user = config.user;
    this.token = config.token;
    this.catalogUrl = config.catalogUrl;
    this.storeUrl = config.storeUrl;
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? 120_000;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.user}:${this.token}`).toString("base64")}`;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json, application/xml, text/xml, */*",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!res.ok) {
        throw new OceanRequestError(`Ocean ${method} ${url} failed: HTTP ${res.status}`, res.status, json ?? text);
      }
      return { status: res.status, text, json };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchCatalogXml(): Promise<string> {
    const { text } = await this.request("GET", this.catalogUrl);
    return text;
  }

  async fetchStoreXml(): Promise<string> {
    const { text } = await this.request("GET", this.storeUrl);
    return text;
  }

  async fetchCatalog(): Promise<OceanCatalogProduct[]> {
    return parseCatalogXml(await this.fetchCatalogXml());
  }

  async fetchStore(): Promise<OceanStoreProduct[]> {
    return parseStoreXml(await this.fetchStoreXml());
  }

  /** Empty the account-global cart. Mutates shared vendor state. */
  async clearCart(): Promise<unknown> {
    const { json, text } = await this.request("DELETE", `${this.apiBaseUrl}/cart`);
    return json ?? text;
  }

  /** Insert lines into the account-global cart. */
  async addToCart(lines: OceanCartLine[]): Promise<unknown> {
    const { json, text } = await this.request("POST", `${this.apiBaseUrl}/cart`, lines);
    return json ?? text;
  }

  async getCart(): Promise<unknown> {
    const { json, text } = await this.request("GET", `${this.apiBaseUrl}/cart`);
    return json ?? text;
  }

  async submitCart(): Promise<unknown> {
    const { json, text } = await this.request("POST", `${this.apiBaseUrl}/cart/submit`);
    return json ?? text;
  }

  async getOrder(orderNumber: string): Promise<unknown> {
    const { json, text } = await this.request(
      "GET",
      `${this.apiBaseUrl}/order/${encodeURIComponent(orderNumber)}`,
    );
    return json ?? text;
  }
}
