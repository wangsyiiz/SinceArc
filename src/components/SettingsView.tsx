import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  MessageSquare,
  Palette,
  Plug,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { AgentProfile, LaunchKind, SshAuth, ThemeMode, ThreadSettings } from "@/types";
import { cn } from "@/lib/utils";
import {
  agentProbe,
  asCmdError,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryOutcome,
  type ModesSnapshot,
  type ProbeOutcome,
} from "@/lib/ipc";
import {
  AGENT_PRESETS,
  joinCommand,
  matchPreset,
  splitCommand,
  type AgentPreset,
} from "@/lib/agentPresets";
import { ModeSelect } from "@/components/ModeSelect";

interface SettingsViewProps {
  settings: ThreadSettings;
  theme: ThemeMode;
  profiles: AgentProfile[];
  onUpdateProfile: (next: AgentProfile) => void;
  /** 连接/断开都走 App 里的那一份实现（并发去重、状态回写都在那边） */
  onConnect: (p: AgentProfile) => Promise<string>;
  onDisconnect: (profileId: string) => Promise<void>;
  onAddProfile: () => void;
  onRemoveProfile: (id: string) => void;
  /** 连接已经断开：App 用它清掉这个连接下待答的权限请求 */
  onDisconnected?: (profileId: string) => void;
  /** 设置页只能读到最近一次连接报上来的模式快照（可选列表 + agent 当前值） */
  modesFor: (profileId: string) => ModesSnapshot | null;
  onChangeContext: (n: number) => void;
  onCycleTheme: (t: ThemeMode) => void;
  /** 最近收到的 ACP 事件（诊断用：确认通道到底通不通） */
  eventLog?: { at: number; text: string }[];
  /** agent 发现（docs/discovery.md）：缓存结果、是否在扫、手动重扫 */
  discovery?: DiscoveryOutcome | null;
  discoveryScanning?: boolean;
  discoveryError?: string | null;
  onScanDiscovery?: () => void;
  /** 用发现到的命令直接建一个连接（program/args/cwd 都带好，用户不用手填） */
  onUseDiscovered?: (candidate: DiscoveryCandidate, hit: DiscoveryHit) => void;
}

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "system", label: "跟随系统" },
];

const SECTIONS = [
  { id: "connection", label: "连接", icon: Plug },
  { id: "chat", label: "群聊", icon: MessageSquare },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "session", label: "会话", icon: SlidersHorizontal },
  { id: "diagnostics", label: "诊断", icon: Activity },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const LAUNCH_LABEL: Record<LaunchKind, string> = {
  local: "本机直连",
  wsl: "WSL",
  ssh: "SSH",
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9.5px] text-ink-3">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 text-[11px] text-ink-1",
          "placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none",
          mono && "font-mono",
        )}
      />
    </label>
  );
}

type ProbeResult =
  | { ok: true; outcome: ProbeOutcome }
  | { ok: false; error: string };

function AgentSelect({
  profile,
  onPreset,
  onCustom,
}: {
  profile: AgentProfile;
  onPreset: (preset: AgentPreset) => void;
  onCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = matchPreset(profile.program, profile.args);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 max-w-[220px] items-center gap-1.5 rounded-[6px] px-2 text-[11px] transition-colors",
          open
            ? "bg-surface-3/65 text-ink-1"
            : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <span className="truncate">{current?.name ?? "自定义"}</span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-ink-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="sc-glass absolute top-full right-0 z-30 mt-1.5 w-[320px] rounded-[10px] p-1">
          {AGENT_PRESETS.map((preset) => {
            const active = current?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.origin}
                onClick={() => {
                  onPreset(preset);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
                  active ? "sc-row-active" : "hover:bg-surface-3/45",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-1">
                  {preset.name}
                </span>
                <span className="max-w-[150px] shrink-0 truncate text-[9.5px] text-ink-3">
                  {preset.requires ?? preset.origin}
                </span>
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {active && <Check className="size-3.5 text-accent-1" />}
                </span>
              </button>
            );
          })}

          <div className="my-1 border-t border-line-1/40" />
          <button
            type="button"
            onClick={() => {
              onCustom();
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
              current ? "hover:bg-surface-3/45" : "sc-row-active",
            )}
          >
            <span className="min-w-0 flex-1 text-[11.5px] text-ink-1">自定义命令</span>
            <span className="grid size-3.5 shrink-0 place-items-center">
              {!current && <Check className="size-3.5 text-accent-1" />}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsView({
  settings,
  theme,
  profiles,
  onUpdateProfile,
  onConnect,
  onDisconnect,
  onAddProfile,
  onRemoveProfile,
  onDisconnected,
  modesFor,
  onChangeContext,
  onCycleTheme,
  eventLog = [],
  discovery = null,
  discoveryScanning = false,
  discoveryError = null,
  onScanDiscovery,
  onUseDiscovered,
}: SettingsViewProps) {
  const [active, setActive] = useState<SectionId>("chat");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 探测会真的 spawn 进程，和连接用的 busy 分开，避免互相锁住 */
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [commandDrafts, setCommandDrafts] = useState<Record<string, string>>({});
  const [commandEditing, setCommandEditing] = useState<Record<string, boolean>>({});
  const refs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const [copied, setCopied] = useState(false);
  /** 发现列表里逐条「验证」的结果，key = candidateId@host */
  const [discoveryProbe, setDiscoveryProbe] = useState<
    Record<string, { busy?: boolean; ok?: string; error?: string }>
  >({});

  /** 诊断内容是用来贴给别人看的，不能只让人截图 */
  const copyDiagnostics = async () => {
    const text = eventLog
      .map(
        (e) =>
          `${new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}  ${e.text}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // WebView 不给 clipboard 权限时的兜底
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const n = settings.contextMessages;
  const heavy = n > 10;

  const handleConnect = async (p: AgentProfile) => {
    setBusy(p.id);
    setErrors((e) => ({ ...e, [p.id]: "" }));
    try {
      // 连接、状态回写、会话绑定都在 useAgentConnect 里，这里只负责把错误显示出来
      await onConnect(p);
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({ ...prev, [p.id]: `${err.code} ${err.msg}` }));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async (p: AgentProfile) => {
    setBusy(p.id);
    setErrors((e) => ({ ...e, [p.id]: "" }));
    try {
      await onDisconnect(p.id);
      onDisconnected?.(p.id);
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({ ...prev, [p.id]: `${err.code} ${err.msg}` }));
    } finally {
      setBusy(null);
    }
  };

  const clearProbe = (id: string) => {
    setProbeResults((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearCommandDraft = (id: string) => {
    setCommandDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const choosePreset = (p: AgentProfile, preset: AgentPreset) => {
    clearProbe(p.id);
    clearCommandDraft(p.id);
    setCommandEditing((prev) => ({ ...prev, [p.id]: false }));
    onUpdateProfile({ ...p, program: preset.program, args: [...preset.args] });
  };

  const chooseCustom = (p: AgentProfile) => {
    clearCommandDraft(p.id);
    setCommandEditing((prev) => ({ ...prev, [p.id]: true }));
  };

  const commitCommand = (p: AgentProfile) => {
    const raw = commandDrafts[p.id];
    if (raw === undefined) return;
    if (!raw.trim()) {
      // 空输入不写回，保留原命令
      clearCommandDraft(p.id);
      return;
    }
    const { program, args } = splitCommand(raw);
    const unchanged =
      program === (p.program ?? "") &&
      args.join("\u0000") === (p.args ?? []).join("\u0000");
    clearCommandDraft(p.id);
    if (unchanged) return;
    clearProbe(p.id);
    onUpdateProfile({ ...p, program, args });
  };

  const handleProbe = async (p: AgentProfile) => {
    const draft = commandDrafts[p.id];
    // 点探测时输入框可能还没 blur：按框里的内容探测，而不是上一次提交的值
    const target =
      draft !== undefined && draft.trim()
        ? { ...p, ...splitCommand(draft) }
        : p;
    setProbeBusy(p.id);
    clearProbe(p.id);
    try {
      const outcome = await agentProbe(target);
      setProbeResults((prev) => ({ ...prev, [p.id]: { ok: true, outcome } }));
    } catch (e) {
      const err = asCmdError(e);
      setProbeResults((prev) => ({
        ...prev,
        [p.id]: { ok: false, error: `${err.code} ${err.msg}` },
      }));
    } finally {
      setProbeBusy((current) => (current === p.id ? null : current));
    }
  };

  /** 左侧导航只做锚点跳转：内容始终整页可见 */
  /** 把「发现到的一条命令 + 它所在的环境」翻译成一条可探测/可保存的连接配置 */
  const profileFromHit = (c: DiscoveryCandidate, hit: DiscoveryHit): AgentProfile => {
    const wsl = hit.host.startsWith("wsl:");
    return {
      id: "p-discovery",
      name: "",
      launch: wsl ? "wsl" : "local",
      detail: "",
      connected: false,
      agentName: null,
      protocolVersion: null,
      program: c.acpProgram,
      args: [...c.acpArgs],
      // cd '<cwd>' 里的 ~ 不会被展开，所以必须用扫出来的绝对家目录
      cwd: hit.home ?? "",
      distro: wsl ? hit.host.slice("wsl:".length) : undefined,
      shell: wsl ? "zsh" : undefined,
      ssh: { host: "", port: 22, user: "", auth: "key" },
    };
  };

  /**
   * 扫到 ≠ 能用：这里真起一次 initialize（与连接卡片上的「探测」同一条路径、同一套错误码）。
   * 两层分开的意义就在这儿 —— 扫描可以很快很宽，验证只对用户真想要的那一个做。
   */
  const handleDiscoveryProbe = async (c: DiscoveryCandidate, hit: DiscoveryHit) => {
    const key = `${c.id}@${hit.host}`;
    setDiscoveryProbe((prev) => ({ ...prev, [key]: { busy: true } }));
    try {
      const out = await agentProbe(profileFromHit(c, hit));
      setDiscoveryProbe((prev) => ({
        ...prev,
        [key]: { ok: `${out.agentName} ${out.agentVersion} · 协议 v${out.protocolVersion}` },
      }));
    } catch (e) {
      const err = asCmdError(e);
      setDiscoveryProbe((prev) => ({ ...prev, [key]: { error: `${err.code} ${err.msg}` } }));
    }
  };

  const jump = (id: SectionId) => {
    setActive(id);
    refs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex min-h-0 flex-1 justify-center">
      <div className="flex min-h-0 w-full max-w-[780px]">
        <nav className="w-[152px] shrink-0 px-2 py-6">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => jump(id)}
            className={cn(
              "mb-0.5 flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12px] transition-colors",
              active === id ? "sc-row-active text-ink-1" : "text-ink-2 hover:bg-surface-3/35",
            )}
          >
            <Icon className="size-3.5 shrink-0 text-ink-3" />
            {label}
          </button>
        ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-6 py-6">
          <h1 className="text-[15px] font-medium text-ink-1">设置</h1>

          <section
            ref={(el) => {
              refs.current.connection = el;
            }}
            className="mt-5 scroll-mt-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[12px] font-medium text-ink-2">连接</h2>
              <button
                onClick={onAddProfile}
                className="flex items-center gap-1 rounded-[6px] px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
              >
                <Plus className="size-3" />
                新建
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {profiles.length === 0 && (
                <div className="rounded-[8px] border border-dashed border-line-1/60 px-3 py-6 text-center text-[10.5px] text-ink-3">
                  还没有连接配置。点右上「新建」加一个 —— 填好之后会自动存到本机。
                </div>
              )}
              {profiles.map((p) => {
                const ssh = p.ssh;
                const snapshot = modesFor(p.id);
                const availableModes = snapshot?.available ?? [];
                // snapshot.current 是 session/new 那一刻 agent 自己的值（那时我们还没推值），
                // 正好就是「不指定」时实际会生效的模式
                const agentDefault = availableModes.find((m) => m.id === snapshot?.current);
                const agentDefaultLabel = agentDefault?.name ?? snapshot?.current ?? null;
                const currentPreset = matchPreset(p.program, p.args);
                const command = commandDrafts[p.id] ?? joinCommand(p.program, p.args);
                const showCommand = currentPreset === null || commandEditing[p.id];
                const probe = probeResults[p.id];
                return (
                  <div key={p.id} className="rounded-[8px] border border-line-1/60 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <input
                          value={p.name}
                          onChange={(e) => onUpdateProfile({ ...p, name: e.target.value })}
                          className="w-full truncate rounded-[4px] bg-transparent text-[12px] text-ink-1 focus:bg-surface-2/50 focus:outline-none"
                        />
                        <div className="truncate font-mono text-[9.5px] text-ink-3">
                          {p.detail || "未配置"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full border border-line-1/60 px-2 py-0.5 font-mono text-[9px] text-ink-3">
                          {LAUNCH_LABEL[p.launch]}
                        </span>
                        <button
                          onClick={() => (p.connected ? handleDisconnect(p) : handleConnect(p))}
                          disabled={busy === p.id}
                          className={cn(
                            "rounded-[6px] px-2 py-1 text-[10.5px] transition-colors",
                            "sc-row-active text-ink-1 hover:brightness-110",
                            busy === p.id && "opacity-60",
                          )}
                        >
                          {busy === p.id ? "…" : p.connected ? "断开" : "连接"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-1.5 flex items-center gap-1.5 text-[9.5px]">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          p.connected ? "bg-ok-1" : "bg-ink-3/50",
                        )}
                      />
                      <span className={p.connected ? "text-ok-1" : "text-ink-3"}>
                        {p.connected ? (p.agentName ?? "已连接") : "未连接"}
                      </span>
                      <button
                        onClick={() => onRemoveProfile(p.id)}
                        title="删除这个连接"
                        className="ml-auto rounded-[4px] p-1 text-ink-3 transition-colors hover:bg-danger-1/[0.12] hover:text-danger-1"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>

                    <div className="mt-2.5 flex gap-1">
                      {(["local", "wsl", "ssh"] as LaunchKind[]).map((k) => (
                        <button
                          key={k}
                          onClick={() =>
                            onUpdateProfile({
                              ...p,
                              launch: k,
                              ssh:
                                k === "ssh"
                                  ? (p.ssh ?? { host: "", port: 22, user: "", auth: "key" })
                                  : p.ssh,
                            })
                          }
                          className={cn(
                            "flex-1 rounded-[6px] py-1 text-[10.5px] transition-colors",
                            p.launch === k
                              ? "sc-row-active text-ink-1"
                              : "text-ink-3 hover:bg-surface-3/35 hover:text-ink-2",
                          )}
                        >
                          {LAUNCH_LABEL[k]}
                        </button>
                      ))}
                    </div>

                    {p.launch === "ssh" && ssh && (
                      <div className="mt-2.5 grid grid-cols-2 gap-2">
                        <Field
                          label="主机"
                          mono
                          value={ssh.host}
                          placeholder="47.109.56.213 或 ~/.ssh/config 的别名"
                          onChange={(v) => onUpdateProfile({ ...p, ssh: { ...ssh, host: v } })}
                        />
                        <Field
                          label="端口"
                          mono
                          value={String(ssh.port)}
                          onChange={(v) =>
                            onUpdateProfile({ ...p, ssh: { ...ssh, port: Number(v) || 22 } })
                          }
                        />
                        <Field
                          label="账号"
                          mono
                          value={ssh.user}
                          placeholder="root"
                          onChange={(v) => onUpdateProfile({ ...p, ssh: { ...ssh, user: v } })}
                        />
                        <label className="block">
                          <span className="mb-1 block text-[9.5px] text-ink-3">认证</span>
                          <select
                            value={ssh.auth}
                            onChange={(e) =>
                              onUpdateProfile({ ...p, ssh: { ...ssh, auth: e.target.value as SshAuth } })
                            }
                            className="h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 text-[11px] text-ink-1 focus:border-accent-1/50 focus:outline-none"
                          >
                            <option value="key">私钥</option>
                            <option value="password">密码</option>
                          </select>
                        </label>
                        <div className="col-span-2">
                          {ssh.auth === "key" ? (
                            <Field
                              label="私钥路径"
                              mono
                              value={ssh.keyPath ?? ""}
                              placeholder="C:\Users\you\.ssh\id_ed25519"
                              onChange={(v) => onUpdateProfile({ ...p, ssh: { ...ssh, keyPath: v } })}
                            />
                          ) : (
                            <Field
                              label="密码"
                              type="password"
                              value={ssh.password ?? ""}
                              placeholder="仅本次运行有效，不落盘"
                              onChange={(v) =>
                                onUpdateProfile({ ...p, ssh: { ...ssh, password: v } })
                              }
                            />
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mt-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="shrink-0 text-[9.5px] text-ink-3">Agent</span>
                        <AgentSelect
                          profile={p}
                          onPreset={(preset) => choosePreset(p, preset)}
                          onCustom={() => chooseCustom(p)}
                        />
                      </div>

                      <div className="mt-1.5 flex items-center gap-1.5">
                        {showCommand ? (
                          <input
                            aria-label="Agent 命令"
                            spellCheck={false}
                            value={command}
                            placeholder="npx -y @google/gemini-cli@0.65.0 --acp"
                            onChange={(e) =>
                              setCommandDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                            }
                            onBlur={() => commitCommand(p)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.currentTarget.blur();
                              }
                            }}
                            className="h-7 min-w-0 flex-1 rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 font-mono text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none"
                          />
                        ) : (
                          <span
                            title={command}
                            className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3"
                          >
                            {command}
                          </span>
                        )}
                        {!showCommand && (
                          <button
                            type="button"
                            onClick={() =>
                              setCommandEditing((prev) => ({ ...prev, [p.id]: true }))
                            }
                            className="shrink-0 rounded-[6px] px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
                          >
                            编辑命令
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleProbe(p)}
                          disabled={probeBusy === p.id}
                          className={cn(
                            "shrink-0 rounded-[6px] px-2 py-1 text-[10.5px] transition-colors",
                            "sc-row-active text-ink-1 hover:brightness-110",
                            probeBusy === p.id && "opacity-60",
                          )}
                        >
                          {probeBusy === p.id ? "探测中…" : "探测"}
                        </button>
                      </div>

                      <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
                        {currentPreset
                          ? currentPreset.origin
                          : "命令里可以带参数；确认能起 ACP 就用右边的探测"}
                      </p>
                      {probe && (
                        <p
                          className={cn(
                            "mt-1 break-all font-mono text-[9.5px] leading-relaxed",
                            probe.ok ? "text-ok-1" : "text-danger-1",
                          )}
                        >
                          {probe.ok
                            ? `已连接 ${probe.outcome.agentName} ${probe.outcome.agentVersion} · 协议 v${probe.outcome.protocolVersion}`
                            : probe.error}
                        </p>
                      )}
                      {p.connected && (
                        <p className="mt-1 text-[9.5px] leading-relaxed text-warn-1">
                          改了 agent 命令需要重新连接才会生效
                        </p>
                      )}
                    </div>

                    <div className="mt-2.5">
                      <Field
                        label="工作目录"
                        mono
                        value={p.cwd ?? ""}
                        placeholder={
                          p.launch === "local" ? "C:\\source\\your-project" : "/mnt/c/source/your-project"
                        }
                        onChange={(v) => onUpdateProfile({ ...p, cwd: v })}
                      />
                      <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
                        这个路径必须存在于 agent 那一侧：WSL 与 SSH 要 Linux 路径，本机要 Windows 路径。
                        填错了 agent 起不来（wsl 会报 chdir failed）。
                      </p>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-3">
                      <span className="shrink-0 text-[9.5px] text-ink-3">默认文件编辑审批</span>
                      <ModeSelect
                        compact
                        variant="connection"
                        followLabel="跟随 Agent"
                        fallbackLabel={agentDefaultLabel}
                        // 跟随且没有连接默认时，按钮上显示 agent 报的当前值（规范 §5.2）
                        current={p.defaultMode ?? snapshot?.current ?? null}
                        available={availableModes}
                        following={p.defaultMode == null}
                        onChoose={(modeId) => onUpdateProfile({ ...p, defaultMode: modeId })}
                      />
                    </div>
                    {availableModes.length === 0 && (
                      <p className="mt-1 text-right text-[9.5px] text-ink-3">
                        连接一次之后才能选
                      </p>
                    )}
                    <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
                      每次打开会话都会按这里重新应用；agent 在会话内自己切走的模式，重开后回到这里的设置。
                    </p>

                    {errors[p.id] && (
                      <p className="mt-2 break-all rounded-[6px] bg-danger-1/[0.09] px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-danger-1">
                        {errors[p.id]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 rounded-[8px] border border-line-1/60 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-1">这台机器上的 ACP agent</span>
                <button
                  type="button"
                  onClick={() => onScanDiscovery?.()}
                  disabled={discoveryScanning}
                  className={cn(
                    "shrink-0 rounded-[6px] px-2 py-1 text-[10.5px] transition-colors",
                    "sc-row-active text-ink-1 hover:brightness-110",
                    discoveryScanning && "opacity-60",
                  )}
                >
                  {discoveryScanning ? "扫描中…" : "重新扫描"}
                </button>
              </div>
              <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
                {discovery
                  ? `上次扫描 ${new Date(discovery.scannedAt).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}`
                  : discoveryScanning
                    ? "正在找本机已装的 agent…"
                    : "还没扫过"}
                ：扫到的只是「这个命令装没装」，能不能起 ACP 要按「验证」真连一次。
              </p>
              {discoveryError && (
                <p className="mt-1 break-all font-mono text-[9.5px] leading-relaxed text-danger-1">
                  {discoveryError}
                </p>
              )}
              {discovery?.warnings.map((w) => (
                <p
                  key={w}
                  className="mt-1 break-all font-mono text-[9.5px] leading-relaxed text-warn-1"
                >
                  {w}
                </p>
              ))}

              <div className="mt-1.5 divide-y divide-line-1/40">
                {discovery?.candidates.map((c) => {
                  const hits = discovery.found.filter((h) => h.candidateId === c.id);
                  return (
                    <div key={c.id} className="py-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "text-[11.5px]",
                            hits.length > 0 ? "text-ink-1" : "text-ink-3",
                          )}
                        >
                          {c.name}
                        </span>
                        <span
                          className={cn(
                            "rounded-[4px] px-1 py-px font-mono text-[9px]",
                            c.mode === "native" ? "text-ok-1" : "text-warn-1",
                          )}
                          title={c.note}
                        >
                          {c.mode === "native" ? "原生 ACP" : "需适配器"}
                        </span>
                        {hits.length === 0 && (
                          <span className="text-[9.5px] text-ink-3">未安装</span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[9.5px] text-ink-3">
                        {c.acpProgram} {c.acpArgs.join(" ")}
                      </p>
                      {c.mode === "adapter" && hits.length > 0 && (
                        <p className="mt-0.5 text-[9.5px] leading-relaxed text-warn-1">{c.note}</p>
                      )}
                      {hits.map((h) => {
                        const key = `${c.id}@${h.host}`;
                        const pr = discoveryProbe[key];
                        return (
                          <div key={key} className="mt-1">
                            <div className="flex items-center gap-1.5">
                              <span className="shrink-0 font-mono text-[9.5px] text-ink-2">
                                {h.host}
                              </span>
                              <span
                                title={h.path}
                                className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-ink-3"
                              >
                                {h.path}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleDiscoveryProbe(c, h)}
                                disabled={pr?.busy}
                                className={cn(
                                  "shrink-0 rounded-[6px] px-2 py-0.5 text-[10px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1",
                                  pr?.busy && "opacity-60",
                                )}
                              >
                                {pr?.busy ? "验证中…" : "验证"}
                              </button>
                              <button
                                type="button"
                                onClick={() => onUseDiscovered?.(c, h)}
                                className="shrink-0 rounded-[6px] px-2 py-0.5 text-[10px] text-accent-1 transition-colors hover:bg-surface-3/45"
                              >
                                用它建连接
                              </button>
                            </div>
                            {(pr?.ok || pr?.error) && (
                              <p
                                className={cn(
                                  "mt-0.5 break-all font-mono text-[9.5px] leading-relaxed",
                                  pr.ok ? "text-ok-1" : "text-danger-1",
                                )}
                              >
                                {pr.ok ?? pr.error}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
              本地与远程是同一条 SSH 路径，只差 host：本地填 <code className="font-mono">localhost</code>{" "}
              即可走 WSL 里的 sshd。密码不会落到 SQLite，存系统凭据库（未接线）。
            </p>
          </section>

          <section
            ref={(el) => {
              refs.current.chat = el;
            }}
            className="mt-7 scroll-mt-4"
          >
            <h2 className="text-[12px] font-medium text-ink-2">群聊</h2>
            <div className="mt-2 rounded-[8px] border border-line-1/60 p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-ink-1">@ 玩家时附带最近几条记录</span>
                <span className="font-mono text-[13px] tabular-nums text-accent-1">{n}</span>
              </div>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={n}
                onChange={(e) => onChangeContext(Number(e.target.value))}
                style={{ accentColor: "var(--a1)" }}
                className="mt-3 h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
              />
              <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-3">
                <span>0</span>
                <span>默认 5</span>
                <span>20</span>
              </div>

              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                只附带<span className="text-ink-2">其他成员</span>的发言。你自己的历史已经在 session
                里，重复带进去等于双份上下文。
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                这是<span className="text-ink-2">本轮开始前</span>
                的快照：并行时，A 看不到 B 在这一轮里刚说的话。
              </p>

              {heavy && (
                <p className="mt-2.5 flex items-start gap-1.5 rounded-[6px] bg-warn-1/[0.09] px-2.5 py-2 text-[11px] leading-relaxed text-warn-1">
                  <AlertTriangle className="mt-[1px] size-3 shrink-0" />
                  {n} 条会明显推高每次请求的输入 token；并行时还要乘以被 @ 的人数。
                </p>
              )}
            </div>
          </section>

          <section
            ref={(el) => {
              refs.current.appearance = el;
            }}
            className="mt-7 scroll-mt-4"
          >
            <h2 className="text-[12px] font-medium text-ink-2">外观</h2>
            <div className="mt-2 flex gap-1 rounded-[8px] border border-line-1/60 p-1">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onCycleTheme(t.id)}
                  className={cn(
                    "flex-1 rounded-[6px] py-2 text-[11.5px] transition-colors",
                    theme === t.id
                      ? "sc-row-active text-ink-1"
                      : "text-ink-3 hover:bg-surface-3/35 hover:text-ink-2",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
              暗色靠内边缘高光分界，浅色靠 1px 边框分界。
            </p>
          </section>

          <section
            ref={(el) => {
              refs.current.session = el;
            }}
            className="mt-7 scroll-mt-4"
          >
            <h2 className="text-[12px] font-medium text-ink-2">会话</h2>
            <div className="mt-2 space-y-2.5 rounded-[8px] border border-line-1/60 p-3.5 text-[11.5px] text-ink-2">
              <div className="flex items-center justify-between">
                <span>新建会话的默认目录</span>
                <span className="font-mono text-[10px] text-ink-3">workspace 根</span>
              </div>
              <div className="flex items-center justify-between">
                <span>群聊玩家上限</span>
                <span className="font-mono text-[10px] text-ink-3">4（未接线）</span>
              </div>
              <div className="flex items-center justify-between">
                <span>会话状态持久化</span>
                <span className="font-mono text-[10px] text-ink-3">SQLite（未接线）</span>
              </div>
            </div>
          </section>

            <section
              ref={(el) => {
                refs.current.diagnostics = el;
              }}
              className="mt-7 scroll-mt-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[12px] font-medium text-ink-2">诊断</h2>
                <button
                  onClick={copyDiagnostics}
                  disabled={eventLog.length === 0}
                  className="flex items-center gap-1 rounded-[6px] px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <div className="mt-2 rounded-[8px] border border-line-1/60 p-3">
                <p className="text-[10px] leading-relaxed text-ink-3">
                  最近收到的 agent 事件。连接后应该先看到 <span className="font-mono">hello</span>；
                  发消息后应出现 <span className="font-mono">notification:session/update</span> 与{" "}
                  <span className="font-mono">promptResult</span>。
                </p>
                <div className="mt-2 max-h-[168px] overflow-y-auto font-mono text-[9.5px] leading-relaxed text-ink-3">
                  {eventLog.length === 0 ? (
                    <div>还没有事件</div>
                  ) : (
                    eventLog.map((e, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="shrink-0 opacity-60">
                          {new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}
                        </span>
                        <span className="truncate">{e.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <p className="mt-8 text-[10px] text-ink-3">未接线版本 · 设置仅本次运行有效</p>
          </div>
        </div>
      </div>
    </div>
  );
}
