import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Paperclip, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentProfile, Player } from "@/types";
import type { AutoApproveLevel } from "@/lib/auto-approve";
import { permissionKindKey } from "@/lib/permission-kind";
import { cn } from "@/lib/utils";
import { localizeText } from "@/lib/i18n-text";
import { Button } from "./ui/Button";
import { Menu, type MenuItem } from "./ui/Menu";
import { SessionMcpButton } from "./SessionMcpMenu";
import { SlashMenu } from "./SlashMenu";
import { Tooltip } from "./ui/Tooltip";
import { filterCommands, slashQuery, type SlashCommand } from "@/lib/slash-filter";
import { steerUnavailableReason, type SteerGate } from "@/lib/steer-availability";
import type { CommandDto } from "@/lib/ipc/types.gen/CommandDto";

interface ComposerProps {
  busy: boolean;
  onSend: (text: string) => void;
  /** 忙碌时发送键切成插话；文本不含 `/steer ` 前缀。 */
  onSteer?: (text: string) => void | Promise<void>;
  /** 插话入口三态：off=没声明 steer / waiting=还没见过正文分组 / on=可插 */
  steerGate?: SteerGate;
  commands?: CommandDto[];
  onStop: () => void;
  placeholder?: string;
  players?: Player[];
  autoApprove?: AutoApproveLevel;
  /** agent 档为 accept_edits / dont_ask：客户端这道闸被覆盖 */
  autoApproveCovered?: boolean;
  onAutoApproveChange?: (level: AutoApproveLevel) => void;
  /** 当前轮已放行的 kind；有值时才显示可撤销 chip */
  turnPolicyKinds?: string[];
  onRevokeTurnPolicy?: () => void;
  /** 当前界面会话；没有会话时不渲染 MCP 入口 */
  sessionId?: string | null;
  sessionProfile?: AgentProfile;
  /** 会话名单减少后的显式重连 */
  onReconnectMcp?: () => Promise<void>;
}

export function Composer({
  busy,
  onSend,
  onSteer,
  steerGate = "off",
  commands = [],
  onStop,
  placeholder,
  players = [],
  autoApprove = "off",
  autoApproveCovered = false,
  onAutoApproveChange,
  turnPolicyKinds = [],
  onRevokeTurnPolicy,
  sessionId,
  sessionProfile,
  onReconnectMcp,
}: ComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const inputBoxRef = useRef<HTMLDivElement>(null);
  /**
   * @ 补全（docs/group-chat.md §3）：只列**本群成员**。
   * 候选来自 players（App 传进来的就是当前会话的成员），所以「没拉进群的人」不会出现在这里 ——
   * 与投递规则一致：能 @ 到的，就是能投到的。
   */
  const [mention, setMention] = useState<{ start: number; caret: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(0);

  const candidates = mention
    ? players.filter((p) => p.handle.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];

  /**
   * 从「光标前那一段」判断是不是正在敲 @handle。
   *
   * 不用字符集正则取 handle：短名可能有中文（如 `hermes-测试2`），`\w` 只认 ASCII，
   * 会把 `@hermes-测` 截成 `@hermes-`，候选看起来匹配、点下去却插错东西。
   * 这里只判断「@ 在哪、后面还是不是同一个词」，查询串按原样截取。
   */
  const syncMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const idx = before.lastIndexOf("@");
    if (idx < 0) {
      setMention(null);
      return;
    }
    // @ 必须在行首或空白之后：邮箱里的 @ 不该触发（john@example.com）
    if (idx > 0 && !/\s/.test(before[idx - 1])) {
      setMention(null);
      return;
    }
    const query = before.slice(idx + 1);
    // 中间出现空白 → 这个词已经敲完了，不再补全
    if (/\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ start: idx, caret, query });
    setActive(0);
  };

  const pick = (handle: string) => {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${handle} ${value.slice(mention.caret)}`;
    setValue(next);
    setMention(null);
    // 光标落在插入内容之后
    const pos = mention.start + handle.length + 2;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const syncSlash = (text: string) => {
    const query = slashQuery(text);
    const slashAt = text.indexOf("/");
    const afterSlash = slashAt >= 0 ? text.slice(slashAt + 1) : "";
    const eligible = query !== null && commands.length > 0 && !/\s/.test(afterSlash);
    setSlashOpen(eligible);
    if (eligible) setSlashActive(0);
  };

  const pickSlash = (command: SlashCommand) => {
    const next = command.hint ? `/${command.name}` : `/${command.name} `;
    setValue(next);
    setSlashOpen(false);
    setMention(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;
  const slashItems = slashOpen ? filterCommands(value, commands) : [];
  const slashVisible = slashOpen && slashItems.length > 0;
  const canSteerSend = busy && steerGate === "on" && value.trim().length > 0;
  const steerReasonKey = steerUnavailableReason(steerGate);
  const steerReason = steerReasonKey ? t(steerReasonKey) : null;

  /**
   * 档位选择器（docs/desktop-ux.md §10）：
   * - 收起态只显示「当前是哪一档」——它是个很少动的安全设置，不该在工具条里占一排按钮；
   * - 展开后每档带一行说明，这是唯一能讲清「这一档替你放行什么」的地方；
   * - 将来加「执行命令」档只加一行菜单项，不用换控件。
   */
  const autoApproveItems: MenuItem[] = [
    {
      id: "off",
      label: t("composer.autoApprove.off"),
      checked: autoApprove === "off",
      description: t("composer.autoApprove.offDescription"),
      onSelect: () => onAutoApproveChange?.("off"),
    },
    {
      id: "edits",
      label: t("settings.chat.autoApprove.edits"),
      checked: autoApprove === "edits",
      description: t("composer.autoApprove.editsDescription"),
      onSelect: () => onAutoApproveChange?.("edits"),
    },
  ];
  const autoApproveText =
    autoApprove === "edits" ? t("settings.chat.autoApprove.edits") : t("composer.autoApprove.off");

  const submit = () => {
    if (busy) {
      if (!canSteerSend) return;
      void onSteer?.(value.trim());
      setValue("");
      setMention(null);
      setSlashOpen(false);
      return;
    }
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
    setMention(null);
    setSlashOpen(false);
  };

  return (
    <>
      <div className="relative">
      <SlashMenu
        open={slashVisible}
        value={value}
        commands={commands}
        active={slashActive}
        onActiveChange={setSlashActive}
        onPick={pickSlash}
        onClose={() => setSlashOpen(false)}
      />
      {mention && (
        <div className="sc-glass absolute bottom-full left-2 z-30 mb-1.5 w-64 rounded-control p-1">
          {candidates.length > 0 ? (
            candidates.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => {
                  // 用 mousedown：click 之前 textarea 会先失焦，光标位置就丢了
                  e.preventDefault();
                  pick(p.handle);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-mark px-2 py-1 text-left transition-colors",
                  i === active ? "bg-surface-3/60" : "hover:bg-surface-3/45",
                )}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span className="shrink-0 text-caption text-ink-1">
                  {localizeText(p.name, t)}
                </span>
                <span className="shrink-0 font-mono text-micro text-ink-3">@{p.handle}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-micro leading-relaxed text-ink-3">
              {players.length === 0
                ? t("composer.mention.emptyGroup")
                : t("composer.mention.noMatch", { query: mention.query })}
            </p>
          )}
        </div>
      )}
      <div
      ref={inputBoxRef}
      className={cn(
        "sc-glass rounded-card transition-colors focus-within:border-accent-1",
        busy && "border-accent-1/25",
      )}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        spellCheck={false}
        placeholder={placeholder ?? t("composer.placeholder")}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          syncMention(next, e.target.selectionStart ?? 0);
          syncSlash(next);
        }}
        onClick={(e) => syncMention(value, e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (slashVisible) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSlashActive((i) => (i + 1) % slashItems.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSlashActive((i) => (i - 1 + slashItems.length) % slashItems.length);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pickSlash(slashItems[Math.min(slashActive, slashItems.length - 1)]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setSlashOpen(false);
              return;
            }
          }
          // 补全列表开着的时候，方向键/回车/Tab 归它用
          if (mention && candidates.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % candidates.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + candidates.length) % candidates.length);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pick(candidates[Math.min(active, candidates.length - 1)].handle);
              return;
            }
          }
          if (e.key === "Escape" && mention) {
            e.preventDefault();
            setMention(null);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            // 中文输入法组合期间不要发送
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            submit();
          }
        }}
        className="sc-selectable max-h-50 w-full resize-none bg-transparent px-3.5 pt-3 pb-0.5 text-ui leading-relaxed text-ink-1 focus-visible:outline-0 placeholder:text-ink-3"
      />
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Tooltip label={t("ui.button.addAttachment")}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("ui.button.addAttachment")}
            className="size-7 gap-0 p-0"
          >
            <Paperclip className="size-3.5" />
          </Button>
        </Tooltip>
        <span className="ml-0.5 font-mono text-micro text-ink-3">
          {busy ? t("composer.agentOutput") : "ACP · stdio"}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {sessionId && (
            <SessionMcpButton
              sessionId={sessionId}
              profile={sessionProfile}
              onReconnect={onReconnectMcp ?? (() => Promise.resolve())}
              avoidRef={inputBoxRef}
            />
          )}
          {turnPolicyKinds.length > 0 && onRevokeTurnPolicy && (
            <Tooltip label={t("composer.revoke")}>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-caption text-ink-2 transition-colors hover:bg-surface-3"
                onClick={onRevokeTurnPolicy}
              >
                {t("composer.turnPolicy", {
                  kinds: turnPolicyKinds
                    .map((kind) => t(permissionKindKey(kind)))
                    .join(" / "),
                })}
              </button>
            </Tooltip>
          )}
          <Menu
            ariaLabel={t("composer.autoApprove.aria")}
            align="end"
            compact
            disabled={autoApproveCovered}
            disabledReason={
              autoApproveCovered
                ? t("composer.autoApprove.disabled")
                : undefined
            }
            trigger={
              <>
                <span className="text-micro text-ink-3">{t("composer.autoApprove.label")}</span>
                <span className="text-caption">{autoApproveText}</span>
                <ChevronDown className="size-3.5 text-ink-3" aria-hidden="true" />
              </>
            }
            items={autoApproveItems}
          />
          {busy && steerReason && (
            <span className="mr-1 text-micro text-ink-3">{steerReason}</span>
          )}
          {busy ? (
            <>
              <Tooltip label={t("ui.button.stop")}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onStop}
                  aria-label={t("ui.button.stop")}
                  className="size-7 gap-0 bg-surface-3/75 p-0 hover:bg-surface-3"
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </Tooltip>
              <Button
                variant="glass"
                size="sm"
                onClick={submit}
                disabled={!canSteerSend}
                disabledReason={
                  steerReason ?? (!canSteerSend ? t("composer.steer.empty") : undefined)
                }
                aria-label={t("ui.button.steer")}
                className="h-7 gap-1 px-2 text-caption"
              >
                <ArrowUp className="size-3.5" />
                {t("ui.button.steer")}
              </Button>
            </>
          ) : (
            <Button
              variant="glass"
              size="sm"
              onClick={submit}
              disabled={!canSend}
              disabledReason={!canSend ? t("composer.send.empty") : undefined}
              aria-label={t("ui.button.send")}
              className="size-7 gap-0 p-0"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      </div>
      </div>
    </>
  );
}
