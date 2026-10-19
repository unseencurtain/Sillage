import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  Inbox,
  MailOpen,
  Mail,
  RefreshCw,
  Reply,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  api,
  type MessageKind,
  type MessageStatus,
  type StoreMessage,
} from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { Pagination } from "@/components/Pagination";
import { useToast } from "@/components/Toast";
import { cn, useFmtDate } from "@/lib/utils";

const TABS: Array<{ kind: MessageKind; label: string; hint: string }> = [
  { kind: "contact", label: "Contact", hint: "Questions from the shop's contact form" },
  { kind: "withdrawal", label: "Withdrawal", hint: "Right-of-withdrawal notices" },
];

const STATUS_OPTIONS: Array<{ value: MessageStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "archived", label: "Archived" },
];

const statusTone: Record<MessageStatus, string> = {
  new: "bg-teal-50 text-accent ring-teal-200",
  read: "bg-slate-100 text-slate-600 ring-slate-200",
  archived: "bg-slate-100 text-slate-400 ring-slate-200",
};

/** One line that tells the two forms apart at a glance in the list. */
function preview(message: StoreMessage): string {
  if (message.kind === "contact") return message.subject || message.body || "(no message)";
  return message.goods || "(no goods listed)";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{children}</div>
    </div>
  );
}

function Who({ message }: { message: StoreMessage }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        message.signed_in
          ? "bg-teal-50 text-accent ring-teal-200"
          : "bg-slate-100 text-slate-600 ring-slate-200",
      )}
    >
      <UserRound size={12} />
      {message.signed_in ? `Customer #${message.customer_id ?? "?"}` : "Guest"}
    </span>
  );
}

export function Messages() {
  const fmtDate = useFmtDate();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [kind, setKind] = useState<MessageKind>("contact");
  const [status, setStatus] = useState<MessageStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Ids ticked in the list. Only ever holds rows of the current tab and page. */
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["messages", kind, status, page],
    queryFn: () => api.messages(kind, page, status),
  });

  const items = data?.items ?? [];
  const selected = items.find((m) => m.id === selectedId) ?? items[0] ?? null;
  const counts = data?.counts ?? { contact: 0, withdrawal: 0 };
  const archivedCount = data?.archived?.[kind] ?? 0;
  const allPicked = items.length > 0 && items.every((m) => picked.has(m.id));

  const togglePicked = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(items.map((m) => m.id)));

  const changeStatus = useMutation({
    mutationFn: (vars: { id: number; status: MessageStatus; silent?: boolean }) =>
      api.setMessageStatus(kind, vars.id, vars.status),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      if (vars.silent) return;
      toast(
        vars.status === "archived"
          ? "Message archived"
          : vars.status === "read"
            ? "Marked as read"
            : "Marked as unread",
        "ok",
      );
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not update the message", "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteMessage(kind, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      setConfirmDelete(false);
      setSelectedId(null);
      toast("Message deleted", "ok");
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not delete the message", "error"),
  });

  const bulkRemove = useMutation({
    mutationFn: (ids: number[]) => api.bulkDeleteMessages(kind, ids),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      setPicked(new Set());
      setConfirmBulk(false);
      setSelectedId(null);
      toast(res.removed === 1 ? "Message deleted" : `${res.removed} messages deleted`, "ok");
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not delete those messages", "error"),
  });

  const purgeArchive = useMutation({
    mutationFn: () => api.emptyArchive(kind),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      setConfirmPurge(false);
      setSelectedId(null);
      toast(
        res.removed === 1 ? "Archived message deleted" : `${res.removed} archived messages deleted`,
        "ok",
      );
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not empty the archive", "error"),
  });

  // Opening an unread message reads it, the way a mail client does. The row is what changes, so the
  // list badge and the tab count follow without a reload.
  useEffect(() => {
    if (selected && selected.status === "new") {
      changeStatus.mutate({ id: selected.id, status: "read", silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  // A new tab, filter or page shows a different list; forget the old selection, ticks and confirms.
  useEffect(() => {
    setSelectedId(null);
    setConfirmDelete(false);
    setPicked(new Set());
    setConfirmBulk(false);
    setConfirmPurge(false);
  }, [kind, status, page]);

  // Switching tab or filter starts at the first page. A page number carried over from the old view
  // can be past the end of the new one, which would show a blank list that reads as "no messages".
  useEffect(() => {
    setPage(1);
  }, [kind, status]);

  // Deleting rows off the last page can leave the page past the end. Step back so the list is never
  // blank while the count above says there is something to show.
  useEffect(() => {
    if (data && items.length === 0 && page > 1) setPage(1);
  }, [data, items.length, page]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
          <p className="text-sm text-muted">
            {counts.contact + counts.withdrawal > 0
              ? `${counts.contact + counts.withdrawal} unread`
              : "Nothing unread"}
            {data ? ` · ${data.total.toLocaleString()} in this view` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Pull new submissions in without reloading the dashboard: the response carries the
              unread counts for both tabs, so one fetch also refreshes the badges above. */}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Check for new messages"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink transition hover:bg-canvas disabled:opacity-60"
          >
            <RefreshCw size={15} className={isFetching ? "animate-spin" : undefined} />
            {isFetching ? "Checking…" : "Refresh"}
          </button>
          <label className="flex items-center gap-2 text-sm text-muted">
            Show
            <select
              className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              value={status}
              onChange={(event) => setStatus(event.target.value as MessageStatus | "all")}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="flex gap-1 border-b border-line">
        {TABS.map((tab) => {
          const unread = counts[tab.kind];
          const active = tab.kind === kind;
          return (
            <button
              key={tab.kind}
              type="button"
              onClick={() => setKind(tab.kind)}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
                active
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              {tab.label}
              {unread > 0 ? (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-accent-ink">
                  {unread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
          {/* Clearing up in bulk: tick the rows you mean, or empty this tab's whole archive. */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-teal-600"
                checked={allPicked}
                disabled={items.length === 0}
                onChange={toggleAll}
              />
              {picked.size > 0 ? `${picked.size} selected` : "Select all"}
            </label>
            <div className="flex items-center gap-2">
              {picked.size > 0 ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1 text-xs text-danger hover:bg-red-50"
                  onClick={() => setConfirmBulk(true)}
                >
                  <Trash2 size={13} />
                  Delete {picked.size}
                </button>
              ) : null}
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-canvas disabled:opacity-50"
                disabled={archivedCount === 0}
                title={archivedCount === 0 ? "Nothing is archived under this tab" : undefined}
                onClick={() => setConfirmPurge(true)}
              >
                <ArchiveX size={13} />
                Empty archive{archivedCount > 0 ? ` (${archivedCount})` : ""}
              </button>
            </div>
          </div>

          {confirmBulk ? (
            <div className="border-b border-line p-3">
              <ConfirmPanel
                title={`Delete ${picked.size} message${picked.size === 1 ? "" : "s"}?`}
                description="They are removed for good. The notifications already sent are not affected."
                confirmLabel="Delete"
                danger
                pending={bulkRemove.isPending}
                onConfirm={() => bulkRemove.mutate([...picked])}
                onCancel={() => setConfirmBulk(false)}
              />
            </div>
          ) : null}

          {confirmPurge ? (
            <div className="border-b border-line p-3">
              <ConfirmPanel
                title={`Empty ${archivedCount === 1 ? "the archived message" : `the ${archivedCount} archived messages`}?`}
                description="Everything already archived under this tab goes for good. Read and unread messages stay."
                confirmLabel="Empty archive"
                danger
                pending={purgeArchive.isPending}
                onConfirm={() => purgeArchive.mutate()}
                onCancel={() => setConfirmPurge(false)}
              />
            </div>
          ) : null}

          <div className="md:max-h-[60vh] md:overflow-y-auto">
            {isLoading ? (
              <p className="px-4 py-6 text-sm text-muted">Loading…</p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-muted">
                <Inbox size={24} />
                <p className="text-sm">No messages here.</p>
              </div>
            ) : (
              items.map((message) => {
                const active = selected?.id === message.id;
                return (
                  <div
                    key={message.id}
                    className={cn(
                      "flex items-start gap-2 border-b border-line pr-3 transition last:border-0",
                      active ? "bg-canvas" : "hover:bg-canvas/60",
                    )}
                  >
                    <label className="flex cursor-pointer self-stretch pl-3 pt-3.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-teal-600"
                        checked={picked.has(message.id)}
                        onChange={() => togglePicked(message.id)}
                        aria-label={`Select the message from ${message.name || message.email}`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setSelectedId(message.id)}
                      className="block min-w-0 flex-1 py-3 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-sm",
                            message.status === "new" ? "font-semibold text-ink" : "text-ink/80",
                          )}
                        >
                          {message.name || message.email}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                          {message.status === "new" ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                          ) : null}
                          {fmtDate(message.created_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">{preview(message)}</div>
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Under the list, inside its box, so the page controls stay in view while the list
              itself scrolls. They used to sit at the foot of the whole page, past a 60vh scroll. */}
          {data && data.total > 0 ? (
            <div className="border-t border-line px-3 py-2">
              <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          {selected ? (
            <article className="space-y-5">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold tracking-tight text-ink">
                    {selected.name || selected.email}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                        statusTone[selected.status],
                      )}
                    >
                      {selected.status}
                    </span>
                    <Who message={selected} />
                    <span className="text-xs text-muted">{fmtDate(selected.created_at)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas"
                    href={`mailto:${selected.email}?subject=${encodeURIComponent(
                      selected.kind === "withdrawal"
                        ? `Re: your withdrawal${selected.order_ref ? ` (order ${selected.order_ref})` : ""}`
                        : `Re: your message to us`,
                    )}`}
                  >
                    <Reply size={15} />
                    Reply
                  </a>
                  {selected.status === "new" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={changeStatus.isPending}
                      onClick={() => changeStatus.mutate({ id: selected.id, status: "read" })}
                    >
                      <MailOpen size={15} />
                      Mark read
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={changeStatus.isPending}
                      onClick={() => changeStatus.mutate({ id: selected.id, status: "new" })}
                    >
                      <Mail size={15} />
                      Mark unread
                    </button>
                  )}
                  {selected.status === "archived" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={changeStatus.isPending}
                      onClick={() => changeStatus.mutate({ id: selected.id, status: "read" })}
                    >
                      <ArchiveRestore size={15} />
                      Unarchive
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
                      disabled={changeStatus.isPending}
                      onClick={() => changeStatus.mutate({ id: selected.id, status: "archived" })}
                    >
                      <Archive size={15} />
                      Archive
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-panel px-3 py-1.5 text-sm text-danger hover:bg-red-50"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={15} />
                    Delete
                  </button>
                </div>
              </header>

              {confirmDelete ? (
                <ConfirmPanel
                  title="Delete this message?"
                  description="It is removed for good. The email notification already sent is not affected."
                  confirmLabel="Delete"
                  danger
                  pending={remove.isPending}
                  onConfirm={() => remove.mutate(selected.id)}
                  onCancel={() => setConfirmDelete(false)}
                />
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email">
                  <a className="text-accent hover:underline" href={`mailto:${selected.email}`}>
                    {selected.email}
                  </a>
                </Field>
                {selected.order_ref ? (
                  <Field label="Order">{selected.order_ref}</Field>
                ) : (
                  <Field label="Order">
                    <span className="text-muted">—</span>
                  </Field>
                )}
                {selected.kind === "contact" && selected.phone ? (
                  <Field label="Phone">{selected.phone}</Field>
                ) : null}
                {selected.kind === "contact" && selected.subject ? (
                  <Field label="Subject">{selected.subject}</Field>
                ) : null}
                {selected.locale ? <Field label="Form language">{selected.locale}</Field> : null}
              </div>

              <div className="border-t border-line pt-4">
                {selected.kind === "contact" ? (
                  <Field label="Message">
                    {selected.body || <span className="text-muted">(empty)</span>}
                  </Field>
                ) : (
                  <div className="space-y-4">
                    <Field label="Goods / services">
                      {selected.goods || <span className="text-muted">(not given)</span>}
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {selected.ordered_on ? (
                        <Field label="Ordered on">{selected.ordered_on}</Field>
                      ) : null}
                      {selected.received_on ? (
                        <Field label="Received on">{selected.received_on}</Field>
                      ) : null}
                    </div>
                    {selected.address ? <Field label="Address">{selected.address}</Field> : null}
                    {selected.comment ? <Field label="Note">{selected.comment}</Field> : null}
                  </div>
                )}
              </div>

              <footer className="flex flex-wrap gap-4 border-t border-line pt-4 text-xs text-muted">
                <span>Sent {fmtDate(selected.created_at)}</span>
                {selected.read_at ? <span>Read {fmtDate(selected.read_at)}</span> : null}
                {selected.archived_at ? <span>Archived {fmtDate(selected.archived_at)}</span> : null}
                {selected.ip ? <span className="font-mono">IP {selected.ip}</span> : null}
              </footer>
            </article>
          ) : (
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-muted">
              <Inbox size={28} />
              <p className="text-sm">Pick a message to read it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
