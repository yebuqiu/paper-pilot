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
    assert.ok(manifest.action.default_popup);
  });

  test("权限最小化：只需要 activeTab / scripting / storage", () => {
    assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
    for (const p of ["tabs", "cookies", "history", "<all_urls>"]) {
      assert.equal(manifest.permissions.includes(p), false, "多申请了 " + p);
    }
  });

  test("外部主机只放行 Crossref", () => {
    assert.deepEqual(manifest.host_permissions, ["https://api.crossref.org/*"]);
    assert.equal(JSON.stringify(manifest).includes("sci-hub"), false);
  });

  test("清单引用的文件都存在", () => {
    assert.ok(exists(manifest.background.service_worker));
    assert.ok(exists(manifest.action.default_popup));
    assert.ok(exists(manifest.options_ui.page));
    for (const key of Object.keys(manifest.icons)) assert.ok(exists(manifest.icons[key]));
  });

  test("图标尺寸正确", () => {
    for (const size of [16, 32, 48, 128]) {
      const { w, h } = pngSize("icons/icon" + size + ".png");
      assert.equal(w, size);
      assert.equal(h, size);
    }
  });

  test("HTML 无内联脚本与内联事件", () => {
    for (const file of ["src/popup/popup.html", "src/options/options.html"]) {
      const html = read(file);
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, file + " 含内联脚本");
      assert.equal(/\son(click|change|input|submit|load)=/i.test(html), false, file + " 含内联事件");
    }
  });

  test("HTML 引用的本地文件都存在", () => {
    const pairs = [
      ["src/popup/popup.html", "src/popup"],
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
