import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { listLegacyIncomeCategories, resolveLegacyIncomeCategory } from "@/lib/db";
import { useData } from "@/lib/data";
import { money } from "@/lib/format";
import { listServices } from "@/lib/sync";
import { Button, Card, CardHeader, Select } from "@/components/ui";

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
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "The legacy income review could not be loaded."); })
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
      setError(cause instanceof Error ? cause.message : "The classification could not be saved.");
      refresh();
    } finally { setBusyId(null); }
  };

  if ((!loaded || categories.length === 0) && !error) return null;
  const activeServices = services.filter((service) => service.active);
  const archivedServices = services.filter((service) => !service.active);

  return (
    <Card className="self-start">
      <CardHeader title="Review older income" />
      <div className="px-5 pb-5">
        <p className="mb-3 text-xs text-muted">Older records use these labels. Choose whether each one was a service or other income. Amounts and saved labels don't change.</p>
        {error && <p className="mb-3 text-sm text-bad" role="alert">{error}</p>}
        <ul className="divide-y divide-line">
          {categories.map((category) => (
            <li key={category.id} className="space-y-2 py-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">{category.name}</p>
                <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">
                  <span>{category.transaction_count} {category.transaction_count === 1 ? "payment" : "payments"}</span>
                  <span>{money(category.total_pence)}</span>
                  <span>{category.appointment_count} {category.appointment_count === 1 ? "appointment" : "appointments"}</span>
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
                  <option value="">Choose classification</option>
                  <option value={OTHER_INCOME}>Keep as other income</option>
                  {activeServices.length > 0 && <optgroup label="Services">{activeServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</optgroup>}
                  {archivedServices.length > 0 && <optgroup label="Archived services">{archivedServices.map((service) => <option key={service.id} value={service.id}>{service.name} (archived)</option>)}</optgroup>}
                </Select>
                <Button
                  size="icon"
                  variant="primary"
                  className="shrink-0"
                  title={`Apply review for ${category.name}`}
                  aria-label={`Apply review for ${category.name}`}
                  disabled={busyId !== null || !choices[category.id] || (choices[category.id] !== OTHER_INCOME && !services.some((service) => service.id === choices[category.id]))}
                  onClick={() => void apply(category)}
                ><Check size={15} /></Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
