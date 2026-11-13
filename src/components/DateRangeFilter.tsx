import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type DateRange } from "react-day-picker";
import {
  endOfDay,
  endOfMonth,
  endOfYear,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type DateFilter = { from: Date; to: Date } | null;

type Preset = { key: string; label: string; range: () => DateFilter };

const presets: Preset[] = [
  { key: "all", label: "All time", range: () => null },
  { key: "today", label: "Today", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { key: "7d", label: "Last 7 days", range: () => ({ from: startOfDay(subDays(new Date(), 6)), to: endOfDay(new Date()) }) },
  { key: "month", label: "This month", range: () => ({ from: startOfMonth(new Date()), to: endOfMonth(new Date()) }) },
  {
    key: "lastMonth",
    label: "Last month",
    range: () => {
      const last = subMonths(new Date(), 1);
      return { from: startOfMonth(last), to: endOfMonth(last) };
    },
  },
  { key: "year", label: "This year", range: () => ({ from: startOfYear(new Date()), to: endOfYear(new Date()) }) },
];

export function DateRangeFilter({
  presetKey,
  value,
  onChange,
}: {
  presetKey: string;
  value: DateFilter;
  onChange: (value: DateFilter, presetKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  function openCalendar(next: boolean) {
    if (next) setDraft(value ? { from: value.from, to: value.to } : undefined);
    setOpen(next);
  }

  function applyDraft() {
    if (!draft?.from) return;
    onChange({ from: startOfDay(draft.from), to: endOfDay(draft.to ?? draft.from) }, "custom");
    setOpen(false);
  }

  const customLabel =
    presetKey === "custom" && value
      ? isSameDay(value.from, value.to)
        ? format(value.from, "d MMM yyyy")
        : `${format(value.from, "d MMM yyyy")} – ${format(value.to, "d MMM yyyy")}`
      : "Custom range";

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground shadow-sm"
        : "bg-background text-foreground hover:border-primary/50 hover:bg-accent",
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className={chip(presetKey === preset.key)}
          aria-pressed={presetKey === preset.key}
          onClick={() => onChange(preset.range(), preset.key)}
        >
          {preset.label}
        </button>
      ))}
      <Popover.Root open={open} onOpenChange={openCalendar}>
        <Popover.Trigger asChild>
          <button type="button" className={chip(presetKey === "custom")} aria-pressed={presetKey === "custom"}>
            <CalendarDays className="h-4 w-4" />
            {customLabel}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            className="z-50 rounded-lg border bg-popover p-4 text-popover-foreground shadow-xl"
          >
            <p className="mb-1 text-sm font-semibold">Choose a date range</p>
            <p className="mb-3 text-xs text-muted-foreground">Click a start date, then an end date. Click one day twice for a single day.</p>
            <DayPicker
              mode="range"
              selected={draft}
              onSelect={setDraft}
              numberOfMonths={2}
              defaultMonth={draft?.from ?? subMonths(new Date(), 1)}
              weekStartsOn={1}
              showOutsideDays
              components={{
                Chevron: ({ orientation }) =>
                  orientation === "left" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />,
              }}
              classNames={{
                root: "relative",
                months: "flex flex-col gap-6 sm:flex-row",
                month: "space-y-3",
                month_caption: "flex h-9 items-center justify-center",
                caption_label: "text-sm font-semibold",
                nav: "absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between",
                button_previous: "grid h-8 w-8 place-items-center rounded-md border bg-background hover:bg-accent disabled:opacity-40",
                button_next: "grid h-8 w-8 place-items-center rounded-md border bg-background hover:bg-accent disabled:opacity-40",
                month_grid: "border-collapse",
                weekdays: "flex",
                weekday: "w-9 text-center text-[0.7rem] font-semibold uppercase text-muted-foreground",
                week: "mt-1 flex",
                day: "h-9 w-9 p-0 text-center text-sm",
                day_button: "h-9 w-9 rounded-md transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                today: "font-bold text-primary",
                outside: "text-muted-foreground/50",
                selected: "",
                range_start: "rounded-l-md bg-primary [&>button]:bg-primary [&>button]:text-primary-foreground",
                range_end: "rounded-r-md bg-primary [&>button]:bg-primary [&>button]:text-primary-foreground",
                range_middle: "bg-accent [&>button]:rounded-none [&>button]:text-foreground",
                disabled: "opacity-40",
                hidden: "invisible",
              }}
            />
            <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
              <span className="text-sm text-muted-foreground">
                {draft?.from
                  ? draft.to && !isSameDay(draft.from, draft.to)
                    ? `${format(draft.from, "d MMM yyyy")} – ${format(draft.to, "d MMM yyyy")}`
                    : format(draft.from, "d MMM yyyy")
                  : "No dates selected"}
              </span>
              <div className="flex gap-2">
                <button type="button" className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!draft?.from}
                  className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  onClick={applyDraft}
                >
                  Apply
                </button>
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {value && (
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null, "all")}
        >
          <X className="h-4 w-4" />
          Clear
        </button>
      )}
    </div>
  );
}
