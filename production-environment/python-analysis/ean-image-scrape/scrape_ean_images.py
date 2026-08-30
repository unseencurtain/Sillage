#!/usr/bin/env python3
"""Download product photos by barcode only.

Lookups are GTIN/EAN/UPC. We never search by name or brand. A source hit is
kept only when the returned barcode matches ours (leading zeros ignored).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from barcodes import codes_match, lookup_variants, normalize_ean  # noqa: E402

UA = (
    "SillageEanImageScrape/1.0 "
    "(+https://github.com/unseencurtain/Sillage; barcode-only shop photos)"
)
MIN_BYTES = 3500
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

OFF_HOSTS = (
    "world.openbeautyfacts.org",
    "world.openproductsfacts.org",
    "world.openfoodfacts.org",
)


def http_get(url: str, ua: str = UA, timeout: int = 25) -> tuple[int, bytes, str]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": ua, "Accept": "*/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type") or ""
            return resp.status, resp.read(), ctype
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        return exc.code, body, exc.headers.get("Content-Type") or ""


def json_get(url: str, ua: str = UA) -> tuple[int, dict | None]:
    status, body, ctype = http_get(url, ua=ua)
    if status != 200 or "json" not in ctype and not body.startswith(b"{"):
        return status, None
    try:
        return status, json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return status, None


def pick_off_image(product: dict) -> str | None:
    for key in ("image_front_url", "image_url"):
        val = product.get(key)
        if isinstance(val, str) and val.startswith("http"):
            return val
    selected = product.get("selected_images") or {}
    front = (selected.get("front") or {}).get("display") or {}
    if isinstance(front, dict):
        for val in front.values():
            if isinstance(val, str) and val.startswith("http"):
                return val
    return None


def primary_codes(ean: str) -> list[str]:
    """Two lookup forms only: stored digits and 13-digit padded. Still EAN-only."""
    variants = lookup_variants(ean)
    if not variants:
        return []
    padded = next((v for v in variants if len(v) == 13), variants[0].zfill(13))
    out: list[str] = []
    for code in (padded, variants[0]):
        if code not in out:
            out.append(code)
    return out


def lookup_open_facts(ean: str) -> dict | None:
    codes = primary_codes(ean)
    for host in OFF_HOSTS:
        for code in codes:
            url = f"https://{host}/api/v0/product/{code}.json"
            status, data = json_get(url)
            if status != 200 or not data or data.get("status") != 1:
                continue
            product = data.get("product") or {}
            found_code = str(data.get("code") or product.get("code") or "")
            if not codes_match(found_code, ean):
                continue
            img = pick_off_image(product)
            if not img:
                continue
            return {
                "source": host,
                "image_url": img,
                "found_code": found_code,
                "found_name": (product.get("product_name") or "")[:200],
            }
    return None


def lookup_goupc(ean: str) -> dict | None:
    for code in primary_codes(ean):
        status, body, _ = http_get(f"https://go-upc.com/search?q={code}", ua=BROWSER_UA)
        if status != 200:
            continue
        html = body.decode("utf-8", "replace")
        if re.search(r"product not found|no product|invalid value", html, re.I):
            continue
        title = re.search(r"<title>([^<]+)", html, re.I)
        title_text = title.group(1) if title else ""
        page_codes = re.findall(r"\b(\d{8,14})\b", title_text + " " + html[:4000])
        if not any(codes_match(c, ean) for c in page_codes):
            continue
        images = re.findall(r"https://go-upc\.s3\.amazonaws\.com/images/[^\"'\s]+", html)
        images = [u for u in images if not u.lower().endswith((".png", ".ico", ".svg"))]
        if not images:
            og = re.findall(r'property="og:image"\s+content="([^"]+)"', html)
            images = [u for u in og if "favicon" not in u]
        if not images:
            continue
        return {
            "source": "go-upc.com",
            "image_url": images[0],
            "found_code": code,
            "found_name": title_text[:200],
        }
    return None


def download_image(url: str) -> bytes | None:
    status, body, ctype = http_get(url, ua=BROWSER_UA)
    if status != 200 or len(body) < MIN_BYTES:
        return None
    if "image" not in ctype and not body.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        # Some CDNs omit content-type; accept JPEG/PNG/WebP magic.
        if not body.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
            return None
    return body


def dest_name(ean: str, url: str) -> str:
    norm = normalize_ean(ean) or digits_only_local(ean)
    ext = Path(urlparse(url).path).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    if ext == ".jpeg":
        ext = ".jpg"
    return f"{norm}{ext}"


def digits_only_local(raw: str) -> str:
    return "".join(ch for ch in raw if ch.isdigit())


def already_done(progress_path: Path) -> set[str]:
    done: set[str] = set()
    if not progress_path.exists():
        return done
    with progress_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            ean = normalize_ean(row.get("lookup_ean"))
            if ean and row.get("status") in {"found", "miss"}:
                done.add(ean)
    return done


def append_progress(path: Path, lock: Lock, row: dict) -> None:
    with lock:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def scrape_one(lookup_ean: str) -> dict:
    hit = lookup_open_facts(lookup_ean) or lookup_goupc(lookup_ean)
    if not hit:
        return {"lookup_ean": lookup_ean, "status": "miss"}
    blob = download_image(hit["image_url"])
    if not blob:
        return {
            "lookup_ean": lookup_ean,
            "status": "miss",
            "reason": "download_failed",
            "source": hit["source"],
            "image_url": hit["image_url"],
        }
    filename = dest_name(lookup_ean, hit["image_url"])
    return {
        "lookup_ean": lookup_ean,
        "status": "found",
        "source": hit["source"],
        "image_url": hit["image_url"],
        "found_code": hit.get("found_code"),
        "found_name": hit.get("found_name"),
        "filename": filename,
        "bytes": len(blob),
        "_blob": blob,
    }


def unique_eans(csv_path: Path) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    with csv_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            ean = row.get("lookup_ean") or row.get("primary_ean") or ""
            norm = normalize_ean(ean)
            if not norm or norm in seen:
                continue
            seen.add(norm)
            ordered.append(ean.strip())
    return ordered


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work-dir", default=os.path.expanduser("~/sillage/ean-image-scrape"))
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    work = Path(args.work_dir)
    csv_path = work / "missing-products.csv"
    scraped = work / "scraped"
    reports = work / "reports"
    scraped.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)
    progress_path = reports / "progress.jsonl"

    eans = unique_eans(csv_path)
    if args.limit:
        eans = eans[: args.limit]
    done = already_done(progress_path)
    todo = [e for e in eans if (normalize_ean(e) or e) not in done]
    print(f"unique={len(eans)} already={len(done)} todo={len(todo)} workers={args.workers}")

    lock = Lock()
    found = 0
    miss = 0
    workers = max(1, min(args.workers, 10))

    def run(ean: str) -> dict:
        time.sleep(0.05)
        return scrape_one(ean)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(run, ean): ean for ean in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            row = fut.result()
            blob = row.pop("_blob", None)
            if row.get("status") == "found" and blob and row.get("filename"):
                (scraped / row["filename"]).write_bytes(blob)
                found += 1
            else:
                miss += 1
            append_progress(progress_path, lock, row)
            if i % 50 == 0 or i == len(todo):
                print(f"progress {i}/{len(todo)} found={found} miss={miss}", flush=True)

    summary = {
        "todo": len(todo),
        "found": found,
        "miss": miss,
        "scraped_dir": str(scraped),
    }
    (reports / "scrape-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
