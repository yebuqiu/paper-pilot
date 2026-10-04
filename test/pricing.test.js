#!/usr/bin/env node
/* AI 计费单价与成本折算测试（服务端 1.5.0）
 *
 * 运行：node test/pricing.test.js
 *
 * 覆盖（纯函数，不启服务）：
 *   normalize / setModel / removeModel —— 归一化幂等、非法入参被拒、单价夹取
 *   priceFor —— 精确命中 / 忽略大小写 / 未知模型回落 fallback 且 known=false
 *   ★ 前缀不匹配 —— glm-5.3 不得吃掉 glm-5.3-flash 的价（算错钱比不算是更糟的失败）
 *   usageOf —— prompt_tokens / input_tokens 两种命名；完全无用量 → null（计量盲区）
 *   costOf  —— 微元口径正确；★ 极小请求不得被四舍五入成 0
 *   microText / tokText —— 展示换算分档
 */
'use strict';

const path = require('path');
const pricing = require(path.join(__dirname, '..', 'server', 'lib', 'pricing.js'));

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ================= A. normalize ================= */

{
  const d = pricing.normalize({});
  eq(Object.keys(d.models).length, 0, 'A1 空文档 → 空单价表');
  eq(d.schemaVersion, 1, 'A2 schemaVersion 归一到 1');
  eq(d.fallback.inPer1k, 0, 'A3 fallback 默认 0');

  // 幂等：连续两次 normalize 结果一致
  const d2 = pricing.normalize(JSON.parse(JSON.stringify(d)));
  eq(JSON.stringify(d2), JSON.stringify(d), 'A4 normalize 幂等');

  // 脏数据：数组、负值、字符串、超限
  const dirty = pricing.normalize({
    models: {
      good: { inPer1k: 1, outPer1k: 2 },
      neg: { inPer1k: -5, outPer1k: 'x' },
      huge: { inPer1k: 1e9, outPer1k: 0 },
      bad: 'not-an-object',
    },
    fallback: 'broken',
    models2: [],
  });
  eq(dirty.models.neg.inPer1k, 0, 'A5 负单价归 0');
  eq(dirty.models.neg.outPer1k, 0, 'A6 非数字单价归 0');
  eq(dirty.models.huge.inPer1k, pricing.MAX_PER_1K, 'A7 超限单价被夹取');
  ok(!('bad' in dirty.models), 'A8 非对象条目被丢弃');
  eq(dirty.fallback.inPer1k, 0, 'A9 坏 fallback 回默认');
  eq(Array.isArray(dirty.models), false, 'A10 models 永远是对象而非数组');
}

/* ================= B. setModel / removeModel / priceFor ================= */

{
  const d = pricing.newDoc();
  let r = pricing.setModel(d, 'glm-5.3-flash', { inPer1k: 0.0008, outPer1k: 0.002, note: '便宜档' });
  ok(!r.error, 'B1 写入单价成功');
  eq(d.models['glm-5.3-flash'].inPer1k, 0.0008, 'B2 输入单价落库');
  eq(d.models['glm-5.3-flash'].note, '便宜档', 'B3 备注落库');

  // 局部更新：只给 outPer1k，inPer1k 保持原值
  pricing.setModel(d, 'glm-5.3-flash', { outPer1k: 0.003 });
  eq(d.models['glm-5.3-flash'].inPer1k, 0.0008, 'B4 局部更新不动未提交字段（inPer1k）');
  eq(d.models['glm-5.3-flash'].outPer1k, 0.003, 'B5 局部更新生效（outPer1k）');

  ok(!!pricing.setModel(d, '', { inPer1k: 1 }).error, 'B6 空模型名被拒');
  ok(!!pricing.setModel(d, 'x', {}).error, 'B7 两个单价都不给 → 拒绝');

  // ★ 关键：前缀不得匹配
  pricing.setModel(d, 'glm-5.3', { inPer1k: 9, outPer1k: 9 });
  const pFull = pricing.priceFor(d, 'glm-5.3-flash');
  ok(pFull.known && pFull.inPer1k === 0.0008, 'B8 精确命中 flash 的价（未被 glm-5.3 抢走）', pFull);
  const pBase = pricing.priceFor(d, 'glm-5.3');
  eq(pBase.inPer1k, 9, 'B9 精确命中 glm-5.3 自己的价');

  // 忽略大小写
  const pCase = pricing.priceFor(d, 'GLM-5.3-FLASH');
  ok(pCase.known && pCase.matched === 'glm-5.3-flash', 'B10 大小写不敏感命中', pCase);

  // 未知模型 → fallback + known=false
  const pUnknown = pricing.priceFor(d, 'never-heard-of-it');
  eq(pUnknown.known, false, 'B11 未知模型 known=false');
  eq(pUnknown.inPer1k, 0, 'B12 未知模型回落 fallback 0');

  // fallback 可配
  d.fallback = { inPer1k: 0.001, outPer1k: 0.002 };
  const pFb = pricing.priceFor(d, 'never-heard-of-it');
  eq(pFb.inPer1k, 0.001, 'B13 配了 fallback 后未知模型按 fallback 计');
  eq(pFb.known, false, 'B14 但仍标 known=false（≠ 真的免费）');

  eq(pricing.hasModel(d, 'glm-5.3'), true, 'B15 hasModel 命中');
  eq(pricing.hasModel(d, 'nope'), false, 'B16 hasModel 未命中');

  const rm = pricing.removeModel(d, 'glm-5.3');
  ok(!rm.error, 'B17 删除单价成功');
  ok(!!pricing.removeModel(d, 'glm-5.3').error, 'B18 重复删除报错');

  eq(pricing.modelList(d).length, 1, 'B19 modelList 剩余 1 条');
  eq(pricing.modelList(d)[0].model, 'glm-5.3-flash', 'B20 modelList 带模型名');
}

/* ================= C. usageOf ================= */

{
  const a = pricing.usageOf({ prompt_tokens: 22, completion_tokens: 30, total_tokens: 52 });
  eq(a.inTok, 22, 'C1 prompt_tokens 解析');
  eq(a.outTok, 30, 'C2 completion_tokens 解析');
  eq(a.totalTok, 52, 'C3 total_tokens 解析');

  const b = pricing.usageOf({ input_tokens: 7, output_tokens: 9 });
  eq(b.inTok, 7, 'C4 input_tokens 命名兼容');
  eq(b.outTok, 9, 'C5 output_tokens 命名兼容');
  eq(b.totalTok, 16, 'C6 缺 total 时自行相加');

  const c = pricing.usageOf({ total_tokens: 100 });
  eq(c.inTok, 0, 'C7 只有 total 也能解析');
  eq(c.totalTok, 100, 'C8 total 保留');

  eq(pricing.usageOf(null), null, 'C9 null → null');
  eq(pricing.usageOf({}), null, 'C10 空对象 → null');
  eq(pricing.usageOf({ prompt_tokens: 0, completion_tokens: 0 }), null, 'C11 全 0 → null（不是「0 成本」，是没数据）');
  eq(pricing.usageOf({ prompt_tokens: -3 }), null, 'C12 负值当作无效');
}

/* ================= D. costOf ================= */

{
  const d = pricing.newDoc();
  pricing.setModel(d, 'flash', { inPer1k: 0.0008, outPer1k: 0.002 });

  // (22*0.0008 + 30*0.002) * 1000 = 77.6 → 78 微元
  const c1 = pricing.costOf(d, 'flash', { inTok: 22, outTok: 30 });
  eq(c1.micro, 78, 'D1 成本微元计算正确');
  eq(c1.known, true, 'D2 已配价 → known');
  eq(c1.inTok, 22, 'D3 带回输入 token');

  // ★ 极小请求：10 token × 0.0001 元/千 → 0.001 微元级也要留下痕迹
  pricing.setModel(d, 'tiny', { inPer1k: 0.0001, outPer1k: 0 });
  const c2 = pricing.costOf(d, 'tiny', { inTok: 10, outTok: 0 });
  eq(c2.micro, 1, 'D4 极小请求不被归零（分口径会算成 0）');
  ok(c2.micro > 0, 'D5 极小请求成本 > 0');

  // 明确配 0 价的模型 = 真免费，但 known=true（与「没配价」区分开）
  pricing.setModel(d, 'freebie', { inPer1k: 0, outPer1k: 0 });
  const c3 = pricing.costOf(d, 'freebie', { inTok: 1000, outTok: 1000 });
  eq(c3.micro, 0, 'D6 配 0 价 → 成本 0');
  eq(c3.known, true, 'D7 配 0 价 known=true（与未配价区分）');

  const c4 = pricing.costOf(d, 'unknown-model', { inTok: 1000, outTok: 1000 });
  eq(c4.known, false, 'D8 未配价 → known=false');
  eq(c4.micro, 0, 'D9 未配价按兜底 0 计（真实成本未知，不能当免费）');

  const c5 = pricing.costOf(d, 'flash', null);
  eq(c5.micro, 0, 'D10 无 usage → 0');
  eq(c5.inTok, 0, 'D11 无 usage token 归 0');

  // 累计不丢精度：1000 次极小请求应等于单次 × 1000
  let acc = 0;
  for (let i = 0; i < 1000; i++) acc += pricing.costOf(d, 'tiny', { inTok: 10, outTok: 0 }).micro;
  eq(acc, 1000, 'D12 微元累计无浮点漂移');
}

/* ================= E. 展示换算 ================= */

{
  eq(pricing.microText(0), '¥0', 'E1 0 → ¥0');
  eq(pricing.microText(1), '¥0.0000', 'E2 1 微元 → 四位小数');
  eq(pricing.microText(40000), '¥0.040', 'E3 4 万微元 → 三位小数');
  eq(pricing.microText(2500000), '¥2.50', 'E4 ≥1 元 → 两位小数');

  eq(pricing.yuanToMicro(0.0008), 800, 'E5 元 → 微元');
  eq(pricing.microToYuan(800), 0.0008, 'E6 微元 → 元');
  eq(pricing.microToCents(10000), 1, 'E7 1 分 = 1 万微元');

  eq(pricing.tokText(999), '999', 'E8 小于一万原样');
  eq(pricing.tokText(12345), '1.2 万', 'E9 大于一万用「万」');
}

console.log('\nAI 计费单价测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ 全部通过');
