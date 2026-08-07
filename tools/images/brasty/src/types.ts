/** Shared types for the Brasty image tool. */

export type LogCategory =
  | "downloaded"
  | "already_exists"
  | "missing_image"
  | "search_failed"
  | "hover_failed"
  | "network_timeout"
  | "unexpected_page_structure";

export type ManifestStatus =
  | "downloaded"
  | "already_exists"
  | "missing_image"
  | "search_failed"
  | "hover_failed"
  | "network_timeout"
  | "unexpected_page_structure"
  | "skipped";

export interface ManifestEntry {
  ean: string;
  status: ManifestStatus;
  outputPath?: string;
  imageUrl?: string;
  error?: string;
  at: string;
}

export interface CsvProduct {
  ean: string;
  name: string;
  rowIndex: number;
}

export interface SearchResult {
  ok: true;
  rowLocator: import("playwright").Locator;
  matchedEan: string;
}

export interface SearchFailure {
  ok: false;
  reason: "not_found" | "ambiguous" | "ean_mismatch" | "page_structure";
  detail: string;
}

export type SearchOutcome = SearchResult | SearchFailure;

export type LogoPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "center";

/**
 * Pluggable image extraction strategy.
 * Implement a concrete strategy only after `npm run investigate` findings
 * identify how Brasty exposes the large preview URL.
 */
export interface ExtractionStrategy {
  /** Short identifier recorded in logs / findings. */
  name: string;
  /**
   * Resolve the highest-quality image URL for the currently matched product row.
   * Must return a downloadable absolute URL, or null if no image is available.
   */
  extract(ctx: ExtractionContext): Promise<string | null>;
}

export interface ExtractionContext {
  page: import("playwright").Page;
  row: import("playwright").Locator;
  ean: string;
  /** Network traffic observed since search / hover began. */
  network: NetworkCapture;
}

export interface NetworkCapture {
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  imageUrls(): string[];
  jsonEndpoints(): CapturedResponse[];
  clear(): void;
}

export interface CapturedRequest {
  url: string;
  method: string;
  resourceType: string;
  at: string;
}

export interface CapturedResponse {
  url: string;
  status: number;
  contentType: string;
  resourceType: string;
  bodyPreview?: string;
  at: string;
}

export interface InvestigateFindings {
  generatedAt: string;
  baseUrl: string;
  eans: string[];
  sessionValid: boolean;
  questions: InvestigateQuestion[];
  thumbnailToFullSizeHints: string[];
  recommendedStrategy: string;
  notes: string[];
}

export interface InvestigateQuestion {
  id: string;
  question: string;
  answer: "yes" | "no" | "unknown" | "partial";
  evidence: string[];
}
