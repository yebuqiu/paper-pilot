#!/usr/bin/env node
/* PaperPilot PDF 文本结构化分析 测试（插件 0.33.0）
 *
 * 为什么要有它：全文对照翻译的「结构化单元」依赖 PdfText 的词法判定与段落装配。
 * 判定全是纯函数，这里逐类钉死：
 *   ① 图注/表注识别（caption）：命中只是打标记照常翻译，误伤无代价，但漏了会丢样式
 *   ② 公式识别（formula）：判成公式 = 原样直出不送翻 —— **误判会丢翻译**，阈值必须保守
 *   ③ 垃圾行识别（junk）：页码/DOI/URL/坐标轴刻度 —— **误判会丢内容**，只拦高置信模式
 *   ④ 判定顺序必须 caption → junk → formula（"Fig. 1a" 要被 caption 接住）
 *   ⑤ charsToParagraphs：阅读器字符流（line/paragraph break 标记）→ 段落
 *   ⑥ pagesToBlocks / analyzeText：跨页重复页眉页脚过滤 + 页码标注
 *   ⑦ blocksToUnits：相邻同 kind 合并、formula 独立成单元、超长硬切
 *   ⑧ 阅读器桥接的静默降级（无 Zotero 环境返回 null，不抛异常）
 *
 * 运行：node test/pdf-text.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'pdf-text.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'pdf-text.js' });
const P = sandbox.PdfText;

/* ==================== ① 图注/表注（caption） ==================== */
eq(P.isCaptionLine('Figure 3. Overall architecture of the system.'), true, '① Figure N. → caption');
eq(P.isCaptionLine('Fig. 2a shows the ablation result.'), true, '① Fig. 2a → caption');
eq(P.isCaptionLine('TABLE 1: Ablation study results'), true, '① TABLE 1（大小写不敏感）→ caption');
eq(P.isCaptionLine('Algorithm 2: Training procedure'), true, '① Algorithm N → caption');
eq(P.isCaptionLine('图3 系统总体架构'), true, '① 图N → caption');
eq(P.isCaptionLine('表 1 消融实验结果'), true, '① 表 N → caption');
eq(P.isCaptionLine('The result is shown in Table 1.'), false, '① 句中提及 Table 1（非行首）→ 非 caption');
eq(P.isCaptionLine('Configuration of our model is as follows.'), false, '① 普通句子 → 非 caption');

/* ==================== ② 公式识别（formula，误判=丢翻译，阈值保守） ==================== */
eq(P.isFormulaText('\\frac{a}{b} + \\sqrt{c} = 2'), true, '② LaTeX 命令残片 → formula');
eq(P.isFormulaText('where $x_t = \\alpha \\beta$ converges'), true, '② $...$ 定界 → formula');
eq(P.isFormulaText('σ² = α² + β²'), true, '② 符号汤（数学符号密度高、无实词）→ formula');
eq(P.isFormulaText('x_1 + x_2 = y_3 + z_4'), true, '② 单字母变量串 + 运算符 → formula');
eq(P.isFormulaText('lim n→∞ Σ f(x) dx = 0'), true, '② 极限/求和表达式 → formula');
eq(P.isFormulaText('The model achieves state-of-the-art results on all benchmarks.'), false,
  '② 普通长句 → 非 formula');
eq(P.isFormulaText('We use 3 methods with 2 baselines and 4 datasets.'), false,
  '② 含数字的正常句子 → 非 formula');
eq(P.isFormulaText('a'), false, '② 过短内容不判公式');

/* ==================== ③ 垃圾行（junk，误判=丢内容，只拦高置信） ==================== */
eq(P.looksLikeJunkLine('12'), true, '③ 纯页码 → junk');
eq(P.looksLikeJunkLine('page 3'), true, '③ page 3 → junk');
eq(P.looksLikeJunkLine('3 / 14'), true, '③ 页码区间 → junk');
eq(P.looksLikeJunkLine('Vol. 12'), true, '③ 卷号 → junk');
eq(P.looksLikeJunkLine('doi:10.1038/s41586-024-12345-6'), true, '③ DOI 行 → junk');
eq(P.looksLikeJunkLine('https://arxiv.org/abs/2401.12345'), true, '③ URL 行 → junk');
eq(P.looksLikeJunkLine('author@example.com'), true, '③ 邮箱行 → junk');
eq(P.looksLikeJunkLine('0.2 0.4 0.6 0.8 1.0'), true, '③ 坐标轴刻度串 → junk');
eq(P.looksLikeJunkLine(''), true, '③ 空串 → junk');
eq(P.looksLikeJunkLine('1 Introduction'), false, '③ 章节标题（数字+实词）→ 非 junk');
eq(P.looksLikeJunkLine('The quick brown fox jumps over the lazy dog.'), false, '③ 正常句子 → 非 junk');
eq(P.looksLikeJunkLine('In this paper we propose a novel framework.'), false, '③ 正文 → 非 junk');

/* ==================== ④ 判定顺序：caption → formula → junk ====================
 * 公式判定必须在垃圾判定之前——短公式同时长得像"轴标签碎片"，
 * 顺序错了会把 σ² = α² + β² 当垃圾丢掉（丢内容），顺序对了最多多保留一行。 */
eq(P.classify('Fig. 1a'), 'caption', '④ "Fig. 1a" 被 caption 接住');
eq(P.classify('σ² = α² + β²'), 'formula', '④ ★ 短公式不被垃圾规则吞掉');
eq(P.classify('12'), 'junk', '④ 纯页码判 junk');
eq(P.classify('In this paper we propose X.'), 'body', '④ 正文判 body');

/* ==================== ⑤ charsToParagraphs（阅读器字符流 → 段落） ==================== */
{
  const chars = [
    { c: 'H' }, { c: 'i', spaceAfter: true }, { c: 'w', lineBreakAfter: true },
    { c: 'X', paragraphBreakAfter: true },
    { c: 'd', paragraphBreakAfter: true },
    { c: ' ', ignorable: true }, { c: 'e' },
  ];
  const paras = P.charsToParagraphs(chars);
  eq(paras.length, 3, '⑤ 段落数正确（line break 不分段，paragraph break 分段）');
  eq(paras[0], 'Hi w X', '⑤ 行内空格保留、行间以空格连接进同段');
  eq(paras[1], 'd', '⑤ paragraph break 落在段尾');
  eq(paras[2], 'e', '⑤ ignorable 字符被跳过');
  eq(P.charsToParagraphs([]).length, 0, '⑤ 空流 → 空段落');
  eq(P.charsToParagraphs([{ c: 'H' }, { c: 'i', spaceAfter: true }]).join('|'), 'Hi',
    '⑤ 尾部 spaceAfter 被裁掉');
}

/* ==================== ⑥ pagesToBlocks / analyzeText（页眉页脚过滤 + 页码） ==================== */
{
  // 3 页，每页首行同一页眉 + 页码行 → 页眉/页码被滤；正文/图注/公式按类保留并带页码
  const pages = [
    ['IEEE Transactions on Testing, 2024', '3', 'First paragraph of page one.'],
    ['IEEE Transactions on Testing, 2024', '4', 'Figure 2. Sample output distribution.', 'Second paragraph.'],
    ['IEEE Transactions on Testing, 2024', '5', 'Third paragraph here.', 'σ² = α² + β²'],
  ];
  const r = P.pagesToBlocks(pages);
  eq(r.dropped, 6, '⑥ 三页的页眉 + 页码共 6 行被滤（页眉 ≥3 页重复、页码是纯数字）');
  eq(r.blocks.length, 5, '⑥ 剩余 5 块（1 正文 + 图注 + 正文 + 正文 + 公式）');
  eq(r.blocks[0].page, 1, '⑥ 页码从 1 起');
  eq(r.blocks[1].kind, 'caption', '⑥ 图注正确分类');
  eq(r.blocks[4].kind, 'formula', '⑥ 公式正确分类');
  eq(r.blocks[4].page, 3, '⑥ 第三页内容 page=3');
}
{
  // 同一行只在 2 页出现（<3）→ 不当页眉滤掉
  const pages = [
    ['Short Header', 'Body one.'],
    ['Short Header', 'Body two.'],
  ];
  const r = P.pagesToBlocks(pages);
  ok(r.blocks.some((b) => b.text === 'Short Header'), '⑥ 只重复 2 次的行不误杀');
}
{
  // 扁平路径：全文索引文本
  const flat = [
    'Journal of Nice Papers Volume 12',
    'We propose a new method for solving the task.',
    'Journal of Nice Papers Volume 12',
    'Figure 1. System overview.',
    'Journal of Nice Papers Volume 12',
    'The experiment section follows.',
  ].join('\n');
  const r = P.analyzeText(flat);
  eq(r.via, 'flat', '⑥ 扁平路径标记 via=flat');
  ok(r.dropped >= 3, '⑥ 重复 3 次的页眉行被滤');
  ok(r.blocks.every((b) => b.page === 0), '⑥ 扁平路径无页码（page=0）');
  eq(P.analyzeText('12\n10.1038/abc\nReal content stays.').blocks.length, 1,
    '⑥ 页码与 DOI 行被滤，正文保留');
}

/* ==================== ⑦ blocksToUnits（合并 / formula 独立 / 硬切） ==================== */
{
  const blocks = [
    { text: 'A', kind: 'body', page: 1 },
    { text: 'B', kind: 'body', page: 1 },
    { text: 'F = ma', kind: 'formula', page: 2 },
    { text: 'C', kind: 'caption', page: 2 },
    { text: 'D', kind: 'body', page: 3 },
  ];
  const units = P.blocksToUnits(blocks, 1000);
  eq(units.length, 4, '⑦ 相邻 body 合并、formula 独立、caption 不并进 body');
  eq(units[0].text, 'A\nB', '⑦ 同 kind 相邻块以换行合并');
  eq(units[0].kind, 'body', '⑦ 合并单元 kind=body');
  eq(units[0].page, 1, '⑦ 合并单元 page=首块页码');
  eq(units[1].kind, 'formula', '⑦ formula 独立成单元');
  eq(units[1].text, 'F = ma', '⑦ formula 原文进单元');
  eq(units[2].kind, 'caption', '⑦ caption 独立');
  eq(units[3].text, 'D', '⑦ 后续 body 从新单元开始');
}
{
  // 超长硬切（同旧 _chunk 语义）
  const long = 'x'.repeat(1500);
  const units = P.blocksToUnits([{ text: long, kind: 'body', page: 7 }], 600);
  eq(units.length, 3, '⑦ 1500 字按 600 硬切成 3 段');
  eq(units[0].page, 7, '⑦ 硬切段继承原块页码');
  // maxChars 下限保护
  eq(P.blocksToUnits([{ text: 'hello world', kind: 'body', page: 1 }], 10)[0].text, 'hello world',
    '⑦ maxChars 过小时仍整段输出（下限 200 由实现夹住）');
  eq(P.blocksToUnits([], 600).length, 0, '⑦ 空 blocks → 空 units');
  eq(P.blocksToUnits([{ text: '   ', kind: 'body', page: 1 }], 600).length, 0,
    '⑦ 空白块被跳过');
}

/* ==================== ⑧ 阅读器桥接：无 Zotero 环境静默降级 ==================== */
eq(P.readerForAttachment({ id: 1 }), null, '⑧ 无 Zotero 环境返回 null（不抛异常）');
eq(P.viewerOf(null), null, '⑧ 空 reader 返回 null');
eq(P.locatePage(null, 3), false, '⑧ 定位失败返回 false（不抛异常）');

(async () => {
  eq(await P.blocksFromReader(null), null, '⑧ blocksFromReader(null) → null（回落扁平路径）');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('PDF 文本分析：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log('✗ 测试自身异常：' + (e && e.stack || e));
  process.exit(1);
});
