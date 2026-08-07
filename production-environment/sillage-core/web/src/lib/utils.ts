import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function eur(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(v);
}

export function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  return new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z").toLocaleString();
}
