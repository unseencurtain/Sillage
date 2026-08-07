# 10 - Repetition Playbook (Build It Multiple Times)

Use this to intentionally rebuild and improve skill.

## Iteration schedule

1. **Run 1:** Express + SSR HTML (baseline)
2. **Run 2:** Express + HTMX (partial updates)
3. **Run 3:** Hono + SSR HTML (framework translation)
4. **Run 4:** Hono + Alpine (light client state)
5. **Run 5:** API-first + React (separated frontend)

## Learning objective per run

1. Run 1: data model + route orchestration
2. Run 2: progressive enhancement and endpoint design
3. Run 3: portability of business logic
4. Run 4: UI state discipline without SPA overhead
5. Run 5: API contracts, auth boundary, client state

## Scoring rubric (self-review)

Score each area 1-5:
1. Domain correctness (sync/order/tracking)
2. Error handling quality
3. Code organization and reuse
4. Test coverage quality
5. Security baseline (auth/authz/csrf/token safety)
6. UX under latency

## Rebuild rule

Do not copy previous run files directly. Recreate from docs + memory, then compare.

## Definition of mastery

You can:
1. Build core system in either Express or Hono from scratch.
2. Swap UI strategy without changing domain logic.
3. Add auth/authz cleanly.
4. Diagnose slow checkout/sync/tracking issues confidently.
