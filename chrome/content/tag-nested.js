/* PaperPilot 嵌套标签视图（窗口脚本，E3，纯只读）
 * 树数据与条目清单由插件作用域经 window.arguments[0] 注入（窗口访问不到 TagCurator）。
 * 只渲染与导航：折叠/展开、点击节点列出命中条目、点击条目回主窗口选中 —— 不改数据。
 */
/* global window, document */

(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  let A = (window.arguments && window.arguments[0]) || {};
  const $ = (id) => document.getElementById(id);
  const zh = () => A.isZh !== false;
  let selectedPath = "";

  function h(tag, attrs, text) {
    const el = document.createElementNS(XHTML, tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  }

  /* ---------------- 树渲染 ---------------- */

  function renderNode(node, depth, container) {
    const row = h("div", {
      style: "display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:4px;" +
        "cursor:pointer;line-height:1.7;" + (depth ? "margin-left:" + (depth * 16) + "px;" : ""),
      "data-path": node.path,
    });
    if (selectedPath === node.path) row.style.background = "#2f9e6f22";

    const kids = node.children || [];
    const arrow = h("span", {
      style: "flex:none;width:14px;text-align:center;color:#888;font-size:10px;user-select:none;",
    }, kids.length ? "▶" : "");
    row.appendChild(arrow);

    row.appendChild(h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;" },
      node.name));
    const badge = String(node.total) + (node.count && node.count !== node.total ? "（自身 " + node.count + "）" : "");
    row.appendChild(h("span", {
      style: "flex:none;font-size:11px;color:#888;",
      title: zh() ? "子树条目合计" + (node.count !== node.total ? "（含恰好等于该标签自身的 " + node.count + " 篇）" : "") : "subtree items",
    }, badge));

    const kidBox = h("div", { style: "display:none;" });
    let open = false;
    const setOpen = (v) => {
      open = v;
      kidBox.style.display = open ? "" : "none";
      arrow.textContent = kids.length ? (open ? "▼" : "▶") : "";
    };
    if (kids.length) {
      arrow.addEventListener("click", (ev) => { ev.stopPropagation(); setOpen(!open); });
      row.style.fontWeight = node.count ? "600" : "400";
    }
    row.addEventListener("click", () => {
      selectedPath = node.path;
      // 重刷高亮
      for (const r of $("pp-tn-tree").querySelectorAll("[data-path]")) {
        r.style.background = (r.getAttribute("data-path") === selectedPath) ? "#2f9e6f22" : "";
      }
      renderItems(node.path);
      if (kids.length && !open) setOpen(true);
    });

    container.appendChild(row);
    for (const c of kids) renderNode(c, depth + 1, kidBox);
    container.appendChild(kidBox);
  }

  function renderTree() {
    const box = $("pp-tn-tree");
    while (box.firstChild) box.removeChild(box.firstChild);
    const tree = Array.isArray(A.tree) ? A.tree : [];
    if (!tree.length) {
      box.appendChild(h("div", { style: "color:#888;padding:8px;" },
        zh() ? "库里还没有标签" : "No tags in library"));
      return;
    }
    for (const n of tree) renderNode(n, 0, box);
  }

  /* ---------------- 命中条目列表 ---------------- */

  function renderItems(path) {
    const box = $("pp-tn-items");
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(h("div", {
      style: "font-weight:600;font-size:12px;color:#666;border-bottom:1px solid #88888830;" +
        "padding-bottom:4px;margin-bottom:6px;word-break:break-all;",
    }, path || ""));
    const list = (A.items && A.items[path]) || [];
    if (!list.length) {
      box.appendChild(h("div", { style: "color:#888;" },
        zh() ? "该节点下没有条目" : "No items under this node"));
      return;
    }
    box.appendChild(h("div", { style: "color:#888;font-size:11px;margin-bottom:4px;" },
      (zh() ? "命中 " : "") + list.length + (zh() ? " 篇（点击在主窗口选中）" : " items")));
    for (const it of list.slice(0, 500)) {
      const row = h("div", {
        style: "padding:3px 4px;border-radius:4px;cursor:pointer;line-height:1.4;" +
          "border-bottom:1px solid #88888818;",
      }, it.title || ("#" + it.id));
      row.addEventListener("click", () => {
        try { if (typeof A.revealItem === "function") A.revealItem(it.id); } catch (e) { /* ignore */ }
      });
      box.appendChild(row);
    }
    if (list.length > 500) {
      box.appendChild(h("div", { style: "color:#888;font-size:11px;margin-top:4px;" },
        "… " + (zh() ? "其余 " : "") + (list.length - 500) + (zh() ? " 篇从略" : " more")));
    }
  }

  /* ---------------- 初始化 ---------------- */

  function countNodes(tree) {
    let n = 0;
    const walk = (nodes) => { for (const x of (nodes || [])) { n++; walk(x.children); } };
    walk(tree);
    return n;
  }

  function init(payload) {
    if (payload) A = payload;
    selectedPath = "";
    const tree = Array.isArray(A.tree) ? A.tree : [];
    $("pp-tn-summary").textContent = zh()
      ? "共 " + countNodes(tree) + " 个节点 · 顶层 " + tree.length + " 个"
      : countNodes(tree) + " nodes · " + tree.length + " roots";
    renderTree();
    const box = $("pp-tn-items");
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(h("div", { style: "color:#888;" },
      zh() ? "点击左侧节点查看命中条目" : "Click a node to list items"));
  }

  /** 单实例复用：插件侧重开时刷新数据 */
  window.ppNestedLoad = function (payload) {
    try { window.focus(); } catch (e) { /* ignore */ }
    init(payload || {});
    return true;
  };

  function bindUi() {
    $("pp-tn-close").addEventListener("click", () => { try { window.close(); } catch (e) { /* ignore */ } });
    if (!zh()) {
      $("pp-tn-close").textContent = "Close";
      document.title = "PaperPilot · Nested Tags";
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    bindUi(); init(A);
  } else {
    window.addEventListener("DOMContentLoaded", () => { bindUi(); init(A); }, { once: true });
  }
})();
