// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot bootstrap — Zotero 7/10 插件入口
 * 参考官方 Make It Red / zotero-plugin-template / zoterostyle 的结构
 */
/* global Zotero, Services, Components, IOUtils, PathUtils */

var chromeHandle;

// ---- 启动诊断：写 数据目录 + profile 目录 两处 papilot-boot.log，并镜像到 Zotero.debug ----
var _ppBootLines = [];

function _ppLogPaths() {
  var paths = [];
  // 必须 PathUtils.join：手工拼 "C:\dir/file" 混合分隔符会被
  // NS_ERROR_FILE_UNRECOGNIZED_PATH 拒绝（FF140 实证），导致静默写失败
  try {
    var d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
    if (d) paths.push(PathUtils.join(d, "papilot-boot.log"));
  } catch (e) { /* 数据目录未初始化时忽略 */ }
  try {
    var prof = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
    var p = PathUtils.join(prof.path, "papilot-boot.log");
    if (paths.indexOf(p) < 0) paths.push(p);
  } catch (e) { /* ignore */ }
  return paths;
}

async function _ppDiag(msg) {
  try {
    _ppBootLines.push(new Date().toISOString() + " " + msg);
    try { Zotero.debug("[papilot-boot] " + msg); } catch (e) { /* ignore */ }
    var text = _ppBootLines.join("\n") + "\n";
    var paths = _ppLogPaths();
    for (var i = 0; i < paths.length; i++) {
      try { await IOUtils.writeUTF8(paths[i], text); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

// 顶层留痕：证明 bootstrap.js 已被 Zotero 的 _loadScope 求值（不等 startup 被调用）
_ppDiag("bootstrap.js evaluated");

// initializationPromise 竞速兜底：任何情况下 startup 都不会挂死
function _ppInitWait() {
  try {
    return Promise.race([
      Zotero.initializationPromise,
      new Promise(function (resolve) { setTimeout(resolve, 10000); }),
    ]);
  } catch (e) {
    return Promise.resolve();
  }
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  try {
    await _ppDiag("startup begin v" + version + " reason=" + reason);
    // 等 Zotero 本体初始化完成（Z10 中调用插件 startup 前已 resolve，竞速仅作兜底）
    await _ppInitWait();
    await _ppDiag("initializationPromise resolved (or timed out)");

    // Z10 实证：startup params 只有 {id, version, rootURI}，没有 resourceURI；
    // 兜底必须判空，否则 resourceURI.spec 抛 TypeError 直接搞死 startup
    if (!rootURI) rootURI = resourceURI ? resourceURI.spec : "";

    // 注册 chrome://papilot/ 内容协议（locale 由 Zotero 的 ftl 自动扫描负责，不在此注册）
    var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "papilot", "chrome/content/"],
    ]);
    await _ppDiag("chrome registered rootURI=" + rootURI);

    // 加载主逻辑脚本（脚本内部把对象挂到 Zotero.Papilot）
    // ⚠️ 必须带 ?v= 缓存破坏：热升级（同 id 换版本）时 jar URL 不变，
    // scriptloader 的内存/启动缓存会返回旧编译产物——实证 0.5.1→0.6.0 热装后
    // 执行的是旧 main.js（诊断日志一切"正常"但新模块从未加载）。
    Services.scriptloader.loadSubScript(
      rootURI + "chrome/content/scripts/main.js?v=" + version
    );
    await _ppDiag("main.js loaded");

    await Zotero.Papilot.init({ id, version, rootURI });
    await _ppDiag("init complete");
  } catch (e) {
    await _ppDiag("STARTUP FAILED: " + (e && (e.stack || e.message) || e));
    throw e;
  }
}

function shutdown(data, reason) {
  _ppDiag("shutdown reason=" + reason);
  // Zotero 退出（APP_SHUTDOWN）时 UI 已销毁，跳过清理
  if (reason === APP_SHUTDOWN) return;
  try {
    if (typeof Zotero !== "undefined" && Zotero.Papilot) {
      Zotero.Papilot.destroy();
      delete Zotero.Papilot;
    }
  } catch (e) {
    try { Zotero.logError(e); } catch (_) { /* ignore */ }
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function install(data, reason) {
  _ppDiag("install reason=" + reason);
}

function uninstall(data, reason) {
  // 0.15.1 起：不再删除账号会话文件（数据目录 + ProfD 的 papilot-account*.json）。
  // 此前版本在卸载钩子里删文件，而更新/重装路径可能触发 uninstall（平台实现差异，
  // 手工重装 xpi 测试亦必经）——用户登录态被直接物理清除，表现为「每次更新都要重新登录」。
  // 0.23.0 起会话为「2 落点 × 3 代」共最多 6 份副本，任何一份被删都还能从其余副本恢复。
  // 留置风险可忽略：令牌服务端仅存散列（sha256）、30 天滑动过期、改密即吊销、
  // 登出/401 走墓碑覆盖（令牌物理清除）；令牌真正失效时插件会在下次校验自动清理。
  _ppDiag("uninstall reason=" + reason + " (account session files kept by design; "
    + "2 locations x 3 generations)");
}
