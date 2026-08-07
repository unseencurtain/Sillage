import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { api, type SyncRun } from "@/lib/api";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { cn, useFmtDate } from "@/lib/utils";

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
  const fmtDate = useFmtDate();
  const [page, setPage] = useState(1);
  const watchingRunId = useRef<number | null>(null);

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
  });

  const live = useQuery({
    queryKey: ["live-status"],
    queryFn: api.liveStatus,
    refetchInterval: 15_000,
  });

  const secrets = useQuery({
    queryKey: ["secrets"],
    queryFn: api.secrets,
  });

  const data = list.data;
  const isLoading = list.isLoading;
  const runs = data?.runs ?? [];
  const newest = latest.data?.runs?.[0];
  const syncRunning = isRunActive(newest);
  const secretsMissing = (secrets.data?.secrets ?? []).filter((s) => !s.set);

  const run = useMutation({
    mutationFn: (opts: { mode: "fast" | "full"; demo?: boolean }) =>
      api.runSync(opts.mode, opts.demo ? { vendors: ["beautyfort", "bts"] } : undefined),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      if (res.alreadyRunning || res.started === false) {
        toast(
          res.detail ??
            "Sync already running — your new prices will apply when it finishes (or open Sync to watch progress).",
          "info",
        );
        return;
      }
      toast(
        vars.demo
          ? "Sync started — BeautyFort + BTS. Watch progress below."
          : vars.mode === "full"
            ? "Full sync started — taxonomy + vanish + catalogue rewrite (live downloads still rate-limited)."
            : "Fast sync started — prices/stock for active retail vendors (live downloads still rate-limited).",
        "ok",
      );
      watchingRunId.current = -1;
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const stop = useMutation({
    mutationFn: () => api.stopSync(),
    onSuccess: (res) => {
      watchingRunId.current = null;
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast(res.detail ?? "Sync stopped — Sync enabled is off until you Run again", "info");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const starting = run.isPending;
  const busy = starting || syncRunning;

  useEffect(() => {
    if (watchingRunId.current === -1 && newest && isRunActive(newest)) {
      watchingRunId.current = newest.id;
      return;
    }
    if (watchingRunId.current == null || watchingRunId.current < 0) return;
    if (!newest || newest.id !== watchingRunId.current) return;
    if (!isRunFinished(newest)) return;

    const id = watchingRunId.current;
    watchingRunId.current = null;
    if (newest.status === "success" || newest.status === "partial") {
      toast(
        `Sync #${id} finished (${newest.status}) — fetched ${newest.products_fetched}, wrote +${newest.posts_created}/~${newest.posts_updated}`,
        "ok",
      );
    } else {
      toast(`Sync #${id} failed (${newest.status})`, "error");
    }
  }, [newest, toast]);

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

  const primaryLabel = syncRunning ? "Syncing…" : starting ? "Starting…" : "Run sync now";
  const stopEnabled = syncRunning && !stop.isPending;
  const stopTitle = syncRunning
    ? "Abort the active run between batches and turn Sync enabled off until you Run again"
    : "No sync running";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sync</h1>
        <p className="text-sm text-muted">
          Catalogue sync for BeautyFort + BTS only — never places vendor orders. Scheduled at :00
          and :30 · live downloads min {live.data?.liveFeedMinMinutes ?? "…"} min apart.
        </p>
      </header>

      {secretsMissing.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Vendor secrets incomplete.</strong> Missing{" "}
          {secretsMissing.map((s) => s.key).join(", ")}.{" "}
          <Link to="/secrets" className="font-medium underline underline-offset-2">
            Open Secrets
          </Link>{" "}
          before a live sync will succeed.
        </div>
      ) : null}

      <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-panel px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold tracking-tight text-ink">Run sync now</h2>
            <p className="mt-1 text-sm text-muted">
              Starts a <strong className="font-medium text-ink">fast</strong> live catalogue sync for
              BeautyFort + BTS (prices, stock, new products). Not orders. After it finishes, open
              Products.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-busy={busy}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-base font-semibold shadow-sm transition disabled:cursor-not-allowed",
                  syncRunning
                    ? "bg-accent text-accent-ink opacity-95 ring-2 ring-accent/30 ring-offset-2 ring-offset-panel"
                    : "bg-accent text-accent-ink hover:opacity-95 disabled:opacity-50",
                )}
                disabled={busy}
                onClick={() => run.mutate({ mode: "fast", demo: true })}
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
                {primaryLabel}
              </button>
              <button
                type="button"
                title={stopTitle}
                aria-disabled={!stopEnabled}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-xl border px-4 py-3 text-sm font-medium transition disabled:cursor-not-allowed",
                  syncRunning
                    ? "border-danger/50 bg-red-50 text-danger hover:bg-red-100"
                    : "border-line bg-canvas text-muted opacity-60",
                )}
                disabled={!stopEnabled}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                {stop.isPending ? "Stopping…" : "Stop sync"}
              </button>
            </div>
            <p className="max-w-sm text-right text-xs text-muted">
              {syncRunning
                ? "Stop aborts between batches and turns Sync enabled off until you Run again."
                : "Stop is available only while a sync is running."}
            </p>
          </div>
        </div>
      </section>

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
              <p className="mt-0.5 text-xs text-muted">
                Whether a fresh catalogue download is allowed right now (rate limits / daily caps).
              </p>
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
            <div className="font-medium text-ink">Syncing…</div>
            <div className="text-muted">
              Run #{newest?.id} · {newest?.mode}/{newest?.source} — other start buttons are disabled
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

      <details className="rounded-xl border border-line bg-panel px-5 py-4 shadow-sm">
        <summary className="cursor-pointer text-sm font-semibold">
          More sync modes
          <span className="ml-2 font-normal text-muted">fast vs full</span>
        </summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-canvas/50 p-3">
            <button
              type="button"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm font-medium hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy}
              onClick={() => run.mutate({ mode: "fast" })}
            >
              {busy ? "Unavailable while syncing" : "Run fast sync"}
            </button>
            <p className="mt-2 text-xs text-muted">
              Fast: refresh prices and stock for all active retail vendors (BeautyFort + BTS). Same
              path as Run sync now, without pinning vendors in the request.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-canvas/50 p-3">
            <button
              type="button"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm font-medium hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy}
              onClick={() => run.mutate({ mode: "full" })}
            >
              {busy ? "Unavailable while syncing" : "Run full sync"}
            </button>
            <p className="mt-2 text-xs text-muted">
              Full: rebuild catalogue structure too (taxonomy, vanished products, park WPF). Heavier;
              usually overnight via schedule.
            </p>
          </div>
        </div>
      </details>

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
                  No sync runs yet — press Run sync now after Secrets are set.
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
