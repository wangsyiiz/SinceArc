import { UserMinus } from "lucide-react";

export function RemovedBadge({
  player,
}: {
  player?: { removed?: boolean; deleted?: boolean } | null;
}) {
  if (!player?.removed || player.deleted) return null;

  return (
    <span className="inline-flex items-center gap-1 text-micro text-ink-3">
      <UserMinus size={10} />
      已移出
    </span>
  );
}
