import { useCallback, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatInTimeZone, resolveTimeZone } from "@/lib/timezone";
import { useOperatorTimezone } from "@/components/TimezoneProvider";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function eur(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(v);
}

/** Format a MariaDB/UTC timestamp in the given IANA zone (default UTC). */
export function fmtDate(v: string | null | undefined, timeZone = "UTC") {
  if (!v) return "—";
  const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "—";
  return formatInTimeZone(d, resolveTimeZone(timeZone));
}

/** Dashboard clocks follow Settings → schedule_timezone. */
export function useFmtDate() {
  const tz = useOperatorTimezone();
  return (v: string | null | undefined) => fmtDate(v, tz);
}

/**
 * Rows per page for a list, remembered across reloads.
 *
 * The engine clamps `limit` to 1..`max` on every list endpoint, so the same ceiling is applied here
 * rather than quietly asking for a page it cannot return.
 */
export function useRowLimit(storageKey: string, fallback = 50, max = 100) {
  const [limit, setLimitState] = useState(() => {
    try {
      const stored = Math.trunc(Number(window.localStorage.getItem(storageKey)));
      if (stored >= 1 && stored <= max) return stored;
    } catch {
      /* storage unavailable — fall through to the default */
    }
    return fallback;
  });

  const setLimit = useCallback(
    (n: number) => {
      const clamped = Number.isFinite(n) ? Math.min(max, Math.max(1, Math.trunc(n))) : fallback;
      setLimitState(clamped);
      try {
        window.localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* storage unavailable — the choice just will not survive a reload */
      }
    },
    [storageKey, fallback, max],
  );

  return [limit, setLimit] as const;
}
