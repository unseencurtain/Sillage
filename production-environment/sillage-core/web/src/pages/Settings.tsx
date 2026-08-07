import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, emptyCompanyBilling, type CompanyBillingAddress } from "@/lib/api";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

const NUMERIC_KEYS = new Set([
  "fast_sync_minutes",
  "full_sync_hour",
  "global_price_multiplier",
  "global_stock_threshold",
  "orders_max_value_eur",
  "orders_daily_cap_eur",
  "orders_poll_minutes",
  "live_feed_min_minutes",
  "beautyfort_live_max_per_day",
  "bts_live_max_per_day",
]);

const fields: Array<{ key: string; label: string; hint?: string; type: "bool" | "number" | "text" }> = [
  { key: "sync_enabled", label: "Sync enabled", hint: "Master switch for scheduled sync", type: "bool" },
  { key: "fast_sync_minutes", label: "Fast sync minutes", type: "number" },
  { key: "full_sync_enabled", label: "Full sync enabled", hint: "Nightly full catalogue rebuild", type: "bool" },
  { key: "full_sync_hour", label: "Full sync hour (UTC)", type: "number" },
  { key: "sync_source", label: "Sync source", hint: "live | local", type: "text" },
  {
    key: "global_price_multiplier",
    label: "Price multiplier",
    hint: "Fallback when no tier matches (or tiers are empty). Sell = cost × this.",
    type: "number",
  },
  { key: "global_stock_threshold", label: "Stock threshold", type: "number" },
  {
    key: "hide_products_without_image",
    label: "Hide products without image",
    hint: "Exclude from catalog/search when the resolved image is still missing or a placeholder",
    type: "bool",
  },
  { key: "orders_dry_run", label: "Orders dry-run", hint: "When on, never spend money", type: "bool" },
  { key: "orders_auto_dispatch", label: "Auto-dispatch", hint: "Off = human approval required", type: "bool" },
  { key: "orders_max_value_eur", label: "Max order value EUR", type: "number" },
  { key: "orders_daily_cap_eur", label: "Daily spend cap EUR", type: "number" },
  { key: "orders_poll_minutes", label: "Tracking poll minutes", type: "number" },
  {
    key: "orders_notify_customer",
    label: "Notify customer on tracking",
    hint: "Email when tracking is pushed to WooCommerce",
    type: "bool",
  },
  {
    key: "volume_filter_mode",
    label: "Volume filter",
    hint: "ranges | exact | off",
    type: "text",
  },
  {
    key: "description_mode",
    label: "Description mode",
    hint: "none (title copy) | template",
    type: "text",
  },
  {
    key: "live_feed_min_minutes",
    label: "Min minutes between live downloads",
    hint: "Hard gate. Cache is used until this elapses (default 60).",
    type: "number",
  },
  {
    key: "beautyfort_live_max_per_day",
    label: "BeautyFort live downloads / day",
    hint: "Hard cap (BF ~40 SOAP/day budget). Default 20.",
    type: "number",
  },
  {
    key: "bts_live_max_per_day",
    label: "BTS live downloads / day",
    hint: "Hard cap on full catalogue pulls. Default 48.",
    type: "number",
  },
];

const BILLING_FIELDS: Array<{ key: keyof CompanyBillingAddress; label: string; wide?: boolean }> = [
  { key: "company", label: "Company", wide: true },
  { key: "vat", label: "VAT / BTW", wide: true },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "address1", label: "Address line 1", wide: true },
  { key: "address2", label: "Address line 2", wide: true },
  { key: "city", label: "City" },
  { key: "state", label: "State / region" },
  { key: "postcode", label: "Postcode" },
  { key: "country", label: "Country (ISO)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

interface TierRow {
  maxCost: string;
  multiplier: string;
  unbounded: boolean;
}

function isTruthy(v: string | undefined) {
  return v === "1" || v === "true";
}

function parseBilling(raw: string | undefined): CompanyBillingAddress {
  if (!raw) return emptyCompanyBilling();
  try {
    return { ...emptyCompanyBilling(), ...JSON.parse(raw) };
  } catch {
    return emptyCompanyBilling();
  }
}

function parseTiers(raw: string | undefined): TierRow[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ maxCost: number | null; multiplier: number }>;
    if (!Array.isArray(list) || list.length === 0) return [];
    return list.map((t, i) => ({
      maxCost: t.maxCost === null || t.maxCost === undefined ? "" : String(t.maxCost),
      multiplier: String(t.multiplier ?? ""),
      unbounded: t.maxCost === null || t.maxCost === undefined || i === list.length - 1,
    }));
  } catch {
    return [];
  }
}

function serializeTiers(rows: TierRow[]): string {
  if (rows.length === 0) return "[]";
  const out = rows.map((r, i) => {
    const last = i === rows.length - 1;
    return {
      maxCost: last || r.unbounded ? null : Number(r.maxCost),
      multiplier: Number(r.multiplier),
    };
  });
  return JSON.stringify(out);
}

export function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [form, setForm] = useState<Record<string, string>>({});
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [bfBilling, setBfBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());
  const [btsBilling, setBtsBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setTiers(parseTiers(data.price_tiers));
    setBfBilling(parseBilling(data.company_billing_beautyfort));
    setBtsBilling(parseBilling(data.company_billing_bts));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        ...form,
        price_tiers: serializeTiers(tiers),
        company_billing_beautyfort: JSON.stringify(bfBilling),
        company_billing_bts: JSON.stringify(btsBilling),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast("Settings saved", "ok");
      if (res.syncStarted) toast("Sync started from settings change", "info");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const setBool = (key: string, v: boolean) => setForm((prev) => ({ ...prev, [key]: v ? "1" : "0" }));

  const updateTier = (index: number, patch: Partial<TierRow>) => {
    setTiers((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addTier = () => {
    setTiers((prev) => {
      if (prev.length === 0) return [{ maxCost: "", multiplier: "1.5", unbounded: true }];
      const next = prev.map((r, i) =>
        i === prev.length - 1 ? { ...r, unbounded: false, maxCost: r.maxCost || "80" } : r,
      );
      return [...next, { maxCost: "", multiplier: "1.5", unbounded: true }];
    });
  };

  const removeTier = (index: number) => {
    setTiers((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) return [];
      return next.map((r, i) => ({ ...r, unbounded: i === next.length - 1 }));
    });
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted">Single source of truth — no wp-admin configuration</p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </header>

      <div className="grid gap-4 rounded-xl border border-line bg-panel p-5 shadow-sm md:grid-cols-2">
        {fields.map((f) =>
          f.type === "bool" ? (
            <div key={f.key} className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3">
              <Toggle
                label={f.label}
                hint={f.hint}
                checked={isTruthy(form[f.key])}
                disabled={save.isPending}
                onChange={(v) => setBool(f.key, v)}
              />
            </div>
          ) : (
            <label key={f.key} className="block text-sm">
              <span className="font-medium text-ink">{f.label}</span>
              <input
                type={NUMERIC_KEYS.has(f.key) ? "number" : "text"}
                step={f.key.includes("multiplier") ? "0.01" : "1"}
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                value={form[f.key] ?? ""}
                disabled={save.isPending}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
              {f.hint ? <span className="mt-1 block text-xs text-muted">{f.hint}</span> : null}
            </label>
          ),
        )}
      </div>

      <section className="space-y-3 rounded-xl border border-line bg-panel p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Price tiers</h2>
          <p className="text-sm text-muted">
            Cost bands (vendor price × FX). First matching max cost wins; the last row is unbounded.
            Empty list falls back to the global multiplier above.
          </p>
          <p className="mt-1 text-sm text-muted">
            Changing tiers requires <code className="font-mono text-xs">bun run sync -- --rewrite-all</code> to
            take effect, because sync hashes cover vendor data only and a settings change produces no hash
            change.
          </p>
        </div>
        <div className="space-y-2">
          {tiers.length === 0 ? (
            <p className="text-sm text-muted">No tiers — global multiplier only.</p>
          ) : (
            tiers.map((row, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <label className="block text-sm">
                  <span className="text-xs text-muted">Max cost (EUR)</span>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-36 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-sm disabled:opacity-50"
                    placeholder={row.unbounded ? "∞" : "80"}
                    value={row.unbounded ? "" : row.maxCost}
                    disabled={save.isPending || row.unbounded}
                    onChange={(e) => updateTier(i, { maxCost: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-muted">Multiplier</span>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-28 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-sm"
                    value={row.multiplier}
                    disabled={save.isPending}
                    onChange={(e) => updateTier(i, { multiplier: e.target.value })}
                  />
                </label>
                <span className="pb-2 text-xs text-muted">{row.unbounded ? "unbounded (last)" : null}</span>
                <button
                  type="button"
                  className="mb-0.5 rounded-lg border border-line px-2.5 py-1.5 text-xs disabled:opacity-40"
                  disabled={save.isPending}
                  onClick={() => removeTier(i)}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
        <button
          type="button"
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={save.isPending}
          onClick={addTier}
        >
          Add tier
        </button>
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-panel p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Company billing profiles</h2>
          <p className="text-sm text-muted">
            Used as the vendor invoice address (BeautyFort InvoiceAddress). BTS has no billing API —
            keep this for ops reference and dry-run payloads.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <BillingEditor
            title="BeautyFort"
            value={bfBilling}
            disabled={save.isPending}
            onChange={setBfBilling}
          />
          <BillingEditor title="BTS" value={btsBilling} disabled={save.isPending} onChange={setBtsBilling} />
        </div>
      </section>
    </div>
  );
}

function BillingEditor({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: CompanyBillingAddress;
  onChange: (v: CompanyBillingAddress) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line/70 bg-canvas/30 p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {BILLING_FIELDS.map((f) => (
          <label key={f.key} className={cn("block text-sm", f.wide && "sm:col-span-2")}>
            <span className="text-xs text-muted">{f.label}</span>
            <input
              className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              value={value[f.key]}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
