import { useParams } from "react-router";
import { ArrowUp } from "lucide-react";
import type { JSX } from "react";
import { ActivityRail } from "@/components/ActivityRail";
import { AgentCapabilities } from "@/components/AgentCapabilities";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { EmptyState as LoadingState } from "@/components/ui/EmptyState";
import { MessageItem } from "@/components/MessageItem";
import { NoticeStack } from "@/components/NoticeStack";
import { StatusBar } from "@/components/StatusBar";
import { StorageNotice } from "@/components/StorageNotice";
import { ThinkingRow } from "@/components/ThinkingRow";
import { acpSessionIdOfActivity } from "@/lib/activity-row";
import { queueCount } from "@/lib/busy-input";
import { useWorkspace } from "@/routes/workspace-context";

export function SessionRoute(): JSX.Element {
  const ws = useWorkspace();
  useParams();
  const {
    state,
    hasMore,
    loadingOlder,
    opening,
    players,
    renderPlayers,
    virtualRows,
    virtualTotalSize,
    measureRow,
    beginAnchorShift,
    endAnchorShift,
    visibleMessageIds,
    settings,
    t,
    cwd,
    sessionProfile,
    activeAcpSid,
    eventCount,
    lastEvent,
    eventLog,
    runningItems,
    activeModeView,
    activeDefaultModeLabel,
    connectPending,
    choose,
    traceOpen,
    setTraceOpen,
    setFocus,
    setTraceLocate,
    acpCommands,
    playerFilter,
    setMemberPanel,
    members,
    profiles,
    reloadMembers,
    scrollRef,
    handleMessageScroll,
    composerH,
    requestOlder,
    connectProblem,
    errorState,
    send,
    refreshTitles,
    estimateMessage,
    highlightMessageId,
    delegateRunning,
    cancelDelegate,
    locateTraceTurn,
    storageStats,
    composerRef,
    unreadJump,
    jumpToFirstUnread,
    setPermOpen,
    noticesBySession,
    dismissUiNotice,
    isInterrupting,
    isStopping,
    usageLine,
    sendInGroup,
    sendSteer,
    steerMode,
    stopGeneration,
    queuedBySession,
    activeAutoApprove,
    autoApproveCoveredByAgent,
    setAutoApproveLevel,
    activeTurnPolicy,
    revokeTurnPolicy,
    reconnectMcp,
    lastSessionId,
  } = ws;

  return (
    <>
      <StatusBar
        cwd={cwd}
        profile={sessionProfile}
        sessionId={activeAcpSid ?? undefined}
        eventCount={eventCount}
        lastEvent={lastEvent}
        eventLog={eventLog}
        running={runningItems}
        onOpenTrace={() => {
          setTraceOpen(true);
          setFocus(null);
        }}
        modes={activeModeView}
        fallbackLabel={activeDefaultModeLabel}
        resume={state.resume}
        connectError={state.connectError}
        connecting={!!connectPending[lastSessionId]}
        onChooseMode={(modeId) => {
          const acpSid = activeAcpSid;
          if (sessionProfile && acpSid) {
            void choose({
              profileId: sessionProfile.id,
              acpSessionId: acpSid,
              uiSessionId: lastSessionId,
              modeId,
            });
          }
        }}
        traceOpen={traceOpen}
        onToggleTrace={() =>
          setTraceOpen((v) => {
            if (v) {
              setFocus(null);
              setTraceLocate(null);
            }
            return !v;
          })
        }
        right={
          <AgentCapabilities
            profile={sessionProfile}
            acpCommands={acpCommands}
          />
        }
      />
      <div className="flex min-h-0 flex-1">
        {/* 竖栏是「谁在这个群里」：历史作者（已移出）不出现在这里，
            他们的消息与轨迹支线仍然保留身份。 */}
        <ActivityRail
          players={players.filter((player) => !player.removed)}
          activities={state.acts}
          filter={playerFilter}
          onOpenMember={(member, anchor) => setMemberPanel({ id: member.id, anchor })}
          group={
            lastSessionId
              ? {
                  sessionId: lastSessionId,
                  members,
                  profiles,
                  onChanged: reloadMembers,
                }
              : undefined
          }
        />
        <div key={lastSessionId} className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={handleMessageScroll}
            className="h-full overflow-y-auto"
          >
            <div
              className="sc-selectable mx-auto min-h-full w-full max-w-3xl px-4 pt-4"
              style={{ paddingBottom: composerH + 16 }}
            >
              {hasMore && (
                <button
                  type="button"
                  onClick={requestOlder}
                  className="mx-auto mb-3.5 rounded-md px-2 py-1 text-caption text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-2"
                >
                  {loadingOlder ? t("app.messages.loadingOlder") : t("app.messages.loadEarlier")}
                </button>
              )}
              {state.msgs.length === 0 ? (
                connectProblem ? (
                  errorState
                ) : opening || connectPending[lastSessionId] ? (
                  /* 打开 → 可用这一段：骨架屏（原语自带 300ms 延迟，快的时候看不到）
                     + 一行阶段说明 —— 冷启动时连接可能要几秒，光有条在跳说不出在等什么 */
                  <div className="flex min-h-full flex-col items-center justify-center gap-2">
                    <LoadingState kind="loading" heading={t("app.session.opening")} />
                    <p className="text-caption text-ink-3">
                      {opening ? t("app.session.readingHistory") : t("app.session.connecting")}
                    </p>
                  </div>
                ) : (
                  <div className="py-12">
                    <EmptyState
                      cwd={cwd}
                      onPick={(t) => {
                        void send(t).then(refreshTitles);
                      }}
                    />
                  </div>
                )
              ) : (
                <>
                  <div className="relative" style={{ height: virtualTotalSize }}>
                    {virtualRows.map((row) => {
                      const m = state.msgs[row.index];
                      if (!m) return null;
                      return (
                        <div
                          key={row.key}
                          ref={measureRow}
                          data-index={row.index}
                          data-message-id={m.id}
                          data-turn-id={m.turnId ?? ""}
                          className="absolute inset-x-0 top-0"
                          style={{
                            transform: `translateY(${row.start}px)`,
                            minHeight: estimateMessage(row.index),
                          }}
                          onClickCapture={(event) => {
                            const target = event.target;
                            if (
                              !(target instanceof Element) ||
                              !target.closest("[aria-expanded]")
                            ) {
                              return;
                            }
                            // 行内卡片展开前先记锚点，React 更新后下一帧摆回原位。
                            beginAnchorShift(row.index);
                            requestAnimationFrame(endAnchorShift);
                          }}
                        >
                          <div className="pb-3.5">
                            <div
                              className={
                                "group relative rounded-card transition-shadow" +
                                (highlightMessageId === m.id
                                  ? " ring-2 ring-accent-1/70"
                                  : "")
                              }
                            >
                              <MessageItem
                                message={m}
                                players={renderPlayers}
                                tweenEnabled={settings.tweenEnabled}
                                delegatePhase={
                                  m.role === "user" && m.delegate
                                    ? delegateRunning[m.delegate.handleId]
                                    : undefined
                                }
                                quoteTargetMissing={
                                  m.role === "user" &&
                                  !!m.quoted?.messageId &&
                                  !visibleMessageIds.has(m.quoted?.messageId ?? "")
                                }
                                onCancelDelegate={cancelDelegate}
                                onLocateTrace={locateTraceTurn}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {state.acts
                    .filter((a) => a.status === "running")
                    .map((a) => {
                      const p = renderPlayers.find((x) => x.id === a.playerId);
                      if (!p) return null;
                      const rowAcpSid = acpSessionIdOfActivity(a.id);
                      const lock = rowAcpSid ? state.locks?.[rowAcpSid] : undefined;
                      return (
                        <div key={a.id} className="pt-3.5">
                          <ThinkingRow
                            player={p}
                            activity={a}
                            lock={lock ? { title: lock.title, count: lock.count } : undefined}
                            onOpenTrace={() => {
                              setTraceOpen(true);
                              setFocus((f) => ({ id: a.id, tick: (f?.tick ?? 0) + 1 }));
                            }}
                          />
                        </div>
                      );
                    })}
                  <div className="pt-3.5 empty:hidden">{errorState}</div>
                </>
              )}
              <div className="pt-3.5 empty:hidden">
                <StorageNotice key={lastSessionId} stats={storageStats} />
              </div>
            </div>
          </div>
          <div
            ref={composerRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3"
          >
            <div className="mx-auto max-w-3xl">
              {unreadJump?.sessionId === lastSessionId && unreadJump.count > 0 && (
                <button
                  type="button"
                  onClick={() => void jumpToFirstUnread()}
                  className="sc-glass pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-card px-3 py-1.5 text-left text-caption text-danger-1 transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                >
                  <ArrowUp className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {t("app.unread.jump", { count: unreadJump.count })}
                  </span>
                </button>
              )}
              {state.pendingPerm && (
                <button
                  onClick={() => setPermOpen(true)}
                  className="sc-glass pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-card px-3 py-1.5 text-left text-caption text-warn-1 transition-colors hover:brightness-110"
                >
                  <span className="shrink-0 font-medium">
                    {players.find((x) => x.id === state.pendingPerm?.playerId)?.name ??
                      "agent"}
                  </span>
                  <span className="truncate text-ink-2">
                    {t("app.permission.request", {
                      // 剥掉标题末尾的问号（中文全角 / 英文半角都算）；这是判据不是文案
                      title: state.pendingPerm.title.replace(/？\?\s*$/, ""), // i18n-ignore
                    })}
                  </span>
                  <span className="ml-auto shrink-0 text-ink-3">{t("app.permission.view")}</span>
                </button>
              )}
              <div className="pointer-events-auto">
                <NoticeStack
                  notices={noticesBySession[lastSessionId] ?? []}
                  onDismiss={(id) => dismissUiNotice(lastSessionId, id)}
                />
                {isInterrupting && (
                  <div className="sc-glass mb-2 flex items-center gap-2 rounded-card px-3 py-1.5 text-caption text-ink-2">
                    <span className="size-1.5 animate-pulse rounded-full bg-warn-1" />
                    {t("composer.busy.interrupting")}
                  </div>
                )}
                {isStopping && (
                  <div className="sc-glass mb-2 flex items-center gap-2 rounded-card px-3 py-1.5 text-caption text-ink-2">
                    <span className="size-1.5 animate-pulse rounded-full bg-warn-1" />
                    {t("app.composer.stoppingNotice")}
                  </div>
                )}
                <Composer
                  busy={state.busy}
                  usage={usageLine}
                  onSend={sendInGroup}
                  onSteer={sendSteer}
                  steerGate={steerMode}
                  commands={acpCommands}
                  onStop={stopGeneration}
                  placeholder={
                    isInterrupting
                      ? t("composer.busy.interrupting")
                      : isStopping
                      ? t("app.composer.stopping")
                      : t("app.composer.placeholder")
                  }
                  busyInputMode={settings.busyInputMode}
                  interrupting={isInterrupting}
                  queuedCount={queueCount(queuedBySession[lastSessionId] ?? [])}
                  players={players.filter((player) => !player.removed)}
                  autoApprove={activeAutoApprove}
                  autoApproveCovered={autoApproveCoveredByAgent}
                  onAutoApproveChange={setAutoApproveLevel}
                  turnPolicyKinds={activeTurnPolicy?.kinds ?? []}
                  onRevokeTurnPolicy={() => void revokeTurnPolicy()}
                  sessionId={lastSessionId}
                  uiSid={lastSessionId}
                  sessionProfile={sessionProfile}
                  onReconnectMcp={() =>
                    lastSessionId && sessionProfile
                      ? reconnectMcp(lastSessionId, sessionProfile.id)
                      : Promise.reject({ code: 50300, msg: t("app.composer.noSession") })
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
