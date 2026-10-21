// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  assert.equal(buf.slice(1, 4).toString("ascii"), "PNG", file + " 不是 PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function localRefs(html, baseDir) {
  const refs = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(v)) continue;
    refs.push(path.normalize(path.join(baseDir, v)));
  }
  return refs;
}

export default function register(test) {
  const manifest = JSON.parse(read("manifest.json"));

  test("manifest 基本字段与 MV3", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.description.length <= 132);
  });

  test("权限最小化：不申请全站访问与 cookies", () => {
    const all = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
    assert.equal(all.includes("<all_urls>"), false);
    assert.equal(all.includes("cookies"), false);
    assert.equal(all.includes("tabs"), false);
    for (const p of all) assert.ok(["sidePanel", "storage", "scripting", "activeTab"].includes(p), "多申请了 " + p);
    for (const h of manifest.host_permissions) {
      assert.equal(h.includes("<all_urls>"), false);
      assert.match(h, /^https:\/\//);
    }
  });

  test("host_permissions 包含 Papilot 网关，且不含 Sci-Hub", () => {
    const joined = manifest.host_permissions.join("\n").toLowerCase();
    assert.match(joined, /pp\.xinglintools\.top/);
    assert.equal(/sci-hub|scihub|libgen/.test(joined), false);
  });

  test("manifest 引用的文件都存在", () => {
    assert.ok(exists(manifest.background.service_worker));
    assert.ok(exists(manifest.side_panel.default_path));
    assert.ok(exists(manifest.options_ui.page));
    for (const key of Object.keys(manifest.icons)) assert.ok(exists(manifest.icons[key]));
    for (const key of Object.keys(manifest.action.default_icon)) assert.ok(exists(manifest.action.default_icon[key]));
    for (const cs of manifest.content_scripts) for (const f of cs.js) assert.ok(exists(f), f);
  });

  test("图标尺寸正确", () => {
    for (const size of [16, 32, 48, 128]) {
      const { w, h } = pngSize("icons/icon" + size + ".png");
      assert.equal(w, size);
      assert.equal(h, size);
    }
  });

  test("内容脚本只匹配 https 学术站点", () => {
    for (const cs of manifest.content_scripts) {
      assert.ok(cs.matches.length >= 10);
      for (const m of cs.matches) {
        assert.match(m, /^https:\/\//);
        assert.notEqual(m, "<all_urls>");
      }
    }
  });

  test("HTML 无内联脚本与内联事件（MV3 CSP）", () => {
    for (const file of ["src/sidepanel/panel.html", "src/options/options.html"]) {
      const html = read(file);
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, file + " 含内联脚本");
      assert.equal(/\son(click|change|input|submit|load)=/i.test(html), false, file + " 含内联事件");
    }
  });

  test("HTML 引用的本地文件都存在", () => {
    const pairs = [
      ["src/sidepanel/panel.html", "src/sidepanel"],
      ["src/options/options.html", "src/options"],
    ];
    for (const [file, base] of pairs) {
      for (const ref of localRefs(read(file), base)) {
        assert.ok(exists(ref), file + " 引用了不存在的 " + ref);
      }
    }
  });

  test("业务代码不含 eval / 远程脚本", () => {
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = path.join(dir, name);
        if (rel.includes("vendor")) continue;
        const stat = fs.statSync(path.join(ROOT, rel));
        if (stat.isDirectory()) walk(rel);
        else if (name.endsWith(".js") || name.endsWith(".html")) files.push(rel);
      }
    };
    walk("src");
    for (const f of files) {
      const code = read(f);
      assert.equal(/\beval\s*\(/.test(code), false, f + " 使用了 eval");
      assert.equal(/new\s+Function\s*\(/.test(code), false, f + " 使用了 new Function");
      assert.equal(/<script[^>]+src="https?:/i.test(code), false, f + " 加载了远程脚本");
    }
  });
}
