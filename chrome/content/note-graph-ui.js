// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 笔记关系图谱窗口（0.23.0）
 * 只做渲染与交互：构图/布局全部由 Zotero.Papilot.noteGraph 完成（便于单测）。
 * 数据通道与其它窗口一致：Zotero/Services 经 window.arguments 传入。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = Z && (Z.locale || "").toLowerCase().startsWith("zh");

  const $ = (id) => document.getElementById(id);
  const canvas = $("pp-ng-canvas");
  const statusEl = $("pp-ng-status");
  const legendEl = $("pp-ng-legend");

  if (!PP || !PP.noteGraph) {
    statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: module unavailable";
    return;
  }
  const NG = PP.noteGraph;

  const COLOR = {
    item: "#58a6ff",   // 条目
    note: "#3fb950",   // 笔记
    edge: {
      parent: "#8b949e", // 归属
      link: "#d29922",   // zotero:// 链接
      pdf: "#d29922",
      note: "#f0883e",   // 笔记→笔记
      wiki: "#a371f7",   // [[标题]]
    },
  };
  const EDGE_LABEL = {
    parent: zh ? "条目↔笔记（归属）" : "item-note",
    link: zh ? "笔记→条目（链接）" : "note→item",
    pdf: zh ? "笔记→附件（pdf 链接）" : "note→attachment",
    note: zh ? "笔记→笔记（note 链接）" : "note→note",
    wiki: zh ? "笔记→笔记（[[标题]]）" : "note→note (wiki)",
  };

  let graph = null;
  let showLinkedOnly = true;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function visibleNodes() {
    if (!graph) return [];
    const nodes = showLinkedOnly ? graph.nodes.filter((n) => n.degree > 0) : graph.nodes;
    return nodes;
  }

  function render() {
    canvas.textContent = "";
    if (!graph) {
      canvas.appendChild(el("div", "color:var(--fill-tertiary,#999);padding:10px;",
        zh ? "点「生成 / 刷新图谱」开始。" : "Click “Build” to start."));
      return;
    }
    const nodes = visibleNodes();
    if (!nodes.length) {
      canvas.appendChild(el("div", "color:var(--fill-tertiary,#999);padding:10px;",
        zh ? "没有可显示的节点。试试取消「只显示有连接的节点」，或先给笔记加上 zotero:// 链接 / [[标题]]。" : "No nodes to show."));
      return;
    }
    const keep = new Set(nodes.map((n) => n.key));
    const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    const W = 1100, H = Math.max(560, Math.min(2000, nodes.length * 3));
    const pos = NG.layout(nodes, edges, { width: W, height: H, iterations: nodes.length > 220 ? 120 : 240 });
    const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">';
    // 边
    for (const e of edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      const color = (COLOR.edge[e.type] || "#8b949e");
      const op = e.type === "parent" ? 0.35 : 0.55;
      svg += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
        '" stroke="' + color + '" stroke-width="' + (e.type === "parent" ? 1 : 1.4) + '" stroke-opacity="' + op + '"/>';
    }
    // 节点
    for (const n of nodes) {
      const p = pos.get(n.key);
      if (!p) continue;
      const r = 3.5 + 7 * Math.sqrt(n.degree / maxDeg);
      const fill = n.kind === "note" ? COLOR.note : COLOR.item;
      const stroke = n.degree > 0 ? "rgba(0,0,0,.35)" : "rgba(0,0,0,.12)";
      const tip = (n.kind === "note" ? (zh ? "笔记：" : "Note: ") : "") +
        (n.title || n.key) + (n.year ? " (" + n.year + ")" : "") +
        " ｜ " + (zh ? "连接 " : "links ") + n.degree;
      svg += '<circle class="pp-ng-node" data-key="' + esc(n.key) + '" data-title="' + esc(n.title) +
        '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) +
        '" fill="' + fill + '" fill-opacity="' + (n.degree > 0 ? 0.92 : 0.42) +
        '" stroke="' + stroke + '"><title>' + esc(tip) + '</title></circle>';
      // 只给连接度高的节点打标签，避免糊成一团
      if (n.degree >= Math.max(2, maxDeg * 0.5)) {
        svg += '<text x="' + (p.x + r + 3).toFixed(1) + '" y="' + (p.y + 3).toFixed(1) +
          '" font-size="10" fill="currentColor" opacity="0.85">' + esc(String(n.title || n.key).slice(0, 28)) + "</text>";
      }
    }
    svg += "</svg>";
    const holder = el("div", "");
    holder.innerHTML = svg;
    canvas.appendChild(holder);
    holder.querySelectorAll("circle.pp-ng-node").forEach((c) => {
      c.style.cursor = "pointer";
      c.addEventListener("click", () => {
        const ok = NG.reveal(c.getAttribute("data-key"));
        statusEl.textContent = ok ? (zh ? "已在主窗口定位：" : "Revealed: ") + c.getAttribute("data-title")
                                 : (zh ? "该对象不在当前用户库中（可能是群组库）" : "Not in the user library");
      });
    });

    const linked = nodes.filter((n) => n.degree > 0).length;
    statusEl.textContent = (zh ? "范围 " : "scope ") + (graph.scopeName || "") +
      (zh ? " ｜ 节点 " : " | nodes ") + nodes.length + "/" + graph.stats.total +
      (zh ? "（有连接 " : " (linked ") + linked + (zh ? "） ｜ 边 " : ") | edges ") + edges.length +
      (graph.truncated ? (zh ? " ｜ 已截断（超出上限，保留连接度最高的）" : " | truncated") : "");
    renderLegend(edges);
  }

  function renderLegend(edges) {
    const types = [...new Set(edges.map((e) => e.type))];
    let html = '<span style="display:inline-block;margin-right:14px;">' +
      '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COLOR.item + '"></span> ' +
      (zh ? "条目" : "item") + "</span>" +
      '<span style="display:inline-block;margin-right:14px;">' +
      '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COLOR.note + '"></span> ' +
      (zh ? "笔记" : "note") + "</span>";
    for (const t of types) {
      html += '<span style="display:inline-block;margin-right:14px;">' +
        '<span style="display:inline-block;width:14px;height:2px;background:' + (COLOR.edge[t] || "#8b949e") + ';vertical-align:middle"></span> ' +
        esc(EDGE_LABEL[t] || t) + "</span>";
    }
    html += '<span style="color:var(--fill-tertiary,#999)">' + (zh ? "｜ 圆点越大=连接越多；点节点可在主窗口定位" : "") + "</span>";
    legendEl.innerHTML = html;
  }

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  async function build() {
    $("pp-ng-build").disabled = true;
    statusEl.textContent = zh ? "正在采集笔记与链接…" : "Collecting…";
    try {
      graph = await NG.build({ useCollection: $("pp-ng-collection").checked });
      render();
    } catch (e) {
      statusEl.textContent = (zh ? "生成失败：" : "Failed: ") + ((e && e.message) || e);
    }
    $("pp-ng-build").disabled = false;
  }

  $("pp-ng-build").addEventListener("click", () => { build(); });
  $("pp-ng-linked").addEventListener("change", (ev) => { showLinkedOnly = ev.target.checked; render(); });
  $("pp-ng-close").addEventListener("click", () => window.close());

  render();
})();
