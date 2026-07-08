import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const whatsappFrom = (process.env.TWILIO_WHATSAPP_FROM || "").split("#")[0].trim() || "whatsapp:+14155238886";
const smsFrom = (process.env.TWILIO_SMS_FROM || "").split("#")[0].trim() || undefined;
const provider = process.env.WHATSAPP_PROVIDER?.trim() || "mock";

// Initialize Twilio client only if credentials are provided and provider is set to 'twilio'
let client: twilio.Twilio | null = null;
if (provider === "twilio" && accountSid && authToken) {
  try {
    client = twilio(accountSid, authToken);
    console.log("Twilio client initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize Twilio client:", err);
  }
} else {
  console.log(`Twilio integration is running in MOCK mode (provider: ${provider}).`);
}

/**
 * Normalizes phone numbers to E.164 format.
 * Default is +91 for Indian mobile numbers if no country code is present.
 */
export function formatPhoneNumber(phone: string): string {
  // Remove spaces, dashes, parentheses
  let cleaned = phone.replace(/[^\d+]/g, "");
  
  if (!cleaned.startsWith("+")) {
    if (cleaned.length === 10) {
      cleaned = "+91" + cleaned;
    } else if (cleaned.length === 12 && cleaned.startsWith("91")) {
      cleaned = "+" + cleaned;
    }
  }
  return cleaned;
}

interface TwilioResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  isMocked: boolean;
}

/**
 * Sends a WhatsApp message using Twilio WhatsApp API
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  mediaUrl?: string
): Promise<TwilioResponse> {
  const formattedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${formatPhoneNumber(to)}`;
  const formattedFrom = whatsappFrom.startsWith("whatsapp:") ? whatsappFrom : `whatsapp:${whatsappFrom}`;

  if (!client) {
    console.log(`[MOCK WHATSAPP] Sending to: ${formattedTo}, From: ${formattedFrom}`);
    console.log(`[MOCK WHATSAPP] Body: ${body}`);
    if (mediaUrl) console.log(`[MOCK WHATSAPP] Media: ${mediaUrl}`);
    return {
      success: true,
      messageId: `mock-wa-msg-${Math.random().toString(36).substr(2, 9)}`,
      isMocked: true,
    };
  }

  try {
    const messageOptions: any = {
      from: formattedFrom,
      to: formattedTo,
      body: body,
    };

    if (mediaUrl) {
      messageOptions.mediaUrl = [mediaUrl];
    }

    const message = await client.messages.create(messageOptions);
    return {
      success: true,
      messageId: message.sid,
      isMocked: false,
    };
  } catch (err: any) {
    console.error("Twilio sendWhatsAppMessage error:", err);
    return {
      success: false,
      error: err.message || String(err),
      isMocked: false,
    };
  }
}

/**
 * Sends an SMS message using Twilio SMS API
 */
export async function sendSMSMessage(to: string, body: string): Promise<TwilioResponse> {
  const formattedTo = formatPhoneNumber(to);

  if (!client || !smsFrom) {
    console.log(`[MOCK SMS] Sending to: ${formattedTo}, From: ${smsFrom || "MOCK_SENDER"}`);
    console.log(`[MOCK SMS] Body: ${body}`);
    return {
      success: true,
      messageId: `mock-sms-msg-${Math.random().toString(36).substr(2, 9)}`,
      isMocked: true,
    };
  }

  try {
    const message = await client.messages.create({
      from: smsFrom,
      to: formattedTo,
      body: body,
    });
    return {
      success: true,
      messageId: message.sid,
      isMocked: false,
    };
  } catch (err: any) {
    console.error("Twilio sendSMSMessage error:", err);
    return {
      success: false,
      error: err.message || String(err),
      isMocked: false,
    };
  }
}
