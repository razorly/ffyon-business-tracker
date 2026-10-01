type Entry = {
  type: "income" | "expense";
  service_id?: string | null;
  service_name?: string | null;
  category_name_snapshot?: string | null;
  category_name?: string | null;
  income_kind?: "service" | "other" | "legacy" | null;
};

export type TransactionKind = "service" | "other" | "legacy" | "unassigned" | "expense";

export function transactionLabel(entry: Entry): string {
  if (entry.type === "income" && entry.service_name?.trim()) return entry.service_name.trim();
  return entry.category_name_snapshot?.trim() || entry.category_name?.trim() ||
    (entry.type === "expense" ? "Uncategorised expense" : "Unassigned income");
}

export function transactionKind(entry: Entry): TransactionKind {
  if (entry.type === "expense") return "expense";
  if (entry.service_id || entry.service_name?.trim()) return "service";
  if (entry.income_kind === "service" || entry.income_kind === "other" || entry.income_kind === "legacy") return entry.income_kind;
  if (entry.category_name_snapshot?.trim() || entry.category_name?.trim()) return "legacy";
  return "unassigned";
}

export function transactionKindLabel(entry: Entry): string {
  const kind = transactionKind(entry);
  return kind === "service" ? "Service payment" : kind === "other" ? "Other income" :
    kind === "legacy" ? "Legacy income" : kind === "expense" ? "Expense" : "Income";
}
