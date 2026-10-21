// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 书签即数据：把一条引文的身份编码进 WPS 书签名
 *
 * 为什么不用文档属性/自定义 XML：
 *   WPS 对 CustomDocumentProperties 的支持随版本波动，写失败是静默的；
 *   而书签是 WPS/Word 都稳定支持的原生对象，且**跟着文字走**——
 *   用户复制粘贴引文时书签会一起复制，这正是我们要的语义。
 *
 * 命名规范（<= 40 字符，Word 上限）：
 *   PPC<tok>_<itemKey>[_p<page>][_a<anno8>][_l<locator>][_i<idx>][_L<libId>]
 *   PPC7f3q_K2M9X4Ta_p7_a1b2c3d4_i0
 *
 *   tok     4 位 base36 的**簇**标识：同一处引多篇文献时共用一个 tok
 *   itemKey Zotero 条目 key（8 位，大写）
 *   page    引用所依据的原文页码（反向定位 PDF 用）
 *   anno8   该页标注 key 前 8 位（有则精确跳到高亮）
 *   locator 正文里标注的页码/章节（如 12-15、chap3），仅字母数字与 - , . :
 *   idx     簇内序号（0 起），只有 idx=0 的书签承载渲染文本
 *   libId   文献库 ID，1（个人库）省略
 */
(function (root) {
  "use strict";

  const PREFIX = "PPC";
  const RE = new RegExp(
    "^PPC([0-9a-z]{4})_([A-Z0-9]{8})" +
    "(?:_p(\\d{1,5}))?(?:_a([A-Za-z0-9]{8}))?(?:_l([0-9a-zA-Z,.\\-:]{1,12}))?" +
    "(?:_i(\\d))?(?:_L(\\d{1,3}))?$");
  const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
  const MAXLEN = 40;

  function token(n) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s = BASE36[n % 36] + s;
      n = Math.floor(n / 36);
    }
    return s;
  }

  function sanitizeLocator(v) {
    return String(v || "").replace(/[^0-9a-zA-Z,.\-:]/g, "").slice(0, 12);
  }

  function build(tok, it) {
    let s = PREFIX + tok + "_" + String(it.itemKey).toUpperCase();
    if (it.page) s += "_p" + Number(it.page);
    if (it.anno) s += "_a" + String(it.anno).toUpperCase().slice(0, 8);
    const loc = sanitizeLocator(it.locator);
    if (loc) s += "_l" + loc;
    if (it.idx) s += "_i" + Number(it.idx);
    if (it.libId && Number(it.libId) !== 1) s += "_L" + Number(it.libId);
    return s;
  }

  /** 生成不与现有书签冲突的名字（同簇内 idx 已存在则顺延） */
  function make(exists, item) {
    if (!/^[A-Z0-9]{8}$/.test(String(item.itemKey || ""))) {
      throw new Error("itemKey 必须是 8 位大写字母数字");
    }
    for (let n = 1; n < 36 * 36 * 36 * 36; n++) {
      const tok = token(n);
      const name = build(tok, item);
      if (name.length > MAXLEN) throw new Error("书签名超过 40 字符：" + name);
      if (!exists(name)) return name;
    }
    throw new Error("书签 token 空间耗尽");
  }

  /** 为一个簇追加成员（同 tok，idx 递增） */
  function makeInCluster(exists, tok, item, startIdx) {
    for (let i = startIdx || 1; i < 10; i++) {
      const name = build(tok, Object.assign({}, item, { idx: i }));
      if (!exists(name)) return name;
    }
    throw new Error("同一处引文最多 9 篇，请拆成两处引用");
  }

  function parse(name) {
    const m = RE.exec(String(name || ""));
    if (!m) return null;
    return {
      name: name,
      token: m[1],
      itemKey: m[2],
      page: m[3] ? Number(m[3]) : 0,
      anno: m[4] || "",
      locator: m[5] || "",
      idx: m[6] ? Number(m[6]) : 0,
      libId: m[7] ? Number(m[7]) : 1,
    };
  }

  const api = { PREFIX, MAXLEN, make, makeInCluster, build, parse, token, sanitizeLocator };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PPCodes = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
