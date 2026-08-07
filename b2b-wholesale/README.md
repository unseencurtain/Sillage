# B2B moved — use the dedicated repo

Operator decision: B2B is **not** a forever folder in this retail tree.

**Canonical project:** [github.com/unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b)

That repo holds:

- `docs/wholesale-perfumes-api.md`
- `env/.env.example` (`WHOLESALE_PERFUMES_*`)
- Extracted connector / order adapter / tests / migrations under `sillage-vendor/`

## This retail shop

Sillage + `cosmetic.slilverbelt.xyz` sell **BeautyFort + BTS only**. wholesale-perfumes stays
parked (`active=0`, excluded from `--vendor=all`). Do not re-enable it here.

A copy of the connector may still exist under `production-environment/sillage-core/` for history
and offline tests until it is deleted in a follow-up. Prefer the **sillage-b2b** tree for all new
B2B work.

Split from tag `pre-scratch-20260808` on this repo.
