/**
 * Runes store for co-presence: one entry per *person* (deduped by userId, guests
 * by clientId), not per client/tab. EditorPane feeds it raw awareness entries +
 * the local person's key from the open session; PresenceStack renders the roster.
 * Reset to empty on session teardown or when a non-synced note is open.
 */
import { groupPresence, type PresencePerson, type PresenceUser } from "$lib/presence";

class PresenceStore {
  /** The grouped roster, self excluded. */
  people = $state<PresencePerson[]>([]);

  /** Replace the roster from an awareness `getStates()` map, excluding self. */
  update(states: Map<number, { user?: PresenceUser }>, selfKey: string | null): void {
    const entries: Array<[number, PresenceUser]> = [...states.entries()]
      .filter(([, s]) => s.user)
      .map(([clientId, s]) => [clientId, s.user as PresenceUser]);
    this.people = groupPresence(entries, selfKey);
  }

  reset(): void {
    this.people = [];
  }

  /** Distinct-person count (StatusBar still shows this). */
  get count(): number {
    return this.people.length;
  }
}

export const presence = new PresenceStore();
