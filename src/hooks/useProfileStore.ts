import { useEffect, useState } from "react";
import { fromDto, profilesLoad, profilesSave } from "@/lib/ipc";
import { profileLabel } from "@/lib/format";
import type { AgentProfile } from "@/types";

export function useProfileStore() {
  // 别再硬编码某个 id：以前这里写死 "p-hermes-wsl"，而真实库里 id 是随机生成的，
  // 于是 activeProfile 永远是 undefined —— 标题栏的连接胶囊、模式选择器全都不渲染。
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  /** 库里的配置是否已读过：没读完不要往回写，否则会把空列表存进去 */
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  const addProfile = (draft?: Partial<AgentProfile>) =>
    setProfiles((list) => [
      ...list,
      {
        id: `p-new-${Date.now().toString(36)}`,
        name: "", // 空名走 profileLabel 派生（程序 · 位置），比所有连接都叫「新连接」有用
        launch: "ssh",
        detail: "",
        connected: false,
        agentName: null,
        protocolVersion: null,
        program: "hermes",
        args: ["acp"],
        cwd: "",
        ssh: { host: "", port: 22, user: "", auth: "key" },
        // 发现结果可以直接带完整启动配置进来，用户不必再手填 program/args
        ...draft,
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
        const loaded = stored.map(fromDto);
        // 老的占位名「新连接」对所有连接都一样，读进来就换成能区分的名字
        loaded.forEach((p) => {
          if (p.name === "新连接") p.name = profileLabel(p);
        });
        setProfiles(loaded);
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

  /** 只替换同 id 的那一条；连接状态、握手结果都靠它回写 */
  const updateProfile = (next: AgentProfile) =>
    setProfiles((list) => list.map((p) => (p.id === next.id ? next : p)));

  return { profiles, setProfiles, profilesLoaded, activeProfile, activeProfileId, setActiveProfileId, addProfile, updateProfile, removeProfile };
}
