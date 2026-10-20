import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, ExternalLink, Star, Trash2 } from "lucide-react";
import { api, reviewPhotoUrl, type ReviewStatus, type StoreReview } from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { Pagination } from "@/components/Pagination";
import { useToast } from "@/components/Toast";
import { cn, useFmtDate } from "@/lib/utils";

const TABS: Array<{ value: ReviewStatus | "all"; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "published", label: "Published" },
  { value: "hidden", label: "Hidden" },
  { value: "all", label: "All" },
];

function Rating({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={14}
          className={star <= value ? "fill-amber-400 text-amber-400" : "text-slate-300"}
        />
      ))}
    </span>
  );
}

function author(review: StoreReview): string {
  return review.name || review.email || "Customer";
}

export function Reviews() {
  const [status, setStatus] = useState<ReviewStatus | "all">("pending");
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<StoreReview | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const fmtDate = useFmtDate();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["reviews", status, page],
    queryFn: () => api.reviews(status, page),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["reviews"] });

  const moderate = useMutation({
    mutationFn: ({ id, next }: { id: number; next: ReviewStatus }) =>
      api.setReviewStatus(id, next),
    onSuccess: (_data, variables) => {
      toast(
        variables.next === "published" ? "Review published" : "Review hidden",
        "ok",
      );
      refresh();
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteReview(id),
    onSuccess: () => {
      toast("Review deleted", "ok");
      setDeleting(null);
      refresh();
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const items = data?.items ?? [];
  const counts = data?.counts ?? { pending: 0, published: 0, hidden: 0 };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Reviews</h1>
        <p className="mt-1 text-sm text-muted">
          Only signed-in customers with a delivered order can submit a review. Nothing is public until
          you approve it.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab) => {
          const count = tab.value === "all" ? counts.pending + counts.published + counts.hidden : counts[tab.value];
          return (
            <button
              key={tab.value}
              type="button"
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition",
                status === tab.value
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line bg-panel text-muted hover:text-ink",
              )}
              onClick={() => {
                setStatus(tab.value);
                setPage(1);
              }}
            >
              {tab.label}
              <span className="ml-1.5 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted">Loading reviews…</p>
      ) : isError ? (
        <p className="text-sm text-danger">{(error as Error).message}</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-8 text-center text-sm text-muted">
          {status === "pending" ? "Nothing waiting for approval." : "No reviews in this tab."}
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((review) => (
            <li key={review.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Rating value={review.rating} />
                    <span className="text-sm font-medium">{author(review)}</span>
                    {review.email ? (
                      <span className="text-xs text-muted">{review.email}</span>
                    ) : null}
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs ring-1",
                        review.status === "published"
                          ? "bg-teal-50 text-accent ring-teal-200"
                          : review.status === "pending"
                            ? "bg-amber-50 text-warn ring-amber-200"
                            : "bg-slate-100 text-slate-500 ring-slate-200",
                      )}
                    >
                      {review.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    {review.productSlug ? (
                      <a
                        className="inline-flex items-center gap-1 underline-offset-2 hover:text-ink hover:underline"
                        href={`/product/${review.productSlug}/`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {review.productName || review.productSlug}
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span>{review.productName || "Product"}</span>
                    )}
                    <span>EAN {review.ean}</span>
                    <span>·</span>
                    <span>{fmtDate(review.createdAt)}</span>
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  {review.status !== "published" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-50"
                      disabled={moderate.isPending}
                      onClick={() => moderate.mutate({ id: review.id, next: "published" })}
                    >
                      <Check size={14} />
                      Approve
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={moderate.isPending}
                      onClick={() => moderate.mutate({ id: review.id, next: "hidden" })}
                    >
                      <EyeOff size={14} />
                      Hide
                    </button>
                  )}
                  {review.status === "hidden" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={moderate.isPending}
                      onClick={() => moderate.mutate({ id: review.id, next: "published" })}
                    >
                      <Eye size={14} />
                      Publish
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-danger hover:bg-canvas disabled:opacity-50"
                    disabled={remove.isPending}
                    onClick={() => setDeleting(review)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {review.title ? <div className="mt-3 text-sm font-medium">{review.title}</div> : null}
              {review.body ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted">{review.body}</p>
              ) : null}

              {review.verified || review.recommends !== null ? (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
                  {review.verified ? <span>Verified buyer</span> : null}
                  {review.recommends === true ? <span>Recommends this product</span> : null}
                  {review.recommends === false ? <span>Does not recommend this product</span> : null}
                  {review.helpfulCount > 0 ? <span>{review.helpfulCount} found this helpful</span> : null}
                </div>
              ) : null}

              {review.photos?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {review.photos.map((photo) => (
                    <a
                      key={photo}
                      href={reviewPhotoUrl(photo)}
                      target="_blank"
                      rel="noreferrer"
                      className="block h-20 w-20 overflow-hidden rounded-lg border border-line"
                    >
                      <img
                        src={reviewPhotoUrl(photo)}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              ) : null}

              {deleting?.id === review.id ? (
                <div className="mt-3">
                  <ConfirmPanel
                    title="Delete this review?"
                    description="It is removed from the database, not hidden. This cannot be undone."
                    confirmLabel="Delete"
                    danger
                    pending={remove.isPending}
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => remove.mutate(review.id)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {data ? (
        <Pagination
          page={page}
          limit={data.limit}
          total={data.total}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}
