import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "./ui";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  delta,
  deltaLabel,
  upIsGood = true,
  icon,
  hero,
}: {
  label: string;
  value: string;
  /** percentage change, null when no comparison is possible */
  delta?: number | null;
  deltaLabel?: string;
  upIsGood?: boolean;
  icon?: ReactNode;
  hero?: boolean;
}) {
  const showDelta = delta !== undefined;
  const good = delta != null && (upIsGood ? delta >= 0 : delta <= 0);
  return (
    <Card className={cn("p-5", hero && "bg-gradient-to-br from-accent-soft to-surface")}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-2">{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className={cn("mt-2 font-semibold tracking-tight", hero ? "text-[32px]" : "text-[26px]")}>{value}</div>
      {showDelta && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px]">
          {delta == null ? (
            <span className="text-muted">No data for {deltaLabel ?? "last period"}</span>
          ) : (
            <>
              <span className={cn("inline-flex items-center gap-0.5 font-medium", good ? "text-good" : "text-bad")}>
                {delta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(0)}%
              </span>
              <span className="text-muted">vs {deltaLabel ?? "last period"}</span>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
