#!/usr/bin/env node
/* MCP 对外供给（MCP，0.50.0）测试 —— Agent 工具桥接
 *
 * 覆盖：
 *   ① tools/list 向后兼容：原有 8 个工具一个不动，总数 8 → 10；
 *   ② 新工具 schema（list_agent_tools 无参 / run_agent_tool 的 tool + args + allowWrite）；
 *   ③ list_agent_tools：只列 AgentTools.enabledIds() 内的工具（pref CSV 过滤，含禁用工具消失）；
 *   ④ run_agent_tool 门控：未知/未启用报错、写工具未 allowWrite 拒绝（且**不执行**、
 *      不弹 Services.prompt）、allowWrite 才执行、只读直接执行；
 *   ⑤ 执行契约：args 透传、非对象 args 回退 {}、ctx = {mcp:true, skipConfirm:true}；
 *   ⑥ 结果处理：8000 字符截断 + 「…（已截断）」、异常不抛（isError 文本，JSON-RPC 仍成功）。
 *
 * 说明：mcp.js 的 handleMessage / callTool 是纯逻辑，可离线直调；
 * 不构造 Zotero.Server.Endpoints（端点注册与 HTTP 传输不在本测试范围）。
 *
 * 运行：node test/mcp.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MCP_FILE = 'chrome/content/scripts/features/mcp.js';
const FILES = [
  'chrome/content/scripts/ai/agent-tools.js', // 真注册表：enabledIds/TOOLS 用真实实现
  MCP_FILE,
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const Prefs = {
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
const promptCalls = [];
const Services = {
  prompt: {
    confirm() { promptCalls.push('confirm'); return true; },
    alert() { promptCalls.push('alert'); },
  },
};
const Zotero = {
  Prefs,
  logError() {},
  PaperPilot: { version: '9.9.9' },
  Server: { Endpoints: {}, port: 23119 },
  Libraries: { userLibraryID: 1 },
};

const sandbox = {
  console, Zotero, Services, Prefs, JSON, Date, Math, Promise, Map, Set,
  isFinite, parseInt, String, Number, Array,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const MCP = sandbox.MCP;
const AT = sandbox.AgentTools;
const SRC = fs.readFileSync(path.join(ROOT, MCP_FILE), 'utf8');

/* 把 execTool 换成可编程 mock（真注册表 + 假执行） */
const execCalls = [];
let execImpl = async () => 'ok-result';
AT.execTool = async (id, args, ctx) => {
  execCalls.push({ id, args, ctx });
  return execImpl(id, args, ctx);
};

/** 统一以 tools/call 走完整 JSON-RPC 链路（不注入 ctx.callTool，走真实 callTool） */
function call(name, args) {
  return MCP.handleMessage({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name, arguments: args || {} },
  });
}
function textOf(resp) { return resp.result.content[0].text; }

(async function main() {

  /* ---------------- ① 工具清单：8 → 10，原 8 个不变 ---------------- */

  const legacy = ['search_library', 'get_item', 'read_fulltext', 'list_annotations',
    'create_note', 'list_collections', 'library_stats', 'list_recent'];
  eq(MCP.TOOLS.length, 10, '工具总数 = 8 原有 + 2 新增 = 10');
  eq(MCP.TOOLS.slice(0, 8).map((t) => t.name).join(','), legacy.join(','),
    '前 8 个工具的名称与顺序完全不变（向后兼容）');
  eq(MCP.TOOLS.slice(8).map((t) => t.name).join(','), 'list_agent_tools,run_agent_tool',
    '新增工具追加在尾部');

  const listed = await MCP.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  eq(listed.result.tools.length, 10, 'tools/list 返回 10 个工具');
  ok(listed.result.tools.every((t) => t.name && t.description && t.inputSchema),
    '每个工具都有 name / description / inputSchema');

  /* ---------------- ② 新工具 schema ---------------- */

  const schemaOf = (n) => MCP.TOOLS.find((t) => t.name === n).inputSchema;
  const lat = schemaOf('list_agent_tools');
  eq(lat.type, 'object', 'list_agent_tools: type=object');
  eq(Object.keys(lat.properties || {}).length, 0, 'list_agent_tools: 无参数');
  ok(!lat.required || !lat.required.length, 'list_agent_tools: 无 required');

  const rat = schemaOf('run_agent_tool');
  eq(rat.required.join(','), 'tool', 'run_agent_tool: 仅 tool 必填');
  eq(rat.properties.tool.type, 'string', 'run_agent_tool: tool 为 string');
  eq(rat.properties.args.type, 'object', 'run_agent_tool: args 为 object');
  eq(rat.properties.allowWrite.type, 'boolean', 'run_agent_tool: allowWrite 为 boolean');

  /* ---------------- ③ list_agent_tools：只列启用的 ---------------- */

  PrefStore.delete('aiAgentTools'); // 默认全量 6 个
  let r = await call('list_agent_tools');
  let payload = JSON.parse(textOf(r));
  ok(Array.isArray(payload.tools), 'list_agent_tools 返回可解析 JSON，含 tools 数组');
  eq(payload.tools.length, AT.enabledTools().length, '列出的数量 = enabledIds 过滤后的数量');
  eq(payload.tools.length, 6, '默认 6 个 Agent 工具全部列出');
  const item = payload.tools.find((t) => t.id === 'search_library');
  ok(item && item.label && item.desc && typeof item.readOnly === 'boolean',
    '每项含 id/label/desc/readOnly');
  eq(item.readOnly, true, 'search_library 标记为只读');
  ok(item.args && item.args.query, 'search_library 带 query 参数说明');
  eq(payload.tools.find((t) => t.id === 'add_note').readOnly, false, 'add_note 标记为写工具');
  eq(payload.tools.find((t) => t.id === 'list_collections').args &&
    Object.keys(payload.tools.find((t) => t.id === 'list_collections').args).length, 0,
    'list_collections 参数说明为空对象');

  // pref 白名单过滤：只启用两个读工具
  PrefStore.set('aiAgentTools', 'search_library,read_item_fulltext');
  r = await call('list_agent_tools');
  payload = JSON.parse(textOf(r));
  eq(payload.tools.length, 2, 'pref 过滤：只剩 2 个启用工具');
  eq(payload.tools.map((t) => t.id).join(','), 'search_library,read_item_fulltext',
    'pref 过滤：内容与白名单一致');
  ok(!payload.tools.some((t) => t.id === 'add_note'), '被禁用的写工具不出现在列表里');

  // 模块缺失降级
  const ATref = sandbox.AgentTools;
  sandbox.AgentTools = undefined;
  r = await call('list_agent_tools');
  eq(textOf(r), 'Agent 工具模块未加载', 'AgentTools 缺失 → 明确报错文本，不抛');
  eq(r.result.isError, true, 'AgentTools 缺失 → isError=true');
  sandbox.AgentTools = ATref;

  /* ---------------- ④ 门控：未知 / 未启用 / 写授权 ---------------- */

  PrefStore.delete('aiAgentTools');
  execCalls.length = 0;

  r = await call('run_agent_tool', { tool: 'no_such_tool' });
  eq(textOf(r), '未知或未启用的工具：no_such_tool', '未知工具 → 指定错误文本');
  eq(r.result.isError, true, '未知工具 → isError=true');
  eq(execCalls.length, 0, '未知工具不触碰 execTool');

  r = await call('run_agent_tool', {});
  eq(textOf(r), '参数 tool 必填', 'tool 缺省 → 提示必填');
  eq(r.result.isError, true, 'tool 缺省 → isError=true');
  eq(execCalls.length, 0, '缺参不执行');

  // 写工具未授权：拒绝 + 不执行 + 不弹窗
  promptCalls.length = 0;
  r = await call('run_agent_tool', { tool: 'add_note', args: { item_id: 101, text: 'hi' } });
  ok(textOf(r).indexOf('该工具会修改文献库（写操作）') === 0, '写工具未授权 → 拒绝说明');
  ok(textOf(r).indexOf('allowWrite: true') > 0, '拒绝文本明确给出 allowWrite: true 的用法');
  eq(r.result.isError, true, '写拒绝 → isError=true');
  eq(execCalls.length, 0, '写拒绝 → 根本不调用 execTool（不产生副作用）');
  eq(promptCalls.length, 0, '写拒绝 → 不弹 Services.prompt（MCP 无人交互）');

  // allowWrite 必须是严格 true
  r = await call('run_agent_tool', { tool: 'add_note', allowWrite: 'true' });
  eq(r.result.isError, true, 'allowWrite 传字符串 "true" 仍拒绝（严格布尔）');
  r = await call('run_agent_tool', { tool: 'add_note', allowWrite: 1 });
  eq(r.result.isError, true, 'allowWrite 传 1 仍拒绝');
  eq(execCalls.length, 0, '非严格 true 一律不执行');

  // 写工具授权后放行
  execImpl = async () => '✓ 笔记已添加';
  r = await call('run_agent_tool', {
    tool: 'add_note', args: { item_id: 101, text: 'hi' }, allowWrite: true,
  });
  eq(r.result.isError, false, '写工具 allowWrite:true → 正常返回');
  eq(textOf(r), '✓ 笔记已添加', '写工具结果原样回传');
  eq(execCalls.length, 1, '写工具授权后执行一次');
  eq(execCalls[0].id, 'add_note', 'execTool 收到正确工具 id');
  eq(execCalls[0].args.item_id, 101, 'execTool 收到透传的 args');
  eq(execCalls[0].ctx.mcp, true, 'ctx.mcp = true');
  eq(execCalls[0].ctx.skipConfirm, true, 'ctx.skipConfirm = true（无人值守旁路契约）');

  // 只读工具：无需 allowWrite
  execCalls.length = 0;
  execImpl = async () => '检索结果：…';
  r = await call('run_agent_tool', { tool: 'search_library', args: { query: 'bert' } });
  eq(textOf(r), '检索结果：…', '只读工具直接执行（无需 allowWrite）');
  eq(r.result.isError, false, '只读工具 isError=false');
  eq(execCalls.length, 1, '只读工具执行一次');

  // 未启用工具：即使存在也拒绝
  PrefStore.set('aiAgentTools', 'search_library');
  execCalls.length = 0;
  r = await call('run_agent_tool', { tool: 'add_note', allowWrite: true });
  eq(textOf(r), '未知或未启用的工具：add_note', '被禁用的工具 → 「未知或未启用」');
  eq(execCalls.length, 0, '被禁用的工具不执行');
  PrefStore.delete('aiAgentTools');

  /* ---------------- ⑤ 执行契约：args 回退 / 异常 / 截断 ---------------- */

  execCalls.length = 0;
  execImpl = async () => 'done';
  await call('run_agent_tool', { tool: 'list_collections', args: '不是对象' });
  eq(JSON.stringify(execCalls[0].args), '{}', 'args 非对象 → 回退空对象');
  await call('run_agent_tool', { tool: 'list_collections', args: [1, 2] });
  eq(JSON.stringify(execCalls[1].args), '{}', 'args 为数组 → 回退空对象');
  await call('run_agent_tool', { tool: 'list_collections' });
  eq(JSON.stringify(execCalls[2].args), '{}', 'args 缺省 → 空对象');

  // 结果截断：8000 上限 + 「…（已截断）」
  execImpl = async () => 'x'.repeat(9000);
  r = await call('run_agent_tool', { tool: 'list_collections' });
  const cut = textOf(r);
  eq(cut.length, 8000 + '…（已截断）'.length, '超长结果截断到 8000 + 截断标记');
  ok(cut.slice(0, 8000) === 'x'.repeat(8000), '截断保留前 8000 字符原样');
  ok(cut.slice(-6) === '…（已截断）', '截断末尾带「…（已截断）」');
  eq(r.result.isError, false, '截断不算错误');
  // 恰好 8000 不截断
  execImpl = async () => 'y'.repeat(8000);
  r = await call('run_agent_tool', { tool: 'list_collections' });
  eq(textOf(r).length, 8000, '恰好 8000 字符不追加标记');

  // 异常：只降级为文本，JSON-RPC 仍是成功响应
  execImpl = async () => { throw new Error('boom'); };
  const exResp = await call('run_agent_tool', { tool: 'list_collections' });
  eq(exResp.error, undefined, '工具异常 → JSON-RPC 无 error（仍是成功响应）');
  eq(exResp.result.isError, true, '工具异常 → result.isError=true');
  eq(textOf(exResp), '工具执行失败：boom', '工具异常 → 文本说明原因');

  // 空字符串结果也不崩
  execImpl = async () => undefined;
  r = await call('run_agent_tool', { tool: 'list_collections' });
  eq(textOf(r), 'undefined', '非字符串结果先 String() 化，不抛');

  /* ---------------- ⑥ 安全纪律：桥接层不弹窗 ---------------- */

  eq(promptCalls.length, 0, '整个流程未触发任何 Services.prompt 调用');
  ok(!/Services\.prompt\.confirm\s*\(/.test(SRC),
    'mcp.js 不调用 Services.prompt.confirm（写操作只走 allowWrite 门控）');
  eq(sandbox.MCP.AGENT_RESULT_MAX, 8000, '截断上限常量为 8000');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nmcp: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
})();
