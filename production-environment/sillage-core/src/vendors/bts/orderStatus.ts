export function normalizeOrderStatus(status: string): string {
  const raw = String(status ?? "").trim();
  if (!raw) return "";

  const s = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (
    s.includes("pending payment") ||
    s.includes("awaiting payment") ||
    s.includes("bezahl") ||
    s.includes("zahlung")
  ) {
    return "Pending Payment";
  }
  if (s === "paid" || s.includes("pagad") || s.includes("bezahlt")) {
    return "Paid";
  }
  if (
    s.includes("shipp") ||
    s.includes("enviad") ||
    s.includes("expedi") ||
    s.includes("versand")
  ) {
    return "Shipped";
  }
  if (
    s.includes("deliver") ||
    s.includes("entreg") ||
    s.includes("zugestellt")
  ) {
    return "Delivered";
  }
  if (
    s.includes("cancel") ||
    s.includes("storn") ||
    s.includes("annul")
  ) {
    return "Cancelled";
  }

  return raw;
}
