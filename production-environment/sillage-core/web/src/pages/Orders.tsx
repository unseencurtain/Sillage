import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, emptyAddress, type OrderAddress } from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { cn, eur, fmtDate } from "@/lib/utils";

const ADDRESS_FIELDS: Array<{ key: keyof OrderAddress; label: string; wide?: boolean }> = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "company", label: "Company", wide: true },
  { key: "address1", label: "Address line 1", wide: true },
  { key: "address2", label: "Address line 2", wide: true },
  { key: "city", label: "City" },
  { key: "state", label: "State / region" },
  { key: "postcode", label: "Postcode" },
  { key: "country", label: "Country (ISO)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

export function Orders() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmLiveId, setConfirmLiveId] = useState<number | null>(null);
  const [address, setAddress] = useState<OrderAddress>(emptyAddress());

  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders(),
    refetchInterval: 10_000,
  });

  const detail = useQuery({
    queryKey: ["order", selected],
    queryFn: () => api.order(selected!),
    enabled: selected !== null,
  });

  useEffect(() => {
    if (detail.data?.address) {
      setAddress(detail.data.address);
    } else if (detail.data) {
      setAddress({
        ...emptyAddress(),
        country: String(detail.data.order.destination_country ?? ""),
      });
    }
  }, [detail.data]);

  const approve = useMutation({
    mutationFn: (id: number) => api.approveOrder(id),
    onSuccess: (res, id) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order", id] });
      if (res.ok) toast(`Order #${id} approved`, "ok");
      else toast(res.reason ?? "Approval blocked", "error");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const dispatch = useMutation({
    mutationFn: ({ id, live }: { id: number; live: boolean }) => api.dispatchOrder(id, live),
    onSuccess: (res, { id, live }) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order", id] });
      setConfirmLiveId(null);
      const label = live ? "Live dispatch" : "Dry-run dispatch";
      if (res.status === "failed" || res.reason) toast(`${label}: ${res.reason ?? res.status}`, "error");
      else toast(`${label} completed — ${res.status}`, "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const saveAddress = useMutation({
    mutationFn: () => api.updateOrderAddress(selected!, address),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", selected] });
      toast("Ship-to address saved", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const pendingAction =
    approve.isPending || dispatch.isPending ? (approve.variables ?? dispatch.variables?.id) : null;

  const startLiveConfirm = (id: number) => {
    setSelected(id);
    setConfirmLiveId(id);
  };

  const order = detail.data?.order;
  const showLiveConfirm = confirmLiveId !== null && confirmLiveId === selected;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted">Per-vendor dispatch rows · dry-run is the default safety rail</p>
      </header>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
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
                (data?.orders ?? []).map((o) => {
                  const rowBusy = pendingAction === o.id;
                  return (
                    <tr
                      key={o.id}
                      className={cn(
                        "border-b border-line/70 last:border-0 transition-colors",
                        selected === o.id ? "bg-teal-50/60" : "hover:bg-canvas/50",
                      )}
                    >
                      <td className="px-3 py-3 font-mono">
                        <button
                          type="button"
                          className="font-medium underline-offset-2 hover:text-accent hover:underline"
                          onClick={() => {
                            setSelected(o.id);
                            setConfirmLiveId(null);
                          }}
                        >
                          #{o.id}
                        </button>
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">{o.wc_order_id}</td>
                      <td className="px-3 py-3">
                        <span className="font-mono text-xs">{o.vendor}</span>
                        {o.dry_run ? (
                          <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                            dry
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">{eur(o.items_cost)}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          <ActionBtn
                            label="Approve"
                            disabled={rowBusy}
                            pending={approve.isPending && approve.variables === o.id}
                            onClick={() => approve.mutate(o.id)}
                          />
                          <ActionBtn
                            label="Dry-run"
                            disabled={rowBusy}
                            pending={dispatch.isPending && dispatch.variables?.id === o.id && !dispatch.variables.live}
                            onClick={() => dispatch.mutate({ id: o.id, live: false })}
                          />
                          <ActionBtn
                            label="Live"
                            danger
                            disabled={rowBusy}
                            onClick={() => startLiveConfirm(o.id)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <aside className="flex max-h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="text-sm text-muted">Select an order to inspect details and dispatch</p>
            </div>
          ) : detail.isLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading order…
            </div>
          ) : detail.isError || !order ? (
            <div className="p-5 text-sm text-danger">Failed to load order</div>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b border-line bg-panel/95 px-5 py-4 backdrop-blur-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs text-muted">{String(order.our_reference)}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-lg font-semibold tabular-nums">#{order.id}</span>
                      <StatusBadge status={String(order.status)} />
                      <span className="text-xs text-muted">{String(order.vendor)}</span>
                    </div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-muted">
                      cost {eur(String(order.items_cost))} · revenue {eur(String(order.revenue))}
                      {order.shipping_cost ? ` · ship ${eur(String(order.shipping_cost))}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <ActionBtn
                      label="Approve"
                      disabled={pendingAction === order.id}
                      pending={approve.isPending && approve.variables === order.id}
                      onClick={() => approve.mutate(order.id as number)}
                    />
                    <ActionBtn
                      label="Dry-run"
                      disabled={pendingAction === order.id}
                      pending={
                        dispatch.isPending &&
                        dispatch.variables?.id === order.id &&
                        !dispatch.variables.live
                      }
                      onClick={() => dispatch.mutate({ id: order.id as number, live: false })}
                    />
                    <ActionBtn
                      label="Live"
                      danger
                      disabled={pendingAction === order.id}
                      onClick={() => setConfirmLiveId(order.id as number)}
                    />
                  </div>
                </div>

                {showLiveConfirm ? (
                  <div className="mt-4">
                    <ConfirmPanel
                      title="Confirm live dispatch"
                      description="This spends real money at the vendor. The order will be submitted immediately and cannot be undone."
                      confirmLabel="Confirm live"
                      danger
                      pending={dispatch.isPending && dispatch.variables?.live === true}
                      onCancel={() => setConfirmLiveId(null)}
                      onConfirm={() => dispatch.mutate({ id: order.id as number, live: true })}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Ship-to address</h3>
                    <button
                      type="button"
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-50"
                      disabled={saveAddress.isPending}
                      onClick={() => saveAddress.mutate()}
                    >
                      {saveAddress.isPending ? "Saving…" : "Save address"}
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {ADDRESS_FIELDS.map((f) => (
                      <label key={f.key} className={cn("block", f.wide && "sm:col-span-2")}>
                        <span className="text-xs text-muted">{f.label}</span>
                        <input
                          className="mt-1 w-full rounded-lg border border-line px-2.5 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={address[f.key]}
                          disabled={saveAddress.isPending}
                          onChange={(e) => setAddress((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Line items</h3>
                  <ul className="mt-2 space-y-2">
                    {(detail.data.items ?? []).length === 0 ? (
                      <li className="text-xs text-muted">No line items</li>
                    ) : (
                      detail.data.items.map((item) => (
                        <li key={item.id} className="rounded-lg border border-line bg-canvas/30 px-3 py-2">
                          <div className="truncate font-medium">{item.name}</div>
                          <div className="mt-0.5 font-mono text-xs text-muted">
                            {item.sku} × {item.quantity} @ {eur(item.unit_cost)}
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Tracking</h3>
                  {(detail.data.tracking ?? []).length === 0 ? (
                    <p className="mt-2 text-xs text-muted">No parcels yet</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.data.tracking.map((t) => (
                        <li key={t.id} className="rounded-lg border border-line px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs">{t.tracking_code}</span>
                            {t.tracking_url ? (
                              <a
                                href={t.tracking_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                              >
                                Track <ExternalLink size={12} />
                              </a>
                            ) : null}
                          </div>
                          <div className="mt-1 text-xs text-muted">
                            {t.courier ?? "Unknown courier"}
                            {t.dispatched_at ? ` · ${fmtDate(t.dispatched_at)}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Event log</h3>
                  <ul className="mt-2 max-h-48 space-y-2 overflow-auto">
                    {(detail.data.events ?? []).length === 0 ? (
                      <li className="text-xs text-muted">No events recorded</li>
                    ) : (
                      detail.data.events.map((ev) => (
                        <li key={ev.id} className="border-l-2 border-line pl-3 text-xs">
                          <div className="font-mono text-muted">{fmtDate(ev.created_at)}</div>
                          {ev.from_status || ev.to_status ? (
                            <div className="mt-0.5 flex items-center gap-1.5">
                              {ev.from_status ? <StatusBadge status={ev.from_status} /> : null}
                              {ev.from_status && ev.to_status ? <span className="text-muted">→</span> : null}
                              {ev.to_status ? <StatusBadge status={ev.to_status} /> : null}
                            </div>
                          ) : null}
                          <div className="mt-0.5">{ev.message}</div>
                        </li>
                      ))
                    )}
                  </ul>
                </section>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  onClick,
  disabled,
  pending,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium disabled:opacity-50",
        danger ? "border-danger/30 text-danger hover:bg-red-50" : "border-line hover:bg-canvas",
      )}
      disabled={disabled || pending}
      onClick={onClick}
    >
      {pending ? <Loader2 size={12} className="animate-spin" /> : null}
      {label}
    </button>
  );
}
