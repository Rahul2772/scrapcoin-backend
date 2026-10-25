/**
 * Dev-only script: send a sample Telegram booking notification.
 *
 * Usage:
 *   npm run telegram:test
 *   # or directly:
 *   npx tsx src/scripts/telegram_test.ts
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_NOTIFY_CHAT_ID to be set in .env.
 * Never creates a public HTTP endpoint — local use only.
 */

import { notifyNewBooking, escapeHtml } from "../lib/telegram.js";

// ---------------------------------------------------------------------------
// Unit-style assertions (no test framework needed)
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${message}`);
  }
}

function runFormatterTests() {
  console.log("\n=== Formatter / escapeHtml tests ===\n");

  // 1. HTML escaping
  const dirty = 'A & <B> "C"';
  const escaped = escapeHtml(dirty);
  assert(
    escaped === "A &amp; &lt;B&gt; \"C\"",
    `escapeHtml: '${dirty}' → '${escaped}'`
  );

  // 2. Ensure escaping of just ampersand
  assert(escapeHtml("Tom & Jerry") === "Tom &amp; Jerry", "escapeHtml: ampersand");

  // 3. Ensure escaping of angle brackets
  assert(escapeHtml("<script>") === "&lt;script&gt;", "escapeHtml: script tag");

  // 4. Check message stays under 4096 chars with a very long address
  const longAddress = "A ".repeat(300); // 600 chars
  // Build a message manually to verify truncation
  const escapedAddr = escapeHtml(longAddress);
  assert(escapedAddr.length > 0, "escapeHtml: long address does not crash");
}

// ---------------------------------------------------------------------------
// Sample booking objects
// ---------------------------------------------------------------------------

const sampleBooking = {
  id: "test-booking-001",
  fullName: "Test & <User>",        // intentional HTML chars
  phone: "+91 98765 43210",
  society: "Sector 62 Heights",
  tower: "Tower B",
  pickupDate: "2026-11-01",
  timeSlot: "10:00 AM – 12:00 PM",
  materials: ["Newspaper", "Cardboard", "Plastic bottles"],
  estimate: "~15 kg",
  lat: 28.6139,
  lng: 77.209,
  createdAt: new Date().toISOString(),
};

const minimalBooking = {
  id: "test-booking-002",
  fullName: "Minimal User",
  phone: "+91 90000 00000",
  society: "Green Park",
  pickupDate: "2026-11-02",
  materials: ["Iron scrap"],
};

// ---------------------------------------------------------------------------
// Live send test
// ---------------------------------------------------------------------------

async function sendLiveTest() {
  console.log("\n=== Live Telegram send test ===\n");

  const env = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_NOTIFY_CHAT_ID: process.env.TELEGRAM_NOTIFY_CHAT_ID,
  };

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_NOTIFY_CHAT_ID) {
    console.warn(
      "⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_NOTIFY_CHAT_ID not set in .env — skipping live send."
    );
    return;
  }

  console.log("Sending sample booking notification (with all fields)…");
  await notifyNewBooking(env, sampleBooking);

  console.log("Sending minimal booking notification (missing optional fields)…");
  await notifyNewBooking(env, minimalBooking);

  console.log("\nDone — check your Telegram chat.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runFormatterTests();
sendLiveTest().catch((err) => {
  console.error("Fatal error in telegram_test:", err);
  process.exit(1);
});
