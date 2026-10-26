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
      style={{
        width: size,
        height: size,
        /* 用 color-mix 而不是拼 hex 后缀（`${color}1f`）：Player.color 现在可能是
           `var(--i3)` 这类 CSS 变量，拼后缀会得到 `var(--i3)1f` —— 非法值，整条 style 被丢掉
           （主 agent 的头像会变成没有底色、没有边框）。color-mix 接受 var()。 */
        background: `color-mix(in srgb, ${player.color} 12%, transparent)`,
        color: player.color,
        borderColor: `color-mix(in srgb, ${player.color} 33%, transparent)`,
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
