import { refOf, type Atom } from "./atom.ts";
import { mergeRuleOf as ruleOfKind } from "./message-registry.ts";

export type BlockKind = "stream" | "tool" | "request" | "single";

export interface Block {
  blockKind: BlockKind;
  atoms: Atom[];
  kind: string;
  primary: Atom;
}

/** 注册表给的规约；未登记 kind 落到 "none"（一块一原子）。 */
function mergeRuleOf(kind: string): "stream" | "tool" | "request" | "none" {
  return ruleOfKind(kind);
}

function makeBlock(blockKind: BlockKind, atom: Atom): Block {
  return { blockKind, atoms: [atom], kind: atom.kind, primary: atom };
}

export function blocksOf(atoms: Atom[]): Block[] {
  const sorted = atoms
    .map((atom, index) => ({ atom, index }))
    .sort((a, b) => a.atom.seq - b.atom.seq || a.index - b.index)
    .map(({ atom }) => atom);

  const blocks: Block[] = [];
  const merged = new Map<string, Block>();
  let openStreamKey: string | null = null;

  for (const atom of sorted) {
    const rule = mergeRuleOf(atom.kind);

    if (rule === "stream") {
      const key = JSON.stringify([
        atom.sessionId,
        refOf(atom, "messageId") ?? atom.id,
        atom.kind,
      ]);
      if (openStreamKey === key) {
        blocks[blocks.length - 1].atoms.push(atom);
      } else {
        blocks.push(makeBlock("stream", atom));
        openStreamKey = key;
      }
      continue;
    }

    openStreamKey = null;

    const refName = rule === "tool" ? "toolCallId" : rule === "request" ? "requestId" : null;
    const ref = refName ? refOf(atom, refName) : undefined;
    if ((rule === "tool" || rule === "request") && ref) {
      const key = JSON.stringify([rule, ref]);
      const existing = merged.get(key);
      if (existing) {
        existing.atoms.push(atom);
        existing.atoms.sort((a, b) => a.seq - b.seq);
        existing.primary = existing.atoms[0];
      } else {
        const block = makeBlock(rule, atom);
        merged.set(key, block);
        blocks.push(block);
      }
      continue;
    }

    blocks.push(makeBlock("single", atom));
  }

  return blocks.sort((a, b) => a.primary.seq - b.primary.seq);
}
