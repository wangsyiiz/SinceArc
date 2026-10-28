//! 通信层门面。业务代码只 import 这里（`@/lib/ipc`），不直接碰 client/events。
export * from "./client";
export * from "./types";
export * from "./events";
export * from "./domains/acp";
export * from "./domains/session";
export * from "./domains/member";
export * from "./domains/delegate";
export * from "./domains/settings";
export * from "./domains/mcp";
export * from "./domains/system";
export * from "./domains/gh";
