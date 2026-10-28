import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { asCmdError, mcpCatalog, type McpCatalogEntryDto } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { McpServerChecklist } from "./McpChecklist";
import { Segmented } from "./ui/Segmented";

type DefaultMode = "follow" | "custom";

/**
 * 连接默认是便捷性层：NULL 跟随目录全部，数组是明确集合。
 * 组件只改草稿，真正的 profile_set_default_mcp 在连接保存时发出。
 */
export function McpDefaultPicker({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (names: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<McpCatalogEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    mcpCatalog()
      .then((entries) => {
        if (alive) setCatalog(entries);
      })
      .catch((e) => {
        if (alive) {
          const err = asCmdError(e);
          setError(errorText(err.code, err.msg, t));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const catalogNames = useMemo(() => catalog.map((entry) => entry.name), [catalog]);
  const mode: DefaultMode = value === null ? "follow" : "custom";
  const selected = value ?? [];

  const chooseMode = (next: DefaultMode) => {
    if (next === mode) return;
    onChange(next === "follow" ? null : catalogNames);
  };

  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    onChange(catalog.filter((entry) => next.has(entry.name)).map((entry) => entry.name));
  };

  return (
    <div className="border-t border-line-1/50 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui font-medium text-ink-2">{t("settings.mcp.default.label")}</span>
        <Segmented
          ariaLabel={t("settings.mcp.default.label")}
          compact
          options={[
            { value: "follow", label: t("settings.mcp.mode.follow") },
            { value: "custom", label: t("settings.mcp.mode.custom") },
          ]}
          value={mode}
          disabled={loading || !!error}
          onChange={chooseMode}
        />
      </div>

      <p className="mt-1.5 text-caption text-ink-3">
        {mode === "follow"
          ? t("settings.mcp.mode.followCount", { count: catalogNames.length })
          : t("settings.mcp.mode.customCount", { count: selected.length })}
      </p>

      {loading ? (
        <p className="mt-2 text-caption text-ink-3">{t("settings.mcp.catalog.loading")}</p>
      ) : error ? (
        <p className="mt-2 break-all text-caption text-danger-1">
          {t("settings.mcp.catalog.loadFailed", { msg: error })}
        </p>
      ) : mode === "custom" ? (
        <div className="sc-pane mt-2 p-1">
          <McpServerChecklist
            entries={catalog}
            selected={selected}
            onToggle={toggle}
            emptyText={t("settings.mcp.catalog.emptyHint")}
          />
        </div>
      ) : null}

      <p className="mt-1.5 text-caption text-ink-3">
        {t("settings.mcp.default.hint")}
      </p>
    </div>
  );
}
