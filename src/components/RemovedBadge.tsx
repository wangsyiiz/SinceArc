import { UserMinus } from "lucide-react";
import { useTranslation } from "react-i18next";

export function RemovedBadge({
  player,
}: {
  player?: { removed?: boolean; deleted?: boolean } | null;
}) {
  const { t } = useTranslation();
  if (!player?.removed || player.deleted) return null;

  return (
    <span className="inline-flex items-center gap-1 text-micro text-ink-3">
      <UserMinus size={10} />
      {t("members.removedBadge")}
    </span>
  );
}
