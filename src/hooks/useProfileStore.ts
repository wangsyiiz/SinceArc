import { useEffect, useState } from "react";
import { fromDto, profilesLoad, profilesSave } from "@/lib/ipc";
import type { AgentProfile } from "@/types";

export function useProfileStore() {
  const [activeProfileId, setActiveProfileId] = useState("p-hermes-wsl");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  /** 库里的配置是否已读过：没读完不要往回写，否则会把空列表存进去 */
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  const addProfile = () =>
    setProfiles((list) => [
      ...list,
      {
        id: `p-new-${Date.now().toString(36)}`,
        name: "新连接",
        launch: "ssh",
        detail: "",
        connected: false,
        agentName: null,
        protocolVersion: null,
        program: "hermes",
        args: ["acp"],
        cwd: "",
        ssh: { host: "", port: 22, user: "", auth: "key" },
      },
    ]);
  const removeProfile = (id: string) => setProfiles((list) => list.filter((p) => p.id !== id));
  // 启动时读本机库：有记录就用记录，第一次运行才播种 mock
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = await profilesLoad();
        if (!alive) return;
        // 只认库里的。库是空的就一直空着 —— 用 mock 播种会在界面上留下
        // 永远连不通的假配置，干扰判断（用户明确要求删掉这类噪点）。
        setProfiles(stored.map(fromDto));
      } catch {
        // 非 Tauri 环境（浏览器直开）保持 mock
      } finally {
        if (alive) setProfilesLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 变更后回写（防抖：改名是逐字触发的）
  useEffect(() => {
    if (!profilesLoaded) return;
    const t = setTimeout(() => {
      profilesSave(profiles).catch((e) => console.warn("[db] save profiles failed", e));
    }, 400);
    return () => clearTimeout(t);
  }, [profiles, profilesLoaded]);

  return { profiles, setProfiles, profilesLoaded, activeProfile, activeProfileId, setActiveProfileId, addProfile, removeProfile };
}
