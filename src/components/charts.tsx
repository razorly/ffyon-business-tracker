import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { money, moneyCompact } from "@/lib/format";
import { Swatch } from "./ui";

const axisTick = { fill: "var(--muted)", fontSize: 12 };

// ---------- Tooltip ----------

interface TipRow {
  label: string;
  value: number;
  colour: string;
}

function TooltipCard({ title, rows, footer }: { title: string; rows: TipRow[]; footer?: ReactNode }) {
  return (
    <div className="min-w-[160px] rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] shadow-lg">
      <div className="mb-1.5 font-semibold text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-2 text-ink-2">
            <Swatch colour={r.colour} /> {r.label}
          </span>
          <span className="tabular font-medium text-ink">{money(r.value)}</span>
        </div>
      ))}
      {footer && <div className="mt-1.5 border-t border-line pt-1.5">{footer}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; colour: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-[13px] text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <Swatch colour={i.colour} /> {i.label}
        </span>
      ))}
    </div>
  );
}

// ---------- Rounded bar that rounds the data end, square at the baseline ----------

function RoundedBar(props: { x?: number; y?: number; width?: number; height?: number; fill?: string; value?: number | number[] }) {
  const { x = 0, width = 0, fill } = props;
  let { y = 0, height = 0 } = props;
  const raw = Array.isArray(props.value) ? props.value[1] - props.value[0] : (props.value ?? 0);
  if (height < 0) {
    y += height;
    height = -height;
  }
  if (height <= 0 || width <= 0) return null;
  const r = Math.min(4, width / 2, height);
  const neg = raw < 0;
  const d = neg
    ? `M${x},${y} h${width} v${height - r} q0,${r} ${-r},${r} h${-(width - 2 * r)} q${-r},0 ${-r},${-r} Z`
    : `M${x},${y + height} v${-(height - r)} q0,${-r} ${r},${-r} h${width - 2 * r} q${r},0 ${r},${r} v${height - r} Z`;
  return <path d={d} fill={fill} />;
}

// ---------- Income vs expenses area chart ----------

export interface MonthPoint {
  label: string;
  income: number;
  expense: number;
}

export function IncomeExpenseChart({ data }: { data: MonthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="fillIncome" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-income)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--series-income)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fillExpense" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-expense)" stopOpacity={0.14} />
            <stop offset="100%" stopColor="var(--series-expense)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="label" tick={axisTick} axisLine={{ stroke: "var(--axis)" }} tickLine={false} dy={6} />
        <YAxis tick={axisTick} axisLine={false} tickLine={false} tickFormatter={moneyCompact} width={60} />
        <Tooltip
          cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as MonthPoint;
            const profit = p.income - p.expense;
            return (
              <TooltipCard
                title={String(label)}
                rows={[
                  { label: "Income", value: p.income, colour: "var(--series-income)" },
                  { label: "Expenses", value: p.expense, colour: "var(--series-expense)" },
                ]}
                footer={
                  <div className="flex justify-between">
                    <span className="text-ink-2">Profit</span>
                    <span className={`tabular font-semibold ${profit < 0 ? "text-bad" : "text-good"}`}>
                      {money(profit)}
                    </span>
                  </div>
                }
              />
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="income"
          stroke="var(--series-income)"
          strokeWidth={2}
          fill="url(#fillIncome)"
          dot={false}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface)" }}
        />
        <Area
          type="monotone"
          dataKey="expense"
          stroke="var(--series-expense)"
          strokeWidth={2}
          fill="url(#fillExpense)"
          dot={false}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface)" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------- Profit per month ----------

export function ProfitBars({ data }: { data: MonthPoint[] }) {
  const rows = data.map((d) => ({ ...d, profit: d.income - d.expense }));
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={rows} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} dy={6} />
        <YAxis tick={axisTick} axisLine={false} tickLine={false} tickFormatter={moneyCompact} width={60} />
        <ReferenceLine y={0} stroke="var(--axis)" />
        <Tooltip
          cursor={{ fill: "var(--surface-2)", opacity: 0.6 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as MonthPoint & { profit: number };
            return (
              <TooltipCard
                title={String(label)}
                rows={[
                  {
                    label: "Profit",
                    value: p.profit,
                    colour: p.profit < 0 ? "var(--series-neg)" : "var(--series-income)",
                  },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="profit" maxBarSize={24} shape={RoundedBar} isAnimationActive>
          {rows.map((r) => (
            <Cell key={r.label} fill={r.profit < 0 ? "var(--series-neg)" : "var(--series-income)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------- Daily income bars (monthly view) ----------

export interface DayPoint {
  label: string;
  day: string;
  income: number;
  expense: number;
}

export function DailyBars({ data }: { data: DayPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="day" tick={axisTick} axisLine={{ stroke: "var(--axis)" }} tickLine={false} interval={1} dy={4} />
        <YAxis tick={axisTick} axisLine={false} tickLine={false} tickFormatter={moneyCompact} width={56} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)", opacity: 0.6 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as DayPoint;
            return (
              <TooltipCard
                title={p.label}
                rows={[
                  { label: "Income", value: p.income, colour: "var(--series-income)" },
                  { label: "Expenses", value: p.expense, colour: "var(--series-expense)" },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="income" fill="var(--series-income)" maxBarSize={10} shape={RoundedBar} />
        <Bar dataKey="expense" fill="var(--series-expense)" maxBarSize={10} shape={RoundedBar} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------- Category donut ----------

export interface Slice {
  name: string;
  value: number;
  colour: string;
}

export function CategoryDonut({ data, centreLabel }: { data: Slice[]; centreLabel: string }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-[180px] w-[180px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={58}
              outerRadius={86}
              paddingAngle={0}
              stroke="var(--surface)"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.colour} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const s = payload[0].payload as Slice;
                return <TooltipCard title={s.name} rows={[{ label: `${Math.round((s.value / total) * 100)}% of total`, value: s.value, colour: s.colour }]} />;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] uppercase tracking-wide text-muted">{centreLabel}</span>
          <span className="text-lg font-semibold">{moneyCompact(total)}</span>
        </div>
      </div>
      <ul className="w-full space-y-2">
        {data.map((d) => (
          <li key={d.name} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <Swatch colour={d.colour} />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="tabular shrink-0 font-medium">
              {money(d.value)}
              <span className="ml-1.5 text-muted">{Math.round((d.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
