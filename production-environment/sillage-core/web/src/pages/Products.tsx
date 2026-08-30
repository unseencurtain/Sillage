import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pagination } from "@/components/Pagination";
import { api } from "@/lib/api";
import { cn, eur } from "@/lib/utils";

export function Products() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["products", q, page],
    queryFn: () => api.products(q, page),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted">
            {data ? `${data.total.toLocaleString()} products` : "Catalogue search"}
            . Stock is the winning offer; Shop follows Settings hide-without-image and stock
            threshold (same rules as WooCommerce).
          </p>
        </div>
        <input
          className="w-full max-w-sm rounded-lg border border-line bg-panel px-3 py-2 text-sm"
          placeholder="Search SKU, name, EAN…"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
      </header>

      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Shop</th>
              <th className="px-4 py-3">Cost</th>
              <th className="px-4 py-3">WP</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-muted">
                  Loading…
                </td>
              </tr>
            ) : (
              (data?.items ?? []).map((p) => (
                <tr key={p.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{p.sku}</td>
                  <td className="px-4 py-3 max-w-md truncate">{p.name}</td>
                  <td className="px-4 py-3">{p.vendor}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{p.stock}</td>
                  <td className="px-4 py-3">
                    <ShopBadge visibility={p.shop_visibility} />
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{eur(p.vendor_price)}</td>
                  <td className="px-4 py-3 font-mono text-muted">{p.wp_post_id}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data ? (
        <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}

function ShopBadge({ visibility }: { visibility?: "visible" | "hidden_no_image" | "hidden_stock" }) {
  if (visibility === "hidden_no_image") {
    return (
      <span className={cn("rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900")}>
        Hidden · no image
      </span>
    );
  }
  if (visibility === "hidden_stock") {
    return (
      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
        Hidden · stock
      </span>
    );
  }
  if (visibility === "visible") {
    return <span className="text-xs font-medium text-ok">Visible</span>;
  }
  return <span className="text-xs text-muted">—</span>;
}
