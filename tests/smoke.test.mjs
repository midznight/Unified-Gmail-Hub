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
  escapeLike,
  INBOX_SEARCH_CONDITION,
  persistDiscoveredMessageIds,
  encryptAccessToken,
  decryptAccessToken,
  getValidAccessToken,
  getMessageDetails,
  acquireSyncLock,
  releaseSyncLock,
  manualSync,
  runCron,
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



const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

test("access tokens use authenticated encryption at rest", async () => {
  const env = { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
  const token = "ya29.synthetic-access-token";
  const encrypted = await encryptAccessToken(token, env);

  assert.match(encrypted, /^at1\./);
  assert.notEqual(encrypted, token);
  assert.equal(await decryptAccessToken(encrypted, env), token);

  const [version, iv, ciphertext] = encrypted.split(".");
  const bytes = Buffer.from(ciphertext, "base64url");
  bytes[0] ^= 1;
  const tampered = `${version}.${iv}.${bytes.toString("base64url")}`;
  await assert.rejects(decryptAccessToken(tampered, env));
});

test("legacy plaintext access tokens are encrypted in D1 before being used", async () => {
  const updates = [];
  const env = {
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                updates.push({ sql, values });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  const legacyToken = "ya29.legacy-synthetic-token";
  const account = {
    id: 17,
    access_token: legacyToken,
    token_expires_at: Math.floor(Date.now() / 1_000) + 3_600,
  };

  assert.equal(await getValidAccessToken(account, env), legacyToken);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /UPDATE accounts SET access_token = \? WHERE id = \? AND access_token = \?/);
  assert.equal(await decryptAccessToken(updates[0].values[0], env), legacyToken);
});

test("opening an email marks it read only through the explicit action", async () => {
  const env = { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
  const encryptedToken = await encryptAccessToken("ya29.synthetic-access-token", env);
  const dbWrites = [];
  const account = {
    id: 5,
    email: "owner@example.test",
    alias: "Synthetic",
    access_token: encryptedToken,
    token_expires_at: Math.floor(Date.now() / 1_000) + 3_600,
  };
  const storedMessage = {
    id: "message-1",
    thread_id: "thread-1",
    account_id: 5,
    received_at: Math.floor(Date.now() / 1_000),
    is_unread: 1,
    sender_name: "Sender",
    sender_email: "sender@example.test",
    reply_to: "",
    rfc_message_id: "<synthetic@example.test>",
    subject: "Synthetic message",
    snippet: "Preview",
  };
  env.DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("SELECT m.*")) return storedMessage;
              if (sql.includes("SELECT * FROM accounts")) return account;
              throw new Error("Unexpected SELECT in test: " + sql);
            },
            async run() {
              dbWrites.push({ sql, values });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  async function invoke(markAsRead) {
    const requests = [];
    const gmailMessage = {
      id: "message-1",
      threadId: "thread-1",
      labelIds: ["UNREAD"],
      payload: {
        mimeType: "text/plain",
        body: { data: Buffer.from("Halo dari fixture").toString("base64url") },
        headers: [
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "To", value: "owner@example.test" },
          { name: "Subject", value: "Synthetic message" },
          { name: "Message-ID", value: "<synthetic@example.test>" },
        ],
      },
    };
    const budget = {
      async fetch(url, init = {}) {
        requests.push({ url: String(url), method: init.method || "GET" });
        return new Response(JSON.stringify(gmailMessage), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    const response = await getMessageDetails(
      "message-1",
      "all",
      env,
      budget,
      async (task) => task(),
      { markAsRead },
    );
    assert.equal(response.status, 200);
    return requests.map((request) => request.method);
  }

  const readOnlyWritesBefore = dbWrites.length;
  assert.deepEqual(await invoke(false), ["GET"]);
  assert.equal(dbWrites.length, readOnlyWritesBefore);

  assert.deepEqual(await invoke(true), ["GET", "POST"]);
  assert.equal(dbWrites.filter((entry) => entry.sql.includes("UPDATE messages SET is_unread = 0")).length, 1);
});

test("Inbox search uses a one-character LIKE escape and treats user wildcards literally", () => {
  const escapeTokens = [...INBOX_SEARCH_CONDITION.matchAll(/ESCAPE '([^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(escapeTokens, ["!", "!", "!"]);
  assert.equal(escapeLike("100%_done!\\folder"), "100!%!_done!!\\folder");
});

test("backfill queues unseen IDs and advances the page checkpoint in one D1 batch", async () => {
  const batches = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return { sql, values };
          },
        };
      },
      async batch(statements) {
        batches.push(statements);
        return [];
      },
    },
  };

  await persistDiscoveredMessageIds(
    env,
    42,
    ["new-1", "already-cached", "new-2"],
    new Set(["already-cached"]),
    1_800_000_000,
    { pageToken: "next-page-token", scanComplete: 0 },
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.match(batches[0][0].sql, /INSERT OR IGNORE INTO pending_messages/);
  assert.deepEqual(batches[0][0].values, ["new-1", 42, 1_800_000_000]);
  assert.deepEqual(batches[0][1].values, ["new-2", 42, 1_800_000_000]);
  assert.match(batches[0][2].sql, /UPDATE accounts SET history_page_token/);
  assert.deepEqual(batches[0][2].values, ["next-page-token", 0, 42]);
});

test("backfill can commit an exhausted-page checkpoint even when no IDs are new", async () => {
  const batches = [];
  const env = {
    DB: {
      prepare(sql) {
        return { sql, bind: (...values) => ({ sql, values }) };
      },
      async batch(statements) {
        batches.push(statements);
      },
    },
  };

  await persistDiscoveredMessageIds(
    env,
    42,
    [],
    new Set(),
    1_800_000_000,
    { pageToken: null, scanComplete: 1 },
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.match(batches[0][0].sql, /UPDATE accounts SET history_page_token/);
  assert.deepEqual(batches[0][0].values, [null, 1, 42]);
});


test("manual and scheduled synchronization share an owner-checked D1 lease", async () => {
  let lockOwner = null;
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                statements.push({ sql, values });
                if (sql.includes("SET owner = ?, lease_until = ?")) {
                  if (lockOwner !== null) return { meta: { changes: 0 } };
                  lockOwner = values[0];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET owner = NULL, lease_until = 0")) {
                  if (lockOwner === values[0]) {
                    lockOwner = null;
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: 0 } };
                }
                throw new Error("Unexpected lock SQL: " + sql);
              },
            };
          },
        };
      },
    },
  };

  const firstOwner = await acquireSyncLock(env);
  assert.equal(typeof firstOwner, "string");
  assert.ok(firstOwner.length >= 20);
  assert.equal(await acquireSyncLock(env), null);

  await releaseSyncLock(env, "not-the-owner");
  assert.equal(lockOwner, firstOwner);
  assert.equal(await acquireSyncLock(env), null);

  await releaseSyncLock(env, firstOwner);
  assert.equal(lockOwner, null);

  const nextOwner = await acquireSyncLock(env);
  assert.equal(typeof nextOwner, "string");
  assert.notEqual(nextOwner, firstOwner);
  await releaseSyncLock(env, nextOwner);
  assert.equal(lockOwner, null);
});

test("manual sync returns HTTP 409 when cron or another manual sync owns the lease", async () => {
  let statements = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async run() {
                statements += 1;
                assert.match(sql, /UPDATE cron_lock SET owner = \?, lease_until = \?/);
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };

  await assert.rejects(
    manualSync(new URL("https://hub.example.test/api/sync"), env),
    (error) => error.status === 409 && error.code === "sync_already_running",
  );
  assert.equal(statements, 1, "account queries must not start while another sync owns the lock");
});

test("manual sync releases its shared lease after successful completion", async () => {
  let lockOwner = null;
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                statements.push(sql);
                if (sql.includes("SET owner = ?, lease_until = ?")) {
                  if (lockOwner !== null) return { meta: { changes: 0 } };
                  lockOwner = values[0];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET owner = NULL, lease_until = 0")) {
                  if (lockOwner === values[0]) lockOwner = null;
                  return { meta: { changes: 1 } };
                }
                throw new Error("Unexpected run SQL: " + sql);
              },
              async all() {
                statements.push(sql);
                assert.match(sql, /SELECT \* FROM accounts/);
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };

  const response = await manualSync(new URL("https://hub.example.test/api/sync"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    synced_accounts: [],
    new_messages: 0,
    external_requests: 0,
  });
  assert.equal(lockOwner, null);
  assert.equal(statements.filter((sql) => sql.includes("SET owner = ?, lease_until = ?")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("SET owner = NULL, lease_until = 0")).length, 1);
});


test("scheduled cron acquires and releases the same D1 lease used by manual sync", async () => {
  let lockOwner = null;
  const batched = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                if (sql.includes("SET owner = ?, lease_until = ?")) {
                  if (lockOwner !== null) return { meta: { changes: 0 } };
                  lockOwner = values[0];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET owner = NULL, lease_until = 0")) {
                  if (lockOwner === values[0]) lockOwner = null;
                  return { meta: { changes: 1 } };
                }
                throw new Error("Unexpected run SQL: " + sql);
              },
              async all() {
                assert.match(sql, /SELECT \* FROM accounts/);
                return { results: [] };
              },
            };
          },
        };
      },
      async batch(statements) {
        batched.push(statements);
      },
    },
  };

  await runCron(env);
  assert.equal(lockOwner, null);
  assert.equal(batched.length, 1);
  assert.equal(batched[0].length, 3, "cron retention and nonce/pending cleanup must execute");
});

test("manual sync releases the lease when validation fails after acquisition", async () => {
  let lockOwner = null;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                if (sql.includes("SET owner = ?, lease_until = ?")) {
                  lockOwner = values[0];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET owner = NULL, lease_until = 0")) {
                  if (lockOwner === values[0]) lockOwner = null;
                  return { meta: { changes: 1 } };
                }
                throw new Error("Unexpected run SQL: " + sql);
              },
            };
          },
        };
      },
    },
  };

  await assert.rejects(
    manualSync(new URL("https://hub.example.test/api/sync?account_id=invalid"), env),
    (error) => error.status === 400 && error.code === "invalid_account_id",
  );
  assert.equal(lockOwner, null);
});

test("backfill does not swallow a failed atomic queue/checkpoint batch", async () => {
  const failure = new Error("simulated D1 batch failure");
  let attemptedBatch = false;
  const env = {
    DB: {
      prepare(sql) {
        return { sql, bind: (...values) => ({ sql, values }) };
      },
      async batch(statements) {
        attemptedBatch = true;
        assert.equal(statements.length, 2);
        throw failure;
      },
    },
  };

  await assert.rejects(
    persistDiscoveredMessageIds(
      env,
      42,
      ["not-yet-cached"],
      new Set(),
      1_800_000_000,
      { pageToken: "next-page-token", scanComplete: 0 },
    ),
    failure,
  );
  assert.equal(attemptedBatch, true);
});
