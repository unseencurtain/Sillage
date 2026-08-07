import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { api, type SyncRun } from "@/lib/api";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { fmtDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

function isRunActive(run: SyncRun | undefined) {
  if (!run) return false;
  if (run.status === "running") return true;
  return run.finished_at == null || run.finished_at === "";
}

function isRunFinished(run: SyncRun) {
  if (run.finished_at) return true;
  return ["success", "partial", "error"].includes(run.status);
}

export function Sync() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  // Always keep page 1 warm so the running banner stays accurate while browsing history.
  const latest = useQuery({
    queryKey: ["sync-runs", 1],
    queryFn: () => api.syncRuns(1),
    refetchInterval: (query) => {
      const newest = query.state.data?.runs?.[0];
      return isRunActive(newest) ? 2_000 : 5_000;
    },
  });
  const list = useQuery({
    queryKey: ["sync-runs", page],
    queryFn: () => api.syncRuns(page),
    // Share cache with `latest` when page === 1.
  });

  const live = useQuery({
    queryKey: ["live-status"],
    queryFn: api.liveStatus,
    refetchInterval: 15_000,
  });

  const data = list.data;
  const isLoading = list.isLoading;
  const runs = data?.runs ?? [];
  const newest = latest.data?.runs?.[0];
  const syncRunning = isRunActive(newest);

  const run = useMutation({
    mutationFn: (mode: "fast" | "full") => api.runSync(mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast("Sync queued (live downloads still rate-limited)", "info");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const stop = useMutation({
    mutationFn: () => api.stopSync(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast(res.detail ?? "Sync stopped — enable Sync or press Run to start fresh", "info");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const lastRunSummary = useMemo(() => {
    if (!newest) return null;
    return {
      id: newest.id,
      status: newest.status,
      mode: newest.mode,
      source: newest.source,
      finished: isRunFinished(newest),
    };
  }, [newest]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sync</h1>
          <p className="text-sm text-muted">
            Scheduled at :00 and :30 · live downloads min {live.data?.liveFeedMinMinutes ?? "…"} min apart
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-danger/40 bg-red-50 px-3 py-2 text-sm font-medium text-danger hover:bg-red-100 disabled:opacity-50"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            <span className="inline-flex items-center gap-1.5">
              <Square size={14} />
              {stop.isPending ? "Stopping…" : "Stop all sync"}
            </span>
          </button>
          <button
            type="button"
            className="rounded-lg border border-line bg-panel px-3 py-2 text-sm font-medium hover:bg-canvas disabled:opacity-50"
            disabled={run.isPending || syncRunning}
            onClick={() => run.mutate("fast")}
          >
            Run fast sync
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
            disabled={run.isPending || syncRunning}
            onClick={() => run.mutate("full")}
          >
            Run full sync
          </button>
        </div>
      </header>

      {live.data ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["BeautyFort", live.data.beautyfort],
              ["BTS", live.data.bts],
            ] as const
          ).map(([name, v]) => (
            <div key={name} className="rounded-xl border border-line bg-panel px-4 py-3 text-sm">
              <div className="font-medium">{name} live API</div>
              <div className={cn("mt-1", v.allow ? "text-ok" : "text-amber-700")}>
                {v.allow ? "Live download allowed" : "Using cache / blocked"}
              </div>
              <div className="mt-1 text-xs text-muted">{v.reason}</div>
              <div className="mt-1 font-mono text-xs text-muted">
                max {v.maxPerDay}/day · cache age{" "}
                {v.cacheAgeMinutes == null ? "none" : `${v.cacheAgeMinutes}m`}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {syncRunning ? (
        <div className="flex items-center gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-sm">
          <Loader2 size={18} className="animate-spin text-accent" />
          <div>
            <div className="font-medium text-ink">Sync running…</div>
            <div className="text-muted">
              Run #{newest?.id} · {newest?.mode}/{newest?.source} — Stop aborts between batches
            </div>
          </div>
        </div>
      ) : null}

      {lastRunSummary ? (
        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            lastRunSummary.finished ? "border-line bg-panel" : "border-amber-200 bg-amber-50/60",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <RefreshCw size={16} className="text-muted" />
            <span className="text-sm font-medium">Last run</span>
            <StatusBadge status={lastRunSummary.status} />
            <span className="font-mono text-sm text-muted">
              #{lastRunSummary.id} · {lastRunSummary.mode}/{lastRunSummary.source}
            </span>
            {newest?.finished_at ? (
              <span className="text-sm text-muted">finished {fmtDate(newest.finished_at)}</span>
            ) : null}
          </div>
        </div>
      ) : null}

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
            ) : runs.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={7}>
                  No sync runs yet
                </td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr
                  key={r.id}
                  className={cn(
                    "border-b border-line/70 last:border-0",
                    r.id === newest?.id && syncRunning && "bg-teal-50/40",
                  )}
                >
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
                  <td className="px-4 py-3 font-mono tabular-nums">
                    {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted">{fmtDate(r.started_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data ? (
        <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
