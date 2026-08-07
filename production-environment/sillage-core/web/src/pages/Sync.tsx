import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDate } from "@/lib/utils";

export function Sync() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["sync-runs"],
    queryFn: api.syncRuns,
    refetchInterval: 5_000,
  });
  const run = useMutation({
    mutationFn: (mode: "fast" | "full") => api.runSync(mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-runs"] }),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sync</h1>
          <p className="text-sm text-muted">Catalogue import runs and manual triggers</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:bg-canvas"
            disabled={run.isPending}
            onClick={() => run.mutate("fast")}
          >
            Run fast sync
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-60"
            disabled={run.isPending}
            onClick={() => run.mutate("full")}
          >
            Run full sync
          </button>
        </div>
      </header>

      {run.isSuccess ? <p className="text-sm text-ok">Sync started — refresh is automatic</p> : null}

      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Fetched</th>
              <th className="px-4 py-3">Writes</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Started</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : (
              (data?.runs ?? []).map((r) => (
                <tr key={r.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-3 font-mono tabular-nums">#{r.id}</td>
                  <td className="px-4 py-3 font-mono">
                    {r.mode}/{r.source}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{r.products_fetched}</td>
                  <td className="px-4 py-3 font-mono tabular-nums text-muted">
                    +{r.posts_created} ~{r.posts_updated} $ {r.prices_updated}
                    {r.errors ? ` !${r.errors}` : ""}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{(r.duration_ms / 1000).toFixed(1)}s</td>
                  <td className="px-4 py-3 text-muted">{fmtDate(r.started_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
