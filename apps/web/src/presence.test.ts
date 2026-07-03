import { describe, it, expect } from "vitest";
import {
  colorFromId,
  initials,
  groupPresence,
  splitForStack,
  type PresenceUser,
} from "./presence";

const user = (over: Partial<PresenceUser> = {}): PresenceUser => ({
  userId: null,
  name: "Oat 86",
  color: "hsl(0 70% 60%)",
  colorLight: "hsl(0 70% 60% / 0.2)",
  kind: "human",
  ...over,
});

describe("groupPresence", () => {
  it("collapses 4 entries with the same userId into 1 person with 4 clientIds", () => {
    const entries: Array<[number, PresenceUser]> = [
      [1, user({ userId: "u1" })],
      [2, user({ userId: "u1" })],
      [3, user({ userId: "u1" })],
      [4, user({ userId: "u1" })],
    ];
    const people = groupPresence(entries, null);
    expect(people).toHaveLength(1);
    expect(people[0].clientIds).toHaveLength(4);
    expect(people[0].clientIds).toEqual([1, 2, 3, 4]);
    expect(people[0].key).toBe("u1");
  });

  it("keeps 1 authed user + 2 guests as 3 separate people", () => {
    const entries: Array<[number, PresenceUser]> = [
      [10, user({ userId: "u1", name: "Ada" })],
      [11, user({ userId: null, name: "Almond 12" })],
      [12, user({ userId: null, name: "Berry 99" })],
    ];
    const people = groupPresence(entries, null);
    expect(people).toHaveLength(3);
    expect(people.map((p) => p.key).sort()).toEqual(["guest:11", "guest:12", "u1"]);
  });

  it("excludes exactly the local person via selfKey", () => {
    const entries: Array<[number, PresenceUser]> = [
      [1, user({ userId: "me" })],
      [2, user({ userId: "me" })],
      [3, user({ userId: "other" })],
    ];
    const people = groupPresence(entries, "me");
    expect(people).toHaveLength(1);
    expect(people[0].key).toBe("other");
  });

  it("keeps everyone when selfKey is null", () => {
    const entries: Array<[number, PresenceUser]> = [
      [1, user({ userId: "me" })],
      [3, user({ userId: "other" })],
    ];
    expect(groupPresence(entries, null)).toHaveLength(2);
  });
});

describe("colorFromId", () => {
  it("is deterministic for the same id", () => {
    expect(colorFromId("abc")).toEqual(colorFromId("abc"));
  });

  it("differs for different ids", () => {
    expect(colorFromId("abc").color).not.toBe(colorFromId("xyz").color);
  });
});

describe("initials", () => {
  it("uses first + last initials for two-word names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  it("uses the first two letters for one-word names", () => {
    expect(initials("Ada")).toBe("AD");
  });

  it("drops numeric words", () => {
    expect(initials("Oat 86")).toBe("O");
  });

  it("returns ? for names with no alphabetic words", () => {
    expect(initials("42 86")).toBe("?");
  });
});

describe("splitForStack", () => {
  it("shows all 3 with no overflow", () => {
    const people = groupPresence(
      [
        [1, user({ userId: "a" })],
        [2, user({ userId: "b" })],
        [3, user({ userId: "c" })],
      ],
      null,
    );
    const { visible, overflow } = splitForStack(people);
    expect(visible).toHaveLength(3);
    expect(overflow).toBe(0);
  });

  it("shows 2 visible + overflow 3 for 5 people", () => {
    const people = groupPresence(
      [
        [1, user({ userId: "a" })],
        [2, user({ userId: "b" })],
        [3, user({ userId: "c" })],
        [4, user({ userId: "d" })],
        [5, user({ userId: "e" })],
      ],
      null,
    );
    const { visible, overflow } = splitForStack(people);
    expect(visible).toHaveLength(2);
    expect(overflow).toBe(3);
  });
});
