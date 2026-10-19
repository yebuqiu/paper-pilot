#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 中文文献 AI 增强（0.42.0，P1-P3）测试
 *
 * 覆盖四层（全部离线、无网络、无 Zotero）：
 *   A. CNAI.parseAIJSON / fallbackPlan —— JSON 提取与确定性检索计划回退
 *   B. L1 规划：buildPlannerMessages / parsePlan —— 校验、兜底、queries 归一
 *   C. L3 裁决：buildJudgeMessages / parseJudgment / decide —— 置信度分档
 *   D. L4 融合：fuseMeta —— 「数据库为准、其余只填空」纪律
 *   E. P2 双通道：CNFetch._parseEndNote —— EndNote tagged 文本字段映射
 *   F. P3 兜底：parseRecognized / parseRescueResults —— 防幻觉硬校验
 *   G. CNFetch 回归：_buildQueries / _isTitleMatch / _matchScore（真文件）
 *
 * 运行：node test/cn-ai.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 沙箱：加载 cn-ai.js + cn-fetch.js 真文件 ---------------- */

function deepProxy(name) {
  const fn = function () { return deepProxy(name + '()'); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString') return () => name;
      if (k === 'then') return undefined;
      return deepProxy(name + '.' + String(k));
    },
    apply() { return deepProxy(name + '()'); },
    construct() { return deepProxy('new ' + name); },
  });
}

const PrefStore = new Map();
const sandbox = {
  console,
  Zotero: deepProxy('Zotero'),
  Services: deepProxy('Services'),
  IOUtils: deepProxy('IOUtils'),
  PathUtils: deepProxy('PathUtils'),
  Components: deepProxy('Components'),
  Worker: deepProxy('Worker'),
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  _ppDiag: () => {},
};
sandbox.Prefs = {
  PREFIX: 'extensions.zotero.papilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
sandbox.I18n = { isZh: true, t: (k) => k };
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(S(rel), 'utf8'), sandbox, { filename: rel });
}
load('features/cn-ai.js');
load('features/cn-fetch.js');

const CNAI = sandbox.CNAI;
const CNFetch = sandbox.CNFetch;
const CNVerify = sandbox.CNVerify;

/* ==================== A. parseAIJSON / fallbackPlan ==================== */

(function A() {
  // A1 围栏 + 闲话容忍
  const j1 = CNAI.parseAIJSON('好的，结果如下：\n```json\n{"a":1}\n```\n以上。');
  eq(j1 && j1.a, 1, 'A1 围栏 JSON 提取');

  // A2 数组 vs 对象：取第一个括号类型
  const j2 = CNAI.parseAIJSON('[1,2,3]');
  ok(Array.isArray(j2) && j2.length === 3, 'A2 数组提取');

  // A3 不平衡括号 → null
  eq(CNAI.parseAIJSON('{"a": {"b": 1'), null, 'A3 不平衡括号返回 null');

  // A4 无括号 → null
  eq(CNAI.parseAIJSON('没有任何 JSON'), null, 'A4 无 JSON 返回 null');

  // A5 fallbackPlan：标题归一 + 查询式生成
  const p1 = CNAI.fallbackPlan('高血压与糖尿病共病管理_张三.pdf', '');
  eq(p1.from, 'fallback', 'A5 回退来源标记');
  ok(p1.queries.length >= 1 && p1.queries.length <= 4, 'A5 查询式数量 1-4');
  ok(p1.queries[0].includes('高血压'), 'A5 首条为完整标题', p1.queries[0]);

  // A6 fallbackPlan：作者串从标题剥离
  const p2 = CNAI.fallbackPlan('深度学习 张三 研究', '张三');
  ok(!p2.queries[0].includes('张三'), 'A6 作者从查询式剥离', p2.queries[0]);

  // A7 fallbackPlan：长标题生成首尾 token 组合式（首条完整标题保留原貌，主题式去「的」）
  const p3 = CNAI.fallbackPlan('基于深度强化学习的城市交通拥堵预测方法研究', '');
  ok(p3.queries.length >= 2, 'A7 长标题多候选式');
  ok(p3.queries.slice(1).every((q) => !q.includes('的')), 'A7 主题式去「的」', p3.queries);
})();

/* ==================== B. L1 规划 ==================== */

(function B() {
  // B1 提示词结构：system 含纪律，user 是 JSON 证据
  const msgs = CNAI.buildPlannerMessages({ filename: 'a.pdf', titleHint: 't', pdfText: '正文' });
  eq(msgs.length, 2, 'B1 规划提示词两条消息');
  ok(msgs[0].content.includes('绝不臆造'), 'B1 提示词含不臆造纪律');
  ok(msgs[1].content.includes('a.pdf'), 'B1 user 含证据');

  // B2 正常解析
  const plan = CNAI.parsePlan(
    '{"title":"高血压管理研究","author":"张三","journal":"中华高血压杂志","year":"2023",' +
    '"docType":"article","queries":["高血压管理研究","高血压管理"]}',
    '旧标题', '李四');
  eq(plan.from, 'ai', 'B2 AI 来源标记');
  eq(plan.title, '高血压管理研究', 'B2 标题');
  eq(plan.author, '张三', 'B2 作者（AI 优先）');
  eq(plan.year, '2023', 'B2 年份');
  eq(plan.docType, 'article', 'B2 文献类型');

  // B3 queries 缺失 → 由标题启发式补齐
  const plan2 = CNAI.parsePlan('{"title":"城市内涝风险评估模型构建研究","queries":[]}', '', '');
  ok(plan2 && plan2.queries.length >= 1, 'B3 queries 启发式补齐');
  eq(plan2.queries[0], '城市内涝风险评估模型构建研究', 'B3 首条为完整标题');

  // B4 完整标题恒为第一条
  const plan3 = CNAI.parsePlan(
    '{"title":"乡村治理数字化转型路径研究","queries":["乡村治理 路径","数字化转型"]}', '', '');
  eq(plan3.queries[0], '乡村治理数字化转型路径研究', 'B4 完整标题置顶');

  // B5 坏 JSON / 标题不含汉字 / 标题过短 → null
  eq(CNAI.parsePlan('不是JSON', '回退标题', ''), null, 'B5-1 坏 JSON → null');
  eq(CNAI.parsePlan('{"title":"English Only Title Here","queries":[]}', '', ''), null, 'B5-2 非中文标题 → null');
  eq(CNAI.parsePlan('{"title":"短","queries":[]}', '', ''), null, 'B5-3 标题过短 → null');

  // B6 回退标题补位（模型没给标题时用 basic title）
  const plan4 = CNAI.parsePlan('{"title":"","queries":["查询式一"]}', '回退的完整中文标题', '王五');
  eq(plan4.title, '回退的完整中文标题', 'B6 回退标题补位');
  eq(plan4.author, '王五', 'B6 回退作者补位');

  // B7 docType 白名单
  const plan5 = CNAI.parsePlan('{"title":"学位论文标题研究","docType":"book","queries":[]}', '', '');
  eq(plan5.docType, '', 'B7 非法 docType 归空');
})();

/* ==================== C. L3 裁决 ==================== */

(function C() {
  const cand = [
    { source: 'CNKI', articleTitle: '高血压管理研究', author: '张三,李四', journal: '中华高血压杂志', year: '2023' },
    { source: 'PubScholar', articleTitle: '高血压药物经济学评价', author: '王五', journal: '中国药房', year: '2022' },
  ];
  const msgs = CNAI.buildJudgeMessages({ title: '高血压管理研究', author: '张三' }, cand);
  eq(msgs.length, 2, 'C1 裁决提示词两条消息');
  ok(msgs[1].content.includes('高血压管理研究'), 'C1 user 含候选');
  ok(msgs[0].content.includes('"index"'), 'C1 提示词约束输出格式');

  // C2 正常解析
  const j1 = CNAI.parseJudgment('{"index":0,"confidence":0.95,"reason":"标题作者完全一致"}', 2);
  eq(j1.index, 0, 'C2 命中序号');
  eq(j1.confidence, 0.95, 'C2 置信度');
  ok(j1.reason.length > 0, 'C2 理由');

  // C3 全否决 index=-1 合法
  const j2 = CNAI.parseJudgment('{"index":-1,"confidence":0.92,"reason":"均非目标"}', 2);
  eq(j2.index, -1, 'C3 全否决序号合法');

  // C4 越界 / 非整数 / 坏 JSON → null
  eq(CNAI.parseJudgment('{"index":5,"confidence":0.9}', 2), null, 'C4-1 序号越界 → null');
  eq(CNAI.parseJudgment('{"index":0.5,"confidence":0.9}', 2), null, 'C4-2 非整数序号 → null');
  eq(CNAI.parseJudgment('垃圾', 2), null, 'C4-3 坏 JSON → null');

  // C5 置信度 clamp
  const j3 = CNAI.parseJudgment('{"index":1,"confidence":7}', 2);
  eq(j3.confidence, 1, 'C5 置信度截断到 1');

  // C6 decide 分档
  eq(CNAI.decide({ index: 0, confidence: 0.95 }, 2, 0.9, 0.6).action, 'auto', 'C6-1 高置信自动');
  eq(CNAI.decide({ index: 1, confidence: 0.75 }, 2, 0.9, 0.6).action, 'confirm', 'C6-2 中置信确认');
  eq(CNAI.decide({ index: 0, confidence: 0.3 }, 2, 0.9, 0.6).action, 'manual', 'C6-3 低置信人工');
  eq(CNAI.decide({ index: -1, confidence: 0.95 }, 2, 0.9, 0.6).action, 'reject', 'C6-4 高置信否决');
  eq(CNAI.decide({ index: -1, confidence: 0.5 }, 2, 0.9, 0.6).action, 'manual', 'C6-5 低置信否决按人工');
  eq(CNAI.decide(null, 2, 0.9, 0.6).action, 'manual', 'C6-6 无裁决人工');

  // C7 decide 索引二次越界保护
  eq(CNAI.decide({ index: 9, confidence: 0.99 }, 2, 0.9, 0.6).action, 'manual', 'C7 越界索引人工兜底');

  // C8 阈值缺省（NaN → 默认 0.9/0.6）
  eq(CNAI.decide({ index: 0, confidence: 0.91 }, 2, NaN, NaN).action, 'auto', 'C8 阈值缺省回退默认');
})();

/* ==================== D. L4 融合 ==================== */

(function D() {
  const db = { articleTitle: '高血压管理研究', journal: '中华高血压杂志', doi: '10.1000/xyz', abstract: '', volume: '31' };
  const pick = { articleTitle: '高血压管理研究', source: 'CNKI', exportID: 'E123', citation: '42', journal: '中华高血压杂志(旧)' };
  const ai = { journal: '中华高血压杂志(AI)', year: '2023', queries: ['x'] };

  // D1 数据库字段为准
  const m = CNAI.fuseMeta(db, pick, ai);
  eq(m.journal, '中华高血压杂志', 'D1 primary 字段优先');
  eq(m.doi, '10.1000/xyz', 'D1 DOI 保留');

  // D2 协议字段从搜索结果被补入
  eq(m.source, 'CNKI', 'D2 source 补入');
  eq(m.exportID, 'E123', 'D2 exportID 补入');
  eq(m.citation, '42', 'D2 citation 补入');

  // D3 AI 只填空（year 三处只有 AI 有）
  eq(m.year, '2023', 'D3 AI 补空字段');

  // D4 空串字段视为空、被后续来源填补
  eq(m.abstract, undefined, 'D4-1 全空字段不出现在结果');
  const m2 = CNAI.fuseMeta({ abstract: '', title: '' }, { abstract: '后补摘要', title: 'T' });
  eq(m2.abstract, '后补摘要', 'D4-2 空串被后续填补');

  // D5 数组：空数组视为空
  const m3 = CNAI.fuseMeta({ keywords: [] }, { keywords: ['高血压'] });
  ok(Array.isArray(m3.keywords) && m3.keywords[0] === '高血压', 'D5 空数组被填补');

  // D6 不改入参
  const dbFrozen = { a: '1' };
  CNAI.fuseMeta(dbFrozen, { b: '2' });
  eq(Object.keys(dbFrozen).length, 1, 'D6 入参不被修改');

  // D7 null 来源安全跳过
  const m4 = CNAI.fuseMeta({ x: '1' }, null, { y: '2' });
  eq(m4.y, '2', 'D7 null 来源跳过');
})();

/* ==================== E. P2 EndNote 解析 ==================== */

(function E() {
  // E1 期刊论文完整样本（CNKI GetExport 典型输出）
  const en1 = '%0 Journal Article\n%T 高血压与糖尿病共病管理模式研究\n%A 张三\n%A 李四\n' +
    '%J 中华高血压杂志\n%D 2023\n%V 31\n%N 05\n%P 412-418\n%R 10.3760/cma.j.cn123\n' +
    '%X 目的 探讨共病管理模式。\n%K 高血压\n%K 糖尿病\n%U https://kns.cnki.net/detail/x';
  const m1 = CNFetch._parseEndNote(en1);
  eq(m1.itemType, 'journalArticle', 'E1 类型映射');
  eq(m1.articleTitle, '高血压与糖尿病共病管理模式研究', 'E1 标题');
  eq(m1.creators.length, 2, 'E1 多作者');
  eq(m1.author, '张三,李四', 'E1 author 串');
  eq(m1.journal, '中华高血压杂志', 'E1 期刊');
  eq(m1.year, '2023', 'E1 年份');
  eq(m1.volume, '31', 'E1 卷');
  eq(m1.issue, '05', 'E1 期');
  eq(m1.pages, '412-418', 'E1 页码');
  eq(m1.doi, '10.3760/cma.j.cn123', 'E1 DOI');
  eq(m1.keywords.length, 2, 'E1 关键词');
  eq(m1.url, 'https://kns.cnki.net/detail/x', 'E1 URL');

  // E2 学位论文类型
  const en2 = '%0 Thesis\n%T 城市内涝风险研究\n%A 王五\n%D 2022';
  eq(CNFetch._parseEndNote(en2).itemType, 'thesis', 'E2 学位论文类型');

  // E3 摘要跨行续行拼接
  const en3 = '%0 Journal Article\n%T 测试标题研究\n%X 第一行摘要\n续行内容\n%A 张三';
  const m3 = CNFetch._parseEndNote(en3);
  ok(m3.abstract.includes('第一行摘要') && m3.abstract.includes('续行内容'), 'E3 摘要续行拼接');

  // E4 未知类型回落 journalArticle
  const en4 = '%0 Patent\n%T 某发明专利方法研究\n%A 张三';
  eq(CNFetch._parseEndNote(en4).itemType, 'journalArticle', 'E4 未知类型回落');

  // E5 空文本安全
  const m5 = CNFetch._parseEndNote('');
  eq(m5.articleTitle, '', 'E5 空文本安全');
  eq(m5.creators.length, 0, 'E5 空文本无作者');
})();

/* ==================== F. P3 兜底识别 / 自愈 ==================== */

(function F() {
  // F1 正常识别结果
  const meta = CNAI.parseRecognized(
    '{"itemType":"thesis","title":"城市内涝风险评估模型研究","creators":["王五"],"journal":"",'
    + '"year":"2022","volume":"","issue":"","pages":"","doi":"","abstract":"本文研究……",'
    + '"keywords":["内涝","风险评估"],"university":"清华大学"}');
  eq(meta.itemType, 'thesis', 'F1 类型');
  eq(meta.articleTitle, '城市内涝风险评估模型研究', 'F1 标题');
  eq(meta._unverified, true, 'F1 恒带未验证标记');
  eq(meta.author, '王五', 'F1 author 串');

  // F2 防幻觉硬校验：无标题/短标题/非中文标题 → null
  eq(CNAI.parseRecognized('{"itemType":"journalArticle","title":""}'), null, 'F2-1 空标题 → null');
  eq(CNAI.parseRecognized('{"title":"短"}'), null, 'F2-2 短标题 → null');
  eq(CNAI.parseRecognized('{"title":"A Pure English Title"}'), null, 'F2-3 非中文标题 → null');

  // F3 itemType 白名单外 → journalArticle
  eq(CNAI.parseRecognized('{"title":"有效的中文标题研究","itemType":"book"}').itemType,
    'journalArticle', 'F3 非法类型回落');

  // F4 坏 JSON → null
  eq(CNAI.parseRecognized('无法解析'), null, 'F4 坏 JSON → null');

  // F5 自愈解析：相对 href 补主机、垃圾行过滤
  const rows = CNAI.parseRescueResults(
    '[{"title":"高血压管理研究","author":"张三 李四","journal":"中华高血压杂志","date":"2023-05","href":"/kcms/detail/detail.aspx?dbname=CJFQ&filename=X1"},'
    + '{"title":"xy","author":"","journal":"","date":"","href":""},'
    + '{"title":"Pure English Row","author":"A","journal":"B","date":"2020","href":""}]');
  eq(rows.length, 1, 'F5 垃圾行被过滤');
  eq(rows[0].source, 'CNKI-LLM', 'F5 来源标记');
  ok(rows[0].url.startsWith('https://kns.cnki.net/'), 'F5 相对地址补主机', rows[0].url);
  eq(rows[0].year, '2023', 'F5 年份抽取');
  ok(rows[0].creators.includes('张三'), 'F5 作者拆分');

  // F6 非数组 / 空数组安全
  eq(CNAI.parseRescueResults('{"not":"array"}').length, 0, 'F6-1 非数组 → 空');
  eq(CNAI.parseRescueResults('[]').length, 0, 'F6-2 空数组 → 空');
  eq(CNAI.parseRescueResults('垃圾').length, 0, 'F6-3 坏 JSON → 空');
})();

/* ==================== G. CNFetch 回归（真文件，确认增强未破坏旧行为） ==================== */

(function G() {
  // G1 _buildQueries 不变
  const qs = CNFetch._buildQueries('基于深度学习的图像识别方法研究', '');
  ok(qs.length >= 2 && qs.length <= 4, 'G1 内置查询式数量');

  // G2 _isTitleMatch 不变
  ok(CNFetch._isTitleMatch('高血压 管理 研究', '高血压管理研究'), 'G2 标题紧凑匹配');
  ok(!CNFetch._isTitleMatch('高血压管理研究', '糖尿病管理研究'), 'G2 不同标题不匹配');

  // G3 _matchScore 不变
  eq(CNFetch._matchScore('高血压管理研究', '高血压管理研究.pdf'), 1, 'G3 文件全等匹配');
  ok(CNFetch._matchScore('高血压管理研究', '高血压管理研究_张三.pdf') >= 0.9, 'G3 文件包含匹配');

  // G4 _parseEndNote 存在于真文件且 CNVerify 已定义（同文件后半）
  eq(typeof CNFetch._parseEndNote, 'function', 'G4 _parseEndNote 已挂载');
  eq(typeof CNVerify.probe, 'function', 'G4 CNVerify 完整加载');

  // G5 GetExport 通道函数已挂载
  eq(typeof CNFetch._getExportEndNote, 'function', 'G5 _getExportEndNote 已挂载');
})();

/* ==================== 汇总 ==================== */

console.log('');
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('✓ cn-ai（中文文献 AI 增强 P1-P3）全部 ' + pass + ' 项断言通过');
