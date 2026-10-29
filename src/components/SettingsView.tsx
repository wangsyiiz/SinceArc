import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  RefreshCw,
  Sun,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import type { MessageKey } from "@/i18n/zh-CN";
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
import { normalizeLanguage, type Language } from "@/i18n/normalize";
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
import { UpdateSection } from "@/components/UpdateSection";
import { McpDefaultPicker } from "@/components/McpDefaultPicker";
import { agentBrand } from "@/lib/agent-brands";
import { capsRows } from "@/lib/caps-format";
import { localizeText, translateKey } from "@/lib/i18n-text";
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
  /** 一轮正常结束后是否播放提示音（§31.3） */
  onChangeReplySound: (value: boolean) => void;
  /** 窗口不在前台时是否发系统通知（§31.4） */
  onChangeReplyToast: (value: boolean) => void;
  /** markdown 代码块配色（独立于界面主题） */
  onChangeCodeTheme: (value: CodeThemeId) => void;
  /** 界面语言（docs/i18n.md §2.3）：改完立即生效，同时落库 */
  onChangeLanguage: (value: Language) => void;
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

const THEMES: { id: ThemeMode; labelKey: MessageKey }[] = [
  { id: "dark", labelKey: "settings.appearance.theme.dark" },
  { id: "light", labelKey: "settings.appearance.theme.light" },
  { id: "system", labelKey: "settings.appearance.theme.system" },
];

/** 语言档位：选项名用各自语言书写（切到英文后这一行仍然可读）。 */
const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" }, // i18n-ignore: 语言名用母语显示
  { value: "en", label: "English" },
];

const DISCARD_UNSAVED_HEADING_KEY: MessageKey = "settings.connection.discard.title";
const DELETE_CONNECTION_HEADING_KEY: MessageKey = "settings.connection.delete";

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

const AUTO_APPROVE_OPTIONS: { value: AutoApproveLevel; labelKey: MessageKey }[] = [
  { value: "off", labelKey: "settings.chat.autoApprove.off" },
  { value: "edits", labelKey: "settings.chat.autoApprove.edits" },
];

const SSH_AUTH_OPTIONS: { value: SshAuth; labelKey: MessageKey }[] = [
  { value: "key", labelKey: "settings.connection.ssh.auth.key" },
  { value: "password", labelKey: "settings.connection.ssh.password.label" },
];

const ADD_PATH_OPTIONS: { value: AddPath; labelKey: MessageKey }[] = [
  { value: "manual", labelKey: "settings.connection.addMethod.manual" },
  { value: "scan", labelKey: "settings.connection.addMethod.scan" },
];

const SECTIONS = [
  { id: "connection", labelKey: "settings.sections.connection", icon: Plug },
  { id: "mcp", labelKey: "settings.sections.mcp", icon: PlugZap },
  { id: "members", labelKey: "settings.sections.members", icon: Users },
  { id: "chat", labelKey: "settings.sections.chat", icon: MessageSquare },
  { id: "appearance", labelKey: "settings.sections.appearance", icon: Palette },
  { id: "update", labelKey: "settings.sections.update", icon: RefreshCw },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const LAUNCH_LABEL: Record<LaunchKind, MessageKey> = {
  local: "settings.connection.launch.local",
  wsl: "settings.connection.launch.wsl",
  ssh: "settings.connection.launch.ssh",
};

type ProbeResult =
  | { ok: true; outcome: ProbeOutcome }
  | { ok: false; error: string };

type AddPath = "manual" | "scan";

type Draft = { profile: AgentProfile; isNew: boolean; addPath: AddPath };

function cloneProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, args: [...(profile.args ?? [])], ssh: profile.ssh ? { ...profile.ssh } : undefined };
}

function connectionTarget(profile: AgentProfile, t: TFunction): string {
  const cwd = profile.cwd?.trim();
  if (profile.launch === "ssh") {
    const host = profile.ssh?.host || t("settings.connection.target.noHost");
    const user = profile.ssh?.user || "?";
    return `${user}@${host}${cwd ? ` · ${cwd}` : ""}`;
  }
  if (profile.launch === "wsl") {
    return `${profile.distro || "WSL"}${cwd ? ` · ${cwd}` : ""}`;
  }
  return cwd || profile.program || t("settings.connection.target.unconfigured");
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
  const { t } = useTranslation();
  const current = matchPreset(profile.program, profile.args);
  const items: MenuItem[] = [
    ...AGENT_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.name,
      description: preset.requiresKey
        ? t(preset.requiresKey)
        : translateKey(t, preset.originKey, preset.originParams),
      checked: current?.id === preset.id,
      onSelect: () => onPreset(preset),
    })),
    {
      id: "custom",
      label: t("settings.connection.agent.customCommand"),
      checked: !current,
      onSelect: onCustom,
    },
  ];

  return (
    <Menu
      ariaLabel={t("settings.connection.agent.preset")}
      align="end"
      compact
      className="max-w-56 justify-between"
      trigger={
        <>
          <span className="min-w-0 truncate">
            {current?.name ?? t("settings.connection.agent.custom")}
          </span>
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
  onChangeReplySound,
  onChangeReplyToast,
  onChangeCodeTheme,
  onChangeLanguage,
  discovery = null,
  discoveryScanning = false,
  discoveryError = null,
  onScanDiscovery,
  onUseDiscovered,
}: SettingsViewProps) {
  const { t } = useTranslation();
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
        throw new Error(t("settings.connection.noSession"));
      }
    } catch (e) {
      const err = asCmdError(e);
      setErrors((prev) => ({
        ...prev,
        [profile.id]: `${err.code} ${localizeText(err.msg, t)}`,
      }));
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
      setErrors((prev) => ({
        ...prev,
        [profile.id]: `${err.code} ${localizeText(err.msg, t)}`,
      }));
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
        [profile.id]: { ok: false, error: `${err.code} ${localizeText(err.msg, t)}` },
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
      .map((row) => t(row.labelKey));
    if (labels.length === 0) return "";
    const head = labels.slice(0, 3).join(" / ");
    return labels.length > 3
      ? t("settings.connection.agent.capsMore", {
          head,
          count: labels.length - 3,
        })
      : head;
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
    if (section === "chat" || section === "appearance" || section === "mcp" || section === "update") return;
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
        [id]: t("settings.connection.mcpSaveFailed", { msg: localizeText(err.msg, t) }),
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
            {t("settings.connection.discovery.description")}
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={discoveryScanning}
            onClick={() => onScanDiscovery?.()}
          >
            {discoveryScanning
              ? t("settings.connection.discovery.scanning")
              : t("settings.connection.discovery.scan")}
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
          <p className="text-caption text-ink-3">
            {t("settings.connection.discovery.notScanned")}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            kind="empty"
            heading={t("settings.connection.discovery.emptyHeading")}
            description={t("settings.connection.discovery.emptyDescription")}
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
    const saveGateProfile = effectiveProfile(profile);
    const saveGate = canSaveConnection(probe?.ok === true, saveGateProfile);
    const missingGateFields: MessageKey[] = [];
    if (saveGateProfile.launch === "ssh") {
      if (!(saveGateProfile.ssh?.host ?? "").trim()) {
        missingGateFields.push("settings.connection.ssh.host.label");
      }
      if (!(saveGateProfile.ssh?.user ?? "").trim()) {
        missingGateFields.push("settings.connection.validation.field.user");
      }
    }
    if (!(saveGateProfile.program ?? "").trim()) {
      missingGateFields.push("settings.connection.validation.field.agentCommand");
    }
    const saveGateReason = missingGateFields.length
      ? t("ui.validation.missing", {
          fields: missingGateFields.map((key) => t(key)).join(t("ui.list.separator")),
        })
      : t("settings.connection.validation.probeRequired");
    const history = (recentPaths[profile.id] ?? []).filter(
      (path) => path !== (profile.cwd ?? ""),
    );

    return (
      <div className="mt-5 space-y-5">
        {isNew && (
          <div className="flex flex-col gap-1.5">
            <span className="text-ui font-medium text-ink-2">
              {t("settings.connection.addMethod.label")}
            </span>
            <Segmented
              ariaLabel={t("settings.connection.addMethod.label")}
              options={ADD_PATH_OPTIONS.map(({ value, labelKey }) => ({
                value,
                label: t(labelKey),
              }))}
              value={addPath}
              onChange={setDraftPath}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-caption text-ink-3">
            <StatusDot status={connected ? "connected" : "untested"} />
            {connected
              ? savedProfile?.agentName || t("statusbar.profile.statusConnected")
              : t("statusbar.profile.statusDisconnected")}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={probeBusy === profile.id}
              onClick={() => void handleProbe(effectiveProfile(profile))}
            >
              {probeBusy === profile.id
                ? t("settings.connection.action.probing")
                : t("settings.connection.action.probe")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!saveGate.ok}
              onClick={() => void saveDraft(profile)}
            >
              {t("ui.button.save")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => discardDraft()}>
              {t("ui.button.cancel")}
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
                  ? t("settings.connection.action.working")
                  : connected
                    ? t("settings.connection.action.disconnect")
                    : t("settings.connection.action.connect")}
              </Button>
            )}
          </div>
        </div>
        {(!saveGate.ok || (!isNew && draftDirty)) && (
          <div className="text-right text-caption text-ink-3">
            {!saveGate.ok && <p>{saveGateReason}</p>}
            {!isNew && draftDirty && (
              <p>{t("settings.connection.saveBeforeConnect")}</p>
            )}
          </div>
        )}

        {scanMode ? (
          renderDiscoveryPicker()
        ) : (
          <>
            <Field label={t("ui.field.name")} htmlFor={`connection-name-${profile.id}`}>
          <Input
            id={`connection-name-${profile.id}`}
            value={profile.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder={t("settings.connection.name.placeholder")}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-ui font-medium text-ink-2">
            {t("settings.connection.launch.label")}
          </span>
          <Segmented
            ariaLabel={t("settings.connection.launch.label")}
            options={(["local", "wsl", "ssh"] as LaunchKind[]).map((kind) => ({
              value: kind,
              label: t(LAUNCH_LABEL[kind]),
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
            <Field
              label={t("settings.connection.ssh.host.label")}
              htmlFor={`ssh-host-${profile.id}`}
            >
              <Input
                id={`ssh-host-${profile.id}`}
                value={ssh.host}
                placeholder={t("settings.connection.ssh.host.placeholder")}
                onChange={(e) => patchDraft({ ssh: { ...ssh, host: e.target.value } })}
                className="font-mono"
              />
            </Field>
            <Field
              label={t("settings.connection.ssh.port.label")}
              htmlFor={`ssh-port-${profile.id}`}
            >
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
            <Field
              label={t("settings.connection.ssh.user.label")}
              htmlFor={`ssh-user-${profile.id}`}
            >
              <Input
                id={`ssh-user-${profile.id}`}
                value={ssh.user}
                placeholder="root"
                onChange={(e) => patchDraft({ ssh: { ...ssh, user: e.target.value } })}
                className="font-mono"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-ui font-medium text-ink-2">
                {t("settings.connection.ssh.auth.label")}
              </span>
              <Segmented
                ariaLabel={t("settings.connection.ssh.auth.aria")}
                options={SSH_AUTH_OPTIONS.map(({ value, labelKey }) => ({
                  value,
                  label: t(labelKey),
                }))}
                value={ssh.auth}
                onChange={(auth) => patchDraft({ ssh: { ...ssh, auth } })}
              />
            </div>
            <div className="md:col-span-2">
              {ssh.auth === "key" ? (
                <Field
                  label={t("settings.connection.ssh.keyPath.label")}
                  htmlFor={`ssh-key-${profile.id}`}
                >
                  <Input
                    id={`ssh-key-${profile.id}`}
                    value={ssh.keyPath ?? ""}
                    placeholder={t("settings.connection.ssh.keyPath.placeholder")}
                    onChange={(e) =>
                      patchDraft({ ssh: { ...ssh, keyPath: e.target.value } })
                    }
                    className="font-mono"
                  />
                </Field>
              ) : (
                <Field
                  label={t("settings.connection.ssh.password.label")}
                  htmlFor={`ssh-password-${profile.id}`}
                >
                  <Input
                    id={`ssh-password-${profile.id}`}
                    type="password"
                    value={ssh.password ?? ""}
                    placeholder={t("settings.connection.ssh.password.placeholder")}
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
                aria-label={t("settings.connection.agent.commandAria")}
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
                {t("settings.connection.agent.editCommand")}
              </Button>
            )}
          </div>

          <p className="mt-1.5 text-caption text-ink-3">
            {currentPreset
              ? translateKey(t, currentPreset.originKey, currentPreset.originParams)
              : t("settings.connection.agent.commandHint")}
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
                  ? t("settings.connection.agent.probeConnected", {
                      agent: probe.outcome.agentName,
                      version: probe.outcome.agentVersion,
                      protocol: probe.outcome.protocolVersion,
                    })
                  : probe.error}
              </p>
              {probe.ok && (
                <p className="mt-0.5 break-all text-caption text-ink-3">
                  {capsRows(probe.outcome.caps).every((row) => !row.on)
                    ? t("settings.connection.agent.noCaps")
                    : describeCaps(probe.outcome.caps)}
                </p>
              )}
            </>
          )}
          {connected && (
            <p className="mt-1 text-caption text-warn-1">
              {t("settings.connection.agent.commandChanged")}
            </p>
          )}
        </div>

        <div>
          <Field
            label={t("ui.field.workingDirectory")}
            htmlFor={`connection-cwd-${profile.id}`}
          >
            <Input
              id={`connection-cwd-${profile.id}`}
              value={profile.cwd ?? ""}
              placeholder={
                profile.launch === "local"
                  ? t("settings.connection.cwd.placeholder.local")
                  : t("settings.connection.cwd.placeholder.remote")
              }
              onChange={(e) => patchDraft({ cwd: e.target.value })}
              className="font-mono"
            />
          </Field>
          <p className="mt-1.5 text-caption text-ink-3">
            {t("settings.connection.cwd.hint")}
          </p>
          {history.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-ink-3">
                {t("settings.connection.cwd.recent")}
              </span>
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
            <span className="text-ui font-medium text-ink-2">
              {t("settings.connection.defaultMode.label")}
            </span>
            <ModeSelect
              compact
              variant="connection"
              followLabel={t("settings.connection.defaultMode.follow")}
              fallbackLabel={agentDefaultLabel}
              // 跟随且没有连接默认时，按钮上显示 agent 报的当前值（规范 §5.2）
              current={profile.defaultMode ?? snapshot?.current ?? null}
              available={availableModes}
              following={profile.defaultMode == null}
              onChoose={(modeId) => patchDraft({ defaultMode: modeId })}
            />
          </div>
          {availableModes.length === 0 && (
            <p className="mt-1 text-right text-caption text-ink-3">
              {t("settings.connection.defaultMode.unavailable")}
            </p>
          )}
          <p className="mt-1 text-caption text-ink-3">
            {t("settings.connection.defaultMode.hint")}
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
                {t("settings.connection.delete")}
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
          {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
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
              {t(labelKey)}
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
                    {t("settings.back")}
                  </Button>
                  {section === "connection" && draft && (
                    <AgentLogo agent={agentOfProfile(draft.profile)} />
                  )}
                  <h1 className="text-title font-medium text-ink-1">
                    {section === "connection"
                      ? t("settings.connection.detailTitle")
                      : memberDetail?.user
                        ? t("settings.member.detailTitle")
                        : t("settings.member.newTitle")}
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
                <h1 className="text-title font-medium text-ink-1">
                  {t("app.tab.settings")}
                </h1>

                {section === "connection" && (
                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-small font-medium text-ink-2">
                        {t("settings.sections.connection")}
                      </h2>
                      <Button variant="secondary" size="sm" onClick={startNewConnection}>
                        <Plus className="size-3" />
                        {t("settings.connection.new")}
                      </Button>
                    </div>

                    {profiles.length === 0 ? (
                      <div className="mt-4">
                        <EmptyState
                          compact
                          heading={t("settings.connection.emptyHeading")}
                          description={t("settings.connection.emptyDescription")}
                          action={
                            <Button variant="secondary" size="sm" onClick={startNewConnection}>
                              <Plus className="size-3" />
                              {t("settings.connection.newAction")}
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
                                {profile.name ||
                                  profile.program ||
                                  t("settings.connection.unnamed")}
                              </span>
                              <span className="mt-0.5 block truncate font-mono text-caption text-ink-3">
                                {t(LAUNCH_LABEL[profile.launch])} ·{" "}
                                {connectionTarget(profile, t)}
                              </span>
                              <span className="mt-1 flex items-center gap-1.5 text-caption text-ink-3">
                                <StatusDot
                                  status={profile.connected ? "connected" : "untested"}
                                />
                                <span>
                                  {profile.connected
                                    ? profile.agentName || t("statusbar.profile.statusConnected")
                                    : t("statusbar.profile.statusDisconnected")}
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
                    <h2 className="text-small font-medium text-ink-2">
                      {t("settings.sections.chat")}
                    </h2>
                    <div className="mt-3 divide-y divide-line-1/50">
                      <div className="flex gap-6 py-4">
                        <div className="min-w-0 flex-1">
                          <div className="text-ui text-ink-1">
                            {t("settings.chat.context.label")}
                          </div>
                          <p className="mt-2 text-caption text-ink-3">
                            <Trans
                              i18nKey="settings.chat.context.hint"
                              components={{ span: <span className="text-ink-2" /> }}
                            />
                          </p>
                          <p className="mt-1.5 text-caption text-ink-3">
                            <Trans
                              i18nKey="settings.chat.snapshot.hint"
                              components={{ span: <span className="text-ink-2" /> }}
                            />
                          </p>
                        </div>
                        <div className="w-64 shrink-0">
                          <div className="flex items-baseline justify-between">
                            <span className="text-caption text-ink-3">
                              {t("settings.chat.count.label")}
                            </span>
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
                            <span>
                              {t("settings.chat.count.default", {
                                count: CONTEXT_MESSAGES_DEFAULT,
                              })}
                            </span>
                            <span>{CONTEXT_MESSAGES_MAX}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="text-ui text-ink-1">
                            {t("settings.chat.autoApprove.label")}
                          </div>
                          <p className="mt-1 text-caption text-ink-3">
                            {t("settings.chat.autoApprove.hint")}
                          </p>
                        </div>
                        <Segmented
                          ariaLabel={t("settings.chat.autoApprove.label")}
                          options={AUTO_APPROVE_OPTIONS.map(({ value, labelKey }) => ({
                            value,
                            label: t(labelKey),
                          }))}
                          value={settings.autoApproveDefault}
                          onChange={onChangeAutoApproveDefault}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="text-ui text-ink-1">
                            {t("settings.replySound.label")}
                          </div>
                          <p className="mt-1 text-caption text-ink-3">
                            {t("settings.replySound.hint")}
                          </p>
                        </div>
                        <Switch
                          checked={settings.replySound}
                          label={t("settings.replySound.label")}
                          onChange={onChangeReplySound}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="text-ui text-ink-1">
                            {t("settings.replyToast.label")}
                          </div>
                          <p className="mt-1 text-caption text-ink-3">
                            {t("settings.replyToast.hint")}
                          </p>
                        </div>
                        <Switch
                          checked={settings.replyToast}
                          label={t("settings.replyToast.label")}
                          onChange={onChangeReplyToast}
                        />
                      </div>
                      {heavy && (
                        <p className="flex items-start gap-1.5 border-l-2 border-warn-1 py-3 pl-3 text-caption text-warn-1">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          {t("settings.chat.heavyWarning", { count: n })}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {section === "appearance" && (
                  <div className="mt-5">
                    <h2 className="text-small font-medium text-ink-2">
                      {t("settings.sections.appearance")}
                    </h2>
                    <div className="mt-3 divide-y divide-line-1/50">
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-ui text-ink-1">
                              {t("settings.appearance.theme.label")}
                            </span>
                            <Hint
                              label={t("settings.appearance.theme.label")}
                              text={t("settings.appearance.theme.hint")}
                            />
                          </div>
                        </div>
                        <Segmented
                          ariaLabel={t("settings.appearance.theme.label")}
                          options={THEMES.map(({ id, labelKey }) => ({
                            value: id,
                            label: t(labelKey),
                            icon: THEME_ICONS[id],
                          }))}
                          value={theme}
                          onChange={onCycleTheme}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-ui text-ink-1">
                              {t("language.label")}
                            </span>
                            <Hint
                              label={t("language.label")}
                              text={t("settings.appearance.language.hint")}
                            />
                          </div>
                        </div>
                        <Segmented
                          ariaLabel={t("language.label")}
                          options={LANGUAGE_OPTIONS}
                          value={settings.language ?? normalizeLanguage(navigator.language)}
                          onChange={onChangeLanguage}
                        />
                      </div>
                      <div className="py-4">
                        <span className="text-ui text-ink-1">
                          {t("settings.appearance.codeTheme.label")}
                        </span>
                        <p className="mt-1 text-caption text-ink-3">
                          {t("settings.appearance.codeTheme.hint")}
                        </p>
                        <div className="mt-3">
                          <CodeThemePicker
                            label={t("settings.appearance.codeTheme.label")}
                            value={settings.codeTheme}
                            onChange={onChangeCodeTheme}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-ui text-ink-1">
                              {t("settings.appearance.tween.label")}
                            </span>
                            <Hint
                              label={t("settings.appearance.tween.label")}
                              text={t("settings.appearance.tween.hint")}
                            />
                          </div>
                        </div>
                        <Switch
                          checked={settings.tweenEnabled}
                          label={t("settings.appearance.tween.label")}
                          onChange={onChangeTweenEnabled}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {section === "update" && <UpdateSection />}
              </>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={discardOpen}
        title={t(DISCARD_UNSAVED_HEADING_KEY)}
        body={<p>{t("settings.connection.discard.body")}</p>}
        confirmLabel={t("settings.connection.discard.confirm")}
        cancelLabel={t("settings.connection.discard.cancel")}
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
        title={t(DELETE_CONNECTION_HEADING_KEY)}
        body={
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <Trans
                i18nKey="settings.connection.delete.body1"
                components={{ span: <span className="text-ink-1" /> }}
              />
            </li>
            <li>{t("settings.connection.delete.body2")}</li>
            <li>{t("settings.connection.delete.body3")}</li>
          </ul>
        }
        confirmLabel={t("app.delete.confirm")}
        cancelLabel={t("ui.button.cancel")}
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
