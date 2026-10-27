import { CornerDownLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandMark } from "./BrandMark";
import { EmptyState as PrimitiveEmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";

const SUGGESTION_KEYS = [
  "emptyState.suggestion.structure",
  "emptyState.suggestion.tests",
  "emptyState.suggestion.cleanup",
] as const;

export function EmptyState({ cwd, onPick }: { cwd: string; onPick: (text: string) => void }) {
  const { t } = useTranslation();
  const suggestions = SUGGESTION_KEYS.map((key) => ({ key, text: t(key) }));
  return (
    <PrimitiveEmptyState
      heading="SinceArc"
      description={t("emptyState.description", { cwd })}
      icon={
        <div className="grid size-12 place-items-center rounded-card border border-line-1 bg-surface-1 text-accent-1">
          <BrandMark className="size-7" />
        </div>
      }
      action={
        <div className="flex w-full max-w-md flex-col gap-2">
          {suggestions.map(({ key, text }) => (
            <Button
              key={key}
              variant="secondary"
              className="w-full justify-start"
              onClick={() => onPick(text)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{text}</span>
              <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            </Button>
          ))}
        </div>
      }
    />
  );
}
