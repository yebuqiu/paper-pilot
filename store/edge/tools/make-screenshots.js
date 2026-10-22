// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 生成 Edge 商店截图（1280×800）：左侧卖点文案 + 右侧真实扩展截图。
 * 运行：NODE_PATH=<playwright-core> node store/edge/tools/make-screenshots.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TMP = path.join(ROOT, "store/edge/tools/.tmp");

let chromium;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error("未找到 playwright-core，请设置 NODE_PATH");
  process.exit(2);
}

const SHOTS = [
  {
    out: "store/edge/reader/screenshots/01-overview.png",
    img: "edge-extension/dist/real-account-verify.png",
    kicker: "学术阅读侧边栏",
    title: "把一篇论文\n读薄一点",
    sub: "划词解释、逐句翻译、结构化摘要，术语全篇一致。",
    bullets: [
      ["划词即问", "选中一句，解释、翻译或继续追问"],
      ["本页摘要", "TL;DR、方法、结论、局限四段式"],
      ["PDF 也能读", "面板内解析全文，不用来回切标签"],
    ],
    foot: "Microsoft Edge · 网页与 PDF",
  },
  {
    out: "store/edge/cite/screenshots/01-overview.png",
    img: "edge-extension-cite/dist/real-site-preview.png",
    kicker: "引文快取",
    title: "一条引文\n一次点完",
    sub: "GB/T 7714、APA、MLA、BibTeX、RIS，复制就能粘进 Word。",
    bullets: [
      ["五种格式同屏", "左侧英文刊名不改，右侧格式随时切换"],
      ["真实页面识别", "arXiv、PubMed、期刊详情页直接读取"],
      ["不写文献库", "只生成文本，不改你的任何资料"],
    ],
    foot: "Microsoft Edge · 引文格式化",
  },
  {
    out: "store/edge/cite/screenshots/02-formats.png",
    img: "edge-extension-cite/dist/popup-preview.png",
    kicker: "引文快取",
    title: "投稿格式\n不用再背",
    sub: "卷、期、页码、DOI 自动拼好；缺字段时用 DOI 向 Crossref 补齐。",
    bullets: [
      ["期刊 / 会议 / 图书", "按类型选择 [J]、[C]、[M] 标识"],
      ["BibTeX / RIS", "直接喂给 LaTeX、EndNote、NoteExpress"],
      ["复制后自动关闭", "连续取十条也不打断写作"],
    ],
    foot: "Microsoft Edge · 引文格式化",
  },
];

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlFor(shot) {
  const imgUrl = pathToFileURL(path.join(ROOT, shot.img)).href;
  const bullets = shot.bullets.map(([t, d]) => `
      <div class="row">
        <span class="dot"></span>
        <div><b>${esc(t)}</b><span>${esc(d)}</span></div>
      </div>`).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body {
    background: #f4f6f5; color: #1b2420;
    font: 14px/1.6 "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    display: flex; align-items: stretch;
    padding: 66px 76px; gap: 54px;
  }
  .left { width: 536px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
  .brand img { width: 30px; height: 30px; border-radius: 8px; }
  .brand em { font-style: normal; color: #5f6b76; font-weight: 400; font-size: 12px; margin-left: 2px; }
  .kicker {
    margin-top: 58px; color: #0f6e56; font-size: 12px; font-weight: 600;
    letter-spacing: 2.4px; text-transform: uppercase;
  }
  h1 { margin: 12px 0 0; font-size: 44px; line-height: 1.24; font-weight: 600; letter-spacing: -1px; white-space: pre-line; }
  .sub { margin: 16px 0 0; color: #5f6b76; font-size: 15.5px; line-height: 1.75; max-width: 470px; }
  .rows { margin-top: 38px; display: flex; flex-direction: column; gap: 20px; }
  .row { display: flex; gap: 12px; align-items: flex-start; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #0f6e56; margin-top: 8px; flex: none; }
  .row b { display: block; font-size: 14.5px; font-weight: 600; }
  .row span { display: block; color: #5f6b76; font-size: 13px; margin-top: 1px; }
  .foot { margin-top: auto; color: #7b878f; font-size: 11.5px; letter-spacing: .6px; }
  .stage { flex: 1; display: flex; align-items: center; justify-content: center; }
  .card {
    border-radius: 20px; overflow: hidden; background: #fff;
    border: 1px solid #e1e7e4;
    box-shadow: 0 26px 60px rgba(17, 40, 33, .13), 0 2px 6px rgba(17, 40, 33, .05);
  }
  .card img { display: block; height: 668px; width: auto; }
  </style></head><body>
    <div class="left">
      <div class="brand"><img src="${pathToFileURL(path.join(ROOT, "store/edge/assets/reader-icon-128.png")).href}">Papilot<em>Edge 扩展</em></div>
      <div class="kicker">${esc(shot.kicker)}</div>
      <h1>${esc(shot.title)}</h1>
      <p class="sub">${esc(shot.sub)}</p>
      <div class="rows">${bullets}</div>
      <div class="foot">${esc(shot.foot)}</div>
    </div>
    <div class="stage"><div class="card"><img src="${imgUrl}"></div></div>
  </body></html>`;
}

fs.mkdirSync(TMP, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (let i = 0; i < SHOTS.length; i++) {
  const shot = SHOTS[i];
  const file = path.join(TMP, "shot-" + i + ".html");
  fs.writeFileSync(file, htmlFor(shot), "utf8");
  await page.goto(pathToFileURL(file).href);
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const card = document.querySelector(".card").getBoundingClientRect();
    const left = document.querySelector(".left").getBoundingClientRect();
    const img = document.querySelector(".card img");
    return {
      cardRight: Math.round(card.right),
      leftRight: Math.round(left.right),
      imgW: img.naturalWidth,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
    };
  });
  if (m.scrollW > 1280 || m.scrollH > 800 || m.cardRight > 1280 || m.imgW === 0) {
    throw new Error("版式溢出：" + JSON.stringify(m));
  }
  console.log("layout:", JSON.stringify(m));
  const out = path.join(ROOT, shot.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1280, height: 800 } });
  console.log("written:", shot.out);
}

await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });
