#!/usr/bin/env node
/**
 * Claude Code Stop hook — fires every time Claude finishes a response.
 * Sends a ping to the Firebase Cloud Function which delivers an FCM push.
 */

const https = require("https");

const FUNCTION_URL = process.env.CLAUDE_NOTIFY_FUNCTION_URL;

if (!FUNCTION_URL) {
  // Silently exit — hook should never crash Claude Code
  process.exit(0);
}

// Parse the hook payload from stdin (Claude passes JSON on stdin)
let payload = {};
try {
  const raw = require("fs").readFileSync("/dev/stdin", "utf8").trim();
  if (raw) payload = JSON.parse(raw);
} catch (_) {
  // stdin not available or not JSON — proceed with empty payload
}

const body = JSON.stringify({
  title: "Claude is waiting",
  body: payload.session_id
    ? `Session ${payload.session_id.slice(0, 8)} needs your input`
    : "Your Claude Code session needs your input",
  timestamp: new Date().toISOString(),
});

const url = new URL(FUNCTION_URL);
const options = {
  hostname: url.hostname,
  path: url.pathname + url.search,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
};

const req = https.request(options, (res) => {
  // We don't need to do anything with the response
  res.resume();
});

req.on("error", () => {
  // Silently ignore network errors — hook must not block Claude Code
});

req.setTimeout(5000, () => {
  req.destroy();
});

req.write(body);
req.end();
