import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentProfile } from "@/types";
import {
  agentDiscover,
  agentDiscoveryCached,
  asCmdError,
  type DiscoveryOutcome,
} from "@/lib/ipc";

/**
 * agent 发现（docs/discovery.md）。
 *
 * 三件事，分开管：
 * 1. 启动先读缓存 —— 界面立刻有内容，不用等扫描；
 * 2. 缓存里没有（第一次启动）才后台扫一次；
 * 3. 用户点「重新扫描」随时重来。
 *
 * 扫描是慢操作（要起 wsl.exe、逐个发行版问 PATH），所以永远不阻塞界面：
 * 只有 scanning 标记，列表保持上一次的结果。
 */
export function useDiscovery(profiles: AgentProfile[] = []) {
  // 扫描要带上 SSH 连接配置；用 ref 拿最新值，避免 profiles 变化时重建 scan 回调
  const profilesRef = useRef<AgentProfile[]>(profiles);
  profilesRef.current = profiles;
  const [outcome, setOutcome] = useState<DiscoveryOutcome | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 同一时刻只允许一次扫描：连点两次会起两倍进程，结果还会互相覆盖 */
  const inFlight = useRef(false);

  const scan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setScanning(true);
    setError(null);
    try {
      setOutcome(await agentDiscover(profilesRef.current));
    } catch (e) {
      const err = asCmdError(e);
      setError(`${err.code} ${err.msg}`);
    } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = await agentDiscoveryCached();
        if (!alive) return;
        if (cached) {
          setOutcome(cached);
          return;
        }
      } catch {
        // 缓存读不出来不算错：下面照常扫一遍
      }
      if (alive) void scan();
    })();
    return () => {
      alive = false;
    };
  }, [scan]);

  return { outcome, scanning, error, scan };
}
