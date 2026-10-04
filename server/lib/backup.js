/* PaperPilot 账号后台 · 数据快照与回滚（1.4.2）
 *
 * 为什么需要：客户端会话仓库有「2 落点 × 3 代」的冗余，服务端反而是一份孤本——
 * users.json / membership.json / channels.json 被误改、写坏、误删就没有退路。
 * 价格表、订单、激活码、会员状态全在这几个文件里，丢一次就是运营事故。
 *
 * 设计
 *   · 快照 = data/backup/<YYYYMMDD-HHmmss>-<reason>/ 目录，内含当时的
 *     users.json / membership.json / channels.json + meta.json（时间、原因、每个文件的 sha256）
 *   · 触发：关键写操作**之前**自动打一份（"改动前现场"），以及服务启动时的每日快照
 *   · 节流：同一 reason 在 PP_BACKUP_THROTTLE_MS（默认 5 分钟）内只留第一份
 *     —— 保住「这一串改动开始前的状态」，又不会被高频写操作刷爆磁盘
 *   · 保留策略（prune）：最近 PP_BACKUP_KEEP（默认 30）份 + 最近 14 天每天各留 1 份锚点，
 *     其余删除；两份规则取并集，因此短期密集改动与长期回溯都能覆盖
 *   · 恢复：把快照文件复制回去；**恢复前先给现场打一份 pre-restore 快照**（可反悔）
 *
 * 快照目录在 data/ 内，而 data/ 已被 .gitignore 排除，不会进仓库。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILES = ['users.json', 'membership.json', 'channels.json', 'pricing.json'];
const DEFAULT_THROTTLE_MS = 5 * 60e3;
const DEFAULT_KEEP_RECENT = 30;
const DEFAULT_DAILY_DAYS = 14;

function backupRoot(dataDir) { return path.join(dataDir, 'backup'); }

function threatDefault(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function cfg() {
  return {
    throttleMs: threatDefault(process.env.PP_BACKUP_THROTTLE_MS, DEFAULT_THROTTLE_MS),
    keepRecent: threatDefault(process.env.PP_BACKUP_KEEP, DEFAULT_KEEP_RECENT),
    dailyDays: threatDefault(process.env.PP_BACKUP_DAILY_DAYS, DEFAULT_DAILY_DAYS),
  };
}

function slug(s) {
  return String(s || 'manual').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'manual';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function dirSize(dir) {
  let total = 0;
  for (const n of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, n)).size; } catch (e) { /* ignore */ }
  }
  return total;
}

/** 列快照（按时间倒序）；损坏/不完整的目录会被标出来而不是直接隐藏 */
function list(dataDir) {
  const root = backupRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st = null;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (e) { /* 缺 meta 也列出来 */ }
    out.push({
      id: name,
      at: (meta && meta.at) || st.mtime.toISOString(),
      atMs: Date.parse((meta && meta.at) || st.mtime.toISOString()) || 0,
      reason: (meta && meta.reason) || 'unknown',
      note: (meta && meta.note) || '',
      files: (meta && meta.files) || [],
      size: dirSize(dir),
      valid: !!(meta && Array.isArray(meta.files) && meta.files.length),
    });
  }
  out.sort((a, b) => b.atMs - a.atMs);
  return out;
}

function find(dataDir, id) {
  return list(dataDir).find((s) => s.id === id) || null;
}

/**
 * 打一份快照。force=false 时按 reason 节流（窗口内只留第一份）。
 * 返回 { ok, skipped?, snapshot? }。
 */
function snapshot(dataDir, reason, { note, force } = {}) {
  const root = backupRoot(dataDir);
  const c = cfg();
  const rs = slug(reason);
  const items = list(dataDir);
  if (!force) {
    const last = items.find((s) => s.reason === rs);
    if (last && (Date.now() - last.atMs) < c.throttleMs) {
      return { ok: true, skipped: true, reason: rs, lastId: last.id,
        lastAt: last.at };
    }
  }
  const at = new Date();
  let id = stamp(at) + '-' + rs;
  let dir = path.join(root, id);
  let n = 1;
  while (fs.existsSync(dir)) { id = stamp(at) + '-' + rs + '-' + (++n); dir = path.join(root, id); }
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of FILES) {
    const src = path.join(dataDir, name);
    if (!fs.existsSync(src)) continue;
    const buf = fs.readFileSync(src);
    fs.writeFileSync(path.join(dir, name), buf);
    files.push({ name, size: buf.length, sha256: sha256(buf) });
  }
  const meta = { id, at: at.toISOString(), reason: rs, note: String(note || '').slice(0, 120), files };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, snapshot: Object.assign({}, meta, { size: dirSize(dir), valid: true }) };
}

/**
 * 保留策略：最近 keepRecent 份 ∪ 最近 dailyDays 天每天最新 1 份，其余删除。
 * 返回 { kept, removed: [id] }。
 */
function prune(dataDir, opts) {
  const c = cfg();
  const keepRecent = threatDefault(opts && opts.keepRecent, c.keepRecent);
  const dailyDays = threatDefault(opts && opts.dailyDays, c.dailyDays);
  const items = list(dataDir);
  const keep = new Set();
  items.slice(0, keepRecent).forEach((s) => keep.add(s.id));
  const cutoff = Date.now() - dailyDays * 86400e3;
  const seenDay = new Set();
  for (const s of items) {
    if (s.atMs < cutoff) continue;
    const day = s.at.slice(0, 10);
    if (seenDay.has(day)) continue;
    seenDay.add(day);
    keep.add(s.id);
  }
  const removed = [];
  for (const s of items) {
    if (keep.has(s.id)) continue;
    try {
      fs.rmSync(path.join(backupRoot(dataDir), s.id), { recursive: true, force: true });
      removed.push(s.id);
    } catch (e) { /* 删不掉就留着，下轮再试 */ }
  }
  return { kept: keep.size, removed };
}

/**
 * 回滚到指定快照。
 *  1. 先给当前现场打一份 `pre-restore` 快照（fail-safe：恢复错了还能再回滚回来）
 *  2. 用快照内存在的文件覆盖 data/ 下同名文件（快照里没有的文件不动）
 *  3. 返回每个文件的 sha256 校验结果 —— 复制后内容不一致必须能被发现
 * 调用方负责把内存里的 store 重新加载（JsonStore.reload()）。
 */
function restore(dataDir, id, { note } = {}) {
  const snap = find(dataDir, id);
  if (!snap) return { error: '快照不存在：' + id };
  const dir = path.join(backupRoot(dataDir), id);
  if (!fs.existsSync(dir)) return { error: '快照目录已丢失：' + id };
  const safety = snapshot(dataDir, 'pre-restore', { note: '回滚到 ' + id + ' 之前的现场', force: true });
  const restored = [];
  const mismatched = [];
  for (const f of snap.files) {
    const src = path.join(dir, f.name);
    if (!fs.existsSync(src)) continue;
    const buf = fs.readFileSync(src);
    fs.writeFileSync(path.join(dataDir, f.name), buf);   // 覆盖写（可能写坏旧文件，但旧文件已在 safety 里）
    const back = fs.readFileSync(path.join(dataDir, f.name));
    const okHash = f.sha256 ? sha256(back) === f.sha256 : true;
    restored.push({ name: f.name, size: back.length, ok: okHash });
    if (!okHash) mismatched.push(f.name);
  }
  return {
    restored, mismatched,
    safety: safety.snapshot ? safety.snapshot.id : null,
    from: { id: snap.id, at: snap.at, reason: snap.reason },
  };
}

/** 给 /api/admin/backups 用的策略说明（后台直接展示，避免"为什么只有 30 份"的疑问） */
function policy() {
  const c = cfg();
  return {
    throttleMs: c.throttleMs,
    keepRecent: c.keepRecent,
    dailyDays: c.dailyDays,
    files: FILES,
    root: 'server/data/backup/',
    text: '关键改动前自动快照（同类操作 ' + Math.round(c.throttleMs / 60000) + ' 分钟内只留第一份）；'
      + '保留最近 ' + c.keepRecent + ' 份 + 最近 ' + c.dailyDays + ' 天每天各 1 份锚点。',
  };
}

/** 最近一次快照（health 用） */
function latest(dataDir) {
  const items = list(dataDir);
  return items.length ? { id: items[0].id, at: items[0].at, reason: items[0].reason } : null;
}

module.exports = {
  FILES, DEFAULT_THROTTLE_MS,
  backupRoot, list, find, snapshot, prune, restore, policy, latest, slug,
};
