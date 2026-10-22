#!/usr/bin/env python
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

# -*- coding: utf-8 -*-
"""launcher.ps1 × account-server.js 接线一致性静态扫描（0.23.0）

目的：GUI 无法在无人环境里真实点击，所以用静态检查兜住三类「点了没反应」的静默失败：
  1. launcher 里调用的函数/按钮处理器是否真的定义了（含 Show-MembershipManager 是否挂到主界面）
  2. launcher 调用的每一个 /api/admin/* 接口，服务端路由里是否真的存在
  3. 会员管理对话框里用到的控件变量是否都在同一函数内先创建后使用

用法：python scripts/check-wiring.py     （在仓库根目录）
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(ROOT, "scripts", "launcher.ps1")
SRV = os.path.join(ROOT, "server", "account-server.js")
ADMIN_HTML = os.path.join(ROOT, "server", "public", "admin.html")

ps = io.open(PS1, encoding="utf-8").read()
srv = io.open(SRV, encoding="utf-8").read()
html = io.open(ADMIN_HTML, encoding="utf-8").read()

problems = []
passes = []


def ok(cond, label):
    (passes if cond else problems).append(label)
    return cond


# ---------- 1. 函数定义 vs 调用 ----------
# 注意：本文件里的自定义函数**大量是嵌套在对话框函数内部的**（带缩进），
# 所以必须匹配行首可带空白的 function，而不是 ^function。
defs = set(re.findall(r"(?m)^[ \t]*function\s+([A-Za-z][\w-]*)", ps))

# 系统 cmdlet 白名单：只列本文件真正用到的，避免把内置命令误判成「未定义函数」
CMDLETS = {
    "Get-ChildItem", "Get-CimInstance", "Get-Date", "Get-Item", "Get-ItemProperty",
    "Get-NetTCPConnection", "Get-Process", "Invoke-Item", "Invoke-RestMethod",
    "New-Item", "New-Object", "Set-Content", "Set-ItemProperty",
    "Start-Sleep", "Stop-Process", "Test-Path",
}

called = set(re.findall(
    r"\b(Show-[A-Za-z]\w*|Refresh-[A-Za-z]\w*|Get-[A-Za-z]\w*|Set-[A-Za-z]\w*|"
    r"New-[A-Za-z]\w*|Start-[A-Za-z]\w*|Stop-[A-Za-z]\w*|Update-[A-Za-z]\w*|"
    r"Format-[A-Za-z]\w*|Invoke-[A-Za-z]\w*|Require-[A-Za-z]\w*|Hide-[A-Za-z]\w*|"
    r"Exit-[A-Za-z]\w*|Test-[A-Za-z]\w*|Resolve-[A-Za-z]\w*)\b", ps))
missing = sorted(c for c in called if c not in defs and c not in CMDLETS)
ok(not missing, "1.1 launcher 调用的自定义函数均已定义 → 缺失: %s" % (missing or "无"))

for must in ["Show-MembershipManager", "Refresh-Membership", "New-MbBtn", "Show-PriceForm",
             "Get-MembershipText", "Get-OrderStatusText", "Get-CodeStatusText", "Format-Dt",
             "Get-PriceRangeText"]:
    ok(must in defs, "1.2 新函数已定义: %s" % must)

ok("价格与周期" in ps, "1.2b launcher 有「价格与周期」标签页")
ok("/api/admin/prices" in ps, "1.2c launcher 调用了价格表接口")

ok(bool(re.search(r"(New-Btn\s+\$grpUser|New-UiButton\s+\$gPlans)[^\n]*Show-MembershipManager", ps)),
   "1.3 主界面「账号管理 / 计费与会员」分组挂了会员管理入口")

# ---------- 2. launcher 调的接口 vs 服务端路由 ----------
calls = set()
for m in re.finditer(r"Invoke-AdminApi\s+'(\w+)'\s+([^)]*)", ps):
    method, rest = m.group(1), m.group(2)
    path = re.search(r"'([^']*?(?:/api/[^']*|/api/admin[^']*))'", rest)
    if not path:
        path = re.search(r"\('([^']+)'", rest)
    if not path:
        continue
    raw = path.group(1)
    # 把 '(\'/api/admin/users/\' + $u.id + \'/membership\')' 这类拼接归一成模式
    norm = re.sub(r"'\s*\+\s*[^+']+?\+\s*'", "*", raw)
    norm = re.sub(r"\$\w+", "*", norm)
    norm = re.sub(r"\*+", "*", norm)
    calls.add((method.upper(), norm))

ok(bool(calls), "2.1 扫描到 Invoke-AdminApi 调用 %d 处" % len(calls))

# 服务端路由：取出所有 url === '...' / regex 匹配
routes = set()
for m in re.finditer(r"url\s*===\s*'([^']+)'", srv):
    routes.add(m.group(1))
for m in re.finditer(r"url\.match\((/[^)]*/)", srv):
    pat = m.group(1).replace("\\", "")
    routes.add(pat)
for m in re.finditer(r"url\.startsWith\('([^']+)'\)", srv):
    routes.add(m.group(1) + "*")

for method, norm in sorted(calls):
    # 查询串不参与路由匹配（调用方可能把 '?limit=…' 拼进路径）
    norm = norm.split("?")[0]
    seg = norm.split("/api/")[-1]
    probe = "*" + seg
    hit = any(seg in r or (r.endswith("*") and seg.startswith(r[:-1])) or
              re.sub(r"\(\[\^/\]\+\)|\[a-zA-Z0-9-\]\+|[^\\]*", "*", r).replace("*", "") and
              re.sub(r"[^/]+", "*", r) == norm for r in routes)
    # 更宽松的兜底：把路由里的正则段也替换成 *
    loose = any(re.sub(r"\(\?:[^)]*\)|\[[^\]]*\][+*?]?|[^/]+", "*", r) == norm for r in routes)
    ok(hit or loose, "2.2 服务端存在该路由: %s %s" % (method, norm))

for must in ["/api/admin/membership", "/api/admin/codes", "/api/admin/orders",
             "/api/admin/users", "/api/admin/prices"]:
    ok(must in srv, "2.3 服务端含路由前缀 %s" % must)
ok("fulfill" in srv and "membership" in srv, "2.4 服务端含核销与会员开通逻辑")
ok("upsertPriceItem" in srv and "priceItemOut" in srv, "2.5 服务端接入价格表模块")
ok("priority" in srv and "effectiveFrom" in srv, "2.6 服务端支持优先级与生效时段")

# ---------- 3. admin.html 与 launcher 的口径一致 ----------
ok('id="tab-membership"' in html, "3.1 Web 管理页有「会员管理」标签")
ok("loadMembership" in html and "fulfillOrder" in html and "createCodes" in html,
   "3.2 Web 管理页含会员管理核心函数")
ok("grantMembership" in html, "3.3 Web 管理页含用户开通/续期")
ok("openPriceForm" in html and "savePrice" in html and "loadPrices" in html,
   "3.3b Web 管理页含价格表 CRUD")
ok('id="pr-table"' in html and 'id="price-mask"' in html and 'id="pf-cycle"' in html,
   "3.3c Web 管理页有价格表与编辑弹窗")
ok("Team" not in html, "3.4 Web 管理页已去掉 Team 档（只保留 Free/Pro）")
ok("'Team'" not in ps, "3.5 launcher 已去掉 Team 档")

# ---------- 4. 会员对话框控件变量先建后用 ----------
mblock = ps[ps.index("function Show-MembershipManager"):]
mblock = mblock[:mblock.index("\nfunction ", 10)] if "\nfunction " in mblock[10:] else mblock
used = set(re.findall(r"\$(lvO|lvC|lvP|lblTop|selCodePlan|txtCode\w*|txtFreeLimit|txtProLimit|txtProPrice|txtPay\w*|lblPrice)\b", mblock))
built = set()
for v in ["lvO", "lvC", "lvP", "lblTop", "selCodePlan", "txtCodeMonths", "txtCodeCount", "txtCodeNote",
          "txtFreeLimit", "txtProLimit", "txtProPrice", "txtPayChannel", "txtPayQr", "txtPayText",
          "txtPayNote", "lblPrice"]:
    if re.search(r"\$%s\s*=" % v, mblock):
        built.add(v)
unbuilt = sorted(used - built)
ok(not unbuilt, "4.1 会员对话框控件均已创建 → 未创建: %s" % (unbuilt or "无"))

# ---------- 5. Show-PriceForm 的控件先建后用 ----------
pblock = ps[ps.index("function Show-PriceForm"):]
pblock = pblock[:pblock.index("\nfunction ", 10)] if "\nfunction " in pblock[10:] else pblock
pused = set(re.findall(r"\$(selPlan|selCycle|txtMonths|txtPrice|txtLabel|txtPrio|txtNote|dtFrom|dtTo|chkEnabled|lblPer|lblMsg)\b", pblock))
pbuilt = set(v for v in pused if re.search(r"\$%s\s*=" % v, pblock))
ok(not (pused - pbuilt), "5.1 价格表单控件均已创建 → 未创建: %s" % (sorted(pused - pbuilt) or "无"))
ok("$script:mbCycles" in pblock and "$script:mbPricePlans" in pblock,
   "5.2 价格表单读取脚本级周期/等级数据（跨作用域用 $script:）")

# ---------- 6. 运维三件套接线（1.4.2）----------
LIBS = os.path.join(ROOT, "server", "lib")
lib_src = {}
for fname in ["backup.js", "alerts.js", "lockout.js"]:
    p = os.path.join(LIBS, fname)
    exists = os.path.exists(p)
    ok(exists, "6.1 存在 server/lib/%s" % fname)
    lib_src[fname] = io.open(p, encoding="utf-8").read() if exists else ""

for fname, fns in [("backup.js", ["snapshot", "restore", "prune", "list", "policy"]),
                   ("alerts.js", ["backlogOf", "shouldAlert", "record"]),
                   ("lockout.js", ["registerFailure", "durationFor"])]:
    for fn in fns:
        ok(re.search(r"function %s\b" % fn, lib_src[fname]) is not None,
           "6.2 %s 定义 %s()" % (fname, fn))

for must in ["/api/admin/backups", "/api/admin/alerts", "/unlock"]:
    ok(must in srv, "6.3 服务端含运维路由 %s" % must)
ok("backlogCount" in srv and "snapshots" in srv and "lastSnapshotAt" in srv,
   "6.4 health 暴露积压与快照观测字段")
ok("preflight" in io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read(),
   "6.5 存在 scripts/preflight.py")

# ---------- 6b. 管理操作审计（服务端 1.4.4）----------
AUDIT_LIB = os.path.join(ROOT, "server", "lib", "audit.js")
ok(os.path.exists(AUDIT_LIB), "6b.1 存在 server/lib/audit.js")
audit_src = io.open(AUDIT_LIB, encoding="utf-8").read() if os.path.exists(AUDIT_LIB) else ""
for fn in ["entry", "redact", "append", "list", "stats", "labelOf"]:
    ok(re.search(r"(function %s\b|const %s\s*=)" % (fn, fn), audit_src) is not None,
       "6b.2 audit.js 定义 %s()" % fn)
ok("SECRET_KEY" in audit_src and "***" in audit_src, "6b.3 audit.js 有密钥脱敏")
ok("/api/admin/audit" in srv, "6b.4 服务端有审计查询路由")
audit_calls = len(re.findall(r"auditLog\(req,", srv))
ok(audit_calls >= 20, "6b.5 管理写操作已接审计（%d 处）" % audit_calls)
for a in ["'user.delete'", "'order.fulfill'", "'price.update'", "'backup.restore'", "'membership.config'"]:
    ok(a in srv, "6b.6 覆盖动作 %s" % a)
ok("auditBytes" in srv, "6b.7 health 暴露审计日志体积")

# 三方 UI 都要能看审计：Web 管理页 + 启动器
ok('id="tab-audit"' in html and 'id="pane-audit"' in html, "6b.8 Web 管理页有审计标签页与面板")
ok("loadAudit" in html and "exportAuditCSV" in html, "6b.9 Web 管理页有加载与导出审计")
ok('id="audit-table"' in html and 'id="a-action"' in html and 'id="a-target"' in html,
   "6b.10 Web 管理页审计表格与筛选控件齐备")
for fn in ["Refresh-Audit", "Get-AuditText", "Format-Bytes", "ConvertTo-ShortJson"]:
    ok(fn in defs, "6b.11 launcher 定义 %s" % fn)
ok("Refresh-Audit" in ps and "/api/admin/audit" in ps, "6b.12 launcher 审计页调用审计接口")
ok(re.search(r"\$pgAudit\s*=", ps) is not None and "审计日志" in ps, "6b.13 launcher 有审计标签页")

# ---------- 9. 永久会员 + 收款流水对账（服务端 1.4.5 / 插件 0.24.5）----------
RC_LIB = os.path.join(ROOT, "server", "lib", "reconcile.js")
ok(os.path.exists(RC_LIB), "9.1 存在 server/lib/reconcile.js")
rc_src = io.open(RC_LIB, encoding="utf-8").read() if os.path.exists(RC_LIB) else ""
for fn in ["parseLine", "parseEntries", "matchPayments", "summarize"]:
    ok(re.search(r"function %s\b" % fn, rc_src) is not None, "9.2 reconcile.js 定义 %s()" % fn)
ok("/api/admin/reconcile" in srv, "9.3 服务端有对账路由")
ok("auditLog(req, 'order.reconcile'" in srv, "9.4 对账核销写审计")
ok("'order.reconcile'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read(),
   "9.5 audit.js 动作表含 order.reconcile")
# 动作中文名跨语言两份，必须同步（MEMORY 里记的纪律）
ok("'order.reconcile'" in ps, "9.6 launcher 的 Get-AuditText 也含 order.reconcile")

MEM_JS = os.path.join(ROOT, "server", "lib", "membership.js")
mem = io.open(MEM_JS, encoding="utf-8").read()
ok("const PERPETUAL = 'perpetual'" in mem, "9.7 membership 定义永久周期常量")
ok("function assignTail" in mem, "9.8 membership 有尾数分配")
ok("function amountCentsOf" in mem, "9.9 membership 有分位金额换算（旧订单兼容）")
ok("perpetual" in mem and "monthsLabel" in mem, "9.10 membership 永久语义（时长文案 / 授予不降级）")

# 后台 Web：永久周期 + 对账面板
for must in ['id="reconcile-mask"', 'id="rc-text"', 'id="rc-table"', 'id="rc-apply-btn"',
             'id="gm-perpetual"']:
    ok(must in html, "9.11 admin.html 含 %s" % must)
for fn in ["openReconcile", "runReconcile", "applyReconcile", "onGrantPerpetual"]:
    ok(("function %s" % fn) in html, "9.12 admin.html 定义 %s()" % fn)
ok("'perpetual'" in html, "9.13 admin.html 价格表单识别永久周期")

# 启动器：对账入口 + 永久周期
ok("Show-ReconcileDialog" in defs, "9.14 launcher 定义 Show-ReconcileDialog")
ok("Get-ReconcileStatusText" in defs, "9.15 launcher 定义 Get-ReconcileStatusText")
ok("对账导入" in ps and "/api/admin/reconcile" in ps, "9.16 launcher 订单页有对账入口并调用接口")
ok("'perpetual'" in ps, "9.17 launcher 价格表单识别永久周期")

# 插件：下单传周期 + 尾数提示 + 永久显示（本节位置在 7/8 之前，直接读文件避免依赖顺序）
_acct_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js"),
                    encoding="utf-8").read()
_pa_src = io.open(os.path.join(ROOT, "chrome", "content", "prefs-account.js"), encoding="utf-8").read()
ok("async createOrder(plan, months, cycle, couponCode)" in _acct_src,
   "9.18 插件 createOrder 支持周期参数与券码")
ok("perpetual" in _acct_src, "9.19 插件 account.js 读取 perpetual")
ok("tailCents" in _pa_src, "9.20 插件支付面板提示专属尾数")
ok("永久" in _pa_src, "9.21 插件显示「永久」相关文案")

# ---------- 7. 插件设置面板：引用的元素 id 是否真的存在于 prefs.xhtml ----------
# 这类失误的表现就是「点了没反应」——JS 里 $("pp-xxx") 拿到 null，静默什么都不做。
PREFS_JS = os.path.join(ROOT, "chrome", "content", "prefs-account.js")
PREFS_XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")
prefs_js = io.open(PREFS_JS, encoding="utf-8").read()
prefs_xhtml = io.open(PREFS_XHTML, encoding="utf-8").read()
xhtml_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', prefs_xhtml))
# 由 JS 动态创建（el() 里带 id）的元素不算缺失
dyn_ids = set(re.findall(r'el\(\s*"[a-z]+"\s*,\s*\{[^}]*id:\s*"([A-Za-z0-9_-]+)"', prefs_js))
used_ids = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', prefs_js))
used_ids |= set(re.findall(r'bind\("([A-Za-z0-9_-]+)"', prefs_js))
used_ids |= set(re.findall(r'mbSetMsg\("([A-Za-z0-9_-]+)"', prefs_js))
missing_ids = sorted(i for i in used_ids if i not in xhtml_ids and i not in dyn_ids)
ok(not missing_ids, "7.1 prefs-account.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (missing_ids or "无"))

for must in ["pp-mb-renew", "pp-mb-usage", "pp-mb-options", "pp-mb-order"]:
    ok(must in xhtml_ids, "7.2 prefs.xhtml 含会员元素 #%s" % must)

# ---------- 8. 0.24.4：价格表 / 到期提醒 / 用量趋势 跨模块接线 ----------
ACCOUNT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js")
MAIN_JS = os.path.join(ROOT, "chrome", "content", "scripts", "main.js")
PREFS_DEFAULTS = os.path.join(ROOT, "prefs.js")
acct = io.open(ACCOUNT_JS, encoding="utf-8").read()
mainjs = io.open(MAIN_JS, encoding="utf-8").read()
prefsdef = io.open(PREFS_DEFAULTS, encoding="utf-8").read()

for fn in ["renewalReminder()", "lastPurchasedMonths()", "cost()"]:
    ok(fn in acct, "8.1 account.js 定义 %s" % fn)
# ★ 1.8.0 取消「赠送调用次数」：插件端不得再引用 dailyLimit / dailyUsed
ok("dailyLimit" not in acct and "dailyLimit" not in prefs_js,
   "8.1b 插件端已无 dailyLimit 引用（每日次数上限已取消）")
for k in ["priceItems", "upcoming"]:
    ok(k in acct, "8.2 account.js plans() 下发 %s" % k)
    ok(k in prefs_js, "8.3 prefs-account.js 使用 %s" % k)
ok("renewalReminder" in prefs_js and "lastPurchasedMonths" in prefs_js,
   "8.4 prefs-account.js 使用到期提醒与上次周期")
ok("_checkRenewal" in mainjs and "renewPromptShownFor" in mainjs,
   "8.5 main.js 启动时检查到期提醒")
ok("renewPromptShownFor" in prefsdef, "8.6 prefs.js 有 renewPromptShownFor 默认值")
ok("usageDays" in srv and "usageDaily" in srv, "8.7 服务端实现按日用量与后台下发")
ok("exportUsageCSV" in html, "8.8 Web 管理页有用量 CSV 导出")

# ---------- 9. 1.4.6：优惠券 / 折扣码 ----------
COUPON_LIB = os.path.join(ROOT, "server", "lib", "coupon.js")
ok(os.path.exists(COUPON_LIB), "9.1 存在 server/lib/coupon.js")
coupon_src = io.open(COUPON_LIB, encoding="utf-8").read()
for fn in ["sanitizeCoupon", "stateOf", "computeDiscount", "quote",
           "reserveUse", "consumeUseByOrder", "releaseUseByOrder",
           "couponOut", "couponPublicOut", "createCoupons", "updateCoupon", "removeCoupon"]:
    # 有的是 function 声明、有的是 const 箭头函数 —— 两种形态都要认，否则满屏假失败
    _defined = (re.search(r"function %s\b" % fn, coupon_src) is not None
                or re.search(r"const %s\s*=" % fn, coupon_src) is not None)
    ok(_defined, "9.2 coupon.js 定义 %s()" % fn)
ok("require('./lib/coupon')" in srv, "9.3 服务端引入 coupon 模块")
for must in ["/api/admin/coupons", "/api/coupons/validate", "couponCode"]:
    ok(must in srv, "9.4 服务端含优惠券接线 %s" % must)
ok("quoteOrder" in srv, "9.5 服务端有试算 helper（与下单共用同一取价口径）")
ok("coupons" in srv and "couponsActive" in srv, "9.6 health 暴露优惠券观测字段")
# 订单生命周期必须联动券占用（否则限额会被乱点耗光 / 释放不掉）
for must in ["coupon.releaseUseByOrder", "coupon.consumeUseByOrder", "coupon.reserveUse"]:
    ok(must in srv or must in io.open(os.path.join(ROOT, "server", "lib", "membership.js"),
                                      encoding="utf-8").read(),
       "9.7 订单生命周期联动券占用：%s" % must)
ok("coupon.create" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"),
                              encoding="utf-8").read(), "9.8 审计动作表含 coupon.*")
# 三处 UI
ok("tab-coupon" in html and "pane-coupon" in html and "openCouponForm" in html,
   "9.9 Web 管理页有优惠券标签页与弹窗")
ok("'优惠券'" in ps and "Show-CouponForm" in ps and "Refresh-Coupons" in ps,
   "9.10 启动器有优惠券标签页与对话框")
# 插件端：试算 + 下单带券 + 面板元素存在
ok("validateCoupon" in acct and "couponCode" in acct, "9.11 插件 account.js 支持试算与带券下单")
ok("createOrder(mbSel.plan, mbSel.months, mbSel.cycle," in prefs_js, "9.12 插件下单时传券码")
for eid in ["pp-mb-coupon", "pp-mb-coupon-btn", "pp-mb-quote"]:
    ok(('id="%s"' % eid) in io.open(os.path.join(ROOT, "chrome", "content", "prefs.xhtml"),
                                    encoding="utf-8").read(),
       "9.13 prefs.xhtml 存在优惠码元素 %s" % eid)
    ok(('"%s"' % eid) in prefs_js, "9.14 prefs-account.js 引用 %s" % eid)
ok("pp-mb-quote" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                            encoding="utf-8").read(), "9.15 prefs.css 有折后价样式")
# 折后金额的下限保护（不允许 100% 减免 → 免费请用激活码）
ok("MIN_PAYABLE_CENTS" in coupon_src and "MAX_PERCENT = 99" in coupon_src,
   "9.16 优惠券守住「折后至少 ¥1、最多 99%」的下限")
# ★ 尾数必须在**折后**金额上分配，否则「按金额唯一对账」在打折后会失效
mem_src = io.open(os.path.join(ROOT, "server", "lib", "membership.js"), encoding="utf-8").read()
ok("const baseCents = originalCents - discountCents;" in mem_src
   and "assignTail(doc, baseCents" in mem_src,
   "9.17 尾数在折后金额上分配（保住按金额唯一对账）")

# ---------- 10. 1.4.7：登录设备与会话管理 ----------
SESS_LIB = os.path.join(ROOT, "server", "lib", "sessions.js")
ok(os.path.exists(SESS_LIB), "10.1 存在 server/lib/sessions.js")
sess_src = io.open(SESS_LIB, encoding="utf-8").read()
for fn in ["sidOf", "maskIp", "deviceFromHeaders", "recordStart", "recordSeen",
           "sessionsOf", "sessionOut", "deviceAlertOf", "shouldAlert", "record",
           "revokeSid", "revokeOthers", "sidOfRec"]:
    _defined = (re.search(r"function %s\b" % fn, sess_src) is not None
                or re.search(r"const %s\s*=" % fn, sess_src) is not None)
    ok(_defined, "10.2 sessions.js 定义 %s()" % fn)
ok("require('./lib/sessions')" in srv, "10.3 服务端引入 sessions 模块")
for must in ["/api/sessions", "revoke-others", "/sessions/"]:
    ok(must in srv, "10.4 服务端含会话路由 %s" % must)
ok("sessionsActive" in srv and "devicesOverLimit" in srv, "10.5 health 暴露设备观测字段")
ok("sessionOut" in srv and "full: true" in srv,
   "10.6 管理侧用 full 视图（完整 IP），用户侧默认打码")
# ★ 展示与撤销必须同源，否则会出现"看得见却踢不掉"的设备
ok("sidOfRec" in sess_src and sess_src.count("sidOfRec(") >= 3,
   "10.7 展示与撤销共用同一个 sid 取值来源（sidOfRec）")
# ★ 只处理有效令牌，保证「已踢出 N 台」与用户数出来的台数一致
ok("if (!(Number(rec.expiresAt) > t)) continue;" in sess_src,
   "10.8 踢出只针对仍然有效的令牌（口径与设备列表一致）")
ok("deviceAlertOf" in srv and "sessions.record(" in srv and "sessions.logLine" in srv,
   "10.9 设备超阈值接入既有告警链（alerts.log + 邮件 + alerts.json）")
ok("alertStore.data.sessions" in srv,
   "10.10 设备告警状态用 sessions 命名空间，不覆盖既有积压状态")
_audit_src = io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read()
for act in ["session.revoke'", "session.revoke-others", "session.revoke-admin"]:
    ok(act in _audit_src, "10.11 审计动作表含 %s" % act)
    ok(act in ps, "10.12 launcher 审计中文表含 %s" % act)
# 两套 UI
ok("sessions-mask" in html and "openSessions" in html and "kickSession" in html,
   "10.13 Web 管理页有设备弹窗与踢出逻辑")
ok("活跃设备" in html, "10.14 Web 管理页用户表有活跃设备列")
ok("Show-SessionsDialog" in ps and "Refresh-Sessions" in ps, "10.15 启动器有设备子窗体")
for eid in ["sessions-mask", "ss-table", "ss-stat"]:
    ok(('id="%s"' % eid) in html, "10.16 Web 管理页存在设备元素 %s" % eid)
ok("openSessions" in html, "10.17 用户行有设备入口按钮")

# ---------- 11. 0.24.7：插件上报设备标识 + 登录设备面板 ----------
for fn in ["installId()", "_deviceHeaders()", "sessions()", "renameSession(", "revokeSession(", "revokeOtherSessions("]:
    ok(fn in acct, "11.1 account.js 定义 %s" % fn)
ok('X-PP-Device' in acct and 'X-PP-Platform' in acct, "11.2 account.js 上报设备头")
ok("const headers = this._deviceHeaders();" in acct,
   "11.3 _request 统一注入设备头（不是每处手写，避免漏传）")
ok("installId" in prefsdef, "11.4 prefs.js 有 installId 默认值")
ok("PUT" in srv and "session.label" in srv, "11.5 服务端支持给设备命名（PUT /api/sessions/:sid）")
ok("setLabel" in sess_src, "11.6 sessions.js 定义 setLabel()")
for eid in ["pp-dev-block", "pp-dev-list", "pp-dev-stat", "pp-dev-refresh",
            "pp-dev-kick-others", "pp-dev-msg"]:
    ok(('id="%s"' % eid) in prefs_xhtml, "11.7 prefs.xhtml 存在设备元素 %s" % eid)
ok("renderDevices" in prefs_js, "11.8 prefs-account.js 渲染设备列表")
ok("onKickOtherDevices" in prefs_js and "onKickDevice" in prefs_js, "11.9 有踢出（单台/全部）逻辑")
# ★ 反馈必须在刷新之后写，否则「已踢出」会被刷新清空（改前踩过）
ok("await renderDevices(\"✓ 已踢出该设备\")" in prefs_js,
   "11.10 操作反馈交给刷新函数最后写（不会被刷新冲掉）")
# ★ 面板作用域没有 Services，必须走安全包装；直接 window.prompt 在 Zotero 里不可靠
ok("Services_promptInput(" in prefs_js and "Services_promptConfirm(" in prefs_js,
   "11.11 提示框走 Services 安全包装（不用裸 window.prompt）")
ok("pp-dev-row" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                           encoding="utf-8").read(), "11.12 prefs.css 有设备行样式")
# 设备标识不是凭据：不能出现在会话文件/审计的敏感位置（这里核对它只存 pref）
ok('Prefs.set("installId"' in acct, "11.13 installId 只持久化到 pref（非凭据，与「令牌不进 pref」不冲突）")

# ---------- 12. 套餐 AI 能力（1.4.9：高级模型白名单 + 新用户全模型试用） ----------
MEM_LIB = os.path.join(ROOT, "server", "lib", "membership.js")
mem_src = io.open(MEM_LIB, encoding="utf-8").read()

# --- membership.py：试用纯函数 + 全局 ai 配置 ---
for fn in ["trialState", "trialDaysFor"]:
    ok(re.search(r"function %s\b" % fn, mem_src) is not None, "12.1 membership.js 定义 %s()" % fn)
ok("trialState," in mem_src and "trialDaysFor," in mem_src, "12.2 membership.js 导出试用函数")
ok("DEFAULT_AI" in mem_src and "trialDays: 7" in mem_src, "12.3 试用天数有默认值（7 天）")
ok("out.ai = { trialDays: clampInt(" in mem_src,
   "12.4 normalize 归一化 ai.trialDays（越界夹取、非法回落默认）")

# --- 服务端：解析函数 ---
for fn in ["highTierModels", "trialOf", "highTierAccess", "modelsForUser", "gatewayModelsAll"]:
    ok(re.search(r"function %s\b" % fn, srv) is not None, "12.5 服务端定义 %s()" % fn)

# auto 恒定免费：这是防「误配把全体用户锁死」的关键守卫
ok("m !== 'auto' && hi.includes(m)" in srv, "12.6 auto 恒免费（不进 locked，不被拦）")
ok("acc.allowed ? all : free" in srv or "acc.allowed ? all.slice() : all.filter((m) => !isHi(m))" in srv,
   "12.7 可用模型按套餐过滤")

# --- 服务端：网关强制 ---
ok("MODEL_REQUIRES_PRO" in srv, "12.8 越权调用返回可编程识别的 code")
# 明确拒绝而非静默换模型（金额/模型类纪律：静默修正比报错危险）
ok(re.search(r"return json\(res, 403, \{ ok: false, code: 'MODEL_REQUIRES_PRO'", srv) is not None,
   "12.9 高级模型越权 → 403 明确拒绝（不静默降级到便宜模型）")
ok("const av = modelsForUser(user);\n        return json(res, 200, { object: 'list'," in srv,
   "12.10 /v1/models 按套餐返回（不再是全局清单）")

# /v1/models 不得再直接吐全量清单
ok("gatewayModelsAll().map" not in srv, "12.11 /v1/models 不再直接返回全量模型")

# --- 服务端：对外契约与后台 ---
ok("out.ai = {" in srv and "lockedModels: av.locked" in srv and "defaultModel: 'auto'" in srv,
   "12.12 /api/auth/me 带 ai 块（含 lockedModels 供面板灰显）")
ok("highTierModels: highTierModels().length" in srv, "12.13 health 暴露高级模型数量")
ok("url === '/api/admin/channels/high-tier' && method === 'PUT'" in srv,
   "12.14 管理端点 PUT /api/admin/channels/high-tier 存在")
ok("highTierModels: highTierModels(),   // 1.4.9" in srv, "12.15 管理端 GET channels 回传高级清单")
ok("ai: { trialDays: membership.trialDaysFor(membershipStore.data) }" in srv,
   "12.16 管理端 GET membership 回传 ai.trialDays（否则后台没法回显）")
ok("if (p.highTierModels !== undefined) doc.plans[pid].highTierModels" in srv,
   "12.17 套餐更新白名单含 highTierModels（此前该字段无处可改）")
ok("input.ai.trialDays !== undefined" in srv, "12.18 套餐更新白名单含 ai.trialDays")
ok("outsidePublished" in srv, "12.19 高级清单越出上线范围时给出提示（不阻断）")

# --- 审计动作（两处都要有） ---
AUDIT_LIB = os.path.join(ROOT, "server", "lib", "audit.js")
audit_src = io.open(AUDIT_LIB, encoding="utf-8").read()
ok("'channel.high-tier'" in audit_src, "12.20 audit.js 动作表含 channel.high-tier")
ok("'channel.high-tier'" in ps, "12.21 launcher 的 Get-AuditText 也含 channel.high-tier")

# --- Web 管理页 ---
for k in ["ht-chips", "saveHighTier", "clearHighTier", "p-trial-days", "p-free-hi", "p-pro-hi", "ch-ht"]:
    ok(k in html, "12.22 admin.html 含 %s" % k)
ok("'/api/admin/channels/high-tier'" in html, "12.23 Web 页调用高级清单接口")
ok("body.ai = { trialDays:" in html, "12.24 Web 页保存试用天数")
ok("highTierModels: !!$('p-free-hi').checked" in html, "12.25 Web 页保存免费版高级模型开关")

# --- 启动器 ---
ok("txtHigh" in ps and "btnSaveHigh" in ps, "12.26 启动器通道窗体有高级模型输入与保存")
ok("'/api/admin/channels/high-tier'" in ps, "12.27 启动器调用高级清单接口")
ok("highTierModels = [bool]$chkFreeHi.Checked" in ps, "12.28 启动器套餐页保存高级模型开关")
ok("ai = @{ trialDays = $script:planTrialDays }" in ps, "12.29 启动器套餐页保存试用天数")
ok("$script:mbAiTrialDays = [int]$r.plans.ai.trialDays" in ps, "12.30 启动器回显当前试用天数")

# ---------- 13. 插件端套餐 AI 能力（0.24.8） ----------
ok(re.search(r"^  ai\(\) \{", acct, re.M) is not None, "13.1 account.js 定义 ai() 访问器")
# 旧服务端没有 ai 块时必须回落「不限制」——客户端绝不能在没有依据时锁用户
ok('reason: "unknown"' in acct, "13.2 旧服务端无 ai 块 → reason=unknown（不限制）")
ok('return { highTier: true, reason: "unknown"' in acct, "13.3 未知时按「不限制」返回")

ok(re.search(r"function aiTier\(\)", prefs_js) is not None, "13.4 面板有 aiTier() 形状归一化")
ok("typeof raw !== \"object\"" in prefs_js, "13.5 非对象返回（含 Promise）→ 安全降级")
ok("Array.isArray(raw.lockedModels)" in prefs_js, "13.6 锁定列表强制成数组（否则 for…of 会抛）")
ok(re.search(r"function renderAiTierNote\(note\)", prefs_js) is not None, "13.7 面板有分层说明条渲染")
# 0.72.3：标记从 🔒 字符改为文字「（需专业版）」（<option> 里画不了 SVG，emoji 一律清掉）
ok('m + "（需专业版）"' in prefs_js, "13.8 需升级的模型以「（需专业版）」灰显列出（让用户看见差距）")
ok("全模型试用中，剩 " in prefs_js, "13.9 试用中显示剩余天数")
ok("已回落到 " in prefs_js and "C.upsert({ id: C.OFFICIAL_ID, model: AI.defaultModel })" in prefs_js,
   "13.10 当前模型已锁 → 回落到默认并**写明原因**（不静默改配置）")
ok("if (!known) { sel.value = list[0]; return \"\"; }" in prefs_js,
   "13.11 无从判断可用性时不动用户配置（旧服务端兼容）")
ok("AI.lockedModels.indexOf(v) >= 0" in prefs_js, "13.12 选中锁定模型时拦下（服务端也会 403，双保险）")
# 反馈必须写在刷新之后（本项目踩过的坑：渲染函数会重置消息区）
ok(re.search(r"Promise\.resolve\(fillOfficialModelSelect\(\)\)\.then\(\(\) => \{\s*\n\s*renderAiTierNote\(",
             prefs_js) is not None,
   "13.13 锁定反馈写在刷新之后（不会被刷新冲掉）")
ok("pp-ai-tier-note" in prefs_xhtml, "13.14 prefs.xhtml 有分层说明条容器")
ok("pp-ai-tier" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                           encoding="utf-8").read(), "13.15 prefs.css 有分层说明条样式")

# ---------- 14. 测试基建：端口由系统分配（避免与本机常驻服务撞端口） ----------
# 起因：sessions.test.js 用 18500..18799 随机端口，而本机常驻的 Prism 网关占 18790/18791，
# 抽中即 EADDRINUSE —— preflight 偶发失败，看着像被测代码坏了，实际是测试基建踩了别人的端口。
TEST_DIR = os.path.join(ROOT, "test")
_n = 0
for _fn in sorted(os.listdir(TEST_DIR)):
    if not _fn.endswith(".test.js"):
        continue
    _src = io.open(os.path.join(TEST_DIR, _fn), encoding="utf-8").read()
    if "server.listen(" not in _src:
        continue
    _n += 1
    ok("server.listen(0, '127.0.0.1'" in _src,
       "14.%d %s 端口由系统分配（listen(0)）" % (_n * 3 - 2, _fn))
    # 1.8.5：允许 `PORT = server.address().port` 与 `PORT = m.server.address().port`
    ok(".address().port;" in _src,
       "14.%d %s 回读实际端口" % (_n * 3 - 1, _fn))
    # ★ 请求助手必须关掉 keep-alive：
    #   Node 19+ 客户端默认 keep-alive，而 Node 服务端 keepAliveTimeout 默认 5s——
    #   复用一条「正被服务端关闭」的空闲 socket 会拿到 ECONNRESET。
    #   表现是**偶发**的「异常中断」，让门禁假红（server-ops 实测 4/6 失败，HEAD 同样复现）。
    #   agent:false = 每个请求新连接，彻底避开该竞态。这是测试基建，不改产品行为。
    ok("agent: false" in _src,
       "14.%d %s 请求助手关闭 keep-alive（防 ECONNRESET 假红）" % (_n * 3, _fn))

# ---------- 15. 主题切换按钮：界面主题 / PDF 阅读主题 两个按钮分开（0.25.1） ----------
# 起因：这两块各有一批典型静默失败——
#   ① 用了自造 DOM 注入而不是官方 renderToolbar 扩展位（原生 React 重渲染会把节点冲掉）；
#   ② append 被异步调用（CustomSections 的 append 在事件同步返回后即失效，会抛
#      "Append must be called directly and synchronously"）；
#   ③ 阅读器那套变量名写成了主窗口的 --fill-quaternary（reader.css 用的是
#      --fill-quarternary，少一个 r）→ hover 底色全失效且不报错；
#   ④ 「按钮分开」的要求很容易被下一个改动悄悄并回去（一个弹层里又塞两套主题），
#      所以把「谁只列谁」也做成断言。
THEME_TOGGLE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "theme-toggle.js")
UI_THEME_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "ui-theme.js")
PDF_THEME_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-theme.js")
toggle_js = io.open(THEME_TOGGLE_JS, encoding="utf-8").read()
uitheme_js = io.open(UI_THEME_JS, encoding="utf-8").read()
pdftheme_js = io.open(PDF_THEME_JS, encoding="utf-8").read()
mainjs = io.open(MAIN_JS, encoding="utf-8").read()
prefsdef = io.open(PREFS_DEFAULTS, encoding="utf-8").read()
utils_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"),
                   encoding="utf-8").read()

ok('"features/theme-toggle.js"' in mainjs, "15.1 main.js 装配清单含 theme-toggle.js")
ok("this.themeToggle = ThemeToggle;" in mainjs, "15.2 main.js 把 ThemeToggle 挂到 Zotero.Papilot")
ok("ThemeToggle.register(id);" in mainjs, "15.3 main.js 启动时注册主题按钮")
ok("ThemeToggle.unregister();" in mainjs, "15.4 main.js 关闭时注销主题按钮（按钮/弹层/样式全摘）")
ok("ThemeToggle.refresh()" in mainjs, "15.5 主题 pref 变化时同步两处按钮提示")
ok('"themeButtonEnabled"' in mainjs, "15.6 themeButtonEnabled 进 pref 观察清单")
ok("themeButtonEnabled" in prefsdef, "15.7 prefs.js 有 themeButtonEnabled 默认值")
# 阅读器：必须走官方扩展位（官方事件 + 同步 append）
ok('registerEventListener("renderToolbar"' in toggle_js, "15.8 阅读器按钮走官方 renderToolbar 事件")
ok('unregisterEventListener("renderToolbar"' in toggle_js, "15.9 注销同一个 handler 引用（否则泄漏）")
ok(re.search(r"const btn = this\._readerButton\(doc\);\s*\n\s*append\(btn\);", toggle_js) is not None,
   "15.10 append 在事件回调里同步调用（异步会抛且按钮不出现）")
_render_fn = toggle_js.split("_onRenderToolbar(event)")[1].split("_readerButton(doc)")[0]
ok("getElementById" not in _render_fn,
   "15.11 工具栏重渲染必须重建按钮（不能「已存在就跳过」）")
# 规范对齐：class 用宿主原生按钮类，不发明样式
ok('setAttribute("class", "toolbar-button pp-theme-pdf-toggle")' in toggle_js,
   "15.12 阅读器按钮用原生 .toolbar-button（hover/active/disabled 全免费）")
ok('btn.style.listStyleImage = \'url("chrome://papilot/content/icons/theme.svg")\'' in toggle_js,
   "15.13 主窗口按钮用 context-fill 单色图标")
ok('btn.setAttribute("class", "zotero-tb-button")' in toggle_js,
   "15.14 主窗口按钮用原生 .zotero-tb-button（28×28 与相邻控件一致）")
ok('"zotero-collections-toolbar"' in toggle_js, "15.15 主窗口按钮落在左上角收藏夹工具栏")
ok('"zotero-tb-collection-add"' in toggle_js, "15.16 锚定「新建分类」之后（左上角第一排）")
ok('setAttribute("type", "menu")' not in toggle_js,
   "15.17 不用 type=menu（宽度会变 40px，与相邻 28px 不齐）")
ok("max-width:min(92vw,280px)" in toggle_js and "max-height:min(70vh,440px)" in toggle_js,
   "15.18 阅读器弹层限宽限高（窄屏不溢出）")
ok('btn.style.flex = "none";' in toggle_js, "15.19 阅读器按钮不参与收缩（窄屏不被挤扁）")
# 变量拼写：reader 侧必须用原生 --fill-quarternary
ok("--fill-quarternary: " in uitheme_js, "15.20 ui-theme 阅读器变量用原生拼写 --fill-quarternary")
ok(re.search(r"_readerCSS\(theme\)", uitheme_js) is not None, "15.21 ui-theme 有阅读器变量组 _readerCSS")
ok("applyToReaderDoc(doc)" in uitheme_js, "15.22 阅读器文档可单独注入（新开 reader 也能吃到主题）")
ok("this.refreshReaders();" in uitheme_js, "15.23 apply() 同步刷新已打开的阅读器界面")
# ---- 15.24~15.32：两块主题必须分开、各管各的 pref ----
# 取块时锚点**必须带方法签名里的 ` {`**：函数名在文件里会先作为调用点出现一次
# （`_mainButton` 里的 addEventListener、`_toggleReaderPopup` 里的自调用），
# 只按名字切会切到调用点、拿到空块 → 断言静默变成"永远不命中"。
_reader_render = toggle_js.split("_renderReaderPopup(doc, pop) {")[1].split("_placePopup(doc, pop, btn)")[0]
_main_menu = toggle_js.split("_fillMainMenu(doc, popup) {")[1].split("/* ==================== 状态同步")[0]
ok("_pdfItems()" in _reader_render, "15.24 阅读器弹层列 PDF 阅读主题")
ok("_uiGroups()" not in _reader_render,
   "15.25 阅读器弹层**不**列界面主题（按钮已分开，不能又并回去）")
ok("_applyUi(" not in _reader_render, "15.26 阅读器弹层不会写 uiTheme")
ok("_uiGroups()" in _main_menu, "15.27 主窗口弹层列界面主题")
ok("_pdfItems()" not in _main_menu,
   "15.28 主窗口弹层**不**列 PDF 阅读主题（同上）")
ok("_applyPdf(" not in _main_menu, "15.29 主窗口弹层不会写 pdfTheme")
ok("_uiTip()" in toggle_js and "_pdfTip()" in toggle_js,
   "15.30 两处按钮提示各自只说自己那套主题")
ok('themeUiButtonTip' in utils_js and 'themePdfButtonTip' in utils_js,
   "15.31 文案表有两条按钮提示键（旧 themeButtonTip 已退役）")
ok("themeButtonTip" not in toggle_js and "themeButtonTip:" not in utils_js,
   "15.32 旧的合并文案键已清干净")
# 旧的自造工具栏注入必须已经拆掉，否则会出现两个按钮
ok("_addToolbarButton" not in pdftheme_js, "15.33 pdf-theme 已移除旧的自造工具栏按钮（避免双按钮）")
ok("papilot-pdf-theme-toggle" not in pdftheme_js, "15.34 pdf-theme 不再持有旧按钮 id")
# ---- 15.35~15.36：「自定义主题」必须是跳板，不能直接套用空色板 ----
# 起因：uiThemeCustom 为空时 setTheme("custom") 会渲染出「全白 + 无壁纸」的主题，
# 用户点完的观感就是「没反应 / 背景反而没了」（0.25.1 用户实测）。
ok("_customReady()" in toggle_js and "uiThemeCustom" in toggle_js,
   "15.35 菜单判断自定义色板是否已配置")
ok("if (jump) this._openThemeSettings();" in toggle_js,
   "15.36 未配置色板时「自定义主题」改为打开设置面板（不套用空主题）")

# ---------- 16. arXiv 核心（0.25.0）：生成物 × 装配 × Discovery 迁移 ----------
# 起因：插件侧的 arXiv 查询构建/Atom 解析/去重由 scripts/build-arxiv-core.py 从
# tools/arxiv/src 生成（单一真源在 tools 侧）。这类「代码生成代码」有四种典型静默失败：
#   ① 改了 tools 侧却忘记重新生成 → CLI 里对、插件里错，两边测试都绿；
#   ② 生成物残留 require/module.exports → 插件作用域加载即抛，只写一行 boot 日志；
#   ③ 装配顺序错（被依赖者排后面）→ 加载期 ReferenceError，同样是静默降级；
#   ④ Discovery 迁移后语义回退（多分类从 OR 变 AND）→ 推荐结果集直接变样，没人会报错。
ARXIV_CORE_DIR = os.path.join(ROOT, "chrome", "content", "scripts", "arxiv")
ARXIV_GEN = ["arxiv-errors", "arxiv-dates", "arxiv-query", "arxiv-categories",
             "arxiv-atom", "arxiv-analyze", "arxiv-rate-limiter"]
ARXIV_FETCH_JS = os.path.join(ARXIV_CORE_DIR, "arxiv-fetch.js")
DISCOVERY_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "discovery.js")
GEN_SCRIPT = os.path.join(ROOT, "scripts", "build-arxiv-core.py")

for _i, _name in enumerate(ARXIV_GEN, 1):
    _p = os.path.join(ARXIV_CORE_DIR, _name + ".js")
    _exists = os.path.exists(_p)
    ok(_exists, "16.%d 生成物存在: %s.js" % (_i, _name))
    if _exists:
        _src = io.open(_p, encoding="utf-8").read()
        ok("AUTOGENERATED" in _src[:400], "16.%d 生成物带 AUTOGENERATED 标记: %s" % (_i, _name))
        ok(("require(" not in _src) and ("module.exports" not in _src) and ("process." not in _src),
           "16.%d 生成物无 Node 专有标识: %s" % (_i, _name))

ok(os.path.exists(ARXIV_FETCH_JS), "16.90 arxiv-fetch.js 存在（手写适配层）")
fetch_js = io.open(ARXIV_FETCH_JS, encoding="utf-8").read() if os.path.exists(ARXIV_FETCH_JS) else ""
disc_js = io.open(DISCOVERY_JS, encoding="utf-8").read() if os.path.exists(DISCOVERY_JS) else ""

# 装配：清单齐全 + 依赖序（核心必须排在 discovery.js 之前）
_main_js = io.open(MAIN_JS, encoding="utf-8").read()
for _name in ARXIV_GEN + ["arxiv-fetch"]:
    ok(('"arxiv/%s.js"' % _name) in _main_js, "16.91 main.js 装配清单含 arxiv/%s.js" % _name)
ok(_main_js.index('"arxiv/arxiv-errors.js"') < _main_js.index('"features/discovery.js"'),
   "16.92 核心排在 discovery.js 之前（否则加载期 ReferenceError）")
ok(_main_js.index('"arxiv/arxiv-fetch.js"') < _main_js.index('"features/discovery.js"'),
   "16.93 arxiv-fetch 排在 discovery.js 之前")
ok(_main_js.index('"arxiv/arxiv-errors.js"') < _main_js.index('"arxiv/arxiv-query.js"') < _main_js.index('"arxiv/arxiv-atom.js"'),
   "16.94 核心内部按依赖序（errors → query → atom）")
ok("this.arxiv = ArxivFetch;" in _main_js, "16.95 main.js 把 ArxivFetch 挂到 Zotero.Papilot")
ok("ArxivFetch.selfTest()" in _main_js, "16.96 启动时跑 arXiv 核心离线自检（结论写进 boot 日志）")

# Discovery 迁移：自带解析/查询/拉取必须已经拆掉，且改用新的核心
for _bad, _desc in [("parseAtom", "自写 Atom 解析"), ("buildQuery", "自写查询构建"),
                    ("fetchFeed", "自写拉取"), ("ARXIV_API", "硬编码 API 地址")]:
    ok(_bad not in disc_js, "16.97 discovery.js 已移除%s" % _desc)
ok("ArxivFetch.search(" in disc_js, "16.98 discovery.js 改用 ArxivFetch.search（分页+重试+限速）")
ok("ArxivCategories.checkAll(" in disc_js, "16.99 discovery.js 用内置分类目录做拼写核对")
# ★ 语义守护：多分类必须 OR（并集）。旧实现手写 +OR+，改成 AND 会静默缩小结果集
ok('categoryMode: "OR"' in disc_js, "16.100 discovery.js 多分类用 OR 并集（防止语义回退成 AND）")

# 适配层：必须自行判状态 + 必须经过限速器
ok("_classify(" in fetch_js, "16.101 arxiv-fetch 自行判定 HTTP 状态（Zotero.HTTP 对 4xx 不抛异常）")
ok("limiter().run(" in fetch_js, "16.102 arxiv-fetch 的请求经 RateLimiter（3 秒 1 次的 arXiv 礼节）")
ok(fetch_js.count("Zotero.HTTP.request(") == 1,
   "16.103 arxiv-fetch 只有一个 HTTP 出口（便于统计与限速）")
ok("ArxivAtom.extractApiError(" in fetch_js, "16.104 400 错误体里的 arXiv 原话被带出（不当成 0 结果）")
ok("extractApiError" in io.open(os.path.join(ROOT, "tools", "arxiv", "src", "atom.js"), encoding="utf-8").read(),
   "16.105 extractApiError 的单一真源在 tools/arxiv/src/atom.js")

# 门禁：生成器 + preflight 步骤 + 冒烟覆盖
ok(os.path.exists(GEN_SCRIPT), "16.106 生成器 scripts/build-arxiv-core.py 存在")
ok("--check" in io.open(GEN_SCRIPT, encoding="utf-8").read(), "16.107 生成器支持 --check（漂移检测）")
_pf = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("build-arxiv-core.py" in _pf, "16.108 preflight 含「arXiv 核心生成物同步」步骤")
ok("arxiv-core.test.js" in _pf, "16.109 preflight 含插件侧 arXiv 核心测试")
_smoke = io.open(os.path.join(ROOT, "test", "smoke-load.test.js"), encoding="utf-8").read()
ok("arxiv)" in _smoke or "|arxiv)" in _smoke, "16.110 全模块冒烟的文件正则含 arxiv/（新模块才会被覆盖）")
ok("ArxivAtom.parseAtom" in _smoke, "16.111 冒烟改用 ArxivAtom.parseAtom（Discovery 不再自带解析）")

# ---------- 17. 全文对照翻译 · 双栏对照窗口（0.25.2） ----------
# 起因：这个窗口几乎踩满了「点了没反应」的高发区——
#   ① 窗口脚本里的 $("pp-xxx") 拿到 null（xhtml 里没这个 id）→ 静默什么都不做；
#   ② 把「段落成对 + 单一滚动容器」改成两个各自滚动的容器 → 左右对齐随内容高度漂走，
#      而且不报错（表现为「同步失效」，最难被人发现）；
#   ③ 窗口脚本直接调 AIClient/AIChat → 窗口作用域里根本没这两个全局，翻译永远不动；
#   ④ 单实例复用通道写歪（getEnumerator 名 vs xhtml windowtype）→ 每次点都开新窗；
#   ⑤ 新 pref 键没在 prefs.js 给默认值 → Prefs.get 拿到 undefined。
# 所以把「骨架 + 接线 + 语义」在这里静态钉死。
BL_XHTML = os.path.join(ROOT, "chrome", "content", "bilingual.xhtml")
BL_VIEW_JS = os.path.join(ROOT, "chrome", "content", "bilingual-view.js")
BL_MOD_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "bilingual-translate.js")
PPREFS_XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")

ok(os.path.exists(BL_XHTML), "17.1 双栏对照窗口 bilingual.xhtml 存在")
ok(os.path.exists(BL_VIEW_JS), "17.2 窗口脚本 bilingual-view.js 存在")
bl_xhtml = io.open(BL_XHTML, encoding="utf-8").read() if os.path.exists(BL_XHTML) else ""
bl_js = io.open(BL_VIEW_JS, encoding="utf-8").read() if os.path.exists(BL_VIEW_JS) else ""
bl_mod = io.open(BL_MOD_JS, encoding="utf-8").read()
menus_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read()
wb_js = io.open(os.path.join(ROOT, "chrome", "content", "workbench.js"), encoding="utf-8").read()
hub_js = io.open(os.path.join(ROOT, "chrome", "content", "hub.js"), encoding="utf-8").read()
pprefs_xhtml = io.open(PPREFS_XHTML, encoding="utf-8").read()

ok('windowtype="papilot:bilingual"' in bl_xhtml, "17.3 窗口 windowtype=papilot:bilingual")
ok("chrome://papilot/content/bilingual-view.js" in bl_xhtml, "17.4 窗口挂了窗口脚本")
ok('WINDOW_TYPE: "papilot:bilingual"' in bl_mod, "17.5 模块 WINDOW_TYPE 与 windowtype 一致")
ok("getEnumerator(this.WINDOW_TYPE)" in bl_mod, "17.6 单实例复用按同一常量枚举（名字不会写歪）")

# 17.7 窗口脚本引用的元素 id 必须都在 xhtml 里（§7 同款守卫）
bl_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', bl_xhtml))
bl_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', bl_js))
bl_refs |= set(re.findall(r'(?:setText|setLabel|getElementById)\(\s*"([A-Za-z0-9_-]+)"', bl_js))
bl_missing = sorted(i for i in bl_refs if i not in bl_ids)
ok(not bl_missing, "17.7 窗口脚本引用的元素 id 都存在于 bilingual.xhtml → 缺失: %s" % (bl_missing or "无"))

# 17.8~17.10 翻译链路必须回传（窗口作用域没有 AIClient/AIChat）
bl_code = re.sub(r"/\*[\s\S]*?\*/", "", bl_js)
bl_code = re.sub(r"(?m)//.*$", "", bl_code)
ok(not re.search(r"AIClient\s*\.|\bAIChat\b|Zotero\.HTTP|fetch\s*\(", bl_code),
   "17.8 窗口脚本不直连 AI/网络（去掉注释后无 AIClient/AIChat/Zotero.HTTP/fetch）")
ok("A.translateChunk(" in bl_js and "A.getFullText(" in bl_js and "A.makeNote(" in bl_js,
   "17.9 取全文/翻译/写笔记都走注入回调")
ok("translateChunk:" in bl_mod and "getFullText:" in bl_mod and "makeNote:" in bl_mod,
   "17.10 模块侧注入了 translateChunk/getFullText/makeNote")

# 17.11~17.16 布局语义：两栏等宽 + 单栏回退 + 单一滚动容器（行级同步的结构保证）
ok("grid-template-columns: 1fr 1fr" in bl_js, "17.11 两栏等宽（1fr 1fr）")
ok("grid-template-columns: 1fr;" in bl_js, "17.12 单栏回退为一列")
ok('setAttribute("data-cols"' in bl_js, "17.13 栏数经 data-cols 切换")
ok("MIN_TWO_COL_PX" in bl_js and 'addEventListener("resize"' in bl_js,
   "17.14 窄屏自动切单栏（宽度阈值 + resize 监听）")
ok("pp-bl-scroll" in bl_xhtml and "overflow-y:auto" in bl_xhtml,
   "17.15 单一滚动容器负责滚动（两栏不各自滚动）")
ok(len(re.findall(r"scrollTop\s*=", bl_js)) == 1,
   "17.16 只有一处 scrollTop 赋值（没有两栏互相追的同步逻辑）")

# 17.17~17.22 入口接线：三处指向双栏窗口，且原「双语笔记」出口保留
ok("PdfDual.openForSelected" in menus_js,
   "17.17 右键菜单主入口指向左原右译对照窗口（PdfDual，0.36.0）")
# 0.42.0：「文本双栏」右键入口撤掉（与对照翻译重叠），功能中心 Hub 仍可达 → 改验 hub.js
_hub_js_early = io.open(os.path.join(ROOT, "chrome", "content", "hub.js"), encoding="utf-8").read() \
    if os.path.exists(os.path.join(ROOT, "chrome", "content", "hub.js")) else ""
ok("BilingualTranslate.runForSelected()" not in menus_js and "bilingual" in _hub_js_early,
   "17.18 文本双栏右键入口已撤（0.42.0），功能中心仍可达")
ok("pdfDual.openForSelected" in wb_js, "17.19 工作台「全文对照翻译」chip 指向左原右译窗口")
ok("pdfDual.openForSelected" in hub_js, "17.20 功能中心卡片指向左原右译窗口")
ok("runForSelected()" in bl_mod, "17.21 原笔记流程仍在（未删）")
ok("openViewerForSelected" in bl_mod,
   "17.21b 旧「文本双栏」出口仍在模块里（0.36.0 起不再挂菜单，保留备用）")
ok("_noteMd(" in bl_mod, "17.22 笔记正文由共用函数生成（窗口导出与笔记出口零漂移）")

# 17.23~17.25 pref 默认值 + 设置面板可配
ok("bilingualViewFontSize" in prefsdef, "17.23 prefs.js 有 bilingualViewFontSize 默认值")
ok("bilingualViewLayout" in prefsdef, "17.24 prefs.js 有 bilingualViewLayout 默认值")
ok("bilingualViewFontSize" in pprefs_xhtml, "17.25 设置面板可配双栏窗口字号")

# 17.26~17.27 主题作用域
ok("papilot:bilingual" in uitheme_js, "17.26 双栏窗口纳入 ui-theme 主题作用域")
ok('wtype === "papilot:bilingual"' in uitheme_js, "17.27 ui-theme 的窗口判定含双栏窗口")

# 17.28~17.29 文案键
ok("menuBilingualView" in utils_js, "17.28 文案表有 menuBilingualView")
ok("blLayoutAuto" in utils_js and "blNoteDone" in utils_js, "17.29 双栏窗口文案键已入表")

# 17.30 门禁：窗口渲染测试进 preflight
_pf2 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("bilingual-view.test.js" in _pf2, "17.30 preflight 含双栏对照窗口渲染测试")

# ---------- 18. AI 计费计量与成本看板（服务端 1.5.0） ----------
PRICING_LIB = os.path.join(ROOT, "server", "lib", "pricing.js")
pricing_src = io.open(PRICING_LIB, encoding="utf-8").read()
BACKUP_LIB = os.path.join(ROOT, "server", "lib", "backup.js")
backup_src = io.open(BACKUP_LIB, encoding="utf-8").read()

# --- pricing.js：纯函数与口径 ---
for fn in ["normalize", "priceFor", "setModel", "removeModel", "usageOf", "costOf", "microText"]:
    ok(re.search(r"function %s\b" % fn, pricing_src) is not None, "18.1 pricing.js 定义 %s()" % fn)
ok("MICRO_PER_YUAN = 1e6" in pricing_src, "18.2 成本单位是微元（1e-6 元），避免小额被四舍五入抹平")
ok("MICRO_PER_CENT = 1e4" in pricing_src, "18.3 微元与分的换算常量存在")
# ★ 前缀匹配会让贵模型按便宜模型的价结算 —— 必须只做精确（含大小写不敏感）匹配
ok("刻意**不做前缀" in pricing_src or "不做前缀" in pricing_src,
   "18.4 ★ 明确不做前缀/模糊匹配（glm-5.3 不得吃掉 glm-5.3-flash 的价）")
ok("function usageOf" in pricing_src and "prompt_tokens" in pricing_src and "input_tokens" in pricing_src,
   "18.5 usage 解析兼容两种命名")
ok("if (!inTok && !outTok && !totalTok) return null" in pricing_src,
   "18.6 ★ 无有效 token 时返回 null（计量盲区），不冒充 0 成本")

# --- 服务端接入 ---
ok("require('./lib/pricing')" in srv, "18.7 服务端引入 pricing 模块")
ok("new JsonStore(path.join(DATA_DIR, 'pricing.json')" in srv, "18.8 pricing.json 独立存储")
ok("pricingStore.data = pricing.normalize(pricingStore.data)" in srv, "18.9 启动即归一化单价表")

# --- 网关计量 ---
ok("stream_options = Object.assign({}, upstreamBody.stream_options, { include_usage: true })" in srv,
   "18.10 流式自动注入 stream_options.include_usage（否则流式完全无法计费）")
ok("c.streamUsage !== false" in srv, "18.11 通道级可关掉注入（兼容不认该参数的上游）")
ok("const scanSse = (text) =>" in srv, "18.12 流式逐行扫描 usage")
ok("meterTail = meterTail.slice(-4096)" in srv, "18.13 ★ 流式扫描缓冲有界（不随响应体量增长）")
ok("const billModel = respModel || requestedModel;" in srv,
   "18.14 ★ 按「响应里的真实模型」计价（auto 会被上游解析成真名）")
ok("countUsage(user, { model: billModel, usage: respUsage, costMicro: cost ? cost.micro : 0 })" in srv,
   "18.15 计量信息落库（次数 + token + 成本）")
ok("if (!ok) { releaseOnce(); return; }" in srv,
   "18.16 上游 4xx 不计次（保持 1.4.x 旧口径；1.8.5 先释放预留）")
ok("plainSize > PLAIN_METER_MAX" in srv, "18.17 非流式响应体过大时放弃解析（保护内存）")

# --- 用量结构：旧字段不能被破坏 ---
ok("u.daily[d] = (Number(u.daily[d]) || 0) + 1;" in srv, "18.18 ★ daily 仍是 number（旧读取点零改动）")
ok("u.missingUsage += 1;" in srv, "18.19 ★ 无 usage 单独计入 missingUsage，不污染成本")
ok("u.byModel[key] = m;" in srv, "18.20 按模型累计")
ok("function usageTotalsIn" in srv and "function usageSeriesDays" in srv, "18.21 窗口合计/序列辅助函数")
ok("function costViewOf" in srv, "18.22 成本视图（微元 + 格式化文案）")
ok("cost: costViewOf(user)," in srv, "18.23 /api/auth/me 下发 cost（客户端可展示）")
ok("function usageSummary" in srv and "function pricingAdminOut" in srv, "18.24 看板与单价表视图函数")

# --- 看板必须暴露「未配价」而不是假装省钱 ---
ok("unconfigured: usedModels.filter((x) => !x.configured)" in srv,
   "18.25 ★ 单价表视图列出「被调用过但未配价」的模型")
ok("suspectUnpriced: t.costMicro === 0 && (t.inTok + t.outTok) > 0" in srv,
   "18.26 ★ 窗口内有调用却 0 成本 → 标疑未配价")

# --- 管理端点 ---
ok("url === '/api/admin/pricing' && method === 'GET'" in srv, "18.27 GET /api/admin/pricing 存在")
ok("url === '/api/admin/pricing' && method === 'PUT'" in srv, "18.28 PUT /api/admin/pricing 存在")
ok("url === '/api/admin/usage-summary' && method === 'GET'" in srv, "18.29 GET /api/admin/usage-summary 存在")
ok("function queryOf" in srv, "18.30 查询参数解析（days=）")

# --- health ---
ok("version: '1.9.2'" in srv, "18.31 服务端版本号已随批次更新（1.9.2）")
ok("pricedModels: pricing.modelList(pricingStore.data).length" in srv, "18.32 health 暴露已配价模型数")
ok("meteringGaps:" in srv, "18.33 health 暴露计量盲区累计")

# --- 审计（两处都要有） ---
ok("'pricing.update'" in audit_src, "18.34 audit.js 动作表含 pricing.update")
ok("'pricing.update'" in ps, "18.35 launcher 的 Get-AuditText 也含 pricing.update")

# --- 快照 / 回滚 ---
ok("'pricing.json'" in backup_src, "18.36 单价表纳入数据快照（可回滚）")
ok("pricingStore.reload();" in srv, "18.37 reloadStores 一并重载单价表（回滚后内存同步）")

# --- Web 管理页 ---
for k in ["tab-cost", "pane-cost", "cost-total", "cost-price-body", "mp-model", "cost-days",
          "cost-unpriced", "cost-model-body", "cost-user-body", "cost-day-body"]:
    ok(k in html, "18.38 admin.html 含 %s" % k)
ok("loadCostTab" in html and "loadPricing" in html and "saveModelPrice" in html,
   "18.39 管理页成本页函数齐备")
ok("'/api/admin/usage-summary?days='" in html, "18.40 管理页调用成本看板接口")
ok("'/api/admin/pricing'" in html, "18.41 管理页调用单价表接口")
ok("if (feedback) msg('cost-msg', feedback, true);" in html,
   "18.42 ★ 反馈写在渲染之后（否则会被本轮刷新重置掉）")

# ★★ 18.43 管理页内联脚本不得有重名函数
#    同作用域下重复声明会**静默**用后者覆盖前者（本次新增成本页时 savePrice/delPrice
#    就与既有价格表函数撞名），前端无任何报错，只表现为某个功能「点了没反应/改错地方」。
_admin_js = re.findall(r"<script>(.*?)</script>", html, re.S)
if _admin_js:
    _names = re.findall(r"^function\s+(\w+)", _admin_js[-1], re.M)
    _dups = sorted(set([n for n in _names if _names.count(n) > 1]))
    ok(not _dups, "18.43 ★ admin.html 内联脚本无重名函数" + ("" if not _dups else "（重名：%s）" % ",".join(_dups)))
    # 18.44 onclick 引用的函数必须都已定义（否则是「点了没反应」的头号成因）
    _called = set(re.findall(r'onclick="(\w+)\(', html)) | set(re.findall(r"onclick=\"(\w+)\(", _admin_js[-1]))
    _missing = sorted([c for c in _called if c not in _names and c not in
                       ("location", "alert", "confirm")])
    ok(not _missing, "18.44 ★ admin.html 的 onclick 引用都已定义" + ("" if not _missing else "（缺：%s）" % ",".join(_missing)))
else:
    ok(False, "18.43 admin.html 应有内联脚本")

# ★★ 18.43b DOM id 不得重复
#    `$('x')` 只取第一个匹配。重复 id 会让 getElementById 永远命中旧元素，
#    表现为「新表单填了没反应 / 保存的是别的表单的值」——前端零报错。
#    本次新增成本页时 cost 页的 cp-note 与优惠券页撞 id，直接让后台 E2E 超时。
_ids = re.findall(r'\bid="([^"]+)"', html)
_dupid = sorted(set([k for k in _ids if _ids.count(k) > 1]))
ok(not _dupid, "18.43b ★ admin.html 无重复 DOM id" + ("" if not _dupid else "（重复：%s）" % ",".join(_dupid)))

# --- 门禁接入 ---
_pf3 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/pricing.test.js" in _pf3, "18.45 preflight 含 AI 计费单价测试")
ok("test/metering.test.js" in _pf3, "18.46 preflight 含网关计量测试")
ok("test/ai-auth-failure.test.js" in _pf3, "18.47 preflight 含官方通道401判别测试")

# --- 18.48 上游 401 不透传（1.8.x 修复，根因见下） ---
# 起因：服务端网关把上游通道（Prism 等）的 401 原样透传给插件；插件把官方网关的
# 任何 401 视为「账号令牌失效」并清除本地会话 → 上游密钥一失效，用户切个模型就
# 表现为「整个插件掉登录、无法使用」。修复 = 服务端 401/403 翻译为 502 + 客户端
# 只认「登录已过期」应答体才清会话，双保险。
_srv3 = io.open(os.path.join(ROOT, "server", "account-server.js"), encoding="utf-8").read()
ok("UPSTREAM_AUTH" in _srv3 and "上游模型通道鉴权失败" in _srv3,
   "18.48 ★ 网关把上游 401/403 翻译为 502 UPSTREAM_AUTH（不透传）")
_cli3 = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "client.js"), encoding="utf-8").read()
ok(re.search(r'_maybeAuthFailure\(status, bodyText\)', _cli3) is not None
   and 'indexOf("登录已过期")' in _cli3,
   "18.49 ★ 客户端仅应答体含「登录已过期」才清会话")
ok("authfail-model" in io.open(os.path.join(ROOT, "test", "metering.test.js"), encoding="utf-8").read(),
   "18.50 计量测试覆盖上游 401 场景")

# ---------- 19. 余额域（服务端 1.6.0：注册赠送 / 充值 / 按成本扣减） ----------
BAL_LIB = os.path.join(ROOT, "server", "lib", "balance.js")
bal_src = io.open(BAL_LIB, encoding="utf-8").read()

for fn in ["normalizeCfg", "ensure", "sweep", "grantSignup", "adminAdjust", "consume", "precheck", "userView", "adminView"]:
    ok(re.search(r"function %s\b" % fn, bal_src) is not None, "19.1 balance.js 定义 %s()" % fn)
ok("signupGrantMicro: 6 * pricing.MICRO_PER_YUAN" in bal_src, "19.2 默认注册赠送 ¥6（用户决策）")
ok("signupValidDays: 30" in bal_src, "19.3 赠送默认 30 天有效（防批量注册囤积）")

# ★ 铁律：钱不过期，赠品才过期 —— paidMicro 没有任何到期机制
ok("grantedExpiresAt" in bal_src and "paidExpiresAt" not in bal_src,
   "19.4 ★ 充值余额无到期字段（钱不过期，赠品才过期）")
# ★ 透支不得被读取路径消毒成 0（曾因 ensure 用非负夹取把欠费清零，测试揪出）
ok("b.paidMicro = signedMicro(b.paidMicro);" in bal_src, "19.5 ★ ensure 保留负的充值余额（透支如实）")
ok("micro(b.grantedMicro, 0)" in bal_src, "19.6 赠送余额仍非负（过期由 sweep 清零）")
# ★ precheck 必须先看 enforce（曾漏判，把观察模式变成拦截）
ok("if (!c.enforce) return { allowed: true" in bal_src, "19.7 ★ 观察模式（enforce=false）恒放行")
# ★ 高级模型：注册赠送不算数，且必须有订阅额度/充值（阈值 0 时不能放行 0 额度用户）
ok("const okPaid = avail > 0 && avail >= c.minBalanceMicro;" in bal_src,
   "19.8 ★ 高级模型要求订阅额度+充值过阈值且 > 0（注册赠送限基础模型）")
# ★ 订阅额度：不结转 —— 只认期号，本期发过就不再补（否则"花完自动续杯"）
ok("if (b.planPeriodKey === key) {" in srv and "balance.extendPlanExpiry(user, grantEnd, t)" in srv,
   "19.8b ★ 订阅额度只按期号判重（花完不补）；续费只延长有效期，不重复发钱")
ok("'BALANCE_REQUIRED_FOR_HIGH_TIER'" in bal_src, "19.9 高级模型拦截有独立 code")
ok("'INSUFFICIENT_BALANCE'" in bal_src, "19.10 余额不足拦截有可编程 code")
ok("自带 Key 不受额度限制" in bal_src, "19.11 拦截文案给「充值 / 自有 Key」两条出路")

# --- 服务端接线 ---
ok("require('./lib/balance')" in srv, "19.12 服务端引入 balance 模块")
ok("balance.normalizeCfg(pricingStore.data)" in srv, "19.13 启动归一化余额配置")
ok("balance.grantSignup(user, balanceCfg())" in srv, "19.14 注册自动赠送")
ok("const gate = balance.precheck(user, balanceCfg(), { highTier: isHighTier });" in srv,
   "19.15 网关 pre-check（在 auto 解析之后，高级判定才准确）")
ok("return json(res, 402, { ok: false, code: gate.code" in srv, "19.16 余额不足 → 402（非 429，语义独立）")
ok("settleOnce(cost ? cost.micro : 0" in srv and "balance.settleHold(" in srv,
   "19.17 网关按真实成本结算（1.8.5 预留制：settleHold 替代直接 consume）")
# 用位置关系断言顺序（正则跨多行块太脆）：扣减必须先于 countUsage，
# 借 countUsage 内部的 usersStore.save() 把余额变动一并落盘
_consume_pos = srv.find("settleOnce(cost ? cost.micro")
_count_pos = srv.find("countUsage(user, { model: billModel")
ok(_consume_pos >= 0 and _count_pos >= 0 and _consume_pos < _count_pos,
   "19.18 ★ 结算在 countUsage 之前（同一快照落盘：余额与用量原子）")
ok("balance: balance.userView(user, balanceCfg())," in srv, "19.19 /api/auth/me 下发 balance")
ok("balance: balance.adminView(u)," in srv, "19.20 管理端用户视图带余额")
ok("/balance$/" in srv, "19.21 管理端充值/调账路由存在（/balance）")
ok("input.balance && typeof input.balance === 'object'" in srv, "19.22 PUT /api/admin/pricing 接受 balance 配置块")
ok("balanceEnforce: balanceCfg().enforce" in srv, "19.23 health 暴露 enforce 状态")
ok("version: '1.9.2'" in srv, "19.24 服务端版本随批次推进（1.9.2）")

# --- 审计（两处都要有） ---
ok("'balance.adjust'" in audit_src, "19.25 audit.js 动作表含 balance.adjust")
ok("'balance.adjust'" in ps, "19.26 launcher 的 Get-AuditText 也含 balance.adjust")

# --- Web 管理页（余额 UI） ---
for k in ["bl-enforce", "bl-grant", "bl-valid", "bl-min", "u-bal", "u-bal-delta"]:
    ok(k in html, "19.27 admin.html 含 %s" % k)

# --- 1.6.0 管理页补充：订阅额度 / 充值档位 / 权益文案 ---
for k in ["p-pro-grant", "p-free-grant", "bl-opts", "p-free-feats", "p-pro-feats"]:
    ok(k in html, "19.28 admin.html 含 %s" % k)
ok("monthlyGrantMicro: Math.round((Number($('p-pro-grant').value) || 0) * 1e6)" in html,
   "19.29 ★ 套餐表单提交每月订阅额度（元 → 微元）")
ok("features: readFeatures('p-pro-feats')" in html,
   "19.30 ★ 权益文案可在后台编辑（否则权益说明只能靠 API 改）")
ok("rechargeOptions: readRechargeOptions()" in html, "19.31 充值档位随余额配置一并提交")
ok("function applyOrderFulfill(order, by) {" in srv, "19.32 ★ 核销副作用唯一入口存在")
ok(srv.count("applyOrderFulfill(") >= 3, "19.33 ★ 手动核销与对账核销共用同一入口（防副作用逻辑漂移）")
ok("membership.createCreditOrder(" in srv, "19.34 服务端接入充值下单")

# --- 门禁接入 ---
ok("test/balance.test.js" in _pf3, "19.28 preflight 含余额域测试")

# ---------- 20. 插件端余额展示与充值（0.26.0） ----------
ACCT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js")
acct_js = io.open(ACCT_JS, encoding="utf-8").read()
PREFS_CSS = os.path.join(ROOT, "chrome", "content", "prefs.css")
prefs_css = io.open(PREFS_CSS, encoding="utf-8").read()
MANIFEST = io.open(os.path.join(ROOT, "manifest.json"), encoding="utf-8").read()

ok(re.search(r"^  balance\(\) \{", acct_js, re.M) is not None, "20.1 account.js 定义 balance() 访问器")
ok('if (!b || typeof b !== "object") return null;' in acct_js,
   "20.2 ★ 旧服务端无 balance → 返回 null（面板整块隐藏，不显示假数据）")
ok("async createCreditOrder(optionId)" in acct_js, "20.3 account.js 提供充值下单")
ok("rechargeOptions: Array.isArray(j.rechargeOptions) ? j.rechargeOptions : []" in acct_js,
   "20.4 plans() 透出充值档位（旧服务端为空数组）")
ok("overdraft: num(b.paidMicro) < 0" in acct_js, "20.5 透支状态透出给面板（不静默）")

for fn in ["renderBalance", "renderBalOptions", "ensureRechargeOptions", "onBalCreate",
           "renderBalPay", "onBalClaim", "onBalPoll", "onBalCancel", "onBalRefresh"]:
    ok(re.search(r"function %s\b" % fn, prefs_js) is not None, "20.6 prefs-account.js 定义 %s()" % fn)
ok("try { renderBalance(); } catch (e)" in prefs_js, "20.7 renderAll 纳入 renderBalance（并自带 try）")
ok("stopBalPolling(); // 充值订单轮询同理" in prefs_js, "20.8 面板关闭停掉充值订单轮询（定时器不泄漏）")
ok("bind(\"pp-bal-create\", \"click\", onBalCreate)" in prefs_js, "20.9 充值按钮已绑定")

for eid in ["pp-bal-block", "pp-bal-total", "pp-bal-detail", "pp-bal-note",
            "pp-bal-recharge-toggle", "pp-bal-recharge", "pp-bal-options",
            "pp-bal-create", "pp-bal-pay", "pp-bal-pay-info", "pp-bal-claim",
            "pp-bal-poll", "pp-bal-cancel", "pp-bal-refresh"]:
    ok(eid in xhtml_ids, "20.10 prefs.xhtml 含 #%s" % eid)
ok(".pp-root .pp-bal {" in prefs_css, "20.11 prefs.css 有 .pp-bal 样式")

# 0.38.3 起改为**自洽校验**：manifest 版本必须等于 dist/ 里最新 xpi 的版本号
# （早先钉死字面量，每发一版都要手改这里，改漏就假红/过时）。
def _latest_dist_version():
    d = os.path.join(ROOT, "dist")
    vs = []
    try:
        for f in os.listdir(d):
            m = re.match(r"papilot-(\d+\.\d+\.\d+)\.xpi$", f)
            if m:
                vs.append(tuple(int(x) for x in m.group(1).split(".")))
    except OSError:
        pass
    if not vs:
        return None
    return ".".join(str(x) for x in max(vs))


_mf_ver = (re.search(r'"version"\s*:\s*"([^"]+)"', MANIFEST) or [None, ""])[1]
_dist_ver = _latest_dist_version()
ok(bool(_mf_ver) and _mf_ver == _dist_ver,
   "20.12 manifest 版本与 dist 最新产物一致（%s / %s）" % (_mf_ver, _dist_ver))
ok("J14 ★ 旧服务端无 balance → 整块隐藏" in io.open(os.path.join(TEST_DIR, "membership-panel.test.js"), encoding="utf-8").read(),
   "20.13 面板测试含余额用例（旧服务端隐藏 + 三档展示 + 充值下单）")

# ---------- 21. 在线支付（服务端 1.7.0：易支付/码支付接入） ----------
PAY_LIB = os.path.join(ROOT, "server", "lib", "pay.js")
SB_LIB = os.path.join(ROOT, "server", "lib", "secretbox.js")
pay_src = io.open(PAY_LIB, encoding="utf-8").read()
sb_src = io.open(SB_LIB, encoding="utf-8").read()
bk_src = io.open(os.path.join(ROOT, "server", "lib", "backup.js"), encoding="utf-8").read()

for fn in ["newCfg", "sanitizeCfg", "isReady", "adminOut", "buildSign", "verifySign",
           "rsaSign", "rsaVerify", "verifyNotify", "newTradeNo", "createPayUrl",
           "queryOrder", "testConnection", "checkKeys"]:
    ok(re.search(r"^(?:async )?function %s\b" % fn, pay_src, re.M) is not None, "21.1 pay.js 定义 %s()" % fn)

# ★ 本仓库服务端声明支持 Node ≥14：不得用全局 fetch（医疗项目原实现用了，这里必须换掉）
ok(pay_src.count("mod.request(") >= 1 and "? https : http" in pay_src,
   "21.2 ★ 用原生 http/https 模块按协议选传输（不依赖全局 fetch）")
ok("fetch(" not in pay_src, "21.3 ★ pay.js 里没有裸 fetch 调用")
ok("timingSafeEqual" in pay_src, "21.4 MD5 验签用定长比对（防时序侧信道）")
ok("NOTIFY_OK = 'success'" in pay_src and "NOTIFY_FAIL = 'fail'" in pay_src,
   "21.5 回调应答常量（协议要求收 success 才停止重试）")
ok("/^[A-Za-z0-9]+$/" in io.open(os.path.join(TEST_DIR, "pay.test.js"), encoding="utf-8").read(),
   "21.6 商户订单号纯字母数字有测试守（网关只收字母数字）")
ok("deep" in pay_src and "0.01" in pay_src,
   "21.7 深度自检会探一笔 0.01 元测试单，且**默认关闭**（由管理员显式触发）")

# 加密盒子
ok("aes-256-gcm" in sb_src, "21.8 secretbox 用 AES-256-GCM")
ok(".secret.key" in sb_src, "21.9 主密钥独立文件（不进备份）")
ok("  } catch (e) {\n    return null;\n  }" in sb_src, "21.10 ★ 解密失败返回 null（不抛异常上去）")
# ★ 密钥文件与支付配置都不能进快照：回滚把它们换成旧的，是「改钱」级意外
ok("pay.json" not in bk_src, "21.11 ★ pay.json 不在备份文件清单里")
ok(".secret" not in bk_src, "21.12 ★ 主密钥不进备份（备份被拿走也解不开商户密钥）")

# 服务端接线
ok("require('./lib/pay')" in srv and "require('./lib/secretbox')" in srv, "21.13 服务端引入 pay/secretbox")
ok("const payStore = new JsonStore(path.join(DATA_DIR, 'pay.json')" in srv, "21.14 支付配置存 pay.json")
ok("payStore.data = pay.sanitizeCfg(payStore.data);" in srv, "21.15 启动归一化支付配置")
for fn in ["payCfg", "siteBaseUrl", "onlinePayReady", "fulfillByGateway", "payReturnHtml"]:
    ok(re.search(r"^function %s\b" % fn, srv, re.M) is not None, "21.16 服务端定义 %s()" % fn)
# ★ notify_url 不能按 Host 头推断（公网请求可伪造 Host，会把回调指向攻击者域名）
ok("process.env.PP_PUBLIC_URL" in srv and "/^https:\\/\\//i.test(siteBaseUrl())" in srv,
   "21.17 ★ 回调地址用 PP_PUBLIC_URL 显式配置，且要求 https")
ok("secretbox.encrypt(DATA_DIR," in srv, "21.18 商户密钥加密后落盘")
ok("next.keyEnc = k ? secretbox.encrypt(DATA_DIR, k) : '';" in srv,
   "21.19 密钥三态：非空=保存 / 空串=清除 / 未提交=保持")

# ★ notify 是公开路由：必须在 isLocalAdmin 守卫**之前**注册（网关从公网来，永不来自回环）
_i_guard = srv.find("if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理接口仅限本机调用' });")
_i_notify = srv.find("url === '/api/pay/notify'")
ok(_i_guard > 0 and _i_notify > 0 and _i_notify < _i_guard,
   "21.20 ★ 回调路由注册在管理守卫之前（否则公网网关打不进来 → 支付全部不到账）")

# 五重校验 + 幂等履约
_notify_body = srv[_i_notify:_i_notify + 2600] if _i_notify > 0 else ""
for probe, label in [("pay.verifyNotify(cfg, q)", "验签"), ("!== cfg.pid", "商户号比对"),
                     ("TRADE_SUCCESS", "交易状态"), ("amount_mismatch", "金额比对（防少付）"),
                     ("fulfillByGateway(order", "幂等履约")]:
    ok(probe in _notify_body, "21.21 回调校验：%s" % label)
ok("res.end(pay.NOTIFY_FAIL)" in _notify_body and "res.end(pay.NOTIFY_OK)" in _notify_body,
   "21.22 回调应答用固定 'fail'/'success'（不泄露拒绝原因）")
ok(srv.count("fulfillByGateway(") >= 3,
   "21.23 ★ 回调与主动查单共用同一履约入口（副作用不漂移）")
ok("applyOrderFulfill(order, source || 'gateway')" in srv,
   "21.24 支付履约复用既有唯一入口 applyOrderFulfill")

# 订单模型
mem_src = io.open(os.path.join(ROOT, "server", "lib", "membership.js"), encoding="utf-8").read()
ok("outTradeNo: ''," in mem_src and "function findOrderByTradeNo" in mem_src,
   "21.25 订单带 outTradeNo + 可按商户订单号反查")
ok("tradeNo: ''" in mem_src and "paidAt: null" in mem_src, "21.26 订单记录网关交易号与支付时间")

# 审计（三处）
ok("'order.pay'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read()
   and "'pay.config'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read(),
   "21.27 audit.js 含 order.pay / pay.config")
ok("'order.pay'" in ps and "'pay.config'" in ps, "21.28 launcher 的 Get-AuditText 同步两份文案")

# 客户端契约与后台
ok("onlinePay: onlinePayReady()" in srv, "21.29 health 暴露 onlinePay")
ok("onlinePay: onlinePayReady()" in srv and "'/api/plans'" in srv, "21.30 /api/plans 暴露 onlinePay 可用性")
for k in ["pay-enabled", "pay-provider", "pay-gateway", "pay-pid", "pay-key", "pay-test", "pay-msg"]:
    ok(k in html, "21.31 admin.html 含 %s" % k)

ok("version: '1.9.2'" in srv, "21.32 服务端版本 1.9.2")
ok("test/pay.test.js" in _pf3, "21.33 preflight 含在线支付测试")

# ---------- 22. 多引擎翻译（插件 0.28.0） ----------
# 起因：翻译从「只能走 AI 大模型」扩为「多引擎注册表」。这类改造有三类静默失败：
#   ① 引擎注册表加了新厂商，但装配/暴露/设置脚本漏了一处 → 界面上看不到、或选了不生效；
#   ② 消费方（浮窗/对照/标题摘要/对比整页）漏改一处 → 有的地方仍强绑 AI，未登录就废；
#   ③ 语言/密钥这类「契约数据」在模块与设置界面之间对不上 → 选了引擎却发不出请求。
TRANSLATE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "translate.js")
PREFS_TRANSLATE_JS = os.path.join(ROOT, "chrome", "content", "prefs-translate.js")
# 0.73.0 重构：原单一 translate.js（1940 行，语言/术语表/公式/签名/注册表/配置/运行时
# 八种职责混合）拆为「5 个子模块 + 门面」。下列内容守卫仍按**模块整体**断言 ——
# tr_js = 按装配顺序拼接的 6 文件源码（函数归属哪个物理文件不影响行为契约）。
TRANSLATE_PARTS = ["translate-lang.js", "translate-crypto.js", "translate-glossary.js",
                   "translate-formula.js", "translate-engines.js", "translate.js"]
def _read_translate_module():
    _buf = []
    for _p in TRANSLATE_PARTS:
        _fp = os.path.join(ROOT, "chrome", "content", "scripts", "ai", _p)
        _buf.append(io.open(_fp, encoding="utf-8").read() if os.path.exists(_fp) else "")
    return "\n".join(_buf)
tr_js = _read_translate_module()
trp_js = io.open(PREFS_TRANSLATE_JS, encoding="utf-8").read()

ok('"ai/translate.js"' in mainjs, "22.1 main.js 装配清单含 ai/translate.js")
ok("this.translateSvc = TranslateSvc;" in mainjs, "22.2 main.js 把 TranslateSvc 挂到 Zotero.Papilot")
ok("TranslateSvc.migrate();" in mainjs, "22.3 启动时执行翻译配置一次性迁移")
ok('"chrome/content/prefs-translate.js"' in mainjs, "22.4 设置面板注册 prefs-translate.js 脚本")

for _sid in ["google", "googleapi", "bing", "edge", "youdao", "transmart", "mymemory",
             "libretranslate", "lingva", "deeplx", "deepl", "microsoft", "baidu",
             "tencent", "caiyun", "llm"]:
    ok(('id: "%s"' % _sid) in tr_js, "22.5 引擎注册表含 %s" % _sid)
ok("CFG_DEFAULTS" in tr_js and "fallback" in tr_js, "22.6 有回退链默认配置")
ok("function hmacSha1" in tr_js and "function googleTk" in tr_js,
   "22.7 自实现 HMAC-SHA1（腾讯云签名）与 Google tk 签名")
ok("function normalizeLang" in tr_js, "22.8 语言归一化入口")
ok("function buildEndpoint" in tr_js and "function extractResult" in tr_js,
   "22.9 请求构造/响应解析拆成纯函数（可离线单测）")
# ★ 默认活动引擎必须是 llm：老用户升级后行为不变（否则翻译质量会无声变化）
ok('active: "llm"' in tr_js, "22.10 ★ 默认活动引擎为 AI 大模型（向后兼容）")
ok("function available()" in tr_js, "22.11 提供 available() 供上层判定「翻译是否可用」")

# 消费方：四处都要走 TranslateSvc，且对照翻译要脱离 AIClient.chat 直连
rp_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js"),
                encoding="utf-8").read()
bl_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "bilingual-translate.js"),
                encoding="utf-8").read()
ch_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "chat.js"),
                encoding="utf-8").read()
pc_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-compare.js"),
                encoding="utf-8").read()
ok("TranslateSvc.available()" in rp_js, "22.12 划词浮窗按引擎可用性放行翻译")
ok("opts && opts.svc" in rp_js, "22.13 划词浮窗翻译支持专用引擎路径")
ok("TranslateSvc.translate(chunk" in bl_js, "22.14 全文对照翻译走 TranslateSvc")
_bl_chunk = bl_js.split("_translateChunk(chunk, lang)")[1].split("_titleOf(")[0] if "_translateChunk(chunk, lang)" in bl_js else ""
ok("AIClient.chat(" not in _bl_chunk, "22.15 ★ 对照翻译的分段翻译不再直连 AIClient.chat")
ok("TranslateSvc.translate(meta.title" in ch_js, "22.16 标题摘要翻译走 TranslateSvc")
ok("TranslateSvc.translate(text" in pc_js, "22.17 对比窗口整页翻译走 TranslateSvc")

# pref 默认值与设置界面
ok('papilot.readerPopupTargetLang", "zh-CN"' in prefsdef, "22.18 目标语言默认规范码 zh-CN")
for _k in ["translateFromLang", "translateCfg", "translateMigrated28"]:
    ok(("papilot.%s" % _k) in prefsdef, "22.19 prefs.js 含 %s 默认值" % _k)
for _k in ["pp-tr-status", "pp-tr-active", "pp-tr-from", "pp-tr-to", "pp-tr-fallback",
           "pp-tr-timeout", "pp-tr-retry", "pp-tr-cache", "pp-tr-list", "pp-tr-test-result",
           "pp-tr-route", "pp-tr-total", "pp-tr-cooldown", "pp-tr-local-scan", "pp-tr-local"]:
    ok(_k in xhtml_ids, "22.20 prefs.xhtml 含 #%s" % _k)
_trp_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', trp_js))
_trp_used |= set(re.findall(r'bind\("([A-Za-z0-9_-]+)"', trp_js))
_trp_missing = sorted(i for i in _trp_used if i not in xhtml_ids)
ok(not _trp_missing,
   "22.21 prefs-translate.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_trp_missing or "无"))
ok("test/translate.test.js" in _pf3, "22.22 preflight 含翻译引擎测试")

# ---- 22.23~22.34：0.31.0 引擎补强（免密钥 Edge / 单次上限分段 / prepare 修复 / 额度说明）----
# 起因：① bing 依赖 prepare 取页面 token，而 prepare 只声明、从未被调用 → 该引擎必然失败；
#      ② MyMemory 单次上限是 500 **UTF-8 字节**（不是 500 字符），我们按字符分段 → 长句必失败；
#      ③ 免密钥阵营缺一个"语种最全又稳定"的引擎（必应网页版易 429）。
ok('id: "edge"' in tr_js, "22.23 新增免密钥 edge 引擎（必应/Edge）")
ok("edge.microsoft.com/translate/auth" in tr_js, "22.24 ★ edge 走官方 token 端点取临时票据")
ok("api-edge.cognitive.microsofttranslator.com" in tr_js, "22.25 ★ edge 走微软 v3 接口（非网页逆向）")
ok('"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)' in tr_js,
   "22.26 edge 携带 Edge UA（该接口对 UA 敏感）")
ok("if (typeof svc.prepare === \"function\" && !ctx.pre)" in tr_js,
   "22.27 ★★ prepare 真正被调用（此前只声明未调用 → bing 引擎失效）")
ok("ctx = Object.assign({}, ctx, { pre: await svc.prepare(ctx) });" in tr_js,
   "22.28 prepare 整次调用只做一次（多段复用同一 token）")
ok("function _splitText" in tr_js, "22.29 长文本分段纯函数存在")
ok("splitText: _splitText, segmentsFor: _segmentsFor" in tr_js, "22.30 分段函数已导出（可单测）")
ok("limits: { bytes: 500 }" in tr_js, "22.31 ★ MyMemory 声明 500 字节上限（官方是字节不是字符）")
ok("limits: { chars: 1000 }" in tr_js, "22.32 必应网页版声明 1000 字符上限")
ok("SEG_MAX" in tr_js, "22.33 分段数上限保护（避免退化成上百次串行请求）")
ok("s.hint" in trp_js, "22.34 设置面板渲染引擎自带的使用说明（额度/申请方式）")

# ---- 22.35~22.46：0.31.0 P1（回退链调度三件套 + Lingva/TranSmart）----
# 起因：只有"重试一次 + 依次回退"，缺**冷却**与**总预算**——一次网络抖动会把整条链跑满，
#      表现为"翻译转半天然后失败"；另外免密钥阵营缺"自建即无限流"的 Google 质量后端，
#      以及中文方向强的免密钥引擎。
ok("function _markCooldown" in tr_js and "function _inCooldown" in tr_js,
   "22.35 ★ 实现失败冷却（刚失败的引擎短时间内不再用）")
ok("clearCooldown, cooldownLeft," in tr_js, "22.36 冷却状态可查询/可清除（测试与界面都需要）")
ok("routeMs: 20000" in tr_js and "totalMs: 45000" in tr_js and "cooldownMs: 60000" in tr_js,
   "22.37 预算三件套有默认值（单路 20s / 总 45s / 冷却 60s）")
ok("chain = cands.filter((id) => {" in tr_js, "22.38 translate() 会跳过冷却中的引擎")
ok("if (!o.engine && c.cooldownMs > 0)" in tr_js,
   "22.39 ★ 显式指定 engine 时不受冷却影响（尊重调用方意图）")
ok("if (c.totalMs > 0 && c.totalMs - spent < 2000)" in tr_js,
   "22.40 总预算不足时停止整条链（而不是继续试下一个）")
ok("budget = Math.min(budget, c.routeMs);" in tr_js, "22.41 单路预算会压到该引擎的调用预算上")
ok("_markCooldown(id, c.cooldownMs);" in tr_js, "22.42 引擎失败后自动进入冷却")
ok("cooled," in tr_js and "detail:" in tr_js, "22.43 结果里回报「被跳过的引擎」与逐条原因明细")
ok("https://transmart.qq.com/api/imt" in tr_js and '"auto_translation"' in tr_js,
   "22.44 新增 TranSmart 引擎（免密钥，腾讯交互翻译）")
ok("transmart.qq.com/api/imt" in tr_js and "\"Origin\": \"https://transmart.qq.com\"" in tr_js,
   "22.45 TranSmart 带 Origin/Referer（网页接口要求）")
ok('"zh_HANT"' in tr_js and "/api/v1/" in tr_js,
   "22.46 新增 Lingva 引擎（REST /api/v1/，繁中用 zh_HANT）")
ok("translateFallbackUpgraded" in prefsdef, "22.47 prefs.js 含回退链升级迁移标记")
ok("translateFallbackUpgraded" in tr_js, "22.48 迁移逻辑只升级「从未自定义过」的回退链")

# ---- 22.49~22.57：0.31.0 P2（自建一键可用 + 隐私提示 + 引擎分组）----
# 起因：「自建离线」在调研里是 P3，但真正挡住用户的是"要自己记 5000/3000/1188 端口"；
#      把它做成一次探测 + 一键填入，P3 就不需要新增任何引擎也能落地。
#      另外：免密钥引擎会把文本发给第三方，学术场景必须如实告知（此前界面里没有任何提示）。
ok("probeLocal, LOCAL_PROBES," in tr_js, "22.49 自建服务探测已导出（设置面板与测试都用）")
ok("const LOCAL_PROBES = [" in tr_js, "22.50 定义本机候选服务清单")
for _e, _p in [("libretranslate", 5000), ("lingva", 3000), ("deeplx", 1188)]:
    ok(('engine: "%s"' % _e) in tr_js and ("port: %d" % _p) in tr_js,
       "22.51 探测 %s（默认端口 %d）" % (_e, _p))
ok('"http://127.0.0.1:" + p.port' in tr_js, "22.52 只探本机回环地址（不对外网扫描）")
ok("probeLocal(2000)" in trp_js, "22.53 设置面板发起探测（2s 超时，不卡界面）")
ok("S.setSecret(f.engine, { url: f.url })" in trp_js, "22.54 ★ 探测结果一键填入该引擎地址")
ok("onLocalScan" in trp_js and 'bind("pp-tr-local-scan", "click", onLocalScan)' in trp_js,
   "22.55 「检测本机自建服务」按钮已接线")
ok("catOf" in trp_js and "完全免配置" in trp_js and "需自备密钥" in trp_js,
   "22.56 引擎列表按「免配置 / 需地址 / 需密钥 / AI」分组")
ok("数据去向" in prefs_xhtml and "不出本机" in prefs_xhtml,
   "22.57 ★ 界面明确提示数据去向（免密钥引擎会把文本发给第三方）")

# ---- 22.58~22.66：0.31.0 界面改版（折叠式布局 + 测试按钮反馈修复）----
# 起因：16 个引擎平铺 + 每行密钥表单/说明 → "界面过于杂乱"；
#      而「测试」按钮的结果只写进卡片底部那个共用结果区，它在十几行之后 ——
#      用户点了按钮，反馈出现在屏幕外、按钮又飞快复原，观感就是"测试没反应"。
ok("COMMON_ENGINES" in trp_js and "COMMON_MAX" in trp_js, "22.58 定义「常用引擎」集合与上限")
ok("let showAllEngines = false;" in trp_js, "22.59 ★ 默认收起（只显示常用引擎）")
ok("function commonIds(" in trp_js and "commonIds(ov, S)" in trp_js,
   "22.60 常用集合 = 活动引擎 + 回退链 + 内置常用（去重后限上限）")
ok('showAllEngines = !showAllEngines;' in trp_js and "renderList();" in trp_js,
   "22.61 展开/收起按钮只重建列表（不整卡重渲染）")
ok("展开全部 " in trp_js and "收起，只看常用" in trp_js, "22.62 按钮文案含引擎总数与当前状态")
ok("pp-tr-more" in trp_js, "22.63 收起时提示「已收起 N 个」")
ok("onTest(s.id, bTest, rowMsg)" in trp_js, "22.64 ★ 测试结果写到**该行内**的元素上")
ok('class: "pp-tr-rowmsg"' in trp_js, "22.65 引擎行带行内结果位")
ok("msgEl.textContent = text" in trp_js and "setMsg(text, color);" in trp_js,
   "22.66 行内与底部双写（反馈不再跑到屏幕外）")
ok("test/prefs-translate.test.js" in _pf3, "22.67 preflight 含翻译设置面板测试")

# ---- 22.68~22.74：0.73.0 翻译模块拆分（单一巨石 → 5 子模块 + 门面，对外接口不变）----
# 起因：translate.js 涨到 1940 行，语言模型/术语表/公式掩码/签名算法/引擎注册表/
#      配置/运行时八种职责混在一起，改一处要在八个主题间跳转；拆分后按文件定界，
#      依赖单向（lang/crypto → engines → 门面；glossary/formula → 门面）。
for _pf in TRANSLATE_PARTS:
    ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "scripts", "ai", _pf)),
       "22.68 翻译子模块文件存在：%s" % _pf)
def _mjl22(marker):
    for _i, _l in enumerate(mainjs.split("\n")):
        if marker in _l:
            return _i
    return -1
_tr_seq = [_mjl22('"ai/%s"' % _p) for _p in TRANSLATE_PARTS]
ok(all(_x >= 0 for _x in _tr_seq) and _tr_seq == sorted(_tr_seq),
   "22.69 ★ 装配顺序 = lang→crypto→glossary→formula→engines→门面（依赖单向，门面最后）")
ok(_mjl22('"ai/pdf-text.js"') >= 0 and _mjl22('"ai/translate-lang.js"') > _mjl22('"ai/pdf-text.js"'),
   "22.70 子模块排在 pdf-text.js 之后（保持 §25.3 的确定性顺序前提）")
_tr_facade = io.open(TRANSLATE_JS, encoding="utf-8").read()
ok("var TranslateSvc" in _tr_facade and "TranslateLang" in _tr_facade
   and "TranslateCrypto" in _tr_facade and "TranslateGlossary" in _tr_facade
   and "TranslateFormula" in _tr_facade and "TranslateEngines" in _tr_facade,
   "22.71 ★ translate.js 为组合门面（别名引用全部 5 个子模块）")
for _gv in ["var TranslateLang", "var TranslateCrypto", "var TranslateGlossary",
            "var TranslateFormula", "var TranslateEngines"]:
    ok(_gv in tr_js, "22.72 子模块以 var 全局暴露（loadSubScript 共享作用域语义）：%s" % _gv)
# 拆分不允许丢对外接口：门面的导出键清单必须与 0.72.x 完全一致
_ok_keys = ["LANGS", "normalizeLang", "langMeta", "langLabel", "langName", "langCode",
            "SERVICES", "get", "list", "activeEngine", "isLLM", "ready", "available",
            "unavailableHint", "overview", "parseSecret", "joinSecret", "resolveSecret",
            "makeCtx", "buildEndpoint", "extractResult", "SEG_MAX",
            "parseGlossary", "glossary", "glossaryAll", "glossaryDomains", "activeDomains",
            "glossaryBlock", "glossaryFingerprint", "glossaryStats",
            "glossaryToCsv", "parseGlossaryImport", "mergeGlossary",
            "maskInlineFormulas", "unmaskFormulas",
            "googleTk", "sha1Bytes", "hmacSha1", "base64", "encodeRFC5987", "utf8Bytes",
            "cfg", "saveCfg", "setActive", "setSecret", "secretOf",
            "targetCode", "sourceCode", "targetName", "translate", "testEngine",
            "clearCache", "clearCooldown", "cooldownLeft", "probeLocal", "LOCAL_PROBES", "migrate"]
_tr_export = _tr_facade.split("return {", 1)[1] if "return {" in _tr_facade else ""
_ok_missing = [_k for _k in _ok_keys
               if not re.search(r"(^|[\s,{])%s([,:\s}])" % re.escape(_k), _tr_export)]
ok(not _ok_missing,
   "22.73 ★ 门面导出键与拆分前一致（缺失：%s）" % (", ".join(_ok_missing) or "无"))
ok("require('./translate-files')" in io.open(os.path.join(ROOT, "test", "translate.test.js"),
   encoding="utf-8").read(),
   "22.74 测试经 test/translate-files.js 单一真源加载模块（防多份清单漂移）")

# ---------- 23. 菜单瘦身（插件 0.29.0）----------
# 改动面：menus.js 注册表化 + classic 回退、prefs.js 三个菜单 pref、
# prefs.xhtml 菜单定制卡片、prefs-menu.js 面板脚本、main.js 暴露 menus/i18n。
# 钉死「重组不减功能」：注册表必须恰好 41 条（0.28 的 40 条 + 0.31.0 新增 ai-chat），
# classic 平铺回退必须真实存在（menuMode=classic 不是空话）。
ok('papilot.menuMode", "grouped"' in prefsdef, "23.1 prefs.js 有 menuMode 默认值 grouped")
for _k in ["menuHiddenGroups", "menuQuickItems"]:
    ok(("papilot.%s" % _k) in prefsdef, "23.2 prefs.js 含 %s 默认值" % _k)
ok("ITEM_REGISTRY" in menus_js and "GROUPS" in menus_js, "23.3 menus.js 改为注册表驱动")
ok('_buildClassicItemMenu' in menus_js and '_buildClassicTools' in menus_js,
   "23.4 classic 平铺回退构建器存在（menuMode=classic 可一键切回）")
ok('"menuMode", "menuHiddenGroups", "menuQuickItems"' in menus_js,
   "23.5 三个菜单 pref 均注册观察者（改动即时重建）")
for _gid in ["ai", "notes", "citation", "tags", "meta", "cn", "automation", "state"]:
    ok(('id: "%s"' % _gid) in menus_js, "23.6 语义分组注册表含 %s" % _gid)
_item_reg_src = menus_js.split("GROUPS:")[0]
ok(_item_reg_src.count("labelKey:") == 56,
   "23.7 ★ 注册表恰好 56 条命令（实测 %d；0.53.0 +综述工作台；0.61.0 +国标参考文献导出、0.62.0 +Obsidian 导出、0.63.0 +OCR 与笔记工具、0.70.0 +标签管理器；0.36.0 撤 pdf-inline；0.42.0 撤文本双栏、+嵌套标签、+评级组×6；0.43.0 +知网登录；0.43.1 登录类收敛到设置面板，撤 cn-login；0.44.0（实验）+第三方文献源；0.72.4 +组件商店）" % _item_reg_src.count("labelKey:"))
ok("type\", \"radio\"" in menus_js and "ReadingState.getState" in menus_js,
   "23.8 阅读状态为 radio 子菜单并按当前选中条目打点")
ok('"chrome/content/prefs-menu.js"' in mainjs, "23.9 设置面板注册 prefs-menu.js 脚本")
ok("this.menus = Menus;" in mainjs and "this.i18n = I18n;" in mainjs,
   "23.10 main.js 把 Menus/I18n 挂到 Zotero.Papilot（面板单一真源）")
for _k in ["pp-menu-mode", "pp-menu-groups", "pp-menu-quick-0", "pp-menu-quick-1",
           "pp-menu-quick-2", "pp-menu-result"]:
    ok(_k in xhtml_ids, "23.11 prefs.xhtml 含 #%s" % _k)
_pmp_js = io.open(os.path.join(ROOT, "chrome", "content", "prefs-menu.js"), encoding="utf-8").read()
_pmp_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', _pmp_js))
_pmp_missing = sorted(i for i in _pmp_used if i not in xhtml_ids)
ok(not _pmp_missing,
   "23.12 prefs-menu.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_pmp_missing or "无"))
ok("Zotero.Papilot.menus" in _pmp_js or "PP().menus" in _pmp_js,
   "23.13 prefs-menu.js 经 Zotero.Papilot.menus 读注册表（不维护第二份列表）")
ok("test/menu-registry.test.js" in _pf3, "23.14 preflight 含菜单注册表测试")

# ---------- 24. 阅读器右侧栏 · 翻译面板（插件 0.30.0） ----------
# 起因：把翻译的「操作+选项+结果」从右键菜单/设置搬进右侧栏（ItemPane section）。
# 这类改动有四类静默失败：
#   ① ItemPaneManager.registerSection 缺 onRender → Z10 schema 校验不通过、**静默返回 false**
#      （面板根本不出现，且控制台只多一行 boot 日志）；
#   ② l10nID 没有对应的 .ftl 条目 → header/sidenav 不渲染（官网明示，本项目 ftl 注释也写了）；
#   ③ 注销时用注册时的 paneID 而非返回值 → 注销不掉；
#   ④ 划词缓存放在浮窗开关之后 → 用户关掉浮窗后侧栏永远拿不到选中文本。
PANE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "panels", "translate-pane.js")
pane_js = io.open(PANE_JS, encoding="utf-8").read()
ZH_FTL = io.open(os.path.join(ROOT, "locale", "zh-CN", "papilot.ftl"), encoding="utf-8").read()
EN_FTL = io.open(os.path.join(ROOT, "locale", "en-US", "papilot.ftl"), encoding="utf-8").read()

ok('"panels/translate-pane.js"' in mainjs, "24.1 main.js 装配清单含 panels/translate-pane.js")
ok("this.translatePane = TranslatePane;" in mainjs, "24.2 main.js 把 TranslatePane 挂到 Zotero.Papilot")
ok("TranslatePane.register(id);" in mainjs, "24.3 main.js 启动时注册翻译面板")
ok("TranslatePane.unregister();" in mainjs, "24.4 main.js 关闭时注销翻译面板")
ok("Zotero.ItemPaneManager.registerSection({" in pane_js, "24.5 走官方 ItemPaneManager.registerSection")
ok('paneID: "papilot-translate"' in pane_js or 'PANE_ID: "papilot-translate"' in pane_js,
   "24.6 paneID 为 papilot-translate")
ok("onRender(" in pane_js, "24.7 ★ 提供 onRender（Z10 缺了会静默返回 false，面板不出现）")
ok("sidenav:" in pane_js, "24.8 提供 sidenav（右侧栏图标位）")
ok('l10nID: "papilot-translate-section-header"' in pane_js, "24.9 header l10nID 正确")
ok('l10nID: "papilot-translate-section-sidenav"' in pane_js, "24.10 sidenav l10nID 正确")
for _ftl, _tag in [(ZH_FTL, "zh-CN"), (EN_FTL, "en-US")]:
    ok("papilot-translate-section-header =" in _ftl and "papilot-translate-section-sidenav =" in _ftl,
       "24.11 %s ftl 有 header+sidenav 条目（缺了图标不渲染）" % _tag)
# ★ 注销必须用 registerSection 的返回值（带命名空间的主键）
ok("this._registeredPaneID = registeredPaneID;" in pane_js
   and "unregisterSection(this._registeredPaneID" in pane_js,
   "24.12 ★ 注销用返回值（不是注册时的 paneID）")
ok("if (!registeredPaneID)" in pane_js, "24.13 显式检查 registerSection 返回值（false 时不静默）")

# ★ 划词缓存在浮窗开关判断之前（否则关掉浮窗后侧栏永远拿不到选中文本）
_rp_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js"),
                  encoding="utf-8").read()
_i_cap = _rp_src.find("TranslatePane.captureSelection(")
_i_gate = _rp_src.find('if (!Prefs.get("readerPopupEnabled", true)) return;')
ok(_i_cap > 0 and _i_gate > 0 and _i_cap < _i_gate,
   "24.14 ★ 划词缓存先于浮窗开关判断（关掉浮窗也能在侧栏翻译）")

# 单一真源：分段与笔记正文复用全文对照翻译的实现，避免两处格式漂移
ok("BilingualTranslate._chunk(" in pane_js, "24.15 分段复用 BilingualTranslate._chunk（不重造）")
ok("BilingualTranslate._noteMd(" in pane_js, "24.16 笔记正文复用 BilingualTranslate._noteMd（格式零漂移）")
ok("pdfDual.openForItem(" in pane_js,
   "24.17 侧栏「双栏窗口」按钮走左原右译窗口（PdfDual，0.36.0）")
ok("AIClient.chat(" not in pane_js, "24.18 面板不直连 AIClient（一律经 TranslateSvc/AIChat）")
ok("TranslateSvc.translate(" in pane_js, "24.19 翻译经 TranslateSvc（多引擎 + 回退）")
ok("test/translate-pane.test.js" in _pf3, "24.20 preflight 含翻译面板测试")

# ---------- 25. 复杂 PDF 全文翻译优化（插件 0.33.0） ----------
# 起因：全文对照翻译此前直接把全文索引的扁平文本按字符切块送翻，学术论文的三类
# 静默劣化没人看得见——公式被改写、图表轴标签混进正文、页眉页脚每页重复烧预算。
# 本批次加 PdfText（结构化分析）+ 术语表/上下文（TranslateSvc）+ 窗口 blocks 渲染，
# 四类典型静默失败都要钉死：
#   ① 新模块没进装配清单或排到消费者之后 → ReferenceError，只写一行 boot 日志；
#   ② 窗口 blocks 路径写歪 → 退回旧路径，功能"看起来还在"但结构化白做；
#   ③ 术语表改了不吃新缓存（缓存键没带指纹）→ 用户以为术语表无效；
#   ④ 新 pref 没默认值 / 设置面板引用了不存在的元素 id → 静默 undefined。
PDFT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "pdf-text.js")
pdft_js = io.open(PDFT_JS, encoding="utf-8").read() if os.path.exists(PDFT_JS) else ""

ok(os.path.exists(PDFT_JS), "25.1 PdfText 模块存在（chrome/content/scripts/ai/pdf-text.js）")
ok('"ai/pdf-text.js"' in mainjs, "25.2 main.js 装配清单含 ai/pdf-text.js")
# 装配顺序：PdfText 必须在 translate.js（无依赖）与 bilingual-translate.js（消费）之前
_mj_lines = mainjs.split("\n")
def _line_of(marker):
    for i, l in enumerate(_mj_lines):
        if marker in l:
            return i
    return -1
ok(0 <= _line_of('"ai/pdf-text.js"') < _line_of('"ai/translate.js"'),
   "25.3 ★ PdfText 装配先于 translate.js（后者无依赖，但保持确定性顺序）")
ok(0 <= _line_of('"ai/pdf-text.js"') < _line_of('"features/bilingual-translate.js"'),
   "25.4 ★ PdfText 装配先于 bilingual-translate.js（消费者）")
ok("this.pdfText = PdfText;" in mainjs, "25.5 main.js 把 PdfText 挂到 Zotero.Papilot")

# 词法判定与分类顺序（误判公式/垃圾 = 丢内容）
ok("function isCaptionLine" in pdft_js and "function isFormulaText" in pdft_js
   and "function looksLikeJunkLine" in pdft_js, "25.6 三类词法判定齐全（caption/formula/junk）")
ok("function classify" in pdft_js, "25.7 有统一分类入口")
# ★ formula 必须先于 junk 判定：短公式长得像轴标签碎片，顺序错了会把公式当垃圾丢
_cl_block = pdft_js.split("function classify")[1].split("\n  }")[0] if "function classify" in pdft_js else ""
ok(_cl_block.index("isFormulaText") < _cl_block.index("looksLikeJunkLine"),
   "25.8 ★ classify 顺序 = caption → formula → junk（公式优先，宁可保留不误删）")
ok("function charsToParagraphs" in pdft_js, "25.9 阅读器字符流段落装配存在")
ok("function blocksToUnits" in pdft_js, "25.10 blocks → 翻译单元合并存在")
ok("kind === \"formula\"" in pdft_js, "25.11 单元带 formula kind（上层据此直出不送翻）")

# 双栏翻译模块：结构化提取 + 定位 + 回退
ok("PdfText.blocksFromReader" in bl_mod and "PdfText.analyzeText" in bl_mod
   and "PdfText.blocksToUnits" in bl_mod, "25.12 对照翻译消费 PdfText（reader 优先 + 扁平兜底 + 单元合并）")
ok("bilingualStructExtract" in bl_mod, "25.13 结构化提取受 pref 控制（可关闭回旧行为）")
ok("PdfText.locatePage" in bl_mod, "25.14 段落级定位经 PdfText.locatePage（复用 compare.js 页跳转打法）")
ok("getBlocks:" in bl_mod and "locate:" in bl_mod, "25.15 窗口载荷注入 getBlocks 与 locate 回调")
ok("context: o.context || null" in tr_js, "25.16 TranslateSvc 上下文经 makeCtx 透传（llm 消费）")
ok("bilingualContext" in bl_mod, "25.17 上下文感知受 pref 控制")

# 术语表（缓存键指纹 + 两处 prompt 注入 + 界面）
ok("function parseGlossary" in tr_js and "function glossaryBlock" in tr_js
   and "function glossaryFingerprint" in tr_js, "25.18 术语表三件套（解析/提示块/指纹）")
ok("glossaryFingerprint();" in tr_js, "25.19 ★ translate() 以术语表指纹参与缓存键（改表不吃旧缓存）")
ok("glossaryBlock(gl, ctx.text)" in tr_js, "25.20 llm 引擎 prompt 注入术语块（带待译文本 → 命中术语优先）")
ok("glossaryBlock(null, text)" in rp_js, "25.21 划词浮窗 LLM 翻译注入术语块（浮窗走 AIClient 直连，不经 _runEngine；同样相关性排序）")
ok("prefBool(\"bilingualStructExtract\"" in trp_js or "translateGlossary" in trp_js,
   "25.22 设置面板接线术语表/结构化开关")

# 行内公式保护（非 llm 引擎掩码）
ok("function maskInlineFormulas" in tr_js and "function unmaskFormulas" in tr_js,
   "25.23 行内公式掩码/还原存在（纯函数）")
ok("maskInlineFormulas(ctx.text)" in tr_js, "25.24 ★ 非 llm 引擎发送前掩码")
ok("unmaskFormulas(out, fMap)" in tr_js, "25.25 引擎返回后还原")
ok("maskInlineFormulas, unmaskFormulas," in tr_js, "25.26 掩码函数已导出（可单测）")

# pref 默认值 + 设置面板元素
for _k in ["translateGlossary", "translateGlossaryDomains", "bilingualStructExtract",
           "bilingualContext", "translateFormulaProtect"]:
    ok(("papilot.%s" % _k) in prefsdef, "25.27 prefs.js 含 %s 默认值" % _k)
for _id in ["pp-tr-glossary", "pp-tr-glossary-msg", "pp-tr-glossary-domains",
            "pp-tr-glossary-import", "pp-tr-glossary-export",
            "pp-tr-glossary-pack", "pp-tr-glossary-pack-add",
            "pp-tr-bl-struct", "pp-tr-bl-context", "pp-tr-formula"]:
    ok(_id in xhtml_ids, "25.28 prefs.xhtml 含 #%s" % _id)

# 门禁：两套测试都进 preflight
ok("pdf-text.test.js" in _pf3, "25.29 preflight 含 PDF 文本分析测试")
ok("bilingual-view.test.js" in _pf3, "25.30 preflight 含双栏窗口 blocks 渲染测试")
# 窗口脚本仍然只有一处 scrollTop 赋值（本批次不允许引入第二处）。
# ⚠️ §22 已把 bl_js 重赋为 bilingual-translate.js —— 这里必须按路径重读窗口脚本
_blv_src = io.open(BL_VIEW_JS, encoding="utf-8").read()
ok(len(re.findall(r"scrollTop\s*=", _blv_src)) == 1,
   "25.31 ★ 双栏窗口仍只有一处 scrollTop 赋值（定位经回调回插件侧，窗口不自滚）")

# ---------- 25.5 术语表领域化（0.4x：领域标签 / 域过滤 / 相关性注入 / 一致性统计 / 导入导出 / 种子词包） ----------
# 数据模型：领域标签（`原文 = 译文 | 领域` 行式第三段 + JSON {s,t,d}）
ok("_looksLikeDomain" in tr_js and "_normDomain" in tr_js,
   "25.32 领域标签归一化与防误判护栏存在（正文里的 | 不当域分隔符）")
ok("it.d !== undefined" in tr_js,
   "25.33 parseGlossary 解析领域字段（JSON {s,t,d} / 行式第三段）")
# 域过滤：pref translateGlossaryDomains → glossary() 过滤（通用术语永不被滤）
ok("function glossaryAll" in tr_js and "function activeDomains" in tr_js
   and "function glossaryDomains" in tr_js, "25.34 全量表/启用域白名单/领域清单三入口存在")
_gloss_fn = tr_js.split("function glossary()")[1].split("\n  }")[0] if "function glossary()" in tr_js else ""
ok("translateGlossaryDomains" in tr_js and "glossaryAll()" in _gloss_fn and "filter" in _gloss_fn,
   "25.35 ★ glossary() 按启用域过滤（域启停=改表，指纹随过滤结果变化 → 不吃旧缓存）")
# 相关性注入：glossaryBlock(list, text) 命中优先（两处注入点都带文本，25.20/25.21 已钉）
_gb_src = tr_js.split("function glossaryBlock")[1].split("\n  }")[0] if "function glossaryBlock" in tr_js else ""
ok("hit.concat(rest)" in _gb_src,
   "25.36 ★ glossaryBlock 相关性排序：待译文本命中的术语优先（60 条上限下保证命中必进 prompt）")
# 一致性统计：glossaryStats 纯函数 + translate() 挂 glossary 字段 + 双栏状态行反馈
ok("function glossaryStats" in tr_js and "_glossaryCheck(clean, out)" in tr_js,
   "25.37 术语一致性自检（glossaryStats 纯函数；translate() 成功与缓存命中都附带）")
ok("glossaryAgg" in bl_mod and "术语一致" in bl_mod,
   "25.38 全文对照翻译聚合术语一致性（_glossAgg / _glossTail；笔记完成文案汇报）")
ok("glossaryAgg" in _blv_src and "术语一致" in _blv_src,
   "25.39 双栏窗口状态行展示「术语一致 n/m」（A.glossaryAgg 回调，旧载荷静默跳过）")
# 导入导出：三纯函数 + 面板接线（CSV/TSV/JSON/行式四形态识别）
ok("function glossaryToCsv" in tr_js and "function parseGlossaryImport" in tr_js
   and "function mergeGlossary" in tr_js, "25.40 导入导出三纯函数（CSV 序列化/多形态识别/行级 upsert 合并）")
ok("pp-tr-glossary-import" in trp_js and "pp-tr-glossary-export" in trp_js
   and "parseGlossaryImport" in trp_js and "mergeGlossary" in trp_js,
   "25.41 设置面板接线导入/导出（FilePicker 薄壳 + persistGlossary 公共落盘路径）")
ok("putContentsAsync" in trp_js and "\\uFEFF" in trp_js,
   "25.42 导出写 UTF-8 BOM（Excel 打开中文 CSV 不乱码）")
# 种子词包：数据文件 + 装配 + 面板
_glp_ok = False
try:
    _glp_src = io.open(os.path.join(ROOT, "chrome/content/scripts/ai/glossary-packs.js"), encoding="utf-8").read()
    _glp_ok = "var GlossaryPacks" in _glp_src and _glp_src.count("{ s:") >= 60 and 'd: "计算机"' in _glp_src
except Exception:
    _glp_ok = False
ok(_glp_ok, "25.43 种子词包数据文件存在（四域各 ~20 条、全部带领域标签、自编无版权风险）")
ok("ai/glossary-packs.js" in mainjs and "this.glossaryPacks = GlossaryPacks;" in mainjs,
   "25.44 main.js 装配 glossary-packs.js 并挂 Zotero.Papilot.glossaryPacks")
ok("pp-tr-glossary-pack-add" in trp_js and "glossaryPacks" in trp_js,
   "25.45 设置面板「添加领域词包」经 mergeGlossary 行级 upsert（追加不覆盖）")
# 领域 chips：动态渲染 + 点击切换（写 translateGlossaryDomains）
ok("renderGlossaryDomains" in trp_js and "onDomainChipToggle" in trp_js
   and "translateGlossaryDomains" in trp_js,
   "25.46 领域筛选 chips（空=全部启用；点击进入筛选；全部取消回未筛选态）")

# 在线词包目录（0.4x：对接 GitHub open-termbank；懒加载 + 基址回退 + sha256 记账）
ok("fetchCatalog" in _glp_src and "fetchDomain" in _glp_src and "ONLINE_BASES" in _glp_src,
   "25.47 在线目录模块（fetchCatalog/fetchDomain/内置基址链）存在于 glossary-packs.js")
ok("translateGlossaryPackBase" in _glp_src and "jsdelivr" in _glp_src
   and "raw.githubusercontent.com" in _glp_src,
   "25.48 取用基址 = 自定义镜像（pref）→ jsDelivr → raw 三级回退")
ok("index.json" in _glp_src and "Date.now()" in _glp_src.split("function fetchCatalog")[1].split("\n  }")[0],
   "25.49 ★ index.json 带时间戳破 CDN 缓存（否则「有更新」检测滞后于 jsDelivr 长缓存）")
for _k in ["translateGlossaryPackBase", "translateGlossaryPackState"]:
    ok(("papilot.%s" % _k) in prefsdef, "25.27b prefs.js 含 %s 默认值" % _k)
for _id in ["pp-tr-glossary-online-fetch", "pp-tr-glossary-online-status",
            "pp-tr-glossary-online-list"]:
    ok(_id in xhtml_ids, "25.28b prefs.xhtml 含 #%s" % _id)
ok("pp-tr-glossary-online-fetch" in trp_js and "onOnlineFetch" in trp_js
   and "readPackState" in trp_js and "writePackState" in trp_js,
   "25.50 面板接线在线目录（懒加载获取 + sha256 记账读写）")
ok("parseGlossaryImport(r.text)" in trp_js and "translateGlossaryPackState" in trp_js,
   "25.51 ★ 在线导入走 parseGlossaryImport→mergeGlossary 同一条链（与文件导入一致）")
ok("glossaryPacks" in trp_js and "fetchCatalog()" in trp_js,
   "25.52 面板经 Zotero.Papilot.glossaryPacks 调沙箱侧在线模块（与 TranslateSvc 同模式）")


# ---------- 26. 参考文献一键入库（插件 0.33.0 重写） ----------
# 起因：旧实现（citation-trace.js 的 importForSelected）有三处硬伤——
#   ① `return d && !doiSet.has(d)` 把**所有没有 DOI 的参考文献直接丢弃**，用户看到的是
#      「参考文献均已在本地文库（或缺 DOI 无法可靠入库）」，功能等于不可用；
#   ② 只按 DOI 判重 → 库里已有的靠标题/arXiv/PMID 匹配不上，一键入库变一键造重复；
#   ③ 不分 itemType 地 setField("publicationTitle") 等字段 → 会议论文/书章/预印本被建成
#      期刊论文且字段静默丢失。
# 重写为三层（ref-format 纯函数 / ref-sources 多源 / ref-import 编排）+ 独立对话框。
# 这里守住的都是「点了没反应」类静默失败的接线：
RI_DIALOG_JS = os.path.join(ROOT, "chrome", "content", "ref-import.js")
RI_DIALOG_XHTML = os.path.join(ROOT, "chrome", "content", "ref-import.xhtml")
RI_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-import.js")
ri_dialog_js = io.open(RI_DIALOG_JS, encoding="utf-8").read()
ri_dialog_xhtml = io.open(RI_DIALOG_XHTML, encoding="utf-8").read()
ri_mod = io.open(RI_MOD, encoding="utf-8").read()
ri_fmt = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-format.js"),
                 encoding="utf-8").read()
ri_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-sources.js"),
                 encoding="utf-8").read()
ri_ct = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "citation-trace.js"),
                encoding="utf-8").read()

# 25.1~25.4 装配：三层按依赖序加载 + 暴露给窗口/菜单
_ri_i_fmt = mainjs.find('"features/ref-format.js"')
_ri_i_src = mainjs.find('"features/ref-sources.js"')
_ri_i_imp = mainjs.find('"features/ref-import.js"')
ok(_ri_i_fmt > 0 and _ri_i_src > _ri_i_fmt and _ri_i_imp > _ri_i_src,
   "26.1 main.js 按依赖序装配 ref-format → ref-sources → ref-import")
ok("this.refImport = RefImport;" in mainjs, "26.2 main.js 把 RefImport 挂到 Zotero.Papilot")

# 25.5~25.7 入口：注册表、classic 菜单、功能中心三处都必须走新对话框
ok('run: () => RefImport.openDialog()' in menus_js, "26.3 注册表 ref-import 入口指向新对话框")
ok(menus_js.count("RefImport.openDialog()") >= 2, "26.4 classic 平铺菜单同样指向新对话框（两处）")
ok("PP.refImport.openDialog()" in hub_js, "26.5 功能中心卡片指向新对话框")

# 25.8 旧实现已删除：不能再有「无 DOI 即丢弃」的过滤与 refs-picker 依赖
ok("return d && !doiSet.has(d)" not in ri_ct, "26.6 ★ 旧「无 DOI 即丢弃」的过滤已从 citation-trace 删除")
ok("refs-picker" not in ri_ct, "26.7 citation-trace 不再依赖 refs-picker")
ok(not os.path.exists(os.path.join(ROOT, "chrome", "content", "refs-picker.xhtml")),
   "26.8 refs-picker 旧对话框已移除（唯一消费方已改走 ref-import）")
ok("importForSelected" in ri_ct and "RefImport.importForSelected()" in ri_ct,
   "26.9 citation-trace.importForSelected 保留为委托入口（兼容旧调用方）")

# 25.10~25.13 修复点的静态存在性：多键判重 / 无 DOI 也入库 / 字段按类型白名单 / 多源联合检索
ok("pmids" in ri_mod and "arxiv" in ri_mod and "isbns" in ri_mod and "titles" in ri_mod,
   "26.10 ★ 库内索引含 DOI/PMID/arXiv/ISBN/标题 五把键（旧实现只有 DOI 一把）")
ok("FIELD_PLAN" in ri_mod and "conferencePaper" in ri_mod and "bookSection" in ri_mod
   and "preprint" in ri_mod, "26.11 ★ 按 itemType 白名单映射字段（期刊/会议/书章/预印本各一套）")
ok("SOURCES" in ri_src and ri_src.count('id: "') >= 5, "26.12 ★ 五个免密钥数据源已注册")
ok("dedupeRecords" in ri_src and "_score" in ri_src and "源一致" in ri_src,
   "26.13 ★ 联合检索按「多源一致命中」打分（准确率机制）")
ok("aiComplete" in ri_mod and "aiInvestigate" in ri_mod, "26.14 AI 补全与 AI 调研均已实现")
ok("toBibtex" in ri_fmt and "toRIS" in ri_fmt and "toEndNoteXML" in ri_fmt and "toCSLAll" in ri_fmt,
   "26.15 ★ 导出支持 BibTeX / EndNote(RIS) / EndNote XML / CSL-JSON")

# 25.16~25.19 对话框：windowtype / 脚本引用 id 全部存在 / 不直连网络 / API 一一对应
ok('windowtype="papilot:ref-import"' in ri_dialog_xhtml,
   "26.16 对话框 windowtype 为 papilot:ref-import")
_ri_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', ri_dialog_xhtml))
# 对话框脚本里的 $("…") 与 getElementById("…") 都必须在 xhtml 里存在
_ri_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', ri_dialog_js))
_ri_refs |= set(re.findall(r'getElementById\(\s*"([A-Za-z0-9_-]+)"', ri_dialog_js))
_ri_missing = sorted(i for i in _ri_refs if i not in _ri_ids)
ok(not _ri_missing, "26.17 对话框脚本引用的元素 id 都存在 → 缺失: %s" % (_ri_missing or "无"))

_ri_code = re.sub(r"/\*[\s\S]*?\*/", "", ri_dialog_js)
_ri_code = re.sub(r"(?m)//.*$", "", _ri_code)
ok(not re.search(r"Zotero\.HTTP|AIClient\s*\.|\bAIChat\b|fetch\s*\(", _ri_code),
   "26.18 ★ 对话框脚本不直连网络/AI（一律经注入的 api）")

# 对话框调用的每个 api.xxx，编排层的 windowApi() 都必须真的提供（漏一个 = 按钮点了没反应）
_ri_api_calls = set(re.findall(r"\bapi\.([A-Za-z_]\w*)", ri_dialog_js))
_ri_api_calls = {c for c in _ri_api_calls if c not in ("isZh",)}
_ri_api_defined = set(re.findall(r"(?m)^\s{6}([A-Za-z_]\w*)\s*[:(]", ri_mod))
_ri_api_missing = sorted(c for c in _ri_api_calls if c not in _ri_api_defined)
ok(not _ri_api_missing,
   "26.19 ★ 对话框用到的 api 方法都已注入 → 缺失: %s" % (_ri_api_missing or "无"))

# 25.20~25.22 主题作用域 / 文案 / 默认值 / 门禁
ok("papilot:ref-import" in uitheme_js, "26.20 新对话框纳入 ui-theme 主题作用域")
ok("menuRefImport" in utils_js, "26.21 文案表保留 menuRefImport")
ok("refImportSources" in prefsdef, "26.22 prefs.js 有 refImportSources 默认值")
ok("refImportMailto" in prefsdef, "26.23 prefs.js 有 refImportMailto 默认值")
_pf4 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/ref-import.test.js" in _pf4, "26.24 preflight 含参考文献入库测试")
# 单实例枚举必须用 windowtype（写成窗口名 → 每点一次菜单就开一个新窗口，
# 这类错误静态单测看不出来，只有真机连点两次才会发现）
ok('WINDOW_TYPE: "papilot:ref-import"' in ri_mod
   and "getEnumerator(this.WINDOW_TYPE)" in ri_mod,
   "26.25 ★ 单实例枚举用 windowtype（不是窗口名）")
ok('WINDOW_NAME: "papilot-ref-import"' in ri_mod
   and "openDialog(this.DLOG_URL, this.WINDOW_NAME" in ri_mod,
   "26.26 openDialog 用窗口名，与 windowtype 分开")

# ---- 26.27~26.38 「该文献引用的参考文献要都能进来」这一轮的补强 ----
# 用户实测反馈：选中的文献没有把该文章引用的参考文献都一键入库。三个原因：
#   ① 参考文献表只取自 Semantic Scholar 一家 → 它没收录/没匹配上的一律看不到；
#   ② 只取「选中条目里的第一篇」（items[0]）→ 多选时后面的文献全丢；
#   ③ 抓完还要手动逐个勾选 → 不叫「一键」。
ok("fetchReferenceLists" in ri_mod, "26.27 多源参考文献列表入口 fetchReferenceLists 存在")
ok('["s2", () =>' in ri_mod and '["crossref", () =>' in ri_mod
   and '["openalex", () =>' in ri_mod and '["europepmc", () =>' in ri_mod
   and '["pdf", async () =>' in ri_mod,
   "26.28 ★ 参考文献走五通道（S2 / Crossref / OpenAlex / Europe PMC / PDF 段落）")
ok("crossrefReferenceList" in ri_src and "openalexReferenceList" in ri_src
   and "europepmcReferenceList" in ri_src and "s2ReferenceList" in ri_src,
   "26.29 四个取数函数都在 RefSources 里（单一真源）")
ok("referenced_works" in ri_src and "openalex_id:" in ri_src,
   "26.30 OpenAlex 走 referenced_works + openalex_id 批量（2 次请求拿整份参考文献表）")
ok("s2BatchByDois" in ri_src and "S2Client.batch(" in ri_src,
   "26.31 DOI 批量补全走 S2 /paper/batch（参考文献表里只有 DOI 的条目能补出标题作者）")
ok('noTruncate: true' in ri_mod,
   "26.32 ★ PDF 通道传 noTruncate（参考文献段在文末，默认截断会正好切掉它）")
ok(".slice(0, o.maxItems || 8)" in ri_mod or "maxItems" in ri_mod,
   "26.33 ★ 支持**多篇**选中（不再只取 items[0]）")
ok("onImportAll" in ri_dialog_js and 'on("pp-ri-import-all", onImportAll)' in ri_dialog_js,
   "26.34 ★ 对话框有「全部导入」一键入口")
ok("channelText" in ri_dialog_js and "channels: channels" in ri_dialog_js,
   "26.35 抓取时把勾选的来源当通道传下去，并把各源命中数写进状态行")
ok("splitBibliography" in ri_fmt
   and "splitBibliographyEntries" in ri_fmt and "recordsFromBibliographyEntries" in ri_fmt,
   "26.36 参考文献段解析（切段/切条目/成记录）在 RefFormat 里")
ok("titleFromUnstructured" in ri_fmt and "authorsFromReferenceString" in ri_fmt
   and "yearFromReference" in ri_fmt and "_looksLikeAuthors" in ri_fmt,
   "26.37 ★ 一行式题录的标题/作者/年份抽取（无 DOI 的参考文献也能入库）")
ok("refsOnly: true" in ri_src and "SEARCHABLE" in ri_src,
   "26.38 新来源 europepmc/pdf 已注册；PDF 标 refsOnly（不参与联合检索）")
ok("test/ref-import.test.js" in _pf4 and "A2.29" in io.open(os.path.join(ROOT, "test", "ref-import.test.js"), encoding="utf-8").read(),
   "26.39 测试覆盖题录解析（A2.x）与新通道")
ok("resolveItemIdentifiers" in ri_src and "resolveByTitle" in ri_mod,
   "26.40 ★ 条目没记 DOI 时先用标题定位（否则四条通道都没入口）")
ok("diagnosis" in ri_mod and "diagnosisText" in ri_dialog_js,
   "26.41 ★ 抓不到时给出可执行诊断（no_identifier / scanned_pdf / no_bib_section / not_indexed）")

# ---- 26.42~26.50 中文文献路线（GB/T 7714 + 知网） ----
# 真机背景：用户库里大量中文临床指南，S2/Crossref/OpenAlex 基本不收录其参考文献表，
# 且样本 PDF 无文本层（扫描件）。所以必须补两条中文路径：
#   ① 粘贴 GB/T 7714 题录（用户从知网复制的就是这形态）——纯解析，100% 可靠；
#   ② 知网通道——能拿到最全的中文参考文献表，但会走风控，故**默认关闭**。
ok("parseChineseReference" in ri_fmt and "parseGBTSource" in ri_fmt and "gbtTypeCode" in ri_fmt,
   "26.42 ★ GB/T 7714 中文题录解析（[J]/[M]/[D]/[S]/[EB-OL] 类型码 + 卷(期):页）")
ok("GBT_TYPES" in ri_fmt and '"journalArticle"' in ri_fmt and '"thesis"' in ri_fmt,
   "26.43 类型码映射表在（含 thesis/report/webpage）")
ok('id: "cnki"' in ri_src and "cnkiReferenceList" in ri_src and "extractReferencesFromCNKIHTML" in ri_src,
   "26.44 知网参考文献通道已实现")
ok("defaultOff: true" in ri_src and "filter((s) => !s.defaultOff)" in ri_src,
   "26.45 ★ 知网默认关闭（风控：不能让用户莫名其妙被拦）")
ok("CNFetch._searchCNKI" in ri_src and "CNFetch._seedCNKI" in ri_src,
   "26.46 知网通道复用既有 CNFetch 会话/检索（不重复实现）")
ok('"need_verify"' in ri_src and '"need_login"' in ri_src and '"no_hit"' in ri_src,
   "26.47 风控/登录/未命中都显式回报原因")
ok("cnki_verify" in ri_mod and "cnki_login" in ri_dialog_js and "cnki_no_hit" in ri_dialog_js,
   "26.48 ★ 诊断文案指路（去过滑块 / 先登录 / 换粘贴题录）")
ok('"kns.cnki.net": 3000' in ri_src, "26.49 知网限速 3s/次（别把风控招来）")
ok("A4.13" in io.open(os.path.join(ROOT, "test", "ref-import.test.js"), encoding="utf-8").read(),
   "26.50 测试覆盖知网区块抽取与失败原因（A4/A5）")

# ---------- 27. PDF 原位对照翻译（插件 0.34.0） ----------
# 起因：用户要求「在**原版 PDF 的对应位置**按原始排版逐段对照」——不是另开窗口罗列。
# 做法是把每段译文按**原文段落坐标**叠加回 pdf.js 页面。这类改造的静默失败点：
#   ① 装配晚于依赖（PdfText / TranslateSvc）→ ReferenceError，只写一行 boot 日志；
#   ② 依赖 pdf.js 私有坐标契约（自己解析 PDF）→ 版本一变就错位；
#   ③ 缩放/懒加载后不重铺 → 用户滚两页就发现「后面没有译文」，且没人报错；
#   ④ 公式/页码当正文翻 → 原页出现垃圾译文；
#   ⑤ 停止/卸载不清层 → 残留覆盖物，用户关掉插件也去不掉。
PI_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-inline.js")
pi_js = io.open(PI_JS, encoding="utf-8").read() if os.path.exists(PI_JS) else ""

ok(os.path.exists(PI_JS), "27.1 PdfInline 模块存在（features/pdf-inline.js）")
ok('"features/pdf-inline.js"' in mainjs, "27.2 main.js 装配清单含 features/pdf-inline.js")
_mj2 = mainjs.split("\n")


def _mj_line(marker):
    for i, l in enumerate(_mj2):
        if marker in l:
            return i
    return -1


ok(0 <= _mj_line('"ai/pdf-text.js"') < _mj_line('"features/pdf-inline.js"'),
   "27.3 ★ 装配序：PdfInline 在 ai/pdf-text.js 之后（复用 viewerOf/classify 单一真源）")
ok(0 <= _mj_line('"ai/translate.js"') < _mj_line('"features/pdf-inline.js"'),
   "27.4 ★ 装配序：PdfInline 在 ai/translate.js 之后（翻译一律走 TranslateSvc）")
ok("this.pdfInline = PdfInline;" in mainjs, "27.5 main.js 把 PdfInline 挂到 Zotero.Papilot")
ok("PdfInline.register(id);" in mainjs, "27.6 main.js 启动时注册（阅读器工具栏按钮）")
ok("PdfInline.unregister();" in mainjs, "27.7 main.js 关闭时注销（摘除注入物）")

# 官方扩展位 + 同步 append（与主题按钮同一纪律）
ok('Zotero.Reader.registerEventListener("renderToolbar"' not in pi_js.split("function register")[1].split("function unregister")[0],
   "27.8 ★ 0.36.0 起不再注入阅读器工具栏（页内形态撤掉，改由 PdfDual 双栏窗口承载）")
ok("attach: start" in pi_js and "extractBlocks, stateMode" in pi_js,
   "27.9 导出 attach/extractBlocks/stateMode 供 PdfDual 右栏复用（内核 API）")

# 坐标来源：pdf.js 已渲染的 textLayer（不自己解析 PDF）+ 复用 PdfText.viewerOf
ok('querySelector(".textLayer")' in pi_js, "27.10 ★ 段落坐标读 pdf.js textLayer（不自造 PDF 解析）")
ok("getBoundingClientRect()" in pi_js, "27.11 用真实 rect 换算页内坐标（与缩放/DPR 解耦）")
ok("PdfText.viewerOf(reader)" in pi_js, "27.12 复用 PdfText.viewerOf 拿 viewer（单一真源）")
ok("PdfText.classify" in pi_js, "27.13 复用 PdfText.classify 分类（公式/图注/垃圾行同一口径）")
ok('b.kind === "formula"' in pi_js and 'if (b.kind === "formula") continue;' in pi_js,
   "27.14 ★ 公式段落不翻译、不叠加（原文原样保留）")

# 懒加载与缩放：事件驱动重铺 + 几何签名判废
ok('eventBus.on("textlayerrendered"' in pi_js and 'eventBus.on("pagerendered"' in pi_js,
   "27.15 ★ 监听 textlayerrendered/pagerendered（懒加载与缩放重建后自动补铺）")
ok("function pageSignature" in pi_js, "27.16 几何签名检测坐标失效（缩放后重铺而非错位）")
ok("function recount" in pi_js, "27.17 计数派生而非累加（重铺不虚高进度）")

# 清理纪律
ok("states.clear();" in pi_js and "btn.remove();" in pi_js,
   "27.18 unregister 摘除按钮与全部 reader 状态（宿主回到原生）")
ok("clearPage(pageEl)" in pi_js, "27.19 每页注入前先清旧层（幂等）")
ok("stop(reader" in pi_js and "markSourceSpans(pageEl, false)" in pi_js,
   "27.20 停止时清层并还原原文标记")

# 入口：菜单 + 工具栏按钮 + 设置面板
menus27 = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read()
ok('id: "pdf-inline"' not in menus27, "27.21 菜单里已无 pdf-inline 页内入口（0.36.0 撤掉）")
ok("PdfInline.startForSelected" not in menus27, "27.22 菜单不再指向页内叠加")
ok("menuPdfInline" in utils_js, "27.23 文案表含 menuPdfInline")
ok("papilot-inline-reader-button" in pi_js, "27.24 阅读器工具栏按钮 id 固定（供清理与测试定位）")

for _k in ["pdfInlineMode", "pdfInlineFontScale", "pdfInlineSelectable", "pdfInlineGapMs"]:
    ok(("papilot.%s" % _k) in prefsdef, "27.25 prefs.js 含 %s 默认值" % _k)
# 0.36.0：设置面板暴露的是「左原右译」的四项（pp-pd-*）；内核 pref 不再直接暴露
for _id in ["pp-pd-rightmode", "pp-pd-scale", "pp-pd-sync", "pp-pd-zoom"]:
    ok(_id in xhtml_ids, "27.26 prefs.xhtml 含 #%s" % _id)
_pi_used = set(re.findall(r'\$\("(pp-pd-[A-Za-z0-9_-]+)"\)', trp_js))
ok(_pi_used, "27.27 prefs-translate.js 接线对照翻译设置（%s）" % (", ".join(sorted(_pi_used)) or "无"))
ok("pdfInline" in trp_js and "piRefresh" in trp_js, "27.28 设置改动即时 refresh 已打开的阅读器")

# 纪律：不直连网络/AI（翻译一律经 TranslateSvc）
pi_code = re.sub(r"/\*[\s\S]*?\*/", "", pi_js)
pi_code = re.sub(r"(?m)//.*$", "", pi_code)
ok(not re.search(r"Zotero\.HTTP|fetch\s*\(", pi_code),
   "27.29 不直连网络（去掉注释后无 Zotero.HTTP/fetch）")
ok("TranslateSvc.translate(" in pi_js, "27.30 翻译走 TranslateSvc（多引擎 + 回退 + 术语表）")
ok("pdf-inline.test.js" in _pf3, "27.31 preflight 含原位对照翻译测试")
ok("pdfInlineSelfTest" in prefsdef and "pdfInline selfTest:" in mainjs,
   "27.32 自检开关（真实 PDF 上验段落抽取与卡片落点）")


# ---------- 28. PDF 对照翻译 · 左原右译双栏窗口（插件 0.36.0） ----------
# 起因：用户要的是「左栏原版 PDF / 右栏同一页译文」的双栏对照（PDF2zh 那种形态），
# 而不是阅读器内的整页叠加。右栏用**同一个 PDF** 的第二个预览 + 内核的 mono 模式
# （译文按原文段落坐标替换文字、图表与公式图形保留）⇒ 版面/分页天然一致。
# 这类改造的静默失败点：
#   ① 窗口脚本直连 AIClient/TranslateSvc（作用域里根本没有）→ 翻译永远不动；
#   ② 预览就绪判据写错（只看 readyState）→ about:blank 被当就绪，右栏空白且不报错；
#   ③ `reader._open()` 吞异常返回 false 而不判返回值 → 失败与空白无法区分；
#   ④ 同步滚动的「布尔 guard + rAF」在窗口被遮挡时永久卡死（compare.js 实踩）；
#   ⑤ 预览 scrollMode 落到 3（单页）→ 两栏都不能滚，用户只看到第一页。
PD_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-dual.js")
PD_XHTML = os.path.join(ROOT, "chrome", "content", "pdf-dual.xhtml")
PD_VIEW = os.path.join(ROOT, "chrome", "content", "pdf-dual-view.js")
pd_mod = io.open(PD_MOD, encoding="utf-8").read() if os.path.exists(PD_MOD) else ""
pd_xhtml = io.open(PD_XHTML, encoding="utf-8").read() if os.path.exists(PD_XHTML) else ""
pd_view = io.open(PD_VIEW, encoding="utf-8").read() if os.path.exists(PD_VIEW) else ""

ok(os.path.exists(PD_MOD) and os.path.exists(PD_XHTML) and os.path.exists(PD_VIEW),
   "28.1 三件套齐全（pdf-dual.js / pdf-dual.xhtml / pdf-dual-view.js）")
ok('"features/pdf-dual.js"' in mainjs, "28.2 main.js 装配清单含 features/pdf-dual.js")
_mj3 = mainjs.split("\n")


def _mj3_line(marker):
    for i, l in enumerate(_mj3):
        if marker in l:
            return i
    return -1


ok(0 <= _mj3_line('"features/pdf-inline.js"') < _mj3_line('"features/pdf-dual.js"'),
   "28.3 ★ 装配序：PdfDual 在内核 pdf-inline.js 之后（右栏复用其 attach）")
ok("this.pdfDual = PdfDual;" in mainjs, "28.4 main.js 把 PdfDual 挂到 Zotero.Papilot")
ok("this.pdfDual.selfTest(undefined, att)" in mainjs and "pdfDualSelfTest" in prefsdef,
   "28.5 自检开关（真实 PDF 上验左右 pane 挂载与右栏落卡；可指定附件排障）")

# 窗口骨架与元素守卫
ok('windowtype="papilot:pdf-dual"' in pd_xhtml, "28.6 窗口 windowtype=papilot:pdf-dual")
ok("chrome://papilot/content/pdf-dual-view.js" in pd_xhtml, "28.7 窗口挂了窗口脚本")
ok('id="pp-pd-left-browser"' in pd_xhtml and 'id="pp-pd-right-browser"' in pd_xhtml,
   "28.8 ★ 左右各一个 reader browser（左原版 / 右译文）")
ok('class="reader"' in pd_xhtml and "<splitter" in pd_xhtml,
   "28.9 browser 用宿主 reader 类 + 分隔条（可拖拽分栏）")
_pd_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', pd_xhtml))
_pd_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', pd_view))
_pd_missing = sorted(i for i in _pd_refs if i not in _pd_ids)
ok(not _pd_missing, "28.10 窗口脚本引用的元素 id 都存在于 pdf-dual.xhtml → 缺失: %s" % (_pd_missing or "无"))

# 窗口脚本纪律：不直连 AI/网络，翻译经注入回调
pd_code = re.sub(r"/\*[\s\S]*?\*/", "", pd_view)
pd_code = re.sub(r"(?m)//.*$", "", pd_code)
ok(not re.search(r"AIClient\s*\.|\bAIChat\b|TranslateSvc\s*\.|Zotero\.HTTP|fetch\s*\(", pd_code),
   "28.11 ★ 窗口脚本不直连 AI/翻译/网络（一律回插件作用域）")
for _cb in ["A.onPanesReady(", "A.exportNote(", "A.setFontScale(", "A.retranslate(", "A.onUnload("]:
    ok(_cb in pd_view, "28.12 窗口经注入回调调用 %s" % _cb)
for _cb in ["onPanesReady:", "exportNote:", "setFontScale:", "retranslate:", "onUnload:"]:
    ok(_cb in pd_mod, "28.13 模块侧注入 %s" % _cb)

# 复用内核：右栏 = 同一 PDF 的 mono 译文视图
ok("PdfInline.attach(" in pd_mod, "28.14 ★ 右栏复用内核 PdfInline.attach（不重造提取/翻译）")
ok("mode: this._rightMode()" in pd_mod and '"mono"' in pd_mod,
   "28.15 右栏默认 mono（译文替换原文文字、图表与公式保留）")
ok("PdfInline._textCache" in pd_mod and "PdfInline.refresh()" in pd_mod,
   "28.16 重新翻译 = 清内核缓存 + 重铺")
ok("BilingualTranslate._noteMd(" in pd_mod, "28.17 导出笔记复用 _noteMd（格式零漂移）")

# 预览挂载的三条硬约束（compare.js 结论）
ok("typeof uw.createReader === \"function\"" in pd_view,
   "28.18 ★ 就绪判据 = createReader 是函数（不看 readyState，about:blank 会骗人）")
ok("opened === false" in pd_view, "28.19 ★ 判 reader._open() 返回值（它吞异常后 return false）")
ok("scrollMode = 0" in pd_view and "overflow:auto !important" in pd_view,
   "28.20 ★ 强制连续垂直（scrollMode=0）+ 解禁 #viewerContainer 的 overflow")

# 同步滚动：页 + 页内比例 + 待吞计数（禁用布尔 guard + rAF）
ok("function currentPosition" in pd_view and "function gotoPosition" in pd_view,
   "28.21 同步滚动按「页号 + 页内比例」定位（几何二分）")
ok("pendingLeft" in pd_view and "pendingRight" in pd_view and "SYNC_GUARD_MS" in pd_view,
   "28.22 ★ 待吞计数 guard + 兜底清零（不用布尔+rAF：窗口被遮挡时会永久卡死）")
ok('addEventListener("scroll"' in pd_view, "28.23 两栏滚动双向联动")

# 入口接线（四处）
ok("PdfDual.openForSelected" in menus_js, "28.24 右键菜单指向 PdfDual")
ok("pdfDual.openForSelected" in wb_js, "28.25 工作台 chip 指向 PdfDual")
ok("pdfDual.openForSelected" in hub_js, "28.26 功能中心卡片指向 PdfDual")
pane_js2 = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "panels", "translate-pane.js"),
                   encoding="utf-8").read()
ok("pdfDual.openForItem(" in pane_js2, "28.27 阅读器侧栏翻译面板指向 PdfDual")
ok("WINDOW_TYPE: \"papilot:pdf-dual\"" in pd_mod and "getEnumerator(this.WINDOW_TYPE)" in pd_mod,
   "28.28 单实例复用（按常量枚举，名字不会写歪）")

# pref 默认值与设置面板
for _k in ["pdfDualSyncScroll", "pdfDualSyncZoom", "pdfDualRightMode", "pdfDualSelfTest"]:
    ok(("papilot.%s" % _k) in prefsdef, "28.29 prefs.js 含 %s 默认值" % _k)
_utils_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"),
                     encoding="utf-8").read()
ok("menuPdfDual" in _utils_src and "pdSync" in _utils_src,
   "28.31 文案表含 menuPdfDual 与窗口文案键（pd*）")
ok("pdf-dual.test.js" in _pf3, "28.32 preflight 含左原右译窗口测试")

# ---- 0.37.0：整篇翻译（逐页滚动触发渲染）+ 就绪信号 ----
ok("translateAll" in pi_js and "viewer.currentPageNumber = i" in pi_js,
   "28.33 ★ 整篇翻译靠**逐页滚动**触发 pdf.js 渲染（PDFPageView 的渲染入口全是私有的，只能滚）")
ok("out.skipped++" in pi_js, "28.34 无文本层的页被跳过并计数（不自欺为「已翻译」）")
ok("container.scrollTop = keep" in pi_js, "28.35 结束后滚回原位（不打扰用户当前阅读位置）")
ok("translateAll: () => this.translateAll()" in pd_mod and "async translateAll(opts)" in pd_mod,
   "28.36 窗口「翻译全文」按钮经回调走插件侧（窗口不直连内核）")
ok("PdfInline.translateAll(" in pd_mod, "28.37 PdfDual 转发到内核 translateAll（翻译全文）")
ok('id="pp-pd-all"' in pd_xhtml and 'pp-pd-all' in pd_view,
   "28.38 工具栏「翻译全文」按钮存在且已接线")
ok("window.ppDualPhase" in pd_view, "28.39 页级进度回调（第 X/Y 页 + 累计段数）")
ok("window.ppDualReady" in pd_view, "28.40 ★ 就绪信号：挂载完成**且**初始化跑完（只看 mounted 会假就绪）")
ok("ppDualReady" in io.open(os.path.join(ROOT, "test", "pdf-dual.test.js"), encoding="utf-8").read(),
   "28.41 窗口测试等的是就绪信号（不是只等 mounted）")
ok("translateAll" in io.open(os.path.join(ROOT, "test", "pdf-inline.test.js"),
                             encoding="utf-8").read(),
   "28.42 内核测试覆盖整篇翻译（遍历/跳过页/滚动复位/卡片落地）")


# ---------- 29. 更新提示（插件 0.37.1） ----------
# 起因：用户报「没有接收到版本更新」——实测更新通道完全正常（把 profile 降回 0.36.0，
# 启动 150 秒后 Zotero 自动替换成 0.37.0），真正的问题是 Zotero 对第三方插件的更新是
# **静默后台替换**，不给任何提示，用户感知不到。本模块补这个反馈。
# 静默失败点：① 本机已是最新还弹窗 = 纯骚扰；② 同一版本每次启动都弹 = 用户想卸载；
# ③ 断网时弹错误窗 = 比不提示更糟；④ 关掉开关还偷偷联网。
UN_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "update-notice.js")
un_js = io.open(UN_MOD, encoding="utf-8").read() if os.path.exists(UN_MOD) else ""

ok(os.path.exists(UN_MOD), "29.1 UpdateNotice 模块存在")
ok('"features/update-notice.js"' in mainjs, "29.2 main.js 装配清单含 features/update-notice.js")
ok("UpdateNotice.register(id, version," in mainjs, "29.3 启动时排程检查（带当前版本与结果回调）")
ok("UpdateNotice.unregister();" in mainjs, "29.4 关闭时清掉定时器")
ok("function compareVersion" in un_js or "compareVersion(a, b)" in un_js,
   "29.5 版本比较是纯函数（可单测）")
ok("function latestVersion" in un_js or "latestVersion(json)" in un_js,
   "29.6 清单取最新版本是纯函数")
# 与 manifest 的 update_url 完全一致（两处漂移 = 检查错地址，且很难发现）
_mf_url_hit = re.search(r'"update_url"\s*:\s*"([^"]+)"', MANIFEST)
_mf_url = _mf_url_hit.group(1) if _mf_url_hit else ""
ok('UPDATE_URL: "%s"' % _mf_url in un_js,
   "29.7 ★ 模块 UPDATE_URL 与 manifest 的 update_url 完全一致")
ok("updateNoticeLastVersion" in un_js, "29.8 记录已提示版本（同一版本只提示一次）")
ok('out.skipped = "already-notified"' in un_js, "29.9 ★ 已提示过则静默")
ok('out.skipped = "up-to-date"' in un_js, "29.10 ★ 已是最新则静默（不骚扰）")
ok('out.skipped = "disabled"' in un_js, "29.11 开关关掉直接跳过")
ok("catch (e)" in un_js and "network: " in un_js, "29.12 ★ 网络异常静默（不弹错误窗）")
ok("ProgressWindow" in un_js, "29.13 用 Zotero 原生通知（与插件其它提示一致）")
ok("updateNoticeEnabled" in prefsdef,
   "29.14 prefs.js 含 updateNoticeEnabled 默认值")
ok("update-notice.test.js" in _pf3, "29.15 preflight 含更新提示测试")
# 0.44.1：更新内容展示（用户报「以前能看到更新了哪些内容」）
ok("updateNoticeLastSeen" in un_js and "updateNoticeLastSeen" in prefsdef,
   "29.16 ★ 记录「上次运行版本」pref（静默更新完成后的“已更新到”提示）")
ok("entryOf" in un_js and "whatsNewOf" in un_js and "_notifyUpdated" in un_js,
   "29.17 ★ whatsNew 摘要解析与更新完成提示（纯函数可单测）")
ok("本次更新内容" in un_js, "29.18 更新完成提示展示「本次更新内容」摘要")


# ---------- 30. XHTML 的 XML 合法性（插件 0.37.2） ----------
# 起因：prefs.xhtml 里一个 `&nbsp;`（XML 只预定义 amp/lt/gt/quot/apos）导致**整个设置面板
# 解析失败 → 面板空白**，而且日志里没有任何提示，用户只能报「设置界面不显示插件设置」。
# 这类错误必须在构建期挡住：这里对每个 xhtml 做「XML 可解析 + 无未定义实体」双检，
# 并在 main.js 侧要求注册面板前预解析一次（失败写 boot 日志），把静默故障变可见。
_XHTML_DIR = os.path.join(ROOT, "chrome", "content")
_xhtml_files = sorted(f for f in os.listdir(_XHTML_DIR) if f.endswith(".xhtml"))
ok(len(_xhtml_files) >= 15, "30.1 找到 %d 个 xhtml 窗口文件" % len(_xhtml_files))
_bad_xml = []
_bad_ent = []
_ALLOWED_ENT = {"amp", "lt", "gt", "quot", "apos"}
for _f in _xhtml_files:
    _p = os.path.join(_XHTML_DIR, _f)
    _src = io.open(_p, encoding="utf-8").read()
    try:
        import xml.etree.ElementTree as _ET
        _ET.fromstring(_src)
    except Exception as _e:
        _bad_xml.append("%s: %s" % (_f, _e))
    for _i, _line in enumerate(_src.split("\n"), 1):
        for _m in re.finditer(r"&([a-zA-Z][a-zA-Z0-9]*);", _line):
            if _m.group(1) not in _ALLOWED_ENT:
                _bad_ent.append("%s:%d %s" % (_f, _i, _m.group(0)))
ok(not _bad_xml, "30.2 ★ 所有 xhtml 都能被 XML 解析 → %s" % (_bad_xml or "全部通过"))
ok(not _bad_ent, "30.3 ★ 无未定义实体（&nbsp; 在 XML 里非法，会让整个面板空白）→ %s"
   % (_bad_ent or "无"))
ok("prefs.xhtml" in " ".join(_xhtml_files) and "&nbsp;" not in
   io.open(os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read(),
   "30.4 设置面板 prefs.xhtml 无 &nbsp;（曾因此整面板空白）")
ok('&html:label class="pp-label">&#160;<' in io.open(
    os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read()
   or "&#160;" in io.open(os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read(),
   "30.5 占位空白用数字实体 &#160;（XML 合法）")
ok("prefs.xhtml 有 XML 未定义实体" in mainjs and "prefs.xhtml ok（" in mainjs,
   "30.6 ★ 启动时自查 prefs.xhtml（零依赖实体扫描，不用 DOMParser），异常写 boot 日志")
ok("new DOMParser()" not in mainjs,
   "30.7 不用 DOMParser（bootstrap 作用域实测不可用，会让自查本身静默失败）")

# ---------- 31. 0.38.0 设置面板折叠分组 ----------
# 设计约束：折叠只切 .pp-fold-closed 类，卡片内 DOM / 元素 id / preference= 绑定一律
# 原样保留——所以这里的守卫盯三件事：脚本注册了、工具条与分组键齐了、默认值声明了。
PFOLD_JS = os.path.join(ROOT, "chrome", "content", "prefs-fold.js")
ok(os.path.exists(PFOLD_JS), "31.1 prefs-fold.js 存在")
_pfold_js = io.open(PFOLD_JS, encoding="utf-8").read() if os.path.exists(PFOLD_JS) else ""
ok("prefs-fold.js" in mainjs, "31.2 main.js 注册 prefs-fold.js（scripts 列表）")
for _eid in ("pp-fold-expand", "pp-fold-collapse"):
    ok(_eid in xhtml_ids, "31.3 prefs.xhtml 含折叠工具条 #%s" % _eid)
_FOLD_KEYS = ["account", "cnki", "thirdsrc", "channels", "translate", "aiparams", "skills", "subscriptions", "schedule", "popup",
              "columns", "tagging", "enhance", "uitheme", "pdftheme", "menu", "hotkeys", "cloud", "wps",
              "glossary", "pdfdual"]
_fold_found = re.findall(r'data-fold="([a-z]+)"', prefs_xhtml)
ok(sorted(_fold_found) == sorted(_FOLD_KEYS),
   "31.4 prefs.xhtml 的 21 个折叠分组键齐全（0.48.x 技能商店；0.49.0 定时任务；0.53.0 检索订阅；0.56.0 云同步；0.68.1 WPS 集成；0.72.4 翻译卡拆三：translate/glossary/pdfdual）→ 实际: %s" % ",".join(sorted(set(_fold_found))))
ok(prefs_xhtml.count('class="pp-card pp-fold"') == 21,
   "31.5 折叠卡片共 21 张（0.49.0 定时任务，0.53.0 检索订阅，0.56.0 云同步，0.68.1 WPS 集成，0.72.4 翻译卡拆三；不多不少，防止漏包一张）")
ok('pref("extensions.zotero.papilot.prefsFoldOpen", "account");' in prefsdef,
   "31.6 prefs.js 有 prefsFoldOpen 默认值（默认展开账号卡；点过全部收起后写空串，记忆优先）")
ok("prefsFoldOpen" in _pfold_js and "pp-fold-closed" in _pfold_js,
   "31.7 prefs-fold.js 读写 prefsFoldOpen 并切换 pp-fold-closed")
ok(".pp-fold-closed .pp-card-body { display: none; }" in prefs_css,
   "31.8 prefs.css 收起态隐藏卡片体")
# 深链：reader-popup 打开设置前放 _prefsFocus，prefs-fold.js 消费后清掉
_rp_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts",
                               "features", "reader-popup.js"), encoding="utf-8").read()
ok("_prefsFocus" in _rp_src and "_prefsFocus" in _pfold_js,
   "31.9 深链定位接线：reader-popup 写 _prefsFocus → prefs-fold.js 消费")

# ---------- 32. 0.38.0 主题按钮冒泡修复 + 顶部快捷按钮 ----------
# 主题按钮「点得开但子菜单进不去」的根因：XUL popup 事件与 menuitem command 都会冒泡。
# 守卫盯两处模块的 ev.target 防御（Zotero 自身 menuManager.js 同款写法）。
_tt_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts",
                               "features", "theme-toggle.js"), encoding="utf-8").read()
ok("if (ev.target !== popup) return" in _tt_src,
   "32.1 ★ theme-toggle popup 事件带 ev.target 冒泡守卫（子菜单悬停不再触发整菜单重建）")
ok("if (ev.target !== btn) return" in _tt_src,
   "32.2 ★ theme-toggle 按钮 command 带 ev.target 冒泡守卫（选完主题菜单正常关闭）")
TQ_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "toolbar-quick.js")
ok(os.path.exists(TQ_JS), "32.3 toolbar-quick.js 存在")
_tq_js = io.open(TQ_JS, encoding="utf-8").read() if os.path.exists(TQ_JS) else ""
ok("toolbar-quick.js" in mainjs, "32.4 main.js 注册 toolbar-quick.js（scripts 列表）")
ok("ToolbarQuick.register()" in mainjs and "ToolbarQuick.unregister()" in mainjs,
   "32.5 main.js 挂 ToolbarQuick 生命周期（register/unregister）")
ok('pref("extensions.zotero.papilot.quickBarButtonEnabled", true);' in prefsdef,
   "32.6 prefs.js 有 quickBarButtonEnabled 默认值")
ok("quickBarButtonEnabled" in mainjs and "ToolbarQuick.syncEnabled" in mainjs,
   "32.7 pref 观察者接线：quickBarButtonEnabled → ToolbarQuick.syncEnabled")
ok("if (ev.target !== popup) return" in _tq_js and "if (ev.target !== btn) return" in _tq_js,
   "32.8 ★ toolbar-quick 同款双冒泡守卫（新代码不吃同一个坑）")
ok("zotero-items-toolbar" in _tq_js,
   "32.9 toolbar-quick 锚定 #zotero-items-toolbar（顶部条目工具栏）")
ok("_quickItems" in _tq_js,
   "32.10 ★ 快捷菜单直达项与右键菜单共用 Menus._quickItems（单一真源，不维护第二份列表）")
ok("quickBarButtonEnabled" in prefs_xhtml,
   "32.11 prefs.xhtml 有快捷按钮开关（增强功能卡）")

# ---------- 35. 0.38.0 提示词深度优化 + 快捷按钮图标 ----------
# 图标：48px icon.png 会按原始尺寸撑大 28px 工具栏按钮 → 换 16px 单色 quick.svg
QUICK_SVG = os.path.join(ROOT, "chrome", "content", "icons", "quick.svg")
ok(os.path.exists(QUICK_SVG), "35.1 icons/quick.svg 存在")
if os.path.exists(QUICK_SVG):
    _qsvg = io.open(QUICK_SVG, encoding="utf-8").read()
    ok('width="16" height="16"' in _qsvg and "context-fill" in _qsvg,
       "35.2 quick.svg 是 16px context-fill 单色图标（与 theme.svg 同规格）")
ok('icons/quick.svg")' in _tq_js and 'icons/icon.png")' not in _tq_js,
   "35.3 toolbar-quick 引用 quick.svg（listStyleImage 不再用 48px icon.png）")
# 提示词：根系统提示词的纪律条款 + 各任务提示词的证据要求
ok("绝不编造" in prefsdef and "注明位置" in prefsdef,
   "35.4 aiSystemPrompt 默认值含反编造与注明出处纪律")
ok('"你是一位严谨的学术研究助手' in prefsdef and "回答纪律：" in prefsdef,
   "35.5 aiSystemPrompt 是「人设+纪律」结构（非一句话人设）")
PROMPTS_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "prompts.js")
_prompts_js = io.open(PROMPTS_JS, encoding="utf-8").read()
ok(_prompts_js.count('name: "') == 8,
   "35.6 技能库内置恰 8 个（chat-float 快捷标签取前 8，防被截断；0.47.0 增「术语与缩写」）")
ok("方法深挖" in _prompts_js and "下一步研究" in _prompts_js and "术语与缩写" in _prompts_js,
   "35.6b 新技能「方法深挖」「下一步研究」「术语与缩写」在库")
CHAT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "chat.js")
_chat_js = io.open(CHAT_JS, encoding="utf-8").read()
ok("研究问题" in _chat_js and "结论与边界" in _chat_js and "只写论文里有的内容" in _chat_js,
   "35.7 summarize 四要素结构化（问题/方法/结果/边界）+ 不补写纪律")
# 0.73.0：translate.js 已拆为「5 子模块 + 门面」，复用 §22 的模块整体拼接读（tr_js）
_tr_js = tr_js
ok("术语表（以下术语必须按给定译法翻译" in _tr_js and "上一段的译文" in _tr_js,
   "35.8 translate.js 术语表与上下文注入未随优化丢失")
RP_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js")
_rp2 = io.open(RP_JS, encoding="utf-8").read()
ok("禁止使用任何 Markdown 标记" in _rp2,
   "35.9 划词浮窗纯文本禁令仍在（防 Markdown 标记泄漏到浮窗）")
ok("论证中的作用" in _rp2,
   "35.10 浮窗解读两段式（在讲什么 + 论证作用）")


# ---------- 33. 对照翻译导出（0.39.0：双语 PDF 附件 / HTML / Markdown / Word） ----------

PE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-export.js")
ok(os.path.exists(PE_JS), "33.1 pdf-export.js 存在")
_pe_js = io.open(PE_JS, encoding="utf-8").read() if os.path.exists(PE_JS) else ""
_pe_test = os.path.join(TEST_DIR, "pdf-export.test.js")
ok("pdf-export.js" in mainjs, "33.2 main.js 注册 pdf-export.js")
ok(mainjs.find('"features/pdf-inline.js"') < mainjs.find('"features/pdf-export.js"'),
   "33.3 ★ 装配序：导出模块在内核 pdf-inline.js 之后（要读它的 state）")
ok("PdfExport.exportAs" in pd_mod, "33.4 pdf-dual 经 PdfExport.exportAs 导出（不在窗口里塞业务）")
ok("exportAs: (kind) => this.exportAs(kind, item, title)" in pd_mod,
   "33.5 ★ 载荷把 exportAs 注入窗口（窗口不直连 PdfExport/附件 API）")
ok('id="pp-pd-export"' in pd_xhtml and "<menulist" in pd_xhtml,
   "33.6 窗口工具栏有导出菜单（menulist，与 compare 窗口同款）")
for _v in ["pdf", "html", "md", "docx"]:
    ok('value="%s"' % _v in pd_xhtml, "33.7 导出菜单含 %s 项" % _v)
ok("window.ppDualExport" in pd_view, "33.8 窗口导出入口 window.ppDualExport(kind)")
ok('exp.addEventListener("command", onExportPick)' in pd_view,
   "33.8b ★ 导出菜单绑 command（XUL menulist 事件名——0.39/0.40 只绑 change，真机点了没反应）")
ok('exp.addEventListener("change", onExportPick)' in pd_view,
   "33.8c 同时兜住 change（双绑且靠清空 value 幂等）")
ok("A.exportAs(kind)" in pd_view, "33.9 窗口导出经注入回调回插件作用域")
ok("setLabelAndText" in pd_view and 'opt("pp-pd-exp-pdf"' in pd_view,
   "33.10 ★ 菜单项文案走文案表（中英双语，不硬编码）")
ok("buildImagePdf" in _pe_js and "/DCTDecode" in _pe_js,
   "33.11 ★ 零依赖自建 PDF：JPEG 以 /DCTDecode 内嵌（不引 npm 包，守零依赖约束）")
ok("Zotero.Attachments.importFromFile" in _pe_js,
   "33.12 ★ 双语 PDF 走 importFromFile 挂到条目下（与补全文同一条通道）")
ok("Zotero.File.zipDirectory(" not in _pe_js and "nsIZipWriter" in _pe_js,
   "33.13 ★ docx 自建 zip（不用 zipDirectory —— 它跳过点文件，会漏掉 OOXML 必需的 _rels/.rels）")
ok("\"_rels/.rels\"" in _pe_js and "addEntryFile" in _pe_js,
   "33.13b ★_rels/.rels 在部件表里 + addEntryFile 显式条目名（点文件能进包）")
ok("[Content_Types].xml" in _pe_js and "word/document.xml" in _pe_js,
   "33.14 docx 部件齐全（content-types / rels / document）")
ok("modeSave" in _pe_js and "fp.open(" in _pe_js, "33.15 文本类导出用文件选择器保存（含取消路径）")
ok(os.path.exists(_pe_test), "33.16 导出单测存在（test/pdf-export.test.js）")
ok("buildImagePdf" in (io.open(_pe_test, encoding="utf-8").read() if os.path.exists(_pe_test) else ""),
   "33.17 ★ 单测覆盖 PDF 生成器（xref / 流长度 / 流式偏移结构自校验）")

# ---------- 34. 期刊分区列：内置 Key 的套餐门控（插件 0.41.0） ----------
# 内置 easyScholar SecretKey 由运营者持有、消耗运营者配额。0.41.0 起改为
# 「自带 Key 永远优先；已登录的 Pro / 试用期可用内置 Key；免费版与未登录须自带」。
# 这里钉死三件事：判定同时看登录态与套餐、探测不到时放行、以及**内置 Key 不被绕过**。
_rk_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "columns", "rank-column.js"),
                 encoding="utf-8").read()
ok("_officialKeyAllowed" not in _rk_js,
   "34.1 0.56.0：内置 Key 的套餐门控已移除（Key 只认用户自备）")
ok("ES_OFFICIAL_KEY" not in _rk_js,
   "34.2 ★ 内置官方 Key 常量已删除（第三方 Key 无商用授权，不能随包分发）")
ok('Prefs.get("easyScholarKey"' in _rk_js,
   "34.3 Key 唯一来源是用户 pref easyScholarKey")
ok('return "need_key"' in _rk_js,
   "34.4 ★ 未填 Key ⇒ esStatus 返回 need_key（设置页给出可执行指引，不静默空白）")
ok("esStatus" in _rk_js, "34.5 提供 esStatus() 供设置页给出可执行指引")
_rek_refs = _rk_js.count("ES_OFFICIAL_KEY")
ok(_rek_refs == 0,
   "34.6 ★ 源码中零处引用内置 Key（防止死灰复燃，实际 %d 处）" % _rek_refs)
ok("esStatus" in io.open(os.path.join(ROOT, "chrome", "content", "prefs-pane.js"),
                         encoding="utf-8").read(),
   "34.7 设置页状态行展示门控状态（免费版不会只看到空白以为坏了）")
ok(os.path.exists(os.path.join(ROOT, "test", "rank-gate.test.js")),
   "34.8 门控单测存在（test/rank-gate.test.js）")

# ---------- 35. 中文文献 AI 增强四层（插件 0.42.0，P1-P3） ----------
# jasminum 分析落地（docs/jasminum-cnki-analysis-and-ai-proposal.md）：
#   L1 检索词规划 / L3 语义裁决 / L4 元数据融合（GetExport 双通道）/ P3 兜底与自愈。
# 核心纪律：协议层（签名/Cookie/检索参数）确定性代码，LLM 不碰；
# AI 全部输出过 JSON 校验 + 字段白名单，兜底识别恒带 unverified 标记。
_cn_ai = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "cn-ai.js"),
                 encoding="utf-8").read()
_cn_f = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "cn-fetch.js"),
                encoding="utf-8").read()
ok("fallbackPlan" in _cn_ai and "parsePlan" in _cn_ai and "buildPlannerMessages" in _cn_ai,
   "35.1 L1 规划三件套（提示词/解析/启发式回退）在 CNAI 里")
ok("parseJudgment" in _cn_ai and "decide" in _cn_ai and '"reject"' in _cn_ai,
   "35.2 L3 裁决置信度分档（auto/confirm/reject/manual）在 CNAI 里")
ok("fuseMeta" in _cn_ai and "数据库为准" in _cn_ai,
   "35.3 L4 融合在 CNAI 里且注释钉死「数据库为准」纪律")
ok("parseRecognized" in _cn_ai and "_unverified: true" in _cn_ai,
   "35.4 ★ P3 兜底识别恒带 unverified 标记（未与数据库核对不得静默入库）")
ok("parseRescueResults" in _cn_ai and "CNKI-LLM" in _cn_ai,
   "35.5 P3 自愈解析在（来源标 CNKI-LLM 便于审计）")
ok("_renderPagesPNG" in _cn_ai and "pdf-render-worker.js" in _cn_ai,
   "35.6 视觉路径渲染走随包 worker（chrome://papilot/content/scripts/pdf-render-worker.js）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "scripts", "pdf-render-worker.js")),
   "35.7 pdf-render-worker.js 已随包（视觉路径缺它即静默 null）")
ok('cnFetchAIVision", false' in prefsdef,
   "35.8 ★ 视觉路径 pref 默认关（实验特性，先灰度）")
ok('cnFetchAI", true' in prefsdef and 'cnFetchAIJudge", true' in prefsdef
   and 'cnFetchCNKIExport", true' in prefsdef,
   "35.9 AI 增强三开关 pref 默认值在 prefs.js")
_mj_cn_ai = mainjs.find("features/cn-ai.js")
_mj_cn_fetch = mainjs.find("features/cn-fetch.js")
ok(_mj_cn_ai > 0 and 0 < _mj_cn_ai < _mj_cn_fetch,
   "35.10 ★ main.js 中 cn-ai.js 必须排在 cn-fetch.js 之前（cn-fetch 消费 CNAI）")
ok("_getExportEndNote" in _cn_f and "_parseEndNote" in _cn_f
   and "dm8/API/GetExport" in _cn_f,
   "35.11 P2 GetExport 双通道（导出接口反爬弱于详情页，是兜底也是补全）")
ok("CNAI.fuseMeta(dbMeta, pick, plan)" in _cn_f,
   "35.12 融合顺序 = EndNote 权威 > 搜索结果 > AI 规划（只填空）")
ok("structureChanged" in _cn_f and "CNAI.rescue" in _cn_f,
   "35.13 CNKI 结构改版 → rescue 自愈接线在 _fetchForItem 里")
ok("pdfDown1" in _cn_f and "oversea.cnki.net" in _cn_f,
   "35.14 PDF 直链兼容 oversea #pdfDown 锚点")
ok("CNAI.judge" in _cn_f and "cnAIAutoThreshold" in _cn_f and "cnAIConfirmThreshold" in _cn_f,
   "35.15 L3 裁决接入 _fetchForItem 且阈值走 pref")
ok("CNAI.recognize(item)" in _cn_f and "AI-recognized, unverified" in _cn_f,
   "35.16 ★ 检索全灭 → AI 兜底 + extra 写 unverified 标记")
_pf5 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/cn-ai.test.js" in _pf5, "35.17 preflight 含中文文献 AI 增强测试")
ok(os.path.exists(os.path.join(ROOT, "test", "cn-ai.test.js")),
   "35.18 cn-ai 单测存在（test/cn-ai.test.js）")

# ---------- 0.43.0 知网账号登录（CNAuth）与反爬基础 ----------
ok("var CNAuth" in _cn_f and "loginSilent" in _cn_f and "loginInteractive" in _cn_f,
   "36.1 CNAuth 模块在 cn-fetch.js（静默 + 交互双通道）")
ok("TopLoginCore/api/LoginApi/LoginPo" in _cn_f and "SM2_PUBKEY" in _cn_f
   and "t8b52yrsoyx66f35tk0p4nubrmrcglv5" in _cn_f and '"appID": "LoginWap"' in _cn_f,
   "36.2 ★ 登录协议三要素齐全（LoginPo 端点 / SM2 公钥 / 签名密钥与 appID）")
ok("cnkiUsername" in prefsdef and 'cnkiPassword", ""' in prefsdef,
   "36.3 ★ 凭据 pref 默认空值（凭据只进本机 profile，绝不进 git）")
ok("parseLoginCookie" in _cn_f and "parseLoginStatus" in _cn_f
   and "Ecp_LoginStuts" in _cn_f and "c_m_Lin" in _cn_f,
   "36.4 登录态判定走 cookie（Ecp_LoginStuts 主 + c_m_Lin 兜底，纯函数可离线测）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "scripts", "vendor", "sm2.js")),
   "36.5 vendor/sm2.js 存在（sm-crypto UMD，与知网官方登录页同款库）")
_sm2f = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "vendor", "sm2.js"),
                encoding="utf-8").read()
ok("doEncrypt" in _sm2f and "exports.sm2" in _sm2f,
   "36.6 vendor sm2 是 UMD 打包且含 doEncrypt（loadSubScript 式 scope 可挂载）")
ok('UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0)' in _cn_f
   and "MIN_INTERVAL_MS: 3000" in _cn_f and "_cnkiHeaders" in _cn_f,
   "36.7 ★ CNKI 全链路桌面 UA + kns 3s 限速（Zotero 默认 UA 会被 WAF 一眼识破）")
ok("CNAuth.ensureLogin({ silent: true })" in _cn_f,
   "36.8 抓取链路接入静默登录（搜索分支 + _tryCNKIPdf 两处）")
ok('"menuCNLogin"' not in menus_js and "menuCNLogin:" in utils_js,
   "36.9 ★ 0.43.1 登录类收敛：右键/工具菜单无 cn-login（文案保留供面板用）")
ok("IpLoginPo" in _cn_f and "ipLogin" in _cn_f and "detectAccess" in _cn_f,
   "36.14 ★ 校园网 IP 登录通道（IpLoginPo 无账号参数，validate.js SubmitCheck2 同款）+ 权限三态探测")
ok(os.path.exists(os.path.join(ROOT, "test", "cn-auth.test.js")),
   "36.10 cn-auth 单测存在（test/cn-auth.test.js）")
ok("test/cn-auth.test.js" in _pf5,
   "36.11 preflight 含知网登录测试")
ok("PP.cnAuth.loginInteractive()" in hub_js,
   "36.12 功能中心（Hub）保留「知网账号登录」入口卡（全能入口，与右键菜单分离）")
ok("this.cnAuth = CNAuth" in mainjs,
   "36.13 main.js 暴露 cnAuth（面板/Hub/排障经 Zotero.Papilot 访问）")
# 设置面板「知网账号」卡片（0.43.1）
_prefs_xhtml = io.open(os.path.join(ROOT, "chrome", "content", "prefs.xhtml"), encoding="utf-8").read()
ok('data-fold="cnki"' in _prefs_xhtml and 'id="pp-cnki-login-btn"' in _prefs_xhtml
   and 'id="pp-cnki-status"' in _prefs_xhtml and 'id="pp-cnki-detect-btn"' in _prefs_xhtml,
   "36.15 ★ 设置面板有「知网账号」卡片（状态行 + 登录按钮 + 权限检测按钮）")
ok('id="pp-cnki-verify-btn"' in _prefs_xhtml and 'id="pp-cnki-translators-btn"' in _prefs_xhtml,
   "36.16 风控验证/转换器更新按钮在面板（菜单已撤）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "prefs-cnki.js")),
   "36.17 面板脚本 prefs-cnki.js 存在")
ok("prefs-cnki.js" in mainjs,
   "36.18 main.js 注册 prefs-cnki.js 到设置面板脚本列表")
ok("loginFromPanel" in _cn_f,
   "36.19 面板登录走 loginFromPanel（不弹对话框，面板已填凭据）")
ok('data-fold="account"' in _prefs_xhtml and 'pp-cnki-status' in _prefs_xhtml,
   "36.20 知网卡片在账号分类下（账号卡片之后）")
ok("cnkiBootSelfTest" in prefsdef and "bootSelfTest" in _cn_f
   and "cnkiBootSelfTest" in mainjs,
   "36.21 ★ 启动自检三端接线（pref 默认关 / CNAuth.bootSelfTest / main.js 条件调度）")
# 0.43.2 防窥屏升级：接口地址无明文出口 + 完全隐藏
_pacc = io.open(os.path.join(ROOT, "chrome", "content", "prefs-account.js"), encoding="utf-8").read()
ok('showFullUrl()' not in _pacc and 'return maskUrl(u || "—")' in _pacc,
   "36.22 ★ 防窥屏：displayUrl 恒掩码（0.14.7 的明文开关出口已移除）")
ok('"***.***.***"' in _pacc,
   "36.23 掩码升级完全隐藏（主机名整体打码，防厂商/域名侧信道）")
ok('pp-ch-show-url' not in _prefs_xhtml and 'pp-ch-show-url' not in _pacc,
   "36.24 prefs.xhtml 已无「显示完整接口地址」勾选框")
ok('留空保持原地址' in _pacc,
   "36.25 编辑通道 baseUrl 不回填明文（留空=保持原地址，同密钥模式）")
_pcj = io.open(os.path.join(ROOT, "chrome", "content", "prefs-cnki.js"), encoding="utf-8").read()
ok("cnAuth().logout()" in _pcj and "logout" in _cn_f,
   "36.26 「清除凭据/退出登录」清 prefs 凭据 + cnki.net 会话 cookie（台账一致）")
ok("清除凭据/退出登录" in _prefs_xhtml,
   "36.27 按钮文案与行为一致（清除凭据/退出登录）")

# ---------- 37. 0.44.0（实验）第三方文献源（Pro 试用）----------
# 实验功能：模块装配 / 面板卡片 / 菜单注册 / Pro 软门控（判定不出时放行）/ 默认关闭。
_ts_path = os.path.join(ROOT, "chrome", "content", "scripts", "features", "third-source.js")
ok(os.path.exists(_ts_path), "37.1 third-source.js 存在")
_ts_js = io.open(_ts_path, encoding="utf-8").read() if os.path.exists(_ts_path) else ""
ok('"features/third-source.js"' in mainjs, "37.2 main.js 装配清单含 features/third-source.js")
ok("this.thirdSource = ThirdSource;" in mainjs, "37.3 main.js 暴露 thirdSource")
ok('"chrome/content/prefs-third-source.js"' in mainjs, "37.4 设置面板注册 prefs-third-source.js")
_pts_path = os.path.join(ROOT, "chrome", "content", "prefs-third-source.js")
ok(os.path.exists(_pts_path), "37.5 prefs-third-source.js 存在")
_pts_js = io.open(_pts_path, encoding="utf-8").read() if os.path.exists(_pts_path) else ""
ok('data-fold="thirdsrc"' in prefs_xhtml and 'id="pp-ts-ping-btn"' in prefs_xhtml
   and 'id="pp-ts-enabled"' in prefs_xhtml and 'id="pp-ts-endpoints"' in prefs_xhtml,
   "37.6 ★ 设置面板有「第三方文献源」卡片（启用开关 + 网点列表容器 + 检测按钮）")
ok('{ id: "third-source", group: "cn", labelKey: "menuThirdSource", run: () => ThirdSource.openSettings() }' in menus_js,
   "37.7 菜单注册 third-source（中文文献工具组 → 打开设置面板网点卡片）")
ok("menuThirdSource:" in utils_js, "37.8 I18n 表含 menuThirdSource 文案")
for _k in ["thirdSourceEnabled", "thirdSourceSite", "thirdSourceUsername", "thirdSourcePassword",
           "thirdSourceLastTest", "thirdSourceEntitlements", "thirdSourceEndpointCheck"]:
    ok(("papilot.%s" % _k) in prefsdef, "37.9 prefs.js 含 %s 默认值" % _k)
ok('pref("extensions.zotero.papilot.thirdSourceEnabled", false);' in prefsdef,
   "37.10 ★ 实验功能默认关闭")
ok("proGate()" in _ts_js and '"not-logged-in"' in _ts_js and "unknown-allow" in _ts_js,
   "37.11 ★ Pro 软门控（判定不出时放行；仅明确非 Pro 拦截）")
ok("parseLoginResult" in _ts_js and "只能一人在线" in _ts_js,
   "37.12 登录结果纯函数解析（含单会话话术识别）")
_pts_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', _pts_js))
_pts_missing = sorted(i for i in _pts_used if i not in xhtml_ids)
ok(not _pts_missing,
   "37.13 prefs-third-source.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_pts_missing or "无"))
_pf_ts = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/third-source.test.js" in _pf_ts, "37.14 preflight 含第三方文献源测试")
# 0.44.2 → 0.45.0：公开入口导航（四组）+ 带检索词直达
ok('id="pp-ts-endpoints"' in prefs_xhtml and 'id="pp-ts-ping-btn"' in prefs_xhtml,
   "37.15 ★ 卡片含「入口列表容器」与「检测入口」按钮")
ok("ENDPOINTS" in _ts_js and "openEndpoint" in _ts_js and "checkEndpoints" in _ts_js
   and "readEndpointCheck" in _ts_js,
   "37.16 ★ 模块内置入口清单 + 打开/检测/缓存读取（无需账号）")
ok("实验功能" in prefs_xhtml and "文献虫" not in prefs_xhtml and "毕业助手" not in prefs_xhtml,
   "37.17 ★ 面板只保留「实验功能」提示，不出现任何来源站点名（来源注释词已清理）")
ok("thirdSourceEndpointCheck" in prefsdef, "37.18 检测结果缓存 pref 存在")
ok('id="pp-ts-query"' in prefs_xhtml and 'id="pp-ts-query-hint"' in prefs_xhtml,
   "37.19 ★ 卡片含检索词输入框（DOI / 标题带入检索）")
ok("GROUPS:" in _ts_js and "grouped()" in _ts_js and "urlFor(" in _ts_js and "canSearch(" in _ts_js,
   "37.20 ★ 入口按四组组织 + 检索模板（urlFor/canSearch 纯函数）")
ok("probe !== false" in _ts_js and "CHECK_CONCURRENCY" in _ts_js,
   "37.21 检测跳过 probe:false 的站点并限并发（不误报不可达）")
ok("_other" in _ts_js, "37.22 入口漏写 group 时兜底进「其它」组（不静默消失）")

# ---------- 38. v1.8.0 启动控制台（侧栏导航 + 计费口径 + 日志双轨） ----------
# 设计：docs/启动控制台-v1.8.0-重构设计.md
_launcher_path = os.path.join(ROOT, "scripts", "launcher.ps1")
_launcher = io.open(_launcher_path, encoding="utf-8-sig").read()
for _pid in ["overview", "services", "billing", "ops", "about"]:
    ok(("id = '%s'" % _pid) in _launcher, "38.1 控制台导航含 %s 页" % _pid)
ok("New-UiPage 'overview'" in _launcher and "New-UiPage 'billing'" in _launcher
   and "New-UiPage 'ops'" in _launcher, "38.2 ★ 五个分页已构建（侧栏切换）")
for _f in ["balanceEnforce", "signupGrantMicro", "meteringGaps", "onlinePay", "backlogCount"]:
    ok(_f in _launcher, "38.3 控制台消费 health.%s" % _f)
ok("dailyLimit" not in _launcher,
   "38.4 ★ 控制台不再出现 dailyLimit（1.8.0 已取消每日次数上限）")
ok("monthlyGrantMicro" in _launcher and "每月额度" in _launcher,
   "38.5 ★ 套餐页按「每月额度」编辑（不再编辑次数）")
ok("server-stdout.log" in _launcher,
   "38.6 ★ stdout 重定向到 server-stdout.log（不锁 server-console.log）")
ok("launcher-audit.jsonl" in _launcher, "38.7 控制台操作写本地审计")
ok("ShowBalloonTip" in _launcher, "38.8 托盘状态告警（掉线/积压）")
_start_ps1 = io.open(os.path.join(ROOT, "scripts", "start-account-server.ps1"), encoding="utf-8-sig").read()
ok("server-stdout.log" in _start_ps1, "38.9 start-account-server 同步日志双轨")
ok(os.path.exists(os.path.join(ROOT, "docs", "启动控制台-v1.8.0-重构设计.md")),
   "38.10 控制台设计文档在库（本次/后续边界可追溯）")
_p1 = _launcher.find('if ($r.plans.ai) { $script:mbAiTrialDays')
_p2 = _launcher.find('$txtTrialDays.Text = [string]$script:mbAiTrialDays')
ok(_p1 >= 0 and _p2 >= 0 and _p1 < _p2,
   "38.11 ★ 试用天数先取服务端值再写控件（顺序反了会把 7 天误关成 0）")
ok("Get-AutoBootServices" in _launcher and "Start-ServicesOnBoot" in _launcher
   and "bootTimer" in _launcher,
   "38.12 ★ 控制台启动后默认拉起后台与通道（可在维护页关闭）")
ok("papilot-launcher-boot.log" in _launcher and "FATAL: " in _launcher
   and "DefaultDesktopOnly" in _launcher,
   "38.13 启动日志 + 致命错误弹窗（wscript 隐藏启动也能排障）")
ok("[PpWin32]::FindWindow([IntPtr]::Zero" in _launcher,
   "38.14 ★ 重复启动时激活已有窗口（$null 传给 string 会变空串→找不到窗口）")
_bat = io.open(os.path.join(ROOT, "启动Papilot后台.bat"), encoding="gbk").read()
ok(":pp_probe" in _bat and "tasklist.exe" in _bat and "papilot-launcher.pid" in _bat,
   "38.15 ★ bat 启动后做 PID 存活确认（wscript 返回 0 ≠ 真的起来了）")
ok("Test-PortOpen" in _launcher and "Get-TunnelProcessCached" in _launcher,
   "38.16 轮询走快探测/缓存（不再每拍 Get-NetTCPConnection + CIM）")

# ---------- 39. 0.46.0 AI 打标签 v2（结构化输出 + 受控词表 + 缓存） ----------
# 参考 Karakeep（词表注入 + normalizeTag 对齐 + 结构化输出）与 Paperless-ngx（语言可控）。
_at_path = os.path.join(ROOT, "chrome/content/scripts/ai/auto-tag.js")
_at_js = io.open(_at_path, encoding="utf-8").read()
_at_prev_js = io.open(os.path.join(ROOT, "chrome/content/tag-preview.js"), encoding="utf-8").read()
_at_prev_x = io.open(os.path.join(ROOT, "chrome/content/tag-preview.xhtml"), encoding="utf-8").read()
ok("_parseStructured" in _at_js and "_extractBalanced" in _at_js,
   "39.1 ★ AI 回复结构化解析（JSON 优先 + 平衡括号抽取，围栏/包装容错）")
ok("buildPrompt" in _at_js and '"confidence"' in _at_js,
   "39.2 ★ 提示词要求 JSON 结构化输出（tag/reason/confidence）")
ok("this._parseHashTokens(text).map" in _at_js,
   "39.3 ★ 降级链只认显式 #token（拒答散文不再被写成垃圾标签）")
ok("_collectVocabulary" in _at_js and "VOCAB_TTL_MS" in _at_js,
   "39.4 ★ 受控词表（库内高频标签注入 + TTL 内存缓存，扫描不重复）")
ok("_alignToVocabulary" in _at_js and "_shapeKey" in _at_js,
   "39.5 ★ 词表对齐（shape 键命中复用库内原样写法，杜绝同义变体）")
ok("_fingerprint" in _at_js and "_cachePut" in _at_js and "CACHE_MAX" in _at_js,
   "39.6 ★ 建议缓存（元数据指纹 + LRU 上限 + 损坏静默恢复）")
ok("async suggest(item)" in _at_js and "suggestDetailed" in _at_js,
   "39.7 ★ suggest() 兼容层保留（automation.js 的 aiAutoTag 动作不改自升级）")
for _k in ["autoTagUseVocab", "autoTagCache", "autoTagLang", "autoTagConfidenceThreshold", "autoTagCacheData"]:
    ok(("papilot.%s" % _k) in prefsdef, "39.8 prefs.js 含 %s 默认值" % _k)
ok('pref("extensions.zotero.papilot.autoTagLang", "auto");' in prefsdef,
   "39.9 ★ 标签语言默认 auto（跟随界面；中文用户行为不变）")
ok('id="pp-autotag-vocab"' in prefs_xhtml and 'id="pp-autotag-lang"' in prefs_xhtml
   and 'id="pp-autotag-threshold"' in prefs_xhtml and 'id="pp-autotag-cache"' in prefs_xhtml,
   "39.10 ★ 设置面板 6.2 组含 v2 四项设置（词表/缓存/语言/阈值）")
ok('id="pp-tag-existing"' in _at_prev_x and "pp-tag-existing" in _at_prev_js,
   "39.11 ★ 勾选对话框展示「已有标签已排除」提示")
ok("threshold" in _at_prev_js and "confidence" in _at_prev_js,
   "39.12 ★ 勾选对话框按置信度预勾选并显示依据")
ok("_tagPassesRules" in _at_js and "GENERIC_NAMES" in _at_js,
   "39.13 新标签规则校验（类别白名单 + 宽泛词黑名单；词表命中豁免）")
ok(os.path.exists(os.path.join(ROOT, "test", "auto-tag.test.js")),
   "39.14 auto-tag v2 测试套件在库")
ok("DOMContentLoaded" in _at_prev_js and "readyState" in _at_prev_js,
   "39.15 ★ 勾选对话框等 DOM 就绪再渲染（0.45.99 真机：脚本先于 DOM 执行 → 空列表死按钮）")
_ri_js = io.open(os.path.join(ROOT, "chrome/content/ref-import.js"), encoding="utf-8").read()
ok("DOMContentLoaded" in _ri_js and "function boot()" in _ri_js,
   "39.16 ★ 参考文献入库对话框同款时序守卫（wire 不再裸跑）")
_cw_js2 = io.open(os.path.join(ROOT, "chrome/content/chat-window.js"), encoding="utf-8").read()
ok("DOMContentLoaded" in _cw_js2 and "function boot()" in _cw_js2 and "readyState" in _cw_js2,
   "39.17 ★ AI 问答分屏窗口同款时序守卫（0.47.0 真机探针实锤：旧版脚本先于 DOM 执行，"
   "sendBtn 为 null 直接 TypeError，事件绑定从未生效＝「无法发送」的真因）")
ok("no-native" in io.open(os.path.join(ROOT, "chrome/content/chat-window.xhtml"), encoding="utf-8").read(),
   "39.18 ★ 分屏窗口输入框带 no-native 豁免（平台皮肤劫持＝「一片蓝色」的真因）")

# ---------- 40. 0.48.0 Agent 模式 + 设置面板扩展 + 分区标题修复 ----------
# 交互设计参考开源项目 Hermes Agent：任务规划（协议里要求先列计划）、工具调用
# （提示词约定 JSON 协议，不依赖原生 function calling）、多轮上下文管理（历史轮数
# 可配滑窗）。守卫盯：装配顺序、面板脚本接线、pref 默认值、CSS 遮挡修复不回归。
AT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "agent-tools.js")
ok(os.path.exists(AT_JS), "40.1 AgentTools 模块存在（ai/agent-tools.js）")
_at_js = io.open(AT_JS, encoding="utf-8").read() if os.path.exists(AT_JS) else ""
ok('"ai/agent-tools.js"' in mainjs,
   "40.2 main.js 装载清单含 agent-tools.js")
ok(mainjs.find('"ai/chat.js"') < mainjs.find('"ai/agent-tools.js"'),
   "40.3 装载顺序：agent-tools.js 在 ai/chat.js 之后（依赖 getFullText/paperMeta）")
ok("this.agentTools = AgentTools" in mainjs and "this.commandTags = CommandTags" in mainjs,
   "40.4 main.js 暴露 agentTools / commandTags（设置面板 prefs-agent.js 经此访问）")
ok("prefs-agent.js" in mainjs, "40.5 main.js 注册 prefs-agent.js（设置面板 scripts 列表）")
_cf_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "panels",
                               "chat-float.js"), encoding="utf-8").read()
ok("AgentTools.runAgentLoop" in _cf_src and "_agentReady" in _cf_src,
   "40.6 chat-float 接入 Agent 循环（_agentReady 门控 + runAgentLoop 分流）")
ok("SlashCommands.attach" in _cf_src and "_slashCommands" in _cf_src,
   "40.7 chat-float 挂「/」命令面板（SlashCommands.attach + 命令清单）")
ok("isOpen" in _cf_src and "entry.slash" in _cf_src,
   "40.8 命令面板打开时 Enter/↑↓ 让位（entry.slash.isOpen 门控，防与输入历史冲突）")
ok("AIChat.windowHistory" in _cf_src and "history.slice(-12)" not in _cf_src,
   "40.9 chat-float 历史窗口走 AIChat.windowHistory（旧硬编码 slice(-12) 已清除）")
_chat_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "chat.js"),
                   encoding="utf-8").read()
ok(_chat_js.count("this.windowHistory(history") == 2 and "history.slice(-12)" not in _chat_js,
   "40.10 ai/chat.js 历史窗口化（buildMessages/ask 两处均走 windowHistory）")
_client_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "client.js"),
                     encoding="utf-8").read()
ok("_sampleParams" in _client_js and _client_js.count("...this._sampleParams()") == 2,
   "40.11 AIClient 两处 payload（chat/流式）统一走 _sampleParams（含可选 top_p）")
PA_JS = os.path.join(ROOT, "chrome", "content", "prefs-agent.js")
ok(os.path.exists(PA_JS), "40.12 prefs-agent.js 存在（AI 参数卡片扩展脚本）")
_pa_js = io.open(PA_JS, encoding="utf-8").read() if os.path.exists(PA_JS) else ""
for _eid in ("pp-agent-tools", "pp-agent-mode", "pp-agent-confirm", "pp-sysprompt",
             "pp-syspreset-strict", "pp-syspreset-critical", "pp-syspreset-explain",
             "pp-syspreset-reset", "pp-agent-tags", "pp-tags-export", "pp-tags-import"):
    ok(_eid in xhtml_ids, "40.13 prefs.xhtml 含 #%s" % _eid)
ok('id="pp-sysprompt"' in prefs_xhtml and
   'preference="extensions.zotero.papilot.aiSystemPrompt"' in prefs_xhtml,
   "40.14 System Prompt textarea 保留 preference= 声明式绑定并带 id（预设按钮写入用）")
# aiAgentTools 为 CSV 白名单，由 prefs-agent.js chips 读写（无声明式绑定，40.17 盯两端）
for _pk in ("aiHistoryRounds", "aiTopP", "chatAgentMode", "aiAgentMaxSteps",
            "aiAgentConfirmWrite"):
    ok('preference="extensions.zotero.papilot.%s"' % _pk in prefs_xhtml,
       "40.15 prefs.xhtml 声明式绑定 %s" % _pk)
    ok('pref("extensions.zotero.papilot.%s"' % _pk in prefsdef,
       "40.16 prefs.js 有 %s 默认值" % _pk)
ok('pref("extensions.zotero.papilot.aiAgentTools"' in prefsdef,
   "40.16b prefs.js 有 aiAgentTools 默认值（CSV 白名单）")
ok("aiAgentTools" in _pa_js and "aiAgentTools" in _at_js,
   "40.17 工具白名单 pref 两端一致（面板写 / AgentTools 读）")
ok("search_library" in _at_js and "add_note" in _at_js and "add_tags" in _at_js,
   "40.18 AgentTools 注册表含核心工具（检索/读全文/加笔记/打标签）")
ok("runAgentLoop" in _at_js and "callLLM" in _at_js and "runTool" in _at_js,
   "40.19 runAgentLoop 依赖注入（callLLM/runTool 可 mock，测试不碰网络）")
ok("confirmWrite" in _at_js and "Services.prompt.confirm" in _at_js,
   "40.20 写操作确认走 Zotero 原生 confirm（协作模式）")
ok(os.path.exists(os.path.join(ROOT, "test", "agent-tools.test.js")),
   "40.21 Agent 工具层测试套件在库")
_preflight_src = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("agent-tools.test.js" in _preflight_src,
   "40.22 preflight 注册 agent-tools.test.js")
# ---------- 42. 0.48.1 技能包目录扩容 + 在线更新源 ----------
# 双源同构铁律：在线目录（server/public/skill-catalog.json）由 build-skill-catalog.js
# 从 _BUILTIN 唯一生成；数据更新 = 改 _BUILTIN → 跑生成器 → 两文件一起提交。
_CAT_PATH = os.path.join(ROOT, "server", "public", "skill-catalog.json")
ok(os.path.exists(_CAT_PATH), "42.1 在线目录 server/public/skill-catalog.json 在库")
_cat_ok = False
if os.path.exists(_CAT_PATH):
    try:
        _cat = json.loads(io.open(_CAT_PATH, encoding="utf-8").read())
        _cat_ok = isinstance(_cat, dict) and isinstance(_cat.get("packs"), list)
    except Exception:
        _cat_ok = False
ok(_cat_ok, "42.2 在线目录是合法 JSON 且含 packs 数组")
if _cat_ok:
    ok(len(_cat["packs"]) == 56, "42.3 在线目录 56 个技能包（8 类；0.71.x 审查批次 45 修订 + 11 新增）→ 实际 %d" % len(_cat["packs"]))
    _cat_ids = [p.get("id", "") for p in _cat["packs"]]
    ok(len(set(_cat_ids)) == len(_cat_ids), "42.4 在线目录 id 唯一")
    ok(all(re.match(r"^[a-z0-9][a-z0-9-]*$", i) for i in _cat_ids), "42.5 在线目录 id 均为 kebab-case")
    _cats = {}
    for _p in _cat["packs"]:
        _cats[_p.get("category", "?")] = _cats.get(_p.get("category", "?"), 0) + 1
    ok(len(_cats) == 8 and all(4 <= v <= 8 for v in _cats.values()),
       "42.6 八分类全覆盖且每类 4-8 个（0.71.x 上限放宽）→ %s" % json.dumps(_cats, ensure_ascii=False))
    ok(all(p.get("name") and p.get("version") and p.get("author") and p.get("desc")
           for p in _cat["packs"]), "42.7 每包必备字段齐全（name/version/author/desc）")
    ok(str(_cat.get("updatedAt", "")).isdigit(), "42.8 目录 updatedAt 为毫秒时间戳")
ok(os.path.exists(os.path.join(ROOT, "scripts", "build-skill-catalog.js")),
   "42.9 目录生成器 build-skill-catalog.js 在库（唯一生成通道）")
ok('pref("extensions.zotero.papilot.skillStoreSource", "https://gitee.com/' in prefsdef,
   "42.10 skillStoreSource 默认指向官方 Gitee raw 目录")
ok("server/public/skill-catalog.json" in prefsdef,
   "42.11 默认目录 URL 路径与仓库文件路径一致")
ok("build-skill-catalog.js" in _preflight_src,
   "42.12 preflight 注册目录同构门禁（--check 步骤）")
# 42.13-42.16：0.48.3 社区贡献工作流基建
ok(os.path.exists(os.path.join(ROOT, "community-packs", "README.md")),
   "42.13 社区贡献指南 community-packs/README.md 在库")
ok(os.path.exists(os.path.join(ROOT, "community-packs", "_TEMPLATE.json")),
   "42.14 技能包模板 _TEMPLATE.json 在库（_ 前缀 = 生成器忽略）")
ok(os.path.exists(os.path.join(ROOT, "scripts", "validate-pack.js")),
   "42.15 独立校验器 validate-pack.js 在库（贡献者自检 + CI 共用）")
ok(os.path.exists(os.path.join(ROOT, ".github", "workflows", "validate-pack.yml")),
   "42.16 CI 工作流 validate-pack.yml 在库（PR 自动校验社区包）")
ok(os.path.exists(os.path.join(ROOT, ".github", "ISSUE_TEMPLATE", "skill-pack.md")),
   "42.17 Issue 投稿模板在库（不会 Git 的贡献者通道）")
_bsc = io.open(os.path.join(ROOT, "scripts", "build-skill-catalog.js"), encoding="utf-8").read()
ok("community-packs" in _bsc and "loadCommunityPacks" in _bsc,
   "42.18 ★ 生成器双源合并（_BUILTIN + community-packs，合并 PR 后跑生成器即发布）")
_ss_js = io.open(os.path.join(ROOT, "chrome/content/skill-store.js"), encoding="utf-8").read()
ok("pp-ss-mk-submit" in _ss_js and "community-packs/README.md" in _ss_js,
   "42.19 商店制作器带「投稿到技能商店」入口（复制 JSON + 打开贡献指南）")
ok(re.search(r"installedIds:\s*state\.installedOnly\s*\?\s*installedIds\s*:\s*undefined", _ss_js) is not None,
   "42.20 ★ renderList 仅在「仅看已安装」时向 searchPacks 传 installedIds——"
   "searchPacks 契约是「给定时只留已装」，无条件传空 Set 会滤光全部目录包"
   "（0.48.0-0.48.3 商店列表始终为空的根因，0.48.4 修复）")

# ---------- 43. 0.49.0 八项功能批次（会话持久化/定时任务/工具扩容/审计撤销/沉淀/路由/画像/MCP桥） ----------
# 逐项盯「模块存在 + 装配 + 消费者接线 + pref 默认值」，防半成品重演。
_CS_JS = os.path.join(ROOT, "chrome/content/scripts/features/chat-sessions.js")
ok(os.path.exists(_CS_JS), "43.1 ChatSessions 模块在库（浮窗会话持久化）")
_cs_src = io.open(_CS_JS, encoding="utf-8").read() if os.path.exists(_CS_JS) else ""
ok("latestForItem" in _cs_src and "list(" in _cs_src and "save(" in _cs_src,
   "43.2 ChatSessions API 齐全（save/list/load/remove/latestForItem/latest）")
ok('"features/chat-sessions.js"' in mainjs and "this.chatSessions = ChatSessions" in mainjs,
   "43.3 main.js 装配并暴露 chatSessions")
ok("ChatSessions.save" in _cf_src and "_restoreSession" in _cf_src,
   "43.4 ★ chat-float 接入会话持久化（发送后保存 / 打开时恢复）")
ok('"history"' in _cf_src and 'id: "distill"' in _cf_src and "_distillLastTask" in _cf_src,
   "43.5 ★ 技能沉淀接线（/distill + /history 斜杠命令）")
ok("opts.model" in _client_js or "opts && opts.model" in _client_js,
   "43.6 AIClient 支持 {model} 覆盖（决策路由底座，两参调用兼容）")
ok("aiAgentDecisionModel" in _cf_src, "43.7 chat-float 决策模型路由（aiAgentDecisionModel）")
_SCH_JS = os.path.join(ROOT, "chrome/content/scripts/features/scheduler.js")
ok(os.path.exists(_SCH_JS), "43.8 Scheduler 模块在库（定时任务）")
_sch_src = io.open(_SCH_JS, encoding="utf-8").read() if os.path.exists(_SCH_JS) else ""
ok("checkDue" in _sch_src and "runJob" in _sch_src and "scheduleLastRun" in _sch_src,
   "43.9 Scheduler API（checkDue/runJob/state/lastRun 防重）")
ok('"features/scheduler.js"' in mainjs and "this.scheduler = Scheduler" in mainjs,
   "43.10 main.js 装配并暴露 scheduler")
ok("Scheduler.start()" in mainjs and "Scheduler.stop()" in mainjs,
   "43.11 ★ Scheduler 生命周期（启动即轮询 / destroy 停止）")
ok(os.path.exists(os.path.join(ROOT, "chrome/content/prefs-schedule.js")) and "prefs-schedule.js" in mainjs,
   "43.12 定时任务设置面板脚本在库并注册")
ok('id="pp-sch-rows"' in prefs_xhtml and 'data-fold="schedule"' in prefs_xhtml,
   "43.13 prefs.xhtml 定时任务卡片容器")
ok('id="pp-profile"' in prefs_xhtml and 'preference="extensions.zotero.papilot.researcherProfile"' in prefs_xhtml,
   "43.14 prefs.xhtml 研究者画像输入（声明式绑定）")
ok('id="pp-agent-decision-model"' in prefs_xhtml
   and 'preference="extensions.zotero.papilot.aiAgentDecisionModel"' in prefs_xhtml,
   "43.15 prefs.xhtml 决策模型输入（声明式绑定）")
for _pk in ("chatSessions", "aiAgentDecisionModel", "researcherProfile", "agentAuditLog",
            "scheduleDailyDigest", "scheduleWeeklyReport", "scheduleLibHealth", "scheduleLastRun"):
    ok('pref("extensions.zotero.papilot.%s"' % _pk in prefsdef,
       "43.16 prefs.js 有 %s 默认值" % _pk)
ok("search_arxiv" in prefsdef and "move_to_collection" in prefsdef and "export_bibliography" in prefsdef,
   "43.17 ★ aiAgentTools 默认 CSV 含 5 个新工具（11 工具）")
ok("auditList" in _at_js and "undoLast" in _at_js and "_confirmWrite" in _at_js,
   "43.18 ★ 写操作审计与撤销 API（auditList/undoLast/undoEntry）")
ok("skipConfirm" in _at_js and "_confirmWrite(head, detail, ctx)" in _at_js,
   "43.19 ★ ctx.skipConfirm 确认旁路（MCP 无 UI 通道）")
ok("list_agent_tools" in io.open(os.path.join(ROOT, "chrome/content/scripts/features/mcp.js"), encoding="utf-8").read()
   and "run_agent_tool" in io.open(os.path.join(ROOT, "chrome/content/scripts/features/mcp.js"), encoding="utf-8").read(),
   "43.20 ★ MCP 暴露 Agent 能力（list_agent_tools / run_agent_tool）")
ok("allowWrite" in io.open(os.path.join(ROOT, "chrome/content/scripts/features/mcp.js"), encoding="utf-8").read(),
   "43.21 ★ MCP 写操作 allowWrite 门控")
ok("search_arxiv" in _pa_js and "move_to_collection" in _pa_js,
   "43.22 prefs-agent.js 工具清单同步 11 项")
_chatjs = io.open(os.path.join(ROOT, "chrome/content/scripts/ai/chat.js"), encoding="utf-8").read()
ok("researcherProfile" in _chatjs and "研究者画像" in _chatjs,
   "43.23 ★ 研究者画像注入 _systemWith（所有单篇 AI 路径生效）")
ok("researcherProfile" in _cf_src, "43.24 多 chip 路径同款画像注入")
ok(os.path.exists(os.path.join(ROOT, "test", "chat-sessions.test.js"))
   and os.path.exists(os.path.join(ROOT, "test", "scheduler.test.js"))
   and os.path.exists(os.path.join(ROOT, "test", "mcp.test.js")),
   "43.25 三套新测试在库（会话/定时/MCP）")

# ---------- 44. 0.51.0（引用可点击 / Agent 记忆 / 相关文献） ----------
ok('pref("extensions.zotero.papilot.citeLinksEnabled", true)' in prefsdef,
   "44.1 citeLinksEnabled 默认开（回答引用可点击）")
ok("_citeRefsOf" in _cf_src and "_focusItem" in _cf_src and "_decorateCites" in _cf_src,
   "44.2 ★ chat-float 引用识别/装饰/定位三件套（纯函数 + 渲染路径）")
ok("pp-cf-cite" in _cf_src, "44.3 引用 chip 样式已挂")
_am_js = os.path.join(ROOT, "chrome/content/scripts/features/agent-memory.js")
ok(os.path.exists(_am_js), "44.4 AgentMemory 模块在库（长期记忆）")
_am_src = io.open(_am_js, encoding="utf-8").read() if os.path.exists(_am_js) else ""
ok("asPromptBlock" in _am_src and "add(" in _am_src and "search(" in _am_src,
   "44.5 AgentMemory API（add/list/search/remove/clear/asPromptBlock）")
ok('pref("extensions.zotero.papilot.agentMemory"' in prefsdef, "44.6 agentMemory pref 默认值")
ok('"features/agent-memory.js"' in mainjs and "this.agentMemory = AgentMemory" in mainjs,
   "44.7 main.js 装配并暴露 agentMemory")
ok("prefs-memory.js" in mainjs and os.path.exists(os.path.join(ROOT, "chrome/content/prefs-memory.js")),
   "44.8 设置面板记忆脚本在库并注册")
ok('id="pp-mem-list"' in prefs_xhtml and 'id="pp-mem-clear"' in prefs_xhtml,
   "44.9 prefs.xhtml 记忆列表与清空按钮容器")
ok("memory_read" in _at_js and "memory_write" in _at_js, "44.10 ★ 工具注册 memory_read/memory_write")
ok('memory_read,memory_write' in prefsdef, "44.11 aiAgentTools 默认 CSV 含两个记忆工具（13 工具）")
ok("memory_read" in _pa_js and "memory_write" in _pa_js, "44.12 prefs-agent.js 工具清单 13 项")
ok("长期记忆" in _chatjs and "asPromptBlock" in _chatjs, "44.13 ★ 单篇路径记忆注入 _systemWith")
ok("asPromptBlock" in _cf_src and "长期记忆" in _cf_src, "44.14 多 chip 路径记忆注入")
_rp_js = os.path.join(ROOT, "chrome/content/scripts/features/related-papers.js")
ok(os.path.exists(_rp_js), "44.15 RelatedPapers 模块在库")
_rp_src = io.open(_rp_js, encoding="utf-8").read() if os.path.exists(_rp_js) else ""
ok("register(" in _rp_src and "fetchFor" in _rp_src and "importPaper" in _rp_src,
   "44.16 RelatedPapers API（register/fetchFor/importPaper）")
_s2x = os.path.join(ROOT, "chrome/content/scripts/features/s2-client.js")
ok(os.path.exists(_s2x) and "recommendations" in io.open(_s2x, encoding="utf-8").read(),
   "44.17 S2Client 扩展 recommendations（幂等挂载）")
ok('pref("extensions.zotero.papilot.relatedPapersEnabled", true)' in prefsdef,
   "44.18 relatedPapersEnabled 默认开")
ok('"features/s2-client.js"' in mainjs and '"features/related-papers.js"' in mainjs
   and mainjs.find('"ai/semantic-scholar.js"') < mainjs.find('"features/s2-client.js"'),
   "44.19 main.js 装配顺序（semantic-scholar → s2-client 扩展 → related-papers）")
ok("RelatedPapers.register(id)" in mainjs and "RelatedPapers.unregister()" in mainjs,
   "44.20 ★ 相关文献面板注册/注销接线")
_ftl_zh = io.open(os.path.join(ROOT, "locale/zh-CN/papilot.ftl"), encoding="utf-8").read()
_ftl_en = io.open(os.path.join(ROOT, "locale/en-US/papilot.ftl"), encoding="utf-8").read()
ok("papilot-related-section-header" in _ftl_zh and "papilot-related-section-header" in _ftl_en,
   "44.21 ftl 双语文案（相关文献 section header 必需）")
ok("test/chat-sessions.test.js" in _preflight_src and "test/scheduler.test.js" in _preflight_src
   and "test/mcp.test.js" in _preflight_src and "test/agent-memory.test.js" in _preflight_src
   and "test/related-papers.test.js" in _preflight_src,
   "44.22 ★ preflight 注册五个新测试套件（补 0.50.0 漏注册）")
ok('id="pp-mem-result"' in prefs_xhtml, "44.23 记忆操作结果提示位")

# ---------- 45. 0.52.0（引文上下文 / 元数据医生 / 标注速记） ----------
menusjs_src = io.open(os.path.join(ROOT, "chrome/content/scripts/menus.js"), encoding="utf-8").read()
_cc_path = os.path.join(ROOT, "chrome/content/scripts/features/citation-context.js")
ok(os.path.exists(_cc_path), "45.1 CitationContext 模块在库（引文上下文）")
_cc_src = io.open(_cc_path, encoding="utf-8").read() if os.path.exists(_cc_path) else ""
ok("_classify" in _cc_src and "fetchFor" in _cc_src and "register(" in _cc_src,
   "45.2 CitationContext API（register/fetchFor/_classify 倾向判定）")
ok("citations" in io.open(os.path.join(ROOT, "chrome/content/scripts/features/s2-client.js"), encoding="utf-8").read(),
   "45.3 S2Client 扩展 citations（双模分派：兼容既有 citation-trace 旧语义）")
ok('pref("extensions.zotero.papilot.citationContextEnabled", true)' in prefsdef,
   "45.4 citationContextEnabled 默认开")
ok('"features/citation-context.js"' in mainjs and "CitationContext.register(id)" in mainjs
   and "CitationContext.unregister()" in mainjs,
   "45.5 ★ 引文上下文面板注册/注销接线")
ok("papilot-citecon-section-header" in io.open(os.path.join(ROOT, "locale/zh-CN/papilot.ftl"), encoding="utf-8").read()
   and "papilot-citecon-section-header" in io.open(os.path.join(ROOT, "locale/en-US/papilot.ftl"), encoding="utf-8").read(),
   "45.6 ftl 双语（引文上下文 section）")
_md_path = os.path.join(ROOT, "chrome/content/scripts/features/meta-doctor.js")
ok(os.path.exists(_md_path), "45.7 MetaDoctor 模块在库（元数据医生）")
_md_src = io.open(_md_path, encoding="utf-8").read() if os.path.exists(_md_path) else ""
ok("_titleSim" in _md_src and "_previewFor" in _md_src and "restoreFields" in _md_src,
   "45.8 MetaDoctor API（相似度/预览/restoreFields 审计）")
ok("restoreFields" in _at_js, "45.9 agent-tools 支持 restoreFields 撤销分派")
ok('"features/meta-doctor.js"' in mainjs and "this.metaDoctor = MetaDoctor" in mainjs,
   "45.10 main.js 装配并暴露 metaDoctor")
ok('"meta-doctor"' in menusjs_src and "menuMetaDoctor" in menusjs_src and "menuMetaDoctor" in io.open(os.path.join(ROOT, "chrome/content/scripts/core/utils.js"), encoding="utf-8").read(),
   "45.11 ★ 菜单项接入（META_ITEMS + 右键 + I18n）")
_ad_path = os.path.join(ROOT, "chrome/content/scripts/features/annotation-digest.js")
ok(os.path.exists(_ad_path), "45.12 AnnotationDigest 模块在库（标注速记）")
_ad_src = io.open(_ad_path, encoding="utf-8").read() if os.path.exists(_ad_path) else ""
ok("collect(" in _ad_src and "buildPrompt" in _ad_src and "MAX_NOTES" in _ad_src,
   "45.13 AnnotationDigest API（collect/buildPrompt/run 证据纪律契约）")
ok('pref("extensions.zotero.papilot.annotationDigestEnabled", true)' in prefsdef,
   "45.14 annotationDigestEnabled 默认开")
ok('"features/annotation-digest.js"' in mainjs and "this.annotationDigest = AnnotationDigest" in mainjs,
   "45.15 main.js 装配并暴露 annotationDigest")
ok('"papilot-itemmenu-annot-digest"' in menusjs_src and "menuAnnotDigest" in menusjs_src
   and "AIClient.hasKey" in menusjs_src,
   "45.16 ★ 标注速记菜单（含 AI 未配置前置拦截）")
ok("test/citation-context.test.js" in _preflight_src and "test/meta-doctor.test.js" in _preflight_src
   and "test/annotation-digest.test.js" in _preflight_src,
   "45.17 preflight 注册三个新测试套件")
ok('preference="extensions.zotero.papilot.citationContextEnabled"' in prefs_xhtml
   and 'preference="extensions.zotero.papilot.annotationDigestEnabled"' in prefs_xhtml,
   "45.18 设置面板两个新开关（声明式绑定）")

# ---------- 46. 0.53.0（检索订阅 / 综述工作台） ----------
_ss_path = os.path.join(ROOT, "chrome/content/scripts/features/search-subs.js")
ok(os.path.exists(_ss_path), "46.1 SearchSubs 模块在库（检索订阅）")
_ss_src = io.open(_ss_path, encoding="utf-8").read() if os.path.exists(_ss_path) else ""
ok("checkDue" in _ss_src and "run(" in _ss_src and "_fingerprint" in _ss_src and "searchSubsSeen" in _ss_src,
   "46.2 SearchSubs API（checkDue/run/指纹去重/记账）")
ok('pref("extensions.zotero.papilot.searchSubscriptions"' in prefsdef
   and 'pref("extensions.zotero.papilot.searchSubsSeen"' in prefsdef,
   "46.3 prefs.js 订阅与记账默认值")
ok('"features/search-subs.js"' in mainjs and "this.searchSubs = SearchSubs" in mainjs,
   "46.4 main.js 装配并暴露 searchSubs")
ok("SearchSubs.start()" in mainjs and "SearchSubs.stop()" in mainjs,
   "46.5 ★ 订阅定时器生命周期（启动即轮询 / destroy 停止）")
ok("prefs-subs.js" in mainjs and os.path.exists(os.path.join(ROOT, "chrome/content/prefs-subs.js")),
   "46.6 订阅设置脚本在库并注册")
ok('id="pp-subs-list"' in prefs_xhtml and 'id="pp-subs-add"' in prefs_xhtml
   and 'data-fold="subscriptions"' in prefs_xhtml,
   "46.7 prefs.xhtml 订阅折叠卡与容器")
ok('id="pp-sub-name"' in prefs_xhtml and 'id="pp-sub-keywords"' in prefs_xhtml
   and 'id="pp-sub-cats"' in prefs_xhtml and 'id="pp-sub-time"' in prefs_xhtml
   and 'id="pp-sub-auto"' in prefs_xhtml,
   "46.8 订阅表单五个控件（名称/关键词/分类/时间/自动入库）")
_rw_path = os.path.join(ROOT, "chrome/content/scripts/features/review-workbench.js")
ok(os.path.exists(_rw_path), "46.9 ReviewWorkbench 模块在库（综述工作台）")
_rw_src = io.open(_rw_path, encoding="utf-8").read() if os.path.exists(_rw_path) else ""
ok("buildOutlinePrompt" in _rw_src and "parseOutline" in _rw_src and "buildSectionPrompt" in _rw_src
   and "assembleDraft" in _rw_src and "citeToLink" in _rw_src,
   "46.10 ★ 工作台五纯函数（大纲/解析/分节/组装/引用链接）")
ok("zotero://select" in _rw_src, "46.11 引用真实化（文献 n → zotero://select 条目链接）")
ok(os.path.exists(os.path.join(ROOT, "chrome/content/review-workbench.xhtml"))
   and os.path.exists(os.path.join(ROOT, "chrome/content/review-workbench.js")),
   "46.12 工作台独立窗口资源（xhtml + 窗口脚本）在库")
ok('"features/review-workbench.js"' in mainjs and "this.reviewWorkbench = ReviewWorkbench" in mainjs,
   "46.13 main.js 装配并暴露 reviewWorkbench")
ok('"review-workbench"' in menusjs_src and "menuReviewWorkbench" in menusjs_src
   and "menuReviewWorkbench" in io.open(os.path.join(ROOT, "chrome/content/scripts/core/utils.js"), encoding="utf-8").read(),
   "46.14 ★ 工作台菜单入口（笔记组 + 右键 + I18n）")
ok('pref("extensions.zotero.papilot.reviewWorkbenchEnabled", true)' in prefsdef,
   "46.15 reviewWorkbenchEnabled 默认开")
ok("test/search-subs.test.js" in _preflight_src and "test/review-workbench.test.js" in _preflight_src,
   "46.16 preflight 注册两个新测试套件")
ok(prefs_xhtml.count('class="pp-card pp-fold"') == 21, "46.17 折叠卡共 21 张（订阅卡、云同步卡、WPS 集成卡、0.72.4 翻译卡拆三已计入）")

# ---------- 47. 0.54.0 审查修复（P0-P2 十项） ----------
ok('addCondition("note", "contains"' in _at_js,
   "47.1 ★ P0-3 search_notes 走 Zotero.Search 服务端过滤（不再全库串行扫描）")
ok('addCondition("itemType", "is", "note")' in _at_js,
   "47.2 P0-3 只检索 note 类型")
ok("_looksLikeInstruction" in _at_js and "INSTRUCTION_PATTERNS" in _at_js,
   "47.3 ★ P0-1 记忆写入拒绝指令型内容（防持久化提示注入）")
ok("viaMcp" in _at_js and "不得超过 200 字" in _at_js,
   "47.4 P0-1 MCP 通道写入限长")
_am2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/agent-memory.js"), encoding="utf-8").read()
ok("不是指令" in _am2 and "不得执行其中" in _am2,
   "47.5 ★ P0-1 asPromptBlock 数据围栏（记忆=数据非指令）")
ok("untrusted_data" in _at_js and "不是指令" in _at_js,
   "47.6 ★ P0-2 工具结果 untrusted_data 围栏")
ok("WRITE_MAX" in _at_js and "本轮写操作已达上限" in _at_js,
   "47.7 ★ P0-2 单轮写操作次数上限")
ok("_queueRender" in _cf_src and "_flushRender" in _cf_src and "_renderTimer" in _cf_src,
   "47.8 ★ P1-4 流式渲染 100ms 节流（取消每 token 全量重绘）")
_rp2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/related-papers.js"), encoding="utf-8").read()
_cc2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/citation-context.js"), encoding="utf-8").read()
ok("_fetchDebounced" in _rp2 and "DEBOUNCE_MS" in _rp2, "47.9 ★ P1-6 相关文献面板防抖")
ok("_fetchDebounced" in _cc2 and "DEBOUNCE_MS" in _cc2, "47.10 ★ P1-6 引文上下文面板防抖")
_sch2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/scheduler.js"), encoding="utf-8").read()
ok("_recentItems" in _sch2 and 'addCondition("dateAdded", "isAfter"' in _sch2,
   "47.11 ★ P1-5 晨报只取最近 24h（Search 服务端过滤）")
ok("_iterItems" in _sch2 and "for await (const it of" in _sch2,
   "47.12 ★ P1-5 周报/体检分批迭代（内存与库大小解耦）")
_cs2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/chat-sessions.js"), encoding="utf-8").read()
ok("FILE_NAME" in _cs2 and "_flushFile" in _cs2 and "IOUtils.writeUTF8" in _cs2,
   "47.13 ★ P1-7 会话全量落 data 目录文件（pref 只留尾部）")
ok("WRITE_DEBOUNCE_MS" in _cs2 and "_scheduleFileWrite" in _cs2,
   "47.14 P1-7 文件写 1.5s 防抖")
_rw2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/review-workbench.js"), encoding="utf-8").read()
ok('return link; // 0.54.0（审查 P2-8）' in _rw2,
   "47.15 P2-8 citeToLink 不再产生畸形 Markdown")
ok("_linkifyHtml" in _rw2 and "transformHtml" in _rw2,
   "47.16 ★ P2-9 引用链接落盘前一次成型（取消二次 setNote）")
_utils2 = io.open(os.path.join(ROOT, "chrome/content/scripts/core/utils.js"), encoding="utf-8").read()
ok("transformHtml" in _utils2, "47.17 P2-9 Notes.createFromMarkdown 支持 transformHtml")
_ss2 = io.open(os.path.join(ROOT, "chrome/content/scripts/features/search-subs.js"), encoding="utf-8").read()
ok("_safeName" in _ss2, "47.18 P2-10 订阅名归一（防标签树分层）")
ok(os.path.exists(os.path.join(ROOT, "docs/代码审查-性能与安全-2026-10-18.md")),
   "47.19 审查报告在库（修复可追溯）")

# ★ 分区标题遮挡修复（负下边距 → 卡片背景盖住「账号」「AI 与翻译」标签底部）
_cat_rule = re.search(r"\.pp-root \.pp-cat-label\s*\{([^}]*)\}", prefs_css, re.S)
ok(_cat_rule is not None, "40.23 prefs.css 有 .pp-cat-label 规则")
if _cat_rule:
    _cat_body = _cat_rule.group(1)
    ok(re.search(r"margin:\s*[^;]*-\d+px", _cat_body) is None,
       "40.24 ★ .pp-cat-label 无负边距（旧值 6px 0 -4px 会把卡片上拉盖住标题底部）")
    ok("scroll-margin-top" in _cat_body,
       "40.25 ★ .pp-cat-label 带 scroll-margin-top（锚点定位不被窗口头部贴边遮挡）")
else:
    ok(False, "40.24/40.25 .pp-cat-label 规则缺失")

# ---------- 41. 0.48.x 技能包商店（Skills Hub）集成接线 ----------
# 协作拆分：核心域 features/skill-packs.js（全局 SkillPacks）与商店窗口
# skill-store.xhtml / skill-store.js 由并行会话开发，本节守卫盯「集成接线」：
# 装配顺序、暴露入口、窗口打开方法与单例 windowtype、设置面板卡片 id 与脚本、
# pref 默认值、hub 卡片、契约方法齐全、测试注册（缺一个就是「点了没反应」）。
SP_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "skill-packs.js")
ok(os.path.exists(SP_JS), "41.1 SkillPacks 核心域存在（features/skill-packs.js）")
_sp_js = io.open(SP_JS, encoding="utf-8").read() if os.path.exists(SP_JS) else ""
ok('"features/skill-packs.js"' in mainjs,
   "41.2 main.js 装载清单含 features/skill-packs.js")
ok(mainjs.find('"ai/command-tags.js"') != -1 and
   mainjs.find('"features/skill-packs.js"') != -1 and
   mainjs.find('"ai/command-tags.js"') < mainjs.find('"features/skill-packs.js"'),
   "41.3 装载顺序：command-tags.js 在 skill-packs.js 之前（SkillPacks 惰性消费 CommandTags/NoteTemplates/TranslateSvc）")
ok("this.skillPacks = SkillPacks" in mainjs,
   "41.4 main.js 暴露 this.skillPacks = SkillPacks（设置面板/商店窗口经此访问）")
ok("openSkillStore" in mainjs and "papilot:skillstore" in mainjs,
   "41.5 main.js 有 openSkillStore 与 papilot:skillstore（单例聚焦 + window.openDialog）")
ok("prefs-skill.js" in mainjs,
   "41.6 main.js scripts 列表注册 prefs-skill.js（设置面板技能商店卡片）")
SS_XHTML = os.path.join(ROOT, "chrome", "content", "skill-store.xhtml")
SS_JS = os.path.join(ROOT, "chrome", "content", "skill-store.js")
_ss_xhtml = io.open(SS_XHTML, encoding="utf-8").read() if os.path.exists(SS_XHTML) else ""
_ss_js = io.open(SS_JS, encoding="utf-8").read() if os.path.exists(SS_JS) else ""
ok(os.path.exists(SS_XHTML) and
   (("no-native" in _ss_xhtml and "function boot()" in _ss_xhtml) or
    ("function boot()" in _ss_js and "readyState" in _ss_js)),
   "41.7 商店窗口引导齐备（xhtml no-native + boot，或 skill-store.js boot + readyState，其一）")
ok("papilot:skillstore" in _ss_xhtml or "papilot:skillstore" in _ss_js,
   "41.8 商店窗口 windowtype 为 papilot:skillstore（xhtml 或 js 声明其一）")
ok("&nbsp;" not in _ss_xhtml,
   "41.9 skill-store.xhtml 无 &nbsp;（XML 实体纪律，同 §30 模式）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "prefs-skill.js")),
   "41.10 prefs-skill.js 存在（设置面板技能商店卡片脚本）")
ok(all(_e in xhtml_ids for _e in
       ("pp-sk-open", "pp-sk-import", "pp-sk-source", "pp-sk-installed", "pp-sk-refresh")),
   "41.11 prefs.xhtml 含技能商店卡片五 id（pp-sk-open / pp-sk-import / pp-sk-source / pp-sk-installed / pp-sk-refresh）")
ok(all('pref("extensions.zotero.papilot.%s"' % _k in prefsdef for _k in
       ("skillPacksInstalled", "skillPackRatings", "skillStoreSource")),
   "41.12 prefs.js 有 skillPacksInstalled / skillPackRatings / skillStoreSource 默认值")
ok("openSkillStore" in hub_js,
   "41.13 hub.js 含 openSkillStore（功能中心卡片接线）")
ok(all(_m in _sp_js for _m in
       ("validate", "install", "uninstall", "fetchCatalog", "searchPacks", "listInstalled",
        "rate", "applyAgentPreset", "buildManifest", "exportPack", "compareVersion")),
   "41.14 SkillPacks 契约方法齐全（validate/install/uninstall/fetchCatalog/searchPacks/"
   "listInstalled/rate/applyAgentPreset/buildManifest/exportPack/compareVersion）")
ok(os.path.exists(os.path.join(ROOT, "test", "skill-packs.test.js")),
   "41.15 技能包核心域测试套件在库（test/skill-packs.test.js）")
ok("skill-packs.test.js" in _preflight_src,
   "41.16 preflight 注册 skill-packs.test.js")
ok('"SkillPacks"' in _smoke,
   "41.17 smoke-load.test.js expect 含 SkillPacks（关键全局冒烟）")
_ps_js2 = io.open(os.path.join(ROOT, "chrome/content/prefs-skill.js"), encoding="utf-8").read()
ok("registerObserver" in _ps_js2 and "unregisterObserver" in _ps_js2,
   "41.18 ★ prefs-skill 监听 skillPacksInstalled 变化自动刷新（0.48.2 修「商店更新后面板不显示新版本」）")
ok("wireRefresh" in _ps_js2 and "pp-sk-refresh" in _ps_js2,
   "41.19 prefs-skill 提供手动刷新按钮接线（观察者不可用时的兜底）")

# ==================== 43. 付款订单弹窗（0.49.0） ====================
# 下单成功（会员购买 / AI 额度充值）自动弹出付款单；「查看付款单」可重开。
# 核心纪律：①两条购买流都必须触发；②动作与内联区共用 *Core 单一真源；
#          ③异常订单不弹窗（回退内联区）；④挂载点在折叠组之外（否则组收起后打不开）。
_pd_js = io.open(os.path.join(ROOT, "chrome/content/prefs-account.js"), encoding="utf-8").read()
ok("const OrderDlg = {" in _pd_js and "show(order, kind, actions)" in _pd_js
   and "update(order)" in _pd_js and "close()" in _pd_js,
   "43.1 prefs-account.js 定义 OrderDlg 弹窗组件（show/update/close）")
ok("if (!bad) openOrderDlg(mbOrder, \"plan\")" in _pd_js,
   "43.2 ★ 会员下单成功 → 自动弹窗（异常订单跳过）")
ok("if (!bad) openOrderDlg(balOrder, \"credit\")" in _pd_js,
   "43.3 ★ 充值下单成功 → 自动弹窗（异常订单跳过）")
ok("function orderViewProblem(o)" in _pd_js and "缺少订单号" in _pd_js,
   "43.4 弹窗前置校验（缺订单号/金额不可读时不展示脏数据）")
ok("claim: kind === \"credit\" ? balClaimCore : mbClaimCore" in _pd_js
   and "cancel: kind === \"credit\" ? balCancelCore : mbCancelCore" in _pd_js
   and "refresh: kind === \"credit\" ? balRefreshCore : mbRefreshCore" in _pd_js,
   "43.5 ★ 弹窗动作指向面板 *Core 函数（与内联区单一真源）")
ok(_pd_js.count("syncOrderDlg();") >= 4,
   "43.6 轮询/认领/取消后同步弹窗内容（>=4 处调用）")
ok("pp-dlg-root" in xhtml_ids
   and prefs_xhtml.rindex('id="pp-dlg-root"') > prefs_xhtml.rindex("data-fold="),
   "43.7 ★ 弹窗挂载点在折叠组之外（组收起不得连带隐藏弹窗）")
ok("pp-mb-order-view" in xhtml_ids and "pp-bal-order-view" in xhtml_ids,
   "43.8 prefs.xhtml 两条购买流都有「查看付款单」重开入口")
ok(".pp-root .pp-order-mask {" in prefs_css and ".pp-root .pp-order-dlg {" in prefs_css,
   "43.9 prefs.css 有弹窗遮罩与卡片样式")
ok("pp-dlg-badge-warn" in prefs_css and "pp-dlg-badge-ok" in prefs_css,
   "43.10 状态徽标按状态着色（待支付警示 / 已开通成功）")
_mpt = io.open(os.path.join(TEST_DIR, "membership-panel.test.js"), encoding="utf-8").read()
ok("K1 ★ 会员下单成功 → 自动弹出付款单" in _mpt
   and "K22 ★ 充值下单成功 → 自动弹出付款单" in _mpt,
   "43.11 测试覆盖两条购买流的下单自动弹窗")
ok("K20 ★ 订单数据异常（缺订单号）→ 不弹窗" in _mpt,
   "43.12 ★ 测试锁定「异常订单不弹窗」（防回归成脏数据弹窗）")

# ==================== 44. 在线支付入口（0.50.0 / 服务端 1.7.0+） ====================
# 充值单的「在线支付（扫码）」：服务端下发可用性 → 面板/弹窗出现入口 →
# account.startOnlinePay 建网关收银台 → Zotero.launchURL 打开浏览器 → 回调自动入账。
# 未开通时必须整入口隐藏（不留死按钮）。
_acct_js = io.open(os.path.join(ROOT, "chrome/content/scripts/ai/account.js"), encoding="utf-8").read()
ok("async startOnlinePay(orderId, channel)" in _acct_js
   and "/api/orders/" in _acct_js and "/pay" in _acct_js,
   "44.1 account.js 提供 startOnlinePay（POST /api/orders/:id/pay）")
ok("onlinePay: (j.onlinePay && typeof j.onlinePay === 'object')" in _acct_js,
   "44.2 plans() 解析服务端 onlinePay 可用性（旧服务端 → false）")
ok("async function balOnlinePayCore()" in _pd_js and "Zotero.launchURL(r.payUrl)" in _pd_js,
   "44.3 prefs-account 在线支付核心：建收银台 + 系统浏览器打开 payUrl")
ok("let mbOnline = { available: false, channels: [] }" in _pd_js
   and 'online: kind === "credit"' in _pd_js and "mbOnlinePayCore" in _pd_js,
   "44.4 ★ 弹窗按订单类型提供在线支付（充值单 + 会员单，均需服务端开通）")
ok("pp-mb-online" in xhtml_ids and 'bind("pp-mb-online", "click", onMbOnlinePay)' in _pd_js,
   "44.4b ★ 会员订单内联「在线支付（扫码）」按钮存在且已绑定")
ok("pp-bal-online" in xhtml_ids, "44.5 prefs.xhtml 含内联「在线支付（扫码）」按钮")
ok("pp-dlg-online" in _pd_js, "44.6 付款单弹窗含在线支付按钮（class pp-dlg-online）")
ok('bind("pp-bal-online", "click", onBalOnlinePay)' in _pd_js,
   "44.7 内联在线支付按钮已绑定")
ok("K30 ★ 付款单弹窗含「在线支付（扫码）」按钮" in _mpt
   and "K34 ★ 未开通 → 弹窗不出现在线支付按钮（不留死入口）" in _mpt,
   "44.8 测试覆盖：开通出现 / 未开通隐藏")
_pay_js = io.open(os.path.join(ROOT, "server/lib/pay.js"), encoding="utf-8").read()
ok("type: 'alipay'" in _pay_js and "收款账号" in _pay_js,
   "44.9 ★ 深度自检用 alipay 且识别「暂无收款账号在线」（原会误报全链路通过）")

# ==================== 45. 订单金额口径：唯一尾数开关（1.8.4） ====================
# 默认关闭 = 所见即所付（订单金额即标价）；开启 = 加 1~99 分对账尾数。
# 全链路一致性：doc 默认值 → 两条下单路径 → 下发（plans/管理接口）→ 管理页开关 → 插件文案。
_mem_js = io.open(os.path.join(ROOT, "server/lib/membership.js"), encoding="utf-8").read()
ok("tailEnabled: false," in _mem_js and "out.tailEnabled = out.tailEnabled === true" in _mem_js,
   "45.1 ★ 唯一尾数默认关闭（newDoc + normalize 幂等）")
ok("const tailsOn = doc.tailEnabled === true" in _mem_js
   and _mem_js.count("tailsOn ? assignTail(") >= 2,
   "45.2 会员单与充值单两条下单路径都遵循开关")
ok("tailEnabled: doc.tailEnabled === true," in _mem_js,
   "45.3 plansForClient 下发 tailEnabled（插件据此提示）")
_as_js2 = io.open(os.path.join(ROOT, "server/account-server.js"), encoding="utf-8").read()
ok("if (input.tail && typeof input.tail === 'object'" in _as_js2
   and "tailEnabled: membershipStore.data.tailEnabled === true" in _as_js2,
   "45.4 管理接口读写开关（PUT {tail:{enabled}} / GET tailEnabled）")
_admin_html = io.open(os.path.join(ROOT, "server/public/admin.html"), encoding="utf-8").read()
ok("p-tail-enabled" in _admin_html and "tail: { enabled:" in _admin_html,
   "45.5 管理页提供「订单金额唯一尾数」开关并随保存提交")
ok("tailEnabled: j.tailEnabled === true" in _acct_js,
   "45.6 account.js 解析 tailEnabled")
ok("(mbPlans && mbPlans.tailEnabled)" in _pd_js,
   "45.7 插件折后价提示仅在开启时提尾数（默认所见即所付）")
_tests_all = ""
for _tf in ["membership.test.js", "balance.test.js", "membership-panel.test.js", "coupon.test.js"]:
    _tests_all += io.open(os.path.join(TEST_DIR, _tf), encoding="utf-8").read()
ok("13.16b ★ 默认精确金额" in _tests_all and "B23b ★ 默认无尾数" in _tests_all
   and "F19 ★ 尾数关闭（默认）" in _tests_all,
   "45.8 ★ 测试锁定默认精确金额（含服务端两条链路与插件文案）")

# ==================== 46. 控制台卡死治理（2026-10-18） ====================
# 三条硬约束：①UI 线程不做重查询 ②健康探测必须「端口前置 + 负缓存 + 退避」
# ③关闭窗口必须真的能关。背景见 docs/启动控制台-卡死根因分析与治理-2026-10-18.md
def _fn_body(src, name):
    m = re.search(r"(?m)^function\s+" + re.escape(name) + r"\b[\s\S]*?\r?\n\}", src)
    return m.group(0) if m else ""


_health_body = _fn_body(ps, "Get-HealthCached")
ok(re.search(r"Get-NetTCPConnection\s+-LocalPort", ps) is None,
   "46.1 ★ launcher 不再用 Get-NetTCPConnection（实测 1202ms，UI 线程上就是硬卡顿）")
ok("healthFailAt" in _health_body and "Test-PortOpen" in _health_body,
   "46.2 ★ Get-HealthCached 有端口前置 + 负缓存（旧版失败不写 healthAt → 每拍重发 3 次探测）")
ok("healthHardFail" in _health_body and "$cool = 15" in _health_body,
   "46.3 连续超时后退避到 15 秒（后端半死时不耗满 UI 线程）")
_restart_body = _fn_body(ps, "Do-RestartServer")
ok("Test-PortOpen" in _restart_body and "Wait-Ui" in _restart_body
   and "Get-PortOwnerPid" not in _restart_body,
   "46.4 ★ 重启改用 150ms 端口探测 + Wait-Ui（不再 20x(1.2s+500ms) ≈ 40s 冻结）")
_fc = re.search(r"\$form\.add_FormClosing\(\{[\s\S]*?\r?\n\}\)", ps)
ok(_fc is not None and "Hide-ToTray" not in _fc.group(0),
   "46.5 ★ 关闭窗口 = 退出（旧行为静默最小化到托盘，用户眼里的「关不掉」）")
_bat = io.open(os.path.join(ROOT, "启动Papilot后台.bat"), encoding="gbk", errors="replace").read()
ok("console-alive.ps1" in _bat and os.path.isfile(os.path.join(ROOT, "scripts", "console-alive.ps1")),
   "46.6 bat 用窗口应答探测控制台（进程活着 ≠ 能用）")
_vbs = io.open(os.path.join(ROOT, "scripts", "start-server-hidden.vbs"), encoding="utf-8", errors="replace").read()
ok('logFile = logDir & "\server-stdout.log"' in _vbs
   and 'logFile = logDir & "\server-console.log"' not in _vbs,
   "46.7 VBS 启动器 stdout 落 server-stdout.log（双轨纪律）")
ok("pid: process.pid" in srv and "lagMs: _loop.lagMs" in srv,
   "46.8 服务端 /api/health 自报 pid + lagMs（控制台据此免查 WMI）")
ok("uncaughtException" in srv and "unhandledRejection" in srv and "server-crash.log" in srv,
   "46.9 服务端崩溃兜底写 server-crash.log（无声消失可追溯）")

# ==================== 47. 守护脚本健康判据（1.8.5 审查 P1-9） ====================
# 端口在听 != 能干活：服务端被同步写盘堵死时 TCP 仍能握手，只判 Test-Port 的
# 守护会永远沉默，而启动器显示「服务异常」——两边结论相反。
_guard = io.open(os.path.join(ROOT, "scripts", "guard-papilot.ps1"),
                 encoding="utf-8", errors="replace").read()
ok("function Test-ServerHealthy" in _guard and "api/health" in _guard,
   "47.1 守护用 /api/health 判活（不只 Test-Port）")
ok("Get-HealthFails" in _guard and "guard-health-fails.txt" in _guard,
   "47.2 连续失败计数（避免刚拉起/抖动时误杀）")
ok("Stop-PortOwner" in _guard and "Get-NetTCPConnection" in _guard,
   "47.3 端口被占但 health 不通时可强杀重启")
ok("Test-ServerHealthy" in _guard.split("# ---------- pass 2")[0],
   "47.4 pass1 主判据已切到 health（不是端口）")
ok("C:\\Users\\Administrator" not in _guard,
   "47.5 守护脚本不写死用户目录（$env:USERPROFILE）")

# ---------- 48. 坚果云云同步（0.56.0） ----------
# 三条关键接线：模块按依赖顺序装、面板脚本注册、密钥类 pref 不在快照白名单里。
# 这三处任何一处断了，症状分别是：功能整体不可用 / 设置卡片空白 / 密钥被同步上云。
_CLOUD_CORE = os.path.join(ROOT, "chrome", "content", "scripts", "core", "webdav.js")
_CLOUD_SYNC = os.path.join(ROOT, "chrome", "content", "scripts", "features", "cloud-sync.js")
_CLOUD_PREFS = os.path.join(ROOT, "chrome", "content", "prefs-cloud.js")
ok(os.path.exists(_CLOUD_CORE), "48.1 core/webdav.js 存在（协议层）")
ok(os.path.exists(_CLOUD_SYNC), "48.2 features/cloud-sync.js 存在（同步域）")
ok(os.path.exists(_CLOUD_PREFS), "48.3 prefs-cloud.js 存在（设置面板脚本）")
ok('"core/webdav.js"' in mainjs and '"features/cloud-sync.js"' in mainjs,
   "48.4 main.js 装配了协议层与同步域")
ok(mainjs.index('"core/webdav.js"') < mainjs.index('"features/cloud-sync.js"'),
   "48.5 加载顺序：webdav.js 在 cloud-sync.js 之前（后者加载期就取 WebDAV.CODES）")
ok("prefs-cloud.js" in mainjs, "48.6 main.js 注册了 prefs-cloud.js")
ok('data-fold="cloud"' in prefs_xhtml and 'id="pp-cloud-email"' in prefs_xhtml
   and 'id="pp-cloud-token"' in prefs_xhtml and 'id="pp-cloud-sync"' in prefs_xhtml,
   "48.7 prefs.xhtml 有云同步卡片与关键控件")
ok('pref("extensions.zotero.papilot.cloudSyncToken", "");' in prefsdef,
   "48.8 prefs.js 有 cloudSyncToken 默认值（空 = 未登录）")
_cloud_sync_js = io.open(_CLOUD_SYNC, encoding="utf-8").read() if os.path.exists(_CLOUD_SYNC) else ""
_cloud_core_js = io.open(_CLOUD_CORE, encoding="utf-8").read() if os.path.exists(_CLOUD_CORE) else ""
_cloud_panel_js = io.open(_CLOUD_PREFS, encoding="utf-8").read() if os.path.exists(_CLOUD_PREFS) else ""
ok("SECRET_LEAF_RE" in _cloud_sync_js and 'shouldSyncPref' in _cloud_sync_js
   and "aiChannels" in _cloud_sync_js,
   "48.9 ★ 设置快照剔除密钥类键（aiChannels/apiKey/token/password）")
ok("cloudSync" in _cloud_sync_js and 'leaf.indexOf("cloudSync") === 0' in _cloud_sync_js,
   "48.10 ★ 同步自身配置不进快照（否则多机互相改配置）")
ok(_cloud_sync_js.count("client.del(") == 4 and "_cleanupOldParts" in _cloud_sync_js
   and "_purgeDir" in _cloud_sync_js and "_applyTombstone" in _cloud_sync_js,
   "48.11 ★ DELETE 只出现在旧分卷清理与墓碑应用；业务文件删除不传播")
ok("TOO_LARGE" in _cloud_sync_js and "QUOTA" in _cloud_core_js and "AUTH_EXPIRED" in _cloud_sync_js,
   "48.12 ★ 错误分类齐全（超限/配额/授权过期）")
ok("_uploadParts" in _cloud_sync_js and "ppmanifest" in _cloud_sync_js,
   "48.13 ★ 大文件分卷 + 清单（断点续传基础）")
ok("/Papilot" in _cloud_sync_js and '=== "/"' in _cloud_sync_js,
   "48.14 同步根兜底：不允许把整个网盘当同步区")
ok("appPassword" in _cloud_panel_js or "应用密码" in _cloud_panel_js,
   "48.15 面板明确提示「应用密码」（登录密码直连会 401）")
ok("pp-cloud-progress" in prefs_xhtml and "pp-cloud-log" in prefs_xhtml,
   "48.16 面板有进度与日志位（状态反馈）")
# 真机（2026-10-19）暴露的两个问题，必须留守卫，否则回归后极难定位：
#  · 坚果云 ETag 是裸串，统一补引号 → 条件写 412；
#  · 密集请求触发 503 BlockedTemporarily，短退避会继续撞墙。
ok("etagRaw" in _cloud_core_js and "etagRaw" in _cloud_sync_js,
   "48.17 ★ ETag 原样回传（etagRaw）：坚果云裸串补引号会 412")
ok("minIntervalMs" in _cloud_core_js and "minIntervalMs" in _cloud_sync_js,
   "48.18 ★ 客户端请求节流（minIntervalMs）防坚果云限流")
ok("BlockedTemporarily" in _cloud_core_js and "retryAfterMs" in _cloud_core_js
   and "retryAfterMs" in _cloud_sync_js,
   "48.19 ★ 限流单独归因（BlockedTemporarily → RATE_LIMIT + 长等待）")
# 批次 1（0.59.0）：数据安全与配额
ok("NON_SETTING_LEAVES" in _cloud_sync_js and '"uiWallpaperPath"' in _cloud_sync_js
   and '"readingProgress"' in _cloud_sync_js and '"rankDataSets"' in _cloud_sync_js,
   "48.20 ★ 快照分层：缓存/大型数据集/机器绝对路径默认不出本机")
ok("_buildSnapshot" in _cloud_sync_js and "snapshotMaxKB" in _cloud_sync_js,
   "48.21 ★ 快照体积上限（超限报错并指出最大键，不静默截断）")
ok('index-" + this._accountKey()' in _cloud_sync_js and "_migrateLegacyIndex" in _cloud_sync_js,
   "48.22 ★ 索引按账号+根目录隔离，旧索引按 owner 迁移一次")
ok("budget.truncated" in _cloud_sync_js and "已跳过该数据集以避免误判" in _cloud_sync_js,
   "48.23 ★ 扫描预算超限 → 整数据集跳过（不做部分同步）")
ok("_cleanupOldParts" in _cloud_sync_js and "keepOldParts" in _cloud_sync_js,
   "48.24 ★ 旧分卷清理（只删同 basename 的其它 hash 目录）")
ok("assembleMaxMB" in _cloud_sync_js and "本机组装上限" in _cloud_sync_js,
   "48.25 ★ 分卷组装独立上限（防 512MB 内存峰值）")
ok("CODES.QUOTA)) throw e" in _cloud_sync_js,
   "48.26 ★ 配额满立即中止整轮（不逐文件刷失败）")
# 批次 2（0.60.0）：删除墓碑 / 三向合并 / 文件名兼容
ok("_collectLocalDeletions" in _cloud_sync_js and "_applyTombstone" in _cloud_sync_js
   and ".tombstones.json" in _cloud_sync_js,
   "48.27 ★ 删除墓碑：本地删除记录 + 跨设备共享 + 应用")
ok('ds.kind === "dir" && cfg.propagateDelete' in _cloud_sync_js
   and "MASS_DELETE" in _cloud_sync_js,
   "48.28 ★ 删除传播仅限目录型数据集，且大批缺失有保护")
ok("mergeSnapshots" in _cloud_sync_js and "_rememberSnapshot" in _cloud_sync_js
   and "snapshots" in _cloud_sync_js,
   "48.29 ★ 设置快照三向合并（基线 + 逐键）")
ok("sanitizeName" in _cloud_sync_js and "Windows 非法字符" in _cloud_sync_js,
   "48.30 ★ 下载前校验 Windows 非法文件名（不做静默改名）")
ok("listConflicts" in _cloud_sync_js and "pp-cloud-conflicts" in prefs_xhtml
   and "pp-cloud-propagate" in prefs_xhtml,
   "48.31 冲突留档列表 + 删除传播开关已接线")
ok('pref("extensions.zotero.papilot.cloudSyncPropagateDelete", true);' in prefsdef,
   "48.32 prefs.js 有删除传播默认值")

# ---------- 49. 0.57.0 检索订阅 v2（推荐 / 试跑 / 多源 / AI 边界） ----------
# 这一版的价值全在「接缝」：推荐没接上=空白卡；预览写脏数据=吃掉正式订阅；
# AI 未就绪没降级=整块不可用；多源装配顺序错=运行时 ReferenceError。
_ssrc_path = os.path.join(ROOT, "chrome/content/scripts/features/sub-sources.js")
ok(os.path.exists(_ssrc_path), "49.1 SubSources 多源适配层在库")
_ssrc = io.open(_ssrc_path, encoding="utf-8").read() if os.path.exists(_ssrc_path) else ""
ok("normalizeOpenAlex" in _ssrc and "normalizeCrossref" in _ssrc and "normalizePubMed" in _ssrc
   and "abstractFromInverted" in _ssrc and "dedupe(" in _ssrc,
   "49.2 ★ 三源归一 + 倒排摘要 + 跨源去重")
ok("_openalex" in _ssrc and "_crossref" in _ssrc and "_pubmed" in _ssrc
   and "bySource" in _ssrc and "partial" in _ssrc,
   "49.3 ★ 多源容错（单源失败不拖垮整次订阅）")
ok('"features/sub-sources.js"' in mainjs and "this.subSources" in mainjs,
   "49.4 main.js 装配并暴露 subSources")
ok(mainjs.index('"features/sub-sources.js"') < mainjs.index('"features/search-subs.js"'),
   "49.5 ★ 适配层排在订阅模块之前（运行时全局可见）")

_ssv2 = io.open(_ss_path, encoding="utf-8").read() if os.path.exists(_ss_path) else ""
ok("async preview(" in _ssv2 and "async suggest(" in _ssv2 and "async aiParseQuery(" in _ssv2
   and "async aiRerank(" in _ssv2 and "async aiDigest(" in _ssv2,
   "49.6 ★ v2 五个能力（预览/推荐/AI 解析/AI 复核/AI 速览）")
ok("_isPlannedDay" in _ssv2 and '"weekly"' in _ssv2 and "weekdays" in _ssv2,
   "49.7 每周计划日调度")
ok("_pushRunLog" in _ssv2 and "RUNLOG_MAX" in _ssv2 and "lastStatus" in _ssv2,
   "49.8 运行历史与最近状态")
ok("searchSubsRecoDismissed" in _ssv2 and "dismissReco" in _ssv2,
   "49.9 推荐可忽略（持久化）")
ok("preview(" in _ssv2 and "_seenSave" in _ssv2 and "不写 pref" in _ssv2,
   "49.10 ★ 预览不写记账（避免吃掉正式订阅内容）")

ok('id="pp-subs-reco"' in prefs_xhtml and 'id="pp-sub-nl"' in prefs_xhtml
   and 'id="pp-sub-src-openalex"' in prefs_xhtml and 'id="pp-sub-src-europepmc"' in prefs_xhtml
   and 'id="pp-sub-mode"' in prefs_xhtml
   and 'id="pp-sub-freq"' in prefs_xhtml and 'id="pp-sub-maxagedays"' in prefs_xhtml,
   "49.11 设置面板推荐/一句话/多源/模式/频率/时间窗控件齐全")
ok("normalizeEuropePmc" in _ssrc and "_europepmc" in _ssrc and "europePmcQuery" in _ssrc,
   "49.11b ★ Europe PMC 源（NCBI 不可达时的生物医学替代）")
ok('id="pp-sub-mailto"' in prefs_xhtml and 'subsMailto' in prefsdef,
   "49.12 礼貌邮箱（OpenAlex/Crossref 配额）")
_psrc = io.open(os.path.join(ROOT, "chrome/content/prefs-subs.js"), encoding="utf-8").read()
ok("loadReco" in _psrc and "doPreview" in _psrc and "aiParse" in _psrc
   and "commitDraftForPreview" in _psrc and "renderReco" in _psrc,
   "49.13 ★ 面板四段交互（推荐/试跑/一句话/表单）")
ok("pp-sub-ai-rerank" in _psrc and "pp-sub-ai-digest" in _psrc,
   "49.14 AI 两个开关（默认关）")

_dsrc = io.open(os.path.join(ROOT, "chrome/content/discovery-ui.js"), encoding="utf-8").read()
ok('id="pp-dc-subs"' in io.open(os.path.join(ROOT, "chrome/content/discovery.xhtml"), encoding="utf-8").read()
   and "fromDiscovery" in _dsrc,
   "49.15 ★ 文献发现 → 订阅的衔接入口（存为订阅）")
ok("test/sub-sources.test.js" in _preflight_src and "test/search-subs.test.js" in _preflight_src
   and "test/prefs-subs.test.js" in _preflight_src,
   "49.16 preflight 注册订阅 / 多源 / 面板三个套件")
ok("search subs selfTest" in mainjs and "SearchSubs.selfTest()" in mainjs,
   "49.17 ★ 启动写订阅自检结论（真机排查入口）")

# ---------- 49b. 0.58.0 检索订阅 P1（反馈学习 / 作者追踪 / 通知 / OpenAlex Key） ----------
# 这四项都是「少一行就静默失效」的接线：作者没进归一=表单白填；反馈没进打分=收藏没反应；
# 通知没接 ProgressWindow=用户永远不知道有新论文；Key 没进 URL=配额没变化。
ok("_normAuthors" in _ssv2 and "MAX_AUTHORS" in _ssv2 and '"authors" in p' in _ssv2,
   "49.18 ★ 作者追踪进订阅模型（_normAuthors 归一 + update 补丁 + 上限）")
ok("authorsOf" in _ssrc and "raw_author_name.search" in _ssrc
   and "AUTH:" in _ssrc and "[au]" in _ssrc and "query.author" in _ssrc,
   "49.18b ★ 四源作者查询式（OpenAlex filter / EPMC AUTH / PubMed [au] / Crossref query.author）")
ok("_personKey" in _ssrc and "authors" in _ssrc and "matches(sub, e)" in _ssrc,
   "49.18c 作者本地复核（matches 不误杀无作者条目）")

ok("searchSubsFeedback" in _ssv2 and "_feedbackLoad" in _ssv2 and "_feedbackPut" in _ssv2
   and "_feedbackAdjust" in _ssv2 and "feedbackOf" in _ssv2,
   "49.19 ★ 收藏/忽略反馈学习（pref + 记录 + 调分）")
ok("async accept(" in _ssv2 and "ignoreEntry(" in _ssv2 and "feedbackClear(" in _ssv2
   and "feedbackStats(" in _ssv2,
   "49.19b ★ 四个反馈入口（收藏 / 忽略 / 清空 / 统计）")
ok("ignoredFps" in _ssv2 and "已忽略" in _ssv2 and 'status = "ignored"' in _ssv2,
   "49.19c ★ 忽略项在 run / preview 里被识别（ignoredFps + 已忽略 文案）")

ok("_itemByID" in _ssv2 and "getAsync" in _ssv2 and "fetchLimit" in _ssv2,
   "49.19d ★ 收藏查重（seen + Items.getAsync）与忽略项不占名额（fetchLimit）")
ok("_scrub" in _ssrc and "api_key=***" in _ssrc,
   "49.21d ★ 失败原因脱敏（bySource.reason 不带 api_key 明文）")

ok("ProgressWindow" in _ssv2 and "_notify" in _ssv2 and "closeOnClick" in _ssv2
   and "startCloseTimer" in _ssv2,
   "49.20 ★ 系统通知（ProgressWindow + 点击关闭 + 8s 计时）")
ok('(o.trigger || "manual") !== "manual"' in _ssv2 and "notify === false" in _ssv2,
   "49.20b 通知只在定时运行 + notify=true 时弹（缺省 trigger 视为手动）")

ok("searchSubsFeedback" in prefsdef and "openAlexApiKey" in prefsdef,
   "49.21 两个新 pref 在 prefs.js 有默认值")
ok("_oaKey" in _ssrc and '"api_key="' in _ssrc,
   "49.21b ★ OpenAlex 免费 Key 进请求参数")
ok('id="pp-sub-openalex-key"' in prefs_xhtml
   and 'preference="extensions.zotero.papilot.openAlexApiKey"' in prefs_xhtml
   and 'id="pp-sub-authors"' in prefs_xhtml and 'id="pp-sub-notify"' in prefs_xhtml,
   "49.21c 设置面板：OpenAlex Key（password）/ 作者 / 通知开关控件齐全")

ok("s.accept(" in _psrc and "s.ignoreEntry(" in _psrc and "feedbackClear" in _psrc,
   "49.22 ★ 预览卡接了收藏 / 忽略，按钮行接了清空反馈")
ok('id="pp-subs-feedback-clear"' in prefs_xhtml and "pp-subs-feedback-clear" in _psrc,
   "49.22b 清空反馈学习按钮接线完整")
ok("关键词、分类、作者、期刊至少要有一个" in _psrc,
   "49.22c 表单校验文案同步（0.69.0 起期刊也是检索条件）")

# ---------- 50. 0.63.0 PDF 无头渲染 + 视觉 OCR / 笔记工具（A2） ----------
# 这两条链路都有「静默降级」的失败面，用户侧只表现为「点了没反应」，所以用静态断言钉住：
#   ① pdfjs 若在模块循环**之后**载入，features/ocr.js 运行期取 pdfjsLib 得到 undefined；
#      若没有 try/catch，UMD 加载失败会直接搞死整个插件启动；
#   ② features/ocr.js 不在装配清单 → 菜单项调 OcrService 时 ReferenceError；
#   ③ 5 个 OCR pref 缺默认值 → Prefs.get 拿到 undefined，页数上限变 NaN，识别循环一页都不跑；
#   ④ 菜单 group 写错 → 功能在右键分组里根本找不到（分组即入口位置）；
#   ⑤ 窗口脚本 getElementById 的 id 与 xhtml 不一致 → 控件永远没反应（点了像坏了）。
_ocr_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "ocr.js"),
                  encoding="utf-8").read()
_nt_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "note-tools.js"),
                 encoding="utf-8").read()
_ntwin_js = io.open(os.path.join(ROOT, "chrome", "content", "note-tools.js"), encoding="utf-8").read()
_ntxhtml = io.open(os.path.join(ROOT, "chrome", "content", "note-tools.xhtml"), encoding="utf-8").read()
_pane_js2 = io.open(os.path.join(ROOT, "chrome", "content", "prefs-pane.js"), encoding="utf-8").read()

# ① pdfjs 载入位置与容错（文本顺序 + 片段包含，不写脆弱正则）
_pdfjs_at = mainjs.find("chrome/content/vendor/pdfjs/pdf.min.js")
_loop_at = mainjs.find("for (const f of files)")
ok(_pdfjs_at >= 0, "50.1 main.js 载入 vendor pdfjs（chrome/content/vendor/pdfjs/pdf.min.js）")
ok(_pdfjs_at >= 0 and _loop_at > _pdfjs_at, "50.2 ★ pdfjs 在模块加载循环之前载入")
ok(_pdfjs_at >= 0 and "try {" in mainjs[max(0, _pdfjs_at - 800):_pdfjs_at],
   "50.3 ★ pdfjs 载入在 try 块内（失败不拖垮启动）")
ok(_pdfjs_at >= 0 and "catch (e)" in mainjs[_pdfjs_at:_pdfjs_at + 2000],
   "50.4 ★ pdfjs 载入被 catch 兜住（只写诊断）")
ok("GlobalWorkerOptions.workerSrc" in mainjs and "pdf.worker.min.js" in mainjs,
   "50.5 main.js 把 workerSrc 指向 vendor 里的 pdf.worker.min.js")
ok('"features/ocr.js"' in mainjs and "this.ocr = " in mainjs,
   "50.6 features/ocr.js 在装配清单且挂到 Zotero.Papilot.ocr")
ok('"features/note-tools.js"' in mainjs and "this.noteTools = NoteTools;" in mainjs,
   "50.6b features/note-tools.js 在装配清单且挂到 Zotero.Papilot.noteTools")

# ② OCR 五个默认值
for _k in ["ocrEngine", "ocrRenderScale", "ocrMaxPages", "ocrSkipExistingPages", "ocrAutoFallback"]:
    ok(('papilot.%s"' % _k) in prefsdef, "50.7 prefs.js 含 OCR 默认值 %s" % _k)

# ③ 菜单分组（分组即入口位置）
ok('id: "ocr-run", group: "meta"' in menus_js, "50.8 菜单 ocr-run 归属 meta 组")
ok('id: "note-tools", group: "notes"' in menus_js, "50.9 菜单 note-tools 归属 notes 组")

# ④ 窗口脚本引用的 id 必须都在 xhtml 里
_nt_ids = set(re.findall(r"""\$\(\s*["']([A-Za-z0-9_-]+)["']\s*\)""", _ntwin_js))
_nt_ids |= set(re.findall(r"""getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)""", _ntwin_js))
_nt_missing = sorted(i for i in _nt_ids if ('id="%s"' % i) not in _ntxhtml)
ok(len(_nt_ids) >= 8, "50.10 从笔记工具窗口脚本提取到元素 id（实测 %d 个）" % len(_nt_ids))
ok(not _nt_missing,
   "50.11 ★ note-tools.xhtml 覆盖窗口脚本引用的全部 id → 缺失: %s" % (_nt_missing or "无"))
ok('windowtype="papilot:notetools"' in _ntxhtml and "papilot:notetools" in _nt_js,
   "50.12 窗口类型一致（openDialog 的「已开则聚焦」靠它）")

# ⑤ OCR 模块接口与问答回退契约
for _fn in ["clampScale", "clampMaxPages", "pickScale", "mergePages", "joinPages", "sidecarName",
            "textFor", "ocrAttachment", "ocrItem", "runForSelected", "cancel"]:
    ok(_fn in _ocr_js, "50.13 ocr.js 提供 %s" % _fn)
ok("ocrAutoFallback" in _chatjs and "_ocrFallbackText" in _chatjs and "textFor" in _chatjs,
   "50.14 ★ AIChat 全文为空时回退 OCR 侧车（受 ocrAutoFallback 控制）")
ok(r"/[ \t]+\n/g" in _chatjs, "50.15 ★ OCR 回退只压行尾空白（保留页间空行）")
ok("绝不传 mode" in _ocr_js, "50.16 ocr.js 写明 IOUtils.writeUTF8 不传 mode 的纪律")
ok('"chrome/content/vendor/pdfjs/pdf.worker.min.js"' in _ocr_js,
   "50.17 ocr.js 的 worker 兜底同样指向 vendor worker")

# ⑥ 设置面板 OCR 子块（控件 + 钳制）
for _id in ["pp-ocr-maxpages", "pp-ocr-scale", "pp-ocr-autofallback", "pp-ocr-skip"]:
    ok(('id="%s"' % _id) in prefs_xhtml, "50.18 设置面板含 OCR 控件 #%s" % _id)
ok("ocrClampPages" in _pane_js2 and "ocrClampScale" in _pane_js2 and "initOcr" in _pane_js2,
   "50.19 ★ 设置面板对 OCR 输入钳制（页数 1–500 / 倍率 1.5-2-3）并显式读写 pref")
ok("svc.clampMaxPages" in _pane_js2 and "svc.pickScale" in _pane_js2,
   "50.20 ★ 面板复用 OcrService 的钳制判定（单一真源，避免面板与流程各钳一套）")

# ⑦ 密钥托管（插件 0.64.0 / 服务端 1.9.0）：服务端 × account.js × 分区列 × 设置面板
#   这条链路最容易「三端各改一半」——端点加了但列不读、按钮加了但没绑，都是静默失败。
_srv_host = io.open(SRV, encoding="utf-8").read()
_acct_host = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js"),
                     encoding="utf-8").read()
_rankhost_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "columns", "rank-column.js"),
                       encoding="utf-8").read()
for _p in ["/api/user/secrets", "hostedSecretsView", "secretbox.encrypt", "maskSecret"]:
    ok(_p in _srv_host, "50.21 ★ 服务端实现密钥托管：%s" % _p)
ok("url.indexOf('/api/user/secrets/') === 0" in _srv_host
   and "url === '/api/user/secrets' || url.startsWith('/api/user/secrets/')" in _srv_host,
   "50.22 ★ 托管接口挂在登录态分组里（未登录 401，不泄漏账号是否有托管）")
for _m in ["hostedSecrets", "revealHostedSecret", "saveHostedSecret", "deleteHostedSecret"]:
    ok(("async %s(" % _m) in _acct_host, "50.23 account.js 提供 %s" % _m)
ok("this._hostedKey" in _rankhost_js and "revealHostedSecret" in _rankhost_js
   and "refreshHostedKey" in _rankhost_js,
   "50.24 ★ 分区列在本机无 Key 时回落账号托管 Key，且 pref 清空后能重新评估")
for _id in ["pp-es-host-save", "pp-es-host-load", "pp-es-host-del", "pp-es-host-state"]:
    ok(('id="%s"' % _id) in prefs_xhtml, "50.25 设置面板含托管控件 #%s" % _id)
ok('bind("pp-es-host-save"' in _pane_js2 and "onHostLoad" in _pane_js2
   and "refreshHostState" in _pane_js2,
   "50.26 ★ 三个托管按钮均已绑定并回显状态（只加控件不接线 = 点了没反应）")
ok("maskSecret(value)" in _srv_host,
   "50.27 ★ 审计只记掩码（日志不能成为密钥的第二份副本）")

# ⑧ 迁移提示包（旧 ID · 0.55.9）：改名的收尾，缺口一开就再也触达不到老用户
_mig_manifest_p = os.path.join(ROOT, "migration", "manifest.json")
ok(os.path.exists(_mig_manifest_p), "51.1 存在 migration/manifest.json")
if os.path.exists(_mig_manifest_p):
    _mig = json.loads(io.open(_mig_manifest_p, encoding="utf-8").read())
    _mig_zot = (_mig.get("applications") or {}).get("zotero") or {}
    ok(_mig_zot.get("id") == "paperpilot@dev.local",
       "51.2 ★ 迁移包必须沿用旧 ID paperpilot@dev.local（新 ID 就不会被旧通道拉取）")
    _mv = tuple(int(x) for x in str(_mig.get("version", "0")).split("."))
    ok(_mv > (0, 54, 0) and _mv < (0, 56, 0),
       "51.3 迁移包版本在 0.54.0 与 0.56.0 之间（当前 %s）" % _mig.get("version"))
    _mig_build = io.open(os.path.join(ROOT, "scripts", "build-migration-xpi.py"), encoding="utf-8").read()
    ok("REQUIRED_ID = \"paperpilot@dev.local\"" in _mig_build and "MIN_VERSION = (0, 54, 0)" in _mig_build,
       "51.4 构建脚本自带 ID/版本硬校验（改错 ID 会直接构建失败）")
    _old_upd = json.loads(io.open(os.path.join(ROOT, "paperpilot-update.json"), encoding="utf-8").read())
    _old_list = (((_old_upd.get("addons") or {}).get("paperpilot@dev.local") or {}).get("updates") or [])
    _hit = [x for x in _old_list if x.get("version") == _mig.get("version")]
    ok(len(_hit) == 1, "51.5 ★ 旧更新清单里有这个迁移版本（否则老用户检查更新看不到）")
    if _hit:
        ok("dist/paperpilot-%s.xpi" % _mig.get("version") in (_hit[0].get("update_link") or ""),
           "51.6 清单里的 update_link 指向 dist 下的迁移包")
        ok(len(_hit[0].get("whatsNew") or "") > 20, "51.7 whatsNew 写清了「先卸载再装新版」")
    ok(os.path.exists(os.path.join(ROOT, "dist", "paperpilot-%s.xpi" % _mig.get("version"))),
       "51.8 迁移包产物已构建")
ok("migration" not in io.open(os.path.join(ROOT, "scripts", "build-xpi.py"), encoding="utf-8").read(),
   "51.9 主包构建脚本不包含 migration/（提示包不得混进 Papilot 本体）")


# ==================== 52. 设置面板信息架构与视觉规范（0.65.0） ====================
# 18 组设置按「用户要做的事」分成 7 大类，并新增顶部工具条（搜索 / 计数 / 批量折叠 / 大类直达）。
# 守卫盯四件事：
#   ① 7 个大类标签都在、且每个带名称与计数（脚本只认 .pp-cat-name，缺了就变成空 chip）；
#   ② 搜索三件套（输入框 / 清空 / 计数）都在 XHTML 里，且 prefs-fold.js 真有过滤逻辑
#      （只加控件不接线 = 用户输了字没反应）；
#   ③ 视觉令牌与组件规则在 prefs.css 里成套存在（颜色/间距/圆角/阴影各至少一处引用），
#      且响应式断点没被删；
#   ④ 折叠卡数量不变（18 张）——重组只许搬家，不许增删功能卡。
_cat_names = re.findall(r'class="pp-cat-label"><html:span class="pp-cat-name">([^<]+)</html:span>'
                        r'<html:span class="pp-cat-count">(\d+) 项</html:span>', prefs_xhtml)
ok(len(_cat_names) == 7, "52.1 7 个大类标签都带名称与计数（实际 %d 个）" % len(_cat_names))
ok([n for n, _ in _cat_names] == ["账号与会员", "AI 能力", "阅读与翻译", "文献获取",
                                 "条目与标签", "界面与效率", "数据与同步"],
   "52.2 ★ 分类顺序按使用频率固定（改顺序属于信息架构变更，需同步文档）")
ok(sum(int(c) for _, c in _cat_names) == 21,
   "52.3 各大类计数之和 = 21（计数写错会让用户以为丢功能；0.72.4 翻译卡拆三后 阅读与翻译=5）")
for _id in ("pp-toolbar", "pp-prefs-search", "pp-prefs-search-clear", "pp-pref-count", "pp-anchor-nav"):
    ok('"%s"' % _id in prefs_xhtml or 'id="%s"' % _id in prefs_xhtml or _id in prefs_xhtml,
       "52.4 设置面板含工具条元素 %s" % _id)
_fold_js = io.open(os.path.join(ROOT, "chrome", "content", "prefs-fold.js"), encoding="utf-8").read()
ok("function initSearch()" in _fold_js and 'pp-hidden' in _fold_js and 'pp-searching' in _fold_js,
   "52.5 ★ prefs-fold.js 实现搜索过滤（切 pp-hidden / pp-searching，不改折叠 pref）")
ok('data-search-strings-raw' in _fold_js,
   "52.6 搜索索引用 data-search-strings-raw（中英文关键词别名，改标题不会让老词搜不到）")
ok("prefsFoldOpen" in _fold_js and "classList.toggle" in _fold_js,
   "52.7 折叠仍走类名 + prefsFoldOpen（不重建节点）")
_hk_js = io.open(os.path.join(ROOT, "chrome", "content", "prefs-hotkeys.js"), encoding="utf-8").read()
ok(".pp-cat-name" in _hk_js,
   "52.8 ★ 大类直达 chip 取 .pp-cat-name（否则 chip 文字会带上「N 项」）")
for _tok in ("--pp-surface:", "--pp-surface-2:", "--pp-field:", "--pp-border:", "--pp-text:",
             "--pp-muted:", "--pp-accent:", "--pp-danger:", "--pp-radius-lg:", "--pp-shadow-1:",
             "--pp-sp-2:", "--pp-fs-md:"):
    ok(_tok in prefs_css, "52.9 prefs.css 定义令牌 %s" % _tok)
for _sel in (".pp-root .pp-toolbar", ".pp-root .pp-search", ".pp-root .pp-count",
             ".pp-root .pp-anchor-nav", ".pp-root .pp-cat-count", ".pp-root .pp-hidden",
             ".pp-root .pp-hk-row", ".pp-root .pp-mem-kind"):
    ok(_sel + " {" in prefs_css or _sel + "," in prefs_css, "52.10 prefs.css 有组件规则 %s" % _sel)
ok("@media (max-width: 560px)" in prefs_css and "@media (prefers-color-scheme: dark)" in prefs_css,
   "52.11 ★ 响应式（≤560px 单列）与暗色主题两套规则都在")
ok("prefers-reduced-motion" in prefs_css, "52.12 尊重系统的减少动效偏好")
ok("class=\"pp-card pp-fold\"" in prefs_xhtml and prefs_xhtml.count('class="pp-card pp-fold"') == 21,
   "52.13 折叠卡仍为 21 张（重组只搬家；0.68.1 新增 WPS 集成、0.72.4 翻译卡拆三仅加卡不改结构）")
ok(os.path.exists(os.path.join(ROOT, "test", "prefs-fold.test.js")),
   "52.14 折叠/搜索测试套件在库")


# ==================== 53. 门禁三态 / CI / 版本单源（0.65.1） ====================
# 这一批治的是「验证靠人」：门禁能不能被看见、文档会不会漂、更新清单会不会漏。
_pf = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok('状态 ∈ "pass" / "skip" / "fail"' in _pf and "skipped=True" in _pf,
   "53.1 ★ preflight 结果三态（pass/skip/fail），跳过不再记成通过")
ok("_e2e_skip" in _pf and '("跳过" in out or "SKIPPED" in out)' in _pf,
   "53.2 ★ 后台 E2E 自行跳过（exit 0 + 输出含「跳过」）会被识别为 skip")
ok('if strict and skipped' in _pf and '"--strict"' in _pf,
   "53.3 --strict：跳过项按失败处理（CI 用）")
ok('fast and "--strict" in argv' in _pf,
   "53.4 ★ --strict 与 --fast 互斥（fast 必然跳过 E2E，否则等于自我否定）")
ok("sync-docs-version.py" in _pf and '"--check"' in _pf,
   "53.5 preflight 含「文档版本」检查步骤")
ok(os.path.exists(os.path.join(ROOT, "scripts", "sync-docs-version.py")),
   "53.6 scripts/sync-docs-version.py 在库（版本单源工具）")
_gate = os.path.join(ROOT, ".github", "workflows", "gate.yml")
ok(os.path.exists(_gate), "53.7 .github/workflows/gate.yml 在库（测试 CI）")
if os.path.exists(_gate):
    _g = io.open(_gate, encoding="utf-8").read()
    ok("preflight.py --strict" in _g, "53.8 ★ CI 以 --strict 跑门禁（跳过即红）")
    ok("PP_CHROME" in _g and "playwright-core" in _g,
       "53.9 CI 装了 E2E 依赖并注入浏览器路径（否则 E2E 必跳过）")
_bx = io.open(os.path.join(ROOT, "scripts", "build-xpi.py"), encoding="utf-8").read()
ok("papilot-update.json" in _bx and "_whats_new" in _bx,
   "53.10 ★ 打包后自动 upsert 更新清单（治好「漏一条老用户升不上」）")
ok('mf["version"] != VER' in _bx,
   "53.11 试打包（包内版本 ≠ 命令行版本）不写更新清单")
ok("--no-update-json" in _bx, "53.12 提供 --no-update-json 逃生口")
# 清单最新版本必须等于 manifest（bump 了没打包 → 老用户拿不到新版）
try:
    _upd = json.loads(io.open(os.path.join(ROOT, "papilot-update.json"), encoding="utf-8").read())
    _ul = (((_upd.get("addons") or {}).get("papilot@dev.local") or {}).get("updates") or [])
    _uvs = sorted((tuple(int(x) for x in str(u.get("version", "0")).split(".") if x.isdigit())
                   for u in _ul), reverse=True)
    _mf_cur = (re.search(r'"version"\s*:\s*"([^"]+)"', MANIFEST) or [None, ""])[1]
    ok(["%d.%d.%d" % v for v in _uvs][:1] == [_mf_cur] or
       ".".join(str(x) for x in _uvs[0]) == _mf_cur,
       "53.13 ★ 更新清单最新版本 == manifest 版本（%s）"
       % ".".join(str(x) for x in _uvs[0]) if _uvs else "53.13 更新清单为空")
except Exception as _e:
    ok(False, "53.13 更新清单可解析：%s" % _e)
# 文档版本漂移（门禁有步骤，这里静态再钉一次：单独跑 check-wiring 也能发现）
_agents = io.open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read()
_mf_v = (re.search(r'"version"\s*:\s*"([^"]+)"', MANIFEST) or [None, ""])[1]
ok("（当前 `%s`）" % _mf_v in _agents,
   "53.14 AGENTS.md 的插件版本与 manifest 一致（当前 %s）" % _mf_v)
_readme = io.open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
ok("badge/version-%s-blue" % _mf_v in _readme,
   "53.15 README badge 与 manifest 一致（当前 %s）" % _mf_v)
# 可访问性（0.65.1）：标题行必须键盘可达
ok('setAttribute("role", "button")' in _fold_js and 'setAttribute("tabindex", "0")' in _fold_js,
   "53.16 ★ 折叠标题行 role=button + tabindex（键盘可聚焦）")
ok('addEventListener("keydown"' in _fold_js and 'aria-expanded' in _fold_js,
   "53.17 ★ Enter/Space 可切换，且 aria-expanded 随状态同步")
ok(":focus-visible" in prefs_css, "53.18 prefs.css 有键盘焦点环（:focus-visible）")


# ==================== 54. 统一设计令牌（0.65.2） ====================
# 设置面板有一套令牌，四个独立窗口各自重抄一份 —— 同一语义四份取值。0.65.2 建了唯一词汇表
# `chrome/content/ui-tokens.css`，窗口用 @import 引入（本地声明在后，计算值不变，已逐令牌实测）。
# 守卫：词汇表在、窗口都引入、位置正确（@import 必须是第一条有效语句）、与 prefs 不漂移。
_ui_tok_p = os.path.join(ROOT, "chrome", "content", "ui-tokens.css")
ok(os.path.exists(_ui_tok_p), "54.1 chrome/content/ui-tokens.css 在库（唯一词汇表）")
if os.path.exists(_ui_tok_p):
    _ut = re.sub(r"/\*[\s\S]*?\*/", "", io.open(_ui_tok_p, encoding="utf-8").read())
    for _t in ("--pp-surface:", "--pp-surface-2:", "--pp-field:", "--pp-border:",
               "--pp-border-strong:", "--pp-text:", "--pp-muted:", "--pp-faint:",
               "--pp-accent:", "--pp-danger:", "--pp-radius-md:", "--pp-shadow-1:",
               "--pp-sp-2:", "--pp-fs-md:"):
        ok(_t in _ut, "54.2 词汇表定义 %s" % _t)
    ok(':root:not([data-theme="light"])' in _ut and ':root[data-theme="dark"]' in _ut,
       "54.3 ★ 明暗三态齐备（系统深色带 :not([data-theme=light]) guard，显式深色走 data-theme）")
    for _alias in ("--pp-soft:", "--pp-border2:", "--pp-subtle:", "--pp-bg:", "--pp-code-bg:"):
        ok(_alias in _ut, "54.4 保留历史别名 %s（迁移期可解析）" % _alias)
    # 与 prefs.css 同值（配色只有一处真理）
    _pf = re.sub(r"/\*[\s\S]*?\*/", "", prefs_css)
    for _k, _v in (("--pp-surface", "#ffffff"), ("--pp-accent", "#0969da"),
                   ("--pp-text", "#1f2328"), ("--pp-border", "#d8dee4")):
        ok((_k + ": " + _v) in _pf and (_k + ": " + _v) in _ut,
           "54.5 ★ prefs.css 与词汇表的 %s 同值（%s）" % (_k, _v))
    # 窗口引入位置：@import 必须是 <html:style> 内第一条有效语句
    for _win in ("chat-window", "review-workbench", "skill-store", "workbench"):
        _p = os.path.join(ROOT, "chrome", "content", _win + ".xhtml")
        _src = io.open(_p, encoding="utf-8").read()
        _m = re.search(r"<html:style><!\[CDATA\[([\s\S]*?)\]\]></html:style>", _src)
        _body = re.sub(r"/\*[\s\S]*?\*/", "", _m.group(1)).strip() if _m else ""
        ok(_body.startswith('@import url("chrome://papilot/content/ui-tokens.css");'),
           "54.6 ★ %s 的样式块第一条语句是 @import 统一令牌" % _win)
ok(os.path.exists(os.path.join(ROOT, "test", "ui-tokens.test.js")),
   "54.7 test/ui-tokens.test.js 在库")
ok("ui-tokens.test.js" in _preflight_src, "54.8 preflight 注册 ui-tokens.test.js")


# ==================== 55. B2/B3 并行编排（2026-10-20） ====================
# 并行不是「同时开工」，而是「文件零交集 + 契约先行 + 汇合点单写者」。
# 登记表与校验器一旦漂移（比如任务偷偷加了文件却没登记），冲突会留到合并时才爆。
# 这里把「登记表可解析 / 校验器通过 / 两份契约在库」钉住；真正的 DAG 与交集判断交给校验器。
_par_dir = os.path.join(ROOT, "docs", "parallel")
ok(os.path.isdir(_par_dir), "55.1 docs/parallel/ 在库（并行编排登记目录）")
_tasks_p = os.path.join(_par_dir, "tasks.json")
ok(os.path.exists(_tasks_p), "55.2 docs/parallel/tasks.json 在库（唯一真源）")
if os.path.exists(_tasks_p):
    try:
        _tj = json.loads(io.open(_tasks_p, encoding="utf-8").read())
        _ids = [t.get("id") for t in (_tj.get("tasks") or [])]
        ok(len(_ids) >= 8 and len(set(_ids)) == len(_ids),
           "55.3 登记表任务 id 唯一且不少于 8 个（实际 %d）" % len(_ids))
        ok(any(t.get("id") == "INTEGRATE" for t in _tj["tasks"]),
           "55.4 存在 INTEGRATE 汇合任务（共享文件唯一写者）")
        ok(all(t.get("files") for t in _tj["tasks"]),
           "55.5 每个任务都声明了文件集（否则交集校验形同虚设）")
    except Exception as _e:
        ok(False, "55.6 tasks.json 可解析：%s" % _e)
ok(os.path.exists(os.path.join(ROOT, "scripts", "parallel-plan.py")),
   "55.7 scripts/parallel-plan.py 在库（DAG / 交集 / 汇合文件校验）")
for _doc in ("ui-kit-contract.md", "wizard-spec.md"):
    ok(os.path.exists(os.path.join(_par_dir, _doc)),
       "55.8 并行契约在库：docs/parallel/%s" % _doc)
ok(os.path.exists(os.path.join(ROOT, "docs", "并行任务编排-B2B3-2026-10-20.md")),
   "55.9 并行编排方案文档在库（调度/依赖/边界/异常/效果/限制）")


# ==================== 56. ui-kit 组件层与首次向导（B2.0 / B3.1） ====================
# 并行开发的两个产出：组件层是共享 API，向导是独立窗口。守卫盯「在库 + 被注册 + 不越界」。
_kit = os.path.join(ROOT, "chrome", "content", "ui-kit.css")
ok(os.path.exists(_kit), "56.1 chrome/content/ui-kit.css 在库（组件层唯一实现）")
if os.path.exists(_kit):
    _kc = re.sub(r"/\*[\s\S]*?\*/", "", io.open(_kit, encoding="utf-8").read())
    ok("!important" not in _kc, "56.2 ★ 组件层不留 !important")
    ok('@import url("chrome://papilot/content/ui-tokens.css")' in _kc,
       "56.3 组件层内部引入统一令牌（消费方只引 ui-kit）")
    for _cls in (".pp-btn {", ".pp-btn-primary", ".pp-btn-sm", ".pp-input", ".pp-select",
                 ".pp-textarea", ".pp-chip", ".pp-card", ".pp-row", ".pp-label",
                 ".pp-hint", ".pp-msg", ".pp-empty"):
        ok(_cls in _kc, "56.4 组件层实现 %s" % _cls)
_wz = os.path.join(ROOT, "chrome", "content", "wizard.xhtml")
ok(os.path.exists(_wz), "56.5 chrome/content/wizard.xhtml 在库（首启向导）")
if os.path.exists(_wz):
    _wx = io.open(_wz, encoding="utf-8").read()
    ok('windowtype="papilot:wizard"' in _wx, "56.6 ★ 向导窗口 windowtype = papilot:wizard（B3.2 单例靠它）")
    ok("wizard.js" in _wx and "wizard.css" in _wx, "56.7 向导引入自己的 js/css")
    ok("<?xml" not in _wx, "56.8 向导不写 XML 声明（避免 parseXULToFragment 报错）")
    _bad_ent = re.findall(r"&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)[a-zA-Z][a-zA-Z0-9]*;", _wx)
    ok(not _bad_ent, "56.9 ★ 向导无未定义命名实体：%s" % (_bad_ent[:3] or "无"))
    _wzjs = io.open(os.path.join(ROOT, "chrome", "content", "wizard.js"), encoding="utf-8").read()
    ok("applyOutcome" in _wzjs and "WRITE_WHITELIST" in _wzjs,
       "56.10 ★ 向导写入有白名单（只 wizardDone / wizardDoneAt / translateCfg）")
    ok("wizardDone" in _wzjs and "skipped" in _wzjs, "56.11 跳过会记 skipped（之后不再自动弹）")
for _t in ("ui-kit.test.js", "wizard.test.js"):
    ok(os.path.exists(os.path.join(ROOT, "test", _t)), "56.12 test/%s 在库" % _t)
    ok(_t in _preflight_src, "56.13 preflight 注册 %s" % _t)
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "ui-kit.css")),
   "56.14 组件层与向导均已随包产出（chrome/content 下，构建自动包含）")


# ==================== 57. skill-store 迁到 ui-kit（B2.1） ====================
# B2 的迁移样板：窗口只保留布局类，控件交 ui-kit。守卫防两种回退：
#   ① 又冒出一套本地按钮/输入样式（复制粘贴回潮）；② 高特异性规则把 kit 的高度压掉。
_ss_x = os.path.join(ROOT, "chrome", "content", "skill-store.xhtml")
_ss_j = os.path.join(ROOT, "chrome", "content", "skill-store.js")
ok(os.path.exists(_ss_x), "57.1 skill-store.xhtml 在库")
if os.path.exists(_ss_x):
    _sx = io.open(_ss_x, encoding="utf-8").read()
    ok("@import url(\"chrome://papilot/content/ui-tokens.css\")" in _sx,
       "57.2 ★ 商店窗口先引入统一令牌（ui-tokens 测试要求第一条 @import 是它）")
    ok('class="pp-btn' in _sx and 'class="pp-input' in _sx,
       "57.3 ★ 商店按钮/输入已改用 ui-kit 类（.pp-btn / .pp-input）")
    ok("button.pp-ss-btn {" not in _sx,
       "57.4 ★ 不再自定义按钮底/悬停（重复样式回潮即红）")
    # 输入/文本域只剩「窗口特有」的一条最小高度；底/描边/焦点都在 ui-kit
    _tr = re.search(r"#pp-ss-root textarea\.pp-ss-textarea \{([^}]*)\}", _sx)
    ok("pp-ss-input" not in _sx
       and (_tr is None or _tr.group(1).strip().startswith("min-height")),
       "57.5 ★ 不再自定义输入底/描边（文本域只留 min-height）")
    # 三保险规则不得含 height:auto —— 它 (1,0,1) 会压掉 .pp-btn 的 28px（本次真实踩到）
    # ★ 必须先剥注释再判：本次的说明注释里就写着「不写 height:auto」，直接字符串搜索会误判
    _sx_nc = re.sub(r"/\*[\s\S]*?\*/", "", _sx)
    _blanket = re.search(r"#pp-ss-root input, #pp-ss-root select, #pp-ss-root textarea, #pp-ss-root button \{([^}]*)\}", _sx_nc)
    ok(_blanket is not None and "height:auto" not in _blanket.group(1),
       "57.6 ★ 控件三保险不含 height:auto（否则压掉 ui-kit 的 28px 高度）")
    ok("pp-ss-btn-danger" in _sx, "57.7 危险操作仍保留窗口语义修饰（pp-ss-btn-danger）")
if os.path.exists(_ss_j):
    _sj = io.open(_ss_j, encoding="utf-8").read()
    _left = _sj.replace("pp-ss-btn-danger", "")
    ok("pp-ss-btn" not in _left and "pp-ss-input" not in _sj,
       "57.8 ★ 脚本动态创建的控件也用 ui-kit 类（否则列表里的按钮还是旧样式）")


# ==================== 58. 其余三个窗口迁到 ui-kit（B2.2 / B2.3） ====================
# 与 skill-store 同一套路：控件交 kit、窗口只留布局与语义修饰。
# 三种回退一旦出现就会静默变形：①又冒本地按钮底/悬停 ②三保险里的 height:auto 压掉 28px
# ③输入/发送仍由 ID 规则写死配色（kit 不生效却看不出）。
def _rule_body(text, sel):
    mm = re.search(re.escape(sel) + r"\s*\{([^}]*)\}", text)
    return mm.group(1) if mm else None

_rw = io.open(os.path.join(ROOT, "chrome", "content", "review-workbench.xhtml"), encoding="utf-8").read()
_rwn = re.sub(r"/\*[\s\S]*?\*/", "", _rw)
ok("button.pp-rw-btn {" not in _rwn, "58.1 ★ 综述工作台不再自定义按钮底/悬停")
ok('class="pp-btn' in _rw and 'class="pp-input' in _rw, "58.2 综述工作台控件已用 ui-kit 类")
_b = _rule_body(_rwn, "#pp-rw-root input, #pp-rw-root textarea, #pp-rw-root button")
ok(_b is not None and "height:auto" not in _b, "58.3 ★ 综述工作台三保险不含 height:auto")
ok(".pp-rw-col textarea.pp-textarea" in _rw, "58.4 列编辑器布局特例仍生效（类名已随迁）")

_cw = io.open(os.path.join(ROOT, "chrome", "content", "chat-window.xhtml"), encoding="utf-8").read()
_cwn = re.sub(r"/\*[\s\S]*?\*/", "", _cw)
ok('id="pp-cw-send" class="pp-btn pp-btn-primary pp-btn-lg"' in _cw,
   "58.5 ★ 分屏问答的发送按钮用 kit 大号主按钮（36px，与多行输入同高）")
ok('id="pp-cw-input" class="pp-textarea"' in _cw, "58.6 分屏问答输入框用 .pp-textarea")
_sendb = _rule_body(_cwn, "#pp-cw-send") or ""
ok("background" not in _sendb and "border-radius" not in _sendb,
   "58.7 ★ 发送按钮不再由 ID 规则写死底色/圆角（交 kit）")
ok("--pp-field:" in _cw, "58.8 分屏问答补了 ui-kit 需要的 --pp-field（暗色不白块）")

_wb = io.open(os.path.join(ROOT, "chrome", "content", "workbench.xhtml"), encoding="utf-8").read()
_wbn = re.sub(r"/\*[\s\S]*?\*/", "", _wb)
ok('id="pp-wb-send" class="pp-btn pp-btn-primary pp-btn-lg"' in _wb
   and 'id="pp-wb-stop" class="pp-btn pp-btn-lg"' in _wb,
   "58.9 ★ 工作台发送/停止用 kit 大号按钮")
_wb_send = _rule_body(_wbn, "#pp-wb-send") or ""
ok("background" not in _wb_send, "58.10 工作台发送按钮不再写死底色")
ok("--pp-field:" in _wb, "58.11 工作台补了 ui-kit 需要的 --pp-field")
ok(".pp-btn-lg {" in io.open(os.path.join(ROOT, "chrome", "content", "ui-kit.css"),
                             encoding="utf-8").read(),
   "58.12 组件层已提供 .pp-btn-lg（编辑器主操作档位）")


# ==================== 59. 向导接线与「推荐配置」入口（B3.2 / B3.3） ====================
# 向导窗口做好但没接线 = 用户永远看不到；接线了但首启不加锁 = 每次启动都弹。
# 这里把「打开 / 单例 / 只弹一次 / 菜单入口 / 关窗算跳过 / 推荐配置入口」逐条钉住。
_mn = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "main.js"), encoding="utf-8").read()
_me = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read()
_ut = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"), encoding="utf-8").read()
_pj = io.open(os.path.join(ROOT, "chrome", "content", "wizard.js"), encoding="utf-8").read()
ok("openWizard()" in _mn and "papilot:wizard" in _mn,
   "59.1 ★ 主模块有 openWizard()，按 papilot:wizard 单例聚焦")
ok('Prefs.get("wizardDone", "")' in _mn and "first-run wizard scheduled" in _mn,
   "59.2 ★ 首启只在 wizardDone 为空时弹一次（延迟触发，失败不挡启动）")
ok("papilot-menu-wizard" in _me and "openWizard" in _me, "59.3 工具菜单有「首次使用向导」入口")
ok("menuWizard" in _ut, "59.4 菜单文案进 I18n 字典（中英双语）")
ok('pref("extensions.zotero.papilot.wizardDone", "")' in prefsdef, "59.5 prefs.js 有 wizardDone 默认值（空 = 未走过）")
ok("unload" in _pj and "skipped" in _pj, "59.6 ★ 关窗也算「稍后」（不会下次启动又弹）")
ok('id="pp-recommend"' in prefs_xhtml and 'id="pp-wizard-open"' in prefs_xhtml,
   "59.7 ★ 设置面板工具条有「推荐配置」与「首次使用向导」两个入口")
ok('id="pp-recommend-msg"' in prefs_xhtml, "59.8 推荐配置有结果提示位（不静默改）")
ok("prefs-recommend.js" in _mn, "59.9 推荐配置脚本已注册到设置面板")
ok("window.PapilotRecommend" in io.open(os.path.join(ROOT, "chrome", "content", "prefs-recommend.js"),
                                        encoding="utf-8").read(),
   "59.10 推荐配置暴露纯逻辑（plan/apply 可单测）")
ok(os.path.exists(os.path.join(ROOT, "test", "prefs-recommend.test.js")),
   "59.11 test/prefs-recommend.test.js 在库")
ok("prefs-recommend.test.js" in _preflight_src, "59.12 preflight 注册推荐配置测试")

# ---- 59.13~59.16（0.68.3）向导「能打开但用不了 / 老用户反复被弹」回归守卫 ----
# 真机根因：openDialog 打开的 chrome 窗口没有 Zotero 全局，wizard.js 却裸用 Zotero.Prefs，
# 于是 pref 读写全失败（wizardDone 永远为空 → 每次启动都弹）且 account/channels 拿不到
# （登录回「账号模块未就绪」）。静态层必须钉住「作用域只从 window.arguments 来」。
ok("window.arguments" in _pj and "ARGS.Zotero" in _pj,
   "59.13 ★ 向导窗口经 window.arguments 取 Zotero（窗口作用域没有 Zotero 全局）")
ok("Zotero.Prefs.set(PFX" not in _pj and "Zotero.Prefs.get(PFX" not in _pj,
   "59.14 ★ 向导不裸用 Zotero.Prefs（写入走 pSet → 失败会记进 failed）")
ok("out.failed" in _pj and "没能保存" in _pj,
   "59.15 ★ 写入失败在完成页如实列出（不再显示「成功」）")
ok("_accountRestore" in _mn and "WizardGate.decide" in _mn and "_maybeFirstRunWizard" in _mn,
   "59.16 ★ 首启闸门等会话恢复后判定：已登录 / 已配通道 → 不弹并补写 skipped")
_wz_test = io.open(os.path.join(ROOT, "test", "wizard.test.js"), encoding="utf-8").read()
ok("window.arguments" in _wz_test and "WizardGate" in _wz_test,
   "59.17 向导测试覆盖窗口作用域与闸门矩阵（不只测纯逻辑）")

# ---- 59.18~59.22（0.68.3）「第一步只给登录」与「选 AI 却必然失败」两个逻辑漏洞 ----
# 用户原话：首次引导里没有注册选项，极其不合理。向导是新用户唯一会打开的界面，
# 只给登录 = 没账号的人无路可走；同理未登录却把翻译留在 llm = 第一次用必然失败。
ok("pp-wz-reg-view" in _wx and 'id="pp-wz-reg"' in _wx and "pp-wz-reg-link" in _wx,
   "59.18 ★ 向导第一步有注册入口（登录/注册双视图，可互相切换）")
ok("A.register" in _pj and "needVerify" in _pj,
   "59.19 ★ 向导复用 account.register，并按 needVerify 决定是否自动登录")
ok("密码至少 8 位" in _pj and "两次输入的密码不一致" in _pj,
   "59.20 注册校验与设置面板同标准（≥8 位 / 两次一致 / 邮箱格式）")
ok("自动改用免费" in _pj and "channelUsable" in _pj,
   "59.21 ★ 第 3 步：没有可用通道时自动回落免费引擎并说明")
ok("注册" in _ut and "chatNotLoggedIn" in _ut,
   "59.22 未登录指引提到注册（AI 未就绪提示是 34 处功能的统一出口）")
ok("isPro" in _pj and "plan === 'pro'" not in _pj,
   "59.23 ★ 档位用 account.isPro() 判断（服务端是 'Pro' 大写，比 'pro' 会把专业版显示成免费版）")
ok("pp-wz-settings" in _wx and "openSettings" in _pj,
   "59.24 完成页有「打开设置」入口（只写「去设置里改」却不给入口 = 死路）")
ok("保持当前通道" in _pj and "channelTouched" in _pj,
   "59.25 ★ 重开向导不改变现有通道（没点过通道卡片 = 保持现状）")


# ---------- 60. WPS 集成（Papilot Cite；0.71.1 起加载项随包分发） ----------
# 背景：0.68.x 那套 wps-zotero 加载项 + 21931 代理 + 从 Gitee 下 bundle.json 的方案已废弃
#   （装上了连不上 Zotero，用户实测），现由 wps-cite/ 的 Papilot Cite 取代：
#   加载项本体是我们自己的 Apache-2.0 代码，构建时同步进 xpi，卡片里一键安装。
# 这里守四件事：①接线在；②名字/端口对；③面板 id 齐；④旧方案不许悄悄回来。
_PWPS_JS = os.path.join(ROOT, "chrome", "content", "prefs-wps.js")
_WB_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "wps-bridge.js")
_WPS_SRC = os.path.join(ROOT, "wps-cite", "addon")          # 加载项单一真源（构建时同步，不在 chrome/ 复制）
_WPS_PROXY = os.path.join(ROOT, "wps-cite", "proxy", "proxy.py")

ok(os.path.exists(_PWPS_JS), "60.1 prefs-wps.js 存在（设置面板脚本）")
ok("prefs-wps.js" in mainjs, "60.2 main.js 注册 prefs-wps.js（scripts 列表）")
ok(os.path.exists(_WB_JS), "60.3 features/wps-bridge.js 存在（检测/安装/清理）")
ok("features/wps-bridge.js" in mainjs, "60.4 main.js 加载 features/wps-bridge.js")
ok("this.wpsBridge" in mainjs, "60.5 main.js 暴露 Zotero.Papilot.wpsBridge（面板经此访问）")
ok(os.path.exists(os.path.join(_WPS_SRC, "index.html")) and os.path.exists(os.path.join(_WPS_SRC, "version.js")),
   "60.6 加载项单一真源 wps-cite/addon 在库")
ok(os.path.exists(_WPS_PROXY), "60.7 代理源 wps-cite/proxy/proxy.py 在库")
_BUILD_XPI = os.path.join(ROOT, "scripts", "build-xpi.py")
_bx = io.open(_BUILD_XPI, encoding="utf-8").read() if os.path.exists(_BUILD_XPI) else ""
ok("wps-cite" in _bx and "tools" in _bx,
   "60.8 ★ build-xpi.py 会把 wps-cite 载荷同步进包（否则卡片里装不了加载项）")

_wb = io.open(_WB_JS, encoding="utf-8").read() if os.path.exists(_WB_JS) else ""
ok('ADDON_NAME: "papilot-cite"' in _wb, "60.9 桥接对接的是 papilot-cite")
ok("PROXY_PORT: 21932" in _wb and "ZOTERO_PORT: 23119" in _wb,
   "60.10 端口常量正确（21932 → 23119）")
ok("installAddon" in _wb and "wps-cite.bundle.json" in _wb,
   "60.11 桥接从随包 bundle 安装加载项（不依赖网络）")
ok("fetch(" in _wb and "jar" in _wb,
   "60.11b ★ 载荷必须用 fetch 读（jar 里没有可枚举目录，改回目录复制会静默装不上）")
ok("_safeRel" in _wb and '_safeRel(rel)' in _wb,
   "60.11c ★ 落盘前做相对路径穿越校验")
ok("cleanupLegacy" in _wb and 'LEGACY_NAME: "wps-zotero"' in _wb,
   "60.12 ★ 桥接提供旧版残留清理（两份同时装着会在功能区打架）")
ok("authaddin.json" in _wb, "60.13 安装后清信任记录（否则 WPS 不会重新确认）")
ok("publish.xml" in _wb and 'customDomain=""' in _wb,
   "60.14 注册项格式与 install.py 一致（customDomain 必须为空）")

for _wid in ("pp-wps-detect", "pp-wps-install", "pp-wps-proxy-start", "pp-wps-clean",
             "pp-wps-addon", "pp-wps-trust", "pp-wps-proxy", "pp-wps-zotero",
             "pp-wps-legacy", "pp-wps-reg", "pp-wps-msg"):
    ok(_wid in prefs_xhtml, "60.15 面板含 #%s" % _wid)

# 旧方案的四件东西：必须已经从包里/库里消失，否则用户会再被装一次坏加载项
ok("pp-wps-fix" not in prefs_xhtml,
   "60.16 ★ 旧的「一键修复」按钮已删除（它只会重写 wps-zotero 的注册项）")
ok(not os.path.exists(os.path.join(ROOT, "chrome", "content", "tools", "wps")),
   "60.17 ★ 旧的 21931 CORS 代理不再随包")
ok(not os.path.exists(os.path.join(ROOT, "tools", "wps-zotero")),
   "60.18 ★ 旧加载项源码 tools/wps-zotero 已删除")
ok(not os.path.exists(os.path.join(ROOT, "dist", "papilot-wps-addon.bundle.json")),
   "60.19 ★ 旧发布物 papilot-wps-addon.bundle.json 已删除（别再往用户机器上装它）")
ok("wpsAutoProxy" not in prefsdef and "wpsScriptDir" not in prefsdef,
   "60.20 旧偏好项 wpsAutoProxy / wpsScriptDir 已清理")

ok(os.path.exists(os.path.join(ROOT, "test", "prefs-wps.test.js")),
   "60.21 test/prefs-wps.test.js 在库")
ok("prefs-wps.test.js" in _preflight_src, "60.22 preflight 注册 WPS 集成测试")


# ==================== 61. 设置面板交互与隐私（0.68.3） ====================
# 用户报的两个问题：
#   ① 「设置里面【直达】不可用」——chip 是 createElementNS(XHTML) 的 **HTML** 按钮，
#      只派发 click，而脚本按 XUL 习惯绑了 command → 点了永远没反应（静默、无报错）。
#   ② 「设置里面隐藏账户的邮箱」——账号卡默认明文显示邮箱（没昵称时甚至显示两次）。
# 静态层盯住「HTML 元素不得用 command」「邮箱必须脱敏」两件事，行为层由
# test/prefs-anchors.test.js 与 test/membership-panel.test.js（L1~L5）覆盖。
_PHK = os.path.join(ROOT, "chrome", "content", "prefs-hotkeys.js")
_PMU = os.path.join(ROOT, "chrome", "content", "prefs-menu.js")
_PAC = os.path.join(ROOT, "chrome", "content", "prefs-account.js")
_phk = io.open(_PHK, encoding="utf-8").read() if os.path.exists(_PHK) else ""
_pmu = io.open(_PMU, encoding="utf-8").read() if os.path.exists(_PMU) else ""
_pac = io.open(_PAC, encoding="utf-8").read() if os.path.exists(_PAC) else ""
ok(os.path.exists(_PHK) and os.path.exists(_PMU) and os.path.exists(_PAC),
   "61.1 设置面板三个脚本在库（hotkeys / menu / account）")
# 只查「绑定调用」，不误伤注释里的说明文字
_bad_cmd = []
for _name, _src in (("prefs-hotkeys.js", _phk), ("prefs-menu.js", _pmu)):
    for _m in re.finditer(r'addEventListener\(\s*["\']command["\']', _src):
        _bad_cmd.append(_name + "@" + str(_src[:_m.start()].count("\n") + 1))
ok(not _bad_cmd, "61.2 ★ 设置面板不得对 HTML 元素绑 command（只派发 click/change）：%s" % (_bad_cmd[:3] or "无"))
ok('chip.addEventListener("click"' in _phk,
   "61.3 ★ 直达 chip 绑的是 click（绑 command = 点了没反应）")
ok("scrollToLabel" in _phk and "scrollTop" in _phk,
   "61.4 直达有 scrollIntoView 失效时的 scrollTop 兜底（并让出吸顶工具条高度）")
ok('cb.addEventListener("change"' in _pmu and 'sel.addEventListener("change"' not in _pmu,
   "61.5 菜单定制：复选框绑 change，下拉只在 wireQuick 里绑一次（renderQuick 内不再挂监听器）")
ok("wireQuick" in _pmu and "onQuickChange" in _pmu,
   "61.5b ★ 下拉事件只绑一次（旧实现边渲染边绑 + 末尾重渲染 = 监听器指数增长）")
ok("function maskEmail" in _pac and "paintEmail" in _pac,
   "61.6 ★ 账号卡邮箱默认脱敏（maskEmail + paintEmail）")
ok('$("pp-account-email").textContent = u.email' not in _pac,
   "61.7 账号卡不再把完整邮箱直接写进界面")
ok(os.path.exists(os.path.join(ROOT, "test", "prefs-anchors.test.js")),
   "61.8 test/prefs-anchors.test.js 在库（直达行为冒烟）")
ok("prefs-anchors.test.js" in _preflight_src, "61.9 preflight 注册直达锚点测试")

# 61.10 工具条计数 vs 真实卡片数（0.68.4）
# 0.68.1 加「WPS 集成」卡时忘了改计数，工具条写着「18 项」而实际 19 张卡；
# 各分类的 .pp-cat-count 相加同样是 19。这种纯文案漂移单靠人眼永远看不出来。
_m_pc = re.search(r'id="pp-pref-count"[^>]*>\s*(\d+)\s*项', prefs_xhtml)
_hdr_count = int(_m_pc.group(1)) if _m_pc else -1
_card_count = prefs_xhtml.count('class="pp-card pp-fold"')
_cat_nums = [int(x) for x in re.findall(r'class="pp-cat-count">\s*(\d+)\s*项', prefs_xhtml)]
_cat_sum = sum(_cat_nums)
ok(_hdr_count == _card_count and _cat_sum == _card_count and _card_count > 0,
   "61.10 ★ 工具条计数 = 实际卡片数 = 各分类计数之和（防止 0.68.1 加卡漏改计数，曾出现 18 vs 19）"
   " → 工具条 %d / 卡片 %d / 分类和 %d（%s）"
   % (_hdr_count, _card_count, _cat_sum, "+".join(str(x) for x in _cat_nums)))

# 61.11 搜索空态与索引扩展（0.68.4）
# 只收「卡片标题 + 说明 + 关键词」时，搜「邮箱」「字体」「价格」「退款」「日志」「恢复」全是 0 命中，
# 用户结论是「这个功能不存在」。空态文案 + 卡内小标题/字段名入索引，两件事必须同时在库。
ok('id="pp-prefs-empty"' in prefs_xhtml,
   "61.11a ★ 搜索 0 命中空态容器 #pp-prefs-empty 在 prefs.xhtml")
ok(".pp-root .pp-empty" in prefs_css,
   "61.11b prefs.css 有空态样式 .pp-root .pp-empty（与 .pp-hint 同语气）")
ok('id="pp-prefs-empty"' in prefs_xhtml and "#pp-prefs-empty + .pp-cat-label" in prefs_css,
   "61.11c ★ 插入空态节点后补了 #pp-prefs-empty + .pp-cat-label 的相邻选择器（否则首个分类上边距失效）")
ok('".pp-sub-title"' in _pfold_js and '".pp-label"' in _pfold_js,
   "61.11d ★ buildIndex 把卡内 .pp-sub-title / .pp-label 一并入索引（否则搜字段名 0 命中）")

# 61.12 直达 × 折叠 × 搜索 三者的联动（0.68.4）
# 三个静默失败点：① 搜索态下点直达 → 目标全是 display:none，看到空白；
#                ② 直达展开首卡不写折叠记忆 → 下次开面板又收起、读屏仍报「已折叠」；
#                ③ 搜索态下点折叠头 → 视觉无变化却静默改写 prefsFoldOpen。
ok("PapilotPrefsSearch" in _phk and "PapilotPrefsFold" in _phk,
   "61.12a ★ 直达先清搜索态、再经折叠钩子展开首卡（prefs-hotkeys.js）")
ok("window.PapilotPrefsFold" in _pfold_js and "pp-searching" in _pfold_js,
   "61.12b ★ prefs-fold.js 暴露 PapilotPrefsFold 并在搜索态下忽略折叠头点击")
ok("pp-anchor-active" in _phk and "pp-anchor-active" in prefs_css,
   "61.12c 直达 chip 有「当前分类」高亮（prefs-hotkeys.js + prefs.css）")
_anch_nav_block = re.search(r"\.pp-root \.pp-anchor-nav\s*\{([^}]*)\}", prefs_css)
ok(bool(_anch_nav_block) and "sticky" not in _anch_nav_block.group(1)
   and "fixed" not in _anch_nav_block.group(1),
   "61.12d ★ #pp-anchor-nav 不做 sticky/fixed（双吸顶会遮挡分类标签，明确不做）")

# 61.13 P0–P2 十项修订的行为回归（0.68.4）
# 上一轮的修订全靠临时脚本验证，跑完即删 —— 等价于没有回归网：任何人「顺手简化」
# 都能把脱敏 / 空态 / 直达联动 / 不静默改 pref 重新挖开，且静态守卫看不出来。
ok(os.path.exists(os.path.join(ROOT, "test", "prefs-panel-ux.test.js")),
   "61.13a ★ test/prefs-panel-ux.test.js 在库（P0–P2 修订的行为回归）")
ok("prefs-panel-ux.test.js" in _preflight_src,
   "61.13b ★ preflight 注册 prefs-panel-ux 测试（否则新测试永远不跑）")


# 62 期刊订阅（0.69.0）：内置目录 + ISSN 检索轴 + 面板一键订阅
# 这条链路的静默失败点：① 目录没被打包 / 加载顺序错 → 面板首次渲染空白；
# ② ISSN 拼进 search 而不是 filter → 把整库按日期倒序拉回来（用户以为订到了）；
# ③ 面板节点缺失 → 整块不渲染（脚本里都有判空，所以不会报错）；
# ④ 新测试没进 preflight → 等于没有回归网。
_jc_path = os.path.join(ROOT, "chrome", "content", "scripts", "data", "journals.js")
ok(os.path.exists(_jc_path),
   "62.1 ★ 内置期刊目录在 chrome/content/scripts/data/journals.js（必须随包走）")
_js_cat = io.open(_jc_path, encoding="utf-8").read() if os.path.exists(_jc_path) else ""
_cat_rows = _js_cat.count('{ n: "')
ok(_cat_rows >= 400, "62.2 ★ 目录规模 ≥ 400 种（当前 %d）" % _cat_rows)
ok("var JournalCatalog" in _js_cat and "module.exports" in _js_cat,
   "62.3 目录暴露全局 JournalCatalog（Node 侧可 require 做校验）")
ok("subjects: [" in _js_cat and _js_cat.count('{ id: "') >= 15,
   "62.4 目录按学科分组（≥15 个学科，面板 chips 靠它）")

_main_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "main.js"), encoding="utf-8").read()
_at_data = _main_js.find('"data/journals.js"')
_at_src = _main_js.find('"features/sub-sources.js"')
_at_subs = _main_js.find('"features/search-subs.js"')
ok(_at_data > 0 and _at_data < _at_src and _at_data < _at_subs,
   "62.5 ★ main.js 先加载期刊目录，再加载 sub-sources / search-subs（顺序错 → 首次渲染空白）")

_js_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "sub-sources.js"),
                  encoding="utf-8").read()
ok("normIssn(raw)" in _js_src and "issnsOf(sub)" in _js_src,
   "62.6 ★ ISSN 归一与 issnsOf 在数据源层（单一真源，UI 不自己解析）")
ok("primary_location.source.issn:" in _js_src,
   "62.7 ★ OpenAlex 用 ISSN filter（不是把 ISSN 丢进 search）")
ok('filters.push("issn:' in _js_src, "62.8 ★ Crossref 用 issn filter")
ok('ISSN:"' in _js_src, '62.9 ★ Europe PMC 用 ISSN:"xxxx-xxxx" 原生字段')
ok('"[ta]"' in _js_src, "62.10 PubMed 期刊走刊名 [ta]（PubMed 没有 ISSN 检索字段）")
ok("lookupJournals" in _js_src and "/sources/issn:" in _js_src,
   "62.11 ★ 在线期刊检索（OpenAlex Sources，目录外 3 万+ 刊）")

_js_ss = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "search-subs.js"),
                 encoding="utf-8").read()
ok("_normIssns(raw)" in _js_ss and "journals: this._normJournals" in _js_ss,
   "62.12 ★ 订阅模型含 issns / journals（旧订阅缺字段 → 空值，行为不变）")
ok("journalCatalog()" in _js_ss and "journalFind(q, opts)" in _js_ss,
   "62.13 本地目录过滤 API")
ok("journalSearch(q, opts)" in _js_ss and "_journalLookup" in _js_ss,
   "62.14 ★ 本地 + 在线合并检索")
ok("subscribeJournals(items, opts)" in _js_ss and "journalSubscribed(issn, name)" in _js_ss,
   "62.15 ★ 一键订阅与已订阅判重")
ok("!issns.length && !journals.length" in _js_ss,
   "62.16 ★ add 放行「只有期刊」的订阅（不再强制关键词）")

_js_ps = io.open(os.path.join(ROOT, "chrome", "content", "prefs-subs.js"), encoding="utf-8").read()
ok("renderJournalSubjects" in _js_ps and "loadJournalList" in _js_ps and "doSubscribeJournals" in _js_ps,
   "62.17 ★ 面板期刊区块三段（学科 chips / 搜索 / 订阅）")
for _nid in ["pp-sub-journal-q", "pp-sub-journal-search", "pp-sub-journal-subjects",
             "pp-sub-journal-list", "pp-sub-journal-subscribe", "pp-sub-journal-sel",
             "pp-sub-journals", "pp-sub-journals-clear"]:
    ok('id="%s"' % _nid in prefs_xhtml, "62.18 面板节点 %s" % _nid)
ok("期刊条件可与关键词叠加" in prefs_xhtml,
   "62.19 表单说明「期刊可与关键词叠加」（用户不必猜两个轴能不能一起用）")
ok("期刊 杂志" in prefs_xhtml and "按期刊订阅" in prefs_xhtml,
   "62.20 卡片可被「期刊 / 杂志」搜到（搜索索引含新关键词）")
ok("editIssns" in _js_ps and "pp-sub-journals-clear" in _js_ps,
   "62.21 ★ 编辑订阅保留 ISSN（清空走单独按钮，避免「改刊名但 ISSN 没变」）")
ok("test/journal-catalog.test.js" in _preflight_src,
   "62.22 ★ preflight 注册期刊目录测试（否则新套件永远不跑）")
_jc_test_path = os.path.join(ROOT, "test", "journal-catalog.test.js")
_jc_test = io.open(_jc_test_path, encoding="utf-8").read() if os.path.exists(_jc_test_path) else ""
ok("issnValid" in _jc_test and "mod 11" in _jc_test,
   "62.23 ★ 目录测试校验 ISSN 校验位（手写错号是最常见的数据错误）")
ok("名称不重复" in _jc_test and "ISSN 不重复" in _jc_test,
   "62.24 目录测试覆盖重复名称 / 重复 ISSN")

# ==================== 63. 标签管理（0.70.0） ====================
# 设计前提（改代码前先读这段，否则很容易"好心办坏事"）：
#   · Zotero 10 的 tag selector 是 React + react-virtualized 虚拟列表
#     （components/tagSelector/tagSelectorList.js），div.tag-selector-item 只渲染可视区，
#     点击 = 加/减筛选条件。**不能**在 chip 里插复选框，也不能靠遍历 DOM 统计标签。
#   · 原生 #tag-menu 已有「指派颜色/重命名/拆分/删除」四条单标签操作，
#     所以本功能的增量只可能是批量、规则化、可撤销、体检 —— 不要重复实现单条删除。
#   · removeFromLibrary 直接 DELETE itemTags，**不可撤销**，删除前必须 snapshot。
_TM_OPS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "tag-ops.js")
_TM_MENU = os.path.join(ROOT, "chrome", "content", "scripts", "features", "tag-menu.js")
_TM_UI = os.path.join(ROOT, "chrome", "content", "tag-manager.js")
_TM_XHTML = os.path.join(ROOT, "chrome", "content", "tag-manager.xhtml")
ok(os.path.exists(_TM_OPS), "63.1 ★ 标签数据层 tag-ops.js 存在（必须随包走）")
ok(os.path.exists(_TM_MENU), "63.2 ★ 左下角入口 tag-menu.js 存在")
ok(os.path.exists(_TM_UI) and os.path.exists(_TM_XHTML), "63.3 ★ 管理器窗口脚本与 xhtml 成对存在")

_tops_src = io.open(_TM_OPS, encoding="utf-8").read() if os.path.exists(_TM_OPS) else ""
_tmenu_src = io.open(_TM_MENU, encoding="utf-8").read() if os.path.exists(_TM_MENU) else ""
_tmui_src = io.open(_TM_UI, encoding="utf-8").read() if os.path.exists(_TM_UI) else ""
_tmx_src = io.open(_TM_XHTML, encoding="utf-8").read() if os.path.exists(_TM_XHTML) else ""

ok("var TagOps = {" in _tops_src, "63.4 数据层暴露全局 TagOps")
ok("planRename" in _tops_src and "planMerge" in _tops_src and "planAddParent" in _tops_src,
   "63.5 ★ 改名/合并/层级都是「先出计划再执行」（plan* 纯函数）")
ok("async snapshot(" in _tops_src and "async undo(" in _tops_src,
   "63.6 ★ 快照与撤销成对存在（删除不可逆，只能靠快照回滚）")
ok("removeFromLibrary" in _tops_src, "63.7 删除走 Zotero.Tags.removeFromLibrary")
ok("getSelectedLibraryID" in _tops_src,
   "63.8 ★ 库 ID 取当前选中库（TagCurator 写死 userLibraryID 的坑不再重犯）")
ok("mode:" not in _tops_src,
   "63.9 ★ IOUtils.writeUTF8 不传 mode（传了会截断/权限异常，项目铁律 4）")
ok("isProtected" in _tops_src and "#状态/*" in _tops_src,
   "63.10 ★ 保护名单默认含系统标签（#状态/*、#治理/*）")

# 装配：三个文件都得进 main.js 的加载清单，且顺序不能反（tag-menu 的 install 直接读 TagOps）
ok('"features/tag-ops.js"' in mainjs and '"features/tag-menu.js"' in mainjs,
   "63.11 ★ main.js 装配清单含 tag-ops.js 与 tag-menu.js")
_i_ops = mainjs.find('"features/tag-ops.js"')
_i_menu = mainjs.find('"features/tag-menu.js"')
ok(_i_ops > 0 and _i_menu > _i_ops,
   "63.12 ★ tag-ops 先于 tag-menu 加载（反了 install 时 TagOps 未定义 → 右键入口静默失效）")
ok("this.tagOps = " in mainjs and "this.tagMenu = " in mainjs,
   "63.13 main.js 把 TagOps / TagMenu 挂到 Zotero.Papilot（排障入口）")
ok("TagMenu.install()" in mainjs, "63.14 ★ 启动时安装左下角右键钩子")
ok("TagMenu.unregister()" in mainjs, "63.15 ★ 卸载时摘钩子（否则禁用/重装后菜单重复）")

# 左下角注入：必须挂原生 #tag-menu，且用 popupshowing 重建（原生每次右键会重置 disabled）
ok('getElementById("tag-menu")' in _tmenu_src,
   "63.16 ★ 注入点是原生 #tag-menu（不要去劫持 React 的 contextmenu）")
ok("popupshowing" in _tmenu_src and "_rebuild" in _tmenu_src,
   "63.17 ★ 每次 popupshowing 重建注入项（防重复堆叠 + 跟随原生 disabled）")
ok(".handleTagContext(" not in _tmenu_src,
   "63.18 不去调用/覆盖原生 handleTagContext（版本升级时最容易断裂的接缝）")
ok("openManager" in _tmenu_src and "WINDOW_TYPE" in _tmenu_src,
   "63.19 ★ 单实例窗口复用（Services.wm.getEnumerator）")

# 窗口
ok('windowtype="papilot:tag-manager"' in _tmx_src, "63.20 xhtml 声明 windowtype")
ok('"papilot:tag-manager"' in _tmenu_src,
   "63.21 ★ windowtype 与 tag-menu.js 常量一致（不一致 = 单实例失效，会开出多个窗口）")
ok("DOMContentLoaded" in _tmui_src and "readyState" in _tmui_src,
   "63.22 ★ 窗口脚本有 DOM 就绪守卫（XUL 的 <script src> 可能早于 DOM 执行 → 窗口空白）")
_i_snap = _tmui_src.find("T.snapshot(S.libID, p.names")
_i_del = _tmui_src.find("T.deleteTags(")
ok(_i_snap > 0 and _i_del > _i_snap,
   "63.23 ★ 执行删除时 snapshot 在 deleteTags 之前（顺序反了就没有回滚点）")
ok(".protected" in _tmui_src and "cbInc" in _tmui_src,
   "63.24 ★ 批量删除默认过滤受保护标签，只有显式勾选才包含")
ok("预览删除" in _tmui_src and "确认删除" in _tmui_src,
   "63.25 ★ 破坏性操作两步走：预览 → 确认（没有一键直删）")
ok("已选" in _tmui_src and "可见" not in _tmui_src,
   "63.26 选择语义在界面上写明（全选作用于筛选结果，不是全库）")

# 注册点：菜单 / 文案 / pref / 测试
ok('{ id: "tag-manager", group: "tags"' in io.open(
    os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read(),
   "63.27 ★ 条目右键「标签治理」组里有管理器入口")
_utils_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"),
                     encoding="utf-8").read()
ok("menuTagManager:" in _utils_src, "63.28 菜单文案键 menuTagManager 存在")
_prefs_src = io.open(os.path.join(ROOT, "prefs.js"), encoding="utf-8").read()
for _pk in ["tagMenuEnabled", "tagProtect", "tagSnapshotKeep"]:
    ok("papilot.%s" % _pk in _prefs_src, "63.29 pref 默认值 %s" % _pk)
ok("test/tag-ops.test.js" in _preflight_src, "63.30 ★ preflight 注册标签规则层测试")
ok("test/tag-manager-ui.test.js" in _preflight_src, "63.31 ★ preflight 注册标签窗口渲染测试")
ok("test/tag-menu.test.js" in _preflight_src,
   "63.32 ★ preflight 注册右键注入测试（幂等 / 重建不堆叠是这一层的核心不变量）")
ok("_hook.nodes" in _tmenu_src,
   "63.33 ★ 注入节点按引用摘除（只靠 getElementById 会在异常路径漏删 → 菜单越堆越多）")

# ==================== 64. 订阅落地桥（0.71.0） ====================
# 背景：检索订阅是「接口检索 + 入库」，左侧【订阅】是 Zotero 原生 RSS，两套机制不通，
# 用户订阅完左侧一片空白。这一层把订阅落到「库内分类 + 原生 RSS」两处。
# 静默失败点（每一条都真实踩过或差点踩到）：
#   ① 子分类用 col.parentID 而不是 parentKey → 全建成了顶层分类（Collection._initSave
#      只认 this._parentKey），用户在「我的文库」下看到一堆散落的刊名；
#   ② 归类用 item.saveTx 二次保存 → 改 dateModified、白白多一次写；
#   ③ 归类异常冒泡回入库循环 → 被计成 failed 且下次重跑（同一条论文反复出现）；
#   ④ RSS 不校验直接建源 → 左侧【订阅】里多出一堆报错的空源；
#   ⑤ 新测试没进 preflight → 等于没有回归网。
_bridge_path = os.path.join(ROOT, "chrome", "content", "scripts", "features", "subs-bridge.js")
ok(os.path.exists(_bridge_path),
   "64.1 ★ 落地桥模块在 chrome/content/scripts/features/subs-bridge.js（必须随包走）")
_bridge_src = io.open(_bridge_path, encoding="utf-8").read() if os.path.exists(_bridge_path) else ""
ok("var SubsBridge" in _bridge_src, "64.2 暴露全局 SubsBridge")
ok("PARENT_NAME: \"订阅期刊\"" in _bridge_src,
   "64.3 父分类名固定为「订阅期刊」（用户能在左侧一眼认出）")
ok("col.parentKey = parent.key" in _bridge_src,
   "64.4 ★ 子分类走 parentKey（写成 parentID 会被 _initSave 忽略 → 全变顶层分类）")
ok(".parentID =" not in _bridge_src,
   "64.5 ★ 不出现 parentID 赋值（同上，防止有人「顺手改回去」；读 parentID 判顶层是允许的）")
ok("Zotero.DB.executeTransaction" in _bridge_src and "col.addItem(" in _bridge_src,
   "64.6 ★ 归类走 Collection.addItem + 事务（不是 item.saveTx 二次保存）")
ok("attachItem(itemOrID, sub)" in _bridge_src and "this._log(\"attachItem failed\", e)" in _bridge_src,
   "64.7 ★ 归类异常内部吞掉（绝不把入库计成 failed）")
ok("itemsByTag" in _bridge_src.replace("_itemsByTag", "itemsByTag")
   and "new Zotero.Search()" in _bridge_src,
   "64.8 回填走 Zotero.Search 按标签查（不拉全库）")
ok("existsByURL" in _bridge_src and "new Zotero.Feed()" in _bridge_src,
   "64.9 ★ 建 RSS 源前按 URL 去重（否则每次点都多一个源）")
ok("Zotero.FeedReader" in _bridge_src and "feedProperties" in _bridge_src,
   "64.10 ★ 建源前用 FeedReader 现场解析（解析不了的刊不建空源）")
ok("probeFeed(url)" in _bridge_src and "PROBE_TIMEOUT" in _bridge_src,
   "64.11 ★ 探测有超时（坏地址不拖死订阅流程）")
ok("rss.sciencedirect.com/publication/science/" in _bridge_src,
   "64.12 Elsevier 按 ISSN 直连（实测 200 + 真 RSS）")
ok("nature.com/" in _bridge_src and "NATURE_SLUGS" in _bridge_src,
   "64.13 Nature 系走 slug 表")
ok("navi.cnki.net/knavi/rss/" in _bridge_src and "CNKI_CODES" in _bridge_src,
   "64.14 知网刊号表（中文刊主要靠这条）")
ok("rssUrl" in _bridge_src,
   "64.15 订阅可带手填 RSS 地址（解析不到的刊有兜底）")
ok("subsBridge" in io.open(os.path.join(ROOT, "chrome", "content", "scripts", "main.js"),
                           encoding="utf-8").read(),
   "64.16 main.js 把 SubsBridge 挂到 Zotero.Papilot（面板与排障入口）")

_ss_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "search-subs.js"),
                  encoding="utf-8").read()
ok("_attachArchive(item, sub)" in _ss_src,
   "64.17 ★ search-subs 入库后调用归类钩子")
ok(_ss_src.count("this._attachArchive(") >= 2,
   "64.18 ★ 两条入库路径（run 自动入库 / accept 收藏）都接了钩子（当前 %d 处）"
   % _ss_src.count("this._attachArchive("))
ok("async _attachArchive(" in _ss_src and "this._log(\"attachArchive failed\", e)" in _ss_src,
   "64.19 ★ 钩子自己包 try（SubsBridge 缺位 / 分类建不出来都不影响入库）")

ok('id="pp-subs-bridge"' in prefs_xhtml and 'id="pp-subs-bridge-msg"' in prefs_xhtml,
   "64.20 面板有「同步到左侧面板」按钮与状态位")
_ps_src = io.open(os.path.join(ROOT, "chrome", "content", "prefs-subs.js"),
                  encoding="utf-8").read()
ok("bridgeAfterSubscribe(created)" in _ps_src,
   "64.21 ★ 期刊订阅成功后自动落地（不用用户再点一次）")
ok("renderBridgeMsg()" in _ps_src and "doBridgeSync" in _ps_src,
   "64.22 状态行随列表刷新 + 手动同步入口")
ok("Zotero.Papilot.subsBridge" in _ps_src,
   "64.23 面板经 Zotero.Papilot.subsBridge 取模块（不直接引用全局，便于降级）")
ok("test/subs-bridge.test.js" in _preflight_src,
   "64.24 ★ preflight 注册落地桥测试（幂等 / 回填 / 建源去重是这一层的核心不变量）")

# ==================== 65. 模块化运行时（0.73.0） ====================
# 背景：功能组件从主包拆出后，「装错一个目录 / 漏一个文件 / 源站被改」不再表现为
# 构建失败，而是用户侧「商店空白 / 装完没反应」。这一节盯四类静默故障：
#   ① modules/<id>/module.json 的 id 与目录名不一致（打包脚本按目录名找，永远装不上）；
#   ② builtin-index.json 与 modules/ 数量漂移（离线首启少一个组件 / 多一个死链）；
#   ③ module-store.xhtml 出现未定义实体（§30 纪律：整页空白）；
#   ④ 写注册表时给 IOUtils.writeUTF8 传 mode（分册 03 铁律：截断/权限异常）。
_MOD_DIR = os.path.join(ROOT, "modules")
_mod_ids = []
if os.path.isdir(_MOD_DIR):
    _mod_ids = sorted(d for d in os.listdir(_MOD_DIR)
                      if os.path.isdir(os.path.join(_MOD_DIR, d)))

_mod_problems = []
if not _mod_ids:
    _mod_problems.append("modules/ 下没有模块目录")
for _d in _mod_ids:
    _mp = os.path.join(_MOD_DIR, _d, "module.json")
    if not os.path.exists(_mp):
        _mod_problems.append("%s: 缺 module.json" % _d)
        continue
    try:
        _m = json.load(io.open(_mp, encoding="utf-8"))
    except Exception as _e:
        _mod_problems.append("%s: module.json 解析失败 %s" % (_d, _e))
        continue
    if _m.get("id") != _d:
        _mod_problems.append("%s: id=%r 与目录名不一致" % (_d, _m.get("id")))
    if not isinstance(_m.get("files"), list) or not _m.get("files"):
        _mod_problems.append("%s: files 为空" % _d)
ok(not _mod_problems,
   "65.1 ★ 每个 modules/<id>/module.json 的 id 与目录名一致且 files 非空 → %s"
   % ("; ".join(_mod_problems) or "全部通过"))

_BIDX_PATH = os.path.join(ROOT, "chrome", "content", "modules", "builtin-index.json")
_idx_problems = []
_idx_mods = []
if not os.path.exists(_BIDX_PATH):
    _idx_problems.append("builtin-index.json 不存在")
else:
    try:
        _bidx = json.load(io.open(_BIDX_PATH, encoding="utf-8"))
        _idx_mods = _bidx.get("modules") or []
        if not isinstance(_idx_mods, list):
            _idx_problems.append("modules 不是数组")
            _idx_mods = []
    except Exception as _e:
        _idx_problems.append("解析失败：%s" % _e)
# 0.73.1 合集（bundles/<id>/）也是合法条目：目录 id 全集 = modules/ + bundles/
_bundle_ids = set()
_bundles_dir = os.path.join(ROOT, "bundles")
if os.path.isdir(_bundles_dir):
    for _d in os.listdir(_bundles_dir):
        if os.path.isfile(os.path.join(_bundles_dir, _d, "module.json")):
            _bundle_ids.add(_d)
if len(_idx_mods) != len(_mod_ids) + len(_bundle_ids):
    _idx_problems.append("索引 %d 条 != modules/ %d 个 + bundles/ %d 个"
                         % (len(_idx_mods), len(_mod_ids), len(_bundle_ids)))
for _m in _idx_mods:
    _mid = _m.get("id") if isinstance(_m, dict) else None
    _is_bundle = isinstance(_m, dict) and _m.get("bundle")
    if not _mid or (_mid not in _mod_ids and not (_is_bundle and _mid in _bundle_ids)):
        _idx_problems.append("索引 id %r 在 modules/ 与 bundles/ 都找不到" % (_mid,))
ok(not _idx_problems,
   "65.2 ★ builtin-index.json 模块数 == modules/ 子目录数，且每个 id 都能找到 → %s"
   % ("; ".join(_idx_problems) or "全部匹配"))

_MS_XHTML = os.path.join(ROOT, "chrome", "content", "module-store.xhtml")
_msx_problem = None
if not os.path.exists(_MS_XHTML):
    _msx_problem = "文件不存在"
else:
    try:
        import xml.etree.ElementTree as _ET2
        _ET2.fromstring(io.open(_MS_XHTML, encoding="utf-8").read())
    except Exception as _e:
        _msx_problem = str(_e)
ok(_msx_problem is None,
   "65.3 ★ module-store.xhtml 能通过 XML 解析（§30：未定义实体会整页空白）→ %s"
   % (_msx_problem or "XML 合法"))

_MS_WIN = os.path.join(ROOT, "chrome", "content", "module-store-window.js")
_ms_win_src = io.open(_MS_WIN, encoding="utf-8").read() if os.path.exists(_MS_WIN) else ""
_win_problems = []
if not _ms_win_src:
    _win_problems.append("文件不存在")
else:
    if "&nbsp;" in _ms_win_src:
        _win_problems.append("含 &nbsp;（XML 未定义实体）")
    _oc_hits = re.findall(r"\bonclick\s*=", _ms_win_src)
    if _oc_hits:
        _win_problems.append("含内联 onclick=（%d 处）" % len(_oc_hits))
ok(not _win_problems,
   "65.4 ★ module-store-window.js 无 &nbsp; 且无内联 onclick= → %s"
   % ("; ".join(_win_problems) or "全部通过"))

_ML_PATH = os.path.join(ROOT, "chrome", "content", "scripts", "core", "module-loader.js")
_ml_src = io.open(_ML_PATH, encoding="utf-8").read() if os.path.exists(_ML_PATH) else ""
_ml_problems = []
if not _ml_src:
    _ml_problems.append("文件不存在")
else:
    _mode_hits = re.findall(r"writeUTF8\([^)]*\{[^)]*mode", _ml_src)
    if _mode_hits:
        _ml_problems.append("writeUTF8 带 mode 参数：%s" % (_mode_hits,))
ok(not _ml_problems,
   "65.5 ★ module-loader.js 的 IOUtils.writeUTF8 调用不带 mode（分册 03 铁律）→ %s"
   % ("; ".join(_ml_problems) or "全部通过"))

print("=" * 60)
for p in passes:
    print("  OK  " + p)
if problems:
    print("-" * 60)
    for p in problems:
        print("  !!  " + p)
print("=" * 60)
print("接线扫描：%d 通过 / %d 问题" % (len(passes), len(problems)))
sys.exit(1 if problems else 0)
