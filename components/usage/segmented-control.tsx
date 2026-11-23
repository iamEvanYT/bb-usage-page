import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  /** Shorter label for phone-width screens, such as "7d" for "7 days". */
  compactLabel?: string;
}

const SIZE_CLASS = {
  // Touch screens get taller targets; mouse layouts keep the compact look.
  md: "h-8 px-3 text-xs max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3.5 max-md:pointer-coarse:text-sm",
  sm: "h-7 px-2.5 text-[10px] tracking-wide uppercase max-md:pointer-coarse:h-9 max-md:pointer-coarse:px-3 max-md:pointer-coarse:text-[11px]",
} as const;

/** A row of mutually exclusive buttons, such as the 7 / 30 / 90 day switch. */
export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  size = "md",
  stretchOnPhones = false,
}: {
  /** Accessible name for the group. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: keyof typeof SIZE_CLASS;
  /** Fill the row on phone-width screens, with equal-width buttons. */
  stretchOnPhones?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex shrink-0 overflow-hidden rounded-md border border-border",
        stretchOnPhones && "max-sm:flex-1",
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          // Screen readers always get the full label, even when abbreviated.
          aria-label={option.compactLabel === undefined ? undefined : option.label}
          onClick={() => onChange(option.value)}
          className={cn(
            "cursor-pointer whitespace-nowrap",
            SIZE_CLASS[size],
            stretchOnPhones && "max-sm:flex-1",
            option.value === value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.compactLabel === undefined ? (
            option.label
          ) : (
            <>
              <span className="sm:hidden">{option.compactLabel}</span>
              <span className="max-sm:hidden">{option.label}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
