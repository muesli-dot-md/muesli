/**
 * Store for co-presence: one entry per *person* (deduped by userId, guests
 * by clientId), not per client/tab. Port of src/lib/sync/presence.svelte.ts.
 * EditorPane feeds it raw awareness entries + the local person's key from the
 * open session; PresenceStack renders the roster.
 * Reset to empty on session teardown or when a non-synced note is open.
 * The Svelte `count` getter is kept as a state field updated with `people`.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { groupPresence, type PresencePerson, type PresenceUser } from "@/services/presence";

export interface PresenceState {
  /** The grouped roster, self excluded. */
  people: PresencePerson[];
  /** Distinct-person count (StatusBar-era convenience; == people.length). */
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
