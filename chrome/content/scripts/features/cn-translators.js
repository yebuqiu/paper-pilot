// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 中文转换器管理（0.14.5，茉莉花同等能力）
 * 从 Zotero 中文社区 translators_CN（https://github.com/l0o0/translators_CN）
 * 拉取最新中文转换器（知网/万方/维普等 99 个），写入 Zotero 数据目录 translators/，
 * 修复「浏览器 Connector 抓取知网失败/无法下载中文 PDF」最常见的根因——转换器过期。
 *
 * 机制（与茉莉花 jasminum translators.ts 对齐）：
 *   1. 多源测速：国内镜像 ×3 + jsdelivr + GitHub raw，HEAD data/translators.json 选最快
 *   2. 索引对比：本地 translators/*.js 头部 lastUpdated < 索引 lastUpdated → 下载覆盖
 *   3. 内置转换器体检：Endnote XML 缺失说明 Zotero 转换器库损坏 → Schema.resetTranslators()
 *   4. 全部写完后 Zotero.Translators.reinit() 热重载，无需重启
 *   5. 索引缓存在数据目录 translators_CN.json（与茉莉花同路径，互相兼容共用）
 * 触发：菜单/功能中心手动（force）+ 启动后每 12h 静默一次（可关）
 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n, _ppDiag */

var CNTranslators = {
  // 源列表：前三为国内镜像（茉莉花同款），后二为上游兜底
  BASE_URLS: [
    "https://oss.wwang.de/translators_CN",
    "https://www.wieke.cn/translators_CN",
    "https://ftp.zotero-chinese.com/translators_CN",
    "https://cdn.jsdelivr.net/gh/l0o0/translators_CN@master",
    "https://raw.githubusercontent.com/l0o0/translators_CN/master",
  ],
  // 默认强制使用某个源（调试/镜像全挂时兜底），null=自动测速
  FORCED_BASE: null,

  _updating: false,
  _base: null,

  _diag(msg) {
    try { _ppDiag("cn-translators: " + msg); } catch (e) { /* ignore */ }
  },

  _tDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, "translators");
  },

  /** 各源 HEAD 测速，返回最快可用的 base（全挂返回 null） */
  async _bestBase() {
    if (this.FORCED_BASE) return this.FORCED_BASE;
    const test = async (base) => {
      const t0 = Date.now();
      try {
        await Zotero.HTTP.request("HEAD", base + "/data/translators.json", { timeout: 5000 });
        return { base, ms: Date.now() - t0 };
      } catch (e) {
        return { base, ms: Infinity };
      }
    };
    const rs = await Promise.all(this.BASE_URLS.map(test));
    rs.sort((a, b) => a.ms - b.ms);
    if (rs[0].ms === Infinity) return null;
    this._diag("best base " + rs[0].base + " (" + rs[0].ms + "ms)");
    return rs[0].base;
  },

  /** 拉取转换器索引 {basename: {label, lastUpdated}}，成功则写缓存 */
  async _fetchIndex(base) {
    const cachePath = PathUtils.join(Zotero.DataDirectory.dir, "translators_CN.json");
    try {
      const resp = await Zotero.HTTP.request("GET", base + "/data/translators.json", {
        timeout: 15000,
        headers: { "Cache-Control": "no-cache" },
      });
      const data = JSON.parse(resp.responseText);
      try { await IOUtils.writeUTF8(cachePath, resp.responseText); } catch (e) { /* 缓存失败不影响流程 */ }
      return data;
    } catch (e) {
      // 远端挂了 → 读本地缓存兜底（茉莉花同款缓存文件，可能已由茉莉花写过）
      this._diag("index fetch failed: " + (e && e.message) + ", try cache");
      try {
        if (await IOUtils.exists(cachePath)) {
          const txt = await IOUtils.readUTF8(cachePath);
          return JSON.parse(txt);
        }
      } catch (e2) { /* ignore */ }
      return null;
    }
  },

  /** 读本地 translators/{filename} 头部 JSON 的 lastUpdated；不存在/解析失败返回 null */
  async _localLastUpdated(filename) {
    try {
      const p = PathUtils.join(this._tDir(), filename);
      if (!(await IOUtils.exists(p))) return null;
      const src = await IOUtils.readUTF8(p);
      const m = /^\s*{[\S\s]*?}\s*?[\r\n]/.exec(src);
      if (!m) return null;
      const meta = JSON.parse(m[0]);
      return meta.lastUpdated || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * 内置转换器体检：Endnote XML 是 Zotero 官方转换器库的锚点，
   * 缺失说明官方转换器被清库（多见于误删/同步损坏），重置恢复。
   */
  async _mendIfBroken() {
    try {
      const anchor = await Zotero.Translators.get("eb7059a4-35ec-4961-a915-3cf58eb9784b");
      if (anchor) return;
      this._diag("official translators broken, resetting");
      await Zotero.Schema.resetTranslators();
    } catch (e) {
      this._diag("mend failed: " + (e && e.message));
    }
  },

  /**
   * 更新入口。force=false 时遵循 12h 间隔静默策略（启动自动调用用）；
   * force=true 为手动触发，总是执行并弹进度窗。
   * 返回 {success, skip, fail} 或 null（跳过/已在更新/索引不可用）。
   */
  async update(force) {
    if (this._updating) return null;
    const now = Date.now();
    if (!force) {
      const last = parseInt(Prefs.get("cnTranslatorUpdateTime", "0"), 10) || 0;
      if (now - last < 12 * 3600 * 1000) return null;
    }
    this._updating = true;
    const zh = I18n.isZh;
    let pw = null;
    try {
      await Zotero.Schema.schemaUpdatePromise;
      await this._mendIfBroken();

      const base = await this._bestBase();
      if (!base) throw new Error(zh ? "所有转换器源均不可达（网络问题）" : "All translator sources unreachable");
      this._base = base;

      const index = await this._fetchIndex(base);
      if (!index || !Object.keys(index).length) {
        throw new Error(zh ? "转换器索引获取失败" : "Failed to fetch translator index");
      }

      if (force) {
        pw = new Zotero.ProgressWindow({ closeOnClick: true });
        pw.changeHeadline("Papilot · " + (zh ? "更新中文转换器" : "Update CN translators"));
        pw.show();
      }
      const line = pw
        ? new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
            zh ? "检查 99 个中文转换器…" : "Checking CN translators…")
        : null;

      let success = 0, skip = 0, fail = 0;
      const names = Object.keys(index);
      for (const name of names) {
        const remote = index[name] && index[name].lastUpdated;
        if (!remote) { skip++; continue; }
        const local = await this._localLastUpdated(name);
        // 本地没有或远端更新 → 下载；时间相等/本地更新 → 跳过
        if (local && new Date(remote) <= new Date(local)) { skip++; continue; }
        try {
          const url = base + "/" + encodeURI(name);
          const resp = await Zotero.HTTP.request("GET", url, { timeout: 20000 });
          const code = resp.responseText;
          if (!code || code.length < 200 || !/"translatorID"/.test(code)) {
            throw new Error("invalid content");
          }
          await IOUtils.writeUTF8(PathUtils.join(this._tDir(), name), code);
          success++;
        } catch (e) {
          fail++;
          this._diag("download failed " + name + ": " + (e && e.message));
        }
        if (line) line.setProgress(Math.round(((success + skip + fail) / names.length) * 100));
      }

      // 热重载（fromSchemaUpdate:false 是 Zotero 7 reinit 的正确签名）
      try {
        await Zotero.Translators.reinit({ fromSchemaUpdate: false });
      } catch (e) {
        // 老版本 Zotero 无参签名
        try { await Zotero.Translators.reinit(); } catch (e2) { /* ignore */ }
      }
      Prefs.set("cnTranslatorUpdateTime", String(now));
      this._diag("update done success=" + success + " skip=" + skip + " fail=" + fail);

      if (pw) {
        if (line) {
          line.setText((zh ? "完成：更新 " : "Done: ") + success +
            (zh ? "，跳过 " : ", skipped ") + skip +
            (fail ? (zh ? "，失败 " : ", failed ") + fail : ""));
          line.setProgress(100);
        }
        pw.startCloseTimer(4000);
      } else if (success || fail) {
        // 静默模式但有实际变更/失败 → 简短提示一下
        const note = new Zotero.ProgressWindow({ closeOnClick: true });
        note.changeHeadline("Papilot · " + (zh ? "中文转换器已更新" : "CN translators updated"));
        note.show();
        const l2 = new note.ItemProgress("chrome://papilot/content/icons/chat.svg",
          (zh ? "更新 " : "Updated ") + success + (zh ? " 个" : "") +
          (fail ? (zh ? "，失败 " : ", failed ") + fail : ""));
        l2.setProgress(100);
        note.startCloseTimer(3000);
      }
      return { success, skip, fail };
    } catch (e) {
      this._diag("update FAILED: " + (e && (e.stack || e.message)));
      if (pw) {
        const errLine = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
          (zh ? "更新失败：" : "Update failed: ") + (e && e.message || e));
        errLine.setError();
        pw.startCloseTimer(6000);
      }
      return null;
    } finally {
      this._updating = false;
    }
  },

  /** 启动后静默自动更新（pref cnTranslatorsAuto 控制，默认开） */
  scheduleAuto() {
    if (!Prefs.get("cnTranslatorsAuto", true)) return;
    // 延迟 20s：不与启动期其他网络任务（账号恢复等）抢带宽
    setTimeout(() => {
      this.update(false).catch((e) => this._diag("auto update error: " + (e && e.message)));
    }, 20000);
  },
};
