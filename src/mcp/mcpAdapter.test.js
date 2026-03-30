const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeLarkMessageText } = require("./mcpAdapter");

test("发送文本中 @所有人 自动规范化为飞书 at 语法", () => {
  const normalized = normalizeLarkMessageText("@所有人 16:00公司楼下集合");
  assert.equal(normalized, '<at user_id="all">所有人</at> 16:00公司楼下集合');
});

test("发送文本中 @_all 自动规范化为飞书 at 语法", () => {
  const normalized = normalizeLarkMessageText("@_all 16:00公司楼下集合");
  assert.equal(normalized, '<at user_id="all">所有人</at> 16:00公司楼下集合');
});

test("已是飞书 at 语法时保持不变", () => {
  const text = '<at user_id="all">所有人</at> 16:00公司楼下集合';
  const normalized = normalizeLarkMessageText(text);
  assert.equal(normalized, text);
});
