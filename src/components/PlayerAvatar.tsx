import type { Player } from "@/types";
import { cn } from "@/lib/utils";

export function PlayerAvatar({
  player,
  size = 22,
  className,
}: {
  player: Player;
  size?: number;
  className?: string;
}) {
  return (
    <span
      title={player.name}
      style={{
        width: size,
        height: size,
        background: `${player.color}1f`,
        color: player.color,
        borderColor: `${player.color}55`,
        fontSize: Math.round(size * 0.44),
      }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full border font-semibold leading-none",
        className,
      )}
    >
      {player.name.slice(0, 1)}
    </span>
  );
}
