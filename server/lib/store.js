// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · JSON 原子存储
 * users.json / channels.json：读时容错（损坏→备份现场），写时 tmp+fsync+rename。
 * 单进程串行写（管理操作低频），无需锁。
 *
 * ★ 1.8.5（审查 P0-4）：损坏不再「静默回退默认值并继续写」。
 *   历史行为是 _load 失败返回空文档，随后启动路径无条件 save()，把空文档覆盖到正式
 *   文件上——一次截断/坏盘就变成「订单、激活码、价格表全清空，服务照常跑」。
 *   现在：损坏只标记 loadFailed（并保留 .corrupt-* 副本），由调用方进入维护模式；
 *   save() 在 loadFailed 时直接抛错，作为最后一道闸门（reload() 成功后才解除）。
 *   另外写盘补 fsync：rename 只保证目录项原子，不保证数据块已落盘。
 */
'use strict';

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.loadFailed = false;   // 磁盘文件存在但解析失败（与「首次运行」严格区分）
    this.loadError = '';       // 供 health / 日志展示
    this.corruptPath = '';     // 损坏副本路径（人工恢复用）
    this.data = this._load();
  }

  _load() {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {           // 首次运行：用默认值，允许随后落盘
        this.loadFailed = false;
        this.loadError = '';
        this.corruptPath = '';
        return clone(this.fallback);
      }
      this.loadFailed = true;                   // 权限/IO 错误：同样不覆盖
      this.loadError = (e && e.message) || String(e);
      console.error('[store] %s 读取失败，进入维护模式: %s', path.basename(this.file), this.loadError);
      return clone(this.fallback);
    }

    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('根节点不是对象');
      }
      this.loadFailed = false;
      this.loadError = '';
      this.corruptPath = '';
      return doc;
    } catch (e) {
      // 损坏：备份现场，但**绝不**用默认值覆盖（由调用方决定怎么恢复）
      this.loadFailed = true;
      this.loadError = (e && e.message) || String(e);
      try {
        const bak = this.file + '.corrupt-' + Date.now();
        fs.copyFileSync(this.file, bak);
        this.corruptPath = bak;
      } catch (_) { /* ignore */ }
      console.error('[store] %s 损坏，已保留副本 %s，进入维护模式（不会覆盖原文件）: %s',
        path.basename(this.file), path.basename(this.corruptPath || '-'), this.loadError);
      return clone(this.fallback);
    }
  }

  /** 原子写：tmp + fsync + rename。loadFailed 时拒绝写入（防止空库覆盖） */
  save() {
    if (this.loadFailed) {
      throw new Error('拒绝写入 ' + path.basename(this.file)
        + '：该文件加载失败（' + (this.loadError || '未知') + '），请先从备份恢复');
    }
    const tmp = this.file + '.tmp';
    const text = JSON.stringify(this.data, null, 2);
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, text, 'utf8');
      try { fs.fsyncSync(fd); } catch (_) { /* 某些文件系统不支持，退化为普通写 */ }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    fs.renameSync(tmp, this.file);
  }

  /**
   * 从磁盘重新加载（1.4.2：备份回滚后必须调用，否则内存里还是回滚前的旧数据）。
   * 注意 _load() 对损坏文件会回退默认值并把 loadFailed 置真——回滚后应立刻校验关键
   * 字段，发现被回退成默认值要当作回滚失败上报，而不是继续用空数据服务。
   */
  reload() {
    this.data = this._load();
    return this.data;
  }
}

module.exports = { JsonStore };
