# Photo pack toolkit

Build lists, zip the live photos, serve **one download**, then the process exits so the
port is not left open.

Cadence for the shop itself is **Settings → Minutes between syncs** on the dashboard, not
a number in these scripts.

```bash
# 1. Lists only (no shop writes)
python3 build_index.py --inventory /path/to/dump --export-csv export.csv --out /path/to/pack

# 2. Zip is built outside git (JPEG bytes are gitignored)

# 3. Serve the zip on localhost, then it dies after the file is sent
PHOTO_PACK_ZIP=/path/to/sillage-photo-pack.zip ./start-serve.sh

# Stop early if you did not download:
./stop-serve.sh
```

Do **not** use `python3 -m http.server` on `0.0.0.0`. That is how a backup zip stayed
on the internet last time. `serve_zip.py` binds `127.0.0.1` unless you override it, and
it **exits after the zip is downloaded** (or after `--minutes`).

`files/scraped/` is unreviewed. Do not copy it onto the CDN until a human has looked.
