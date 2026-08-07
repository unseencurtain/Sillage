import type { Page, Request, Response } from "playwright";
import type {
  CapturedRequest,
  CapturedResponse,
  NetworkCapture,
} from "./types.js";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|$)/i;
const IMAGE_CT = /^image\//i;

/**
 * Attach request/response listeners to a page for investigation and extraction.
 * Prefer this over guessing DOM structure — network evidence is authoritative.
 */
export function attachNetworkCapture(page: Page): NetworkCapture & { dispose: () => void } {
  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];

  const onRequest = (req: Request): void => {
    requests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      at: new Date().toISOString(),
    });
  };

  const onResponse = async (res: Response): Promise<void> => {
    const headers = res.headers();
    const contentType = headers["content-type"] ?? "";
    const entry: CapturedResponse = {
      url: res.url(),
      status: res.status(),
      contentType,
      resourceType: res.request().resourceType(),
      at: new Date().toISOString(),
    };

    // Capture small JSON bodies for API discovery (investigation only).
    if (
      contentType.includes("application/json") ||
      contentType.includes("text/json") ||
      /\.json(\?|$)/i.test(res.url())
    ) {
      try {
        const text = await res.text();
        entry.bodyPreview = text.slice(0, 4000);
      } catch {
        // Body may be unavailable (download, CORS, navigation race).
      }
    }

    responses.push(entry);
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    requests,
    responses,
    imageUrls(): string[] {
      const urls = new Set<string>();
      for (const r of requests) {
        if (r.resourceType === "image" || IMAGE_EXT.test(r.url)) urls.add(r.url);
      }
      for (const r of responses) {
        if (
          r.resourceType === "image" ||
          IMAGE_CT.test(r.contentType) ||
          IMAGE_EXT.test(r.url)
        ) {
          urls.add(r.url);
        }
      }
      return [...urls];
    },
    jsonEndpoints(): CapturedResponse[] {
      return responses.filter(
        (r) =>
          r.contentType.includes("json") ||
          /\.json(\?|$)/i.test(r.url) ||
          Boolean(r.bodyPreview),
      );
    },
    clear(): void {
      requests.length = 0;
      responses.length = 0;
    },
    dispose(): void {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}
