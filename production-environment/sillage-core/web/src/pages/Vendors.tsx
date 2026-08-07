import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Vendor, type VendorPatch } from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";

interface VendorForm {
  storefrontLabel: string;
  priceMultiplier: string;
  minVisibleStock: string;
  fxRate: string;
  vatRate: string;
  minOrderValueEur: string;
  serviceableCountries: string;
  active: boolean;
  liveMaxPerDay: string;
  storeLiveMaxPerDay: string;
  storeLiveMinMinutes: string;
}

function toForm(v: Vendor): VendorForm {
  return {
    storefrontLabel: v.storefrontLabel,
    priceMultiplier: v.priceMultiplier === null || v.priceMultiplier === undefined ? "" : String(v.priceMultiplier),
    minVisibleStock: v.minVisibleStock === null || v.minVisibleStock === undefined ? "" : String(v.minVisibleStock),
    fxRate: String(v.fxRate),
    vatRate: String(v.vatRate),
    minOrderValueEur:
      v.minOrderValueEur === null || v.minOrderValueEur === undefined ? "" : String(v.minOrderValueEur),
    serviceableCountries: v.serviceableCountries.join(" "),
    active: v.active,
    liveMaxPerDay: v.liveMaxPerDay === null || v.liveMaxPerDay === undefined ? "" : String(v.liveMaxPerDay),
    storeLiveMaxPerDay:
      v.storeLiveMaxPerDay === null || v.storeLiveMaxPerDay === undefined ? "" : String(v.storeLiveMaxPerDay),
    storeLiveMinMinutes:
      v.storeLiveMinMinutes === null || v.storeLiveMinMinutes === undefined ? "" : String(v.storeLiveMinMinutes),
  };
}

function parseCountries(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function countriesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((c, i) => c === sb[i]);
}

function emptyToNullNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  return Number(t);
}

function buildPatch(form: VendorForm, original: Vendor): VendorPatch {
  const patch: VendorPatch = {};
  if (form.storefrontLabel.trim() !== original.storefrontLabel) {
    patch.storefrontLabel = form.storefrontLabel.trim();
  }

  const mult = emptyToNullNumber(form.priceMultiplier);
  if (mult !== original.priceMultiplier) patch.priceMultiplier = mult;

  const stock = emptyToNullNumber(form.minVisibleStock);
  const stockInt = stock === null ? null : Math.trunc(stock);
  if (stockInt !== original.minVisibleStock) patch.minVisibleStock = stockInt;

  const fx = Number(form.fxRate);
  if (fx !== original.fxRate) patch.fxRate = fx;

  const vat = Number(form.vatRate);
  if (vat !== original.vatRate) patch.vatRate = vat;

  const minOrder = emptyToNullNumber(form.minOrderValueEur);
  if (minOrder !== original.minOrderValueEur) patch.minOrderValueEur = minOrder;

  const countries = parseCountries(form.serviceableCountries);
  if (!countriesEqual(countries, original.serviceableCountries)) {
    patch.serviceableCountries = countries;
  }

  if (form.active !== original.active) patch.active = form.active;

  const liveMax = emptyToNullNumber(form.liveMaxPerDay);
  const liveMaxInt = liveMax === null ? null : Math.trunc(liveMax);
  if (liveMaxInt !== original.liveMaxPerDay) patch.liveMaxPerDay = liveMaxInt;

  if (original.slug === "wholesale-perfumes") {
    const storeMax = emptyToNullNumber(form.storeLiveMaxPerDay);
    const storeMaxInt = storeMax === null ? null : Math.trunc(storeMax);
    if (storeMaxInt !== original.storeLiveMaxPerDay) patch.storeLiveMaxPerDay = storeMaxInt;

    const storeMin = emptyToNullNumber(form.storeLiveMinMinutes);
    const storeMinInt = storeMin === null ? null : Math.trunc(storeMin);
    if (storeMinInt !== original.storeLiveMinMinutes) patch.storeLiveMinMinutes = storeMinInt;
  }

  return patch;
}

function confirmDescription(original: Vendor, patch: VendorPatch): string {
  const parts: string[] = [];
  if (patch.active !== undefined) {
    parts.push(
      patch.active
        ? `Activate “${original.storefrontLabel || original.name}” (${original.slug}) — orders may dispatch to this supplier.`
        : `Deactivate “${original.storefrontLabel || original.name}” (${original.slug}) — this supplier will stop receiving dispatch.`,
    );
  }
  if (patch.serviceableCountries !== undefined) {
    const from = original.serviceableCountries.join(" ") || "(none)";
    const to = patch.serviceableCountries.join(" ") || "(none)";
    parts.push(`Change serviceable countries from ${from} to ${to}.`);
  }
  return parts.join(" ");
}

export function Vendors() {
  const { data, isLoading } = useQuery({ queryKey: ["vendors"], queryFn: api.vendors });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <p className="text-sm text-muted">
          Per-supplier multipliers, stock floors, VAT, shipping coverage, and live-feed caps
        </p>
      </header>

      {isLoading ? <p className="text-muted">Loading…</p> : null}

      <div className="grid gap-4 xl:grid-cols-1">
        {(data?.vendors ?? []).map((v) => (
          <VendorEditor
            key={v.id}
            vendor={v}
            globalPriceMultiplier={data?.globalPriceMultiplier ?? 1}
            globalStockThreshold={data?.globalStockThreshold ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

function VendorEditor({
  vendor,
  globalPriceMultiplier,
  globalStockThreshold,
}: {
  vendor: Vendor;
  globalPriceMultiplier: number;
  globalStockThreshold: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<VendorForm>(() => toForm(vendor));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingPatch, setPendingPatch] = useState<VendorPatch | null>(null);

  useEffect(() => {
    setForm(toForm(vendor));
    setConfirmOpen(false);
    setPendingPatch(null);
  }, [vendor]);

  const save = useMutation({
    mutationFn: (patch: VendorPatch) => api.saveVendor(vendor.slug, patch),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast("Vendor saved", "ok");
      if (res.syncStarted) toast("Price rewrite started (cache / rewrite-only)", "info");
      setConfirmOpen(false);
      setPendingPatch(null);
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const set = <K extends keyof VendorForm>(key: K, value: VendorForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const requestSave = () => {
    const patch = buildPatch(form, vendor);
    if (Object.keys(patch).length === 0) {
      toast("No changes", "info");
      return;
    }
    const needsConfirm = patch.active !== undefined || patch.serviceableCountries !== undefined;
    if (needsConfirm) {
      setPendingPatch(patch);
      setConfirmOpen(true);
      return;
    }
    save.mutate(patch);
  };

  const inputClass =
    "mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-60";

  return (
    <article className="rounded-xl border border-line bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{vendor.storefrontLabel || vendor.name}</h2>
          <div className="font-mono text-xs text-muted">
            {vendor.slug} · SKU {vendor.skuPrefix}-*
            {vendor.storefrontLabel && vendor.storefrontLabel !== vendor.name ? ` · internal ${vendor.name}` : ""}
          </div>
        </div>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
            form.active ? "bg-emerald-50 text-ok ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200"
          }`}
        >
          {form.active ? "active" : "inactive"}
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-ink">Storefront label</span>
          <input
            className={inputClass}
            value={form.storefrontLabel}
            disabled={save.isPending}
            onChange={(e) => set("storefrontLabel", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">Customer-facing section name (e.g. LPS01)</span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Price multiplier</span>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            placeholder={`Global ${globalPriceMultiplier}`}
            value={form.priceMultiplier}
            disabled={save.isPending}
            onChange={(e) => set("priceMultiplier", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Empty = fall back to global multiplier and price tiers. A value here disables tiered pricing for
            this vendor.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Min visible stock</span>
          <input
            type="number"
            step="1"
            className={inputClass}
            placeholder={`Global ${globalStockThreshold}`}
            value={form.minVisibleStock}
            disabled={save.isPending}
            onChange={(e) => set("minVisibleStock", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Empty = fall back to the global stock threshold ({globalStockThreshold}).
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">FX rate</span>
          <input
            type="number"
            step="0.000001"
            className={inputClass}
            value={form.fxRate}
            disabled={save.isPending}
            onChange={(e) => set("fxRate", e.target.value)}
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">VAT rate (fraction)</span>
          <input
            type="number"
            step="0.0001"
            className={inputClass}
            value={form.vatRate}
            disabled={save.isPending}
            onChange={(e) => set("vatRate", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Cost = vendor price × FX × (1 + VAT). Use 0.21 for 21%, not 21. wholesale-perfumes publishes
            ex-VAT prices.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Min order value (EUR)</span>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            placeholder="none"
            value={form.minOrderValueEur}
            disabled={save.isPending}
            onChange={(e) => set("minOrderValueEur", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Stored in order_config.min_order_value_eur. Empty clears that key only.
          </span>
        </label>

        <label className="block text-sm md:col-span-2">
          <span className="font-medium text-ink">Serviceable countries</span>
          <input
            className={inputClass}
            value={form.serviceableCountries}
            disabled={save.isPending}
            onChange={(e) => set("serviceableCountries", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Space- or comma-separated ISO codes (e.g. BE DE NL). Changing this requires confirmation.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Live downloads / day</span>
          <input
            type="number"
            step="1"
            className={inputClass}
            value={form.liveMaxPerDay}
            disabled={save.isPending}
            onChange={(e) => set("liveMaxPerDay", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">Catalogue feed daily cap (BeautyFort ~40 SOAP budget).</span>
        </label>

        {vendor.slug === "wholesale-perfumes" ? (
          <>
            <label className="block text-sm">
              <span className="font-medium text-ink">Store feed downloads / day</span>
              <input
                type="number"
                step="1"
                className={inputClass}
                value={form.storeLiveMaxPerDay}
                disabled={save.isPending}
                onChange={(e) => set("storeLiveMaxPerDay", e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted">
                wholesale-perfumes price/stock XML — separate from the once-per-day catalog cap
                (default 24).
              </span>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-ink">Store feed min minutes</span>
              <input
                type="number"
                step="1"
                className={inputClass}
                value={form.storeLiveMinMinutes}
                disabled={save.isPending}
                onChange={(e) => set("storeLiveMinMinutes", e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted">
                Minimum interval between wholesale-perfumes store downloads (default 60).
              </span>
            </label>
          </>
        ) : null}

        <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3 md:col-span-2">
          <Toggle
            label="Active"
            hint="Inactive vendors are skipped by sync and cannot receive dispatch. Requires confirmation."
            checked={form.active}
            disabled={save.isPending}
            onChange={(v) => set("active", v)}
          />
        </div>
      </div>

      <p className="mt-4 text-sm text-muted">
        Changing the multiplier or VAT requires{" "}
        <code className="font-mono text-xs">bun run sync -- --rewrite-all</code> (or the automatic
        rewrite-only sync after save) to take effect, because sync hashes cover vendor data only.
      </p>

      {confirmOpen && pendingPatch ? (
        <div className="mt-4">
          <ConfirmPanel
            title="Confirm vendor dispatch settings"
            description={confirmDescription(vendor, pendingPatch)}
            confirmLabel="Confirm and save"
            danger
            pending={save.isPending}
            onCancel={() => {
              setConfirmOpen(false);
              setPendingPatch(null);
            }}
            onConfirm={() => pendingPatch && save.mutate(pendingPatch)}
          />
        </div>
      ) : (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
            disabled={save.isPending}
            onClick={requestSave}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </article>
  );
}
