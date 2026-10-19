// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 对照翻译导出（0.39.0）
 *
 * 为什么要有它：对照翻译完成后，用户手上只有「双语笔记」一个出口（Zotero 内部笔记），
 * 拿不出去、也分享不了。本模块补齐四种出口：
 *   · **双语 PDF 附件**：右栏每页 canvas（原版页面）+ 译文按段落原位叠画 → JPEG →
 *     自建 PDF → `Zotero.Attachments.importFromFile` 挂到该文献条目下（Zotero 里直接看）；
 *   · **双语 HTML 文件**：逐页逐段「原文 | 译文」两栏对照，自包含样式，可再转 Word；
 *   · **双语 Markdown 文件**：同上，纯文本便于二次加工；
 *   · **双语 Word (.docx)**：OOXML 最小集（两列表格）→ 自建 zip（nsIZipWriter）打包。
 *     ⚠️ 不能用 `Zotero.File.zipDirectory`：它明文跳过点文件，而 OOXML 必需的
 *     `_rels/.rels` 就是点文件（真机实踩，详见 writeZip 注释）。
 *
 * 为什么自建 PDF 生成器：插件**零运行时依赖**（AGENTS §2.2），而 pdf-lib / jsPDF 都是
 * npm 包。往 PDF 里直接嵌 JPEG 是规范允许的做法（`/Filter /DCTDecode`），几百行可闭环，
 * 且纯函数部分能在 Node 单测里用 pdfjs-dist 反解验证（test/pdf-export.test.js）。
 *
 * 分工：纯函数（可单测）= buildImagePdf / wrapByMeasure / buildBilingualHtml /
 * buildBilingualMarkdown / buildDocxFiles / xmlEscape；运行时 = capturePages（canvas 叠画）
 * / collectDoc（从内核 state 取段落）/ 各 export*（落盘或挂附件）。
 */
/* global Zotero, Services, I18n, PdfInline, BilingualTranslate, Notes, PathUtils, IOUtils */

var PdfExport = {
  PDF_TO_CSS: 96 / 72,          // pdf.js 的 CSS 像素 ↔ PDF 点换算（1pt = 1.333px）

  /* ==================== 纯函数 ==================== */

  xmlEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  },

  /** 按「测量函数」折行（测量函数注入 → 纯函数，可在 Node 单测） */
  wrapByMeasure(text, maxWidth, measure) {
    const s = String(text == null ? "" : text);
    const out = [];
    const w = Number(maxWidth) > 0 ? Number(maxWidth) : 100;
    const m = typeof measure === "function" ? measure : (t) => t.length * 8;
    let line = "";
    for (const ch of s) {
      if (ch === "\n") { out.push(line); line = ""; continue; }
      const t = line + ch;
      if (line && m(t) > w) { out.push(line); line = ch; }
      else line = t;
    }
    out.push(line);
    return out;
  },

  /**
   * 自建 PDF（每页一张 JPEG 全幅铺满）。pages = [{jpeg:Uint8Array, pxW, pxH, ptW?, ptH?}]
   * @returns {Uint8Array}
   */
  buildImagePdf(pages) {
    const list = (pages || []).filter((p) => p && p.jpeg && p.jpeg.length && p.pxW > 0 && p.pxH > 0);
    if (!list.length) throw new Error("buildImagePdf: no pages");
    const enc = new TextEncoder();
    const chunks = [];
    let len = 0;
    const push = (u8) => { chunks.push(u8); len += u8.length; };
    const pushStr = (s) => push(enc.encode(s));
    const fmt = (n) => {
      const v = Math.round(Number(n) * 100) / 100;
      return String(v);
    };

    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,   // %PDF-1.4
      0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));                                     // 二进制注释

    const n = list.length;
    const N_OBJ = 2 + n * 3;
    const off = new Array(N_OBJ + 1).fill(0);
    const begin = (id) => { off[id] = len; pushStr(id + " 0 obj\n"); };
    const end = () => pushStr("endobj\n");

    begin(1);
    pushStr("<< /Type /Catalog /Pages 2 0 R >>\n");
    end();

    const kids = [];
    for (let i = 0; i < n; i++) kids.push((3 + i * 3) + " 0 R");
    begin(2);
    pushStr("<< /Type /Pages /Count " + n + " /Kids [" + kids.join(" ") + "] >>\n");
    end();

    for (let i = 0; i < n; i++) {
      const p = list[i];
      const pageId = 3 + i * 3, contId = pageId + 1, imgId = pageId + 2;
      const ptW = p.ptW || p.pxW, ptH = p.ptH || p.pxH;
      begin(pageId);
      pushStr("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + fmt(ptW) + " " + fmt(ptH) + "] "
        + "/Resources << /XObject << /Im0 " + imgId + " 0 R >> /ProcSet [/PDF /ImageC] >> "
        + "/Contents " + contId + " 0 R >>\n");
      end();
      const content = "q " + fmt(ptW) + " 0 0 " + fmt(ptH) + " 0 0 cm /Im0 Do Q\n";
      begin(contId);
      pushStr("<< /Length " + content.length + " >>\nstream\n" + content + "endstream\n");
      end();
      begin(imgId);
      pushStr("<< /Type /XObject /Subtype /Image /Width " + p.pxW + " /Height " + p.pxH
        + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "
        + p.jpeg.length + " >>\nstream\n");
      push(p.jpeg);
      pushStr("\nendstream\n");
      end();
    }

    const xrefPos = len;
    let xref = "xref\n0 " + (N_OBJ + 1) + "\n0000000000 65535 f \n";
    for (let id = 1; id <= N_OBJ; id++) xref += String(off[id]).padStart(10, "0") + " 00000 n \n";
    pushStr(xref);
    pushStr("trailer\n<< /Size " + (N_OBJ + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");

    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  },

  /** 双语 HTML（自包含样式；两栏对照） */
  buildBilingualHtml(doc) {
    const d = doc || {};
    const esc = this.xmlEscape;
    const parts = [];
    parts.push("<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n");
    parts.push("<title>" + esc(d.title || "双语对照") + "</title>\n<style>\n"
      + "body{font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif;margin:24px;color:#111;}\n"
      + "h1{font-size:20px;margin:0 0 4px;} .meta{color:#666;font-size:12px;margin-bottom:18px;}\n"
      + "h2{font-size:15px;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #ddd;}\n"
      + "table{width:100%;border-collapse:collapse;table-layout:fixed;}\n"
      + "th,td{border:1px solid #e3e3e3;padding:6px 8px;vertical-align:top;font-size:13px;line-height:1.5;}\n"
      + "th{background:#f6f6f6;text-align:left;}\n"
      + "td.src{width:50%;color:#333;} td.dst{width:50%;}\n"
      + "</style>\n</head>\n<body>\n");
    parts.push("<h1>" + esc(d.title || "") + "</h1>\n");
    parts.push("<div class=\"meta\">" + esc(d.meta || "") + "</div>\n");
    for (const pg of (d.pages || [])) {
      parts.push("<h2>" + esc((I18n && I18n.isZh ? "第 " : "Page ") + pg.num + (I18n && I18n.isZh ? " 页" : "")) + "</h2>\n");
      parts.push("<table>\n<thead><tr><th>" + esc(I18n && I18n.isZh ? "原文" : "Source")
        + "</th><th>" + esc(I18n && I18n.isZh ? "译文" : "Translation") + "</th></tr></thead>\n<tbody>\n");
      for (const b of (pg.blocks || [])) {
        parts.push("<tr><td class=\"src\">" + esc(b.src) + "</td><td class=\"dst\">" + esc(b.dst) + "</td></tr>\n");
      }
      parts.push("</tbody>\n</table>\n");
    }
    parts.push("</body>\n</html>\n");
    return parts.join("");
  },

  /** 双语 Markdown */
  buildBilingualMarkdown(doc) {
    const d = doc || {};
    const out = [];
    out.push("# " + String(d.title || "双语对照") + "\n");
    if (d.meta) out.push("> " + String(d.meta) + "\n");
    for (const pg of (d.pages || [])) {
      out.push("\n## " + (I18n && I18n.isZh ? "第 " + pg.num + " 页" : "Page " + pg.num) + "\n");
      for (const b of (pg.blocks || [])) {
        out.push("**" + (I18n && I18n.isZh ? "原文" : "Source") + "**\n\n" + String(b.src || "") + "\n");
        out.push("**" + (I18n && I18n.isZh ? "译文" : "Translation") + "**\n\n" + String(b.dst || "") + "\n");
      }
    }
    return out.join("\n");
  },

  /** Docx（OOXML 最小集）的各个文件内容 → {相对路径: 文本}；打包交给 Zotero.File.zipDirectory */
  buildDocxFiles(doc) {
    const d = doc || {};
    const esc = this.xmlEscape;
    const run = (t) => "<w:r><w:t xml:space=\"preserve\">" + esc(t) + "</w:t></w:r>";
    const para = (t, bold) => "<w:p>" + (bold ? "<w:pPr><w:rPr><w:b/></w:rPr></w:pPr>" : "")
      + "<w:r>" + (bold ? "<w:rPr><w:b/></w:rPr>" : "") + "<w:t xml:space=\"preserve\">" + esc(t) + "</w:t></w:r></w:p>";
    const cell = (t, w, bold) => "<w:tc><w:tcPr><w:tcW w:w=\"" + w + "\" w:type=\"dxa\"/></w:tcPr>"
      + para(t, bold) + "</w:tc>";

    const rows = [];
    rows.push("<w:tr>" + cell(I18n && I18n.isZh ? "原文" : "Source", 4680, true)
      + cell(I18n && I18n.isZh ? "译文" : "Translation", 4680, true) + "</w:tr>");
    for (const pg of (d.pages || [])) {
      rows.push("<w:tr>" + cell((I18n && I18n.isZh ? "第 " + pg.num + " 页" : "Page " + pg.num), 4680, true)
        + cell("", 4680, false) + "</w:tr>");
      for (const b of (pg.blocks || [])) {
        rows.push("<w:tr>" + cell(b.src, 4680, false) + cell(b.dst, 4680, false) + "</w:tr>");
      }
    }
    const tbl = "<w:tbl><w:tblPr><w:tblW w:w=\"9360\" w:type=\"dxa\"/><w:tblBorders>"
      + ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) =>
        "<w:" + s + " w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"D0D0D0\"/>").join("")
      + "</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w=\"4680\"/><w:gridCol w:w=\"4680\"/></w:tblGrid>"
      + rows.join("") + "</w:tbl>";
    const body = "<w:body>" + para(d.title || "", true)
      + (d.meta ? para(d.meta, false) : "") + tbl
      + "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>"
      + "<w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\"/></w:sectPr></w:body>";

    const documentXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
      + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
      + body + "</w:document>";
    const contentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
      + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
      + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
      + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
      + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
      + "</Types>";
    const rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
      + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
      + "</Relationships>";
    return { "[Content_Types].xml": contentTypes, "_rels/.rels": rels, "word/document.xml": documentXml };
  },

  /* ==================== 运行时：取数据 ==================== */

  /** 从内核 state 收集「逐页逐段」对照数据（只取已落定的段） */
  collectDoc(reader, title, meta) {
    const pages = [];
    try {
      const st = PdfInline && PdfInline._states ? PdfInline._states.get(reader) : null;
      if (st && st.pageBlocks) {
        const nums = Array.from(st.pageBlocks.keys()).sort((a, b) => Number(a) - Number(b));
        for (const n of nums) {
          const blocks = (st.pageBlocks.get(n) || [])
            .filter((b) => b && b.kind !== "formula" && String(b.text || "").trim());
          if (!blocks.length) continue;
          pages.push({
            num: String(n),
            blocks: blocks.map((b) => ({
              src: String(b.text || "").replace(/\s+/g, " ").trim(),
              dst: b.dst == null ? "" : String(b.dst),
            })),
          });
        }
      }
    } catch (e) { /* ignore */ }
    return { title: title || "", meta: meta || "", pages };
  },

  /** 页元素里的 canvas（pdf.js 渲染出的原版页面）→ 复制一份并叠画译文 */
  _pageCanvas(pageEl) {
    try { return pageEl.querySelector("canvas"); } catch (e) { return null; }
  },

  /** 把一段译文画进 canvas（与窗口 mono 卡片的观感一致：浅底 + 深字 + 细描边） */
  _drawBlock(ctx, b, k) {
    const text = String(b.dst == null ? "" : b.dst).trim();
    const pad = 2 * k;
    const left = Math.max(0, (b.left || 0) - 2);
    const top = Math.max(0, (b.top || 0) - 2);
    const w = Math.max(40, ((b.right || 0) - (b.left || 0)) + 4) * k;
    const h = Math.max(10, (b.height || 0) + 4) * k;
    const x = left * k, y = top * k;
    const maxH = Math.max(30, Math.max((b.height || 0) * 3.2, (b.height || 0) + 44)) * k;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(127,127,127,0.45)";
    ctx.lineWidth = Math.max(0.5, 0.6 * k);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (!text) { ctx.restore(); return; }
    let fs = Math.max(6, (b.fontSize || 10)) * k;
    const fontOf = (size) => size + "px \"Microsoft YaHei\",\"PingFang SC\",\"Noto Sans CJK SC\",sans-serif";
    ctx.fillStyle = "#111111";
    ctx.textBaseline = "top";
    // 内容超高 → 降档（与窗口 fitFontSize 同策略：最多降 8 档，保底 6px）
    let lines = [];
    for (let i = 0; i < 8; i++) {
      ctx.font = fontOf(fs);
      lines = PdfExport.wrapByMeasure(text, w - pad * 2, (s) => ctx.measureText(s).width);
      if (lines.length * fs * 1.28 <= maxH || fs <= 6) break;
      fs = Math.max(6, fs * 0.85);
    }
    ctx.beginPath();
    ctx.rect(x, y, w, maxH);
    ctx.clip();
    let ty = y + 1;
    for (const ln of lines) {
      if (ty > y + maxH) break;
      ctx.fillText(ln, x + pad, ty);
      ty += fs * 1.28;
    }
    ctx.restore();
  },

  /** 捕获「已渲染页」：canvas 原图 + 译文叠画 → JPEG。未渲染/无译文的页进 skipped */
  async capturePages(reader) {
    const out = { pages: [], skipped: [] };
    let st = null;
    try { st = PdfInline && PdfInline._states ? PdfInline._states.get(reader) : null; } catch (e) { st = null; }
    if (!st || !st.doc) return out;
    const doc = st.doc;
    const nums = Array.from(st.pageBlocks.keys()).sort((a, b) => Number(a) - Number(b));
    for (const num of nums) {
      const blocks = (st.pageBlocks.get(num) || []).filter((b) => b && b.kind !== "formula");
      if (!blocks.length) continue;
      let pe = null;
      try { pe = doc.querySelector('.page[data-page-number="' + num + '"]'); } catch (e) { pe = null; }
      const src = pe ? this._pageCanvas(pe) : null;
      if (!src || !src.width || !src.height) { out.skipped.push(String(num)); continue; }
      try {
        const cssW = pe.clientWidth || pe.offsetWidth || src.width;
        const cssH = pe.clientHeight || pe.offsetHeight || src.height;
        const cv = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        cv.width = src.width;
        cv.height = src.height;
        const ctx = cv.getContext("2d");
        if (!ctx) { out.skipped.push(String(num)); continue; }
        ctx.drawImage(src, 0, 0);
        const k = src.width / cssW;
        for (const b of blocks) this._drawBlock(ctx, b, k);
        const jpeg = await this._canvasJpeg(cv);
        if (!jpeg) { out.skipped.push(String(num)); continue; }
        out.pages.push({
          num: String(num), jpeg,
          pxW: cv.width, pxH: cv.height,
          ptW: cssW / this.PDF_TO_CSS, ptH: cssH / this.PDF_TO_CSS,
        });
      } catch (e) {
        out.skipped.push(String(num));
      }
    }
    return out;
  },

  _canvasJpeg(canvas) {
    return new Promise((resolve) => {
      try {
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob((blob) => {
            if (!blob) { resolve(null); return; }
            try {
              blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), () => resolve(null));
            } catch (e) {
              // 老实现：FileReader
              try {
                const fr = new FileReader();
                fr.onload = () => resolve(new Uint8Array(fr.result));
                fr.onerror = () => resolve(null);
                fr.readAsArrayBuffer(blob);
              } catch (e2) { resolve(null); }
            }
          }, "image/jpeg", 0.92);
          return;
        }
        const url = canvas.toDataURL("image/jpeg", 0.92);
        const b64 = String(url).split(",")[1] || "";
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        resolve(u8);
      } catch (e) { resolve(null); }
    });
  },

  /* ==================== 运行时：出口 ==================== */

  _metaLine() {
    const lang = (() => {
      try { return (typeof TranslateSvc !== "undefined" && TranslateSvc.targetName) ? (TranslateSvc.targetName() || "") : ""; }
      catch (e) { return ""; }
    })();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " "
      + pad(d.getHours()) + ":" + pad(d.getMinutes());
    return (I18n && I18n.isZh ? "由 Papilot 生成 · " : "Generated by Papilot · ")
      + ts + (lang ? (" · " + (I18n && I18n.isZh ? "译至 " : "to ") + lang) : "");
  },

  _safeName(s) {
    return String(s || "paper").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "paper";
  },

  /** 双语 PDF → 作为附件挂到条目下（outPath 给定时改为直接落盘：自检/诊断用） */
  async exportPdfAttachment(item, reader, title, outPath) {
    const doc = this.collectDoc(reader, title, this._metaLine());
    if (!doc.pages.length) {
      return { ok: false, error: I18n && I18n.isZh ? "还没有译文可导出（请等翻译完成，或先点「翻译全文」）" : "Nothing translated yet" };
    }
    const cap = await this.capturePages(reader);
    if (!cap.pages.length) {
      return {
        ok: false,
        error: (I18n && I18n.isZh
          ? "没有可捕获的已渲染页面（请先点「翻译全文」，让页面渲染出来）"
          : "No rendered pages to capture — run “Translate whole doc” first"),
      };
    }
    let bytes = null;
    try { bytes = this.buildImagePdf(cap.pages); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const name = this._safeName(title) + (I18n && I18n.isZh ? "（双语）.pdf" : " (bilingual).pdf");
    // 诊断/自检路径：只落盘，不动用户库
    if (outPath) {
      try {
        await IOUtils.write(outPath, bytes);
        return { ok: true, path: outPath, pages: cap.pages.length, skipped: cap.skipped.length, bytes: bytes.length };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
    const tmp = PathUtils.join(PathUtils.tempDir, "papilot-bi-" + Date.now() + ".pdf");
    try {
      await IOUtils.write(tmp, bytes);
      const att = await Zotero.Attachments.importFromFile({ file: tmp, parentItemID: item.id });
      try {
        if (att && att.setField) {
          att.setField("title", name.slice(0, 200));
          await att.saveTx();
        }
      } catch (e) { /* 命名失败不影响附件本体 */ }
      return { ok: true, pages: cap.pages.length, skipped: cap.skipped.length, bytes: bytes.length, attachmentID: att && att.id };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      try { await IOUtils.remove(tmp, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
  },

  /** 文本类导出（html / md）→ 文件选择器落盘（outPath 给定则直接写） */
  async exportTextFile(kind, doc, title, outPath) {
    const isHtml = kind === "html";
    const text = isHtml ? this.buildBilingualHtml(doc) : this.buildBilingualMarkdown(doc);
    const ext = isHtml ? "html" : "md";
    const path = outPath || await this._pickSavePath(this._safeName(title) + (I18n && I18n.isZh ? "（双语）" : " (bilingual)") + "." + ext, ext);
    if (!path) return { ok: false, canceled: true };
    try {
      await IOUtils.writeUTF8(path, text);
      return { ok: true, path, paragraphs: this._countBlocks(doc) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  /** 双语 Word (.docx)：OOXML 部件 → 写临时目录 → 自建 zip（条目名可控）→ 落盘 */
  async exportDocx(doc, title, outPath) {
    const path = outPath || await this._pickSavePath(this._safeName(title) + (I18n && I18n.isZh ? "（双语）" : " (bilingual)") + ".docx", "docx");
    if (!path) return { ok: false, canceled: true };
    const dir = PathUtils.join(PathUtils.tempDir, "papilot-docx-" + Date.now());
    const sep = String(dir).indexOf("\\") >= 0 ? "\\" : "/";
    try {
      const files = this.buildDocxFiles(doc);
      for (const [rel, content] of Object.entries(files)) {
        const full = dir + sep + rel.split("/").join(sep);
        const parent = full.slice(0, full.lastIndexOf(sep));
        try { await IOUtils.makeDirectory(parent, { createAncestors: true, ignoreExisting: true }); }
        catch (e) { /* 已存在 */ }
        await IOUtils.writeUTF8(full, content);
      }
      this.writeZipFromDir(dir, Object.keys(files), path, sep);
      return { ok: true, path, paragraphs: this._countBlocks(doc) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      try { await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
  },

  /** 自建 zip（nsIZipWriter + addEntryFile：**条目名由我们显式给**）。
   *  ★ 为什么不用 Zotero.File.zipDirectory：它明文跳过以点开头的文件
   *  （`if (entry.name.startsWith('.')) continue`），而 OOXML 必需的包级关系部件
   *  `_rels/.rels` 正是点文件 → 打出来的 docx 缺件、Word 打不开
   *  （0.39.0 首轮真机自检实踩：产物只有 [Content_Types].xml 与 word/document.xml）。
   *  另：nsIStringInputStream 在本机 Gecko 没有 setData（第二轮实踩）→ 走「先落盘再按名加条目」，
   *  既避开流 API 差异，又能精确控制条目名。 */
  writeZipFromDir(dir, names, outPath, sep) {
    const Cc = Components.classes;
    const Ci = Components.interfaces;
    const s = sep || (String(dir).indexOf("\\") >= 0 ? "\\" : "/");
    const zw = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
    const PR_RDWR = 0x04, PR_CREATE_FILE = 0x08, PR_TRUNCATE = 0x20;
    zw.open(Zotero.File.pathToFile(outPath), PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);
    try {
      for (const name of names) {
        const full = dir + s + name.split("/").join(s);
        zw.addEntryFile(name, Ci.nsIZipWriter.COMPRESSION_DEFAULT, Zotero.File.pathToFile(full), false);
      }
    } finally {
      zw.close();
    }
    return true;
  },

  _countBlocks(doc) {
    let n = 0;
    for (const p of ((doc && doc.pages) || [])) n += (p.blocks || []).length;
    return n;
  },

  /** 文件保存对话框（modeSave）→ 绝对路径；取消返回 null */
  _pickSavePath(name, ext) {
    return new Promise((resolve) => {
      try {
        const nsIFilePicker = Components.interfaces.nsIFilePicker;
        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(Zotero.getMainWindow(), I18n && I18n.isZh ? "导出双语文件" : "Export bilingual file", nsIFilePicker.modeSave);
        fp.defaultString = name;
        if (ext) { try { fp.defaultExtension = ext; } catch (e) { /* ignore */ } }
        if (ext === "html") fp.appendFilter("HTML", "*.html");
        else if (ext === "md") fp.appendFilter("Markdown", "*.md");
        else if (ext === "docx") fp.appendFilter("Word", "*.docx");
        fp.appendFilters(nsIFilePicker.filterAll);
        fp.open((rv) => {
          if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) { resolve(null); return; }
          try { resolve(fp.file.path); } catch (e) { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  },

  /** 窗口「导出 ▾」的统一入口（pdf/html/md/docx）；ctx.outPath 供自检/诊断落盘 */
  async exportAs(kind, ctx) {
    const c = ctx || {};
    const doc = this.collectDoc(c.reader, c.title, this._metaLine());
    if (!doc.pages.length) {
      return { ok: false, error: I18n && I18n.isZh ? "还没有译文可导出（请等翻译完成，或先点「翻译全文」）" : "Nothing translated yet" };
    }
    if (kind === "pdf") return this.exportPdfAttachment(c.item, c.reader, c.title, c.outPath);
    if (kind === "html") return this.exportTextFile("html", doc, c.title, c.outPath);
    if (kind === "md") return this.exportTextFile("md", doc, c.title, c.outPath);
    if (kind === "docx") return this.exportDocx(doc, c.title, c.outPath);
    return { ok: false, error: "unknown kind: " + kind };
  },
};
