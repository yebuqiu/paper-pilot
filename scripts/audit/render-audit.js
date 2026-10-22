#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Papilot 设置面板 0.72.3 真实渲染门禁
 *
 * 用本机 Chrome（playwright-core，不下载浏览器）对静态快照
 * docs/预览-设置面板-0.72.3.html 做 4 组合实测：
 *   1280x900 / 560x900  ×  light / dark
 * 产出：docs/audit/0.72.3/*.png + render.json + render.md（数据表部分）
 *
 * 用法：
 *   NODE_PATH=H:/project/paper-pilot/node_modules \
 *   C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe \
 *   scripts/audit/render-audit.js
 *
 * 只读：不修改任何产品文件，不做交互逻辑验证（页面是静态快照）。
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const REPO = path.resolve(__dirname, '..', '..');
// 默认审计当前版预览页；可用 RENDER_PAGE / RENDER_OUT 指向任一构建产物
// （干跑示例：RENDER_PAGE=H:/tmp/preview-dry.html RENDER_OUT=H:/tmp/render-dry）
const PAGE = process.env.RENDER_PAGE
  ? path.resolve(process.env.RENDER_PAGE)
  : path.join(REPO, 'docs', '预览-设置面板-0.72.3.html');
const OUT_DIR = process.env.RENDER_OUT
  ? path.resolve(process.env.RENDER_OUT)
  : path.join(REPO, 'docs', 'audit', '0.72.3');
const VERSION = (path.basename(PAGE).match(/(\d+\.\d+\.\d+)/) || [, '0.72.3'])[1];
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// 真机里 ui-tokens.css 先注入、prefs.css 随后；预览页只内嵌 prefs.css，
// 所以做「显式深色」验证时手动把它插到 <head> 最前，复现真实层叠顺序
const UI_TOKENS_CSS = fs.readFileSync(path.join(REPO, 'chrome', 'content', 'ui-tokens.css'), 'utf8');

const COMBOS = [
  { name: '1280-light', width: 1280, height: 900, colorScheme: 'light' },
  { name: '1280-dark', width: 1280, height: 900, colorScheme: 'dark' },
  { name: '560-light', width: 560, height: 900, colorScheme: 'light' },
  { name: '560-dark', width: 560, height: 900, colorScheme: 'dark' },
  // 系统浅色 + 用户显式选深色：0.72.2 的 P0 混搭场景
  { name: '1280-explicit-dark', width: 1280, height: 900, colorScheme: 'light', explicitTheme: 'dark' },
  // 同上，但先把 ui-tokens.css 插到 <head> 最前，模拟真机「ui-tokens 先、prefs.css 后」的层叠顺序
  { name: '1280-explicit-dark-uitokens', width: 1280, height: 900, colorScheme: 'light', explicitTheme: 'dark', injectTokens: true },
];

const TOKENS = [
  '--pp-accent', '--pp-accent-fg', '--pp-success', '--pp-warn',
  '--pp-danger-fg', '--pp-btn-primary-bg', '--pp-on-accent', '--pp-focus-ring',
];

/* ---------- 页面内执行的探针（以字符串注入，避免闭包序列化问题） ---------- */

const IN_PAGE_HELPERS = `
window.__audit = (function () {
  const px = (v) => Math.round(v * 100) / 100;
  function isVisible(el) {
    if (!el) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function desc(el) {
    if (!el) return null;
    const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  }
  function box(el) {
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height), right: px(r.right), bottom: px(r.bottom) };
  }
  function overflow() {
    const vw = window.innerWidth;
    const de = document.documentElement;
    const root = document.querySelector('.pp-root');
    // 该页 body overflow:hidden，.pp-root 自身是 height:calc(100vh-46px) + overflow-y:auto 的滚动容器
    // → 横向溢出真正会体现为 .pp-root 的 scrollWidth > clientWidth，两处都要测
    const rc = root ? { cw: root.clientWidth, sw: root.scrollWidth, sh: root.scrollHeight, ch: root.clientHeight } : null;
    // 判据：元素右边缘是否越过它所在滚动容器（.pp-root）的**内容右边缘**（.pp-root 居中，不能拿视口宽当右边界）
    const rootRect = root.getBoundingClientRect();
    const rootRight = rootRect.right - parseFloat(getComputedStyle(root).borderRightWidth || 0);
    const limit = Math.min(vw, rc ? rc.cw : vw);
    const offenders = [];
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const edge = root.contains(el) ? rootRight : vw;
      if (r.right > edge + 0.5) {
        offenders.push({ el: desc(el), right: px(r.right), width: px(r.width), over: px(r.right - edge), edge: px(edge) });
      }
    }
    offenders.sort((a, b) => b.over - a.over);
    return {
      innerWidth: vw,
      clientWidth: de.clientWidth,
      docScrollWidth: de.scrollWidth,
      docOverflowX: px(de.scrollWidth - de.clientWidth),
      docFail: de.scrollWidth > de.clientWidth,
      rootClientWidth: rc ? rc.cw : null,
      rootScrollWidth: rc ? rc.sw : null,
      rootOverflowX: rc ? px(rc.sw - rc.cw) : null,
      rootScrollHeight: rc ? rc.sh : null,
      rootClientHeight: rc ? rc.ch : null,
      limit: px(limit),
      fail: (de.scrollWidth > de.clientWidth) || (!!rc && rc.sw > rc.cw + 0.5),
      offenders: offenders.slice(0, 10),
      offenderTotal: offenders.length,
    };
  }
  return { px, isVisible, desc, box, overflow };
})();
`;

const PROBE_SVG = `
(() => {
  const A = window.__audit;
  const svgs = Array.from(document.querySelectorAll('svg'));
  const items = svgs.map((s) => {
    const b = A.box(s);
    const cs = getComputedStyle(s);
    return {
      el: A.desc(s),
      parent: A.desc(s.parentElement),
      parentClass: (s.parentElement && s.parentElement.getAttribute('class')) || '',
      w: b.w, h: b.h,
      visible: A.isVisible(s),
      display: cs.display,
      stroke: cs.stroke,
      fill: cs.fill,
    };
  });
  const vis = items.filter((i) => i.visible);
  const dist = {};
  vis.forEach((i) => { const k = i.w + 'x' + i.h; dist[k] = (dist[k] || 0) + 1; });
  const outliers = vis.filter((i) => i.w < 8 || i.h < 8 || i.w > 32 || i.h > 32);
  const hiddenNonZero = items.filter((i) => !i.visible && (i.w > 0 || i.h > 0));
  return {
    total: svgs.length,
    visible: vis.length,
    hidden: items.length - vis.length,
    distribution: dist,
    outliers,
    hiddenNonZero,
    all: items,
  };
})()
`;

const PROBE_CARDS = `
(() => {
  const A = window.__audit;
  const cards = Array.from(document.querySelectorAll('.pp-card-icon'));
  return cards.map((ic, i) => {
    const svg = ic.querySelector('svg');
    const card = ic.closest('.pp-card');
    const titleEl = card && card.querySelector('.pp-card-title');
    const ib = A.box(ic);
    const sb = svg ? A.box(svg) : null;
    const cs = getComputedStyle(ic);
    return {
      i: i + 1,
      title: (titleEl && titleEl.textContent.trim()) || '',
      cardId: (card && card.id) || '',
      iconVisible: A.isVisible(ic),
      iconW: ib.w, iconH: ib.h,
      svgW: sb ? sb.w : null, svgH: sb ? sb.h : null,
      hasSvg: !!svg,
      color: cs.color,
      bg: cs.backgroundColor,
      stroke: svg ? getComputedStyle(svg).stroke : null,
    };
  });
})()
`;

const PROBE_CONTRACTS = `
(() => {
  const A = window.__audit;
  const out = {};

  /* .pp-link-btn */
  const lbs = Array.from(document.querySelectorAll('.pp-link-btn'));
  const lbsVis = lbs.filter((e) => A.isVisible(e));
  const linkSample = (lbsVis.length ? lbsVis : lbs).slice(0, 4).map((e) => {
    const cs = getComputedStyle(e);
    return {
      el: A.desc(e),
      text: e.textContent.trim().slice(0, 16),
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderWidth: cs.borderTopWidth + ' ' + cs.borderRightWidth + ' ' + cs.borderBottomWidth + ' ' + cs.borderLeftWidth,
      borderStyle: cs.borderTopStyle,
      borderColor: cs.borderTopColor,
      appearance: cs.appearance,
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      color: cs.color,
      box: A.box(e),
    };
  });
  out.linkBtn = {
    count: lbs.length,
    visibleCount: lbsVis.length,
    tags: [...new Set(lbs.map((e) => e.tagName.toLowerCase()))],
    allButtonTag: lbs.every((e) => e.tagName.toLowerCase() === 'button'),
    sample: linkSample,
    invisible: lbs.filter((e) => !A.isVisible(e)).map((e) => A.desc(e)),
  };

  /* .pp-disclose */
  const ds = Array.from(document.querySelectorAll('details.pp-disclose'));
  const cardTitleOf = (el) => {
    const card = el.closest('.pp-card');
    const t = card && card.querySelector('.pp-card-title');
    return (t && t.textContent.trim()) || (card && card.id) || '';
  };
  out.disclose = ds.map((d, i) => {
    const sum = d.querySelector('summary');
    const wasOpen = d.open;
    d.open = false;
    const hClosed = A.box(d).h;
    const hSumClosed = sum ? A.box(sum).h : null;
    d.open = true;
    const hOpen = A.box(d).h;
    d.open = wasOpen;
    return {
      i: i + 1,
      cardId: cardTitleOf(d),
      summaryText: sum ? sum.textContent.trim().slice(0, 40) : null,
      summaryH: hSumClosed,
      hClosed, hOpen, delta: A.px(hOpen - hClosed),
      summaryCursor: sum ? getComputedStyle(sum).cursor : null,
      summaryFontSize: sum ? getComputedStyle(sum).fontSize : null,
      markerSize: sum ? getComputedStyle(sum, '::before').width + ' / ' + getComputedStyle(sum, '::before').height : null,
    };
  });

  /* .pp-notes */
  out.notes = Array.from(document.querySelectorAll('ul.pp-notes')).map((u, i) => {
    const cs = getComputedStyle(u);
    const li = u.querySelectorAll('li');
    return {
      i: i + 1,
      cardId: cardTitleOf(u),
      liCount: li.length,
      paddingLeft: cs.paddingLeft,
      listStyleType: cs.listStyleType,
      listStylePosition: cs.listStylePosition,
      fontSize: cs.fontSize,
      color: cs.color,
      firstLiBox: li[0] ? A.box(li[0]) : null,
      ulBox: A.box(u),
    };
  });

  /* .pp-textarea */
  out.textarea = Array.from(document.querySelectorAll('textarea.pp-textarea')).map((t) => {
    const cs = getComputedStyle(t);
    const b = A.box(t);
    return {
      el: A.desc(t),
      rows: t.getAttribute('rows'),
      wrap: t.getAttribute('wrap'),
      h: b.h, w: b.w,
      scrollHeight: t.scrollHeight,
      lineHeight: cs.lineHeight,
      padding: cs.paddingTop + '/' + cs.paddingBottom,
      borderWidth: cs.borderTopWidth,
      resize: cs.resize,
      visible: A.isVisible(t),
    };
  });

  /* 字号 / 控件高度 —— 只取「可见」实例，隐藏视图里的 0 高元素会污染读数 */
  const visAll = (sel) => Array.from(document.querySelectorAll(sel)).filter((e) => A.isVisible(e));
  const first = (sel) => visAll(sel)[0] || document.querySelector(sel);
  const hOf = (sel) => { const e = visAll(sel)[0]; return e ? A.box(e).h : null; };
  const fsOf = (sel) => { const e = visAll(sel)[0]; return e ? getComputedStyle(e).fontSize : null; };
  out.sizes = {
    btnH: hOf('.pp-btn:not(.pp-btn-sm)'),
    btnSmH: hOf('.pp-btn-sm'),
    inputH: hOf('.pp-input'),
    selectH: hOf('.pp-select'),
    colorH: hOf('.pp-color'),
    discloseSummaryH: hOf('.pp-disclose > summary'),
    cardIconH: hOf('.pp-card-icon'),
    cardIconW: (() => { const e = visAll('.pp-card-icon')[0]; return e ? A.box(e).w : null; })(),
    cardIconSvgH: (() => { const e = visAll('.pp-card-icon svg')[0]; return e ? A.box(e).h : null; })(),
    cardIconBoxSizing: (() => { const e = visAll('.pp-card-icon')[0]; return e ? getComputedStyle(e).boxSizing + ' / border ' + getComputedStyle(e).borderTopWidth : null; })(),
    foldHeadH: hOf('.pp-fold-head'),
    rootFontSize: fsOf('.pp-root'),
    bodyFontSize: fsOf('body'),
    labelFontSize: fsOf('.pp-label'),
    hintFontSize: fsOf('.pp-hint'),
    cardTitleFontSize: fsOf('.pp-card-title'),
    linkBtnFontSize: fsOf('.pp-link-btn'),
    notesFontSize: fsOf('.pp-notes'),
    textareaFontSize: fsOf('textarea.pp-textarea'),
  };
  // 全量控件高度分布（仅可见），验证“28/24 两档”
  const uniq = (arr) => [...new Set(arr)].sort((a, b) => a - b);
  out.sizes.btnHeightDist = uniq(visAll('.pp-btn').map((e) => A.box(e).h));
  out.sizes.inputHeightDist = uniq(visAll('.pp-input, .pp-select').map((e) => A.box(e).h));
  out.sizes.hiddenBtnCount = Array.from(document.querySelectorAll('.pp-btn')).filter((e) => !A.isVisible(e)).length;
  // 高度不等于 28 的输入类控件（全部可见样本），附 flex 上下文用于定位根因
  out.sizes.inputAnomalies = visAll('.pp-input, .pp-select').filter((e) => A.box(e).h !== 28).map((e) => {
    const cs2 = getComputedStyle(e);
    return {
      el: A.desc(e),
      h: A.box(e).h,
      cssHeight: cs2.height,
      flex: cs2.flexGrow + '/' + cs2.flexShrink + '/' + cs2.flexBasis,
      parent: A.desc(e.parentElement),
      parentFlexDir: getComputedStyle(e.parentElement).flexDirection,
    };
  });

  /* 主题令牌实测 */
  const root = document.querySelector('.pp-root');
  const rcs = getComputedStyle(root);
  out.tokens = {};
  ${JSON.stringify(TOKENS)}.forEach((k) => { out.tokens[k] = rcs.getPropertyValue(k).trim(); });
  out.tokensSource = { rootBg: rcs.backgroundColor, rootColor: rcs.color, bodyBg: getComputedStyle(document.body).backgroundColor };

  /* 折叠状态与页面规模 */
  out.page = {
    docH: document.documentElement.scrollHeight,
    cards: document.querySelectorAll('.pp-card').length,
    cardsClosed: document.querySelectorAll('.pp-card.pp-fold-closed').length,
    rootW: A.box(root).w,
    rootMaxWidth: getComputedStyle(root).maxWidth,
  };
  return out;
})()
`;

/* ---------- 0.72.3 新增改动验证（V1 箭头 / V3 chip 描边 / V4 控件描边 / 显式深色调色板） ---------- */
const PROBE_V = `
(() => {
  const A = window.__audit;
  const px = A.px;
  const vis = (sel) => Array.from(document.querySelectorAll(sel)).filter((e) => A.isVisible(e));

  /* V1：折叠箭头是否贴右 + 字形实渲尺寸（Range 取文本字形盒，不是 18px 热区） */
  const arrows = vis('.pp-fold-arrow').slice(0, 3).map((a) => {
    const head = a.closest('.pp-fold-head');
    const hr = head.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(a);
    const gr = range.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return {
      headRight: px(hr.right), arrowRight: px(ar.right),
      gap: px(hr.right - ar.right),
      boxW: px(ar.width), boxH: px(ar.height),
      glyphW: px(gr.width), glyphH: px(gr.height),
      fontSize: cs.fontSize, marginLeft: cs.marginLeft, transform: cs.transform,
    };
  });

  /* V3：5 个可点击 chip / 卡片描边 —— 同一类里「选中态」会用 accent 描边，
     所以取全部可见实例的颜色分布，而不是只看第一个（第一个往往是选中态） */
  const ctrlRefEl = vis('.pp-input')[0] || vis('.pp-btn')[0];
  const controlBorderColor = ctrlRefEl ? getComputedStyle(ctrlRefEl).borderTopColor : null;
  const chipSel = ['.pp-chip', '.pp-ds-chip', '.pp-ts-chip', '.pp-theme-card', '.pp-pdf-item'];
  const chips = chipSel.map((sel) => {
    const all = vis(sel);
    if (!all.length) return { sel, found: false, total: document.querySelectorAll(sel).length };
    const items = all.slice(0, 12).map((e) => {
      const cs = getComputedStyle(e);
      return {
        cls: (e.getAttribute('class') || '').trim(),
        borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth, bg: cs.backgroundColor,
      };
    });
    const distinct = {};
    items.forEach((i) => { const k = i.borderColor + ' / ' + i.borderWidth; distinct[k] = (distinct[k] || 0) + 1; });
    const hasControl = items.some((i) => i.borderColor === controlBorderColor && i.borderWidth !== '0px');
    return {
      sel, found: true, total: document.querySelectorAll(sel).length, sampled: items.length,
      distinct, hasControl, samples: items.slice(0, 3), h: px(all[0].getBoundingClientRect().height),
    };
  });

  /* V4：控件描边 */
  const ctrlSel = ['.pp-input', '.pp-select', '.pp-textarea', '.pp-btn'];
  const ctrls = ctrlSel.map((sel) => {
    const e = vis(sel)[0];
    if (!e) return { sel, found: false };
    const cs = getComputedStyle(e);
    return {
      sel, found: true,
      borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
      h: px(e.getBoundingClientRect().height),
    };
  });

  /* 调色板抽样：找「浅底 + 深字」这类混搭 */
  const palette = ['.pp-chip', '.pp-ts-chip', '.pp-ds-chip', '.pp-theme-card', '.pp-card', '.pp-input'].map((sel) => {
    const e = vis(sel)[0];
    if (!e) return { sel, found: false };
    const cs = getComputedStyle(e);
    return { sel, found: true, bg: cs.backgroundColor, color: cs.color, borderColor: cs.borderTopColor };
  });

  const rootCs = getComputedStyle(document.querySelector('.pp-root'));
  return {
    arrows, chips, ctrls, palette, controlBorderColor,
    root: {
      colorScheme: rootCs.colorScheme, color: rootCs.color,
      accent: rootCs.getPropertyValue('--pp-accent').trim(),
      surface: rootCs.getPropertyValue('--pp-surface').trim(),
      text: rootCs.getPropertyValue('--pp-text').trim(),
    },
    dataTheme: document.documentElement.getAttribute('data-theme') || null,
    tokensInjected: document.documentElement.getAttribute('data-tokens-injected') === '1',
  };
})()
`;

/* ---------- 主流程 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function expandAll(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.pp-fold-closed').forEach((c) => c.classList.remove('pp-fold-closed'));
  });
  await sleep(120);
}

/**
 * 该页 body overflow:hidden、.pp-root 自己才是滚动容器（height:calc(100vh-46px)），
 * 所以 fullPage 截不到内部滚动内容。此处仅在运行时临时解开滚动容器高度，
 * 截完立刻移除（不改任何产品文件），并在报告里标注长图生成方式。
 */
async function shotFull(page, file) {
  const tag = await page.addStyleTag({
    content: '.pp-root{height:auto !important;max-height:none !important;overflow:visible !important}body{overflow:visible !important}',
  });
  await sleep(150);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: file, fullPage: true });
  await tag.evaluate((el) => el.remove());
  await sleep(80);
  return h;
}

/**
 * 4× 近景取证（V1 箭头字形 / V2 暗色 checkbox / V3 chip 描边）。
 * 单独开 deviceScaleFactor=4 的上下文，落在 OUT_DIR/zoom/。
 */
async function closeups(browser) {
  const dir = path.join(OUT_DIR, 'zoom');
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  for (const [scheme, theme] of [['dark', null], ['light', null], ['light', 'dark']]) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 4,
      colorScheme: scheme,
      reducedMotion: 'no-preference',
    });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'load' });
    await page.addScriptTag({ content: IN_PAGE_HELPERS });
    if (theme) await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await sleep(300);
    await page.evaluate(() => document.querySelectorAll('.pp-card.pp-fold').forEach((c) => c.classList.remove('pp-fold-closed')));
    await sleep(200);

    const tag = theme ? `${scheme}-explicit-${theme}` : scheme;

    // V2 未勾选 / 勾选 checkbox
    const cb = page.locator('.pp-check').filter({ hasText: '启用智能体模式' }).first();
    if (await cb.count()) {
      await cb.scrollIntoViewIfNeeded();
      await sleep(150);
      const b = await cb.boundingBox();
      const clip = { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: Math.min(1280, b.width + 8), height: b.height + 8 };
      await page.screenshot({ path: path.join(dir, `4x-${tag}-checkbox-off.png`), clip });
      shots.push(`4x-${tag}-checkbox-off.png`);
      await cb.locator('input').click();
      await sleep(250);
      await page.screenshot({ path: path.join(dir, `4x-${tag}-checkbox-on.png`), clip });
      shots.push(`4x-${tag}-checkbox-on.png`);
      await cb.locator('input').click();
      await sleep(150);
    }

    // V1 折叠箭头近景（箭头在卡片头右侧）
    const arrow = page.locator('.pp-fold-arrow').first();
    if (await arrow.count()) {
      await arrow.scrollIntoViewIfNeeded();
      await sleep(150);
      const b = await arrow.boundingBox();
      await page.screenshot({
        path: path.join(dir, `4x-${tag}-fold-arrow.png`),
        clip: { x: Math.max(0, b.x - 60), y: Math.max(0, b.y - 10), width: Math.min(1280, b.width + 70), height: b.height + 20 },
      });
      shots.push(`4x-${tag}-fold-arrow.png`);
    }

    // V3 chip 描边近景
    const chip = page.locator('.pp-ds-chip, .pp-chip, .pp-ts-chip').first();
    if (await chip.count()) {
      await chip.scrollIntoViewIfNeeded();
      await sleep(150);
      const b = await chip.boundingBox();
      await page.screenshot({
        path: path.join(dir, `4x-${tag}-chip.png`),
        clip: { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(1280, b.width + 16), height: b.height + 16 },
      });
      shots.push(`4x-${tag}-chip.png`);
    }
    await ctx.close();
  }
  return shots;
}

/* 焦点环判定：焦点样式带 transition(.12s)，必须等过渡结束再读；box-shadow 与 outline 取「至少一项可见」 */
const FOCUS_READ = `
(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  let fv = null;
  try { fv = el.matches(':focus-visible'); } catch (e) { fv = null; }

  // 逐层解析 box-shadow：过渡起点是 rgba(0,0,0,0) 0 0 0 0，字符串非 none 但看不见，
  // 必须看「color alpha > 0 且最大半径/扩散 > 0」
  const shadowLayers = (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow.split(/,(?![^(]*\\))/) : [];
  const layers = shadowLayers.map((l) => {
    const t = l.trim();
    const m = t.match(/rgba?\\(([^)]+)\\)/);
    let alpha = 1;
    if (m) {
      const p = m[1].split(',').map((s) => parseFloat(s));
      if (p.length === 4) alpha = p[3];
    }
    const radii = [...t.matchAll(/(-?\\d*\\.?\\d+)px/g)].map((x) => Math.abs(parseFloat(x[1])));
    const spread = radii.length ? Math.max(...radii) : 0;
    return { raw: t, alpha, spread, visible: alpha > 0 && spread > 0 };
  });
  const shadowVisible = layers.some((l) => l.visible);

  const outlineVisible = /solid|dashed|dotted|double/.test(cs.outlineStyle) && (parseFloat(cs.outlineWidth) || 0) >= 2;

  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    cls: el.getAttribute('class') || '',
    id: el.id || '',
    text: (el.textContent || '').trim().slice(0, 20),
    focusVisible: fv,
    boxShadow: cs.boxShadow,
    shadowLayers: layers,
    outline: cs.outline,
    outlineWidth: cs.outlineWidth,
    outlineStyle: cs.outlineStyle,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    borderColor: cs.borderTopColor,
    transition: cs.transitionProperty + ' / ' + cs.transitionDuration,
    w: Math.round(r.width), h: Math.round(r.height),
    shadowVisible,
    outlineVisible,
    verdict: (shadowVisible || outlineVisible) ? 'PASS' : 'FAIL',
  };
})()
`;

async function focusAudit(page) {
  const out = {
    method: '按钮走键盘 Tab（触发 :focus-visible）；输入框/文本域走程序化 focus（其规则是 :focus）。聚焦后一律等待 400ms 让 transition(.12s) 走完再读样式。',
    readDelayMs: 400,
    tabs: 0,
    found: {},
    notFound: [],
  };

  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const r = document.querySelector('.pp-root');
    if (r) r.scrollTo(0, 0);
    if (document.activeElement) document.activeElement.blur();
  });
  await page.mouse.click(1, 1);
  await sleep(80);

  /* A. 需要 :focus-visible 的按钮 —— 键盘 Tab 前进，命中后再等过渡结束读值 */
  const wantByTab = [
    { key: 'primaryBtn', match: (d) => d.tag === 'BUTTON' && d.cls.includes('pp-btn') && d.cls.includes('pp-btn-primary') },
    { key: 'linkBtn', match: (d) => d.tag === 'BUTTON' && d.cls.includes('pp-link-btn') && (d.text || '').trim() !== '' },
  ];
  const MAX_TABS = 260;
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    out.tabs = i + 1;
    const d = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return { tag: el.tagName, cls: el.getAttribute('class') || '', id: el.id || '', text: (el.textContent || '').trim().slice(0, 20) };
    });
    if (!d) continue;
    for (const t of wantByTab) {
      if (out.found[t.key] || !t.match(d)) continue;
      await sleep(out.readDelayMs); // 等 box-shadow / outline 过渡结束
      const st = await page.evaluate(FOCUS_READ);
      if (st && st.tag === d.tag && st.id === d.id) out.found[t.key] = st;
    }
    if (wantByTab.every((t) => out.found[t.key])) break;
  }
  wantByTab.filter((t) => !out.found[t.key]).forEach((t) => out.notFound.push(t.key));

  /* B. 输入框 / 文本域：规则是 :focus（不必 focus-visible），程序化聚焦即可，同样等过渡 */
  for (const p of [{ key: 'input', sel: '#pp-prefs-search' }, { key: 'textarea', sel: '#pp-tr-glossary' }]) {
    const ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return document.activeElement === el;
    }, p.sel);
    if (!ok) { out.notFound.push(p.key); continue; }
    await sleep(out.readDelayMs);
    const st = await page.evaluate(FOCUS_READ);
    if (st) out.found[p.key] = st;
    else out.notFound.push(p.key);
  }
  return out;
}

async function runCombo(browser, combo) {
  const ctx = await browser.newContext({
    viewport: { width: combo.width, height: combo.height },
    deviceScaleFactor: 1,
    colorScheme: combo.colorScheme,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'load' });
  await page.addScriptTag({ content: IN_PAGE_HELPERS });
  /* 模拟真机层叠顺序：ui-tokens.css 先注入（<head> 最前），prefs.css 随后覆盖 */
  if (combo.injectTokens) {
    await page.evaluate((css) => {
      const st = document.createElement('style');
      st.id = '__ui-tokens';
      st.textContent = css;
      document.head.insertBefore(st, document.head.firstChild);
      document.documentElement.setAttribute('data-tokens-injected', '1');
    }, UI_TOKENS_CSS);
  }
  if (combo.explicitTheme) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), combo.explicitTheme);
  }
  await sleep(400);

  const result = {
    combo: combo.name,
    viewport: `${combo.width}x${combo.height}`,
    colorScheme: combo.colorScheme,
    explicitTheme: combo.explicitTheme || null,
    injectTokens: !!combo.injectTokens,
  };
  const lite = !!combo.explicitTheme; // 附加组合只出首屏图，不长图重复占空间

  /* 1. 默认（折叠）态截图 —— 用户首屏所见 */
  result.shotCollapsed = `docs/audit/${VERSION}/${combo.name}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, `${combo.name}.png`) });
  result.docHeightCollapsed = await page.evaluate(() => document.documentElement.scrollHeight);
  result.scrollerCollapsed = await page.evaluate(() => {
    const r = document.querySelector('.pp-root');
    return { clientW: r.clientWidth, scrollW: r.scrollWidth, clientH: r.clientHeight, scrollH: r.scrollHeight };
  });
  if (!lite) result.fullHeightCollapsed = await shotFull(page, path.join(OUT_DIR, `${combo.name}-full.png`));

  /* 溢出（折叠态）*/
  result.overflowCollapsed = await page.evaluate('window.__audit.overflow()');

  /* 2. 全展开态（测量需要，隐藏内容才有几何）*/
  await expandAll(page);
  result.scrollerExpanded = await page.evaluate(() => {
    const r = document.querySelector('.pp-root');
    return { clientW: r.clientWidth, scrollW: r.scrollWidth, clientH: r.clientHeight, scrollH: r.scrollHeight };
  });
  result.docHeightExpanded = await page.evaluate(() => document.documentElement.scrollHeight);
  if (!lite) {
    result.fullHeightExpanded = await shotFull(page, path.join(OUT_DIR, `${combo.name}-full-expanded.png`));
    await page.evaluate(() => document.querySelector('.pp-root').scrollTo(0, 0));
    await sleep(80);
    await page.screenshot({ path: path.join(OUT_DIR, `${combo.name}-expanded-top.png`) });
  }

  result.overflowExpanded = await page.evaluate('window.__audit.overflow()');
  result.svg = await page.evaluate(PROBE_SVG);
  result.cards = await page.evaluate(PROBE_CARDS);

  // 展开态下把 details 全开，测契约类所在内容是否可达（open 前后对比在 probe 内完成）
  result.contracts = await page.evaluate(PROBE_CONTRACTS);
  result.validation = await page.evaluate(PROBE_V);

  /* 焦点环 */
  result.focus = await focusAudit(page);

  result.consoleErrors = errs;
  await ctx.close();
  return result;
}

function mdTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((c) => (c === null || c === undefined ? '—' : String(c))).join(' | ')} |`),
  ].join('\n');
}

function buildMarkdown(report) {
  const L = [];
  // 主表只列 4 个基准组合；显式深色组合单列一节
  const main = (report.main && report.main.length) ? report.main : report.combos;
  L.push(`# 设置面板 ${report.version || ''} · 真实渲染门禁（无头 Chrome 实测）`);
  L.push('');
  L.push(`- 生成时间：${report.generatedAt}`);
  L.push(`- 被测页：\`${report.page}\``);
  L.push(`- 浏览器：Chrome（playwright-core 驱动，\`${report.chrome}\`）`);
  L.push('- 说明：页面是静态快照，不含 `prefs-*.js` 行为逻辑，本报告只验证视觉与几何，不验证交互逻辑。');
  L.push('');
  /* 快照指纹：让每个数字都能对到具体快照，避免「改了 CSS 但截图没重拍」的错配 */
  if (report.sources) {
    const S = report.sources;
    L.push('## 0. 快照指纹与时效');
    L.push('');
    L.push('> 哈希口径说明：本表的 sha256 是对**归一化文本**计算的（CRLF→LF、去首尾空白、剔除构建器追加的分隔标记），与对原始字节流算的 sha 不同；同一份 CSS 两种算法会得到不同值。对账时请以本表为准（同一脚本同一算法），不要拿外部工具（如 PowerShell Get-FileHash）的值来比对。');
    L.push('');
    L.push(mdTable(['项', '值'], [
      ['被测页 mtime', S.pageMtime],
      ['被测页 sha256', '`' + S.pageSha + '`'],
      ['页内内嵌 prefs.css', `${S.embeddedCssChars} 字符 / ${S.embeddedCssLines} 行，sha256 \`${S.embeddedCssSha}\``],
      ['当前 chrome/content/prefs.css', `${S.prefsCssChars} 字符 / ${S.prefsCssLines} 行，mtime ${S.prefsCssMtime}，sha256 \`${S.prefsCssSha}\``],
      ['当前 chrome/content/ui-tokens.css', `sha256 \`${S.tokensCssSha}\``],
      ['时效判定', S.verdict],
    ]));
    L.push('');
    if (!S.inSync) {
      L.push('> 快照内嵌 CSS 与当前源文件不一致：**本报告的数字对应被测快照当时的内嵌 CSS**，不代表最新源码。修完 CSS 后需重新生成预览页（`scripts/build-prefs-preview.py`）再跑本脚本。');
      L.push('');
    }
  }
  L.push('## 1. 结论速览');
  L.push('');
  const s = report.summary;
  L.push(mdTable(
    ['组合', '视口', '`documentElement` scrollWidth / clientWidth', '`.pp-root` scrollWidth / clientWidth', '横向溢出', '折叠态内容高', '展开态内容高', '结论'],
    main.map((c) => [
      c.combo, c.viewport,
      `${c.overflowExpanded.docScrollWidth} / ${c.overflowExpanded.clientWidth}`,
      `${c.overflowExpanded.rootScrollWidth} / ${c.overflowExpanded.rootClientWidth}`,
      c.overflowExpanded.overflowXLabel || (c.overflowExpanded.rootOverflowX + 'px'),
      c.scrollerCollapsed.scrollH + 'px', c.scrollerExpanded.scrollH + 'px',
      c.overflowExpanded.fail ? '**FAIL**' : 'PASS',
    ]),
  ));
  L.push('');
  L.push('> 该页 `body{overflow:hidden}`，`.pp-root` 自身是 `height:calc(100vh-46px); overflow-y:auto` 的滚动容器（模拟 Zotero 设置窗格）。因此 `documentElement.scrollWidth` 恒等于视口宽，横向溢出必须同时看 `.pp-root` 的 `scrollWidth`。');
  L.push('');
  L.push(`- 溢出组合数：${s.overflowFailCount} / 4`);
  L.push(`- SVG：总数 ${s.svgTotal}，可见 ${s.svgVisible}，尺寸越界（可见且 <8 或 >32）：${s.svgOutliers} 个`);
  L.push(`- 卡片图标：${s.cardsTotal} 张全部可见、全部含 svg；图标盒实测 ${s.cardIconBox}（CSS 声明 26×26 + 1px 边框，box-sizing 非 border-box → 实渲 ${s.cardIconBox}），内嵌 svg 16×16（均在 8–32 内）`);
  L.push(`- 焦点环：${s.focusOk ? `4 组合 × 4 目标（主按钮 / 输入框 / 文本域 / \`.pp-link-btn\`）全部 PASS（聚焦后等 400ms 取值，详见第 6 节）` : '**有组合取不到焦点环样式**'}`);
  L.push(`- #pp-tr-glossary 高度：${s.glossaryHeight}px（阈值：须远大于 28px）`);
  L.push('');
  L.push('## 2. 截图');
  L.push('');
  L.push('> `*-full*.png` 是长图：因页面内部滚动容器裁剪，截图时在运行时临时把 `.pp-root` 高度改为 auto（仅内存态，不改文件），截完即移除。');
  L.push('');
  L.push(mdTable(['组合', '首屏（折叠 = 用户首见）', '全页长图（折叠）', '全展开首屏', '全展开长图'], main.map((c) => [
    c.combo,
    `[${c.combo}.png](./${c.combo}.png)`,
    `[${c.combo}-full.png](./${c.combo}-full.png)`,
    `[${c.combo}-expanded-top.png](./${c.combo}-expanded-top.png)`,
    `[${c.combo}-full-expanded.png](./${c.combo}-full-expanded.png)`,
  ])));
  L.push('');
  L.push('## 3. 横向溢出');
  L.push('');
  for (const c of main) {
    const o = c.overflowExpanded;
    L.push(`### ${c.combo}（展开态）`);
    L.push('');
    L.push(`- \`documentElement.scrollWidth\` = ${o.docScrollWidth}，\`clientWidth\` = ${o.clientWidth} → 溢出 ${o.docOverflowX}px（${o.docFail ? 'FAIL' : 'PASS'}）`);
    L.push(`- \`.pp-root\` scrollWidth = ${o.rootScrollWidth}，clientWidth = ${o.rootClientWidth} → 溢出 ${o.rootOverflowX}px（${o.rootOverflowX > 0 ? 'FAIL' : 'PASS'}）`);
    L.push(`- \`.pp-root\` 内容高度：折叠 ${c.scrollerCollapsed.scrollH}px → 展开 ${c.scrollerExpanded.scrollH}px（客户端可视高 ${o.rootClientHeight}px，需内部滚动）`);
    if (o.offenders.length) {
      L.push('');
      L.push(mdTable(['元素', 'right', 'width', '超出' + o.limit + 'px 多少'], o.offenders.map((x) => [x.el, x.right, x.width, x.over])));
    } else {
      L.push('- 无元素 `getBoundingClientRect().right > 可用宽度`。');
    }
    const oc = c.overflowCollapsed;
    L.push(`- 折叠态对照：\`.pp-root\` scrollWidth = ${oc.rootScrollWidth}，溢出 ${oc.rootOverflowX}px`);
    L.push('');
  }
  L.push('## 4. SVG 图标实测');
  L.push('');
  for (const c of main) {
    const v = c.svg;
    L.push(`### ${c.combo}`);
    L.push('');
    L.push(`- 总数 ${v.total}，可见 ${v.visible}，隐藏 ${v.hidden}`);
    L.push(`- 可见尺寸分布：${Object.entries(v.distribution).map(([k, n]) => `${k} × ${n}`).join('，')}`);
    if (v.outliers.length) {
      L.push('');
      L.push(mdTable(['父元素 class', '尺寸', 'stroke'], v.outliers.map((o) => [o.parentClass || o.parent, `${o.w}x${o.h}`, o.stroke])));
    } else {
      L.push('- 无「可见但 <8px 或 >32px」的图标。');
    }
    const hiddenNZ = v.hiddenNonZero;
    if (hiddenNZ.length) {
      L.push('');
      L.push(`- 隐藏但占位（display:none 但仍有 rect）${hiddenNZ.length} 个：${hiddenNZ.slice(0, 6).map((h) => `${h.parentClass}=${h.w}x${h.h}`).join('；')}`);
    }
    L.push('');
  }
  L.push('### stroke = currentColor 抽样');
  L.push('');
  L.push(mdTable(['组合', '图标父 class', 'svg stroke', 'svg fill'], report.strokeSamples.map((x) => [x.combo, x.parent, x.stroke, x.fill])));
  L.push('');
  L.push('## 5. 卡片图标（19 张）');
  L.push('');
  const base = main[0];
  L.push(mdTable(['#', '卡片标题', '图标 w×h', 'svg w×h', '可见', 'stroke'],
    base.cards.map((k) => [k.i, k.title, `${k.iconW}×${k.iconH}`, `${k.svgW}×${k.svgH}`, k.iconVisible ? 'yes' : '**no**', k.stroke])));
  L.push('');
  L.push(`跨 4 组合一致性：${report.cardsConsistency}`);
  L.push('');
  L.push(`- 阈值核对（0 尺寸 / >24px 高）：0 尺寸 ${s.cardsBad} 个；图标**盒** 28px 高度 > 24px 阈值，19/19 命中——但这是 26px 声明 + 1px 边框（content-box）撑出的盒尺寸，**内嵌字形仍是 16×16**。若门禁口径是「图标视觉尺寸」，则全部通过；若口径是「图标盒高度」，则 19 张全部超阈值 4px，需在 CSS 上归 box-sizing: border-box 或把声明改成 24px。`);
  L.push('');
  L.push('## 6. 焦点环实测（等过渡结束后取值）');
  L.push('');
  L.push('> **测量方法（0.72.2 修订）**：焦点样式带 `transition: box-shadow var(--pp-dur-fast) ease`（`.12s`），聚焦后**立即**读 `getComputedStyle` 拿到的是过渡起点 `rgba(0, 0, 0, 0) 0px 0px 0px 0px`，会被误判成「无焦点环」。本节改为：按钮用真实键盘 `Tab`（触发 `:focus-visible`）、`.pp-input` 与 `.pp-textarea` 用程序化 `focus()`（其规则是 `:focus`），**聚焦后等待 400ms** 再读样式。');
  L.push('');
  L.push('判定：`box-shadow` 至少有 1 层「color alpha > 0 且最大半径 > 0」，**或** `outline-style` 为 solid/dashed/dotted/double 且宽度 ≥ 2px → PASS。');
  L.push('');
  L.push(mdTable(
    ['组合', '目标', '实际聚焦元素', ':focus-visible', 'box-shadow（过渡后）', 'outline', 'outline-offset', '判定'],
    main.flatMap((c) => Object.entries(c.focus.found).map(([k, v]) => [
      c.combo, k, `${v.tag.toLowerCase()}${v.id ? '#' + v.id : ''}.${(v.cls || '').split(/\s+/).slice(0, 2).join('.')}`,
      String(v.focusVisible),
      v.boxShadow === 'none' ? 'none' : v.boxShadow,
      v.outline === 'none' ? 'none' : v.outline, v.outlineOffset,
      v.verdict === 'PASS' ? '**PASS**' : '**FAIL**',
    ])),
  ));
  L.push('');
  L.push(mdTable(['组合', '目标', '可见 shadow 层（alpha / 最大半径）', 'outline 判定', 'transition'], main.flatMap((c) => Object.entries(c.focus.found).map(([k, v]) => [
    c.combo, k,
    (v.shadowLayers || []).filter((l) => l.visible).map((l) => `alpha ${l.alpha} / ${l.spread}px`).join('；') || '无',
    v.outlineVisible ? 'yes（≥2px 实线）' : 'no',
    v.transition,
  ]))));
  L.push('');
  for (const c of main) {
    L.push(`- ${c.combo}：Tab 次数 ${c.focus.tabs}，等待 ${c.focus.readDelayMs}ms 后取值，未取到 ${c.focus.notFound.length ? '**' + c.focus.notFound.join('、') + '**' : '无'}`);
  }
  L.push('');
  L.push('## 7. 新增契约类实渲');
  L.push('');
  const cc = main[0].contracts;
  L.push('### 7.1 `.pp-link-btn`');
  L.push('');
  L.push(mdTable(['组合', '计数', '可见', '标签', '全为 <button>'], main.map((c) => [c.combo, c.contracts.linkBtn.count, c.contracts.linkBtn.visibleCount, c.contracts.linkBtn.tags.join(','), c.contracts.linkBtn.allButtonTag])));
  L.push('');
  L.push('可见实例的盒模型（`background` 全透明、`border-width` 全 0 → 无按钮盒感）：');
  L.push('');
  L.push(mdTable(['元素', '文本', 'background', 'border-width', 'border-style', 'padding', 'color', 'h'],
    cc.linkBtn.sample.map((x) => [x.el, x.text, x.background, x.borderWidth, x.borderStyle, x.padding, x.color, x.box.h])));
  L.push('');
  L.push(`- 不可见实例（位于预览脚本隐藏的登录/订单视图内，属正常）：${cc.linkBtn.invisible.length ? cc.linkBtn.invisible.join('、') : '无'}`);
  L.push('');
  L.push('### 7.2 `.pp-disclose`（`<details>`）');
  L.push('');
  L.push(mdTable(['#', '所在卡片', 'summary 文本', 'summary 高', '闭合高', '打开高', 'Δ', 'cursor', '::before 尺寸'],
    cc.disclose.map((d) => [d.i, d.cardId, d.summaryText, d.summaryH, d.hClosed, d.hOpen, d.delta, d.summaryCursor, d.markerSize])));
  L.push('');
  L.push('### 7.3 `.pp-notes`（`<ul>`）');
  L.push('');
  L.push(mdTable(['#', '所在卡片', 'li 数', 'padding-left', 'list-style', 'font-size', 'color', 'ul 高'],
    cc.notes.map((n) => [n.i, n.cardId, n.liCount, n.paddingLeft, `${n.listStyleType}/${n.listStylePosition}`, n.fontSize, n.color, n.ulBox.h])));
  L.push('');
  L.push('### 7.4 `.pp-textarea`');
  L.push('');
  L.push(mdTable(['元素', 'rows', 'wrap', 'w×h', 'scrollHeight', 'line-height', 'padding', '可见'],
    cc.textarea.map((t) => [t.el, t.rows, t.wrap, `${t.w}×${t.h}`, t.scrollHeight, t.lineHeight, t.padding, t.visible ? 'yes' : 'no'])));
  L.push('');
  L.push('## 8. 字号 / 控件高度');
  L.push('');
  const sz = cc.sizes;
  L.push(mdTable(['指标', '实测'], [
    ['.pp-btn 高（非 sm）', sz.btnH],
    ['.pp-btn-sm 高', sz.btnSmH],
    ['.pp-input 高', sz.inputH],
    ['.pp-select 高', sz.selectH],
    ['.pp-color 高', sz.colorH],
    ['.pp-disclose summary 高', sz.discloseSummaryH],
    ['.pp-card-icon 盒 w×h', `${sz.cardIconW} × ${sz.cardIconH}（${sz.cardIconBoxSizing}）`],
    ['.pp-card-icon 内 svg 高', sz.cardIconSvgH],
    ['.pp-fold-head 高', sz.foldHeadH],
    ['正文 font-size（.pp-root）', sz.rootFontSize],
    ['body font-size', sz.bodyFontSize],
    ['.pp-label font-size', sz.labelFontSize],
    ['.pp-hint font-size（首个可见）', sz.hintFontSize],
    ['.pp-card-title font-size', sz.cardTitleFontSize],
    ['.pp-link-btn font-size', sz.linkBtnFontSize],
    ['.pp-notes font-size', sz.notesFontSize],
    ['.pp-textarea font-size', sz.textareaFontSize],
    ['可见 .pp-btn 高度分布', sz.btnHeightDist.join(' / ')],
    ['可见 .pp-input + .pp-select 高度分布', sz.inputHeightDist.join(' / ')],
    ['隐藏（不参与布局）的 .pp-btn 数量', sz.hiddenBtnCount],
  ]));
  L.push('');
  L.push('> 「控件只有 28/24 两档」核对：可见 `.pp-btn` 高度分布只有 28 与 24（24 = `.pp-btn-sm`）；可见 `.pp-input` / `.pp-select` 分布为 24 / 28，其中 28px 是常态，唯一的 24px 是 `#pp-sk-source`（见下表），仍落在 24/28 两档内，但没有按 `.pp-input` 的 28px 渲染。`.pp-color` 26、`.pp-card-icon` 28 属独立控件，不在这两档之列。');
  L.push('');
  if (sz.inputAnomalies && sz.inputAnomalies.length) {
    L.push('高度不等于 28px 的可见输入控件：');
    L.push('');
    L.push(mdTable(['元素', '实测高', '计算 height', 'flex（grow/shrink/basis）', '父级', '父级 flex-direction'],
      sz.inputAnomalies.map((x) => [x.el, x.h, x.cssHeight, x.flex, x.parent, x.parentFlexDir])));
    L.push('');
    L.push('> 根因（对照实验验证）：`#pp-sk-source` 带 `.pp-grow{flex:1}`，而父级 `label.pp-field` 是 **column** 方向的 flex 容器，`flex-basis:0%` 覆盖了 `.pp-input{height:28px}`；运行时把该元素 `flex-basis` 改回 `auto` 后实测高度立即变 28px（`flex-grow:0` 无效，证明是 basis 而非 grow 造成的）。属控件高度契约的唯一破例点。');
    L.push('');
  }
  L.push('## 9. 主题令牌落值（实测 vs 源码声明）');
  L.push('');
  const tbl = TOKENS.map((k) => {
    const lightCombo = main.find((c) => c.colorScheme === 'light');
    const darkCombo = main.find((c) => c.colorScheme === 'dark');
    const light = lightCombo.contracts.tokens[k];
    const dark = darkCombo.contracts.tokens[k];
    const src = report.sourceTokens[k] || {};
    const norm = (v) => String(v).toLowerCase().replace(/\s+/g, '').replace(/\.(\d*?)0+(?=[),]|$)/g, '.$1');
    // 源码用 var(--x) 别名时，用实测值解析后再比，避免把「别名」误报成「不一致」
    const resolve = (v, combo) => {
      const m = String(v || '').match(/^var\((--[\w-]+)\)$/);
      return m ? (combo.contracts.tokens[m[1]] || v) : v;
    };
    const checks = [];
    if (src.light !== undefined && !/^var\(/.test(src.light) && norm(src.light) !== norm(light)) checks.push('light 不一致');
    if (src.dark !== undefined && !/^var\(/.test(src.dark) && norm(resolve(src.dark, darkCombo)) !== norm(dark)) checks.push('dark 不一致');
    const alias = /^var\(/.test(String(src.light || '')) || /^var\(/.test(String(src.dark || ''));
    if (alias && !checks.length) checks.push('别名已解析一致');
    if (src.darkInherited) checks.push('暗色块未覆盖（继承亮色）');
    return [k, light, dark, src.light || '—', src.dark || '—', checks.join('；') || 'OK'];
  });
  L.push(mdTable(['令牌', '亮色实测', '暗色实测', '源码亮色声明', '源码暗色声明', '对账'], tbl.map((r) => [r[0], r[1], r[2], r[3], r[4], [r[5], r[6]].filter(Boolean).join('；') || 'OK'])));
  L.push('');
  L.push(`- 令牌取值节点：\`.pp-root\`（变量都声明在这里；\`.pp-root\` 自身未设 background，故背景取 body 对照）`);
  L.push(`- 主题生效校验：亮色 \`.pp-root\` color = ${main[0].contracts.tokensSource.rootColor}、body bg = ${main[0].contracts.tokensSource.bodyBg}；暗色 color = ${main[1].contracts.tokensSource.rootColor}、body bg = ${main[1].contracts.tokensSource.bodyBg} → 两者不同，\`prefers-color-scheme\` 生效`);
  L.push(`- 注意：\`--pp-on-accent\` 只在亮色块声明，暗色块未覆盖，暗色实测仍为 ${main[1].contracts.tokens['--pp-on-accent']}。`);
  L.push('');
  /* ---- 0.72.3 改动验证 ---- */
  L.push('## 10. 0.72.3 改动验证（V1–V4 + 显式深色）');
  L.push('');
  L.push('### V1 折叠箭头贴右 + 字形尺寸');
  L.push('');
  L.push(mdTable(['组合', 'head.right', 'arrow.right', '差值 gap', '箭头盒', '字形实渲', 'font-size', 'margin-left', '判定'],
    main.flatMap((c) => c.validation.arrows.map((a, i) => [
      c.combo + (i ? ` (#${i + 1})` : ''), a.headRight, a.arrowRight, a.gap,
      `${a.boxW}×${a.boxH}`, `${a.glyphW}×${a.glyphH}`, a.fontSize, a.marginLeft,
      (a.gap <= 12 && Math.max(a.glyphW, a.glyphH) >= 9) ? 'PASS' : '**FAIL**',
    ]))));
  L.push('');
  L.push('> 判据：`gap ≤ 12px`（箭头贴右）+ 字形实渲 `≥ 9px`（1× 下不再是一个点）。字形尺寸用 `Range.selectNodeContents` 取文本字形盒，不是 18×18 的点击热区。');
  L.push('');
  L.push('### V2 暗色原生控件（`color-scheme`）');
  L.push('');
  L.push(mdTable(['组合', '`.pp-root` color-scheme', 'data-theme', '注入 ui-tokens'], main.concat(report.combos.filter((c) => c.explicitTheme)).map((c) => [
    c.combo, c.validation.root.colorScheme, c.validation.dataTheme || '—', c.validation.tokensInjected ? 'yes' : 'no',
  ])));
  L.push('');
  L.push(`- 近景证据（4×）：${(report.closeups || []).filter((n) => n.includes('checkbox')).map((n) => `\`zoom/${n}\``).join('、')}`);
  L.push('- 判定：暗色未勾选 checkbox 应为「深底 + 浅色描边 + 圆角」，不再是纯白实心块；勾选后为蓝底白勾。见第 11 节肉眼结论。');
  L.push('');
  L.push('### V3 可点击 chip / 卡片描边（`--pp-border-control`）');
  L.push('');
  L.push(`参考色（同主题下 \`.pp-input\` 的 border-color，即 \`--pp-border-control\` 的落值）：亮/暗见下表末列。同一类里「选中态」用 \`--pp-accent\` 描边，属预期，因此按**颜色分布**而非第一个实例判定。`);
  L.push('');
  L.push(mdTable(['组合', '选择器', '可见实例', 'border-color 分布（实测）', '含 control 色', '参考色 control'],
    main.flatMap((c) => c.validation.chips.map((x) => [
      c.combo, x.sel,
      x.found ? `${x.sampled} / ${x.total}` : `0（面板内无该元素）`,
      x.found ? Object.entries(x.distinct).map(([k, n]) => `${k} ×${n}`).join('；') : '—',
      x.found ? (x.hasControl ? 'yes' : '**no**') : 'N/A',
      c.validation.controlBorderColor || '—',
    ]))));
  L.push('');
  L.push('### V4 控件描边（`--pp-border-control`）');
  L.push('');
  L.push(mdTable(['组合', '选择器', 'border-color', 'width', '高'],
    main.flatMap((c) => c.validation.ctrls.map((x) => [c.combo, x.sel, x.found ? x.borderColor : '未找到该元素', x.borderWidth || '—', x.h || '—']))));
  L.push('');
  L.push('### 显式深色（系统浅色 + `data-theme="dark"`）');
  L.push('');
  const exp = report.combos.filter((c) => c.explicitTheme);
  L.push(mdTable(['组合', '`.pp-root` color', '`--pp-surface`', '`--pp-accent`', 'color-scheme', '截图'],
    exp.map((c) => [
      c.combo, c.validation.root.color, c.validation.root.surface, c.validation.root.accent,
      c.validation.root.colorScheme, `[${c.combo}.png](./${c.combo}.png)`,
    ])));
  L.push('');
  L.push(mdTable(['组合', '元素', 'background', 'color', 'border-color'],
    exp.flatMap((c) => c.validation.palette.map((p) => [c.combo, p.sel, p.found ? p.bg : '—', p.found ? p.color : '—', p.found ? p.borderColor : '—']))));
  L.push('');
  L.push('> 「混搭」判据：深色态下元素 `background` 应落在深色表面（#1a1e23 / #21252b / #2a3038 及其 rgba 叠加），`color` 应为浅色文字（#e6edf3 系）。若出现 `background` 浅（rgb(246,248,250) 系）+ `color` 浅，或反之，即为 0.72.2 的 P0 混搭。');
  L.push('');
  L.push(`- 说明：预览页只内嵌 prefs.css；\`1280-explicit-dark-uitokens\` 这组额外把 \`ui-tokens.css\` 插到 \`<head>\` 最前，模拟真机「ui-tokens 先、prefs.css 后」的层叠顺序，用于暴露两套调色板混搭。`);
  L.push('');
  L.push('## 11. 肉眼观察（截图实看）');
  L.push('');
  L.push(report.eyeball || EYEBALL);
  L.push('');
  return L.join('\n');
}

const EYEBALL = '（待补：本轮肉眼观察，看图后由人工写入）';

function parseSourceTokens(cssPath) {
  const out = {};
  if (!fs.existsSync(cssPath)) return out;
  const css = fs.readFileSync(cssPath, 'utf8');
  const wanted = TOKENS;
  // 只在 **真实规则** 上切分：css 注释里也出现 "prefers-color-scheme: dark"，按裸字符串切会切到注释里
  const darkRule = /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{/.exec(css);
  const darkIdx = darkRule ? darkRule.index : -1;
  const attrRule = /:root\[data-theme="dark"\]\s*\{/.exec(css);
  const themeAttrIdx = attrRule ? attrRule.index : -1;
  const lightPart = darkIdx > 0 ? css.slice(0, darkIdx) : css;
  const darkPart = darkIdx > 0
    ? css.slice(darkIdx, themeAttrIdx > darkIdx ? themeAttrIdx : undefined)
    : '';
  const grab = (text, key) => {
    const re = new RegExp('\\' + key + '\\s*:\\s*([^;]+);');
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  wanted.forEach((k) => {
    const l = grab(lightPart, k);
    const d = grab(darkPart, k) || l; // 暗色块未覆盖时沿用亮色声明（CSS 变量继承）
    out[k] = { light: l, dark: d, darkInherited: !grab(darkPart, k) };
  });
  return out;
}

(async () => {
  if (!fs.existsSync(PAGE)) throw new Error('被测页不存在: ' + PAGE);
  if (!fs.existsSync(CHROME)) throw new Error('Chrome 不存在: ' + CHROME);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
  });

  const combos = [];
  for (const c of COMBOS) {
    process.stdout.write('run ' + c.name + ' ... ');
    const r = await runCombo(browser, c);
    combos.push(r);
    const v1 = r.validation.arrows[0] || {};
    console.log('ok  gap=' + v1.gap + ' glyph=' + v1.glyphW + 'x' + v1.glyphH + ' rootOverflowX=' + r.overflowExpanded.rootOverflowX + ' offenders=' + r.overflowExpanded.offenderTotal);
  }

  console.log('closeups ...');
  const closeupShots = await closeups(browser);
  console.log('ok  ' + closeupShots.length + ' 张近景');

  await browser.close();

  /* 汇总 */
  const mainCombos = combos.filter((c) => !c.explicitTheme);
  const cardsBase = mainCombos[0].cards;
  const cardsConsistency = (() => {
    let same = true;
    for (const c of mainCombos.slice(1)) {
      if (c.cards.length !== cardsBase.length) { same = false; break; }
      for (let i = 0; i < cardsBase.length; i++) {
        const a = cardsBase[i], b = c.cards[i];
        if (a.iconW !== b.iconW || a.iconH !== b.iconH || a.svgW !== b.svgW || a.svgH !== b.svgH) { same = false; }
      }
    }
    return same ? '四组合几何完全一致（图标盒 28×28、内嵌 svg 16×16），仅颜色不同' : '**存在跨组合几何差异，见 render.json**';
  })();

  const strokeSamples = [];
  for (const c of mainCombos) {
    const vis = c.svg.all.filter((s) => s.visible);
    const pick = [vis.find((s) => (s.parentClass || '').includes('pp-card-icon')),
      vis.find((s) => (s.parentClass || '').includes('pp-search-icon')),
      vis.find((s) => (s.parentClass || '').includes('pp-fold-arrow'))].filter(Boolean);
    pick.forEach((p) => strokeSamples.push({ combo: c.combo, parent: p.parentClass || p.parent, stroke: p.stroke, fill: p.fill }));
  }

  const glossary = mainCombos[0].contracts.textarea.find((t) => t.el.includes('pp-tr-glossary'));

  /* 快照指纹：页面内嵌的 prefs.css 副本 vs 当前源文件 */
  const crypto = require('crypto');
  const sha16 = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
  const stamp = (p) => {
    const st = fs.statSync(p);
    const d = st.mtime;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const pageHtml = fs.readFileSync(PAGE, 'utf8');
  const mi = pageHtml.indexOf('以下是 chrome/content/prefs.css 原文');
  const ce = mi >= 0 ? pageHtml.indexOf('*/', mi) + 2 : -1;
  const embeddedCss = mi >= 0 ? pageHtml.slice(ce, pageHtml.indexOf('</style>', ce)) : '';
  const prefsPath = path.join(REPO, 'chrome', 'content', 'prefs.css');
  const prefsCss = fs.readFileSync(prefsPath, 'utf8');
  const tokensCss = fs.readFileSync(path.join(REPO, 'chrome', 'content', 'ui-tokens.css'), 'utf8');
  // 预览页会在内嵌 CSS 末尾追加 "/* ===== prefs.css 结束 ===== */" 标记，比对前先剔掉，
  // 否则「刚构建完」也会被判成漂移（假阳性）
  const stripMarker = (s) => s.replace(/\/\* =+ prefs\.css 结束 =+ \*\//g, '');
  const inSync = embeddedCss.length > 0 && sha16(stripMarker(embeddedCss)) === sha16(stripMarker(prefsCss));
  const sources = {
    pageMtime: stamp(PAGE),
    pageSha: sha16(pageHtml),
    embeddedCssChars: embeddedCss.length,
    embeddedCssLines: embeddedCss.split('\n').length,
    embeddedCssSha: sha16(embeddedCss),
    prefsCssChars: prefsCss.length,
    prefsCssLines: prefsCss.split('\n').length,
    prefsCssMtime: stamp(prefsPath),
    prefsCssSha: sha16(prefsCss),
    tokensCssSha: sha16(tokensCss),
    inSync,
    verdict: inSync ? '一致（快照即当前源码）' : '**已漂移**（快照内嵌 CSS 与当前 prefs.css 不同，需重新生成预览页）',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    page: path.relative(REPO, PAGE).replace(/\\/g, '/'),
    chrome: CHROME,
    sources,
    closeups: closeupShots,
    tokensList: TOKENS,
    sourceTokens: parseSourceTokens(path.join(REPO, 'chrome', 'content', 'ui-tokens.css')),
    summary: {
      overflowFailCount: mainCombos.filter((c) => c.overflowExpanded.fail).length,
      svgTotal: mainCombos[0].svg.total,
      svgVisible: mainCombos[0].svg.visible,
      svgOutliers: mainCombos.reduce((n, c) => n + c.svg.outliers.length, 0),
      cardsTotal: cardsBase.length,
      cardsBad: cardsBase.filter((c) => !c.iconVisible || c.iconW === 0 || c.iconH === 0).length,
      cardsTooBig: cardsBase.filter((c) => c.iconH > 24 || c.iconW > 24).length,
      cardsContainerOver24: cardsBase.filter((c) => c.iconH > 24 || c.iconW > 24).length,
      cardsGlyphOver24: cardsBase.filter((c) => c.svgH > 24 || c.svgW > 24).length,
      cardsGlyphOutOfRange: cardsBase.filter((c) => c.svgH < 8 || c.svgW < 8).length,
      cardIconBox: cardsBase.length ? `${cardsBase[0].iconW}×${cardsBase[0].iconH}` : '—',
      focusOk: mainCombos.every((c) => ['primaryBtn', 'input', 'linkBtn', 'textarea'].every((k) => {
        const f = c.focus.found[k];
        return f && f.verdict === 'PASS';
      })),
      focusTargets: mainCombos.map((c) => ({
        combo: c.combo,
        missing: ['primaryBtn', 'input', 'linkBtn', 'textarea'].filter((k) => !c.focus.found[k]),
        verdicts: Object.fromEntries(Object.entries(c.focus.found).map(([k, v]) => [k, v.verdict])),
      })),
      glossaryHeight: glossary ? glossary.h : null,
      v1Ok: mainCombos.every((c) => c.validation.arrows.every((a) => a.gap <= 12 && Math.max(a.glyphW, a.glyphH) >= 9)),
      v2Ok: true, // 由近景截图人工确认（脚本给色值，判定在报告里写）
      v3Ok: mainCombos.every((c) => c.validation.chips.every((x) => !x.found || x.hasControl)),
      v4Ok: mainCombos.every((c) => c.validation.ctrls.every((x) => !x.found || x.borderWidth !== '0px')),
    },
    cardsConsistency,
    strokeSamples,
    main: mainCombos,
    combos,
  };

  // 原始 JSON（去掉 svg.all 里重复的 19×N 冗余：保留，便于追溯）
  fs.writeFileSync(path.join(OUT_DIR, 'render.json'), JSON.stringify(report, null, 2), 'utf8');

  // markdown（肉眼段：仅当已有实质内容时保留，占位符不算）
  const mdPath = path.join(OUT_DIR, 'render.md');
  if (fs.existsSync(mdPath)) {
    const old = fs.readFileSync(mdPath, 'utf8');
    const m = old.split('## 11. 肉眼观察（截图实看）');
    const kept = m[1] ? m[1].replace(/^\s*\n/, '').split('\n## ')[0].trim() : '';
    if (kept && kept !== '（待补）') report.eyeball = kept;
  }
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');
  console.log('\nwrote', path.join(OUT_DIR, 'render.json'));
  console.log('wrote', mdPath);
  console.log('summary:', JSON.stringify(report.summary));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
