// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 文档适配层：所有直接碰 wps.* 的代码都收在这里
 *
 * 纪律：别的模块不许直接调 wps.*，一律经本层。这样换 WPS 版本/换 Word 时只改一个文件，
 * 也让上层（model / styles / links）保持纯函数、可单测。
 *
 * 与旧实现的关键差别：**不用 Word 域（Field）**。
 *   WPS 12 对 Fields.Add / field.Result 的兼容性不稳，且域代码藏在二进制里、用户看不见也编不动。
 *   这里用「书签 + 命名编码」：书签是两端都稳定的原生对象，名字里带条目 key / 页码 / 标注 id，
 *   刷新时扫一遍书签就能重建全部引文——文档就是自己的数据库。
 */
(function (root) {
  "use strict";
  const codes = root.PPCodes;
  const BIB = "PPCBIB";      // 文献表锚（不匹配引文命名规范，不会被当作引文）
  const BIB_HEAD = "PPCBIBHEAD";

  function app() {
    if (typeof wps === "undefined" || !wps.WpsApplication) throw new Error("WPS jsapi 不可用");
    return wps.WpsApplication();
  }

  /**
   * 取当前文档。
   * 注意：加载项页面（含任务窗格）**没有焦点**时，ActiveDocument 可能是 null——
   * 旧实现直接抛错，于是"点了没反应"。这里退化为"取第一个打开的文档"。
   */
  function doc() {
    const a = app();
    let d = null;
    try {
      d = a.ActiveDocument;
    } catch (e) {
      d = null;
    }
    if (d) return d;
    try {
      if (a.Documents && a.Documents.Count > 0) return a.Documents.Item(1);
    } catch (e) { /* 继续往下抛 */ }
    throw new Error("拿不到文档对象（WPS 里没有打开的文档，或接口不可用）");
  }

  function docPath() {
    try {
      return String(doc().FullName || "");
    } catch (e) {
      return "";
    }
  }

  /** 扫出所有引文书签（只解析，不排序——排序在 model 里做） */
  function scan() {
    const d = doc();
    const out = [];
    const bms = d.Bookmarks;
    const n = bms.Count;
    for (let i = 1; i <= n; i++) {
      let bm;
      try {
        bm = bms.Item(i);
      } catch (e) {
        continue;                 // 书签可能在枚举中被删（刷新时正常）
      }
      const name = String(bm.Name || "");
      if (!codes.parse(name)) continue;
      let start = 0;
      try {
        start = Number(bm.Range.Start) || 0;
      } catch (e) { /* 取不到位置就排后面 */ }
      out.push({ name: name, start: start });
    }
    return out;
  }

  function exists(name) {
    try {
      return !!doc().Bookmarks.Exists(name);
    } catch (e) {
      return false;
    }
  }

  /** 替换书签范围内的文本；WPS 有可能在覆写后丢掉书签，这里补回来 */
  function setText(name, text) {
    const d = doc();
    const bm = d.Bookmarks.Item(name);
    const r = bm.Range;
    r.Text = text == null ? "" : String(text);
    if (!d.Bookmarks.Exists(name)) {
      const again = d.Bookmarks.Add(name, r);
      return again ? true : false;
    }
    return true;
  }

  function remove(name) {
    try {
      if (doc().Bookmarks.Exists(name)) doc().Bookmarks.Item(name).Delete();
    } catch (e) { /* 已经没了 */ }
  }

  /** 在光标处写入文本并给它挂一个书签名；返回 {name, ok} */
  function insertAtCursor(text, name) {
    const d = doc();
    let sel = null;
    try {
      sel = app().Selection.Range;
    } catch (e) {
      sel = null;
    }
    if (!sel) {
      // 无选区（页面没焦点）：退化为在文末插入
      // ★ 0 = wdCollapseEnd（Word/WPS 的 WdCollapseDirection：End=0，Start=1）。
      //   我曾凭印象改成 1，那会折到文首、把内容插到文章最前面，已改回。
      sel = d.Content;
      try { sel.Collapse(0); } catch (e) { /* 不支持就保持整段 */ }
    }
    sel.Text = String(text == null ? "" : text);
    // 用写入后的范围挂书签（sel 会随文本更新）
    const r = app().Selection.Range;
    if (r.Start > 0) {
      try {
        r.Start = r.Start - String(text).length;
        r.End = r.Start + String(text).length;
      } catch (e) { /* 取不到就整段挂 */ }
    }
    try {
      d.Bookmarks.Add(name, r);
    } catch (e) {
      return { name: name, ok: false, error: String(e && e.message || e) };
    }
    return { name: name, ok: true };
  }

  /** 把光标移到某个书签（用于"从台账跳回文档"） */
  function gotoBookmark(name) {
    const d = doc();
    if (!d.Bookmarks.Exists(name)) return false;
    const bm = d.Bookmarks.Item(name);
    bm.Range.Select();
    app().ActiveWindow.ScrollIntoView(bm.Range, true);
    return true;
  }

  /** 选区当前落在哪个引文书签里？返回 {name, parsed} 或 null */
  function citationAtCursor() {
    const d = doc();
    const pos = Number(app().Selection.Range.Start) || 0;
    let best = null;
    const bms = d.Bookmarks;
    for (let i = 1; i <= bms.Count; i++) {
      let bm;
      try {
        bm = bms.Item(i);
      } catch (e) { continue; }
      const p = codes.parse(String(bm.Name || ""));
      if (!p) continue;
      let r;
      try {
        r = bm.Range;
      } catch (e) { continue; }
      if (pos >= Number(r.Start) - 1 && pos <= Number(r.End) + 1) {
        best = { name: p.name, parsed: p };
      }
    }
    return best;
  }

  /** 扫描文档里的域（dotm 插入的 Zotero 引文就是域），返回 [{index, code, start}] */
  function scanFields() {
    const d = doc();
    const out = [];
    let fields;
    try {
      fields = d.Fields;
    } catch (e) {
      return out;
    }
    if (!fields) return out;
    const n = Number(fields.Count) || 0;
    for (let i = 1; i <= n; i++) {
      let f = null;
      try {
        f = fields.Item(i);
      } catch (e) {
        continue;
      }
      let code = "";
      try {
        code = String((f.Code && f.Code.Text) || f.Code || "");
      } catch (e) {
        continue;
      }
      let start = 0;
      try {
        start = Number(f.Result && f.Result.Start) || 0;
      } catch (e) { /* 取不到位置不影响解析 */ }
      out.push({ index: i, code: code, start: start });
    }
    return out;
  }

  /** 光标是否落在某个域里？返回 {index, code} 或 null */
  function fieldAtCursor() {
    const d = doc();
    let pos = 0;
    try {
      pos = Number(app().Selection.Range.Start) || 0;
    } catch (e) {
      return null;
    }
    let fields;
    try {
      fields = d.Fields;
    } catch (e) {
      return null;
    }
    const n = Number(fields && fields.Count) || 0;
    for (let i = 1; i <= n; i++) {
      let f = null;
      try {
        f = fields.Item(i);
      } catch (e) {
        continue;
      }
      let s = 0, e2 = 0;
      try {
        s = Number(f.Result.Start) || 0;
        e2 = Number(f.Result.End) || 0;
      } catch (err) {
        continue;
      }
      if (pos >= s - 1 && pos <= e2 + 1) {
        let code = "";
        try {
          code = String((f.Code && f.Code.Text) || f.Code || "");
        } catch (err) { /* 忽略 */ }
        return { index: i, code: code };
      }
    }
    return null;
  }

  /** 文献表：没有锚就建一个（文末），有就返回它的范围 */
  function bibAnchor() {
    const d = doc();
    if (d.Bookmarks.Exists(BIB)) return { name: BIB, fresh: false };
    const end = d.Content;
    // 0 = wdCollapseEnd（端点在末尾）。WdCollapseDirection 是 End=0 / Start=1。
    try { end.Collapse(0); } catch (e) { /* 不支持就整段 */ }
    d.Bookmarks.Add(BIB, end);
    return { name: BIB, fresh: true };
  }

  /** 用段落数组替换文献表锚点范围 */
  function setBib(lines) {
    const d = doc();
    bibAnchor();
    const bm = d.Bookmarks.Item(BIB);
    const r = bm.Range;
    r.Text = "";
    const text = (lines || []).join("\r");
    if (text) {
      r.InsertAfter(text);
      r.End = r.Start + text.length;
    }
    if (!d.Bookmarks.Exists(BIB)) d.Bookmarks.Add(BIB, r);
    return true;
  }

  /** 文档属性探测（存在就用它存样式名等非关键元数据，失败静默降级） */
  function meta(key, value) {
    try {
      const props = doc().CustomDocumentProperties;
      if (value === undefined) {
        for (let i = 1; i <= props.Count; i++) {
          if (String(props.Item(i).Name) === key) return String(props.Item(i).Value);
        }
        return "";
      }
      for (let i = 1; i <= props.Count; i++) {
        if (String(props.Item(i).Name) === key) {
          props.Item(i).Value = String(value);
          return String(value);
        }
      }
      props.Add(key, false, 4 /* msoPropertyTypeString */, String(value));
      return String(value);
    } catch (e) {
      return "";
    }
  }

  const api = {
    BIB, BIB_HEAD, app, doc, docPath, scan, scanFields, fieldAtCursor, exists, setText, remove,
    insertAtCursor, gotoBookmark, citationAtCursor, bibAnchor, setBib, meta,
  };
  root.PPDoc = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
