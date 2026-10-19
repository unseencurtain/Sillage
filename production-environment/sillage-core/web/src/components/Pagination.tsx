import { useEffect, useRef, useState } from "react";

export function Pagination({
  page,
  limit,
  total,
  onPageChange,
  onLimitChange,
  limitMax = 100,
}: {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
  /** When given, renders an editable rows-per-page box. */
  onLimitChange?: (limit: number) => void;
  /** The largest page the engine will return. */
  limitMax?: number;
}) {
  const showing = total === 0 ? 0 : Math.min(page * limit, total);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)));

  // Typed freely. A settled number is applied even without leaving the box, so reloading or walking
  // away mid-edit does not lose the choice; a half-typed "1" of "100" waits for the pause.
  const [draft, setDraft] = useState(String(limit));

  const onChange = useRef(onLimitChange);
  useEffect(() => {
    onChange.current = onLimitChange;
  });

  useEffect(() => setDraft(String(limit)), [limit]);

  useEffect(() => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) return;
    const clamped = Math.min(limitMax, n);
    if (clamped === limit) return;
    const t = setTimeout(() => onChange.current?.(clamped), 400);
    return () => clearTimeout(t);
  }, [draft, limit, limitMax]);

  const commit = () => {
    const n = Math.trunc(Number(draft));
    if (!Number.isFinite(n) || n < 1) {
      setDraft(String(limit));
      return;
    }
    const clamped = Math.min(limitMax, n);
    setDraft(String(clamped));
    if (clamped !== limit) onChange.current?.(clamped);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </button>
      <span className="font-mono text-muted">
        page {page}
        {total > 0 ? ` of ${pages.toLocaleString()} · ${from}–${showing} of ${total.toLocaleString()}` : ""}
      </span>
      <button
        type="button"
        className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
        disabled={page * limit >= total}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
      {onLimitChange ? (
        <label className="flex items-center gap-2 text-muted">
          Rows
          <input
            type="number"
            min={1}
            max={limitMax}
            inputMode="numeric"
            className="w-20 rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs tabular-nums"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
          />
          per page
        </label>
      ) : null}
    </div>
  );
}
