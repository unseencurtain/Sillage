import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const fields: Array<{ key: string; label: string; hint?: string }> = [
  { key: "sync_enabled", label: "Sync enabled", hint: "0/1" },
  { key: "fast_sync_minutes", label: "Fast sync minutes" },
  { key: "full_sync_enabled", label: "Full sync enabled", hint: "0/1" },
  { key: "full_sync_hour", label: "Full sync hour (UTC)" },
  { key: "sync_source", label: "Sync source", hint: "live | local" },
  { key: "global_price_multiplier", label: "Price multiplier" },
  { key: "global_stock_threshold", label: "Stock threshold" },
  { key: "orders_dry_run", label: "Orders dry-run", hint: "1 = never spend money" },
  { key: "orders_auto_dispatch", label: "Auto-dispatch", hint: "0 = human approval required" },
  { key: "orders_max_value_eur", label: "Max order value EUR" },
  { key: "orders_daily_cap_eur", label: "Daily spend cap EUR" },
  { key: "orders_poll_minutes", label: "Tracking poll minutes" },
  { key: "orders_notify_customer", label: "Notify customer on tracking", hint: "0/1" },
];

export function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.saveSettings(form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted">Single source of truth — no wp-admin configuration</p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink disabled:opacity-60"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </header>

      {save.isSuccess ? <p className="text-sm text-ok">Saved</p> : null}

      <div className="grid gap-4 rounded-xl border border-line bg-panel p-5 shadow-sm md:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="text-muted">{f.label}</span>
            <input
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 font-mono text-sm"
              value={form[f.key] ?? ""}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
            {f.hint ? <span className="mt-1 block text-xs text-muted">{f.hint}</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}
