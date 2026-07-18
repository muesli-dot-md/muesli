/**
 * Store for co-presence: one entry per *person* (deduped by userId, guests
 * by clientId), not per client/tab. Adapted from the desktop's
 * state/presence.ts (no web Svelte original — the Svelte DocApp called
 * groupPresence() inline; this store gives the React header/presence stack a
 * subscription point). The doc header feeds it raw awareness entries + the
 * local person's key from the open session; the presence stack renders the
 * roster. Reset to empty on session teardown.
 * The `count` field is kept in lockstep with `people`.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { groupPresence, type PresencePerson, type PresenceUser } from "@/services/presence";

export interface PresenceState {
  /** The grouped roster, self excluded. */
  people: PresencePerson[];
  /** Distinct-person count (== people.length). */
  count: number;
  /** Replace the roster from an awareness `getStates()` map, excluding self. */
  update(states: Map<number, { user?: PresenceUser }>, selfKey: string | null): void;
  reset(): void;
}

export const presenceStore = createStore<PresenceState>()((set) => ({
  people: [],
  count: 0,
  update(states, selfKey) {
    const entries: Array<[number, PresenceUser]> = [...states.entries()]
      .filter(([, s]) => s.user)
      .map(([clientId, s]) => [clientId, s.user as PresenceUser]);
    const people = groupPresence(entries, selfKey);
    set({ people, count: people.length });
  },
  reset() {
    set({ people: [], count: 0 });
  },
}));

export const usePresence = <T>(sel: (s: PresenceState) => T): T => useStore(presenceStore, sel);
