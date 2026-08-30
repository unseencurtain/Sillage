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

export function btsVendorPollStatus(
  orderStatus: string,
): "pending" | "confirmed" | "dispatched" | "delivered" | "cancelled" | "unknown" {
  const normalised = normalizeOrderStatus(orderStatus);
  if (normalised === "Delivered") return "delivered";
  if (normalised === "Shipped") return "dispatched";
  if (normalised === "Paid") return "confirmed";
  if (normalised === "Pending Payment") return "pending";
  if (normalised === "Cancelled") return "cancelled";
  return "unknown";
}
