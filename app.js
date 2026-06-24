"use strict";
const $ = (id) => document.getElementById(id);
let analysis = null;

function post(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "요청 실패");
    return d;
  });
}

async function loadStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    $("redirectUri").textContent = s.redirectUri || "—";
    if (s.sheetTab) $("sheetTab").placeholder = s.sheetTab;
    if (s.sheetId) $("sheetUrl").placeholder = `연결됨: ...${s.sheetId.slice(-8)}`;
    if (s.hasAiKey) $("aiKey").placeholder = `저장됨 (${s.aiProvider}) — 바꾸려면 새로 입력`;
    if (s.hasOpenAiBackup) $("openaiKey").placeholder = "백업 저장됨 ✓ — 바꾸려면 새로 입력";
    if (s.hasGoogleClient) { $("clientId").placeholder = "저장됨 (바꾸려면 새로)"; $("clientSecret").placeholder = "저장됨"; }
    const parts = [];
    parts.push(s.hasAiKey ? "AI ✓" : "AI 키 필요");
    parts.push(s.sheetsAuthorized && s.sheetId ? "시트 ✓" : "시트 연결 필요");
    $("statusBadge").textContent = parts.join(" · ");

    // 단계별 라이브 상태
    const done = { step1: !!s.hasAiKey, step2: !!s.hasGoogleClient, step3: !!s.sheetId, step4: !!s.sheetsAuthorized };
    let count = 0;
    for (const id of ["step1", "step2", "step3", "step4"]) {
      const el = $(id); if (!el) continue;
      el.classList.toggle("done", done[id]);
      if (done[id]) count++;
    }
    const allDone = count === 4;
    $("settingsChip").textContent = `${count} / 4`;
    $("settingsChip").classList.toggle("ok", allDone);
    $("setupDone").hidden = !allDone;
    // 설정 완료 → 설정가이드 숨기고 '사용법' 표시 / 미완 → 설정가이드 펼치고 사용법 숨김
    $("usageGuide").hidden = !allDone;
    $("settings").hidden = allDone;
    $("settings").open = !allDone;
  } catch {}
}

// 시트 로그인 콜백 메시지
(() => {
  const msg = new URLSearchParams(location.search).get("msg");
  if (!msg) return;
  history.replaceState(null, "", location.pathname);
  const txt = { sheet_connected: "구글시트 로그인 완료! ✅", google_client_missing: "먼저 구글 클라이언트 정보를 저장하세요.", invalid_state: "로그인 상태값 오류 — 다시 시도하세요." }[msg] || `로그인 결과: ${msg}`;
  setTimeout(() => { $("cfgStatus").textContent = txt; $("settings").open = true; }, 200);
})();

$("analyzeBtn").addEventListener("click", async () => {
  const transcript = $("transcript").value.trim();
  if (!transcript) { $("analyzeStatus").textContent = "전사문을 붙여넣어 주세요."; return; }
  $("analyzeBtn").disabled = true; $("analyzeBtn").textContent = "🧠 정리 중…";
  $("analyzeStatus").textContent = "AI가 상담을 정리하고 있어요…";
  try {
    analysis = await post("/api/analyze", { transcript, memo: $("memo").value.trim() });
    const c = analysis.customer || {};
    $("fName").value = c.name || ""; $("fPhone").value = c.phone || "";
    $("fDate").value = (c.consultDate || "").slice(0, 10); $("fStage").value = c.stage || "";
    $("fRevenue").value = c.revenue || "";
    $("detailPreview").textContent = analysis.detailRecord || "(상세 기록 없음)";
    $("preview").hidden = false;
    $("analyzeStatus").textContent = "정리 완료! 내용 확인 후 저장하거나 안내문을 만드세요. ↓";
  } catch (e) { $("analyzeStatus").textContent = "⚠️ " + e.message; }
  $("analyzeBtn").disabled = false; $("analyzeBtn").textContent = "🧠 AI 정리";
});

function syncFields() {
  if (!analysis) return;
  analysis.customer = analysis.customer || {};
  analysis.customer.name = $("fName").value.trim();
  analysis.customer.phone = $("fPhone").value.trim();
  analysis.customer.consultDate = $("fDate").value;
  analysis.customer.stage = $("fStage").value.trim();
  analysis.customer.revenue = $("fRevenue").value.trim();
  analysis.sheetRow = analysis.sheetRow || {};
  if ($("fName").value.trim()) analysis.sheetRow["고객명"] = $("fName").value.trim();
  if ($("fPhone").value.trim()) analysis.sheetRow["전화번호"] = $("fPhone").value.trim();
  if ($("fDate").value) analysis.sheetRow["상담일"] = $("fDate").value;
  if ($("fRevenue").value.trim()) analysis.sheetRow["매출액"] = $("fRevenue").value.trim();
}

$("saveBtn").addEventListener("click", async () => {
  if (!analysis) return;
  syncFields();
  $("saveBtn").disabled = true; $("saveStatus").textContent = "구글시트에 저장 중…";
  try {
    await post("/api/save", { analysis });
    $("saveStatus").textContent = "✅ 구글시트에 저장됐어요.";
  } catch (e) {
    $("saveStatus").textContent = "⚠️ " + e.message + (e.message.includes("로그인") ? " (설정에서 구글시트 로그인)" : "");
  }
  $("saveBtn").disabled = false;
});

$("a4Btn").addEventListener("click", async () => {
  if (!analysis) return;
  syncFields();
  $("a4Btn").disabled = true; $("a4Btn").textContent = "📄 생성 중…";
  $("saveStatus").textContent = "안내문을 만드는 중…";
  try {
    const d = await post("/api/a4", { analysis });
    $("a4Edit").value = d.markdown || "";
    $("a4Card").hidden = false;
    $("a4Card").scrollIntoView({ behavior: "smooth", block: "start" });
    $("saveStatus").textContent = "오른쪽에서 내용 확인·수정한 뒤 'PDF 생성'을 누르세요. →";
  } catch (e) { $("saveStatus").textContent = "⚠️ " + e.message; }
  $("a4Btn").disabled = false; $("a4Btn").textContent = "📄 안내문 만들기";
});

function openA4Print(markdown) {
  const html = markdown
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>").replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^\- (.+)$/gm, "<li>$1</li>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
  const win = window.open("", "_blank");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title> </title>
    <style>@page{margin:18mm 0}body{font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;max-width:700px;margin:0 auto;padding:0 18mm;line-height:1.7;color:#1a2420;font-size:14px}
    h1{font-size:21px;border-bottom:2px solid #1f6f5b;padding-bottom:8px}h2{font-size:16px;color:#164c40;margin-top:22px;break-after:avoid}li{margin:3px 0;break-inside:avoid}</style></head>
    <body>${html}<script>setTimeout(()=>window.print(),500)<\/script></body></html>`);
  win.document.close();
}
$("pdfBtn").addEventListener("click", () => {
  const md = $("a4Edit").value.trim();
  if (!md) { $("saveStatus").textContent = "안내문 내용이 없어요."; return; }
  openA4Print(md);
});

$("saveCfgBtn").addEventListener("click", async () => {
  $("saveCfgBtn").disabled = true; $("cfgStatus").textContent = "저장 중…";
  try {
    await post("/api/config", {
      aiKey: $("aiKey").value.trim(), openaiKey: $("openaiKey").value.trim(),
      clientId: $("clientId").value.trim(), clientSecret: $("clientSecret").value.trim(),
      sheetUrl: $("sheetUrl").value.trim(), sheetTab: $("sheetTab").value.trim(),
    });
    $("aiKey").value = ""; $("openaiKey").value = ""; $("clientSecret").value = "";
    $("cfgStatus").textContent = "✅ 설정 저장됨.";
    loadStatus();
  } catch (e) { $("cfgStatus").textContent = "⚠️ " + e.message; }
  $("saveCfgBtn").disabled = false;
});
$("loginBtn").addEventListener("click", () => { location.href = "/api/sheets/auth/start"; });
$("openSettingsBtn").addEventListener("click", () => {
  $("settings").hidden = false; $("settings").open = true;
  $("settings").scrollIntoView({ behavior: "smooth", block: "start" });
});
// ───────────── 탭 전환 ─────────────
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
let followLoaded = false;
function switchTab(name) {
  $("viewConsult").hidden = name !== "consult";
  $("viewFollowup").hidden = name !== "followup";
  $("tabConsult").classList.toggle("active", name === "consult");
  $("tabFollowup").classList.toggle("active", name === "followup");
  if (name === "followup" && !followLoaded) { followLoaded = true; loadFollowups(); }
}
$("tabConsult").addEventListener("click", () => switchTab("consult"));
$("tabFollowup").addEventListener("click", () => switchTab("followup"));
$("refreshFollowBtn").addEventListener("click", () => loadFollowups());

async function loadFollowups() {
  $("followStatus").textContent = "구글시트에서 불러오는 중…";
  ["bucketToday", "bucketD2", "bucketD3", "bucketOverdue"].forEach((id) => { $(id).innerHTML = ""; });
  try {
    const r = await fetch("/api/followups");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "불러오기 실패");
    const b = d.buckets;
    $("followStatus").textContent =
      `오늘(${d.today}) 기준 · 오늘 연락 ${b.d0.length}명 · 1일 뒤 ${b.d1.length}명 · 2일 뒤 ${b.d2.length}명` +
      (b.overdue.length ? ` · 지난 ${b.overdue.length}명` : "");
    renderBucket("bucketToday", "📞 오늘 연락할 분 (상담 23일째)", b.d0, { accent: true, emptyMsg: "오늘 연락할 대상자가 없어요." });
    renderBucket("bucketD2", "⏳ 1일 뒤 연락 (상담 22일째)", b.d1, {});
    renderBucket("bucketD3", "🗓️ 2일 뒤 연락 (상담 21일째)", b.d2, {});
    renderBucket("bucketOverdue", "⚠️ 지난 — 놓치지 마세요", b.overdue, { overdue: true });
  } catch (e) {
    $("followStatus").textContent = "⚠️ " + e.message + (/로그인|설정/.test(e.message) ? " (설정 탭에서 확인)" : "");
  }
}

function renderBucket(containerId, title, items, opts) {
  const c = $(containerId);
  if (!items.length) {
    c.innerHTML = opts.accent
      ? `<div class="bucket-head accent">${title} <span class="bcount">0명</span></div><p class="bempty">${opts.emptyMsg || ""}</p>`
      : "";
    return;
  }
  c.innerHTML = `<div class="bucket-head${opts.accent ? " accent" : ""}">${title} <span class="bcount">${items.length}명</span></div>`;
  for (const item of items) c.appendChild(fcard(item, opts));
}

function fcard(item, opts) {
  const wrap = document.createElement("div");
  wrap.className = "fcard" + (opts.overdue ? " overdue" : "");
  const extra = opts.overdue ? ` · <span class="fdays">연락 ${item.overdueDays}일 지남</span>` : "";
  wrap.innerHTML =
    `<div class="fcard-head">
       <div class="fname"><b>${esc(item.name || "(이름 없음)")}</b> <span class="fphone">${esc(item.phone || "")}</span></div>
       <div class="fmeta">상담일 ${esc(item.consultDate || "-")}${extra}</div>
     </div>`;
  return wrap;
}

$("copyUriBtn").addEventListener("click", async () => {
  const uri = $("redirectUri").textContent.trim();
  if (!uri || uri === "—") return;
  try { await navigator.clipboard.writeText(uri); $("copyUriBtn").textContent = "복사됨 ✓"; }
  catch { $("copyUriBtn").textContent = "직접 복사하세요"; }
  setTimeout(() => { $("copyUriBtn").textContent = "복사"; }, 1600);
});

loadStatus();
