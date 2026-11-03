import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

export function BackToDashboard({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-2 inline-flex items-center gap-1 rounded-mark px-1.5 py-1 text-micro text-ink-3 transition-colors hover:bg-surface-2/60 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
    >
      <ChevronLeft className="size-3" />
      {t("repo.dash.back")}
    </button>
  );
}
