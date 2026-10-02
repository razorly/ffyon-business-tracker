import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FittedValue } from "./FittedValue";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "icon" }
>(({ className, variant = "secondary", size = "md", type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-full font-medium tracking-wide transition-colors cursor-pointer",
      "disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      size === "md" && "h-9 px-4 text-sm",
      size === "sm" && "h-8 px-3 text-[13px]",
      size === "icon" && "h-8 w-8",
      variant === "primary" && "bg-accent text-accent-ink hover:bg-accent-hover shadow-sm",
      variant === "secondary" && "bg-surface border border-line text-ink hover:bg-surface-2",
      variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
      variant === "danger" && "bg-bad text-white hover:opacity-90",
      className,
    )}
    {...props}
  />
));

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("min-w-0 rounded-3xl border border-line bg-surface shadow-[0_1px_3px_rgba(74,36,20,0.05)]", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-4 pb-2">
      <div className="min-w-0">
        <h3 className="font-display text-[19px] leading-tight text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const fieldBase =
  "w-full min-w-0 rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted " +
  "focus:outline-none focus:ring-2 focus:ring-rose/50 focus:border-rose";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(fieldBase, "h-9", className)} {...props} />,
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, "py-2 min-h-[64px] resize-none", className)} {...props} />
  ),
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(fieldBase, "h-9 pr-8", className)} {...props} />,
);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="eyebrow mb-1.5 block text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-full bg-surface-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors cursor-pointer",
            value === o.value ? "bg-accent text-accent-ink shadow-sm" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
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
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root &&
      (!element.querySelector('[role="dialog"]') || Boolean(element.compareDocumentPosition(root!) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => { element.inert = true; });
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
      siblings.forEach((element, index) => { element.inert = previousInert[index]; });
      if (previouslyFocused?.isConnected && !previouslyFocused.closest('[inert]')) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-[#2a1208]/45" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn("relative flex max-h-[calc(100dvh-24px)] w-full min-w-0 flex-col rounded-3xl border border-line bg-surface shadow-2xl", width)}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <h2 className="font-display text-[22px]">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-3 sm:px-6 sm:pb-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={title} width="max-w-sm">
      <div className="text-sm text-ink-2">{message}</div>
      {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
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
      </div>
    </Modal>
  );
}

/** Failed reads are visible and retryable; financial zeros must not imply success. */
export function LoadError({ error, onRetry }: { error: string | null | undefined; onRetry: () => void }) {
  return error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-bad/30 bg-surface px-4 py-3 text-sm text-bad"><span className="min-w-0 flex-1 break-words">Could not load the latest information: {error}</span><Button size="sm" onClick={onRetry}>Retry</Button></div> : null;
}

/** Big figure on a card — the totals above the monthly and schedule tables. */
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
      <div className={cn("eyebrow", strong ? "text-accent-ink/80" : "text-ink-2")}>{label}</div>
      <FittedValue
        className={cn(
          "mt-2 min-w-0 font-display text-[28px] leading-none",
          !strong && tone === "good" && "text-good",
          !strong && tone === "bad" && "text-bad",
        )}
        value={value}
      />
      {hint && (
        <div className={cn("mt-1.5 text-[12px] leading-snug", strong ? "text-accent-ink/70" : "text-muted")}>{hint}</div>
      )}
    </Card>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-rose">
        {icon}
      </div>
      <p className="font-display text-lg">{title}</p>
      {children && <div className="mt-1 text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Swatch({ colour, className }: { colour: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: colour }} />;
}
