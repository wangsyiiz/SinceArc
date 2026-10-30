import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghViewer, type ViewerDto } from "@/lib/ipc";
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

export function GhIdentity() {
  const { t } = useTranslation();
  const [state, setState] = useState<IdentityState>({ kind: "loading" });
  const [avatarBroken, setAvatarBroken] = useState(false);

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
  return (
    <Tooltip label={login}>
      <button
        type="button"
        aria-label={t("titleBar.identity.githubAccount", { login })}
        className="grid size-4 shrink-0 cursor-default place-items-center overflow-hidden rounded-full bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1"
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
  );
}
