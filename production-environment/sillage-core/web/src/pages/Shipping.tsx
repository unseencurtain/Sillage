import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ShippingQuoteRow } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-60";

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted">{help}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink">{label}</span>
      <div className="mt-1.5">{children}</div>
      <span className="mt-1 block text-xs text-muted">{help}</span>
    </label>
  );
}

const eur = (n: number) => `€${n.toFixed(2)}`;

/** Customer price for a vendor cost, using the same rule the storefront uses. */
function customerPrice(cost: number, percent: number, fixed: number): number {
  return Math.round((cost * (1 + percent / 100) + fixed) * 100) / 100;
}

export function Shipping() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["shipping"], queryFn: api.shipping });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const [form, setForm] = useState({
    markupPercent: "0",
    markupFixed: "0",
    freeOver: "0",
    displayMode: "total" as "total" | "per_location",
    refreshHours: "6",
  });
  const [sample, setSample] = useState("10");

  useEffect(() => {
    if (!data) return;
    setForm({
      markupPercent: String(data.rules.markupPercent),
      markupFixed: String(data.rules.markupFixedEur),
      freeOver: String(data.rules.freeOverEur),
      displayMode: data.rules.displayMode,
      refreshHours: String(data.rules.refreshHours),
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        shipping_markup_percent: form.markupPercent,
        shipping_markup_fixed_eur: form.markupFixed,
        shipping_free_over_eur: form.freeOver,
        shipping_display_mode: form.displayMode,
        shipping_quote_refresh_hours: form.refreshHours,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipping"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast("Shipping rules saved", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshShipping(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["shipping"] });
      const errors = res.results.reduce((n, r) => n + r.error, 0);
      toast(errors ? `Vendor costs refreshed with ${errors} error(s)` : "Vendor costs refreshed", errors ? "error" : "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const busy = save.isPending || refresh.isPending;
  const vendorName = (slug: string) => data?.vendors.find((v) => v.slug === slug)?.name ?? slug;
  const quotes: ShippingQuoteRow[] = data?.quotes ?? [];
  const percent = Number(form.markupPercent) || 0;
  const fixed = Number(form.markupFixed) || 0;
  const sampleCost = Number(sample) || 0;
  const freeOver = Number(form.freeOver) || 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>
        <p className="mt-1 text-sm text-muted">
          Vendor costs refresh on a schedule. Your markup and free-shipping rules apply on top, to every country.
        </p>
      </header>

      <Section
        title="Shipping rules"
        help="Defaults charge the vendor cost exactly. Every rule applies to all countries."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Markup (%)" help="Percent added to the vendor cost. 0 = none.">
            <input
              type="number"
              step="0.1"
              min="0"
              className={inputClass}
              value={form.markupPercent}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, markupPercent: e.target.value }))}
            />
          </Field>
          <Field label="Markup (EUR per order)" help="Fixed amount added to every order. 0 = none.">
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.markupFixed}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, markupFixed: e.target.value }))}
            />
          </Field>
          <Field label="Free shipping above (EUR)" help="Whole-bag subtotal. 0 = off. Coupons with free shipping still apply.">
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.freeOver}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, freeOver: e.target.value }))}
            />
          </Field>
          <Field label="Refresh vendor costs every (hours)" help="How often the cached vendor costs update. Minimum 1.">
            <input
              type="number"
              step="1"
              min="1"
              className={inputClass}
              value={form.refreshHours}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, refreshHours: e.target.value }))}
            />
          </Field>
          <div className="md:col-span-2">
            <span className="text-sm font-medium text-ink">Customer view when a bag ships from both locations</span>
            <div className="mt-2 flex gap-2">
              {(
                [
                  ["total", "One shipping total"],
                  ["per_location", "One line per location"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => setForm((f) => ({ ...f, displayMode: value }))}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm",
                    form.displayMode === value
                      ? "border-accent bg-accent/10 font-medium"
                      : "border-line bg-panel text-muted hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted">Example: vendor cost</span>
            <input
              type="number"
              step="0.01"
              min="0"
              className={cn(inputClass, "w-28")}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            <span className="text-muted">becomes</span>
            <span className="font-mono font-medium">{eur(customerPrice(sampleCost, percent, fixed))}</span>
            <span className="text-muted">
              {freeOver > 0 ? `(free when the bag is ${eur(freeOver)} or more)` : "(no free-shipping threshold)"}
            </span>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => save.mutate()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : "Save shipping rules"}
          </button>
        </div>
      </Section>

      <Section
        title="Vendor costs"
        help="Cheapest cost the vendor reports per country, from the last refresh. Admin only: customers never see vendor names."
      >
        <div className="flex items-center justify-between gap-3 text-sm text-muted">
          <span>
            {data?.quotes.length ? `${data.quotes.length} country quotes` : "No quotes yet. Refresh to load them."}
            {settings?.shipping_quote_refresh_hours
              ? ` · refreshed every ${settings.shipping_quote_refresh_hours} h`
              : ""}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => refresh.mutate()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-60"
          >
            {refresh.isPending ? "Refreshing…" : "Refresh now"}
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 font-medium">Country</th>
                  <th className="py-2 pr-4 font-medium">Vendor cost</th>
                  <th className="py-2 pr-4 font-medium">Customer pays</th>
                  <th className="py-2 pr-4 font-medium">Carrier</th>
                  <th className="py-2 pr-4 font-medium">Days</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Quoted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {quotes.map((q) => (
                  <tr key={`${q.vendorSlug}-${q.country}`}>
                    <td className="py-2 pr-4">{vendorName(q.vendorSlug)}</td>
                    <td className="py-2 pr-4 font-mono">{q.country}</td>
                    <td className="py-2 pr-4 font-mono">{q.status === "ok" ? eur(q.costEur) : "-"}</td>
                    <td className="py-2 pr-4 font-mono">
                      {q.status === "ok" ? eur(customerPrice(q.costEur, percent, fixed)) : "-"}
                    </td>
                    <td className="py-2 pr-4">{q.carrier ?? "-"}</td>
                    <td className="py-2 pr-4">{q.deliveryDays ?? "-"}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-xs",
                          q.status === "ok" ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger",
                        )}
                      >
                        {q.status === "ok" ? "Available" : q.status === "none" ? "Not offered" : "Refresh failed"}
                      </span>
                    </td>
                    <td className="py-2 text-muted">{new Date(q.quotedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
