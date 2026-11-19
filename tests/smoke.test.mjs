import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeBase64UrlUtf8,
  sanitizeEmailHtml,
  extractMessageBody,
  parseMetadataMessage,
  MAX_EXTERNAL_REQUESTS_PER_RUN,
  MAX_METADATA_PER_ACCOUNT,
  DISPLAY_WINDOW_DAYS,
  DISPLAY_WINDOWS,
  DEFAULT_DISPLAY_RANGE,
  normalizeDisplayRange,
  getRecentWindowCutoff,
  MESSAGE_RETENTION_SECONDS,
  MAX_CACHED_MESSAGES,
  GOOGLE_OAUTH_PROMPT,
  ACCOUNT_UPSERT_SQL,
} from "../src/index.js";

test("MIME UTF-8 decoder preserves emoji and non-ASCII characters", () => {
  const original = "Halo 😃 dunia — café";
  const encoded = Buffer.from(original, "utf8").toString("base64url");
  assert.equal(decodeBase64UrlUtf8(encoded), original);
});

test("email HTML sanitizer removes script, event handlers, and dangerous URLs", () => {
  const safeHtml = sanitizeEmailHtml(
    '<html><body><script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)"><p onclick="x()">Aman</p><a href="https://example.com">link</a></body></html>',
  );
  assert.doesNotMatch(safeHtml, /<script|onerror|onclick|javascript:/i);
  assert.match(safeHtml, /Aman/);
  assert.match(safeHtml, /https:\/\/example\.com/);
});

test("MIME extraction prioritizes HTML over plain text", () => {
  const body = extractMessageBody({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("PLAIN").toString("base64url") } },
      { mimeType: "text/html", body: { data: Buffer.from("<p>HTML</p>").toString("base64url") } },
    ],
  });
  assert.equal(body.format, "html");
  assert.match(body.html, /HTML/);
});

test("metadata parser preserves account relation and unread status", () => {
  const metadata = parseMetadataMessage(
    {
      id: "m1",
      threadId: "t1",
      internalDate: "1760000000000",
      snippet: "snip",
      labelIds: ["UNREAD"],
      payload: {
        headers: [
          { name: "From", value: "A <a@example.com>" },
          { name: "Subject", value: "Test" },
          { name: "Message-ID", value: "<id@example.com>" },
        ],
        mimeType: "text/plain",
      },
    },
    7,
  );
  assert.equal(metadata.id, "m1");
  assert.equal(metadata.account_id, 7);
  assert.equal(metadata.is_unread, 1);
});

test("sync budget leaves headroom below the 30-request application ceiling", () => {
  assert.equal(MAX_EXTERNAL_REQUESTS_PER_RUN, 29);
  assert.equal(MAX_METADATA_PER_ACCOUNT, 6);
});


test("display ranges use rolling 7, 30, and 90 day cutoffs", () => {
  const now = 2_000_000_000;
  assert.equal(DEFAULT_DISPLAY_RANGE, "7d");
  assert.equal(DISPLAY_WINDOW_DAYS, 7);
  assert.deepEqual(DISPLAY_WINDOWS, { "7d": 7, "30d": 30, "90d": 90, all: null });
  assert.equal(getRecentWindowCutoff("7d", now), now - (7 * 24 * 60 * 60));
  assert.equal(getRecentWindowCutoff("30d", now), now - (30 * 24 * 60 * 60));
  assert.equal(getRecentWindowCutoff("90d", now), now - (90 * 24 * 60 * 60));
  assert.equal(getRecentWindowCutoff("all", now), null);
  assert.equal(normalizeDisplayRange("all"), "all");
  assert.throws(() => normalizeDisplayRange("14d"), /Rentang email tidak valid/);
});

test("cache retention preserves at most 90 days and 1000 messages", () => {
  assert.equal(MESSAGE_RETENTION_SECONDS, 90 * 24 * 60 * 60);
  assert.equal(MAX_CACHED_MESSAGES, 1_000);
});


test("OAuth add flow explicitly asks Google to show the account chooser", () => {
  assert.equal(GOOGLE_OAUTH_PROMPT, "select_account consent");
});

test("re-authorizing an existing Gmail address preserves account identity and mailbox history", () => {
  assert.ok(ACCOUNT_UPSERT_SQL.includes("ON CONFLICT(email) DO UPDATE SET"));
  assert.ok(ACCOUNT_UPSERT_SQL.includes("refresh_token_enc = excluded.refresh_token_enc"));
  assert.ok(ACCOUNT_UPSERT_SQL.includes("access_token = excluded.access_token"));
  assert.equal(ACCOUNT_UPSERT_SQL.includes("alias = excluded.alias"), false);
  assert.equal(ACCOUNT_UPSERT_SQL.includes("category = excluded.category"), false);
  assert.equal(ACCOUNT_UPSERT_SQL.includes("last_synced_at = excluded.last_synced_at"), false);
  assert.equal(ACCOUNT_UPSERT_SQL.includes("history_page_token = excluded.history_page_token"), false);
  assert.equal(ACCOUNT_UPSERT_SQL.includes("history_scan_complete = excluded.history_scan_complete"), false);
});
