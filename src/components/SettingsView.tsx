import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Plug,
  PlugZap,
  Sun,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import type {
  AgentProfile,
  AutoApproveLevel,
  LaunchKind,
  SshAuth,
  ThemeMode,
  ThreadSettings,
} from "@/types";
import { CONTEXT_MESSAGES_DEFAULT, CONTEXT_MESSAGES_MAX } from "@/types";
import { cn } from "@/lib/utils";
import { newId } from "@/lib/ids";
import type { CodeThemeId } from "@/lib/highlight/themes";
import {
  canSaveConnection,
  createEmptyConnection,
  isProfileDirty,
} from "@/lib/connection-draft";
import {
  agentProbe,
  asCmdError,
  profileSetDefaultMcp,
  profilesSave,
  type AgentCaps,
  type AgentUser,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryOutcome,
  type ModesSnapshot,
  type ProbeOutcome,
  type ResumeOutcome,
} from "@/lib/ipc";
import {
  AGENT_PRESETS,
  joinCommand,
  matchPreset,
  splitCommand,
  type AgentPreset,
} from "@/lib/agentPresets";
import { ModeSelect } from "@/components/ModeSelect";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AgentUserDetail, AgentUsersList } from "@/components/AgentUsers";
import { AgentLogo } from "@/components/AgentLogo";
import { McpCatalogSection } from "@/components/McpCatalogSection";
import { McpDefaultPicker } from "@/components/McpDefaultPicker";
import { agentBrand } from "@/lib/agent-brands";
import { capsRows } from "@/lib/caps-format";
import { StatusDot } from "./ui/Badge";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { Hint } from "./ui/Hint";
import { useHoverCard } from "./ui/HoverCard";
import { Field, Input } from "./ui/Field";
import { Menu, type MenuItem } from "./ui/Menu";
import { CodeThemePicker } from "./ui/CodeThemePicker";
import { Segmented } from "./ui/Segmented";
import { Switch } from "./ui/Switch";

interface SettingsViewProps {
  settings: ThreadSettings;
  theme: ThemeMode;
  profiles: AgentProfile[];
  onUpdateProfile: (next: AgentProfile) => void;
  /** 连接/断开都走 App 里的那一份实现（并发去重、状态回写都在那边） */
  onConnect: (p: AgentProfile) => Promise<{
    acpSid: string | null;
    resume: ResumeOutcome | null;
  }>;
  onDisconnect: (profileId: string) => Promise<void>;
  onAddProfile: (draft?: Partial<AgentProfile>) => string;
  onRemoveProfile: (id: string) => void;
  /** 连接已经断开：App 用它清掉这个连接下待答的权限请求 */
  onDisconnected?: (profileId: string) => void;
  /** 设置页只能读到最近一次连接报上来的模式快照（可选列表 + agent 当前值） */
  modesFor: (profileId: string) => ModesSnapshot | null;
  onChangeContext: (n: number) => void;
  onCycleTheme: (t: ThemeMode) => void;
  /** 新会话默认自动同意档（客户端应答策略，不是 agent 的审批档） */
  onChangeAutoApproveDefault: (level: AutoApproveLevel) => void;
  /** 新建连接默认继承整份 MCP 目录（只影响新连接） */
  onChangeMcpInheritDefault: (value: boolean) => void;
  /** 流式回答是否按到达节奏平滑推进（只影响渲染层） */
  onChangeTweenEnabled: (value: boolean) => void;
  /** markdown 代码块配色（独立于界面主题） */
  onChangeCodeTheme: (value: CodeThemeId) => void;
  /** agent 发现（docs/discovery.md）：缓存结果、是否在扫、手动重扫 */
  discovery?: DiscoveryOutcome | null;
  discoveryScanning?: boolean;
  discoveryError?: string | null;
  onScanDiscovery?: () => void;
  /** 把发现结果组装成草稿预填值；不落库，由设置页负责建草稿并自动探测。 */
  onUseDiscovered?: (
    candidate: DiscoveryCandidate,
    hit: DiscoveryHit,
  ) => Partial<AgentProfile> | undefined;
}

const THEME_ICONS = {
  dark: <Moon />,
  light: <Sun />,
  system: <Monitor />,
} as const;

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "system", label: "跟随系统" },
];

const THEME_OPTIONS = THEMES.map((theme) => ({
  value: theme.id,
  label: theme.label,
  icon: THEME_ICONS[theme.id],
}));

const DISCARD_UNSAVED_HEADING = "放弃未保存的修改";
const DELETE_CONNECTION_HEADING = "删除连接";

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

const AUTO_APPROVE_OPTIONS = [
  { value: "off" as const, label: "关闭" },
  { value: "edits" as const, label: "编辑类" },
];

const SSH_AUTH_OPTIONS: { value: SshAuth; label: string }[] = [
  { value: "key", label: "私钥" },
  { value: "password", label: "密码" },
];

const ADD_PATH_OPTIONS: { value: AddPath; label: string }[] = [
  { value: "manual", label: "手动填写" },
  { value: "scan", label: "自动扫描" },
];

const SECTIONS = [
  { id: "connection", label: "连接", icon: Plug },
  { id: "mcp", label: "MCP", icon: PlugZap },
  { id: "members", label: "成员", icon: Users },
  { id: "chat", label: "群聊", icon: MessageSquare },
  { id: "appearance", label: "外观", icon: Palette },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const LAUNCH_LABEL: Record<LaunchKind, string> = {
  local: "本机直连",
  wsl: "WSL",
  ssh: "SSH",
};

type ProbeResult =
  | { ok: true; outcome: ProbeOutcome }
  | { ok: false; error: string };

type AddPath = "manual" | "scan";

type Draft = { profile: AgentProfile; isNew: boolean; addPath: AddPath };

function cloneProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, args: [...(profile.args ?? [])], ssh: profile.ssh ? { ...profile.ssh } : undefined };
}

function connectionTarget(profile: AgentProfile): string {
  const cwd = profile.cwd?.trim();
  if (profile.launch === "ssh") {
    const host = profile.ssh?.host || "未填主机";
    const user = profile.ssh?.user || "?";
    return `${user}@${host}${cwd ? ` · ${cwd}` : ""}`;
  }
  if (profile.launch === "wsl") {
    return `${profile.distro || "WSL"}${cwd ? ` · ${cwd}` : ""}`;
  }
  return cwd || profile.program || "未配置";
}

function agentOfProfile(profile: AgentProfile): string {
  const branded = [profile.agentName, profile.program, profile.name].find(
    (candidate): candidate is string => !!candidate && agentBrand(candidate) !== null,
  );
  return branded || profile.name || profile.program || "";
}

/** 预设选择：统一走菜单原语，不再自己维护浮层与外部点击关闭。 */
function AgentSelect({
  profile,
  onPreset,
  onCustom,
}: {
  profile: AgentProfile;
  onPreset: (preset: AgentPreset) => void;
  onCustom: () => void;
}) {
  const current = matchPreset(profile.program, profile.args);
  const items: MenuItem[] = [
    ...AGENT_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.name,
      description: preset.requires ?? preset.origin,
      checked: current?.id === preset.id,
      onSelect: () => onPreset(preset),
    })),
    {
      id: "custom",
      label: "自定义命令",
      checked: !current,
      onSelect: onCustom,
    },
  ];

  return (
    <Menu
      ariaLabel="Agent 预设"
      align="end"
      compact
      className="max-w-56 justify-between"
      trigger={
        <>
          <span className="min-w-0 truncate">{current?.name ?? "自定义"}</span>
          <ChevronDown className="size-3 shrink-0 text-ink-3" />
        </>
      }
      items={items}
    />
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
  onChangeAutoApproveDefault,
  onChangeMcpInheritDefault,
  onChangeTweenEnabled,
  onChangeCodeTheme,
  discovery = null,
  discoveryScanning = false,
  discoveryError = null,
  onScanDiscovery,
  onUseDiscovered,
}: SettingsViewProps) {
  const [section, setSection] = useState<SectionId>("connection");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const pendingDiscardRef = useRef<(() => void) | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [memberDetail, setMemberDetail] = useState<{ user: AgentUser | null } | null>(null);
  const [connectionFocus, setConnectionFocus] = useState<{ id: string; tick: number } | null>(null);
  const [memberFocus, setMemberFocus] = useState<{ id: string; tick: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 探测会真的 spawn 进程，和连接用的 busy 分开，避免互相锁住 */
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [commandDrafts, setCommandDrafts] = useState<Record<string, string>>({});
  const [commandEditing, setCommandEditing] = useState<Record<string, boolean>>({});
  const [recentPaths, setRecentPaths] = useState<Record<string, string[]>>({});
  const probeSeq = useRef<Record<string, number>>({});
  const connectionRowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const detailOpen =
    (section === "connection" && !!draft) || (section === "members" && !!memberDetail);

  const invalidateProbe = (id: string) => {
    probeSeq.current[id] = (probeSeq.current[id] ?? 0) + 1;
    setProbeResults((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setProbeBusy((current) => (current === id ? null : current));
  };

  const clearCommandDraft = (id: string) => {
    setCommandDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /** 命令输入框可能还没 blur：保存/探测都按框里的内容算。 */
  const effectiveProfile = (profile: AgentProfile): AgentProfile => {
    const raw = commandDrafts[profile.id];
    return raw !== undefined && raw.trim() ? { ...profile, ...splitCommand(raw) } : profile;
  };

  const draftEffective = draft ? effectiveProfile(draft.profile) : null;
  const draftBaseline = draft
    ? draft.isNew
      ? createEmptyConnection(draft.profile.id)
      : (profiles.find((profile) => profile.id === draft.profile.id) ?? draft.profile)
    : null;
  const draftDirty =
    draftEffective && draftBaseline ? isProfileDirty(draftEffective, draftBaseline) : false;

  const notePath = (profile: AgentProfile) => {
    const cwd = profile.cwd?.trim();
    if (!cwd) return;
    setRecentPaths((prev) => {
      const current = prev[profile.id] ?? [];
      const next = [cwd, ...current.filter((path) => path !== cwd)].slice(0, 5);
      if (next.length === current.length && next.every((path, index) => path === current[index])) {
        return prev;
      }
      return { ...prev, [profile.id]: next };
    });
  };

  const handleConnect = async (profile: AgentProfile) => {
    notePath(profile);
    setBusy(profile.id);
    setErrors((prev) => ({ ...prev, [profile.id]: "" }));
    try {
      // 连接、状态回写、会话绑定都在 useAgentConnect 里，这里只负责把错误显示出来
      const result = await onConnect(profile);
      if (result.resume?.kind === "unavailable") {
        throw { code: 50403, msg: result.resume.reason };
      }
      if (!result.acpSid) {
        throw new Error("agent 没有给出会话");
      }
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({ ...prev, [profile.id]: `${err.code} ${err.msg}` }));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async (profile: AgentProfile) => {
    setBusy(profile.id);
    setErrors((prev) => ({ ...prev, [profile.id]: "" }));
    try {
      await onDisconnect(profile.id);
      onDisconnected?.(profile.id);
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({ ...prev, [profile.id]: `${err.code} ${err.msg}` }));
    } finally {
      setBusy(null);
    }
  };

  const patchDraft = (patch: Partial<AgentProfile>) => {
    if (!draft) return;
    invalidateProbe(draft.profile.id);
    setDraft((current) =>
      current ? { ...current, profile: { ...current.profile, ...patch } } : current,
    );
  };

  const choosePreset = (preset: AgentPreset) => {
    if (!draft) return;
    const id = draft.profile.id;
    clearCommandDraft(id);
    setCommandEditing((prev) => ({ ...prev, [id]: false }));
    patchDraft({ program: preset.program, args: [...preset.args] });
  };

  const chooseCustom = () => {
    if (!draft) return;
    const id = draft.profile.id;
    clearCommandDraft(id);
    setCommandEditing((prev) => ({ ...prev, [id]: true }));
  };

  const commitCommand = () => {
    if (!draft) return;
    const profile = draft.profile;
    const raw = commandDrafts[profile.id];
    if (raw === undefined) return;
    if (!raw.trim()) {
      // 空输入不写回，保留原命令
      clearCommandDraft(profile.id);
      return;
    }
    const { program, args } = splitCommand(raw);
    const unchanged =
      program === (profile.program ?? "") &&
      args.join("\u0000") === (profile.args ?? []).join("\u0000");
    clearCommandDraft(profile.id);
    if (unchanged) return;
    patchDraft({ program, args });
  };

  const handleProbe = async (profile: AgentProfile, useCommandDraft = true) => {
    const raw = useCommandDraft ? commandDrafts[profile.id] : undefined;
    // 点探测时输入框可能还没 blur：按框里的内容探测，而不是上一次提交的值
    const target =
      raw !== undefined && raw.trim()
        ? { ...profile, ...splitCommand(raw) }
        : profile;
    invalidateProbe(profile.id);
    const seq = probeSeq.current[profile.id] ?? 0;
    notePath(target);
    setProbeBusy(profile.id);
    try {
      const outcome = await agentProbe(target);
      if (probeSeq.current[profile.id] !== seq) return;
      setProbeResults((prev) => ({ ...prev, [profile.id]: { ok: true, outcome } }));
    } catch (e) {
      if (probeSeq.current[profile.id] !== seq) return;
      const err = asCmdError(e);
      setProbeResults((prev) => ({
        ...prev,
        [profile.id]: { ok: false, error: `${err.code} ${err.msg}` },
      }));
    } finally {
      if (probeSeq.current[profile.id] === seq) {
        setProbeBusy((current) => (current === profile.id ? null : current));
      }
    }
  };

  /** 只列支持的能力；最多 3 个，避免探测结果行变成一长串。 */
  const describeCaps = (caps: AgentCaps): string => {
    const labels = capsRows(caps)
      .filter((row) => row.on)
      .map((row) => row.label);
    if (labels.length === 0) return "";
    const head = labels.slice(0, 3).join(" / ");
    return labels.length > 3
      ? ` · ${head} 等 ${labels.length - 3} 项`
      : ` · ${head}`;
  };

  const newConnectionDraft = (id: string): AgentProfile => ({
    ...createEmptyConnection(id),
    // 新连接草稿就先呈现全局开关的语义；保存时后端仍会以显式值优先。
    defaultMcp: settings.mcpInheritDefault ? null : [],
  });

  /** 发现结果的预填值由 App 组装；这里只负责合并默认值。 */
  const discoveredProfile = (
    id: string,
    candidate: DiscoveryCandidate,
    hit: DiscoveryHit,
    base?: AgentProfile,
  ): AgentProfile | null => {
    const partial = onUseDiscovered?.(candidate, hit);
    if (!partial) return null;
    return { ...(base ?? newConnectionDraft(id)), ...partial, id };
  };

  const closeDraft = useCallback(
    (after?: () => void) => {
      const current = draft;
      setDraft(null);
      if (current) {
        invalidateProbe(current.profile.id);
        clearCommandDraft(current.profile.id);
        setCommandEditing((prev) => ({ ...prev, [current.profile.id]: false }));
        setConnectionId(current.isNew ? null : current.profile.id);
        const focusId = current.isNew ? profiles[0]?.id : current.profile.id;
        if (focusId) setConnectionFocus({ id: focusId, tick: Date.now() });
      }
      after?.();
    },
    [draft, profiles],
  );

  const discardDraft = useCallback(
    (after?: () => void) => {
      if (!draft) {
        after?.();
        return;
      }
      if (draftDirty) {
        pendingDiscardRef.current = after ?? null;
        setDiscardOpen(true);
        return;
      }
      closeDraft(after);
    },
    [closeDraft, draft, draftDirty],
  );

  const switchSection = (next: SectionId) => {
    const apply = () => {
      setSection(next);
      setConnectionId(null);
      setMemberDetail(null);
      setConnectionFocus(null);
      setMemberFocus(null);
    };
    if (draft) {
      discardDraft(apply);
      return;
    }
    apply();
  };

  const backToList = useCallback(() => {
    if (draft) {
      discardDraft();
      return;
    }
    if (memberDetail) {
      setMemberDetail(null);
      setMemberFocus({ id: memberDetail.user?.id ?? "", tick: Date.now() });
    }
  }, [discardDraft, draft, memberDetail]);

  useEffect(() => {
    if (section === "connection" && !draft) return;
    if (section === "members" && !memberDetail) return;
    if (section === "chat" || section === "appearance" || section === "mcp") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"]') || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      backToList();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [backToList, draft, memberDetail, section]);

  useEffect(() => {
    if (!connectionFocus || draft) return;
    const target =
      connectionRowRefs.current[connectionFocus.id] ??
      profiles.map((profile) => connectionRowRefs.current[profile.id]).find(Boolean);
    target?.focus();
    setConnectionFocus(null);
  }, [connectionFocus, draft, profiles]);

  useEffect(() => {
    if (!connectionId) return;
    if (profiles.some((profile) => profile.id === connectionId)) return;
    setConnectionId(null);
  }, [connectionId, profiles]);

  const startNewConnection = () => {
    const id = newId("p-draft");
    invalidateProbe(id);
    setDraft({ profile: newConnectionDraft(id), isNew: true, addPath: "manual" });
    setConnectionId(null);
  };

  const openConnection = (profile: AgentProfile) => {
    invalidateProbe(profile.id);
    clearCommandDraft(profile.id);
    setCommandEditing((prev) => ({ ...prev, [profile.id]: false }));
    setDraft({ profile: cloneProfile(profile), isNew: false, addPath: "manual" });
    setConnectionId(profile.id);
  };

  const setDraftPath = (next: AddPath) => {
    setDraft((current) =>
      current && current.isNew ? { ...current, addPath: next } : current,
    );
  };

  const startDiscoveredDraft = (candidate: DiscoveryCandidate, hit: DiscoveryHit) => {
    const id = draft?.profile.id ?? newId("p-draft");
    const profile = discoveredProfile(id, candidate, hit, draft?.profile);
    if (!profile) return;
    invalidateProbe(id);
    clearCommandDraft(id);
    setCommandEditing((prev) => ({ ...prev, [id]: false }));
    setDraft({ profile, isNew: true, addPath: "manual" });
    setConnectionId(null);
    // 扫描结果已经写进 profile；不能让它被手动档未提交的命令草稿覆盖。
    void handleProbe(profile, false);
  };

  const saveDraft = async (profile: AgentProfile) => {
    if (!draft) return;
    const effective = effectiveProfile(profile);
    const gate = canSaveConnection(probeResults[effective.id]?.ok === true, effective);
    if (!gate.ok) return;
    const isNew = draft.isNew;
    // 新连接未显式选名单时，按全局开关决定落库初值；已有连接保持自己的选择。
    const defaultMcp =
      isNew && effective.defaultMcp == null
        ? settings.mcpInheritDefault
          ? null
          : []
        : (effective.defaultMcp ?? null);
    const saved = isNew ? { ...effective, defaultMcp } : effective;
    const id = isNew ? onAddProfile(saved) : saved.id;
    try {
      // 新连接先落库，profile_set_default_mcp 才能 UPDATE 到这一行。
      if (isNew) await profilesSave([...profiles, saved]);
      await profileSetDefaultMcp(id, defaultMcp);
      if (!isNew) onUpdateProfile(saved);
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({
        ...prev,
        [id]: `保存默认 MCP 服务器失败：${err.msg}`,
      }));
      if (isNew) {
        setDraft({ profile: { ...effective, id }, isNew: false, addPath: "manual" });
        setConnectionId(id);
      }
      return;
    }
    setConnectionId(id);
    setConnectionFocus({ id, tick: Date.now() });
    invalidateProbe(id);
    clearCommandDraft(id);
    setCommandEditing((prev) => ({ ...prev, [id]: false }));
    setDraft(null);
  };

  const renderDiscoveryPicker = () => {
    const rows = discovery
      ? discovery.candidates.flatMap((candidate) =>
          discovery.found
            .filter((hit) => hit.candidateId === candidate.id)
            .map((hit) => ({ candidate, hit })),
        )
      : [];

    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-ui text-ink-2">
            扫描本机已安装的 ACP agent，点一条直接填入当前草稿。
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={discoveryScanning}
            onClick={() => onScanDiscovery?.()}
          >
            {discoveryScanning ? "扫描中…" : "扫描本机"}
          </Button>
        </div>

        {discoveryError && (
          <p className="break-all text-caption text-danger-1">{discoveryError}</p>
        )}
        {discovery?.warnings.map((warning) => (
          <p key={warning} className="break-all font-mono text-caption text-warn-1">
            {warning}
          </p>
        ))}

        {!discovery ? (
          <p className="text-caption text-ink-3">还没扫描过</p>
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            kind="empty"
            heading="没找到能跑 ACP 的 agent"
            description="也可以手动填写启动命令"
          />
        ) : (
          <div className="divide-y divide-line-1/50">
            {rows.map(({ candidate, hit }) => (
              <button
                key={`${candidate.id}@${hit.host}@${hit.path}`}
                type="button"
                onClick={() => startDiscoveredDraft(candidate, hit)}
                className="flex w-full flex-col gap-1 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-ui font-medium text-ink-1">{candidate.name}</span>
                  <span className="text-caption text-ink-3">{candidate.note}</span>
                  <span className="ml-auto shrink-0 font-mono text-caption text-ink-2">
                    {hit.host}
                  </span>
                </span>
                <LongTextHover
                  text={hit.path}
                  disabled={hit.path.length <= 24}
                  className="truncate font-mono text-caption text-ink-3"
                >
                  {hit.path}
                </LongTextHover>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const n = settings.contextMessages;
  const heavy = n > 10;

  const renderConnectionDetail = (profile: AgentProfile) => {
    const ssh = profile.ssh;
    const isNew = draft?.isNew ?? false;
    const addPath = draft?.addPath ?? "manual";
    const scanMode = isNew && addPath === "scan";
    const savedProfile = isNew
      ? null
      : (profiles.find((item) => item.id === profile.id) ?? null);
    const connected = savedProfile?.connected ?? false;
    const snapshot = modesFor(profile.id);
    const availableModes = snapshot?.available ?? [];
    // snapshot.current 是 session/new 那一刻 agent 自己的值（那时我们还没推值），
    // 正好就是「不指定」时实际会生效的模式
    const agentDefault = availableModes.find((mode) => mode.id === snapshot?.current);
    const agentDefaultLabel = agentDefault?.name ?? snapshot?.current ?? null;
    const currentPreset = matchPreset(profile.program, profile.args);
    const command = commandDrafts[profile.id] ?? joinCommand(profile.program, profile.args);
    const showCommand = currentPreset === null || commandEditing[profile.id];
    const probe = probeResults[profile.id];
    const saveGate = canSaveConnection(probe?.ok === true, effectiveProfile(profile));
    const history = (recentPaths[profile.id] ?? []).filter(
      (path) => path !== (profile.cwd ?? ""),
    );

    return (
      <div className="mt-5 space-y-5">
        {isNew && (
          <div className="flex flex-col gap-1.5">
            <span className="text-ui font-medium text-ink-2">添加方式</span>
            <Segmented
              ariaLabel="添加方式"
              options={ADD_PATH_OPTIONS}
              value={addPath}
              onChange={setDraftPath}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-caption text-ink-3">
            <StatusDot status={connected ? "connected" : "untested"} />
            {connected ? savedProfile?.agentName || "已连接" : "未连接"}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={probeBusy === profile.id}
              onClick={() => void handleProbe(effectiveProfile(profile))}
            >
              {probeBusy === profile.id ? "探测中…" : "探测"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!saveGate.ok}
              onClick={() => void saveDraft(profile)}
            >
              保存
            </Button>
            <Button variant="ghost" size="sm" onClick={() => discardDraft()}>
              取消
            </Button>
            {!isNew && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === profile.id || draftDirty}
                onClick={() =>
                  connected
                    ? void handleDisconnect(profile)
                    : void handleConnect(profile)
                }
              >
                {busy === profile.id
                  ? "处理中…"
                  : connected
                    ? "断开"
                    : "连接"}
              </Button>
            )}
          </div>
        </div>
        {(!saveGate.ok || (!isNew && draftDirty)) && (
          <div className="text-right text-caption text-ink-3">
            {!saveGate.ok && <p>{saveGate.reason}</p>}
            {!isNew && draftDirty && <p>先保存再连接</p>}
          </div>
        )}

        {scanMode ? (
          renderDiscoveryPicker()
        ) : (
          <>
            <Field label="名称" htmlFor={`connection-name-${profile.id}`}>
          <Input
            id={`connection-name-${profile.id}`}
            value={profile.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder="留空时按命令与位置自动命名"
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-ui font-medium text-ink-2">启动方式</span>
          <Segmented
            ariaLabel="启动方式"
            options={(["local", "wsl", "ssh"] as LaunchKind[]).map((kind) => ({
              value: kind,
              label: LAUNCH_LABEL[kind],
            }))}
            value={profile.launch}
            onChange={(kind) =>
              patchDraft({
                launch: kind,
                ssh:
                  kind === "ssh"
                    ? (profile.ssh ?? { host: "", port: 22, user: "", auth: "key" })
                    : profile.ssh,
              })
            }
          />
        </div>

        {profile.launch === "ssh" && ssh && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="主机" htmlFor={`ssh-host-${profile.id}`}>
              <Input
                id={`ssh-host-${profile.id}`}
                value={ssh.host}
                placeholder="47.109.56.213 或 ~/.ssh/config 的别名"
                onChange={(e) => patchDraft({ ssh: { ...ssh, host: e.target.value } })}
                className="font-mono"
              />
            </Field>
            <Field label="端口" htmlFor={`ssh-port-${profile.id}`}>
              <Input
                id={`ssh-port-${profile.id}`}
                value={String(ssh.port)}
                inputMode="numeric"
                onChange={(e) =>
                  patchDraft({ ssh: { ...ssh, port: Number(e.target.value) || 22 } })
                }
                className="font-mono"
              />
            </Field>
            <Field label="账号" htmlFor={`ssh-user-${profile.id}`}>
              <Input
                id={`ssh-user-${profile.id}`}
                value={ssh.user}
                placeholder="root"
                onChange={(e) => patchDraft({ ssh: { ...ssh, user: e.target.value } })}
                className="font-mono"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-ui font-medium text-ink-2">认证</span>
              <Segmented
                ariaLabel="SSH 认证方式"
                options={SSH_AUTH_OPTIONS}
                value={ssh.auth}
                onChange={(auth) => patchDraft({ ssh: { ...ssh, auth } })}
              />
            </div>
            <div className="md:col-span-2">
              {ssh.auth === "key" ? (
                <Field label="私钥路径" htmlFor={`ssh-key-${profile.id}`}>
                  <Input
                    id={`ssh-key-${profile.id}`}
                    value={ssh.keyPath ?? ""}
                    placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                    onChange={(e) =>
                      patchDraft({ ssh: { ...ssh, keyPath: e.target.value } })
                    }
                    className="font-mono"
                  />
                </Field>
              ) : (
                <Field label="密码" htmlFor={`ssh-password-${profile.id}`}>
                  <Input
                    id={`ssh-password-${profile.id}`}
                    type="password"
                    value={ssh.password ?? ""}
                    placeholder="仅本次运行有效，不落盘"
                    onChange={(e) =>
                      patchDraft({ ssh: { ...ssh, password: e.target.value } })
                    }
                  />
                </Field>
              )}
            </div>
          </div>
        )}

        <div className="border-t border-line-1/50 pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ui font-medium text-ink-2">Agent</span>
            <AgentSelect
              profile={profile}
              onPreset={(preset) => choosePreset(preset)}
              onCustom={() => chooseCustom()}
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            {showCommand ? (
              <Input
                aria-label="Agent 命令"
                spellCheck={false}
                value={command}
                placeholder="npx -y @google/gemini-cli@0.65.0 --acp"
                onChange={(e) => {
                  invalidateProbe(profile.id);
                  setCommandDrafts((prev) => ({ ...prev, [profile.id]: e.target.value }))
                }}
                onBlur={() => commitCommand()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                className="min-w-0 flex-1 font-mono"
              />
            ) : (
              <LongTextHover
                text={command}
                disabled={command.length <= 24}
                className="min-w-0 flex-1 truncate font-mono text-caption text-ink-3"
              >
                <code>{command}</code>
              </LongTextHover>
            )}
            {!showCommand && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCommandEditing((prev) => ({ ...prev, [profile.id]: true }))}
              >
                编辑命令
              </Button>
            )}
          </div>

          <p className="mt-1.5 text-caption text-ink-3">
            {currentPreset
              ? currentPreset.origin
              : "命令里可以带参数；确认能起 ACP 就用右边的探测"}
          </p>
          {probe && (
            <>
              <p
                className={cn(
                  "mt-1 break-all font-mono text-caption",
                  probe.ok ? "text-ok-1" : "text-danger-1",
                )}
              >
                {probe.ok
                  ? `已连接 ${probe.outcome.agentName} ${probe.outcome.agentVersion} · 协议 v${probe.outcome.protocolVersion}`
                  : probe.error}
              </p>
              {probe.ok && (
                <p className="mt-0.5 break-all text-caption text-ink-3">
                  {capsRows(probe.outcome.caps).every((row) => !row.on)
                    ? "这个 agent 没报任何可选能力"
                    : describeCaps(probe.outcome.caps).replace(" · ", "")}
                </p>
              )}
            </>
          )}
          {connected && (
            <p className="mt-1 text-caption text-warn-1">
              改了 agent 命令需要重新连接才会生效
            </p>
          )}
        </div>

        <div>
          <Field label="工作目录" htmlFor={`connection-cwd-${profile.id}`}>
            <Input
              id={`connection-cwd-${profile.id}`}
              value={profile.cwd ?? ""}
              placeholder={
                profile.launch === "local"
                  ? "C:\\source\\your-project"
                  : "/mnt/c/source/your-project"
              }
              onChange={(e) => patchDraft({ cwd: e.target.value })}
              className="font-mono"
            />
          </Field>
          <p className="mt-1.5 text-caption text-ink-3">
            这个路径必须存在于 agent 那一侧：WSL 与 SSH 要 Linux 路径，本机要 Windows
            路径。填错了 agent 起不来（wsl 会报 chdir failed）。
          </p>
          {history.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-ink-3">最近使用</span>
              {history.map((path) => (
                <LongTextHover
                  key={path}
                  text={path}
                  disabled={path.length <= 24}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-w-60"
                    onClick={() => patchDraft({ cwd: path })}
                  >
                    <span className="truncate font-mono text-caption">{path}</span>
                  </Button>
                </LongTextHover>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ui font-medium text-ink-2">默认文件编辑审批</span>
            <ModeSelect
              compact
              variant="connection"
              followLabel="跟随 Agent"
              fallbackLabel={agentDefaultLabel}
              // 跟随且没有连接默认时，按钮上显示 agent 报的当前值（规范 §5.2）
              current={profile.defaultMode ?? snapshot?.current ?? null}
              available={availableModes}
              following={profile.defaultMode == null}
              onChoose={(modeId) => patchDraft({ defaultMode: modeId })}
            />
          </div>
          {availableModes.length === 0 && (
            <p className="mt-1 text-right text-caption text-ink-3">连接一次之后才能选</p>
          )}
          <p className="mt-1 text-caption text-ink-3">
            每次打开会话都会按这里重新应用；agent 在会话内自己切走的模式，重开后回到这里的设置。
          </p>
        </div>

        <McpDefaultPicker
          value={profile.defaultMcp ?? null}
          onChange={(defaultMcp) => patchDraft({ defaultMcp })}
        />

        {errors[profile.id] && (
          <p className="break-all rounded-control bg-danger-1/10 px-2.5 py-2 font-mono text-caption text-danger-1">
            {errors[profile.id]}
          </p>
        )}

            <div className="border-t border-line-1/50 pt-4">
              <Button
                variant="ghost"
                size="sm"
                danger
                onClick={() => setConfirmDeleteId(profile.id)}
              >
                <Trash2 className="size-3" />
                删除连接
              </Button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 justify-center">
      <div className="flex min-h-0 w-full max-w-3xl">
        <nav className="w-40 shrink-0 px-2 py-6">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => switchSection(id)}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-small transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
                section === id
                  ? "sc-row-active text-ink-1"
                  : "text-ink-2 hover:bg-surface-3",
              )}
            >
              <Icon className="size-3.5 shrink-0 text-ink-3" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-6 py-6">
            {detailOpen ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2"
                    onClick={backToList}
                  >
                    <ArrowLeft className="size-3.5" />
                    返回
                  </Button>
                  {section === "connection" && draft && (
                    <AgentLogo agent={agentOfProfile(draft.profile)} />
                  )}
                  <h1 className="text-title font-medium text-ink-1">
                    {section === "connection"
                      ? "连接详情"
                      : memberDetail?.user
                        ? "成员详情"
                        : "新建成员"}
                  </h1>
                </div>

                {section === "connection" && draft && renderConnectionDetail(draft.profile)}
                {section === "members" && memberDetail && (
                  <AgentUserDetail
                    key={memberDetail.user?.id ?? "new"}
                    profiles={profiles}
                    user={memberDetail.user}
                    ensureConnected={async (profile) => {
                      // 复用设置页那条连接路径（连接生命周期、状态回写都在 useAgentConnect 里）
                      await onConnect(profile);
                    }}
                    onSaved={(id) => {
                      setMemberDetail(null);
                      setMemberFocus({ id, tick: Date.now() });
                    }}
                  />
                )}
              </>
            ) : (
              <>
                <h1 className="text-title font-medium text-ink-1">设置</h1>

                {section === "connection" && (
                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-small font-medium text-ink-2">连接</h2>
                      <Button variant="secondary" size="sm" onClick={startNewConnection}>
                        <Plus className="size-3" />
                        新建
                      </Button>
                    </div>

                    {profiles.length === 0 ? (
                      <div className="mt-4">
                        <EmptyState
                          compact
                          heading="还没有连接配置"
                          description="新建一个连接，填好 agent 命令与工作目录。"
                          action={
                            <Button variant="secondary" size="sm" onClick={startNewConnection}>
                              <Plus className="size-3" />
                              新建连接
                            </Button>
                          }
                        />
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {profiles.map((profile) => (
                          <button
                            key={profile.id}
                            ref={(el) => {
                              connectionRowRefs.current[profile.id] = el;
                            }}
                            type="button"
                            onClick={() => openConnection(profile)}
                            className="flex w-full items-center gap-3 rounded-card border border-line-1/70 bg-surface-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                          >
                            <AgentLogo agent={agentOfProfile(profile)} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ui font-medium text-ink-1">
                                {profile.name || profile.program || "未命名连接"}
                              </span>
                              <span className="mt-0.5 block truncate font-mono text-caption text-ink-3">
                                {LAUNCH_LABEL[profile.launch]} · {connectionTarget(profile)}
                              </span>
                              <span className="mt-1 flex items-center gap-1.5 text-caption text-ink-3">
                                <StatusDot
                                  status={profile.connected ? "connected" : "untested"}
                                />
                                <span>
                                  {profile.connected
                                    ? profile.agentName || "已连接"
                                    : "未连接"}
                                </span>
                              </span>
                            </span>
                            <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {section === "members" && (
                  <div className="mt-5">
                    <AgentUsersList
                      profiles={profiles}
                      focus={memberFocus}
                      onOpen={(user) => setMemberDetail({ user })}
                    />
                  </div>
                )}

                {section === "mcp" && (
                  <McpCatalogSection
                    inheritDefault={settings.mcpInheritDefault}
                    onInheritDefaultChange={onChangeMcpInheritDefault}
                  />
                )}

                {section === "chat" && (
                  <div className="mt-5">
                    <h2 className="text-small font-medium text-ink-2">群聊</h2>
                    <div className="mt-3 divide-y divide-line-1/50">
                      <div className="flex gap-6 py-4">
                        <div className="min-w-0 flex-1">
                          <div className="text-ui text-ink-1">
                            @ 玩家时附带最近几条记录
                          </div>
                          <p className="mt-2 text-caption text-ink-3">
                            只附带<span className="text-ink-2">其他成员</span>的发言。你自己的历史已经在
                            session 里，重复带进去等于双份上下文。
                          </p>
                          <p className="mt-1.5 text-caption text-ink-3">
                            这是<span className="text-ink-2">本轮开始前</span>
                            的快照：并行时，A 看不到 B 在这一轮里刚说的话。
                          </p>
                        </div>
                        <div className="w-64 shrink-0">
                          <div className="flex items-baseline justify-between">
                            <span className="text-caption text-ink-3">条数</span>
                            <span className="font-mono text-ui tabular-nums text-accent-1">
                              {n}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={CONTEXT_MESSAGES_MAX}
                            step={1}
                            value={n}
                            onChange={(e) => onChangeContext(Number(e.target.value))}
                            style={{ accentColor: "var(--a1)" }}
                            className="mt-3 h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
                          />
                          <div className="mt-1 flex justify-between font-mono text-micro text-ink-3">
                            <span>0</span>
                            <span>默认 {CONTEXT_MESSAGES_DEFAULT}</span>
                            <span>{CONTEXT_MESSAGES_MAX}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="text-ui text-ink-1">新会话默认自动同意</div>
                          <p className="mt-1 text-caption text-ink-3">
                            agent 发来审批请求时替你答的方式，只管编辑类（改文件 / 删除 / 移动）；
                            命令与读取始终交给你。agent 自己的审批档已经不问的情况下，这一档不起作用。
                          </p>
                        </div>
                        <Segmented
                          ariaLabel="新会话默认自动同意"
                          options={AUTO_APPROVE_OPTIONS}
                          value={settings.autoApproveDefault}
                          onChange={onChangeAutoApproveDefault}
                        />
                      </div>
                      {heavy && (
                        <p className="flex items-start gap-1.5 border-l-2 border-warn-1 py-3 pl-3 text-caption text-warn-1">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          {n} 条会明显推高每次请求的输入 token；并行时还要乘以被 @ 的人数。
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {section === "appearance" && (
                  <div className="mt-5">
                    <h2 className="text-small font-medium text-ink-2">外观</h2>
                    <div className="mt-3 divide-y divide-line-1/50">
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-ui text-ink-1">主题</span>
                            <Hint
                              label="主题"
                              text="暗色靠内边缘高光分界，浅色靠 1px 边框分界。"
                            />
                          </div>
                        </div>
                        <Segmented
                          ariaLabel="主题"
                          options={THEME_OPTIONS}
                          value={theme}
                          onChange={onCycleTheme}
                        />
                      </div>
                      <div className="py-4">
                        <span className="text-ui text-ink-1">代码配色</span>
                        <p className="mt-1 text-caption text-ink-3">
                          代码配色独立于界面主题；只作用于代码（代码块与行内 code）。缩略图用的是该主题的真实配色。
                        </p>
                        <div className="mt-3">
                          <CodeThemePicker
                            label="代码配色"
                            value={settings.codeTheme}
                            onChange={onChangeCodeTheme}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-ui text-ink-1">流式补间</span>
                            <Hint
                              label="流式补间"
                              text="agent 回答按到达节奏平滑推进；关掉后与改前一致。"
                            />
                          </div>
                        </div>
                        <Switch
                          checked={settings.tweenEnabled}
                          label="流式补间"
                          onChange={onChangeTweenEnabled}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={discardOpen}
        title={DISCARD_UNSAVED_HEADING}
        body={<p>这些改动没有保存，放弃后就没了。</p>}
        confirmLabel="放弃"
        cancelLabel="继续编辑"
        onConfirm={() => {
          const after = pendingDiscardRef.current;
          pendingDiscardRef.current = null;
          setDiscardOpen(false);
          closeDraft(after ?? undefined);
        }}
        onCancel={() => {
          pendingDiscardRef.current = null;
          setDiscardOpen(false);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={DELETE_CONNECTION_HEADING}
        body={
          <ul className="list-disc space-y-0.5 pl-4">
            <li>只删这一条连接配置，<span className="text-ink-1">不会</span>删除任何会话与历史消息；</li>
            <li>如果它正在连接中，会先断开；</li>
            <li>删除后无法恢复，需要重新填一遍主机与认证。</li>
          </ul>
        }
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {
          if (!confirmDeleteId) return;
          setConnectionFocus({ id: confirmDeleteId, tick: Date.now() });
          onRemoveProfile(confirmDeleteId);
          setConfirmDeleteId(null);
          setConnectionId(null);
          // 删掉的那条可能正开着（draft 是它的副本），不清掉会留下一个指向已删 id 的详情
          setDraft(null);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
