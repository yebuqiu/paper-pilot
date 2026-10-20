// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* PaperPilot → Papilot 迁移提示包（0.55.9）
 *
 * 为什么存在：0.56.0 起插件更名，扩展 ID 从 paperpilot@dev.local 改为
 * papilot@dev.local。Zotero 按扩展 ID 匹配更新，因此所有还装着旧 ID 的机器
 * 点「检查更新」永远只会看到旧清单里的最高版本（0.54.0），升不到 Papilot。
 *
 * 本包故意沿用**旧 ID**、版本号 0.55.9（> 0.54.0，且不与 0.56.0 冲突），
 * 于是能被旧 ID 的更新通道正常拉取并安装；装完只做一件事：告诉用户
 * 「先卸载 PaperPilot，再装 Papilot」并提供一键打开发行版页面。
 *
 * ★ 不自动下载/安装新插件：Zotero 不支持静默安装第二个插件，
 *   任何「自动装」的实现都只能是伪造用户确认，不做。
 * ★ 不卸载自己：卸载插件会让 Zotero 立刻回收本作用域，弹窗都来不及。
 */
/* global Zotero, Services, Components, IOUtils, PathUtils */

var MIGRATION_VERSION = "0.55.9";
var PREF_BRANCH = "extensions.zotero.paperpilot-migration.";
var DOWNLOAD_URL = "https://gitee.com/cassiuschen9261/zotero-papilot/releases";
var LOG_NAME = "paperpilot-migration.log";

/** 日志落点：数据目录 + profile 各一份（首次启动向导完成前 DataDirectory 可能为空） */
function _logPaths() {
  var paths = [];
  try {
    var d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
    if (d) paths.push(PathUtils.join(d, LOG_NAME));
  } catch (e) { /* ignore */ }
  try {
    var prof = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
    var p = PathUtils.join(prof.path, LOG_NAME);
    if (paths.indexOf(p) < 0) paths.push(p);
  } catch (e) { /* ignore */ }
  return paths;
}

/** 诊断落盘（只保留最近一次；本包用途单一，不需要历史） */
function _log(msg) {
  var line = new Date().toISOString() + " " + msg;
  try { Zotero.debug("[paperpilot-migration] " + msg); } catch (e) { /* ignore */ }
  var paths = _logPaths();
  for (var i = 0; i < paths.length; i++) {
    try { IOUtils.writeUTF8(paths[i], line + "\n").catch(function () {}); }
    catch (e) { /* 日志失败不影响提示 */ }
  }
}

function _getPref(key, dft) {
  try { return Services.prefs.getStringPref(PREF_BRANCH + key, dft); }
  catch (e) { return dft; }
}

function _setPref(key, value) {
  try { Services.prefs.setStringPref(PREF_BRANCH + key, String(value)); }
  catch (e) { /* ignore */ }
}

/** 弹提示；用户点主按钮返回 true */
function _prompt(win) {
  var text = "PaperPilot 已更名为 Papilot。\n\n"
    + "· 从 0.56.0 起插件换了新的扩展 ID，Zotero 无法把它当成本插件的“更新”，"
    + "所以本插件今后不会再收到新版本——这就是你一直看不到更新的原因。\n\n"
    + "· 请先在「工具 → 插件」里卸载 PaperPilot，再安装 Papilot 安装包。\n\n"
    + "· 文库、笔记、插件设置都不会丢；Papilot 首次启动会自动迁移旧设置。\n\n"
    + "点「打开发行版页面」可直接下载最新版。";
  var flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
    + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
  var r = Services.prompt.confirmEx(win, "Papilot 迁移提示", text, flags,
    "打开发行版页面", "稍后", null, null, {});
  return r === 0;
}

async function _waitMainWindow() {
  for (var i = 0; i < 40; i++) {
    try {
      var win = Zotero.getMainWindow();
      if (win && finalizeWindow(win)) return win;
    } catch (e) { /* ignore */ }
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
  }
  return null;
}

/** 主窗口是否已经能弹窗（避免在启动向导/空白窗口上弹） */
function finalizeWindow(win) {
  try { return !!(win && win.document && win.document.documentElement); }
  catch (e) { return false; }
}

async function startup({ id, version, rootURI }, reason) {
  _log("startup version=" + version + " reason=" + reason);
  try {
    // 同一个版本只打扰一次：Zotero 每次启动都会调 startup
    if (_getPref("shownFor", "") === MIGRATION_VERSION) {
      _log("notice already shown for " + MIGRATION_VERSION + ", skip");
      return;
    }
    // 等 Zotero 本体 + 主窗口就绪（竞速兜底，永不挂死）
    try {
      await Promise.race([
        Zotero.initializationPromise,
        new Promise(function (resolve) { setTimeout(resolve, 10000); }),
      ]);
    } catch (e) { /* ignore */ }

    var win = await _waitMainWindow();
    if (!win) { _log("no usable main window, defer to next start"); return; }

    _setPref("shownFor", MIGRATION_VERSION);
    // 稍等 UI 稳定再弹，避免和启动向导、更新检查对话框叠在一起
    setTimeout(function () {
      try {
        _log("showing notice dialog");
        var wantDownload = _prompt(win);
        _log(wantDownload ? "user chose download page" : "user dismissed");
        if (wantDownload) {
          try { Zotero.launchURL(DOWNLOAD_URL); }
          catch (e) { _log("launchURL failed: " + e); }
        }
      } catch (e) {
        _log("prompt failed: " + e);
        // 弹窗失败不该吞掉提示：至少把地址记进日志，用户可手动打开
        _log("download page: " + DOWNLOAD_URL);
      }
    }, 1500);
  } catch (e) {
    _log("startup failed: " + e);
  }
}

function shutdown(data, reason) {
  _log("shutdown reason=" + reason);
}

function install(data, reason) {
  _log("install reason=" + reason);
}

function uninstall(data, reason) {
  _log("uninstall reason=" + reason);
  try {
    Services.prefs.clearUserPref(PREF_BRANCH + "shownFor");
  } catch (e) { /* ignore */ }
}
