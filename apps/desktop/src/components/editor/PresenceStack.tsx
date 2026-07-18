// One chip per *person* (already deduped/grouped upstream), with a 2-chip + ⊕N
// overflow that opens a roster popover. Port of src/lib/PresenceStack.svelte;
// mirrors the webapp header presence stack.
import { initials, splitForStack, type PresencePerson } from "@/services/presence";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Hairline outline keeps avatar photos from melting into the chrome on either
// theme; outline (not border) so it never shifts layout.
const AVATAR_OUTLINE = "outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10";

function Chip({ person, size }: { person: PresencePerson; size: "sm" | "md" }) {
  const dim = size === "md" ? "h-7 w-7" : "h-6 w-6";
  const text = size === "md" ? "text-[0.65rem]" : "text-[0.6rem]";
  return person.avatar ? (
    <img
      className={cn("shrink-0 rounded-full", dim, AVATAR_OUTLINE)}
      src={person.avatar}
      alt={person.name}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        dim,
        text,
      )}
      style={{ backgroundColor: person.color }}
      aria-label={person.name}
    >
      {person.kind === "agent" ? "✦" : initials(person.name)}
    </span>
  );
}

export default function PresenceStack({ people }: { people: PresencePerson[] }) {
  const stack = splitForStack(people);

  if (people.length === 0) return null;

  return (
    <div className="relative flex items-center">
      {stack.visible.map((p) => (
        <div
          key={p.key}
          className="-ml-1.5 first:ml-0 ring-2 ring-background rounded-full"
          title={p.name}
        >
          <Chip person={p} size="md" />
        </div>
      ))}
      {stack.overflow > 0 && (
        <Popover>
          <PopoverTrigger
            className="-ml-1.5 flex h-7 min-w-7 items-center justify-center rounded-full ring-2 ring-background transition-transform active:scale-[0.96]"
            title={`${stack.overflow} more`}
            aria-haspopup="true"
          >
            <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-1 text-[0.65rem] font-semibold">
              ⊕{stack.overflow}
            </span>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-80 w-56 overflow-y-auto p-2" role="menu">
            <p className="px-1.5 pb-1 text-xs font-semibold text-muted-foreground">People here</p>
            <ul className="flex flex-col gap-0.5">
              {people.map((p) => (
                <li key={p.key} className="flex items-center gap-2 rounded px-1.5 py-1">
                  <Chip person={p} size="sm" />
                  <span className="truncate text-sm">{p.name}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
