import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeBase64UrlUtf8,
  sanitizeEmailHtml,
  extractMessageBody,
  parseMetadataMessage,
  MAX_EXTERNAL_REQUESTS_PER_RUN,
  MAX_METADATA_PER_ACCOUNT,
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
  assert.equal(MAX_METADATA_PER_ACCOUNT, 7);
});
