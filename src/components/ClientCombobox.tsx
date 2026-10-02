import { useId, useMemo, useRef, useState } from "react";
import { Plus, User } from "lucide-react";
import type { Client } from "@/lib/db";
import { Input } from "./ui";
import { cn } from "@/lib/utils";

export interface ClientChoice {
  id: number | null; // null = new client to be created on save
  name: string;
}

export function ClientCombobox({
  clients,
  value,
  onChange,
  placeholder = "Search or add a client (optional)",
  required = false,
}: {
  clients: Client[];
  value: ClientChoice;
  onChange: (v: ClientChoice) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const query = value.name.trim().toLowerCase();
  const matches = useMemo(
    () => clients.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8),
    [clients, query],
  );
  const exact = clients.find((c) => c.name.toLowerCase() === query);
  const options: ClientChoice[] = [
    ...matches.map((c) => ({ id: c.id, name: c.name })),
    ...(query && !exact ? [{ id: null, name: value.name.trim() }] : []),
  ];

  const choose = (o: ClientChoice | undefined) => {
    if (!o) return;
    onChange(o);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value.name}
        placeholder={placeholder}
        required={required}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && options.length > 0 ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
        autoComplete="off"
        maxLength={200}
        onFocus={() => { setActive(0); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          const name = e.target.value;
          const match = clients.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
          onChange({ id: match ? match.id : null, name });
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault(); e.stopPropagation(); setOpen(false); return;
          }
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); setActive(0); return; }
          if (!open || options.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(options[Math.min(active, options.length - 1)]);
          }
        }}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Matching clients" className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {options.map((o, i) => (
            <li key={o.id ?? "new"} role="none">
              <button
                type="button"
                role="option"
                id={`${listId}-${i}`}
                aria-selected={i === Math.min(active, options.length - 1)}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm cursor-pointer",
                  i === active && "bg-surface-2",
                )}
              >
                {o.id == null ? (
                  <>
                    <Plus size={14} className="text-accent" /> Add “{o.name}” as a new client
                  </>
                ) : (
                  <>
                    <User size={14} className="text-muted" /> {o.name}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
