// 验证 Zotero 集成事务可开可收。
//
// 协议硬约束（测出来的，别踩）：
//   inProgress 只在 Zotero 自己调 Document.complete() 时复位，而 complete() 在
//   execCommand 的 finally 里，条件是 `document` 已存在。
//   所以：**在 getActiveDocument 之前就报错 = 永久卡死 503，只能重启 Zotero**。
//   正确的中止点必须在 getActiveDocument 成功之后（给一个合法 documentID）。
//
// 本脚本流程：execCommand → 回合法 documentID → 拿到下一条命令 → 立刻走错误通道中止
// → 把 activate/displayAlert/cleanup/complete 都应答掉 → 复检 503 是否消失。
// 零 UI 副作用：displayAlert 直接回 0，不会真的弹窗。
const BASE = "http://127.0.0.1:21932/zit";

async function post(path, payload, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload === undefined ? null : payload),
      signal: ctrl.signal,
    });
    return { status: res.status, ok: res.ok, body: await res.text() };
  } catch (e) {
    return { status: 0, ok: false, body: "TIMEOUT/" + String(e && e.message) };
  } finally {
    clearTimeout(t);
  }
}

async function unwind(resp, tag) {
  for (let i = 0; i < 20; i++) {
    if (!resp.ok || !resp.body) {
      console.log("   [" + tag + "] 链路结束:", resp.body.slice(0, 100));
      return;
    }
    let cmd;
    try { cmd = JSON.parse(resp.body); } catch (e) { break; }
    if (!cmd.command) break;
    console.log("   [" + tag + "] <-", cmd.command);
    const done = cmd.command.indexOf("complete") >= 0;
    const safe = cmd.command === "Document.displayAlert" ? 0 : null;
    if (done) {
      await post("/connector/document/respond", safe, 10000);
      console.log("   [" + tag + "] 事务 complete，inProgress 已复位");
      return;
    }
    resp = await post("/connector/document/respond", safe, 25000);
  }
}

(async () => {
  console.log("== 1. execCommand ==");
  let r = await post("/connector/document/execCommand", { command: "addCitation", docId: "papilot-probe" }, 15000);
  console.log("   HTTP", r.status, r.body.slice(0, 120));
  if (r.status === 503) {
    console.log("\n结论：仍未复位，需重启 Zotero");
    process.exit(2);
  }
  if (!r.ok) process.exit(3);

  let cmd = JSON.parse(r.body);
  console.log("   首条:", cmd.command);

  console.log("\n== 2. 回合法的 documentID（让 Zotero 拿到 document 对象）==");
  r = await post("/connector/document/respond", {
    documentID: "papilot-probe-doc",
    outputFormat: "html",
    processorName: "Papilot Probe",
    supportsCitationMerging: false,
    supportsTextInsertion: true,
    supportsImportExport: false,
    supportedNotes: ["footnote", "endnote"],
  }, 25000);
  console.log("   HTTP", r.status, r.body.slice(0, 120));
  if (r.ok) {
    cmd = JSON.parse(r.body);
    console.log("   下一条:", cmd.command);
  }

  console.log("\n== 3. 从中途走错误通道中止 ==");
  r = await post("/connector/document/respond", {
    error: "Alert",
    message: "Papilot 诊断：主动中止（不执行任何文档操作）",
    stack: "",
  }, 25000);
  console.log("   HTTP", r.status, r.body.slice(0, 120));
  await unwind(r, "unwind");

  console.log("\n== 4. 复检：再开一次事务 ==");
  const again = await post("/connector/document/execCommand", { command: "addCitation", docId: "papilot-probe" }, 15000);
  console.log("   HTTP", again.status, again.body.slice(0, 120));
  if (again.ok) {
    // 再收一次，别留脏状态
    let rr = await post("/connector/document/respond", {
      documentID: "papilot-probe-doc", outputFormat: "html", processorName: "Papilot Probe",
      supportsCitationMerging: false, supportsTextInsertion: true, supportsImportExport: false,
      supportedNotes: ["footnote", "endnote"],
    }, 25000);
    rr = await post("/connector/document/respond", { error: "Alert", message: "Papilot 诊断：收尾", stack: "" }, 25000);
    await unwind(rr, "cleanup2");
    console.log("\n✅ 事务可开可收，状态干净");
  } else if (again.status === 503) {
    console.log("\n❌ 仍然 503：收尾失败，需要重启 Zotero");
    process.exit(2);
  }
})();
