// 약국 상담 정리 프로그램 (독립 실행) — 전사문 → 구글시트 저장 + A4 안내문(PDF)
// 윈도우/맥 공용. node server.mjs 로 실행(또는 start.bat 더블클릭).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { randomBytes, createSign, createHmac, timingSafeEqual } from "node:crypto";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8800;
const HOSTED = Boolean(process.env.PORT); // 클라우드(호스팅)는 PORT를 줌 → 외부 접속 허용
const HOST = process.env.HOST || (HOSTED ? "0.0.0.0" : "127.0.0.1");
const APP_PASSWORD = String(process.env.APP_PASSWORD || "").trim(); // 있으면 비밀번호 잠금

const aiKeyPath = path.join(rootDir, ".ai-key.json");
const openaiKeyPath = path.join(rootDir, ".openai-key.json"); // OpenAI 백업 키(선택)
const googleClientPath = path.join(rootDir, ".google-client.json");
const sheetsTokenPath = path.join(rootDir, ".sheets-token.json");
const consultConfigPath = path.join(rootDir, ".consult-config.json");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets openid email";

// 구글시트 한 줄에 들어갈 항목(맨 끝에 '상담 상세 기록' = 예전 노션 기록지)
const SHEET_COLUMNS = [
  "고객명", "전화번호", "상담일", "한달뒤 상담일", "주요 증상", "상담 요약(한 줄)",
  "추천 제품 조합", "복용 시작일", "경과 요약", "다음 상담일",
  "태그", "특이사항", "약력/병력", "현재 복용 중 약", "현재 복용 중 영양제",
  "담당자 메모", "매출액", "상담 상세 기록", "안부 상담문자",
];

const PRODUCT_KB = `
[자주 쓰는 제품 자료 — 복용법·보관법은 이 자료를 우선 적용]
- 팜스 슈퍼 헴철 필앤써큐: 1일 1회 1포 15g, 직접/음용수 혼합, 흔들어 섭취. 철 24mg. 서늘한 곳 보관. ★별도 지시 없으면 "자기 전 1포"
- 팜스 슈퍼 헴철 G: 1일 1회 1포 20g, 흔들어 섭취. 철 12mg. 서늘한 곳 보관.
- 팜스 헴철 키즈: 1일 1회 1포 15g, 흔들어 섭취. 어린이용, 철 8mg.
- 팜스 슈퍼 아스친 알티지 오메가3: 1일 1회 2캡슐, 물과. EPA·DHA 600mg, 아스타잔틴 6mg. 서늘·건조 보관.
- 투윅스 체인지 메타: 1일 1회 1포, 공복 기본. 냉암소 보관.
- 투윅스 체인지 리퀴드 OPC: 1일 1회 1포 10ml, 흔들어 섭취. ★별도 지시 없으면 "아침 공복 1포".
- 아드 파워 부스터: 1일 2회, 1회 2정, 물과. 멀티비타민·미네랄.
- 팜스 슈퍼 엘스케이뮨: 1일 2회, 1회 1포 3g, 물과. 면역 균형.
- 액티브 칼맥 더블 액션: 1일 2회, 1회 1정, 물과. 칼슘·마그네슘·K2·D3·아연.
- 팜스 슈퍼 노토진생 리퀴드: 1일 1회 1포 15g. 전칠삼·단삼 액상차.
공통: 자료에 없는 효능·금기·복용법은 만들지 않는다. 건강기능식품 기능성은 자료 표현 수준으로만. "빈속"보다 "공복" 표현 우선.
`.trim();

// ───────────────── 공통 유틸 ─────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
async function parseJson(req) {
  const r = new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: "half" });
  return r.json();
}
async function readJsonFile(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}
async function writeJsonFile(p, v) { await fs.writeFile(p, JSON.stringify(v, null, 2), "utf8"); }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function addMonth(ymdStr) {
  const d = new Date(ymdStr); if (isNaN(d)) return "";
  d.setMonth(d.getMonth() + 1); return ymd(d);
}
function describeError(e, fallback) { return (e && e.message) || fallback; }
function baseUrlFrom(req) { return `http://${req.headers.host || `${HOST}:${PORT}`}`; }
function parseLooseDate(s) {
  const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d) ? null : d;
}
function daysBetween(a, b) { // b - a (달력 기준 일수)
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86400000);
}

// ───────────────── AI (형 키: Claude 또는 OpenAI) ─────────────────
async function getAiKey() {
  const env = String(process.env.ANTHROPIC_KEY || "").trim();
  if (env) return { key: env, provider: "anthropic", model: String(process.env.AI_MODEL || "").trim() };
  const raw = await readJsonFile(aiKeyPath, null);
  const key = String(raw?.apiKey || "").trim();
  if (!key) return null;
  const provider = key.startsWith("sk-ant-") ? "anthropic" : "openai";
  return { key, provider, model: raw?.model || "" };
}
async function getOpenAiBackupKey() {
  const env = String(process.env.OPENAI_KEY || "").trim();
  if (env) return env;
  const raw = await readJsonFile(openaiKeyPath, null);
  const k = String(raw?.apiKey || "").trim();
  return k || null;
}
async function callClaudeOnce(key, model, system, prompt) {
  const body = { model, max_tokens: 8000, system, messages: [{ role: "user", content: prompt }] };
  if (model === "claude-opus-4-8") body.thinking = { type: "adaptive" }; // adaptive thinking은 opus류만 지원
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || "Claude 호출 실패"), { status: r.status });
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
// 한 모델 호출 + 일시 장애(500/과부하 529/429/네트워크) 시 1.5초 후 1회 재시도
async function callClaudeRetry(key, model, system, prompt) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await callClaudeOnce(key, model, system, prompt); }
    catch (e) {
      lastErr = e; const s = e.status || 0;
      if (s === 500 || s === 529 || s === 429 || s === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw e; // 4xx 등 영구 오류
    }
  }
  throw lastErr;
}
async function callOpenAI(key, system, prompt, model) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model || "gpt-5.5", messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || "OpenAI 호출 실패"), { status: r.status });
  return (d.choices?.[0]?.message?.content || "").trim();
}
async function callText(system, prompt) {
  const ai = await getAiKey();
  const backup = await getOpenAiBackupKey();
  if (!ai && !backup) throw Object.assign(new Error("AI 키가 필요합니다. (설정에서 키 입력)"), { status: 401 });
  if (ai?.provider === "openai") return await callOpenAI(ai.key, system, prompt, ai.model);
  if (ai?.provider === "anthropic") {
    try { return await callClaudeRetry(ai.key, ai.model || "claude-opus-4-8", system, prompt); }
    catch (e1) {
      // Opus 장애 → OpenAI 백업(최신 gpt-5.5) 우선 사용
      if (backup) {
        console.log(`[AI] Claude(Opus) 실패 → OpenAI(gpt-5.5) 백업: ${e1.message}`);
        return await callOpenAI(backup, system, prompt);
      }
      // 백업 키 없으면 다른 Claude 모델로(Sonnet→Haiku)
      let lastErr = e1;
      for (const m of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
        try { return await callClaudeRetry(ai.key, m, system, prompt); } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
  }
  return await callOpenAI(backup, system, prompt); // 기본키 없고 OpenAI 백업만 있는 경우
}
function parseJsonLoose(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch {}
  const s = t.search(/[{[]/); const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("AI 응답을 JSON으로 읽지 못했습니다.");
}
async function callJson(system, prompt) {
  return parseJsonLoose(await callText(system, prompt + "\n\n반드시 유효한 JSON 하나만 출력(코드블록·설명 없이)."));
}

// ───────────────── 상담 정리 프롬프트 ─────────────────
function consultPrompt(transcript, memo) {
  const today = ymd(new Date());
  return `
역할: 약사 상담 기록 정리 비서. 상담 전사문을 바탕으로 ①구글시트 한 줄 ②상세 상담 기록지를 작성한다.
원칙: 과장·마케팅·단정적 치료 표현 금지. 연령/복용약/기저질환/알레르기/임신수유 반영. 전사에 없는 내용은 추정 말고 그냥 그 항목을 비우거나 통째로 뺀다(명시된 "없음"만 "없음"). ❌ 어디에도 '확인 필요 / 확인 부탁 / 미확인 / [확인] / 확인해 주세요' 같은 점검 요청·빈칸 안내 문구를 만들지 마라 — 빠진 정보는 조용히 생략한다. 기존 처방약 임의 중단 안내 금지.
${PRODUCT_KB}

오늘 날짜: ${today} (상담일 미언급 시 오늘로)

[상담 전사문]
${transcript.slice(0, 30000)}
${memo ? `\n[약사 메모]\n${memo}` : ""}

반드시 아래 JSON만 출력:
{
  "customer": {"name": "고객명", "phone": "전화(없으면 빈값)", "consultDate": "YYYY-MM-DD", "stage": "1차|2차...(모르면 1차)", "revenue": "매출(언급시 숫자만)"},
  "sheetRow": {${SHEET_COLUMNS.filter((c) => c !== "상담 상세 기록" && c !== "안부 상담문자").map((c) => `"${c}": "..."`).join(", ")}},
  "detailRecord": "상세 상담 기록지(마크다운). 다음 소제목 순서로: ## 고객 기본 정보 / ## 현재 가장 불편한 증상 / ## 약력·병력·복용 이력 / ## 상담 핵심 요약 / ## 전문가 분석·문제 원인 / ## 이번 상담 추천 제품(제품명—기능/근거, 복용법, 기대 타임라인) / ## 다음 케어 계획. 각 항목은 - 불릿으로.",
  "followupSms": "상담 약 3주 뒤(약이 떨어질 즈음) 보낼 '안부 겸 재상담 권유' 문자 본문. 그 분의 증상·복용 제품 중 1~2개를 구체적으로 언급해 기억하는 느낌을 준다. 다정한 존댓말, 일반 문자 길이로 짧게(3~5줄, 한 줄도 짧게), 판매 강요·과장·치료 단정 금지, 기록에 없는 사실은 지어내지 않는다. 첫 줄은 'OOO님, 안녕하세요. 낭만약사입니다' 형태(고객명 넣기), 이모지는 맨 끝에 1개 정도."
}
sheetRow 규칙:
- "상담일"=consultDate, "한달뒤 상담일"=상담일+1개월.
- "다음 상담일"= 추천 제품을 다 먹는 시점으로 추정. 전사문에서 제품이 '몇 개월분 / 며칠분 / 몇 통'인지 단서를 찾아, (복용 시작일이 있으면 그 날, 없으면 상담일)에 그 기간을 더한 날짜를 YYYY-MM-DD로 적는다. 약사 메모에 '다음 상담일' 또는 복용 기간이 적혀 있으면 그것을 최우선으로 따른다. 기간 단서가 전혀 없으면 빈 문자열로 둔다(임의로 한 달 넣지 말 것).
- 채울 수 없는 칸은 빈 문자열, "상담 요약(한 줄)"은 정말 한 줄.`.trim();
}

function sheetRowValues(analysis) {
  const row = analysis?.sheetRow || {};
  const detail = String(analysis?.detailRecord || "").trim();
  const sms = String(analysis?.followupSms || "").trim();
  return SHEET_COLUMNS.map((c) =>
    c === "상담 상세 기록" ? detail : c === "안부 상담문자" ? sms : String(row[c] ?? ""));
}

// ───────────────── 구글시트 OAuth ─────────────────
async function getGoogleClient() {
  const id = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const sec = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (id && sec) return { clientId: id, clientSecret: sec };
  const raw = await readJsonFile(googleClientPath, null);
  const clientId = String(raw?.clientId || "").trim();
  const clientSecret = String(raw?.clientSecret || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function sheetsRedirectUri(req) { return `${baseUrlFrom(req)}/auth/sheets/callback`; }
async function getSheetsTokens() {
  const rt = String(process.env.GOOGLE_REFRESH_TOKEN || "").trim();
  if (rt) return { refreshToken: rt, accessToken: "", expiresAt: 0 };
  const raw = await readJsonFile(sheetsTokenPath, null);
  return raw?.accessToken || raw?.refreshToken ? raw : null;
}
// 클라우드용: 구글 '서비스 계정'으로 시트 접근(로그인 불필요, 만료 없음)
function getServiceAccount() {
  // ① JSON 통째를 base64로(가장 안전) ② JSON 통째 ③ 이메일+개인키 따로
  const fromJson = (raw) => {
    try { const o = JSON.parse(raw); if (o.client_email && o.private_key) return { email: String(o.client_email).trim(), key: String(o.private_key) }; } catch {}
    return null;
  };
  const b64 = String(process.env.GOOGLE_SA_JSON_B64 || "").trim();
  if (b64) { const r = fromJson(Buffer.from(b64, "base64").toString("utf8")); if (r) return r; }
  const json = String(process.env.GOOGLE_SA_JSON || "").trim();
  if (json) { const r = fromJson(json); if (r) return r; }
  const email = String(process.env.GOOGLE_SA_EMAIL || "").trim();
  let key = String(process.env.GOOGLE_SA_PRIVATE_KEY || "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  key = key.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  return email && key.includes("PRIVATE KEY") ? { email, key } : null;
}
let saTokenCache = { token: "", exp: 0 };
async function getServiceAccountToken(sa) {
  if (saTokenCache.token && saTokenCache.exp > Date.now() + 60000) return saTokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  const jwt = `${unsigned}.${signer.sign(sa.key).toString("base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error_description || d.error || "서비스 계정 인증 실패"), { status: 401 });
  saTokenCache = { token: String(d.access_token || "").trim(), exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return saTokenCache.token;
}
async function ensureSheetsAccess() {
  const sa = getServiceAccount();
  if (sa) return { accessToken: await getServiceAccountToken(sa) }; // 클라우드 우선
  const client = await getGoogleClient();
  if (!client) throw Object.assign(new Error("구글 클라이언트 정보가 없습니다(설정)."), { status: 400 });
  let tokens = await getSheetsTokens();
  if (!tokens) throw Object.assign(new Error("구글시트 로그인이 필요합니다(설정)."), { status: 401 });
  if (!tokens.accessToken || !tokens.expiresAt || tokens.expiresAt < Date.now() + 60000) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(p.error_description || "토큰 갱신 실패 — 다시 로그인."), { status: 401 });
    tokens = { accessToken: String(p.access_token || "").trim(), refreshToken: tokens.refreshToken, expiresAt: Date.now() + (Number(p.expires_in) || 0) * 1000 };
    try { await writeJsonFile(sheetsTokenPath, tokens); } catch {}
  }
  return tokens;
}
const authStates = new Map();
async function handleSheetsAuthStart(req, res) {
  const client = await getGoogleClient();
  if (!client) return redirect(res, "/?msg=google_client_missing");
  const state = randomBytes(12).toString("hex");
  authStates.set(state, Date.now());
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: sheetsRedirectUri(req), response_type: "code", scope: SHEETS_SCOPE, access_type: "offline", prompt: "consent select_account", state }).toString();
  redirect(res, u.toString());
}
async function handleSheetsAuthCallback(req, res) {
  const url = new URL(req.url, baseUrlFrom(req));
  const err = url.searchParams.get("error"); const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
  if (err) return redirect(res, `/?msg=${encodeURIComponent(err)}`);
  if (!state || !authStates.has(state)) return redirect(res, "/?msg=invalid_state");
  authStates.delete(state);
  const client = await getGoogleClient();
  if (!client || !code) return redirect(res, "/?msg=missing");
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: sheetsRedirectUri(req), grant_type: "authorization_code" }),
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(p.error_description || p.error || "로그인 실패");
    const prev = await getSheetsTokens();
    await writeJsonFile(sheetsTokenPath, { accessToken: String(p.access_token || "").trim(), refreshToken: String(p.refresh_token || prev?.refreshToken || "").trim(), expiresAt: Date.now() + (Number(p.expires_in) || 0) * 1000 });
    redirect(res, "/?msg=sheet_connected");
  } catch (e) { redirect(res, `/?msg=${encodeURIComponent(e.message || "auth_failed")}`); }
}
async function appendSheetRow(accessToken, sheetId, sheetTab, rowValues) {
  const range = encodeURIComponent(`${sheetTab}!A1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ values: [rowValues] }), signal: AbortSignal.timeout(25000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || "구글시트 입력 실패"), { status: r.status });
  return d;
}
// 시트가 비어있으면 머리글(컬럼명) 한 줄을 먼저 넣어준다
async function ensureHeaderRow(accessToken, sheetId, sheetTab) {
  try {
    const range = encodeURIComponent(`${sheetTab}!A1:A1`);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return;
    if (!d.values?.[0]?.[0]) await appendSheetRow(accessToken, sheetId, sheetTab, SHEET_COLUMNS);
  } catch {}
}
// 시트의 모든 상담 줄을 읽어 객체 배열로 (머리글 있으면 머리글 기준, 없으면 순서 기준)
async function readSheetRows() {
  const cfg = await getConsultConfig();
  if (!cfg.sheetId) throw Object.assign(new Error("구글시트가 설정되지 않았습니다(설정)."), { status: 400 });
  const tokens = await ensureSheetsAccess();
  const range = encodeURIComponent(`${cfg.sheetTab}!A1:S10000`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${range}`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(25000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || "구글시트 읽기 실패"), { status: r.status });
  const values = d.values || [];
  if (!values.length) return [];
  const hasHeader = String(values[0]?.[0] || "").trim() === SHEET_COLUMNS[0];
  const header = hasHeader ? values[0].map((h) => String(h || "").trim()) : null;
  const dataRows = hasHeader ? values.slice(1) : values;
  const startRow = hasHeader ? 2 : 1;
  return dataRows.map((row, i) => {
    const obj = { _row: startRow + i };
    SHEET_COLUMNS.forEach((c, ci) => {
      const idx = header ? (header.indexOf(c) >= 0 ? header.indexOf(c) : ci) : ci;
      obj[c] = String(row[idx] ?? "").trim();
    });
    return obj;
  });
}

// ───────────────── 설정 ─────────────────
async function getConsultConfig() {
  const envId = String(process.env.SHEET_ID || "").trim();
  if (envId) return { sheetId: envId, sheetTab: String(process.env.SHEET_TAB || "시트1").trim() || "시트1" };
  const raw = await readJsonFile(consultConfigPath, {});
  return { sheetId: String(raw.sheetId || "").trim(), sheetTab: String(raw.sheetTab || "시트1").trim() || "시트1" };
}
function extractSheetId(v) { const m = String(v || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : String(v || "").trim(); }

// ───────────────── 핸들러 ─────────────────
async function handleAnalyze(req, res) {
  try {
    const body = await parseJson(req);
    const transcript = String(body?.transcript || "").trim();
    if (!transcript) return sendJson(res, 400, { error: "상담 전사문을 붙여넣어주세요." });
    const out = await callJson("You are a meticulous Korean pharmacist consultation-record assistant. Output only valid JSON.", consultPrompt(transcript, String(body?.memo || "").trim()));
    sendJson(res, 200, out);
  } catch (e) { sendJson(res, e.status || 500, { error: describeError(e, "상담 정리에 실패했습니다.") }); }
}
async function handleSave(req, res) {
  try {
    const body = await parseJson(req);
    const analysis = body?.analysis;
    if (!analysis?.customer?.name) return sendJson(res, 400, { error: "정리 결과(고객명)가 없습니다." });
    const cfg = await getConsultConfig();
    if (!cfg.sheetId) return sendJson(res, 400, { error: "구글시트가 설정되지 않았습니다(설정)." });
    const tokens = await ensureSheetsAccess();
    // 한달뒤 상담일 비어있으면 자동 채움
    const row = analysis.sheetRow || (analysis.sheetRow = {});
    if (!row["한달뒤 상담일"] && (row["상담일"] || analysis.customer.consultDate)) {
      row["한달뒤 상담일"] = addMonth(row["상담일"] || analysis.customer.consultDate);
    }
    await ensureHeaderRow(tokens.accessToken, cfg.sheetId, cfg.sheetTab);
    await appendSheetRow(tokens.accessToken, cfg.sheetId, cfg.sheetTab, sheetRowValues(analysis));
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, e.status || 500, { error: describeError(e, "구글시트 저장에 실패했습니다."), needsReauth: e.status === 401 }); }
}
function a4Prompt(analysis) {
  return `
역할: 낭만약사. 아래 상담 정리를 바탕으로 고객 전달용 안내문을 작성한다.
톤: 쉬운 설명체, 다정한 존댓말, 관리 안내문. 판매·과장·단정적 치료 표현 금지. 전사에 없는 사실 단정 금지. 기존 약 임의 중단 금지.
❌ 금지: 상단·어디에도 날짜·시간 적지 마라. '이 제품은 건강기능식품으로 질병의 치료를 목적으로 하는 약이 아닙니다' 같은 면책·디스클레이머 절대 금지(신뢰도·효과 저하). "## 8. 안심 안내"는 면책 아닌 따뜻한 격려로.
❌ 정보가 비어 있는 항목은 '확인 필요 / 확인 부탁 / 미확인 / [확인] / 확인해 주세요' 같은 안내를 쓰지 말고, 그 줄·항목을 조용히 생략하고 있는 내용만으로 자연스럽게 작성한다.
${PRODUCT_KB}

[상담 정리 JSON]
${JSON.stringify(analysis, null, 2)}

구조(이 순서, 마크다운):
# 📄 ${analysis?.customer?.name || "고객"}님 맞춤 [주제] 관리 안내문
부제 한 줄
제공: 낭만약사
짧은 인사 및 도입(2~3문장)
## 1. 이번 프로그램의 목표
## 2. 현재 상태 요약
## 3. 복용 프로그램 요약
## 4. 복용법 안내
## 5. 예상되는 변화 타임라인
## 6. 복용 시 주의사항 & TIP
## 7. 다음 상담 시 확인할 내용
## 8. 안심 안내
## 9. 약사의 한마디
마크다운 텍스트만 출력(코드블록 금지).`.trim();
}
async function handleA4(req, res) {
  try {
    const body = await parseJson(req);
    if (!body?.analysis) return sendJson(res, 400, { error: "정리 결과가 필요합니다." });
    const markdown = await callText("You write warm, trustworthy Korean pharmacy guidance documents.", a4Prompt(body.analysis));
    sendJson(res, 200, { markdown });
  } catch (e) { sendJson(res, e.status || 500, { error: describeError(e, "안내문 생성에 실패했습니다.") }); }
}
// ───────────────── 안부·상담 문자 ─────────────────
// 상담일 + 23일(= 한 달 −1주, 약 떨어지기 전)에 연락. 그 3일 전부터 알림.
const FOLLOWUP_DAY = 23;
async function handleFollowups(req, res) {
  try {
    const rows = await readSheetRows();
    const today = new Date();
    const buckets = { d0: [], d1: [], d2: [], overdue: [] };
    for (const row of rows) {
      const cd = parseLooseDate(row["상담일"]);
      if (!cd) continue;
      const since = daysBetween(cd, today); // 상담 후 며칠 (오늘 - 상담일)
      const item = { row: row["_row"], name: row["고객명"], phone: row["전화번호"], consultDate: row["상담일"], since };
      if (since === FOLLOWUP_DAY) buckets.d0.push(item);            // 오늘 연락 (상담+23)
      else if (since === FOLLOWUP_DAY - 1) buckets.d1.push(item);   // 내일 연락 (상담+22)
      else if (since === FOLLOWUP_DAY - 2) buckets.d2.push(item);   // 모레 연락 (상담+21)
      else if (since > FOLLOWUP_DAY && since <= FOLLOWUP_DAY + 14) buckets.overdue.push({ ...item, overdueDays: since - FOLLOWUP_DAY });
    }
    buckets.overdue.sort((a, b) => a.overdueDays - b.overdueDays);
    sendJson(res, 200, { today: ymd(today), buckets });
  } catch (e) { sendJson(res, e.status || 500, { error: describeError(e, "안부문자 목록을 불러오지 못했습니다."), needsReauth: e.status === 401 }); }
}
async function handleStatus(req, res) {
  const ai = await getAiKey(); const backup = await getOpenAiBackupKey(); const sa = getServiceAccount();
  const client = await getGoogleClient(); const tokens = await getSheetsTokens(); const cfg = await getConsultConfig();
  // 서비스계정(클라우드)이 있으면 구글 연결은 완료된 것으로 본다
  sendJson(res, 200, {
    hasAiKey: Boolean(ai), aiProvider: ai?.provider || "", hasOpenAiBackup: Boolean(backup),
    hasGoogleClient: Boolean(sa) || Boolean(client),
    sheetsAuthorized: Boolean(sa) || Boolean(tokens?.refreshToken || tokens?.accessToken),
    sheetId: cfg.sheetId, sheetTab: cfg.sheetTab, redirectUri: sheetsRedirectUri(req),
    cloud: Boolean(sa) || HOSTED,
  });
}
async function handleSaveConfig(req, res) {
  try {
    const body = await parseJson(req);
    if (typeof body?.aiKey === "string" && body.aiKey.trim()) await writeJsonFile(aiKeyPath, { apiKey: body.aiKey.trim() });
    if (typeof body?.openaiKey === "string" && body.openaiKey.trim()) await writeJsonFile(openaiKeyPath, { apiKey: body.openaiKey.trim() });
    if (body?.clientId && body?.clientSecret) await writeJsonFile(googleClientPath, { clientId: String(body.clientId).trim(), clientSecret: String(body.clientSecret).trim() });
    const prev = await getConsultConfig();
    await writeJsonFile(consultConfigPath, { sheetId: body?.sheetUrl ? extractSheetId(body.sheetUrl) : prev.sheetId, sheetTab: String(body?.sheetTab ?? prev.sheetTab).trim() || "시트1" });
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 400, { error: describeError(e, "설정 저장 실패") }); }
}

// ───────────────── 정적 파일 ─────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
async function serveStatic(req, res) {
  const url = new URL(req.url, baseUrlFrom(req));
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(rootDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("Not found"); }
}

// ───────────────── 비밀번호 잠금 (APP_PASSWORD 있을 때만) ─────────────────
function readBody(req) { return new Promise((resolve) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) d = d.slice(0, 1e6); }); req.on("end", () => resolve(d)); }); }
function pwCookie() { return createHmac("sha256", APP_PASSWORD).update("pharmacy-ok").digest("hex"); }
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)pw=([a-f0-9]+)/);
  if (!m) return false;
  try { const a = Buffer.from(m[1], "hex"); const b = Buffer.from(pwCookie(), "hex"); return a.length === b.length && timingSafeEqual(a, b); } catch { return false; }
}
function loginPage(msg) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>약국 상담</title></head>
<body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;background:#f4f7f5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<form method="POST" action="/api/login" style="background:#fff;padding:30px 26px;border-radius:16px;box-shadow:0 6px 22px rgba(20,60,48,.1);width:300px;text-align:center">
<div style="font-size:30px">🩺</div><h2 style="margin:6px 0 2px;color:#164c40">약국 상담</h2>
<p style="color:#6b7b74;font-size:14px;margin:0 0 16px">비밀번호를 입력하세요</p>
<input name="password" type="password" autofocus style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #e2eae6;border-radius:10px;font-size:15px" placeholder="비밀번호">
${msg ? `<p style="color:#b5462f;font-size:13px;margin:10px 0 0">${msg}</p>` : ""}
<button style="width:100%;margin-top:12px;padding:12px;background:#1f6f5b;color:#fff;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">들어가기</button>
</form></body></html>`;
}
async function handleLogin(req, res) {
  const pw = new URLSearchParams(await readBody(req)).get("password") || "";
  if (APP_PASSWORD && pw === APP_PASSWORD) {
    const secure = HOSTED ? " Secure;" : "";
    res.writeHead(302, { "Set-Cookie": `pw=${pwCookie()}; HttpOnly;${secure} Path=/; Max-Age=2592000; SameSite=Lax`, Location: "/" });
    return res.end();
  }
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  res.end(loginPage("비밀번호가 틀렸어요."));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrlFrom(req));
  const m = req.method;
  try {
    // 비밀번호 잠금: 로그인 안 됐으면 로그인 화면만
    if (APP_PASSWORD && !isAuthed(req)) {
      if (m === "POST" && url.pathname === "/api/login") return handleLogin(req, res);
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "로그인이 필요합니다." });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(loginPage(""));
    }
    if (m === "GET" && url.pathname === "/api/status") return handleStatus(req, res);
    if (m === "POST" && url.pathname === "/api/config") return handleSaveConfig(req, res);
    if (m === "POST" && url.pathname === "/api/analyze") return handleAnalyze(req, res);
    if (m === "POST" && url.pathname === "/api/save") return handleSave(req, res);
    if (m === "POST" && url.pathname === "/api/a4") return handleA4(req, res);
    if (m === "GET" && url.pathname === "/api/followups") return handleFollowups(req, res);
    if (m === "GET" && url.pathname === "/api/sheets/auth/start") return handleSheetsAuthStart(req, res);
    if (m === "GET" && url.pathname === "/auth/sheets/callback") return handleSheetsAuthCallback(req, res);
    if (m === "GET") return serveStatic(req, res);
    res.writeHead(405); res.end("Method not allowed");
  } catch (e) { sendJson(res, 500, { error: describeError(e, "서버 오류") }); }
});

server.listen(PORT, HOST, () => {
  if (HOSTED) { console.log(`약국 상담 프로그램(웹) 실행 중 — 포트 ${PORT}${APP_PASSWORD ? " · 비밀번호 잠금 ON" : ""}`); return; }
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  약국 상담 정리 프로그램 실행 중:  ${url}\n  (이 창은 닫지 마세요. 종료하려면 Ctrl+C)\n`);
  // 브라우저 자동 열기(윈도우/맥) — OPEN_BROWSER=0 이면 건너뜀
  if (process.env.OPEN_BROWSER !== "0") {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
});
