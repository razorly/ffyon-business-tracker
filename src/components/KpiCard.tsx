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
    <Card className={cn("p-5", hero && "bg-accent text-accent-ink border-transparent")}>
      <div className="flex items-center justify-between">
        <span className={cn("eyebrow", hero ? "text-accent-ink/80" : "text-ink-2")}>{label}</span>
        {icon && <span className={hero ? "text-accent-ink/70" : "text-rose"}>{icon}</span>}
      </div>
      <div className={cn("mt-2 font-display leading-none", hero ? "text-[40px]" : "text-[32px]")}>{value}</div>
      {showDelta && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12px]">
          {delta == null ? (
            <span className={hero ? "text-accent-ink/70" : "text-muted"}>No data for {deltaLabel ?? "last period"}</span>
          ) : (
            <>
              <span className={cn("inline-flex items-center gap-0.5 font-medium", hero ? "text-accent-ink" : good ? "text-good" : "text-bad")}>
                {delta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(0)}%
              </span>
              <span className={hero ? "text-accent-ink/70" : "text-muted"}>vs {deltaLabel ?? "last period"}</span>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
