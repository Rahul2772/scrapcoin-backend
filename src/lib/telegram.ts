/**
 * Telegram Booking Notification Helper
 *
 * Sends a Telegram message to `TELEGRAM_NOTIFY_CHAT_ID` whenever a new booking
 * is created.  Uses raw `fetch` (no third-party SDK) so it is compatible with
 * the Cloudflare Workers runtime as well as Node.js.
 *
 * Env vars required:
 *   TELEGRAM_BOT_TOKEN       — Bot token from @BotFather
 *   TELEGRAM_NOTIFY_CHAT_ID  — Target chat ID (user or group; comma-separated for multiple)
 *
 * Design notes:
 *   - A Telegram failure NEVER causes a booking failure.
 *   - The caller is responsible for firing this non-blocking (e.g. via .catch()).
 *   - One retry on network error or HTTP 429/5xx (honouring retry_after on 429).
 *   - Bot token is never logged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_NOTIFY_CHAT_ID?: string;
}

export interface BookingForNotification {
  id: string;
  fullName: string;
  phone: string;
  society: string;
  tower?: string | null;
  pickupDate: string;
  /** Time slot string, if available */
  timeSlot?: string | null;
  materials: string[];
  /** Estimated weight / value string, if available */
  estimate?: string | null;
  lat?: number | null;
  lng?: number | null;
  createdAt?: string | null;
}

interface SendOptions {
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  disable_web_page_preview?: boolean;
  reply_markup?: Record<string, unknown>;
}

interface TelegramSendResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// HTML escaping (required for parse_mode: 'HTML')
// ---------------------------------------------------------------------------

/**
 * Escapes characters that are special inside Telegram HTML messages.
 * Apply this to ALL user-supplied strings before embedding in the message.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Low-level send
// ---------------------------------------------------------------------------

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Truncate a string to `maxLen` characters, appending "…" if cut.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * POST to Telegram's sendMessage endpoint.
 * Retries once on network error or HTTP 429/5xx (respecting retry_after).
 * Never throws — always returns a TelegramSendResult.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  options: SendOptions = {}
): Promise<TelegramSendResult> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text: truncate(text, MAX_MESSAGE_LENGTH),
    disable_web_page_preview: true,
    ...options,
  });

  const attempt = async (): Promise<TelegramSendResult> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (networkErr) {
      return {
        success: false,
        error: `Network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      };
    }

    // Parse JSON regardless of HTTP status so we can log Telegram's description
    let json: { ok: boolean; description?: string; parameters?: { retry_after?: number } } | null =
      null;
    try {
      json = await response.json();
    } catch {
      // Ignore parse failure
    }

    if (response.ok && json?.ok) {
      return { success: true };
    }

    const desc = json?.description ?? `HTTP ${response.status}`;
    return {
      success: false,
      error: desc,
      // Expose retry_after so the caller can wait
      ...(json?.parameters?.retry_after ? { retryAfter: json.parameters.retry_after } : {}),
    } as TelegramSendResult & { retryAfter?: number };
  };

  // First attempt
  let result = await attempt();

  // Retry once on network error or server/rate-limit error
  if (!result.success) {
    const retryAfter =
      (result as TelegramSendResult & { retryAfter?: number }).retryAfter ?? 0;
    const isRetryable =
      result.error?.startsWith("Network error") ||
      result.error?.startsWith("HTTP 5") ||
      result.error?.startsWith("HTTP 429") ||
      retryAfter > 0;

    if (isRetryable) {
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 30_000)));
      result = await attempt();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Booking notification formatter + sender
// ---------------------------------------------------------------------------

/**
 * Format a booking into an HTML Telegram message and send it.
 * Returns silently on any error — never throws.
 */
export async function notifyNewBooking(
  env: TelegramEnv,
  booking: BookingForNotification
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const rawChatIds = env.TELEGRAM_NOTIFY_CHAT_ID?.trim();

  if (!token || !rawChatIds) {
    console.warn(
      "[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_NOTIFY_CHAT_ID is not set — skipping notification."
    );
    return;
  }

  // Support comma-separated list of chat IDs
  const chatIds = (rawChatIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (chatIds.length === 0) {
    console.warn("[Telegram] TELEGRAM_NOTIFY_CHAT_ID is empty after parsing — skipping.");
    return;
  }

  const message = formatBookingMessage(booking);
  const replyMarkup = buildReplyMarkup(booking);
  const sendOptions: SendOptions = {
    parse_mode: "HTML",
    disable_web_page_preview: !hasMapLink(booking),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  const results = await Promise.allSettled(
    chatIds.map((chatId) => sendTelegramMessage(token, chatId, message, sendOptions))
  );

  results.forEach((result, i) => {
    const chatId = chatIds[i];
    if (result.status === "fulfilled" && result.value.success) {
      console.log(`[Telegram] Booking notification sent to chat ${chatId} (booking ${booking.id})`);
    } else {
      const reason =
        result.status === "rejected"
          ? String(result.reason)
          : result.value.error ?? "unknown error";
      console.error(
        `[Telegram] Failed to send booking notification to chat ${chatId}: ${reason}`
      );
    }
  });

}

// ---------------------------------------------------------------------------
// Message formatter
// ---------------------------------------------------------------------------

function hasMapLink(booking: BookingForNotification): boolean {
  return typeof booking.lat === "number" && typeof booking.lng === "number";
}

function formatBookingMessage(booking: BookingForNotification): string {
  const lines: string[] = [];

  lines.push("🆕 <b>New Pickup Booking</b>");
  lines.push("");

  // Name (required)
  lines.push(`👤 <b>Name:</b> ${escapeHtml(booking.fullName)}`);

  // Phone (required)
  lines.push(`📞 <b>Phone:</b> ${escapeHtml(booking.phone)}`);

  // Address
  const addressParts: string[] = [];
  if (booking.tower) addressParts.push(booking.tower);
  if (booking.society) addressParts.push(booking.society);
  const address = addressParts.join(", ");
  if (address) {
    lines.push(`📍 <b>Address:</b> ${escapeHtml(truncate(address, 200))}`);
  }

  // Slot: pickup date + time slot
  const slotParts: string[] = [];
  if (booking.pickupDate) slotParts.push(booking.pickupDate);
  if (booking.timeSlot) slotParts.push(booking.timeSlot);
  if (slotParts.length > 0) {
    lines.push(`🗓 <b>Slot:</b> ${escapeHtml(slotParts.join(" · "))}`);
  }

  // Scrap materials + optional estimate
  if (booking.materials && booking.materials.length > 0) {
    const materialsStr = booking.materials.map((m) => escapeHtml(m)).join(", ");
    const estimateStr = booking.estimate ? ` (${escapeHtml(booking.estimate)})` : "";
    lines.push(`♻️ <b>Scrap:</b> ${materialsStr}${estimateStr}`);
  }

  // Booking ID
  lines.push(`🆔 <b>Booking ID:</b> <code>${escapeHtml(booking.id)}</code>`);

  // Created at
  if (booking.createdAt) {
    const dateStr = new Date(booking.createdAt).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
    lines.push(`🕐 <b>Created:</b> ${dateStr} IST`);
  }

  // Map link
  if (hasMapLink(booking)) {
    const mapUrl = `https://www.google.com/maps?q=${booking.lat},${booking.lng}`;
    lines.push(`🗺 <a href="${mapUrl}">View on map</a>`);
  }

  return lines.join("\n");
}

function buildReplyMarkup(
  booking: BookingForNotification
): Record<string, unknown> | null {
  // Only add an inline button if we have a booking ID to link to.
  // The admin dashboard URL — update this path if the frontend route changes.
  const dashboardBase = process.env.ADMIN_DASHBOARD_URL?.trim();
  if (!dashboardBase) return null;

  return {
    inline_keyboard: [
      [
        {
          text: "Open in Dashboard",
          url: `${dashboardBase}/bookings/${encodeURIComponent(booking.id)}`,
        },
      ],
    ],
  };
}
