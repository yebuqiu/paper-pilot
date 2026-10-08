/* PaperPilot 全文补全（多源链：Unpaywall → Sci-Hub → Sci-Net）
 * 0.11.0：Unpaywall 合法开放获取渠道 —— 有 DOI 无 PDF 的条目查 OA 版本并导入。
 * 0.27.0：未命中时按设置可选接力 Sci-Hub / Sci-Net 补充渠道（features/scihub.js）：
 *         Sci-Hub 按镜像顺序探测（sci-hub.ru → .se → .st），未收录的新文献兜底 Sci-Net。
 *         渠道默认开启、可在插件设置中关闭；被要求人机验证时在 Zotero 中打开验证页，
 *         完成验证（cookie 存于 Zotero 会话）后重跑即可。仅供个人学术研究用途。
 * pref：unpaywallEmail / scihubEnabled / scihubMirrors / scinetEnabled / scinetUrl。
 */
/* global Zotero, Prefs, I18n, ItemSel, CitationColumn, SciHub, PathUtils, IOUtils */

var OAFetch = {
  API: "https://api.unpaywall.org/v2/",

  /** 从 Unpaywall 响应挑最佳 PDF URL */
  _pickUrl(json) {
    if (!json || typeof json !== "object") return "";
    const loc = json.best_oa_location;
    if (loc && loc.url_for_pdf) return loc.url_for_pdf;
    for (const l of json.oa_locations || []) {
      if (l && l.url_for_pdf) return l.url_for_pdf;
    }
    return (loc && loc.url) || "";
  },

  async _lookup(doi, email) {
    const url = this.API + encodeURIComponent(doi) + "?email=" + encodeURIComponent(email);
    const req = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 30000 });
    return req.response;
  },

  /** 条目是否已有 PDF 附件 */
  _hasPdf(item) {
    try {
      for (const id of item.getAttachments()) {
        const a = Zotero.Items.get(id);
        if (a && a.isPDFAttachment && a.isPDFAttachment()) return true;
        if (a && a.attachmentContentType === "application/pdf") return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  /** 字节 → 临时文件 → 挂为条目的 PDF 附件（%PDF 校验已由 SciHub 侧完成） */
  async _importBytes(item, bytes, title) {
    const tmp = PathUtils.join(PathUtils.tempDir, "paperpilot-fulltext-" + Date.now() + "-" + Math.floor(Math.random() * 1e4) + ".pdf");
    await IOUtils.write(tmp, bytes);
    try {
      const att = await Zotero.Attachments.importFromFile({ file: tmp, parentItemID: item.id });
      try {
        att.setField("title", (title || "Full Text PDF").slice(0, 200));
        await att.saveTx();
      } catch (e) { /* ignore */ }
      return att;
    } finally {
      try { await IOUtils.remove(tmp, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
  },

  /**
   * 单条目补全文。
   * ctx：{ email, scihub, scinet } —— 渠道开关（captcha/unreachable 后的「本次运行停试」由调用方控制）
   * 返回 { status }，status ∈
   *   "has-pdf" | "no-doi" | "added"（Unpaywall） | "added-scihub" | "added-scinet"
   *   | "not-found" | "captcha" | "unreachable" | "error"
   * captcha / unreachable 附带 { host, pageUrl }（供调用方打开验证页）。
   */
  async fill(item, ctx) {
    ctx = ctx || {};
    if (this._hasPdf(item)) return { status: "has-pdf" };

    let doi = "";
    try { doi = CitationColumn.normalizeDOI(item.getField("DOI") || ""); } catch (e) { /* ignore */ }
    if (!doi) return { status: "no-doi" };

    // ① Unpaywall（合法开放获取源；接口异常不阻断后续补充渠道）
    try {
      const json = await this._lookup(doi, ctx.email);
      const pdfUrl = this._pickUrl(json);
      if (pdfUrl) {
        await Zotero.Attachments.importFromURL({
          url: pdfUrl,
          parentItemID: item.id,
          title: "Full Text PDF (OA)",
          contentType: "application/pdf",
        });
        return { status: "added" };
      }
    } catch (e) {
      try { Zotero.debug("PaperPilot oaFetch: Unpaywall 查询失败 - " + (e && e.message)); } catch (e2) { /* ignore */ }
    }

    // ② Sci-Hub（补充渠道，按镜像顺序探测）
    let s1 = null;
    if (ctx.scihub) {
      try { s1 = await SciHub.fetchPdf(doi); }
      catch (e) { s1 = { status: "error", message: String((e && e.message) || e) }; }
      if (s1.status === "ok") {
        await this._importBytes(item, s1.bytes, "Full Text PDF (Sci-Hub)");
        return { status: "added-scihub" };
      }
      if (s1.status === "captcha") {
        return { status: "captcha", host: s1.host, pageUrl: s1.pageUrl };
      }
      if (s1.status !== "not-found" && s1.status !== "unreachable") {
        try { Zotero.debug("PaperPilot oaFetch: Sci-Hub " + s1.status + " - " + (s1.message || "")); } catch (e2) { /* ignore */ }
      }
    }

    // ③ Sci-Net（Sci-Hub 未收录 / 出错 / 不可达时兜底；换主机，可能仍可达）
    let s2 = null;
    if (ctx.scihub && ctx.scinet) {
      try { s2 = await SciHub.fetchFromSciNet(doi); }
      catch (e) { s2 = { status: "error", message: String((e && e.message) || e) }; }
      if (s2.status === "ok") {
        await this._importBytes(item, s2.bytes, "Full Text PDF (Sci-Net)");
        return { status: "added-scinet" };
      }
      if (s2.status === "captcha") {
        return { status: "captcha", host: s2.host, pageUrl: s2.pageUrl };
      }
    }

    // ④ 汇总：优先如实上报「不可达」（网络问题可修复），其余一律未找到
    if (s1 && s1.status === "unreachable") return { status: "unreachable", host: s1.host, pageUrl: s1.pageUrl };
    if (s2 && s2.status === "unreachable" && (!s1 || s1.status === "error")) {
      return { status: "unreachable", host: s2.host, pageUrl: s2.pageUrl };
    }
    return { status: "not-found" };
  },

  /** 打开验证页：优先 Zotero 内置查看器（与 Zotero.HTTP 共享 cookie 罐），失败再退外部浏览器 */
  _openVerifyPage(pageUrl, zh) {
    if (pageUrl) {
      try { Zotero.openInViewer(pageUrl); }
      catch (e) {
        try {
          const w = Zotero.getMainWindow();
          if (w && w.ZoteroPane && w.ZoteroPane.loadURI) w.ZoteroPane.loadURI(pageUrl);
          else Zotero.launchURL(pageUrl);
        } catch (e2) { try { Zotero.launchURL(pageUrl); } catch (e3) { /* ignore */ } }
      }
    }
    try {
      Zotero.alert(null, "PaperPilot",
        zh ? "Sci-Hub 要求人机验证：\n已尝试在 Zotero 中打开验证页面。请按页面提示完成验证（如点「Нет」），\n然后重新运行「补全文」。验证状态保存在 Zotero 会话中，一次即可。"
          : "Sci-Hub requires human verification:\nA verification page was opened in Zotero (if available). Complete it as instructed,\nthen run Find Full Text again. The verification is kept in Zotero's session.");
    } catch (e) { /* ignore */ }
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    const email = String(Prefs.get("unpaywallEmail", "") || "").trim() || "paperpilot@users.noreply.local";
    const useScihub = Prefs.get("scihubEnabled", true) !== false;
    const useScinet = useScihub && Prefs.get("scinetEnabled", true) !== false;

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("menuOaFetch"));
    pw.show();
    let nOA = 0, nSci = 0, nSnet = 0, nHas = 0, nMiss = 0, nNoDoi = 0, nErr = 0;
    let scihubBlocked = false;   // 验证拦截 / 不可达后，本次运行不再尝试补充渠道
    let captchaHandled = false;
    let unreachHandled = false;
    let first = true;

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        progress.setText(zh ? "检索中…" : "Searching…");
        const r = await this.fill(item, {
          email,
          scihub: useScihub && !scihubBlocked,
          scinet: useScinet && !scihubBlocked,
        });
        const st = r && r.status;
        if (st === "added") { nOA++; progress.setText(zh ? "已补全文 PDF（开放获取）" : "PDF added (OA)"); }
        else if (st === "added-scihub") { nSci++; progress.setText(zh ? "已补全文 PDF（Sci-Hub）" : "PDF added (Sci-Hub)"); }
        else if (st === "added-scinet") { nSnet++; progress.setText(zh ? "已补全文 PDF（Sci-Net）" : "PDF added (Sci-Net)"); }
        else if (st === "has-pdf") { nHas++; progress.setText(zh ? "已有 PDF" : "Has PDF"); }
        else if (st === "no-doi") { nNoDoi++; progress.setText(zh ? "无 DOI" : "No DOI"); }
        else if (st === "captcha") {
          nMiss++;
          scihubBlocked = true;
          progress.setText(zh ? "Sci-Hub 需人机验证（已开验证页）" : "Sci-Hub captcha (page opened)");
          if (!captchaHandled) { captchaHandled = true; this._openVerifyPage(r.pageUrl, zh); }
        }
        else if (st === "unreachable") {
          nMiss++;
          scihubBlocked = true;
          progress.setText(zh ? "Sci-Hub 镜像不可达" : "Sci-Hub unreachable");
          if (!unreachHandled) {
            unreachHandled = true;
            try {
              Zotero.alert(null, "PaperPilot",
                zh ? "无法连接 Sci-Hub 镜像（" + (r.host || "") + "）：\n网络可能阻断该域名。可在 设置 → 增强功能 中更换镜像列表（如 sci-hub.box），\n或稍后重试。"
                  : "Cannot reach Sci-Hub mirror (" + (r.host || "") + "):\nyour network may block it. Try another mirror in Settings → Enhanced Features\n(e.g. sci-hub.box) or retry later.");
            } catch (e) { /* ignore */ }
          }
        }
        else { nMiss++; progress.setText(zh ? "未找到可补的全文" : "No full text found"); }
        progress.setProgress(100);
      } catch (e) {
        nErr++;
        progress.setError();
        progress.setText((zh ? "出错：" : "Error: ") + String((e && e.message) || e).slice(0, 60));
        Zotero.logError(e);
      }
      if (!first) await new Promise((r) => setTimeout(r, 600)); // 礼貌限速
      first = false;
    }
    let sum = (zh ? "合计：已补 " : "Done: added ") + (nOA + nSci + nSnet) +
      (zh ? "（OA " : " (OA ") + nOA + (zh ? " / Sci-Hub " : " / Sci-Hub ") + nSci +
      (zh ? " / Sci-Net " : " / Sci-Net ") + nSnet + ")" +
      (zh ? "，已有 " : ", has ") + nHas +
      (zh ? "，未找到 " : ", miss ") + nMiss +
      (zh ? "，无 DOI " : ", no DOI ") + nNoDoi;
    if (nErr) sum += (zh ? "，出错 " : ", errors ") + nErr;
    if (captchaHandled) sum += (zh ? "；Sci-Hub 已暂停：完成验证后重跑" : "; Sci-Hub paused: verify then rerun");
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", sum);
    summary.setProgress(100);
    pw.startCloseTimer(6000);
  },
};
