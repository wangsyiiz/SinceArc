import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghViewer, openExternal, type ViewerDto } from "@/lib/ipc";
import { currentLocale } from "@/i18n/locale";
import { badgeLabel, clockTime, topItems } from "@/lib/my-prs-display";
import { relativeTime } from "@/lib/relative-time";
import { useMyPrs } from "@/hooks/useMyPrs";
import { useHoverCard } from "./ui/HoverCard";
import { Tooltip } from "./ui/Tooltip";

let pending: Promise<ViewerDto> | null = null;

function loadViewer(): Promise<ViewerDto> {
  if (pending === null) pending = ghViewer();
  return pending;
}

type IdentityState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; viewer: ViewerDto };

const GITHUB_PULLS = "https://github.com/pulls";

export function GhIdentity() {
  const { t } = useTranslation();
  const [state, setState] = useState<IdentityState>({ kind: "loading" });
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const hover = useHoverCard();
  const myPrs = useMyPrs();

  useEffect(() => {
    let alive = true;
    loadViewer().then(
      (viewer) => {
        if (alive) setState({ kind: "loaded", viewer });
      },
      () => {
        if (alive) setState({ kind: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "loading" || state.kind === "failed") {
    return <span aria-hidden="true" />;
  }

  const viewer = state.viewer;
  if (viewer.state === "loggedOut" || viewer.state === "unavailable") {
    return (
      <span className="whitespace-nowrap text-micro text-ink-3">
        {t("titleBar.identity.notLoggedIn")}
      </span>
    );
  }

  if (viewer.state !== "ready" || !viewer.login) {
    return <span aria-hidden="true" />;
  }

  const login = viewer.login;
  const initial = login.slice(0, 1).toUpperCase();
  const data = myPrs.data;
  const badge = data ? badgeLabel(data.count, data.hasMore) : null;
  const items = topItems(data?.items ?? [], 8);
  const unavailable = data?.state === "unavailable";
  const displayedCount = data?.hasMore ? "100+" : String(data?.count ?? 0);
  const staleLine = data?.stale ? (
    <div className="mt-2 text-micro text-ink-3">
      {t("titleBar.myPrs.stale", { time: clockTime(data.updatedAt) || "--:--" })}
    </div>
  ) : null;

  return (
    <>
      <span className="relative inline-flex">
        <Tooltip label={login}>
          <button
            ref={setTriggerEl}
            {...hover.triggerProps(triggerEl)}
            type="button"
            aria-label={t("titleBar.identity.githubAccount", { login })}
            onClick={() => void openExternal(GITHUB_PULLS)}
            className="grid size-4 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1"
          >
            {viewer.avatarUrl && !avatarBroken ? (
              <img
                src={viewer.avatarUrl}
                alt=""
                onError={() => setAvatarBroken(true)}
                className="size-4 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="grid size-4 place-items-center rounded-full text-micro font-semibold leading-none text-ink-2"
              >
                {initial}
              </span>
            )}
          </button>
        </Tooltip>
        {badge && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-0.5 -top-0.5 grid size-3.5 place-items-center rounded-full bg-accent-1 font-mono text-micro leading-none text-accent-ink"
          >
            {badge}
          </span>
        )}
      </span>
      {hover.card(
        <div className="flex flex-col">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {unavailable
                ? t("titleBar.myPrs.unavailable")
                : t("titleBar.myPrs.heading", { total: displayedCount })}
            </span>
          </div>

          {unavailable ? null : items.length === 0 ? (
            <div className="py-2 text-caption text-ink-3">
              {t("titleBar.myPrs.empty")}
            </div>
          ) : (
            <div className="flex flex-col">
              {items.map((pr) => (
                <div key={`${pr.repo}#${pr.number}`} className="py-1.5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="shrink-0 font-mono text-micro text-ink-3">
                      #{pr.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-caption text-ink-1">
                      {pr.title}
                    </span>
                    {pr.isDraft && (
                      <span className="shrink-0 text-micro text-ink-3">
                        {t("titleBar.myPrs.draft")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-micro text-ink-3">
                    <span className="min-w-0 flex-1 truncate">{pr.repo}</span>
                    <span className="shrink-0">
                      {relativeTime(pr.updatedAt, currentLocale())}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {staleLine &&
            (data?.error ? (
              <Tooltip label={data.error.msg}>{staleLine}</Tooltip>
            ) : (
              staleLine
            ))}

          <div className="mt-2 flex items-center justify-between border-t border-line-1/60 pt-2">
            <button
              type="button"
              onClick={() => void openExternal(GITHUB_PULLS)}
              className="cursor-pointer text-caption text-accent-1 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1"
            >
              {t("titleBar.myPrs.openOnGithub")}
            </button>
            <button
              type="button"
              onClick={myPrs.refresh}
              className="cursor-pointer text-caption text-ink-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1"
            >
              {t("titleBar.myPrs.refresh")}
            </button>
          </div>
        </div>,
      )}
    </>
  );
}
