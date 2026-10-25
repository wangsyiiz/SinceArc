import assert from "node:assert/strict";
import test from "node:test";

import {
  delegateActionLabel,
  delegateCancelFailureMessage,
} from "./delegate-status.ts";

test("引用条只给在飞阶段动作，重启后的历史状态不显示", () => {
  assert.equal(delegateActionLabel("running"), "停止");
  assert.equal(delegateActionLabel("cancelling"), "正在停止…");
  assert.equal(delegateActionLabel(null), null);
  assert.equal(delegateActionLabel(undefined), null);
  assert.equal(delegateActionLabel("finished"), null);
});

test("停止成功后引用条写「已停止」，但不给动作", () => {
  assert.equal(delegateActionLabel("cancelled"), "已停止");
});

test("取消失败说明为什么退不出正在停止", () => {
  assert.equal(
    delegateCancelFailureMessage(50300),
    "目标连接已断开，这次派活没有可停的对象",
  );
  assert.equal(
    delegateCancelFailureMessage(50704),
    "这个派活已经结束或不属于当前会话",
  );
  assert.equal(delegateCancelFailureMessage(50000), "停止失败（50000）");
});
