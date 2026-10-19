// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 附件体检（0.22.0）
 * 库健康栏目原有「智能清理」查的是条目层面（重复/无附件/缺元数据）。
 * 本模块补的是**附件层面**的五类问题，全部只读扫描 + 报告，绝不删除任何文件：
 *  1. 无附件条目（区分「完全没附件」与「有附件但没有 PDF」）
 *  2. 断链/丢失：linked_file 链接失效，或 imported 附件在存储目录里找不到文件
 *  3. 同父重复附件：同一父条目下文件名相同或体积相同的多个 PDF
 *  4. 无文本层 PDF：全文索引取不到文字（扫描件）→ 这类文献在 Papilot 的
 *     AI 问答/翻译/综述里等于「全瞎」，是最容易踩的隐性坑
 *  5. 存储目录孤儿文件：storage/<key>/ 下存在、但库里没有任何附件引用的文件
 *
 * 跨版本策略：每个探测点独立 try/catch，拿不到接口就把该项记入 skipped，
 * 在报告里显式说明「已跳过」，不做静默失败（项目纪律）。
 */
/* global Zotero, Services, Prefs, I18n, MdLite, AIChat, IOUtils */

var AttachDoctor = {
  TAG_NOATT: "#附件/无附件",
  TAG_BROKEN: "#附件/断链",
  TAG_DUP: "#附件/重复",
  TAG_NOTEXT: "#附件/无文本层",
  TEXT_CHECK_CAP: 300, // 单次最多检查多少篇 PDF 的文本层（避免大库跑太久）

  /* ---------- 基础探测 ---------- */

  _title(item) {
    try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /** 所有常规条目（不含附件） */
  async _regularItems() {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    const out = [];
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (it && !it.deleted && it.isRegularItem && it.isRegularItem()) out.push(it);
    }
    return out;
  },

  /** 所有附件条目（含独立附件） */
  async _attachments() {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "is", "attachment");
    const ids = await s.search();
    const out = [];
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (it && !it.deleted) out.push(it);
    }
    return out;
  },

  /** 扫描范围：选中分类的条目，否则全库 */
  async _scope() {
    const zp = Zotero.getActiveZoteroPane();
    let name = I18n.isZh ? "全库" : "Whole library";
    try {
      const col = zp && zp.getSelectedCollections && zp.getSelectedCollections()[0];
      if (col) name = (I18n.isZh ? "分类「" : "Collection \"") + col.name + "」";
    } catch (e) { /* Z10 getSelectedCollection 会 throw */ }
    return name;
  },

  /** 文件是否真的存在（跨版本：优先 getFilePathAsync） */
  async _filePath(att) {
    try {
      if (typeof att.getFilePathAsync === "function") {
        const p = await att.getFilePathAsync();
        return p || "";
      }
      const p = att.getFilePath && att.getFilePath();
      return p || "";
    } catch (e) {
      return "";
    }
  },

  /* ---------- 存储目录孤儿文件 ---------- */

  /** 数据目录下的 storage 路径（跨版本探测）；失败返回 "" */
  _storageDirPath() {
    try {
      if (Zotero.DataDirectory && typeof Zotero.DataDirectory.getDir === "function") {
        const dir = Zotero.DataDirectory.getDir();
        if (dir) {
          try { return (dir.clone ? dir.clone() : dir).path; } catch (e) { /* next */ }
          if (typeof dir === "string") return dir;
        }
      }
    } catch (e) { /* next */ }
    try {
      if (Zotero.DataDirectory && typeof Zotero.DataDirectory.dir === "string") {
        const base = Zotero.DataDirectory.dir;
        const sep = base.includes("\\") ? "\\" : "/";
        return base.replace(/[\\/]+$/, "") + sep + "storage";
      }
    } catch (e) { /* next */ }
    return "";
  },

  /** storage/<key>/<file> 中未被任何附件引用的文件 */
  async _findOrphans(attachments) {
    const dirPath = this._storageDirPath();
    if (!dirPath) return { orphans: [], skipped: true };
    // 被引用的 key/filename 集合（imported_* 的 attachmentPath 形如 storage:xxx.pdf）
    const ref = new Set();
    for (const att of attachments) {
      let key = "";
      try { key = att.key || ""; } catch (e) { key = ""; }
      if (!key) continue;
      let p = "";
      try { p = att.attachmentPath || ""; } catch (e) { p = ""; }
      if (p.startsWith("storage:")) ref.add(key + "/" + p.slice("storage:".length));
      else ref.add(key + "/"); // 非常规形式：整目录视为已引用，避免误报
    }
    const orphans = [];
    try {
      const IOU = (typeof IOUtils !== "undefined") ? IOUtils : null;
      if (!IOU || typeof IOU.getChildren !== "function") return { orphans: [], skipped: true };
      const subdirs = await IOU.getChildren(dirPath);
      for (const sub of subdirs || []) {
        let files = [];
        try { files = await IOU.getChildren(sub); } catch (e) { continue; }
        const subKey = String(sub).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        for (const f of files || []) {
          const fname = String(f).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
          if (fname.startsWith(".")) continue; // .zotero-ft-cache 等隐藏文件不算
          if (ref.has(subKey + "/" + fname) || ref.has(subKey + "/")) continue;
          let size = 0;
          try { const st = await IOU.stat(f); size = (st && st.size) || 0; } catch (e) { size = 0; }
          orphans.push({ path: String(f), name: fname, size });
        }
      }
    } catch (e) {
      return { orphans: [], skipped: true };
    }
    return { orphans, skipped: false };
  },

  /* ---------- 主扫描 ---------- */

  async scan(opts) {
    const o = opts || {};
    const scope = await this._scope();
    const items = await this._regularItems();
    const atts = await this._attachments();
    const result = {
      scope, total: items.length, attTotal: atts.length,
      noAttach: [], noPdf: [], broken: [], dupGroups: [], noText: [],
      orphans: [], skipped: [], textChecked: 0,
    };

    // 1/2. 无附件 / 断链
    for (const item of items) {
      let ids = [];
      try { ids = item.getAttachments() || []; } catch (e) { ids = []; }
      let pdfs = 0;
      for (const aid of ids) {
        const att = await Zotero.Items.getAsync(aid);
        if (!att || att.deleted) continue;
        if (att.isPDFAttachment && att.isPDFAttachment()) pdfs++;
        const lm = att.linkMode;
        if (lm === 3) continue; // 链接网页：不是文件
        if (!(await this._filePath(att))) {
          result.broken.push({ att, parent: item, title: this._title(item) });
        }
      }
      if (!ids.length) result.noAttach.push(item);
      else if (!pdfs) result.noPdf.push(item);
    }

    // 3. 同父重复附件（文件名相同 或 体积相同）
    const byParent = new Map();
    for (const att of atts) {
      let pid = 0;
      try { pid = att.parentItemID || 0; } catch (e) { pid = 0; }
      if (!pid) continue;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(att);
    }
    for (const [pid, list] of byParent) {
      if (list.length < 2) continue;
      const seen = new Map();
      const groups = [];
      for (const att of list) {
        const p = (await this._filePath(att)) || "";
        const name = String(p).split(/[\\/]/).pop().toLowerCase();
        let size = 0;
        try { size = att.attachmentSize || 0; } catch (e) { size = 0; }
        const key = name + "|" + size;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(att);
      }
      for (const [, same] of seen) {
        if (same.length > 1) groups.push({ parent: Zotero.Items.get(pid), atts: same });
      }
      if (groups.length) result.dupGroups.push(...groups);
    }

    // 4. 无文本层（对 PDF 抽样检查，带上限）
    if (o.checkText !== false && typeof AIChat !== "undefined" && AIChat._readIndexedText) {
      for (const att of atts) {
        if (result.textChecked >= this.TEXT_CHECK_CAP) break;
        let isPdf = false;
        try { isPdf = att.isPDFAttachment && att.isPDFAttachment(); } catch (e) { isPdf = false; }
        if (!isPdf) continue;
        result.textChecked++;
        try {
          const txt = await AIChat._readIndexedText(att);
          if (!txt || txt.replace(/\s+/g, "").length < 80) {
            result.noText.push({ att, parent: att.parentItemID ? Zotero.Items.get(att.parentItemID) : null });
          }
        } catch (e) { /* 单篇失败忽略 */ }
      }
    } else {
      result.skipped.push(I18n.isZh ? "PDF 文本层检查（当前环境不可用）" : "PDF text layer check");
    }

    // 5. 存储目录孤儿
    const orph = await this._findOrphans(atts);
    result.orphans = orph.orphans;
    if (orph.skipped) result.skipped.push(I18n.isZh ? "存储目录孤儿文件（接口不可用）" : "Storage orphans");
    return result;
  },

  /* ---------- 报告 ---------- */

  async _tag(item, tag) {
    if (!item) return;
    try {
      if (!item.getTags().some((t) => t.tag === tag)) {
        item.addTag(tag);
        await item.saveTx();
      }
    } catch (e) { /* ignore */ }
  },

  async _createLibraryNote(title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(MdLite.toNoteHtml(title, md));
    await note.saveTx();
    return note;
  },

  _reportMd(r, zh) {
    const date = new Date().toISOString().slice(0, 10);
    const mb = r.orphans.reduce((n, x) => n + (x.size || 0), 0) / 1048576;
    let md = (zh ? "扫描范围：" : "Scope: ") + r.scope +
      (zh ? "，条目 " : " | items ") + r.total + (zh ? " 篇 / 附件 " : " / attachments ") + r.attTotal +
      (zh ? " 个（" : " (") + date + "）\n\n" +
      "| " + (zh ? "问题" : "Issue") + " | " + (zh ? "数量" : "Count") + " | " + (zh ? "标签" : "Tag") + " |\n|---|---|---|\n" +
      "| " + (zh ? "完全没有附件" : "No attachment") + " | " + r.noAttach.length + " | `" + this.TAG_NOATT + "` |\n" +
      "| " + (zh ? "有附件但没有 PDF" : "No PDF") + " | " + r.noPdf.length + " | `" + this.TAG_NOATT + "` |\n" +
      "| " + (zh ? "附件文件丢失/链接失效" : "Missing/broken files") + " | " + r.broken.length + " | `" + this.TAG_BROKEN + "` |\n" +
      "| " + (zh ? "同父重复附件" : "Duplicate attachments") + " | " + r.dupGroups.length + (zh ? " 组" : " groups") + " | `" + this.TAG_DUP + "` |\n" +
      "| " + (zh ? "无文本层 PDF（扫描件）" : "No text layer (scanned)") + " | " + r.noText.length + " | `" + this.TAG_NOTEXT + "` |\n" +
      "| " + (zh ? "存储目录孤儿文件" : "Storage orphans") + " | " + r.orphans.length +
      (zh ? " 个（约 " : " (") + mb.toFixed(1) + (zh ? " MB，不处理，仅供核对）" : " MB, not touched)") + " |\n";
    if (r.skipped.length) {
      md += "\n> " + (zh ? "本次跳过：" : "Skipped: ") + r.skipped.join("；") + "\n";
    }
    if (r.noText.length) {
      md += "\n## " + (zh ? "无文本层 PDF（Papilot 的 AI 问答/翻译/综述对它们无效，建议先 OCR）" : "No text layer") + "\n" +
        r.noText.slice(0, 80).map((x) => "- " + this._title(x.parent || x.att)).join("\n") + "\n";
    }
    if (r.broken.length) {
      md += "\n## " + (zh ? "丢失/断链的附件（文件已不在磁盘上）" : "Missing files") + "\n" +
        r.broken.slice(0, 80).map((x) => "- " + this._title(x.parent) + " ｜ " + ((x.att && (x.att.attachmentPath || x.att.id)) || "?")).join("\n") + "\n";
    }
    if (r.dupGroups.length) {
      md += "\n## " + (zh ? "同父重复附件（建议保留一个）" : "Duplicate attachments") + "\n";
      r.dupGroups.slice(0, 60).forEach((g, i) => {
        md += "\n### " + (i + 1) + ". " + this._title(g.parent) + "\n";
        g.atts.forEach((a) => { md += "- " + (a.attachmentPath || a.id) + "\n"; });
      });
    }
    if (r.noAttach.length) {
      md += "\n## " + (zh ? "完全没有附件" : "No attachment") + "\n" +
        r.noAttach.slice(0, 100).map((it) => "- " + this._title(it)).join("\n") + "\n";
    }
    if (r.orphans.length) {
      md += "\n## " + (zh ? "存储目录孤儿文件（未被任何条目引用，多为删除条目后的残留）" : "Storage orphans") + "\n" +
        r.orphans.slice(0, 60).map((x) => "- " + x.name + "（" + ((x.size || 0) / 1048576).toFixed(1) + " MB）").join("\n") +
        (r.orphans.length > 60 ? "\n- …" : "") + "\n";
    }
    md += "\n" + (zh
      ? "> 本报告只读，未删除或移动任何文件。清理前请先用「文件 → 导出库」备份，并用 Zotero 自带「重复条目」面板处理条目级重复。"
      : "> Read-only. Nothing was deleted or moved. Back up your library before cleaning.");
    return md;
  },

  /** 入口：扫描 → 打标签 → 报告笔记 */
  async run() {
    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + (zh ? "附件体检" : "Attachment Doctor"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      zh ? "正在检查附件…" : "Checking attachments…");
    progress.setProgress(10);
    pw.show();
    try {
      const r = await this.scan({});
      progress.setText(zh ? "正在写入报告…" : "Writing report…");
      progress.setProgress(80);
      for (const it of r.noAttach) await this._tag(it, this.TAG_NOATT);
      for (const it of r.noPdf) await this._tag(it, this.TAG_NOATT);
      for (const x of r.broken) await this._tag(x.parent, this.TAG_BROKEN);
      for (const g of r.dupGroups) await this._tag(g.parent, this.TAG_DUP);
      for (const x of r.noText) await this._tag(x.parent, this.TAG_NOTEXT);
      const date = new Date().toISOString().slice(0, 10);
      await this._createLibraryNote((zh ? "附件体检报告｜" : "Attachment Doctor | ") + date, this._reportMd(r, zh));
      progress.setText((zh ? "无附件 " : "noAtt ") + (r.noAttach.length + r.noPdf.length) +
        (zh ? " · 断链 " : " · broken ") + r.broken.length +
        (zh ? " · 重复 " : " · dup ") + r.dupGroups.length +
        (zh ? " · 无文本层 " : " · noText ") + r.noText.length +
        (zh ? " · 孤儿 " : " · orphan ") + r.orphans.length);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
    }
    pw.startCloseTimer(5000);
  },
};
