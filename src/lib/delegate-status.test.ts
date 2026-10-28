import assert from "node:assert/strict";
import test from "node:test";

import {
  delegateActionCode,
  delegateCancelFailureKey,
} from "./delegate-status.ts";

test("引用条只给在飞阶段动作，重启后的历史状态不显示", () => {
  assert.equal(delegateActionCode("running"), "stop");
  assert.equal(delegateActionCode("cancelling"), "stopping");
  assert.equal(delegateActionCode(null), null);
  assert.equal(delegateActionCode(undefined), null);
  assert.equal(delegateActionCode("finished"), null);
});

test("停止成功后引用条写「已停止」，但不给动作", () => {
  assert.equal(delegateActionCode("cancelled"), "stopped");
});

test("取消失败说明为什么退不出正在停止", () => {
  assert.equal(delegateCancelFailureKey(50300), "delegate.cancel.noTarget");
  assert.equal(delegateCancelFailureKey(50704), "delegate.error.ended");
  assert.equal(delegateCancelFailureKey(50000), "delegate.cancel.generic");
});
