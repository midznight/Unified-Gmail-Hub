import { INLINE_ASSETS } from "./inline-assets.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const TOKEN_EARLY_REFRESH_SECONDS = 60;
const MAX_CRON_ACCOUNTS = 3;
const MAX_GMAIL_LIST_IDS = 8;
// A run can refresh 3 tokens, list 3 mailboxes, fetch 21 metadata records,
// and send one aggregated Telegram alert: 28 external requests at most.
const MAX_METADATA_PER_ACCOUNT = 7;
const MAX_EXTERNAL_REQUESTS_PER_RUN = 29;
const MAX_PARALLEL_FETCHES = 6;
const MAX_REPLY_BODY_LENGTH = 100_000;
const MESSAGE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DISPLAY_WINDOW_DAYS = 7;
const DISPLAY_WINDOW_SECONDS = DISPLAY_WINDOW_DAYS * 24 * 60 * 60;
const MAX_CACHED_MESSAGES = 1_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "connect-src 'self'",
    "frame-src 'self' data:",
  ].join("; "),
};

class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

class GoogleApiError extends Error {
  constructor(status, message, googleCode = "google_api_error") {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.googleCode = googleCode;
  }
}

class ExternalRequestBudget {
  constructor(maximum = MAX_EXTERNAL_REQUESTS_PER_RUN) {
    this.maximum = maximum;
    this.count = 0;
  }

  async fetch(input, init = {}) {
    if (this.count >= this.maximum) {
      throw new Error("Batas subrequest eksternal internal tercapai; request dihentikan dengan aman.");
    }
    this.count += 1;
    return fetch(input, { ...init, redirect: "manual" });
  }
}

function createSemaphore(maximum) {
  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < maximum) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return async function run(task) {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function withSecurityHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        ...extraHeaders,
      },
    }),
  );
}

function htmlResponse(html, status = 200) {
  return withSecurityHeaders(
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    }),
  );
}

const OAUTH_COOKIE_NAME = "ugh_oauth_nonce";

function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() === name) {
      return segment.slice(separator + 1).trim();
    }
  }
  return "";
}

function setOAuthCookie(response, nonce, url, clear = false) {
  const headers = new Headers(response.headers);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = clear ? "" : encodeURIComponent(nonce);
  const age = clear ? 0 : OAUTH_STATE_TTL_SECONDS;
  headers.append(
    "Set-Cookie",
    `${OAUTH_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${age}${secure}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof GoogleApiError && error.status === 401) {
    return jsonResponse({ error: "Token Google tidak dapat digunakan. Hubungkan ulang akun.", code: "google_unauthorized" }, 401);
  }
  console.error("Request gagal:", safeErrorMessage(error));
  return jsonResponse({ error: "Terjadi kesalahan internal. Periksa log Worker.", code: "internal_error" }, 500);
}

function safeErrorMessage(error) {
  if (!error) return "unknown_error";
  const message = String(error.message || error).replace(/[\r\n\t]/g, " ").slice(0, 240);
  return message || "unknown_error";
}

function requireEnvironment(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new HttpError(500, `Konfigurasi server belum lengkap: ${missing.join(", ")}.`, "server_configuration_error");
  }
}

function validateSameOrigin(request, url, { mutating = false } = {}) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (origin && origin !== url.origin) {
    throw new HttpError(403, "Permintaan lintas origin ditolak.", "cross_origin_request");
  }
  if (mutating && origin !== url.origin) {
    throw new HttpError(403, "Header Origin wajib sama dengan origin aplikasi.", "missing_or_invalid_origin");
  }
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "Permintaan cross-site ditolak.", "cross_site_request");
  }
  if (mutating && !/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
    throw new HttpError(415, "Content-Type harus application/json.", "unsupported_media_type");
  }
}

async function readJson(request, maximumLength = 200_000) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maximumLength) {
    throw new HttpError(413, "Ukuran payload terlalu besar.", "payload_too_large");
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError(400, "Payload tidak dapat dibaca.", "invalid_body");
  }
  if (raw.length > maximumLength) {
    throw new HttpError(413, "Ukuran payload terlalu besar.", "payload_too_large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "JSON tidak valid.", "invalid_json");
  }
}

function cleanText(value, maximumLength, fieldName) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} harus berupa teks.`, "invalid_field");
  }
  const cleaned = value.trim().replace(/[\u0000-\u001F\u007F]/g, " ");
  if (!cleaned || cleaned.length > maximumLength) {
    throw new HttpError(400, `${fieldName} wajib diisi dan maksimal ${maximumLength} karakter.`, "invalid_field");
  }
  return cleaned;
}

function decodeBase64UrlBytes(value) {
  const cleaned = String(value || "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Gmail bodies are base64url-encoded UTF-8, not UTF-16 binary strings.
function decodeBase64UrlUtf8(value) {
  if (!value) return "";
  try {
    return decoder.decode(decodeBase64UrlBytes(value));
  } catch {
    return "";
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64UrlToBase64(value) {
  return String(value || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
}

function decodeEncryptionKey(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new HttpError(500, "Secret ENCRYPTION_KEY belum diatur.", "missing_encryption_key");

  try {
    const decoded = decodeBase64UrlBytes(raw);
    if (decoded.length === 32) return decoded;
  } catch {
    // The deployment guide also permits a literal 32-byte UTF-8 value.
  }

  const utf8 = encoder.encode(raw);
  if (utf8.length === 32) return utf8;
  throw new HttpError(500, "ENCRYPTION_KEY harus berisi tepat 32 byte (Base64 atau teks 32 byte).", "invalid_encryption_key");
}

async function getAesKey(env) {
  const keyBytes = decodeEncryptionKey(env.ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptRefreshToken(token, env) {
  if (!token) throw new Error("Refresh token kosong.");
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode("unified-gmail-hub:refresh-token:v1");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    encoder.encode(token),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptRefreshToken(encrypted, env) {
  const [version, ivPart, ciphertextPart, extra] = String(encrypted || "").split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart || extra) {
    throw new Error("Format refresh token terenkripsi tidak dikenal.");
  }
  const iv = decodeBase64UrlBytes(ivPart);
  const ciphertext = decodeBase64UrlBytes(ciphertextPart);
  if (iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("Data refresh token terenkripsi tidak valid.");
  }
  const key = await getAesKey(env);
  const additionalData = encoder.encode("unified-gmail-hub:refresh-token:v1");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

async function getHmacKey(env) {
  requireEnvironment(env, ["ENCRYPTION_KEY"]);
  const domainSeparated = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`unified-gmail-hub:oauth-state:v1:${env.ENCRYPTION_KEY}`),
  );
  return crypto.subtle.importKey(
    "raw",
    domainSeparated,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signOAuthState(payload, env) {
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await getHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  return `${payloadPart}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const maximum = Math.max(a.length, b.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function verifyOAuthState(state, env) {
  if (typeof state !== "string" || state.length > 4_096) {
    throw new HttpError(400, "OAuth state tidak valid.", "invalid_oauth_state");
  }
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new HttpError(400, "OAuth state tidak valid.", "invalid_oauth_state");
  }

  const [payloadPart, suppliedSignature] = parts;
  const key = await getHmacKey(env);
  const expectedSignature = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart))),
  );
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    throw new HttpError(400, "Tanda tangan OAuth state tidak cocok.", "invalid_oauth_signature");
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(decodeBase64UrlBytes(payloadPart)));
  } catch {
    throw new HttpError(400, "Payload OAuth state rusak.", "invalid_oauth_payload");
  }

  const now = Math.floor(Date.now() / 1_000);
  if (
    payload?.v !== 1 ||
    !Number.isInteger(payload?.ts) ||
    typeof payload?.nonce !== "string" ||
    payload.nonce.length < 20 ||
    typeof payload?.alias !== "string" ||
    typeof payload?.category !== "string" ||
    payload.ts > now + 60 ||
    now - payload.ts > OAUTH_STATE_TTL_SECONDS
  ) {
    throw new HttpError(400, "OAuth state sudah kedaluwarsa atau tidak valid.", "expired_oauth_state");
  }
  return payload;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeOAuthNonce(payload, env) {
  const nonceHash = await sha256Hex(payload.nonce);
  const now = Math.floor(Date.now() / 1_000);
  const result = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE nonce_hash = ? AND created_at >= ?",
  ).bind(nonceHash, now - OAUTH_STATE_TTL_SECONDS).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new HttpError(400, "OAuth state sudah digunakan atau tidak ditemukan.", "oauth_state_replayed");
  }
}

async function fetchGoogleJson(url, accessToken, init, budget, semaphore) {
  const response = await semaphore(() => budget.fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  }));
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const googleError = payload?.error;
    const message = typeof googleError === "string"
      ? googleError
      : googleError?.message || `Google API mengembalikan HTTP ${response.status}.`;
    throw new GoogleApiError(response.status, String(message).slice(0, 240), googleError?.status || googleError?.code || "google_api_error");
  }
  return payload;
}

async function refreshAccessToken(account, env, budget, semaphore) {
  const refreshToken = await decryptRefreshToken(account.refresh_token_enc, env);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await semaphore(() => budget.fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  }));
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Error is handled below with a generic message.
  }
  if (!response.ok || !payload.access_token) {
    const code = payload.error || "token_refresh_failed";
    if (code === "invalid_grant") {
      throw new GoogleApiError(401, "Google menolak refresh token (invalid_grant).", "invalid_grant");
    }
    throw new GoogleApiError(response.status || 502, "Google gagal memperbarui access token.", String(code));
  }

  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = now + Math.max(60, Number(payload.expires_in) || 3_600);
  await env.DB.prepare(
    "UPDATE accounts SET access_token = ?, token_expires_at = ? WHERE id = ?",
  ).bind(payload.access_token, expiresAt, account.id).run();
  return payload.access_token;
}

async function getValidAccessToken(account, env, budget, semaphore) {
  const now = Math.floor(Date.now() / 1_000);
  if (account.access_token && Number(account.token_expires_at || 0) > now + TOKEN_EARLY_REFRESH_SECONDS) {
    return account.access_token;
  }
  requireEnvironment(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPTION_KEY"]);
  return refreshAccessToken(account, env, budget, semaphore);
}

function getHeader(headers, name) {
  const wanted = name.toLowerCase();
  return (headers || []).find((header) => String(header?.name || "").toLowerCase() === wanted)?.value || "";
}

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, encoding, data) => {
    try {
      let bytes;
      if (encoding.toLowerCase() === "b") {
        const normalized = base64UrlToBase64(data);
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(padded);
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } else {
        const decoded = data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      }
      const normalizedCharset = String(charset).toLowerCase();
      if (["iso-8859-1", "latin1", "windows-1252"].includes(normalizedCharset)) {
        return new TextDecoder("windows-1252").decode(bytes);
      }
      return decoder.decode(bytes);
    } catch {
      return whole;
    }
  });
}

function parseMailbox(value) {
  const decoded = decodeMimeWords(value).replace(/[\r\n]/g, " ").trim();
  const bracket = decoded.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const emailMatch = bracket?.[1] || decoded.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const name = bracket
    ? decoded.slice(0, bracket.index).replace(/^\s*"|"\s*$/g, "").trim()
    : (emailMatch ? decoded.replace(emailMatch, "").replace(/[<>\"]/g, "").trim() : decoded);
  return { name: name || emailMatch, email: emailMatch };
}

function parseMetadataMessage(message, accountId) {
  const headers = message?.payload?.headers || [];
  const sender = parseMailbox(getHeader(headers, "From"));
  const internalDate = Number(message?.internalDate || 0);
  return {
    id: String(message.id),
    thread_id: String(message.threadId || ""),
    account_id: accountId,
    sender_name: sender.name || sender.email || "Pengirim tidak diketahui",
    sender_email: sender.email,
    reply_to: getHeader(headers, "Reply-To") || "",
    rfc_message_id: getHeader(headers, "Message-ID") || "",
    subject: decodeMimeWords(getHeader(headers, "Subject") || "(Tanpa subjek)"),
    snippet: String(message.snippet || "").slice(0, 1_000),
    is_unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD") ? 1 : 0,
    received_at: Number.isFinite(internalDate) && internalDate > 0
      ? Math.floor(internalDate / 1_000)
      : Math.floor(Date.now() / 1_000),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeEmailHtml(input) {
  let html = String(input || "");
  // The iframe sandbox is the primary boundary. This conservative pass removes
  // active document elements and common active attributes before srcdoc use.
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(script|iframe|frame|frameset|object|embed|form|input|button|textarea|select|option|meta|base|link|portal|template|svg|math|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  html = html.replace(/<(script|iframe|frame|object|embed|form|input|button|textarea|select|option|meta|base|link|portal|svg|math|video|audio)\b[^>]*\/?>/gi, "");
  html = html.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s+(srcdoc|formaction|action|autofocus|contenteditable)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s+(href|xlink:href)\s*=\s*("|')\s*(?:javascript:|vbscript:|data:text\/html)[\s\S]*?\2/gi, "");
  html = html.replace(/\s+(src|srcset|poster)\s*=\s*("|')\s*(?:https?:|\/\/|javascript:|vbscript:)[\s\S]*?\2/gi, "");
  html = html.replace(/@import\s+[^;]+;?/gi, "");
  html = html.replace(/url\s*\([^)]*\)/gi, "none");
  html = html.replace(/expression\s*\([^)]*\)/gi, "none");
  html = html.replace(/<\s*\/\s*(?:html|body)\s*>/gi, "");
  html = html.replace(/<\s*(?:html|body)\b[^>]*>/gi, "");
  return html.slice(0, 1_500_000);
}

function collectMimeParts(part, output = []) {
  if (!part || typeof part !== "object") return output;
  const mimeType = String(part.mimeType || "").toLowerCase();
  const filename = String(part.filename || "");
  if (!filename && part.body?.data && (mimeType === "text/html" || mimeType === "text/plain")) {
    output.push({ mimeType, data: part.body.data });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectMimeParts(child, output);
  }
  return output;
}

function collectAttachments(part, output = []) {
  if (!part || typeof part !== "object") return output;
  if (part.filename) {
    const bytes = Math.max(0, Number(part.body?.size || 0));
    output.push({
      name: String(part.filename).slice(0, 255),
      size_bytes: bytes,
      size_label: bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.ceil(bytes / 1024))} KB`,
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectAttachments(child, output);
  }
  return output;
}

function extractMessageBody(payload) {
  const parts = collectMimeParts(payload);
  const htmlPart = parts.find((part) => part.mimeType === "text/html");
  const plainPart = parts.find((part) => part.mimeType === "text/plain");
  const topLevelMime = String(payload?.mimeType || "").toLowerCase();
  const fallbackData = payload?.body?.data || "";

  if (htmlPart) {
    const html = sanitizeEmailHtml(decodeBase64UrlUtf8(htmlPart.data));
    return { html, text: "", format: "html" };
  }
  if (topLevelMime === "text/html" && fallbackData) {
    return { html: sanitizeEmailHtml(decodeBase64UrlUtf8(fallbackData)), text: "", format: "html" };
  }
  if (plainPart || (topLevelMime === "text/plain" && fallbackData)) {
    const text = decodeBase64UrlUtf8(plainPart?.data || fallbackData);
    const html = escapeHtml(text).replace(/\r?\n/g, "<br>");
    return { html, text, format: "plain" };
  }
  if (fallbackData) {
    const text = decodeBase64UrlUtf8(fallbackData);
    return { html: escapeHtml(text).replace(/\r?\n/g, "<br>"), text, format: "plain" };
  }
  return { html: "<p>Email ini tidak memiliki isi teks yang dapat ditampilkan.</p>", text: "", format: "empty" };
}

function getRecentWindowCutoff(now = Math.floor(Date.now() / 1_000)) {
  return now - DISPLAY_WINDOW_SECONDS;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function makeGmailMessageUrl(id, query = "") {
  return `${GOOGLE_API}/users/me/messages/${encodeURIComponent(id)}${query}`;
}

async function syncOneAccount(account, env, budget, semaphore) {
  const accountResult = {
    account_id: account.id,
    email: account.email,
    new_messages: 0,
    sync_error: null,
    alert_messages: [],
    ok: false,
  };
  let syncError = null;
  const syncedAt = Math.floor(Date.now() / 1_000);

  try {
    const accessToken = await getValidAccessToken(account, env, budget, semaphore);
    const listUrl = new URL(`${GOOGLE_API}/users/me/messages`);
    listUrl.searchParams.set("q", "in:inbox newer_than:7d");
    listUrl.searchParams.set("maxResults", String(MAX_GMAIL_LIST_IDS));
    const listing = await fetchGoogleJson(listUrl.toString(), accessToken, { method: "GET" }, budget, semaphore);
    const ids = [...new Set((listing.messages || []).map((message) => String(message.id || "")).filter(Boolean))];

    // The inbox list is only a discovery window. Persist every unseen ID before
    // fetching metadata so IDs beyond this cycle's seven-request budget cannot
    // fall out of Gmail's next maxResults=8 window and be lost.
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      const existingResult = await env.DB.prepare(
        `SELECT id FROM messages WHERE account_id = ? AND id IN (${placeholders})`,
      ).bind(account.id, ...ids).all();
      const existingIds = new Set((existingResult.results || []).map((row) => String(row.id)));
      const pendingInserts = ids
        .filter((id) => !existingIds.has(id))
        .map((id) => env.DB.prepare(`
          INSERT OR IGNORE INTO pending_messages (id, account_id, queued_at)
          VALUES (?, ?, ?)
        `).bind(id, account.id, syncedAt));
      if (pendingInserts.length) await env.DB.batch(pendingInserts);
    }

    const pendingResult = await env.DB.prepare(`
      SELECT p.id
      FROM pending_messages p
      WHERE p.account_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.id = p.id AND m.account_id = p.account_id
        )
      ORDER BY p.queued_at ASC, p.id ASC
      LIMIT ?
    `).bind(account.id, MAX_METADATA_PER_ACCOUNT).all();
    const pendingIds = (pendingResult.results || []).map((row) => String(row.id));

    if (!pendingIds.length) {
      accountResult.ok = true;
      return accountResult;
    }

    const metadataResults = await Promise.allSettled(pendingIds.map((id) => {
      const metadataUrl = new URL(makeGmailMessageUrl(id));
      metadataUrl.searchParams.set("format", "metadata");
      for (const header of ["From", "Reply-To", "Message-ID", "Subject", "Date", "To"]) {
        metadataUrl.searchParams.append("metadataHeaders", header);
      }
      return fetchGoogleJson(metadataUrl.toString(), accessToken, { method: "GET" }, budget, semaphore);
    }));

    const statements = [];
    let retryableFailures = 0;
    for (let index = 0; index < metadataResults.length; index += 1) {
      const result = metadataResults[index];
      const messageId = pendingIds[index];
      if (result.status === "fulfilled" && result.value?.id) {
        const message = parseMetadataMessage(result.value, account.id);
        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO messages
            (id, thread_id, account_id, sender_name, sender_email, reply_to,
             rfc_message_id, subject, snippet, is_unread, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          message.id,
          message.thread_id,
          message.account_id,
          message.sender_name,
          message.sender_email,
          message.reply_to,
          message.rfc_message_id,
          message.subject,
          message.snippet,
          message.is_unread,
          message.received_at,
        ));
        // Insert + queue deletion are committed together by D1.batch().
        statements.push(env.DB.prepare(
          "DELETE FROM pending_messages WHERE id = ? AND account_id = ?",
        ).bind(messageId, account.id));
        accountResult.new_messages += 1;
        const keywords = String(env.ALERT_KEYWORDS || "invoice,pembayaran,otp,verifikasi")
          .split(",")
          .map((keyword) => keyword.trim().toLocaleLowerCase("id-ID"))
          .filter(Boolean);
        if (keywords.some((keyword) => message.subject.toLocaleLowerCase("id-ID").includes(keyword))) {
          accountResult.alert_messages.push({
            account_alias: account.alias,
            account_email: account.email,
            subject: message.subject,
          });
        }
        continue;
      }

      const failure = result.status === "rejected" ? result.reason : new Error("Metadata Gmail tidak memiliki ID pesan.");
      if (failure instanceof GoogleApiError && (failure.status === 404 || failure.status === 410)) {
        // A message permanently deleted on Gmail can no longer be cached.
        statements.push(env.DB.prepare(
          "DELETE FROM pending_messages WHERE id = ? AND account_id = ?",
        ).bind(messageId, account.id));
      } else {
        retryableFailures += 1;
        statements.push(env.DB.prepare(`
          UPDATE pending_messages
          SET attempts = attempts + 1, last_error = ?
          WHERE id = ? AND account_id = ?
        `).bind(safeErrorMessage(failure), messageId, account.id));
      }
    }

    if (statements.length) await env.DB.batch(statements);

    if (retryableFailures > 0) {
      syncError = `${retryableFailures} metadata email gagal dimuat; sinkronisasi berikutnya akan mencoba ulang.`;
      accountResult.sync_error = syncError;
    }
    accountResult.ok = retryableFailures === 0;
    return accountResult;
  } catch (error) {
    if (error instanceof GoogleApiError && error.googleCode === "invalid_grant") {
      syncError = "invalid_grant: refresh token ditolak Google. Hubungkan ulang akun.";
    } else if (error instanceof GoogleApiError && error.status === 401) {
      syncError = "Google menolak access token. Hubungkan ulang akun.";
    } else {
      syncError = `Sync gagal: ${safeErrorMessage(error)}`;
    }
    accountResult.sync_error = syncError;
    return accountResult;
  } finally {
    // Updating last_synced_at even on invalid_grant prevents one broken account
    // from remaining at the head of ORDER BY last_synced_at forever.
    try {
      await env.DB.prepare(
        "UPDATE accounts SET last_synced_at = ?, sync_error = ? WHERE id = ?",
      ).bind(syncedAt, syncError, account.id).run();
    } catch (error) {
      console.error("Gagal menyimpan status sinkronisasi akun", account.id, safeErrorMessage(error));
    }
  }
}

async function syncAccounts(accounts, env, { budget, semaphore }) {
  const settled = await Promise.allSettled(
    accounts.map((account) => syncOneAccount(account, env, budget, semaphore)),
  );
  const results = settled.map((entry, index) => entry.status === "fulfilled"
    ? entry.value
    : {
        account_id: accounts[index].id,
        email: accounts[index].email,
        new_messages: 0,
        ok: false,
        sync_error: safeErrorMessage(entry.reason),
        alert_messages: [],
      });
  return {
    results,
    newMessages: results.reduce((sum, result) => sum + Number(result.new_messages || 0), 0),
    alerts: results.flatMap((result) => result.alert_messages || []),
  };
}

async function sendTelegramDigest(alerts, env, budget, semaphore) {
  if (!alerts.length || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const lines = ["Unified Gmail Hub: email baru yang cocok dengan kata kunci:"];
  for (const item of alerts.slice(0, 20)) {
    lines.push(`• ${item.account_alias} (${item.account_email}): ${item.subject}`);
  }
  if (alerts.length > 20) lines.push(`Dan ${alerts.length - 20} email lainnya.`);
  const body = new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID, text: lines.join("\n").slice(0, 4_000) });
  try {
    const response = await semaphore(() => budget.fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      },
    ));
    if (!response.ok) {
      console.error("Telegram mengembalikan HTTP", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Notifikasi Telegram gagal:", safeErrorMessage(error));
    return false;
  }
}

async function runCron(env) {
  const now = Math.floor(Date.now() / 1_000);
  const owner = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  // Cron invocations may run for up to 15 minutes; keep a lease beyond that
  // ceiling so a terminated run cannot overlap its next scheduled attempt.
  const lockResult = await env.DB.prepare(
    "UPDATE cron_lock SET owner = ?, lease_until = ? WHERE id = 1 AND lease_until < ?",
  ).bind(owner, now + 960, now).run();
  if (Number(lockResult?.meta?.changes || 0) !== 1) {
    console.log("Cron dilewati karena siklus sebelumnya masih memegang lock.");
    return;
  }

  const budget = new ExternalRequestBudget(MAX_EXTERNAL_REQUESTS_PER_RUN);
  const semaphore = createSemaphore(MAX_PARALLEL_FETCHES);
  try {
    const accountResult = await env.DB.prepare(
      "SELECT * FROM accounts ORDER BY last_synced_at ASC, id ASC LIMIT ?",
    ).bind(MAX_CRON_ACCOUNTS).all();
    const accounts = accountResult.results || [];
    const synced = await syncAccounts(accounts, env, { budget, semaphore });
    await sendTelegramDigest(synced.alerts, env, budget, semaphore);

    const cutoff = now - MESSAGE_RETENTION_SECONDS;
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM messages
        WHERE received_at < ?
           OR id NOT IN (
             SELECT id FROM messages ORDER BY received_at DESC LIMIT ?
           )
      `).bind(cutoff, MAX_CACHED_MESSAGES),
      env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now - OAUTH_STATE_TTL_SECONDS),
      env.DB.prepare("DELETE FROM pending_messages WHERE queued_at < ?").bind(cutoff),
    ]);

    console.log(JSON.stringify({
      cron: "gmail-sync",
      processed_accounts: accounts.length,
      new_messages: synced.newMessages,
      external_requests: budget.count,
    }));
  } finally {
    await env.DB.prepare(
      "UPDATE cron_lock SET owner = NULL, lease_until = 0 WHERE id = 1 AND owner = ?",
    ).bind(owner).run();
  }
}

function getAccountIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/accounts\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "ID pesan tidak valid.", "invalid_message_id");
  }
}

async function startOAuth(request, env, url) {
  requireEnvironment(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPTION_KEY"]);
  const alias = cleanText(url.searchParams.get("alias") || "", 60, "Alias");
  const category = cleanText(url.searchParams.get("category") || "General", 40, "Kategori");
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const now = Math.floor(Date.now() / 1_000);
  const statePayload = { v: 1, ts: now, nonce, alias, category };
  const state = await signOAuthState(statePayload, env);
  const nonceHash = await sha256Hex(nonce);
  await env.DB.prepare(
    "INSERT INTO oauth_states (nonce_hash, created_at) VALUES (?, ?)",
  ).bind(nonceHash, now).run();

  const redirectUri = `${url.origin}/auth/callback`;
  const oauthUrl = new URL(GOOGLE_AUTH_URL);
  oauthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  oauthUrl.searchParams.set("access_type", "offline");
  oauthUrl.searchParams.set("prompt", "consent");
  oauthUrl.searchParams.set("include_granted_scopes", "true");
  oauthUrl.searchParams.set("state", state);

  const redirect = withSecurityHeaders(Response.redirect(oauthUrl.toString(), 302), { "Cache-Control": "no-store" });
  return setOAuthCookie(redirect, nonce, url);
}

async function finishOAuth(request, env, url) {
  try {
    const state = url.searchParams.get("state");
    if (!state) {
      throw new HttpError(400, "Parameter OAuth state tidak ditemukan.", "missing_oauth_state");
    }
    requireEnvironment(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPTION_KEY"]);
    const payload = await verifyOAuthState(state, env);
    const browserNonce = readCookie(request, OAUTH_COOKIE_NAME);
    if (!browserNonce || !constantTimeEqual(browserNonce, payload.nonce)) {
      throw new HttpError(403, "OAuth callback tidak berasal dari browser yang memulai koneksi.", "oauth_browser_mismatch");
    }
    await consumeOAuthNonce(payload, env);

    if (url.searchParams.get("error")) {
      const cancelled = htmlResponse(oauthResultPage(false, "Persetujuan Google dibatalkan atau ditolak. Tidak ada akun yang ditambahkan."), 400);
      return setOAuthCookie(cancelled, "", url, true);
    }

    const code = url.searchParams.get("code");
    if (!code) {
      throw new HttpError(400, "Parameter authorization code tidak ditemukan.", "missing_oauth_code");
    }

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/auth/callback`,
        grant_type: "authorization_code",
      }),
    });
    let tokenData = {};
    try {
      tokenData = await tokenResponse.json();
    } catch {
      // The error response below remains deliberately generic.
    }
    if (!tokenResponse.ok || !tokenData.access_token) {      console.error("OAuth token exchange gagal:", tokenData.error || tokenResponse.status);
      throw new HttpError(502, "Google gagal menyelesaikan pertukaran authorization code.", "oauth_token_exchange_failed");
    }

    const profileResponse = await fetch(`${GOOGLE_API}/users/me/profile`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
      redirect: "manual",
    });
    if (!profileResponse.ok) {
      throw new HttpError(502, "Alamat Gmail tidak dapat diverifikasi dari Google.", "gmail_profile_failed");
    }
    const profile = await profileResponse.json();
    const email = String(profile.emailAddress || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(502, "Google tidak mengembalikan alamat Gmail yang valid.", "invalid_gmail_profile");
    }

    const existing = await env.DB.prepare("SELECT refresh_token_enc FROM accounts WHERE email = ?")
      .bind(email).first();
    let encryptedRefreshToken = existing?.refresh_token_enc || "";
    if (tokenData.refresh_token) {
      encryptedRefreshToken = await encryptRefreshToken(tokenData.refresh_token, env);
    }
    if (!encryptedRefreshToken) {
      throw new HttpError(502, "Google tidak mengirim refresh token. Cabut akses aplikasi di akun Google lalu tambahkan kembali dengan persetujuan baru.", "missing_refresh_token");
    }

    const now = Math.floor(Date.now() / 1_000);
    const tokenExpiresAt = now + Math.max(60, Number(tokenData.expires_in) || 3_600);
    await env.DB.prepare(`
      INSERT INTO accounts
        (email, alias, category, refresh_token_enc, access_token, token_expires_at, last_synced_at, sync_error)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(email) DO UPDATE SET
        alias = excluded.alias,
        category = excluded.category,
        refresh_token_enc = excluded.refresh_token_enc,
        access_token = excluded.access_token,
        token_expires_at = excluded.token_expires_at,
        sync_error = NULL
    `).bind(
      email,
      payload.alias,
      payload.category,
      encryptedRefreshToken,
      tokenData.access_token,
      tokenExpiresAt,
    ).run();

    const success = htmlResponse(oauthResultPage(true, `Akun ${email} berhasil ditambahkan atau diperbarui.`));
    return setOAuthCookie(success, "", url, true);
  } catch (error) {
    console.error("OAuth callback gagal:", safeErrorMessage(error));
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError
      ? error.message
      : "Google gagal menyelesaikan proses koneksi. Coba tambahkan akun kembali.";
    const failure = htmlResponse(oauthResultPage(false, message), status);
    return setOAuthCookie(failure, "", url, true);
  }
}

function oauthResultPage(success, message) {
  const title = success ? "Akun berhasil terhubung" : "Koneksi Gmail tidak selesai";
  const safeMessage = escapeHtml(message);
  const color = success ? "#166534" : "#991b1b";
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="margin:0;background:#f8fafc;color:#0f172a;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center"><main style="width:min(92vw,480px);background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:28px;box-sizing:border-box"><p style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${color}">${success ? "Berhasil" : "Perlu tindakan"}</p><h1 style="font-size:24px;margin:8px 0 12px">${title}</h1><p style="line-height:1.6;color:#475569">${safeMessage}</p><a href="/" style="display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;margin-top:16px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700">Kembali ke Unified Gmail Hub</a></main></body></html>`;
}

async function getAccounts(env) {
  const result = await env.DB.prepare(`
    SELECT a.id, a.email, a.alias, a.category, a.last_synced_at, a.sync_error,
      (SELECT COUNT(*) FROM messages m
       WHERE m.account_id = a.id AND m.is_unread = 1 AND m.received_at >= ?) AS unread_count
    FROM accounts a
    ORDER BY a.category COLLATE NOCASE, a.alias COLLATE NOCASE, a.email COLLATE NOCASE
  `).bind(getRecentWindowCutoff()).all();
  return jsonResponse({ accounts: result.results || [], display_window_days: DISPLAY_WINDOW_DAYS });
}

async function updateAccount(request, env, accountId) {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new HttpError(400, "ID akun tidak valid.", "invalid_account_id");
  }
  const payload = await readJson(request, 8_192);
  const alias = cleanText(payload.alias, 60, "Alias");
  const category = cleanText(payload.category, 40, "Kategori");
  const result = await env.DB.prepare(
    "UPDATE accounts SET alias = ?, category = ? WHERE id = ?",
  ).bind(alias, category, accountId).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new HttpError(404, "Akun tidak ditemukan.", "account_not_found");
  }
  return jsonResponse({ ok: true, account_id: accountId, alias, category });
}

async function deleteAccount(env, accountId) {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new HttpError(400, "ID akun tidak valid.", "invalid_account_id");
  }
  const result = await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new HttpError(404, "Akun tidak ditemukan.", "account_not_found");
  }
  return jsonResponse({ ok: true, deleted_account_id: accountId });
}

async function getInbox(url, env) {
  const category = url.searchParams.get("category") || "";
  const accountIdRaw = url.searchParams.get("account_id") || "";
  const query = (url.searchParams.get("q") || "").trim().slice(0, 120);
  const offsetRaw = Number(url.searchParams.get("offset") || 0);
  const offset = Number.isSafeInteger(offsetRaw) && offsetRaw > 0 ? Math.min(offsetRaw, 100_000) : 0;
  const cutoff = getRecentWindowCutoff();
  const conditions = ["m.received_at >= ?"];
  const parameters = [cutoff];
  let accountId = null;

  if (category && category.toLocaleLowerCase("id-ID") !== "semua") {
    conditions.push("a.category = ?");
    parameters.push(category);
  }
  if (accountIdRaw) {
    accountId = Number(accountIdRaw);
    if (!Number.isSafeInteger(accountId) || accountId < 1) {
      throw new HttpError(400, "Filter akun tidak valid.", "invalid_account_filter");
    }
    conditions.push("a.id = ?");
    parameters.push(accountId);
  }
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    conditions.push("(m.sender_name LIKE ? ESCAPE '\\' OR m.sender_email LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\')");
    parameters.push(pattern, pattern, pattern);
  }

  const whereSql = `WHERE ${conditions.join(" AND ")}`;
  const list = await env.DB.prepare(`
    SELECT m.id, m.thread_id, m.account_id, m.sender_name, m.sender_email, m.subject,
      m.snippet, m.is_unread, m.received_at, a.alias AS account_alias,
      a.email AS account_email, a.category AS account_category
    FROM messages m
    INNER JOIN accounts a ON a.id = m.account_id
    ${whereSql}
    ORDER BY m.received_at DESC, m.id DESC
    LIMIT 40 OFFSET ?
  `).bind(...parameters, offset).all();

  const unreadConditions = ["m.is_unread = 1", "m.received_at >= ?"];
  const unreadParameters = [cutoff];
  if (category && category.toLocaleLowerCase("id-ID") !== "semua") {
    unreadConditions.push("a.category = ?");
    unreadParameters.push(category);
  }
  if (accountId !== null) {
    unreadConditions.push("a.id = ?");
    unreadParameters.push(accountId);
  }
  const unreadTotal = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM messages m
    INNER JOIN accounts a ON a.id = m.account_id
    WHERE ${unreadConditions.join(" AND ")}
  `).bind(...unreadParameters).first();

  const unreadByCategory = await env.DB.prepare(`
    SELECT a.category, COUNT(*) AS unread_count
    FROM messages m INNER JOIN accounts a ON a.id = m.account_id
    WHERE m.is_unread = 1 AND m.received_at >= ?
    GROUP BY a.category
    ORDER BY a.category COLLATE NOCASE
  `).bind(cutoff).all();

  return jsonResponse({
    messages: list.results || [],
    unread_total: Number(unreadTotal?.total || 0),
    unread_by_category: unreadByCategory.results || [],
    display_window_days: DISPLAY_WINDOW_DAYS,
    next_offset: (list.results || []).length === 40 ? offset + 40 : null,
  });
}

async function getMessageDetails(messageId, env, budget, semaphore) {
  if (!messageId || messageId.length > 200) {
    throw new HttpError(400, "ID pesan tidak valid.", "invalid_message_id");
  }
  const stored = await env.DB.prepare(`
    SELECT m.*, a.email AS account_email, a.alias AS account_alias
    FROM messages m INNER JOIN accounts a ON a.id = m.account_id
    WHERE m.id = ? AND m.received_at >= ?
  `).bind(messageId, getRecentWindowCutoff()).first();
  if (!stored) throw new HttpError(404, "Email tidak ditemukan dalam jendela tampilan 7 hari terakhir.", "message_not_found");

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(stored.account_id).first();
  if (!account) throw new HttpError(404, "Akun pemilik email tidak ditemukan.", "account_not_found");

  const accessToken = await getValidAccessToken(account, env, budget, semaphore);
  const message = await fetchGoogleJson(makeGmailMessageUrl(messageId, "?format=full"), accessToken, { method: "GET" }, budget, semaphore);
  const headers = message?.payload?.headers || [];
  const body = extractMessageBody(message?.payload || {});
  const attachments = collectAttachments(message?.payload || {});
  const sender = parseMailbox(getHeader(headers, "From"));
  const to = getHeader(headers, "To");
  const replyTo = getHeader(headers, "Reply-To") || stored.reply_to || "";

  if ((message.labelIds || []).includes("UNREAD")) {
    await fetchGoogleJson(
      `${GOOGLE_API}/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      },
      budget,
      semaphore,
    );
  }
  await env.DB.prepare("UPDATE messages SET is_unread = 0 WHERE id = ?").bind(messageId).run();

  return jsonResponse({
    id: messageId,
    thread_id: message.threadId || stored.thread_id,
    from: {
      name: sender.name || stored.sender_name,
      email: sender.email || stored.sender_email,
    },
    to,
    reply_to: replyTo,
    account_id: stored.account_id,
    account_alias: stored.account_alias,
    account_email: stored.account_email,
    subject: decodeMimeWords(getHeader(headers, "Subject") || stored.subject || "(Tanpa subjek)"),
    date: getHeader(headers, "Date"),
    received_at: stored.received_at,
    snippet: stored.snippet,
    body_html: body.html,
    body_text: body.text,
    body_format: body.format,
    attachments,
    rfc_message_id: getHeader(headers, "Message-ID") || stored.rfc_message_id,
    references: getHeader(headers, "References"),
  });
}

function sanitizeHeaderValue(value) {
  return String(value || "").replace(/[\r\n\u0000]/g, " ").replace(/\s+/g, " ").trim();
}

function encodeMimeHeader(value) {
  const text = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${bytesToBase64(encoder.encode(text))}?=`;
}

function validMessageId(value) {
  const cleaned = sanitizeHeaderValue(value);
  const matches = cleaned.match(/<[^<>\s]+@[^<>\s]+>/g) || [];
  return matches;
}

function wrapBase64(value, width = 76) {
  const lines = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines.join("\r\n");
}

async function replyToMessage(messageId, request, env, budget, semaphore) {
  const payload = await readJson(request, MAX_REPLY_BODY_LENGTH + 1_024);
  if (typeof payload.body !== "string" || !payload.body.trim() || payload.body.length > MAX_REPLY_BODY_LENGTH) {
    throw new HttpError(400, `Isi balasan wajib diisi dan maksimal ${MAX_REPLY_BODY_LENGTH} karakter.`, "invalid_reply_body");
  }

  const stored = await env.DB.prepare(`
    SELECT m.*, a.email AS account_email, a.alias AS account_alias
    FROM messages m INNER JOIN accounts a ON a.id = m.account_id
    WHERE m.id = ? AND m.received_at >= ?
  `).bind(messageId, getRecentWindowCutoff()).first();
  if (!stored) throw new HttpError(404, "Email asal tidak ditemukan dalam jendela tampilan 7 hari terakhir.", "message_not_found");
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(stored.account_id).first();
  if (!account) throw new HttpError(404, "Akun pengirim asli tidak ditemukan.", "account_not_found");

  const accessToken = await getValidAccessToken(account, env, budget, semaphore);
  const original = await fetchGoogleJson(
    makeGmailMessageUrl(messageId, "?format=full"),
    accessToken,
    { method: "GET" },
    budget,
    semaphore,
  );
  const headers = original?.payload?.headers || [];
  const replyTo = getHeader(headers, "Reply-To");
  const from = getHeader(headers, "From");
  const recipient = parseMailbox(replyTo || from).email;
  if (!recipient) {
    throw new HttpError(422, "Alamat Reply-To/From email asal tidak dapat dibaca.", "reply_recipient_missing");
  }

  const originalMessageId = getHeader(headers, "Message-ID") || stored.rfc_message_id;
  const inReplyTo = validMessageId(originalMessageId)[0];
  if (!inReplyTo) {
    throw new HttpError(422, "Header Message-ID email asal tidak tersedia; balasan tidak dikirim agar thread tidak rusak.", "original_message_id_missing");
  }
  const references = [
    ...validMessageId(getHeader(headers, "References")),
    inReplyTo,
  ].filter((value, index, values) => values.indexOf(value) === index);

  const originalSubject = decodeMimeWords(getHeader(headers, "Subject") || stored.subject || "");
  const replySubject = /^re\s*:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject || "(Tanpa subjek)"}`;
  const bodyBase64 = wrapBase64(bytesToBase64(encoder.encode(payload.body.replace(/\r?\n/g, "\r\n"))));
  const rawMessage = [
    `To: ${recipient}`,
    `Subject: ${encodeMimeHeader(replySubject)}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references.join(" ")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyBase64,
  ].join("\r\n");

  const sent = await fetchGoogleJson(
    `${GOOGLE_API}/users/me/messages/send`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: String(original.threadId || stored.thread_id),
        raw: bytesToBase64Url(encoder.encode(rawMessage)),
      }),
    },
    budget,
    semaphore,
  );
  return jsonResponse({ ok: true, sent_id: sent.id || null, thread_id: sent.threadId || stored.thread_id });
}

async function manualSync(url, env) {
  const accountIdRaw = url.searchParams.get("account_id");
  let accounts;
  if (accountIdRaw) {
    const accountId = Number(accountIdRaw);
    if (!Number.isSafeInteger(accountId) || accountId < 1) {
      throw new HttpError(400, "account_id tidak valid.", "invalid_account_id");
    }
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    if (!account) throw new HttpError(404, "Akun tidak ditemukan.", "account_not_found");
    accounts = [account];
  } else {
    const result = await env.DB.prepare(
      "SELECT * FROM accounts ORDER BY last_synced_at ASC, id ASC LIMIT ?",
    ).bind(MAX_CRON_ACCOUNTS).all();
    accounts = result.results || [];
  }

  const budget = new ExternalRequestBudget(MAX_EXTERNAL_REQUESTS_PER_RUN);
  const semaphore = createSemaphore(MAX_PARALLEL_FETCHES);
  const synced = await syncAccounts(accounts, env, { budget, semaphore });
  return jsonResponse({
    synced_accounts: synced.results,
    new_messages: synced.newMessages,
    external_requests: budget.count,
  });
}

async function routeApi(request, env, url) {
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const mutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);
  validateSameOrigin(request, url, { mutating });

  if (pathname === "/api/accounts" && method === "GET") {
    return getAccounts(env);
  }
  if (pathname === "/api/accounts" && method !== "GET") {
    throw new HttpError(405, "Method tidak diizinkan.", "method_not_allowed");
  }
  if (pathname === "/api/sync" && method === "POST") {
    return manualSync(url, env);
  }
  if (pathname === "/api/inbox" && method === "GET") {
    return getInbox(url, env);
  }

  const accountId = getAccountIdFromPath(pathname);
  if (accountId !== null) {
    if (method === "PATCH") return updateAccount(request, env, accountId);
    if (method === "DELETE") return deleteAccount(env, accountId);
    throw new HttpError(405, "Method tidak diizinkan.", "method_not_allowed");
  }

  const replyMatch = pathname.match(/^\/api\/messages\/([^/]+)\/reply$/);
  if (replyMatch && method === "POST") {
    const messageId = decodePathSegment(replyMatch[1]);
    const budget = new ExternalRequestBudget(MAX_EXTERNAL_REQUESTS_PER_RUN);
    const semaphore = createSemaphore(MAX_PARALLEL_FETCHES);
    return replyToMessage(messageId, request, env, budget, semaphore);
  }

  const messageMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch && method === "GET") {
    const messageId = decodePathSegment(messageMatch[1]);
    const budget = new ExternalRequestBudget(MAX_EXTERNAL_REQUESTS_PER_RUN);
    const semaphore = createSemaphore(MAX_PARALLEL_FETCHES);
    return getMessageDetails(messageId, env, budget, semaphore);
  }

  if (pathname.startsWith("/api/")) {
    throw new HttpError(404, "Endpoint API tidak ditemukan.", "endpoint_not_found");
  }
  throw new HttpError(404, "Endpoint tidak ditemukan.", "not_found");
}

async function serveStaticAsset(request, env) {
  if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
    return env.ASSETS.fetch(request);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method tidak diizinkan.", {
      status: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const asset = INLINE_ASSETS[pathname];
  if (!asset) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": pathname === "/index.html" ? "no-cache" : "public, max-age=3600",
    },
  });
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/auth/add" && request.method === "GET") {
      return await startOAuth(request, env, url);
    }
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      return await finishOAuth(request, env, url);
    }
    if (url.pathname.startsWith("/auth/")) {
      throw new HttpError(405, "Method atau endpoint autentikasi tidak diizinkan.", "auth_method_not_allowed");
    }
    if (url.pathname.startsWith("/api/")) {
      return await routeApi(request, env, url);
    }

    const assetResponse = await serveStaticAsset(request, env);
    return withSecurityHeaders(assetResponse, { "Cache-Control": assetResponse.status === 200 ? "no-cache" : "no-store" });
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    try {
      await runCron(env);
    } catch (error) {
      console.error("Cron Gmail Hub gagal:", safeErrorMessage(error));
    }
  },
};

export {
  decodeBase64UrlUtf8,
  sanitizeEmailHtml,
  extractMessageBody,
  parseMetadataMessage,
  MAX_EXTERNAL_REQUESTS_PER_RUN,
  MAX_METADATA_PER_ACCOUNT,
};