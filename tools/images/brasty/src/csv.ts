import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import type { CsvProduct } from "./types.js";

const EAN_HEADER_RE =
  /^(ean|ean13|ean_13|barcode|bar_code|gtin|gtin13|upc|code)$/i;
const NAME_HEADER_RE =
  /^(name|product.?name|title|product|description|product_title|nazwa)$/i;
const EAN_VALUE_RE = /^\d{8,14}$/;

function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, "");
}

function normalizeHeader(h: string): string {
  return stripBom(h).trim();
}

function pickColumn(headers: string[], re: RegExp): string | null {
  for (const h of headers) {
    if (re.test(h)) return h;
  }
  return null;
}

/** Detect delimiter from the first non-empty line (; vs ,). */
async function detectDelimiter(filePath: string): Promise<"," | ";"> {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 4096 });
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      buf = buf.slice(0, nl);
      break;
    }
    if (buf.length > 8192) break;
  }
  stream.destroy();
  const line = stripBom(buf);
  const semis = (line.match(/;/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

/**
 * Read Brasty product CSV. Auto-detects EAN + name columns; tolerates BOM and
 * both comma and semicolon delimiters.
 */
export async function readProductsCsv(filePath: string): Promise<CsvProduct[]> {
  const delimiter = await detectDelimiter(filePath);

  const records: Record<string, string>[] = await new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    createReadStream(filePath)
      .pipe(
        parse({
          columns: (header: string[]) => header.map(normalizeHeader),
          delimiter,
          bom: true,
          relax_column_count: true,
          skip_empty_lines: true,
          trim: true,
        }),
      )
      .on("data", (row: Record<string, string>) => rows.push(row))
      .on("error", reject)
      .on("end", () => resolve(rows));
  });

  if (records.length === 0) {
    throw new Error(`CSV has no data rows: ${filePath}`);
  }

  const headers = Object.keys(records[0]!);
  let eanCol = pickColumn(headers, EAN_HEADER_RE);
  let nameCol = pickColumn(headers, NAME_HEADER_RE);

  // Fallback: scan first rows for an 8–14 digit column.
  if (!eanCol) {
    for (const h of headers) {
      const sample = records.slice(0, 20).map((r) => (r[h] ?? "").replace(/^'+/, "").trim());
      const hits = sample.filter((v) => EAN_VALUE_RE.test(v)).length;
      if (hits >= Math.min(5, sample.length) && hits / Math.max(sample.length, 1) >= 0.6) {
        eanCol = h;
        break;
      }
    }
  }

  if (!eanCol) {
    throw new Error(
      `Could not auto-detect EAN column in ${filePath}. Headers: ${headers.join(", ")}`,
    );
  }
  if (!nameCol) {
    nameCol =
      headers.find((h) => h !== eanCol && /name|title|product|desc/i.test(h)) ??
      headers.find((h) => h !== eanCol) ??
      eanCol;
  }

  const products: CsvProduct[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i]!;
    const ean = (row[eanCol] ?? "").replace(/^'+/, "").trim();
    if (!ean) continue;
    products.push({
      ean,
      name: (row[nameCol] ?? "").trim(),
      rowIndex: i + 1,
    });
  }

  return products;
}
