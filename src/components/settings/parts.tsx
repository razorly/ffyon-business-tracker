import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Actions, Button, ErrorText } from "@/components/ui";

/** A heading inside a card, above a small group of controls. */
export function SubHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-body font-medium text-ink", className)}>{children}</h3>;
}

/** Quiet helper text under a heading or control. */
export function Help({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-small text-ink-2", className)}>{children}</p>;
}

/** A card heading with its on/off switch held at the end of the line, at any width. */
export function SwitchHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
      <div className="min-w-0">
        <h2 className="text-heading font-semibold text-ink">{title}</h2>
        {subtitle && <p className="text-small text-ink-2">{subtitle}</p>}
      </div>
      <div className="flex h-7 shrink-0 items-center">{children}</div>
    </div>
  );
}

/** Shared settings can only be changed while connected. */
export function OnlineNotice({ online }: { online: boolean }) {
  return online ? null : <Help>Reconnect to change these.</Help>;
}

/**
 * The end of a settings form. Nothing shows until something has changed; then Reset and Save appear.
 * If the same settings were saved elsewhere meanwhile, saving is held back and Reset becomes "Reload latest".
 */
export function SaveBar({ dirty, stale, busy, disabled, label, onReset, error, children }: {
  dirty: boolean; stale: boolean; busy: boolean; disabled?: boolean; label: string; onReset: () => void; error?: string; children?: ReactNode;
}) {
  if (!dirty) return null;
  return (
    <div className="space-y-3 border-t border-line pt-4">
      {children}
      {stale && <ErrorText>These settings were changed on another device. Reload the latest before saving.</ErrorText>}
      {error && <ErrorText>{error}</ErrorText>}
      <Actions>
        <Button disabled={busy} onClick={onReset}><RotateCcw size={16} aria-hidden /> {stale ? "Reload latest" : "Reset"}</Button>
        <Button type="submit" variant="primary" disabled={disabled || busy || stale}>{busy ? "Saving…" : label}</Button>
      </Actions>
    </div>
  );
}
