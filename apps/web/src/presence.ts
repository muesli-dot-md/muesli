// shared-core candidate (sub-project ①): keep these two files byte-identical.
export type PresenceUser = {
  userId: string | null;
  name: string;
  color: string;
  colorLight: string;
  avatar?: string | null;
  kind: "human" | "agent";
};

export type PresencePerson = PresenceUser & { key: string; clientIds: number[] };

/** Stable HSL color from any id string. */
export function colorFromId(id: string): { color: string; colorLight: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { color: `hsl(${hue} 70% 60%)`, colorLight: `hsl(${hue} 70% 60% / 0.2)` };
}

/** Initials from a display name; only alphabetic words contribute ("Oat 86" → "O"). */
export function initials(name: string): string {
  const all = name.split(/\s+/).filter(Boolean);
  const words = all.filter((w) => /[a-zA-Z]/.test(w));
  if (words.length === 0) return "?";
  // A lone alphabetic token ("Ada") gets two letters; but when other (numeric)
  // tokens were dropped ("Oat 86"), the single surviving word gets just one.
  if (words.length === 1)
    return all.length === 1 ? words[0].slice(0, 2).toUpperCase() : words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Group raw awareness entries into one person per identity.
 * @param entries  [clientId, user] pairs from awareness.getStates() where user is present
 * @param selfKey  the local person's key, to exclude from the returned list (or null to include)
 */
export function groupPresence(
  entries: Array<[number, PresenceUser]>,
  selfKey: string | null,
): PresencePerson[] {
  const byKey = new Map<string, PresencePerson>();
  for (const [clientId, u] of entries) {
    const key = u.userId ?? `guest:${clientId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.clientIds.push(clientId);
    } else {
      byKey.set(key, { ...u, key, clientIds: [clientId] });
    }
  }
  let people = [...byKey.values()];
  if (selfKey) people = people.filter((p) => p.key !== selfKey);
  return people;
}

export const MAX_AVATARS = 3;
export const OVERFLOW_VISIBLE = 2; // when overflowing, show this many chips + ⊕N

/** Split a person list into visible chips + the hidden overflow count. */
export function splitForStack(people: PresencePerson[]): {
  visible: PresencePerson[];
  overflow: number;
} {
  if (people.length <= MAX_AVATARS) return { visible: people, overflow: 0 };
  return { visible: people.slice(0, OVERFLOW_VISIBLE), overflow: people.length - OVERFLOW_VISIBLE };
}
