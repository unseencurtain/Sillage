# Photo inventory (selected target VPS)

Live lists are built **on the VPS**, not on a laptop agent VM:

```bash
SSH_ALIAS="your-configured-ssh-alias"
ssh "$SSH_ALIAS"
bash ~/sillage/python-analysis/photo-pack/run_on_vps.sh
# writes ~/photo-inventory/ (CSVs + COUNTS.json)
```

That does not change the shop. `scraped/` is unreviewed. Do not copy it onto the CDN
until a human has looked. Do not open extra firewall ports to serve zips — `scp` from
the VPS, or copy files that already live in `~/ecom_sites/data/media/`.
