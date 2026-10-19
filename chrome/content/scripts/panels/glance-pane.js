// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot PDF 速览侧栏（0.11.0，pdf-preview 品类的轻量路线）
 * ItemPane section：选中条目即显示「摘要 + 全文开篇」，不打开 PDF 也能速览内容。
 * 轻量原因：pdf-preview 的缩略图渲染依赖 pdf.js 离屏绘制，重且易随版本碎；
 * 本实现复用 AIChat 全文索引缓存（首次读取后即缓存，切换无延迟）。
 */
/* global Zotero, AIChat, I18n */

var GlancePane = {
  PANE_ID: "papilot-glance",
  _panes: new Map(),
  _registered: false,

  _h(doc, tag, attrs = {}, text) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const k in attrs) {
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _state(paneID) {
    if (!this._panes.has(paneID)) {
      this._panes.set(paneID, { item: null, token: 0 });
    }
    return this._panes.get(paneID);
  },

  _usable(item) {
    return !!(item && (
      (item.isRegularItem && item.isRegularItem()) ||
      (item.isPDFAttachment && item.isPDFAttachment())
    ));
  },

  register(pluginID) {
    if (this._registered) return;
    const self = this;
    const registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: this.PANE_ID,
      pluginID,
      header: {
        l10nID: "papilot-glance-section-header",
        icon: "chrome://papilot/content/icons/chat.svg",
      },
      sidenav: {
        l10nID: "papilot-glance-section-sidenav",
        icon: "chrome://papilot/content/icons/chat.svg",
      },
      onRender({ paneID, doc, body }) {
        if (body.querySelector("[data-pp-glance-root]")) return;
        const H = (t, a, x) => self._h(doc, t, a, x);
        const root = H("div", {
          "data-pp-glance-root": "1",
          style: "display:flex;flex-direction:column;gap:6px;padding:6px;font-size:13px;line-height:1.6;",
        });
        const absEl = H("div", {
          style: "max-height:160px;overflow-y:auto;padding:6px 8px;border-radius:6px;" +
            "background:#88888812;border:1px solid #88888830;white-space:pre-wrap;word-break:break-word;",
        }, "—");
        const ftLabel = H("div", { style: "font-weight:600;color:var(--fill-secondary,#666);font-size:12px;" },
          I18n.isZh ? "全文开篇" : "Opening");
        const ftEl = H("div", {
          style: "max-height:220px;overflow-y:auto;padding:6px 8px;border-radius:6px;" +
            "background:#88888812;border:1px solid #88888830;white-space:pre-wrap;word-break:break-word;",
        }, "—");
        root.appendChild(absEl);
        root.appendChild(ftLabel);
        root.appendChild(ftEl);
        body.appendChild(root);
        const stNow = self._state(paneID);
        stNow.refs = { absEl, ftEl };
        // section 延迟展开场景：onItemChange 先于 onRender 到达时内容停在占位符，
        // 渲染完成时若已有当前条目，立即补一次加载
        if (stNow.item) {
          self._load(paneID).catch((e) => {
            try { Zotero.logError(e); } catch (_) { /* ignore */ }
          });
        }
      },
      onItemChange({ paneID, item, setEnabled }) {
        const ok = self._usable(item);
        setEnabled(ok);
        const st = self._state(paneID);
        const changed = (item && (!st.item || st.item.id !== item.id)) || (!item && st.item);
        st.item = item || null;
        if (changed) self._load(paneID).catch((e) => {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        });
        return true;
      },
      onDestroy({ paneID }) {
        self._panes.delete(paneID);
      },
    });
    if (!registeredPaneID) {
      throw new Error("ItemPaneManager.registerSection 校验失败（返回 false），glance section 未注册");
    }
    this._registeredPaneID = registeredPaneID;
    this._registered = true;
  },

  /** 载入摘要 + 全文开篇（带 token 防快速切换时的串扰） */
  async _load(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const token = ++st.token;
    const { absEl, ftEl } = st.refs;
    const zh = I18n.isZh;

    if (!st.item) {
      absEl.textContent = "—";
      ftEl.textContent = "—";
      return;
    }
    let abs = "";
    try { abs = st.item.getField("abstractNote") || ""; } catch (e) { /* ignore */ }
    absEl.textContent = abs.trim() || (zh ? "（无摘要字段）" : "(no abstract)");
    ftEl.textContent = zh ? "正在读取全文索引…" : "Reading full text index…";

    let ft = null;
    try {
      ft = await AIChat.getFullText(st.item);
    } catch (e) { /* 下面统一兜底 */ }
    if (token !== st.token) return; // 已切走
    ftEl.textContent = ft
      ? ft.slice(0, 1200) + (ft.length > 1200 ? " …" : "")
      : (zh ? "（无可读 PDF 全文，扫描件请先 OCR）" : "(no readable PDF text)");
  },

  unregister() {
    if (this._registered) {
      try {
        Zotero.ItemPaneManager.unregisterSection(this._registeredPaneID || this.PANE_ID);
      } catch (e) { /* 已注销则忽略 */ }
      this._registeredPaneID = null;
      this._registered = false;
    }
    this._panes.clear();
  },
};
