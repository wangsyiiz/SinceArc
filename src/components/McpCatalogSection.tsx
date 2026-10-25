import { useCallback, useEffect, useReducer, useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  asCmdError,
  mcpCatalog,
  mcpDelete,
  mcpUpsert,
  type McpCatalogEntryDto,
  type McpKeyValueDto,
  type McpServerDto,
} from "@/lib/ipc";
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
import { Segmented } from "./ui/Segmented";

const KIND_OPTIONS: { value: McpKind; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "http" },
  { value: "sse", label: "sse" },
];

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

function validateForm(form: FormState): string | null {
  if (!form.name.trim()) return "还缺：名称";
  if (form.kind === "stdio" && !form.command.trim()) return "还缺：command";
  if (form.kind !== "stdio" && !form.url.trim()) return "还缺：url";
  return null;
}

function ToggleSwitch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "sc-control relative h-4 w-8 shrink-0 rounded-control border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1",
        checked ? "border-accent-1 bg-accent-1" : "border-control bg-surface-3",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 size-3 rounded-mark bg-surface-1 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
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
  const patch = (id: string, next: Partial<PairRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-ink-2">{label}</span>
      <p className="text-micro text-ink-3">键名不掩码；值默认隐藏，每行可单独显示。</p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-1.5">
            <Input
              aria-label={`${label}键名`}
              value={row.name}
              placeholder="键名"
              spellCheck={false}
              onChange={(event) => patch(row.id, { name: event.target.value })}
              className="w-40 shrink-0 font-mono"
            />
            <Input
              aria-label={`${label}值`}
              type={row.reveal ? "text" : "password"}
              value={row.value}
              placeholder="值"
              spellCheck={false}
              onChange={(event) => patch(row.id, { value: event.target.value })}
              className="min-w-0 flex-1 font-mono"
            />
            <button
              type="button"
              aria-label={row.reveal ? `隐藏${label}值` : `显示${label}值`}
              onClick={() => patch(row.id, { reveal: !row.reveal })}
              className="grid size-7 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              {row.reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button
              type="button"
              aria-label={`删除这行${label}`}
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
          添加一行
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
      setError(`读取 MCP 目录失败：${asCmdError(e).msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

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
      setFormError(invalid);
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
      setFormError(`保存 MCP 服务器失败：${err.msg}`);
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
      setError(`删除 MCP 服务器失败：${err.msg}`);
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
            取消
          </Button>
        </div>

        <Field
          label="名称"
          htmlFor="mcp-name"
          required
          hint={form.originalName ? "名称是目录里的唯一键，创建后不能改。" : undefined}
        >
          <Input
            id="mcp-name"
            value={form.name}
            readOnly={form.originalName !== null}
            placeholder="例如 filesystem"
            spellCheck={false}
            onChange={(event) => patchForm({ name: event.target.value })}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-2">类型</span>
          <Segmented
            ariaLabel="MCP 类型"
            compact
            options={KIND_OPTIONS}
            value={form.kind}
            onChange={(kind) => patchForm({ kind })}
          />
        </div>

        {form.kind === "stdio" ? (
          <>
            <Field label="command" htmlFor="mcp-command" required>
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
              hint="每行一个参数；参数里的空格会原样保留。"
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
              label="环境变量"
              rows={form.env}
              onChange={(env) => patchForm({ env })}
            />
          </>
        ) : (
          <>
            <Field label="url" htmlFor="mcp-url" required>
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
              label="请求头"
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
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-small font-medium text-ink-2">MCP 目录</h2>
        <Button variant="secondary" size="sm" onClick={startAdd}>
          <Plus className="size-3" />
          添加
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 break-all rounded-control bg-danger-1/10 px-2.5 py-2 font-mono text-caption text-danger-1">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui text-ink-1">新建连接默认继承这份目录</div>
          <p className="mt-0.5 text-caption text-ink-3">
            只影响之后新建的连接；已有连接各自保留自己的选择。
          </p>
        </div>
        <ToggleSwitch
          checked={inheritDefault}
          label="新建连接默认继承这份目录"
          onChange={onInheritDefaultChange}
        />
      </div>

      {editor.mode === "add" && renderForm("添加 MCP 服务器")}

      {loading ? (
        <p className="mt-4 text-caption text-ink-3">正在读取 MCP 目录…</p>
      ) : entries.length === 0 && !form ? (
        <div className="mt-4">
          <EmptyState
            compact
            title="还没有 MCP 服务器"
            description="这里配置的 MCP 服务器对所有 agent 生效。"
            action={
              <Button variant="secondary" size="sm" onClick={startAdd}>
                <Plus className="size-3" />
                添加服务器
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
                  {renderForm(`编辑 ${form?.originalName ?? entry.name}`, true)}
                </div>
              );
            }
            return (
              <div
                key={entry.name}
                className="sc-pane flex flex-wrap items-center gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className="max-w-40 shrink-0 truncate text-ui font-medium text-ink-1"
                    title={entry.name.length > 24 ? entry.name : undefined}
                  >
                    {entry.name}
                  </span>
                  <span className="shrink-0 rounded-mark bg-surface-3/45 px-1.5 py-0.5 font-mono text-micro text-ink-3">
                    {kind}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-caption text-ink-3"
                    title={summary !== fullSummary ? fullSummary : undefined}
                  >
                    {summary}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === entry.name}
                    onClick={() => startEdit(entry)}
                  >
                    <Pencil className="size-3" />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    danger
                    disabled={busy === entry.name}
                    onClick={() => setDeleteTarget(entry)}
                  >
                    <Trash2 className="size-3" />
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除 MCP 服务器"
        body={
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              从全局目录删除
              {deleteTarget ? <span className="font-mono text-ink-1"> {deleteTarget.name}</span> : null}
              ，所有连接与会话都会受影响。
            </li>
            <li>已经注入的会话要重新连接后，这个服务器才可能从 agent 进程里消失。</li>
            <li>删除后无法恢复。</li>
          </ul>
        }
        confirmLabel="删除"
        cancelLabel="取消"
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
