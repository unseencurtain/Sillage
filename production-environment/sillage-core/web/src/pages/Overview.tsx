import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDate } from "@/lib/utils";

export function Overview() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 15_000,
  });

  if (isLoading) return <p className="text-muted">Loading overview…</p>;
  if (error || !data) return <p className="text-danger">Failed to load overview</p>;

  const orderTotal = Object.values(data.ordersByStatus).reduce((a, b) => a + b, 0);
  const catalogVisible = data.catalogVisible ?? data.published;
  const hiddenFromCatalog = data.hiddenFromCatalog ?? Math.max(0, data.published - catalogVisible);
  const hiddenNoImage = data.hiddenNoImage ?? 0;
  const hiddenStock = data.hiddenStock ?? 0;
  const outOfStock = data.outOfStock ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted">Catalogue health, sync cadence, and order rails</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Visible in shop"
          value={catalogVisible.toLocaleString()}
          hint="catalog loop (not excluded)"
          accent
        />
        <KpiCard
          label="Published in WP"
          value={data.published.toLocaleString()}
          hint={
            hiddenFromCatalog > 0
              ? `${hiddenFromCatalog.toLocaleString()} hidden from catalog`
              : "all catalog-visible"
          }
        />
        <KpiCard label="Sillage products" value={data.products.toLocaleString()} />
        <KpiCard
          label="Sync"
          value={data.settings.syncEnabled ? "on" : "off"}
          hint={data.settings.dryRun ? "orders: dry-run" : "orders: LIVE"}
          accent={!data.settings.dryRun}
        />
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Catalogue visibility</h2>
          <span className="font-mono text-xs tabular-nums text-muted">
            {data.offers.toLocaleString()} active offers
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <VisibilityStat label="Visible in shop" value={catalogVisible} />
          <VisibilityStat label="Published (WP)" value={data.published} />
          <VisibilityStat
            label="Hidden from catalog"
            value={hiddenFromCatalog}
            hint={
              hiddenFromCatalog > 0
                ? [
                    hiddenNoImage > 0 ? `${hiddenNoImage.toLocaleString()} no/weak image` : null,
                    hiddenStock > 0 ? `${hiddenStock.toLocaleString()} stock threshold` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "exclude-from-catalog"
                : undefined
            }
          />
          <VisibilityStat
            label="Out of stock"
            value={outOfStock}
            hint={
              data.settings.hideProductsWithoutImage
                ? `hide without image on · threshold ${data.settings.stockThreshold ?? 0}`
                : `threshold ${data.settings.stockThreshold ?? 0}`
            }
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Last sync</h2>
            {data.lastSync ? <StatusBadge status={data.lastSync.status} /> : null}
          </div>
          {data.lastSync ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="font-mono text-muted">
                #{data.lastSync.id} · {data.lastSync.mode} · {data.lastSync.source}
              </div>
              <div className="text-muted">{fmtDate(data.lastSync.started_at)}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs tabular-nums sm:grid-cols-3">
                <span>fetched {data.lastSync.products_fetched}</span>
                <span>created {data.lastSync.posts_created}</span>
                <span>updated {data.lastSync.posts_updated}</span>
                <span>repriced {data.lastSync.prices_updated}</span>
                <span className={data.lastSync.errors ? "text-danger" : ""}>errors {data.lastSync.errors}</span>
                <span>{(data.lastSync.duration_ms / 1000).toFixed(1)}s</span>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No sync runs yet</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Vendor orders</h2>
            {orderTotal > 0 ? (
              <span className="font-mono text-xs tabular-nums text-muted">{orderTotal} total</span>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.keys(data.ordersByStatus).length === 0 ? (
              <p className="text-sm text-muted">No orders ingested yet</p>
            ) : (
              Object.entries(data.ordersByStatus).map(([status, n]) => (
                <div
                  key={status}
                  className="flex items-center gap-2 rounded-lg border border-line bg-canvas/40 px-3 py-2"
                >
                  <StatusBadge status={status} />
                  <span className="font-mono text-sm tabular-nums">{n}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-3 text-xs text-muted">
            <span>
              auto-dispatch{" "}
              <strong className={data.settings.autoDispatch ? "text-warn" : "text-ink"}>
                {data.settings.autoDispatch ? "on" : "off"}
              </strong>
            </span>
            <span>
              dry-run{" "}
              <strong className={data.settings.dryRun ? "text-ok" : "text-danger"}>
                {data.settings.dryRun ? "on" : "OFF"}
              </strong>
            </span>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Syncs · last 7 days</h2>
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.syncsLast7Days}>
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#5b6b7c" }} axisLine={{ stroke: "#e2e8ef" }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#5b6b7c" }} axisLine={{ stroke: "#e2e8ef" }} />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e2e8ef",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="n" fill="#0f766e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}

function VisibilityStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas/40 px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">
        {value.toLocaleString()}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
