/**
 * 棘轮清单：P1 之前就存在的违规。
 * 只许减少 —— 修掉一条就从这里删一行；新增违规会让测试红。
 * 每条注明归属（哪个组件、为什么暂时留着），P2 逐个清。
 */
export const ALLOWED: Record<string, { rule: string; count: number; why: string }[]> = {
  "App.tsx": [
    { rule: "arbitrary-value", count: 5, why: "P2 收敛停止提示与输入浮层的尺寸/字号" },
    { rule: "color-literal", count: 1, why: "P2 把主 agent 颜色改为令牌" },
    {
      rule: "glass-border-kill",
      count: 3,
      why: "通知条上的 border-0：暗色看不出差别，浅色会丢掉浮层边界。P2b2 清 App.tsx 时一起删",
    },
  ],
  "components/AgentCapabilities.tsx": [
    { rule: "arbitrary-value", count: 10, why: "P2 能力徽标尺寸与字号收敛" },
  ],
  "components/AgentUsers.tsx": [
    { rule: "arbitrary-value", count: 29, why: "P2 成员管理表单改为令牌尺寸" },
    { rule: "color-literal", count: 6, why: "P2 内置成员色板改为令牌" },
    { rule: "outline-none", count: 4, why: "P2 统一输入框焦点环" },
  ],
  "components/MembersMenu.tsx": [
    { rule: "arbitrary-value", count: 8, why: "P2 成员菜单字号与圆角收敛" },
  ],
  "components/PrView.tsx": [
    { rule: "arbitrary-value", count: 11, why: "P2 PR 状态与按钮尺寸收敛" },
    { rule: "color-literal", count: 5, why: "P2 PR 状态色改为令牌" },
    { rule: "transition-all", count: 1, why: "P2 主按钮改为按属性过渡" },
  ],
  "components/RepoBrowser.tsx": [
    { rule: "arbitrary-value", count: 11, why: "P2 仓库列表尺寸与字号收敛" },
    { rule: "color-literal", count: 1, why: "P2 merged 状态色改为令牌" },
  ],
  "components/SettingsView.tsx": [
    { rule: "arbitrary-value", count: 67, why: "P2 重写设置页时统一尺寸与字号" },
    { rule: "native-control", count: 1, why: "P2 移除第 606 行说明注释里的 <select> 字样" },
    { rule: "outline-none", count: 3, why: "P2 统一设置页输入框焦点环" },
  ],
  "components/Sidebar.tsx": [
    { rule: "arbitrary-value", count: 18, why: "P2 侧栏行高与字号收敛" },
    { rule: "outline-none", count: 1, why: "P2 搜索框补可替代的焦点样式" },
  ],
  "components/TracePanel.tsx": [
    { rule: "arbitrary-value", count: 14, why: "P2 轨迹面板尺寸与字号收敛" },
  ],
  "mock/data.ts": [
    { rule: "color-literal", count: 3, why: "P2 mock 玩家颜色改为令牌" },
  ],
};
