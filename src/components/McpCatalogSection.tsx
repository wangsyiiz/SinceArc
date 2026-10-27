import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import type { MessageKey } from "@/i18n/zh-CN";
import {
  asCmdError,
  mcpCatalog,
  mcpDelete,
  mcpUpsert,
  type McpCatalogEntryDto,
  type McpKeyValueDto,
  type McpServerDto,
} from "@/lib/ipc";
import { Switch } from "@/components/ui/Switch";
import {
  describeServer,
  entryKind,
  serverFields,
  type McpKind,
} from "@/lib/mcp-display";
import {
  MCP_CATALOG_EDITOR_CLOSED,
  mcpCatalogEditorReducer,
} from "@/lib/mcp-catalog-editor";
import { newId } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { Field, Input, Textarea } from "./ui/Field";
import { useHoverCard } from "./ui/HoverCard";
import { Segmented } from "./ui/Segmented";
import { Tooltip } from "./ui/Tooltip";

const KIND_OPTIONS: { value: McpKind; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "http" },
  { value: "sse", label: "sse" },
];

const DELETE_MCP_HEADING_KEY: MessageKey = "settings.mcp.deleteHeading";

function LongTextHover({
  text,
  disabled = false,
  className,
  children,
}: {
  text: string;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard({ disabled });
  return (
    <>
      <span ref={setEl} {...hover.triggerProps(el)} className={className}>
        {children ?? text}
      </span>
      {hover.card(<span className="break-all font-mono">{text}</span>)}
    </>
  );
}

interface PairRow extends McpKeyValueDto {
  id: string;
  reveal: boolean;
}

interface FormState {
  originalName: string | null;
  name: string;
  kind: McpKind;
  command: string;
  argsText: string;
  url: string;
  env: PairRow[];
  headers: PairRow[];
}

function pairRow(name = "", value = ""): PairRow {
  return { id: newId("mcp-kv"), name, value, reveal: false };
}

function emptyForm(): FormState {
  return {
    originalName: null,
    name: "",
    kind: "stdio",
    command: "",
    argsText: "",
    url: "",
    env: [pairRow()],
    headers: [pairRow()],
  };
}

function formFromEntry(entry: McpCatalogEntryDto): FormState {
  const fields = serverFields(entry.server);
  return {
    originalName: entry.name,
    name: entry.name,
    kind: entryKind(entry),
    command: fields.command,
    argsText: fields.args.join("\n"),
    url: fields.url,
    env: fields.env.length > 0 ? fields.env.map((pair) => pairRow(pair.name, pair.value)) : [pairRow()],
    headers:
      fields.headers.length > 0
        ? fields.headers.map((pair) => pairRow(pair.name, pair.value))
        : [pairRow()],
  };
}

function asServerDto(value: Record<string, unknown>): McpServerDto {
  return value as unknown as McpServerDto;
}

function pairs(rows: PairRow[]): McpKeyValueDto[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ name: row.name.trim(), value: row.value }));
}

function formServer(form: FormState): McpServerDto {
  const name = form.name.trim();
  if (form.kind === "stdio") {
    return asServerDto({
      name,
      command: form.command.trim(),
      args: form.argsText
        .split(/\r?\n/)
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      env: pairs(form.env),
    });
  }
  return asServerDto({
    type: form.kind,
    name,
    url: form.url.trim(),
    headers: pairs(form.headers),
  });
}

function validateForm(form: FormState): MessageKey | null {
  if (!form.name.trim()) return "ui.field.name";
  if (form.kind === "stdio" && !form.command.trim()) return "settings.mcp.field.command";
  if (form.kind !== "stdio" && !form.url.trim()) return "settings.mcp.field.url";
  return null;
}

function PairEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: PairRow[];
  onChange: (rows: PairRow[]) => void;
}) {
  const { t } = useTranslation();
  const patch = (id: string, next: Partial<PairRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-ink-2">{label}</span>
      <p className="text-micro text-ink-3">{t("settings.mcp.form.pairsHint")}</p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-1.5">
            <Input
              aria-label={t("settings.mcp.form.pairKeyAria", { label })}
              value={row.name}
              placeholder={t("settings.mcp.form.keyPlaceholder")}
              spellCheck={false}
              onChange={(event) => patch(row.id, { name: event.target.value })}
              className="w-40 shrink-0 font-mono"
            />
            <Input
              aria-label={t("settings.mcp.form.pairValueAria", { label })}
              type={row.reveal ? "text" : "password"}
              value={row.value}
              placeholder={t("settings.mcp.form.valuePlaceholder")}
              spellCheck={false}
              onChange={(event) => patch(row.id, { value: event.target.value })}
              className="min-w-0 flex-1 font-mono"
            />
            <button
              type="button"
              aria-label={
                row.reveal
                  ? t("settings.mcp.form.hideValueAria", { label })
                  : t("settings.mcp.form.showValueAria", { label })
              }
              onClick={() => patch(row.id, { reveal: !row.reveal })}
              className="grid size-7 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              {row.reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button
              type="button"
              aria-label={t("settings.mcp.form.deletePairAria", { label })}
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
              className="grid size-7 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={() => onChange([...rows, pairRow()])}>
          <Plus className="size-3" />
          {t("settings.mcp.form.addRow")}
        </Button>
      </div>
    </div>
  );
}

export function McpCatalogSection({
  inheritDefault,
  onInheritDefaultChange,
}: {
  inheritDefault: boolean;
  onInheritDefaultChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<McpCatalogEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [editor, dispatchEditor] = useReducer(
    mcpCatalogEditorReducer,
    MCP_CATALOG_EDITOR_CLOSED,
  );
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpCatalogEntryDto | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await mcpCatalog());
    } catch (e) {
      setError(t("settings.mcp.catalog.loadFailed", { msg: asCmdError(e).msg }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const startAdd = () => {
    dispatchEditor({ type: "add" });
    setForm(emptyForm());
    setFormError(null);
    setError(null);
  };

  const startEdit = (entry: McpCatalogEntryDto) => {
    dispatchEditor({ type: "edit", name: entry.name });
    setForm(formFromEntry(entry));
    setFormError(null);
    setError(null);
  };

  const cancelEdit = () => {
    dispatchEditor({ type: "close" });
    setForm(null);
    setFormError(null);
  };

  const save = async () => {
    if (!form) return;
    const invalid = validateForm(form);
    if (invalid) {
      setFormError(t("ui.validation.missing", { fields: t(invalid) }));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await mcpUpsert(formServer(form));
      dispatchEditor({ type: "close" });
      setForm(null);
      await load();
    } catch (e) {
      const err = asCmdError(e);
      setFormError(t("settings.mcp.form.saveFailed", { msg: err.msg }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: McpCatalogEntryDto) => {
    if (editor.mode === "edit" && editor.name === entry.name) cancelEdit();
    setBusy(entry.name);
    setError(null);
    try {
      await mcpDelete(entry.name);
      await load();
    } catch (e) {
      const err = asCmdError(e);
      setError(t("settings.mcp.form.deleteFailed", { msg: err.msg }));
    } finally {
      setBusy(null);
    }
  };

  const patchForm = (patch: Partial<FormState>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setFormError(null);
  };

  const renderForm = (title: string, inline = false) => {
    if (!form) return null;
    return (
      <div className={cn("sc-pane space-y-4 p-3", !inline && "mt-3")}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui font-medium text-ink-1">{title}</h3>
          <Button variant="ghost" size="sm" onClick={cancelEdit}>
            {t("ui.button.cancel")}
          </Button>
        </div>

        <Field
          label={t("ui.field.name")}
          htmlFor="mcp-name"
          required
          hint={form.originalName ? t("settings.mcp.form.nameHint") : undefined}
        >
          <Input
            id="mcp-name"
            value={form.name}
            readOnly={form.originalName !== null}
            placeholder={t("settings.mcp.form.namePlaceholder")}
            spellCheck={false}
            onChange={(event) => patchForm({ name: event.target.value })}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-2">
            {t("settings.mcp.form.type")}
          </span>
          <Segmented
            ariaLabel={t("settings.mcp.form.typeAria")}
            compact
            options={KIND_OPTIONS}
            value={form.kind}
            onChange={(kind) => patchForm({ kind })}
          />
        </div>

        {form.kind === "stdio" ? (
          <>
            <Field
              label={t("settings.mcp.field.command")}
              htmlFor="mcp-command"
              required
            >
              <Input
                id="mcp-command"
                value={form.command}
                placeholder="npx"
                spellCheck={false}
                onChange={(event) => patchForm({ command: event.target.value })}
                className="font-mono"
              />
            </Field>
            <Field
              label="args"
              htmlFor="mcp-args"
              hint={t("settings.mcp.form.argsHint")}
            >
              <Textarea
                id="mcp-args"
                value={form.argsText}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/mnt/c/source"}
                spellCheck={false}
                onChange={(event) => patchForm({ argsText: event.target.value })}
                className="font-mono"
              />
            </Field>
            <PairEditor
              label={t("settings.mcp.form.env")}
              rows={form.env}
              onChange={(env) => patchForm({ env })}
            />
          </>
        ) : (
          <>
            <Field label={t("settings.mcp.field.url")} htmlFor="mcp-url" required>
              <Input
                id="mcp-url"
                value={form.url}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                onChange={(event) => patchForm({ url: event.target.value })}
                className="font-mono"
              />
            </Field>
            <PairEditor
              label={t("settings.mcp.form.headers")}
              rows={form.headers}
              onChange={(headers) => patchForm({ headers })}
            />
          </>
        )}

        {formError && (
          <p role="alert" className="text-caption text-danger-1">
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={cancelEdit}>
            {t("ui.button.cancel")}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
            {t("ui.button.save")}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-small font-medium text-ink-2">{t("settings.mcp.catalog.title")}</h2>
        <Button variant="secondary" size="sm" onClick={startAdd}>
          <Plus className="size-3" />
          {t("ui.button.add")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 break-all rounded-control bg-danger-1/10 px-2.5 py-2 font-mono text-caption text-danger-1">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui text-ink-1">{t("settings.mcp.catalog.inheritLabel")}</div>
          <p className="mt-0.5 text-caption text-ink-3">
            {t("settings.mcp.catalog.inheritHint")}
          </p>
        </div>
        <Switch
          checked={inheritDefault}
          label={t("settings.mcp.catalog.inheritLabel")}
          onChange={onInheritDefaultChange}
        />
      </div>

      {editor.mode === "add" && renderForm(t("settings.mcp.form.addTitle"))}

      {loading ? (
        <p className="mt-4 text-caption text-ink-3">{t("settings.mcp.catalog.loading")}</p>
      ) : entries.length === 0 && !form ? (
        <div className="mt-4">
          <EmptyState
            compact
            heading={t("settings.mcp.catalog.emptyHeading")}
            description={t("settings.mcp.catalog.emptyDescription")}
            action={
              <Button variant="secondary" size="sm" onClick={startAdd}>
                <Plus className="size-3" />
                {t("settings.mcp.catalog.addServer")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((entry) => {
            const kind = entryKind(entry);
            const summary = describeServer(entry);
            const fullSummary = describeServer(entry, 100000);
            if (editor.mode === "edit" && editor.name === entry.name) {
              return (
                <div key={entry.name}>
                  {renderForm(
                    t("settings.mcp.form.editTitle", {
                      name: form?.originalName ?? entry.name,
                    }),
                    true,
                  )}
                </div>
              );
            }
            return (
              <div
                key={entry.name}
                className="sc-pane flex flex-wrap items-center gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {entry.name.length > 24 ? (
                    <Tooltip label={entry.name}>
                      <span className="max-w-40 shrink-0 truncate text-ui font-medium text-ink-1">
                        {entry.name}
                      </span>
                    </Tooltip>
                  ) : (
                    <span className="max-w-40 shrink-0 truncate text-ui font-medium text-ink-1">
                      {entry.name}
                    </span>
                  )}
                  <span className="shrink-0 rounded-mark bg-surface-3/45 px-1.5 py-0.5 font-mono text-micro text-ink-3">
                    {kind}
                  </span>
                  <LongTextHover
                    text={fullSummary}
                    disabled={summary === fullSummary}
                    className="min-w-0 flex-1 truncate font-mono text-caption text-ink-3"
                  >
                    {summary}
                  </LongTextHover>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === entry.name}
                    onClick={() => startEdit(entry)}
                  >
                    <Pencil className="size-3" />
                    {t("ui.button.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    danger
                    disabled={busy === entry.name}
                    onClick={() => setDeleteTarget(entry)}
                  >
                    <Trash2 className="size-3" />
                    {t("app.delete.confirm")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t(DELETE_MCP_HEADING_KEY)}
        body={
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <Trans
                i18nKey="settings.mcp.delete.body.global"
                values={{ name: deleteTarget?.name ?? "" }}
                components={{ name: <span className="font-mono text-ink-1" /> }}
              />
            </li>
            <li>{t("settings.mcp.delete.body.injected")}</li>
            <li>{t("settings.mcp.delete.body.irreversible")}</li>
          </ul>
        }
        confirmLabel={t("app.delete.confirm")}
        cancelLabel={t("ui.button.cancel")}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void remove(target);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
