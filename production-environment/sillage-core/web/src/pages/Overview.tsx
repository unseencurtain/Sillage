import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDate } from "@/lib/utils";

export function Overview() {
  const { data, isLoading, error } = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });

  if (isLoading) return <p className="text-muted">Loading overview…</p>;
  if (error || !data) return <p className="text-danger">Failed to load overview</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted">Catalogue health, sync cadence, and order rails</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Published products" value={data.published.toLocaleString()} />
        <KpiCard label="Sillage products" value={data.products.toLocaleString()} />
        <KpiCard label="Active offers" value={data.offers.toLocaleString()} />
        <KpiCard
          label="Sync"
          value={data.settings.syncEnabled ? "on" : "off"}
          hint={data.settings.dryRun ? "orders: dry-run" : "orders: LIVE"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <h2 className="text-sm font-medium">Last sync</h2>
          {data.lastSync ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={data.lastSync.status} />
                <span className="font-mono text-muted">
                  #{data.lastSync.id} · {data.lastSync.mode} · {data.lastSync.source}
                </span>
              </div>
              <div className="text-muted">{fmtDate(data.lastSync.started_at)}</div>
              <div className="font-mono tabular-nums">
                fetched {data.lastSync.products_fetched} · created {data.lastSync.posts_created} · updated{" "}
                {data.lastSync.posts_updated} · repriced {data.lastSync.prices_updated} · errors{" "}
                {data.lastSync.errors}
              </div>
              <div className="text-muted">{(data.lastSync.duration_ms / 1000).toFixed(1)}s</div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No sync runs yet</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <h2 className="text-sm font-medium">Vendor orders</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.keys(data.ordersByStatus).length === 0 ? (
              <p className="text-sm text-muted">No orders ingested yet</p>
            ) : (
              Object.entries(data.ordersByStatus).map(([status, n]) => (
                <div key={status} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                  <StatusBadge status={status} />
                  <span className="font-mono text-sm tabular-nums">{n}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-4 text-xs text-muted">
            auto-dispatch {data.settings.autoDispatch ? "on" : "off"} · dry-run{" "}
            {data.settings.dryRun ? "on" : "OFF"}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-medium">Syncs · last 7 days</h2>
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.syncsLast7Days}>
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="n" fill="#0f766e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
