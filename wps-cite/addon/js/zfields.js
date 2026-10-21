// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Zotero 域解析：让"双向链接"能作用于 **dotm 插入的官方引文**，而不是只能作用于我们自己的书签
 *
 * 背景：
 *   Zotero 的 Word/WPS 插件（dotm）插入的是 Word 域，域代码形如
 *       ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"...","properties":{...},
 *              "citationItems":[{"id":"http://zotero.org/users/8552292/items/MWG8GNMN",...}]}
 *       ADDIN ZOTERO_BIBL {"custom":[]} CSL_BIBLIOGRAPHY
 *   条目身份就在那段 JSON 里（id 是 URI），所以**不需要改造 dotm** 也能建双向链接：
 *   扫文档里的域 → 解析出条目 key → 写台账 / 拼 zotero:// 跳转。
 *
 * 这个文件是纯函数（不碰 wps.*），可以直接在 Node 里测。
 */
(function (root) {
  "use strict";

  const ITEM_URI = /^https?:\/\/zotero\.org\/(users|groups)\/(\d+)\/items\/([A-Z0-9]{8})$/;

  /** 从域代码里抠出 CSL 的 JSON（域代码里 JSON 与关键字混排，靠括号配对抓） */
  function extractJSON(code) {
    const s = String(code || "");
    const i = s.indexOf("{");
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(i, j + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** id 可能是 URI，也可能直接是 8 位 key */
  function idToItem(id) {
    const s = String(id || "");
    const m = ITEM_URI.exec(s);
    if (m) return { libType: m[1], libId: Number(m[2]), key: m[3] };
    if (/^[A-Z0-9]{8}$/.test(s)) return { libType: "users", libId: 1, key: s };
    return null;
  }

  /**
   * 解析一条域代码。
   * @returns {null | {kind:"item"|"bibl", items:[{key,libId,libType}], citationID?:string, style?:string}}
   */
  function parseField(code) {
    const s = String(code || "");
    if (s.indexOf("ZOTERO_ITEM") < 0 && s.indexOf("ZOTERO_BIBL") < 0) return null;
    const json = extractJSON(s);
    const kind = s.indexOf("ZOTERO_BIBL") >= 0 ? "bibl" : "item";
    const items = [];
    if (json && Array.isArray(json.citationItems)) {
      for (const ci of json.citationItems) {
        const it = idToItem(ci && ci.id);
        if (it) {
          if (ci.locator) it.locator = String(ci.locator);
          items.push(it);
        }
      }
    }
    const style = json && json.properties && json.properties.style
      ? String(json.properties.style).replace(/^https?:\/\/www\.zotero\.org\/styles\//, "")
      : "";
    return { kind: kind, items: items, citationID: (json && json.citationID) || "", style: style };
  }

  /** 从一堆域代码里汇总出"本文档引用了哪些条目"（去重、保序） */
  function collectItems(codes) {
    const seen = new Set();
    const out = [];
    for (const code of codes || []) {
      const f = parseField(code);
      if (!f) continue;
      for (const it of f.items) {
        const k = it.libId + ":" + it.key;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
      }
    }
    return out;
  }

  /** dotm 的域里没有页码信息，但条目本身可以定位；有 locator 时用它提示 */
  function describe(field) {
    if (!field) return "";
    if (field.kind === "bibl") return "文献表";
    return field.items.map((i) => i.key).join(", ");
  }

  const api = { parseField, extractJSON, idToItem, collectItems, describe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPZFields = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
