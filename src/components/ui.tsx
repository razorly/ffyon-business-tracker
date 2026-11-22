import { forwardRef, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FittedValue } from "./FittedValue";

/*
 * The component kit. Every screen and dialog is built from these, so the app reads as one thing.
 *
 * Type: six sizes only (text-label, text-small, text-body, text-heading, text-title, text-figure)
 * and three weights (font-normal, font-medium, font-semibold). The serif (font-display) is for
 * page and dialog titles; money and times are always sans with the `tabular` class.
 * Shape: cards rounded-2xl, controls rounded-xl, small tiles rounded-lg, badges rounded-full.
 * Controls are 44px high (h-11); `sm` is 36px for a mouse and grows to 44px for touch.
 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ButtonSize = "sm" | "md" | "icon";

const buttonClass = (variant: ButtonVariant, size: ButtonSize, className?: string) => cn(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium transition-colors cursor-pointer",
  "disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  size === "md" && "h-11 px-4 text-body",
  size === "sm" && "btn-sm h-9 px-3 text-small",
  size === "icon" && "h-11 w-11",
  variant === "primary" && "bg-accent text-accent-ink hover:bg-accent-hover",
  variant === "secondary" && "bg-surface border border-line text-ink hover:bg-surface-2",
  variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
  variant === "danger" && "bg-bad text-bad-ink hover:opacity-90",
  className,
);

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(({ className, variant = "secondary", size = "md", type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />
));

/** A link that looks and sizes like a button: Call, Text, a map link. */
export function ButtonLink({ className, variant = "secondary", size = "md", ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonClass(variant, size, className)} {...props} />;
}

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-w-0 rounded-2xl border border-line bg-surface", className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-2">
      <div className="min-w-0">
        <h2 className="text-heading font-semibold text-ink">{title}</h2>
        {subtitle && <p className="text-small text-ink-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** A section title inside a page or card, with an optional count beside it. */
export function SectionHeading({ id, title, count, action, className }: { id?: string; title: ReactNode; count?: number; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <h2 id={id} className="flex items-baseline gap-2 text-heading font-semibold text-ink">
        {title}
        {count != null && <span className="tabular text-small font-normal text-ink-2">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

/** The small rose line above a name: "Booking request", "Payment due", "Next up". */
export function KindLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-label font-medium text-rose-ink", className)}>{children}</div>;
}

const fieldBase =
  "w-full min-w-0 rounded-xl border border-line-strong bg-surface px-3.5 text-body text-ink placeholder:text-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent disabled:opacity-60";
// Only typed fields can be read-only; a select always matches :read-only.
const readOnlyTint = "read-only:bg-surface-2/50";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(fieldBase, readOnlyTint, "h-11", className)} {...props} />,
);

/** An amount in pounds: the £ sits inside the box and digits line up. */
export const MoneyInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, placeholder = "0.00", ...props }, ref) => (
    <div className="relative min-w-0">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-body text-ink-2" aria-hidden>£</span>
      <input ref={ref} inputMode="decimal" placeholder={placeholder} className={cn(fieldBase, readOnlyTint, "tabular h-11 pl-8", className)} {...props} />
    </div>
  ),
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, readOnlyTint, "min-h-[72px] resize-none py-2.5", className)} {...props} />
  ),
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(fieldBase, "h-11 pr-8", className)} {...props} />,
);

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1.5 block text-small font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-small text-ink-2">{hint}</span>}
    </label>
  );
}

/** A tick box with its label, tall enough to tap. */
export function Checkbox({ label, hint, className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-body", props.disabled && "cursor-not-allowed opacity-60", className)}>
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" {...props} />
      <span className="min-w-0">{label}{hint && <span className="block text-small text-ink-2">{hint}</span>}</span>
    </label>
  );
}

/** An on/off switch. `label` names it for screen readers; show visible text beside it. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn("relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", checked ? "bg-accent" : "bg-line-strong")}>
      <span className={cn("absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform", checked && "translate-x-5")} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex max-w-full rounded-xl bg-surface-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "btn-sm h-9 min-w-0 flex-1 whitespace-nowrap rounded-lg px-3.5 text-small transition-colors cursor-pointer",
            value === o.value ? "bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--border)]" : "font-medium text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A tappable choice: a service, a day, a free time, a filter. Pressed means chosen. */
export function Chip({ selected, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button type="button" aria-pressed={!!selected} {...props}
      className={cn(
        "inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 text-small transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "bg-accent font-semibold text-accent-ink" : "border border-line bg-surface font-medium text-ink hover:bg-surface-2",
        className,
      )}>
      {children}
    </button>
  );
}

/** A count on a nav item or heading. */
export function Badge({ children, tone = "strong", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "strong" | "soft" }) {
  return <span {...props} className={cn("tabular inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-label font-semibold", tone === "strong" ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink", className)}>{children}</span>;
}

export function Avatar({ name, large }: { name: string; large?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-semibold text-ink", large ? "h-14 w-14 text-heading" : "h-10 w-10 text-small")}>
      {initials || "?"}
    </span>
  );
}

/**
 * One line of a list: something in front, a title with a line beneath, something at the end.
 * Pass `onClick` for a tappable row. Wrap rows in a `divide-y divide-line` list.
 */
export function ListRow({ leading, title, subtitle, trailing, onClick, selected, className, ...props }: {
  leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; onClick?: () => void; selected?: boolean; className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "onClick">) {
  const body = <>
    {leading}
    <span className="min-w-0 flex-1">
      <span className="block break-words font-medium text-ink">{title}</span>
      {subtitle && <span className="block break-words text-small text-ink-2">{subtitle}</span>}
    </span>
    {trailing}
  </>;
  const classes = cn("flex w-full min-w-0 items-center gap-3 px-5 py-3 text-left text-body", selected && "bg-surface-2", className);
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={selected} className={cn(classes, "cursor-pointer hover:bg-surface-2/60", selected && "hover:bg-surface-2")} {...props as React.ButtonHTMLAttributes<HTMLButtonElement>}>{body}</button>
    : <div className={classes} {...props}>{body}</div>;
}

/** The "More" button: rare or risky actions, each with a plain label. */
export function Menu({ label = "More", items, align = "right", className }: {
  label?: string; align?: "left" | "right"; className?: string;
  items: ({ label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | false | null | undefined)[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = items.filter((item): item is Exclude<typeof item, false | null | undefined> => Boolean(item));
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
      root.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  if (!shown.length) return null;
  return (
    <div ref={root} className={cn("relative shrink-0", className)}>
      <Button variant="secondary" className="w-full" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={18} aria-hidden /> {label}
      </Button>
      {open && <div id={id} role="menu" aria-label={label} className={cn("absolute z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1 shadow-lg", align === "right" ? "right-0" : "left-0")}>
        {shown.map((item) => (
          <button key={item.label} type="button" role="menuitem" disabled={item.disabled} title={item.hint}
            onClick={() => { setOpen(false); item.onSelect(); }}
            className={cn("flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-body hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50", item.danger ? "text-bad" : "text-ink")}>
            {item.icon}<span className="min-w-0 flex-1">{item.label}</span>
          </button>
        ))}
      </div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !panel.current) return;
    const dialog = panel.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.parentElement;
    // The custom window title bar stays usable, so a dialog never stops the window being moved, minimised or closed.
    const chrome = document.querySelector(".window-titlebar");
    const outsideChrome = (element: HTMLElement): HTMLElement[] => !chrome || !element.contains(chrome) ? [element]
      : Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== chrome).flatMap(outsideChrome);
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root &&
      (!element.querySelector('[role="dialog"]') || Boolean(element.compareDocumentPosition(root!) & Node.DOCUMENT_POSITION_FOLLOWING))).flatMap(outsideChrome);
    // Undo only what this dialog did. A dialog opened over another sees the app already inert; if both
    // close together, restoring that captured state would leave the whole app unusable.
    const madeInert = siblings.filter((element) => !element.inert);
    madeInert.forEach((element) => { element.inert = true; });
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], iframe, [tabindex]'))
      .filter((element) => !element.matches(':disabled, [tabindex="-1"]') && element.getClientRects().length > 0);
    const isTop = () => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      return dialogs[dialogs.length - 1] === dialog;
    };
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focusFirst();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop() || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      } else if (e.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { e.preventDefault(); dialog.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          e.preventDefault(); first.focus();
        }
      }
    };
    const onFocus = (e: FocusEvent) => { if (isTop() && e.target instanceof Node && !dialog.contains(e.target)) focusFirst(); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      madeInert.forEach((element) => { element.inert = false; });
      if (previouslyFocused?.isConnected && !previouslyFocused.closest('[inert]')) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-root fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-[#2a1208]/45" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn("modal-panel relative flex max-h-full w-full min-w-0 flex-col border border-line bg-surface shadow-2xl", width)}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 pl-5 pr-2 pt-3 sm:pl-6 sm:pr-3 sm:pt-4">
          <h2 className="min-w-0 break-words font-display text-title text-ink">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5 pt-3 sm:px-6 sm:pb-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The row of buttons that ends a dialog or form: quiet action left, main action right. */
export function Actions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center justify-end gap-2 pt-1", className)}>{children}</div>;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={title} width="max-w-sm">
      <div className="text-body text-ink-2">{message}</div>
      {error && <ErrorText className="mt-3">{error}</ErrorText>}
      <Actions className="mt-5">
        <Button disabled={busy} onClick={onClose}>{cancelLabel}</Button>
        <Button
          variant={tone}
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true); setError(null);
            try { await onConfirm(); onClose(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Could not complete this change. Please retry."); }
            finally { setBusy(false); }
          }}
        >
          {confirmLabel}
        </Button>
      </Actions>
    </Modal>
  );
}

/** A problem with what was just tried, said plainly and announced to screen readers. */
export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return <p role="alert" className={cn("break-words text-small text-bad", className)}>{children}</p>;
}

/** A quiet banner: you're offline, something is still importing, a tip. */
export function Notice({ children, action, tone = "info", className }: { children: ReactNode; action?: ReactNode; tone?: "info" | "bad"; className?: string }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-surface px-4 py-3 text-small", tone === "bad" ? "border-bad/40 text-bad" : "border-line text-ink-2", className)}>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  );
}

/** Failed reads are visible and retryable; financial zeros must not imply success. */
export function LoadError({ error, onRetry }: { error: string | null | undefined; onRetry: () => void }) {
  return error ? (
    <Notice tone="bad" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>
      Could not load the latest information.
      <details className="mt-1 text-ink-2"><summary className="cursor-pointer">Show details</summary><span className="break-words">{error}</span></details>
    </Notice>
  ) : null;
}

export function Loading({ label, className }: { label: string; className?: string }) {
  return <div role="status" className={cn("flex items-center gap-2 px-5 py-8 text-small text-ink-2", className)}><LoaderCircle size={16} className="animate-spin" aria-hidden /> {label}</div>;
}

/** A headline number on a card: the totals above Money and the Diary. */
export function Stat({
  label,
  value,
  tone,
  strong,
  hint,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  strong?: boolean;
  hint?: string;
}) {
  return (
    <Card className={cn("px-5 py-4", strong && "border-transparent bg-accent text-accent-ink")}>
      <div className={cn("text-small", strong ? "text-accent-ink/85" : "text-ink-2")}>{label}</div>
      <FittedValue
        className={cn(
          "tabular mt-1 min-w-0 text-title font-semibold",
          !strong && tone === "good" && "text-good",
          !strong && tone === "bad" && "text-bad",
        )}
        value={value}
      />
      {hint && <div className={cn("mt-1 text-small", strong ? "text-accent-ink/85" : "text-ink-2")}>{hint}</div>}
    </Card>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-rose-ink">
        {icon}
      </div>
      <p className="text-heading font-semibold">{title}</p>
      {children && <div className="mt-1 text-small text-ink-2">{children}</div>}
    </div>
  );
}

export function Swatch({ colour, className }: { colour: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: colour }} />;
}
