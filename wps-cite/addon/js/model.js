// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 引文模型：从"书签扫描结果"推出"该写什么文本"
 *
 * 全部是纯函数（不碰 WPS），所以能被单测钉死——这是本项目对旧实现的第一个改进：
 * 旧实现把"排版决策"和"文档 I/O"揉在一起，出错只能靠人眼在 WPS 里试。
 *
 * 输入：scan = [{name, start}]（start = 书签在文档里的字符位置，用来定顺序）
 * 输出：plan = {
 *         clusters: [{token, start, items: [{name, idx, itemKey, page, anno, locator}]}],
 *         edits:    [{name, text, remove}],        // 该改的书签
 *         bib:      [{itemKey, seq}],              // 文献表该列哪些、什么顺序
 *         seqOf:    {itemKey: 序号}                // 数字制用
 *       }
 */
(function (root) {
  "use strict";
  const codes = root.PPCodes || require("./codes.js");

  /** 把书签列表按 位置 排序 → 按 token 聚成簇（同一处引多篇共用一个 token） */
  function cluster(scan) {
    const parsed = [];
    for (const s of scan || []) {
      const p = codes.parse(s.name);
      if (p) parsed.push(Object.assign({ start: Number(s.start) || 0 }, p));
    }
    parsed.sort((a, b) => a.start - b.start || a.idx - b.idx);

    const byTok = new Map();
    const out = [];
    for (const p of parsed) {
      let c = byTok.get(p.token);
      if (!c) {
        c = { token: p.token, start: p.start, items: [] };
        byTok.set(p.token, c);
        out.push(c);
      }
      c.start = Math.min(c.start, p.start);
      c.items.push(p);
    }
    for (const c of out) c.items.sort((a, b) => a.idx - b.idx || a.start - b.start);
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /**
   * 生成渲染计划。
   * @param scan   [{name, start}]
   * @param byKey  {itemKey: zoteroItem}
   * @param style  样式对象（numeric 决定是否编号）
   */
  function plan(scan, byKey, style) {
    const clusters = cluster(scan);
    const missing = [];
    const seqOf = Object.create(null);
    const order = [];
    let seq = 0;

    for (const c of clusters) {
      c.alive = [];
      for (const it of c.items) {
        const item = byKey[it.itemKey];
        if (!item) {
          missing.push(it);
          continue;
        }
        if (!(it.itemKey in seqOf)) {
          seqOf[it.itemKey] = style.numeric ? ++seq : 0;
          order.push(it.itemKey);
        }
        it.seq = seqOf[it.itemKey];
        c.alive.push(it);
      }
    }

    const edits = [];
    for (const c of clusters) {
      if (!c.alive.length) {
        // 条目全丢（被移出文献库/换了电脑没同步）→ 保留占位，不静默删除
        const first = c.items[0];
        edits.push({ name: first.name, text: "[?]", remove: false, degraded: true });
        for (const it of c.items.slice(1)) edits.push({ name: it.name, text: "", remove: true });
        continue;
      }
      const first = c.alive[0];
      const text = style.cite(c.alive.map((it) => ({
        seq: it.seq, locator: it.locator, item: byKey[it.itemKey],
      })));
      edits.push({ name: first.name, text: text, remove: false });
      // 同簇其余书签只做清理（它们不承载文本）
      for (const it of c.items) {
        if (it !== first) edits.push({ name: it.name, text: "", remove: true });
      }
    }

    const bib = style.numeric
      ? order.map((k) => ({ itemKey: k, seq: seqOf[k] }))
      : order.map((k) => ({ itemKey: k, seq: 0 }));

    return { clusters, edits, bib, seqOf, missing };
  }

  /** 插入一条新引文时，决定书签名（同簇追加 or 新簇） */
  function nameForNewCitation(exists, anchor, item) {
    if (anchor && anchor.token) {
      return codes.makeInCluster(exists, anchor.token, item, anchor.nextIdx || 1);
    }
    return codes.make(exists, item);
  }

  const api = { cluster, plan, nameForNewCitation };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
