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
    hint: "Sell = cost × this. Example: 5 turns €1 cost into €5. Saving starts a sync to WooCommerce.",
    type: "number",
  },
  { key: "global_stock_threshold", label: "Stock threshold", type: "number" },
  {
    key: "image_cdn_base_url",
    label: "Image CDN base URL",
    hint: "Public origin for self-hosted files (e.g. https://images.slilverbelt.xyz). Does not rewrite existing product URLs — update image_overrides.json / tool PUBLIC_URL_BASE, then sync with --rewrite-all.",
    type: "text",
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

export function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [form, setForm] = useState<Record<string, string>>({});
  const [bfBilling, setBfBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());
  const [btsBilling, setBtsBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setBfBilling(parseBilling(data.company_billing_beautyfort));
    setBtsBilling(parseBilling(data.company_billing_bts));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        ...form,
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
