import { forwardRef, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "icon" }
>(({ className, variant = "secondary", size = "md", ...props }, ref) => (
  <button
    ref={ref}
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
    <div className={cn("rounded-3xl border border-line bg-surface shadow-[0_1px_3px_rgba(74,36,20,0.05)]", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
      <div>
        <h3 className="font-display text-[19px] leading-tight text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const fieldBase =
  "w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted " +
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
    <label className="block">
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#2a1208]/45" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn("relative w-full rounded-3xl border border-line bg-surface shadow-2xl", width)}
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <h2 className="font-display text-[22px]">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>
        <div className="px-6 pb-6 pt-3">{children}</div>
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
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-sm">
      <div className="text-sm text-ink-2">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
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
      <div
        className={cn(
          "mt-2 font-display text-[28px] leading-none",
          !strong && tone === "good" && "text-good",
          !strong && tone === "bad" && "text-bad",
        )}
      >
        {value}
      </div>
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
