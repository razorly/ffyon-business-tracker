import { useEffect, useState } from "react";
import { toast } from "sonner";
import { listLegacyIncomeCategories, resolveLegacyIncomeCategory } from "@/lib/db";
import { useData } from "@/lib/data";
import { money } from "@/lib/format";
import { listServices } from "@/lib/sync";
import { Button, Card, CardHeader, ErrorText, Select } from "@/components/ui";

type LegacyCategory = Awaited<ReturnType<typeof listLegacyIncomeCategories>>[number];
type Service = Awaited<ReturnType<typeof listServices>>[number];
const OTHER_INCOME = "__other_income__";

export function LegacyIncomeReview() {
  const { version, refresh } = useData();
  const [categories, setCategories] = useState<LegacyCategory[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([listLegacyIncomeCategories(), listServices()])
      .then(([nextCategories, nextServices]) => {
        if (!alive) return;
        // Unused labels (such as the original starter list) have nothing to classify.
        setCategories(nextCategories.filter((category) => category.transaction_count > 0 || category.appointment_count > 0));
        setServices(nextServices);
        setError("");
      })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Couldn't load your older income."); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [version]);

  const apply = async (category: LegacyCategory) => {
    const choice = choices[category.id];
    if (busyId !== null || !choice || (choice !== OTHER_INCOME && !services.some((service) => service.id === choice))) return;
    setBusyId(category.id);
    setError("");
    try {
      await resolveLegacyIncomeCategory(category.id, choice === OTHER_INCOME ? null : choice);
      setCategories((current) => current.filter((item) => item.id !== category.id));
      setChoices((current) => {
        const next = { ...current };
        delete next[category.id];
        return next;
      });
      toast.success(choice === OTHER_INCOME ? "Kept as other income" : "Linked to service");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.");
      refresh();
    } finally { setBusyId(null); }
  };

  if ((!loaded || categories.length === 0) && !error) return null;
  const activeServices = services.filter((service) => service.active);
  const archivedServices = services.filter((service) => !service.active);

  return (
    <Card>
      <CardHeader title="Older income to sort" subtitle="These labels are from before you had services. Say what each one was. Amounts don't change." />
      {error && <ErrorText className="px-5 pb-3">{error}</ErrorText>}
      <ul className="divide-y divide-line border-t border-line">
        {categories.map((category) => (
          <li key={category.id} className="space-y-2 px-5 py-3">
            <div className="min-w-0">
              <p className="break-words font-medium">{category.name}</p>
              <p className="tabular flex flex-wrap gap-x-2 text-small text-ink-2">
                <span>{category.transaction_count} {category.transaction_count === 1 ? "payment" : "payments"}</span>
                <span>· {money(category.total_pence)}</span>
                <span>· {category.appointment_count} {category.appointment_count === 1 ? "appointment" : "appointments"}</span>
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Select
                aria-label={`Classification for ${category.name}`}
                disabled={busyId !== null}
                value={choices[category.id] ?? ""}
                onChange={(event) => {
                  setChoices((current) => ({ ...current, [category.id]: event.target.value }));
                  setError("");
                }}
              >
                <option value="">Choose what this was</option>
                <option value={OTHER_INCOME}>Other income (not a service)</option>
                {activeServices.length > 0 && <optgroup label="Services">{activeServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</optgroup>}
                {archivedServices.length > 0 && <optgroup label="Archived services">{archivedServices.map((service) => <option key={service.id} value={service.id}>{service.name} (archived)</option>)}</optgroup>}
              </Select>
              <Button
                variant="primary"
                aria-label={`Apply review for ${category.name}`}
                disabled={busyId !== null || !choices[category.id] || (choices[category.id] !== OTHER_INCOME && !services.some((service) => service.id === choices[category.id]))}
                onClick={() => void apply(category)}
              >Apply</Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
