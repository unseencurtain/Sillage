import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function Vendors() {
  const { data, isLoading } = useQuery({ queryKey: ["vendors"], queryFn: api.vendors });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <p className="text-sm text-muted">Price multipliers, stock thresholds, shipping coverage</p>
      </header>

      {isLoading ? <p className="text-muted">Loading…</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {(data?.vendors ?? []).map((v) => (
          <article key={v.id} className="rounded-xl border border-line bg-panel p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{v.name}</h2>
                <div className="font-mono text-xs text-muted">
                  {v.slug} · SKU {v.skuPrefix}-*
                </div>
              </div>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                  v.active ? "bg-emerald-50 text-ok ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200"
                }`}
              >
                {v.active ? "active" : "inactive"}
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted">Multiplier</dt>
                <dd className="font-mono tabular-nums">{v.priceMultiplier}</dd>
              </div>
              <div>
                <dt className="text-muted">Min stock</dt>
                <dd className="font-mono tabular-nums">{v.minVisibleStock}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted">Ships to ({v.serviceableCountries.length})</dt>
                <dd className="mt-1 font-mono text-xs leading-5">{v.serviceableCountries.join(" ")}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}
