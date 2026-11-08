import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ghViewer, openExternal, type ViewerDto } from "@/lib/ipc";
import { currentLocale } from "@/i18n/locale";
import { badgeLabel, clockTime, prMenuRows } from "@/lib/my-prs-display";
import { useMyPrs } from "@/hooks/useMyPrs";
import { Menu, type MenuItem } from "./ui/Menu";

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
const COUNT_MARKER = "__COUNT__";

function IdentityAvatar({
  avatarUrl,
  initial,
  broken,
  onBroken,
}: {
  avatarUrl: string | null;
  initial: string;
  broken: boolean;
  onBroken: () => void;
}) {
  return (
    <span className="grid size-4.5 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-3">
      {avatarUrl && !broken ? (
        <img
          src={avatarUrl}
          alt=""
          onError={onBroken}
          className="size-4.5 rounded-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="text-micro font-semibold leading-none text-ink-2">
          {initial}
        </span>
      )}
    </span>
  );
}

export function GhIdentity() {
  const { t } = useTranslation();
  const [state, setState] = useState<IdentityState>({ kind: "loading" });
  const [avatarBroken, setAvatarBroken] = useState(false);
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

  const data = myPrs.data;
  if (data?.state === "unavailable") {
    return (
      <span className="whitespace-nowrap text-micro text-ink-3">
        {t("titleBar.identity.notLoggedIn")}
      </span>
    );
  }

  const login = viewer.login;
  const initial = login.slice(0, 1).toUpperCase();
  const badge = data ? badgeLabel(data.count, data.hasMore) : null;
  const displayedCount = data?.hasMore ? "100+" : String(data?.count ?? 0);
  const rows = prMenuRows(data?.items ?? [], {
    draftLabel: t("titleBar.myPrs.draft"),
    locale: currentLocale(),
    limit: 8,
  });

  let description: string | undefined;
  if (data?.stale) {
    const line = t("titleBar.myPrs.stale", {
      time: clockTime(data.updatedAt) || "--:--",
    });
    description = data.error ? `${line} · ${data.error.msg.slice(0, 80)}` : line;
  }

  const actions: MenuItem[] = [
    {
      id: "open-on-github",
      label: t("titleBar.myPrs.openOnGithub"),
      icon: <ExternalLink className="size-3.5" aria-hidden="true" />,
      onSelect: () => void openExternal(GITHUB_PULLS),
    },
    {
      id: "refresh",
      label: t("titleBar.myPrs.refresh"),
      icon: <RefreshCw className="size-3.5" aria-hidden="true" />,
      onSelect: myPrs.refresh,
    },
  ];

  let items: MenuItem[];
  if (rows.length === 0) {
    items = [
      { id: "empty", label: t("titleBar.myPrs.empty"), disabled: true },
      ...actions,
    ];
  } else {
    items = [
      ...rows.map((row) => ({
        id: row.id,
        label: row.label,
        hint: row.hint,
        description: row.description,
        onSelect: () => void openExternal(row.url || GITHUB_PULLS),
      })),
      ...actions,
    ];
  }

  // 计数要单独用 font-mono，借现有 heading 文案的 {{total}} 槽位拆出数字。
  const [headingBefore, headingAfter] = t("titleBar.myPrs.heading", {
    total: COUNT_MARKER,
  }).split(COUNT_MARKER);

  const avatar = (
    <IdentityAvatar
      avatarUrl={viewer.avatarUrl}
      initial={initial}
      broken={avatarBroken}
      onBroken={() => setAvatarBroken(true)}
    />
  );

  return (
    <span className="relative inline-flex">
      <Menu
        ariaLabel={t("titleBar.identity.githubAccount", { login })}
        align="end"
        triggerVariant="bare"
        trigger={avatar}
        header={
          <div className="flex min-w-0 items-center gap-2">
            {avatar}
            <span className="min-w-0 truncate text-caption text-ink-1">@{login}</span>
          </div>
        }
        section={
          <>
            {headingBefore}
            <span className="font-mono">{displayedCount}</span>
            {headingAfter}
          </>
        }
        description={description}
        items={items}
      />
      {badge && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-0.5 -top-0.5 grid size-3.5 place-items-center rounded-full bg-accent-1 font-mono text-micro leading-none text-accent-ink"
        >
          {badge}
        </span>
      )}
    </span>
  );
}
