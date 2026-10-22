/**
 * 主 agent 在「玩家表」里的稳定 id。
 *
 * 它没有 authorId —— 主 agent 就是「这个会话本身」，群成员才有自己的 id。
 * 单独放在无依赖模块里：事件处理、轨迹适配、测试都要用它，
 * 从 hooks 里 import 会把整条 React 依赖链拖进纯逻辑测试。
 */
export const MAIN_AGENT_ID = "agent";
