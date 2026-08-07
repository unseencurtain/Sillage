export function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint ? <div className="mt-1 text-sm text-muted">{hint}</div> : null}
    </div>
  );
}
