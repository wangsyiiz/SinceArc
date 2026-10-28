import { i18nText } from "./i18n-text.ts";

export interface PlayerSeed {
  id: string;
  name: string;
  handle: string;
  color: string;
  profileId: string;
  removed?: boolean;
  deleted?: boolean;
}

export function buildPlayers(input: {
  members: {
    id: string;
    name: string;
    handle: string;
    color: string;
    profileId: string;
  }[];
  known: {
    id: string;
    name: string;
    handle: string;
    color: string;
    profileId: string;
  }[];
  authorIds: string[];
}): PlayerSeed[] {
  const knownById = new Map(input.known.map((user) => [user.id, user]));
  const seen = new Set<string>();
  const players: PlayerSeed[] = [];

  const add = (player: PlayerSeed) => {
    if (seen.has(player.id)) return;
    seen.add(player.id);
    players.push(player);
  };

  for (const member of input.members) {
    add({ ...member, removed: false });
  }

  for (const authorId of input.authorIds) {
    if (seen.has(authorId)) continue;
    const known = knownById.get(authorId);
    if (known) {
      add({ ...known, removed: true });
    } else {
      add({
        id: authorId,
        name: i18nText("members.deleted"),
        handle: "",
        color: "var(--i3)",
        profileId: "",
        removed: true,
        deleted: true,
      });
    }
  }

  return players;
}
