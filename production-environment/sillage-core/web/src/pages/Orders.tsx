import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import {
  api,
  ApiError,
  emptyAddress,
  emptyCompanyBilling,
  type CompanyBillingAddress,
  type OrderAddress,
  type OrderFilter,
  type OrderRow,
} from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { cn, eur, useFmtDate, useRowLimit } from "@/lib/utils";

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

const BILLING_FIELDS: Array<{ key: keyof CompanyBillingAddress; label: string; wide?: boolean }> = [
  { key: "company", label: "Company", wide: true },
  { key: "vat", label: "VAT / BTW", wide: true },
  ...ADDRESS_FIELDS.filter((f) => f.key !== "company"),
];

const STAGES = ["received", "approved", "submitted", "confirmed", "dispatched", "delivered"] as const;
const TERMINAL = new Set(["failed", "needs_attention", "cancelled"]);

const ORDER_FILTERS: Array<{ key: OrderFilter; label: string; count: "all" | "todo" | "done" }> = [
  { key: "all", label: "All", count: "all" },
  { key: "todo", label: "To do", count: "todo" },
  { key: "done", label: "Done", count: "done" },
];

/** A pending bulk close or delete. */
type BulkTarget = {
  action: "done" | "delete";
  wc_order_ids?: number[];
  filter?: OrderFilter;
  label: string;
};

function formatAddress(a: OrderAddress | null | undefined): string {
  if (!a) return "—";
  const lines = [
    [a.firstName, a.lastName].filter(Boolean).join(" "),
    a.company,
    a.address1,
    a.address2,
    [a.postcode, a.city].filter(Boolean).join(" "),
    [a.state, a.country].filter(Boolean).join(" "),
  ].filter(Boolean);
  return lines.join("\n") || "—";
}

export function Orders() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fmtDate = useFmtDate();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useRowLimit("sillage.rows.orders");
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<BulkTarget | null>(null);
  const [bulkPassword, setBulkPassword] = useState("");
  const [confirmLiveId, setConfirmLiveId] = useState<number | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<OrderAddress>(emptyAddress());
  const [billing, setBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());

  const { data, isLoading } = useQuery({
    queryKey: ["orders", page, limit, filter],
    queryFn: () => api.orders(page, undefined, limit, filter),
    refetchInterval: 10_000,
  });

  const detail = useQuery({
    queryKey: ["order", selected],
    queryFn: () => api.order(selected!),
    enabled: selected !== null,
  });

  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data.deliveryAddress ?? detail.data.address;
    if (d) setDelivery(d);
    else {
      setDelivery({
        ...emptyAddress(),
        country: String(detail.data.order.destination_country ?? ""),
      });
    }
    setBilling(detail.data.billingAddress ?? emptyCompanyBilling());
    setConfirmStatus(null);
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
      const vendorNo = res.vendorOrderNumber ? ` · vendor #${res.vendorOrderNumber}` : "";
      if (res.status === "failed") {
        toast(`${label} failed: ${res.reason ?? res.status}`, "error");
        return;
      }
      if (res.reason && res.status !== "submitted" && res.status !== "confirmed") {
        toast(`${label}: ${res.reason}${vendorNo}`, "error");
        return;
      }
      toast(`${label} → ${res.status}${vendorNo}. Tracking appears here after the vendor ships.`, "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const saveDelivery = useMutation({
    mutationFn: () => api.updateOrderAddress(selected!, { delivery }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", selected] });
      toast("Delivery address saved (Sillage only — WooCommerce unchanged)", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const saveBilling = useMutation({
    mutationFn: () => api.updateOrderAddress(selected!, { billing }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", selected] });
      toast("Billing / invoice address saved", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const useCompany = useMutation({
    mutationFn: () => api.updateOrderAddress(selected!, { useCompanyBilling: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", selected] });
      toast("Filled from saved company billing", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const resetDelivery = useMutation({
    mutationFn: () => api.updateOrderAddress(selected!, { resetDeliveryFromWoo: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order", selected] });
      toast("Delivery reset from WooCommerce", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const setStatus = useMutation({
    mutationFn: ({ status, confirm }: { status: string; confirm?: boolean }) =>
      api.updateOrderStatus(selected!, status, confirm),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order", selected] });
      setConfirmStatus(null);
      toast(`Status → ${res.status}`, "ok");
    },
    onError: (err: Error, vars) => {
      if (err instanceof ApiError && err.status === 409 && !vars.confirm) {
        setConfirmStatus(vars.status);
        return;
      }
      toast(err.message, "error");
    },
  });

  const bulk = useMutation({
    mutationFn: (vars: { target: BulkTarget; password?: string }) =>
      api.bulkOrders({
        action: vars.target.action,
        wc_order_ids: vars.target.wc_order_ids,
        filter: vars.target.filter,
        password: vars.password,
      }),
    onSuccess: (res, vars) => {
      const t = vars.target;
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order"] });
      setBulkTarget(null);
      setBulkPassword("");
      setChecked(new Set());
      if (t.action === "delete") setSelected(null);
      const verb = t.action === "done" ? "Closed" : "Deleted";
      const parts = [`${verb} ${res.orders} order${res.orders === 1 ? "" : "s"}`];
      if (res.skipped > 0) parts.push(`${res.skipped} leg(s) left alone (already at a vendor)`);
      if (res.remaining > 0) parts.push(`${res.remaining} still to do — run it again`);
      if (res.ignored > 0) {
        parts.push(`${res.ignored} order${res.ignored === 1 ? "" : "s"} will not be imported again`);
      }
      toast(parts.join(" · "), res.orders === 0 ? "error" : "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const pendingAction =
    approve.isPending || dispatch.isPending ? (approve.variables ?? dispatch.variables?.id) : null;

  const startLiveConfirm = (id: number) => {
    setSelected(id);
    setConfirmLiveId(id);
  };

  const settingsQ = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const settingsDryRun =
    settingsQ.data?.orders_dry_run === undefined
      ? true
      : settingsQ.data.orders_dry_run === "1" || settingsQ.data.orders_dry_run === "true";

  const todoCount = data?.counts?.todo ?? 0;
  const pageIds = (data?.orders ?? []).map((o) => o.wc_order_id);
  const allOnPageChecked = pageIds.length > 0 && pageIds.every((id) => checked.has(id));

  const toggleRow = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openOrder = (o: OrderRow) => {
    setSelected(o.vendors[0]?.id ?? null);
    setConfirmLiveId(null);
  };

  // Closing an order is reversible and spends nothing; deleting is not, so it asks for the password.
  const bulkConfirm = bulkTarget ? (
    bulkTarget.action === "done" ? (
      <ConfirmPanel
        title={`Close ${bulkTarget.label}?`}
        description="They are marked cancelled and leave the To do list. Nothing is sent to a vendor, and a closed order can be reopened from its stage buttons."
        confirmLabel="Close"
        pending={bulk.isPending}
        onCancel={() => setBulkTarget(null)}
        onConfirm={() => bulk.mutate({ target: bulkTarget })}
      />
    ) : (
      <div className="rounded-lg border border-danger/40 bg-red-50/80 p-4">
        <div className="flex gap-2">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">Delete {bulkTarget.label}?</div>
            <p className="mt-1 text-sm text-muted">
              Removes the order and every vendor leg, item, event and tracking record from Sillage.
              The WooCommerce order is not touched, and it will not be imported again.
            </p>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Your dashboard password"
              value={bulkPassword}
              onChange={(e) => setBulkPassword(e.target.value)}
              className="mt-3 w-full max-w-xs rounded-lg border border-line px-2.5 py-1.5 text-sm focus:border-danger focus:outline-none focus:ring-1 focus:ring-danger/30"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                disabled={bulk.isPending}
                onClick={() => {
                  setBulkTarget(null);
                  setBulkPassword("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={bulk.isPending || bulkPassword.length === 0}
                onClick={() => bulk.mutate({ target: bulkTarget, password: bulkPassword })}
              >
                {bulk.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  ) : null;

  const detailData = detail.data;
  const order = detailData?.order;
  const showLiveConfirm = confirmLiveId !== null && confirmLiveId === selected;
  const currentStatus = String(order?.status ?? "");
  const stageIndex = STAGES.indexOf(currentStatus as (typeof STAGES)[number]);

  // Vendor tabs: the open leg plus its siblings of the same WooCommerce order.
  const detailTabs =
    detailData && order
      ? [
          {
            id: Number(order.id),
            vendor: String(order.vendor),
            vendor_prefix: String(order.vendor_prefix),
            status: String(order.status),
          },
          ...(detailData.siblings ?? []),
        ].sort((a, b) => a.id - b.id)
      : [];
  const selectedWcOrder = detailData?.order?.wc_order_id ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted">
          One row per WooCommerce order · the vendor split lives under Vendors and in the panel ·
          Dry-run never spends, Live always asks for confirmation.
          {data ? ` · ${data.total.toLocaleString()} total` : ""}
        </p>
      </header>

      {!settingsDryRun ? (
        <div className="rounded-xl border-2 border-danger bg-red-50 px-4 py-4 text-sm text-danger">
          <div className="text-base font-semibold">LIVE order mode (Settings dry-run is OFF)</div>
          <p className="mt-1">
            Auto-dispatch and CLI can spend real money. The Live button on each vendor leg also spends
            money when confirmed. Turn Orders dry-run back on in Settings unless you intend live spend.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {ORDER_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            title={
              f.key === "todo"
                ? "At least one vendor not placed yet (a dry-run submit is a rehearsal, so it stays here)"
                : f.key === "done"
                  ? "Every vendor placed or closed"
                  : "Every order"
            }
            onClick={() => {
              setFilter(f.key);
              setPage(1);
              setChecked(new Set());
            }}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm font-medium transition",
              filter === f.key
                ? "border-accent bg-teal-50 text-accent"
                : "border-line bg-panel text-muted hover:text-ink",
            )}
          >
            {f.label}
            {data?.counts ? (
              <span
                className={cn(
                  "ml-1.5 tabular-nums",
                  filter === f.key ? "text-accent/70" : "text-muted/70",
                )}
              >
                {data.counts[f.count]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-sm">
        <span className="text-muted">
          {checked.size > 0 ? `${checked.size} selected` : `${todoCount} to do`}
        </span>
        <button
          type="button"
          disabled={bulk.isPending || (checked.size === 0 && todoCount === 0)}
          onClick={() =>
            setBulkTarget(
              checked.size > 0
                ? {
                    action: "done",
                    wc_order_ids: [...checked],
                    label: `${checked.size} selected order${checked.size === 1 ? "" : "s"}`,
                  }
                : {
                    action: "done",
                    filter: "todo",
                    label: `all ${todoCount} to do order${todoCount === 1 ? "" : "s"}`,
                  },
            )
          }
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          Mark {checked.size > 0 ? checked.size : todoCount} done
        </button>
        <button
          type="button"
          disabled={bulk.isPending || checked.size === 0}
          title={
            checked.size === 0
              ? "Tick the orders you want to delete first"
              : "Deletes the ticked orders — asks for your dashboard password"
          }
          onClick={() =>
            setBulkTarget({
              action: "delete",
              wc_order_ids: [...checked],
              label: `${checked.size} selected order${checked.size === 1 ? "" : "s"}`,
            })
          }
          className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger hover:bg-red-50 disabled:opacity-40"
        >
          Delete
        </button>
        {checked.size > 0 ? (
          <button
            type="button"
            className="text-xs text-muted hover:text-ink"
            onClick={() => setChecked(new Set())}
          >
            Clear
          </button>
        ) : null}
      </div>

      {bulkTarget ? bulkConfirm : null}

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-8 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select every order on this page"
                      className="h-3.5 w-3.5 accent-teal-600"
                      checked={allOnPageChecked}
                      onChange={(e) => {
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) pageIds.forEach((id) => next.add(id));
                          else pageIds.forEach((id) => next.delete(id));
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th className="px-3 py-3">WC</th>
                  <th className="px-3 py-3">Vendors</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Cost</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-muted">
                      Loading…
                    </td>
                  </tr>
                ) : (data?.orders ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-muted">
                      No orders yet
                    </td>
                  </tr>
                ) : (
                  (data?.orders ?? []).map((o) => (
                    <tr
                      key={o.wc_order_id}
                      className={cn(
                        "cursor-pointer border-b border-line/70 last:border-0 transition-colors",
                        o.order_done === 0 && "border-l-2 border-l-amber-400",
                        selectedWcOrder === o.wc_order_id ? "bg-teal-50/60" : "hover:bg-canvas/50",
                      )}
                      onClick={() => openOrder(o)}
                    >
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select order ${o.wc_order_id}`}
                          className="h-3.5 w-3.5 accent-teal-600"
                          checked={checked.has(o.wc_order_id)}
                          onChange={() => toggleRow(o.wc_order_id)}
                        />
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">
                        <span className="font-medium">#{o.wc_order_id}</span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {o.vendors.map((v) => (
                            <span
                              key={v.id}
                              title={v.vendor}
                              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700"
                            >
                              {v.vendor_prefix}
                            </span>
                          ))}
                          {o.any_dry_run ? (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                              dry
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {o.order_done === 0 ? (
                            <span
                              className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900"
                              title="Still to do — at least one vendor not placed"
                            >
                              to do
                            </span>
                          ) : null}
                          {o.vendors.map((v) => (
                            <span key={v.id} className="inline-flex items-center gap-1">
                              {o.vendors.length > 1 ? (
                                <span className="font-mono text-[10px] text-muted">
                                  {v.vendor_prefix}
                                </span>
                              ) : null}
                              <StatusBadge status={v.status} />
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">{eur(o.items_cost)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {data ? (
            <Pagination
              page={page}
              limit={data.limit}
              total={data.total}
              onPageChange={setPage}
              onLimitChange={(n) => {
                setLimit(n);
                setPage(1);
              }}
            />
          ) : null}
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
          ) : detail.isError || !detailData || !order ? (
            <div className="p-5 text-sm text-danger">Failed to load order</div>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b border-line bg-panel/95 px-5 py-4 backdrop-blur-sm">
                {detailTabs.length > 1 ? (
                  <div className="mb-3 flex flex-wrap gap-1 border-b border-line pb-3">
                    {detailTabs.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        title={t.vendor}
                        onClick={() => {
                          setSelected(t.id);
                          setConfirmLiveId(null);
                        }}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-semibold transition",
                          t.id === selected
                            ? "border-accent bg-teal-50 text-accent"
                            : "border-line bg-panel text-muted hover:text-ink",
                        )}
                      >
                        {t.vendor_prefix}
                        <span className="ml-1.5 font-normal text-muted">{t.vendor}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs text-muted">{String(order.our_reference)}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-lg font-semibold tabular-nums">#{order.wc_order_id}</span>
                      <StatusBadge status={String(order.status)} />
                      <span className="text-xs text-muted">
                        {String(order.vendor)} · leg #{order.id}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-muted">
                      cost {eur(String(order.items_cost))} · revenue {eur(String(order.revenue))}
                      {order.shipping_cost ? ` · ship ${eur(String(order.shipping_cost))}` : ""}
                    </div>
                    {detailData.wpAdminUrl ? (
                      <a
                        href={detailData.wpAdminUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        Open in WooCommerce <ExternalLink size={12} />
                      </a>
                    ) : null}
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

                {confirmStatus ? (
                  <div className="mt-4">
                    <ConfirmPanel
                      title="Override status after live submit?"
                      description={`Move this live order to “${confirmStatus}”. Vendor polling still only advances forward.`}
                      confirmLabel="Confirm override"
                      danger
                      pending={setStatus.isPending}
                      onCancel={() => setConfirmStatus(null)}
                      onConfirm={() => setStatus.mutate({ status: confirmStatus, confirm: true })}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
                <section>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                    Progress
                  </h3>
                  <div className="mt-2 flex items-center gap-0 overflow-x-auto pb-1">
                    {STAGES.map((stage, i) => {
                      const filled = stageIndex >= 0 && i <= stageIndex;
                      const current = stage === currentStatus;
                      return (
                        <div key={stage} className="flex min-w-0 flex-1 items-center">
                          <div className="flex w-full flex-col items-center gap-1 px-1 py-1 text-center">
                            <span
                              className={cn(
                                "h-2.5 w-2.5 rounded-full border-2",
                                filled ? "border-accent bg-accent" : "border-line bg-panel",
                              )}
                            />
                            <span
                              className={cn(
                                "text-[10px] leading-tight",
                                current ? "font-semibold text-ink" : "text-muted",
                              )}
                            >
                              {stage}
                            </span>
                          </div>
                          {i < STAGES.length - 1 ? (
                            <div
                              className={cn(
                                "mx-0.5 h-0.5 w-3 shrink-0 sm:w-4",
                                stageIndex > i ? "bg-accent" : "bg-line",
                              )}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    This advances on its own: auto-dispatch sends it to{" "}
                    <span className="font-mono">submitted</span>, then the tracking poller walks it
                    to <span className="font-mono">delivered</span> as the vendor ships. The override
                    below is only for correcting a stuck state.
                  </p>
                  {TERMINAL.has(currentStatus) ? (
                    <div className="mt-2 flex items-center gap-2">
                      <StatusBadge status={currentStatus} />
                      <span className="text-xs text-muted">Terminal — use the override to reopen</span>
                    </div>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <label htmlFor="status-override" className="text-xs text-muted">
                      Manual override
                    </label>
                    <select
                      id="status-override"
                      className="rounded-lg border border-line bg-panel px-2 py-1.5 text-xs font-mono disabled:opacity-50"
                      disabled={setStatus.isPending}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) setStatus.mutate({ status: e.target.value });
                      }}
                    >
                      <option value="">—</option>
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    WooCommerce customer (read-only)
                  </h3>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-canvas/30 px-3 py-2 font-mono text-xs text-muted">
                    {formatAddress(detailData.wooAddress)}
                  </pre>
                </section>

                <section>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Delivery (vendor ship-to)
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="rounded-lg border border-line px-2.5 py-1.5 text-xs hover:bg-canvas disabled:opacity-50"
                        disabled={resetDelivery.isPending}
                        onClick={() => resetDelivery.mutate()}
                      >
                        Reset from WooCommerce
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-50"
                        disabled={saveDelivery.isPending}
                        onClick={() => saveDelivery.mutate()}
                      >
                        {saveDelivery.isPending ? "Saving…" : "Save delivery"}
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {ADDRESS_FIELDS.map((f) => (
                      <label key={f.key} className={cn("block", f.wide && "sm:col-span-2")}>
                        <span className="text-xs text-muted">{f.label}</span>
                        <input
                          className="mt-1 w-full rounded-lg border border-line px-2.5 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={delivery[f.key]}
                          disabled={saveDelivery.isPending}
                          onChange={(e) => setDelivery((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Billing / invoice (company)
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="rounded-lg border border-line px-2.5 py-1.5 text-xs hover:bg-canvas disabled:opacity-50"
                        disabled={useCompany.isPending}
                        onClick={() => useCompany.mutate()}
                      >
                        Use saved company billing
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-50"
                        disabled={saveBilling.isPending}
                        onClick={() => saveBilling.mutate()}
                      >
                        {saveBilling.isPending ? "Saving…" : "Save billing"}
                      </button>
                    </div>
                  </div>
                  <p className="mb-2 text-xs text-muted">
                    BeautyFort: invoice address. BTS: account invoice is portal-side; still shown in dry-run
                    payload.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {BILLING_FIELDS.map((f) => (
                      <label key={f.key} className={cn("block", f.wide && "sm:col-span-2")}>
                        <span className="text-xs text-muted">{f.label}</span>
                        <input
                          className="mt-1 w-full rounded-lg border border-line px-2.5 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={billing[f.key]}
                          disabled={saveBilling.isPending}
                          onChange={(e) => setBilling((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Line items</h3>
                  <ul className="mt-2 space-y-2">
                    {(detailData.items ?? []).length === 0 ? (
                      <li className="text-xs text-muted">No line items</li>
                    ) : (
                      detailData.items.map((item) => (
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
                  {(detailData.tracking ?? []).length === 0 ? (
                    <p className="mt-2 text-xs text-muted">No parcels yet</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detailData.tracking.map((t) => (
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
                    {(detailData.events ?? []).length === 0 ? (
                      <li className="text-xs text-muted">No events recorded</li>
                    ) : (
                      detailData.events.map((ev) => (
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
