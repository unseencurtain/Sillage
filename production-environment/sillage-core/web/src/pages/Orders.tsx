import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { eur, fmtDate } from "@/lib/utils";

export function Orders() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["orders"], queryFn: () => api.orders(), refetchInterval: 10_000 });
  const detail = useQuery({
    queryKey: ["order", selected],
    queryFn: () => api.order(selected!),
    enabled: selected !== null,
  });

  const approve = useMutation({
    mutationFn: (id: number) => api.approveOrder(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
  const dispatch = useMutation({
    mutationFn: ({ id, live }: { id: number; live: boolean }) => api.dispatchOrder(id, live),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      if (selected) qc.invalidateQueries({ queryKey: ["order", selected] });
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted">Per-vendor dispatch rows. Dry-run is the default.</p>
      </header>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-3">ID</th>
                <th className="px-3 py-3">WC</th>
                <th className="px-3 py-3">Vendor</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Cost</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-muted">
                    Loading…
                  </td>
                </tr>
              ) : (data?.orders ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-muted">
                    No vendor orders yet
                  </td>
                </tr>
              ) : (
                (data?.orders ?? []).map((o) => (
                  <tr
                    key={o.id}
                    className={`border-b border-line/70 last:border-0 ${selected === o.id ? "bg-teal-50/50" : ""}`}
                  >
                    <td className="px-3 py-3 font-mono">
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSelected(o.id)}>
                        #{o.id}
                      </button>
                    </td>
                    <td className="px-3 py-3 font-mono">{o.wc_order_id}</td>
                    <td className="px-3 py-3">
                      {o.vendor}
                      {o.dry_run ? <span className="ml-1 text-xs text-muted">dry</span> : null}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="px-3 py-3 font-mono tabular-nums">{eur(o.items_cost)}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="rounded border border-line px-2 py-1 text-xs"
                          onClick={() => approve.mutate(o.id)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="rounded border border-line px-2 py-1 text-xs"
                          onClick={() => dispatch.mutate({ id: o.id, live: false })}
                        >
                          Dry-run
                        </button>
                        <button
                          type="button"
                          className="rounded border border-danger/30 px-2 py-1 text-xs text-danger"
                          onClick={() => {
                            if (confirm(`LIVE dispatch vendor order #${o.id}? This spends real money.`)) {
                              dispatch.mutate({ id: o.id, live: true });
                            }
                          }}
                        >
                          Live
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <aside className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          {!selected ? (
            <p className="text-sm text-muted">Select an order to inspect lines and events</p>
          ) : detail.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : detail.data ? (
            <div className="space-y-4 text-sm">
              <div>
                <div className="font-mono text-xs text-muted">{String(detail.data.order.our_reference)}</div>
                <div className="mt-1 flex items-center gap-2">
                  <StatusBadge status={String(detail.data.order.status)} />
                  <span>{String(detail.data.order.destination_country)}</span>
                </div>
                <div className="mt-2 font-mono tabular-nums">
                  cost {eur(String(detail.data.order.items_cost))} · revenue {eur(String(detail.data.order.revenue))}
                </div>
              </div>
              <div>
                <h3 className="text-xs uppercase tracking-wide text-muted">Lines</h3>
                <ul className="mt-2 space-y-2">
                  {detail.data.items.map((item) => (
                    <li key={String(item.id)} className="rounded-lg border border-line px-3 py-2">
                      <div className="truncate">{String(item.name)}</div>
                      <div className="font-mono text-xs text-muted">
                        {String(item.sku)} × {String(item.quantity)} @ {eur(String(item.unit_cost))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-xs uppercase tracking-wide text-muted">Events</h3>
                <ul className="mt-2 max-h-64 space-y-2 overflow-auto">
                  {detail.data.events.map((ev) => (
                    <li key={String(ev.id)} className="text-xs">
                      <span className="font-mono text-muted">{fmtDate(String(ev.created_at))}</span>
                      <div>{String(ev.message)}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-sm text-danger">Failed to load order</p>
          )}
        </aside>
      </div>
    </div>
  );
}
