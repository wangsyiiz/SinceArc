import { useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
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
  asCmdError,
  type ModesSnapshot,
} from "@/lib/ipc";
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
}: SettingsViewProps) {
  const [active, setActive] = useState<SectionId>("chat");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const [copied, setCopied] = useState(false);

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

  /** 左侧导航只做锚点跳转：内容始终整页可见 */
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

                    {errors[p.id] && (
                      <p className="mt-2 break-all rounded-[6px] bg-danger-1/[0.09] px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-danger-1">
                        {errors[p.id]}
                      </p>
                    )}
                  </div>
                );
              })}
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
