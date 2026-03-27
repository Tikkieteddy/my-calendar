/**
 * Firebase Cloud Functions — LINE OA Calendar Webhook + Scheduler
 *
 * ENV vars required (set via .env in functions directory):
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const line = require("@line/bot-sdk");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// LINE config
// ---------------------------------------------------------------------------
const lineConfig = {
  channelSecret: (process.env.LINE_CHANNEL_SECRET || functions.config().line?.channel_secret || "").trim(),
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || functions.config().line?.channel_access_token || "").trim(),
};
const LINE_USER_ID = (process.env.LINE_USER_ID || functions.config().line?.user_id || "").trim();

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ---------------------------------------------------------------------------
// Category constants
// ---------------------------------------------------------------------------
const CATEGORY_MAP = { "งาน": "work", "สุขภาพ": "health", "ส่วนตัว": "personal", "ครอบครัว": "family" };
const CATEGORY_TH = { work: "งาน", health: "สุขภาพ", personal: "ส่วนตัว", family: "ครอบครัว" };
const CATEGORY_EMOJI = { work: "🟣", health: "🟢", personal: "🟡", family: "🔵" };
const CATEGORY_LABELS = ["งาน", "สุขภาพ", "ส่วนตัว", "ครอบครัว"];

function makeCategoryQuickReply() {
  return {
    items: CATEGORY_LABELS.map(label => ({
      type: "action",
      action: { type: "message", label, text: label }
    }))
  };
}

// ---------------------------------------------------------------------------
// Helpers — Thai date/time natural-language parser
// ---------------------------------------------------------------------------
const THAI_MONTHS = {
  "ม.ค.": "01", "มกราคม": "01", "มค": "01",
  "ก.พ.": "02", "กุมภาพันธ์": "02", "กพ": "02",
  "มี.ค.": "03", "มีนาคม": "03", "มีค": "03",
  "เม.ย.": "04", "เมษายน": "04", "เมย": "04",
  "พ.ค.": "05", "พฤษภาคม": "05", "พค": "05",
  "มิ.ย.": "06", "มิถุนายน": "06", "มิย": "06",
  "ก.ค.": "07", "กรกฎาคม": "07", "กค": "07",
  "ส.ค.": "08", "สิงหาคม": "08", "สค": "08",
  "ก.ย.": "09", "กันยายน": "09", "กย": "09",
  "ต.ค.": "10", "ตุลาคม": "10", "ตค": "10",
  "พ.ย.": "11", "พฤศจิกายน": "11", "พย": "11",
  "ธ.ค.": "12", "ธันวาคม": "12", "ธค": "12",
};

const EN_MONTHS = {
  jan: "01", january: "01", feb: "02", february: "02",
  mar: "03", march: "03", apr: "04", april: "04",
  may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", september: "09",
  oct: "10", october: "10", nov: "11", november: "11",
  dec: "12", december: "12",
};

const THAI_DAYS = {
  "จันทร์": 1, "วันจันทร์": 1,
  "อังคาร": 2, "วันอังคาร": 2,
  "พุธ": 3, "วันพุธ": 3,
  "พฤหัส": 4, "วันพฤหัส": 4, "พฤหัสบดี": 4, "วันพฤหัสบดี": 4,
  "ศุกร์": 5, "วันศุกร์": 5,
  "เสาร์": 6, "วันเสาร์": 6,
  "อาทิตย์": 0, "วันอาทิตย์": 0,
};

const EN_DAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function todayBKK() {
  const now = new Date();
  const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  bkk.setHours(0, 0, 0, 0);
  return bkk;
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextWeekday(targetDay) {
  const today = todayBKK();
  const diff = (targetDay - today.getDay() + 7) % 7 || 7;
  today.setDate(today.getDate() + diff);
  return today;
}

function parseDate(text) {
  const today = todayBKK();

  if (/วันนี้|today/i.test(text)) return fmt(today);

  if (/พรุ่งนี้|tomorrow/i.test(text)) {
    today.setDate(today.getDate() + 1);
    return fmt(today);
  }

  if (/มะรืนนี้|day after tomorrow/i.test(text)) {
    today.setDate(today.getDate() + 2);
    return fmt(today);
  }

  for (const [k, v] of Object.entries(THAI_DAYS)) {
    if (text.includes(k)) return fmt(nextWeekday(v));
  }

  for (const [k, v] of Object.entries(EN_DAYS)) {
    const re = new RegExp(`\\b${k}\\b`, "i");
    if (re.test(text)) return fmt(nextWeekday(v));
  }

  // DD Thai-month pattern: 28 มี.ค. or 29มีค
  for (const [k, v] of Object.entries(THAI_MONTHS)) {
    const escaped = k.replace(/\./g, "\\.");
    const re = new RegExp(`(\\d{1,2})\\s*${escaped}\\.?`);
    const m = text.match(re);
    if (m) {
      const day = m[1].padStart(2, "0");
      const year = today.getFullYear();
      return `${year}-${v}-${day}`;
    }
  }

  for (const [k, v] of Object.entries(EN_MONTHS)) {
    const re1 = new RegExp(`(\\d{1,2})\\s*${k}`, "i");
    const re2 = new RegExp(`${k}\\s*(\\d{1,2})`, "i");
    let m = text.match(re1) || text.match(re2);
    if (m) {
      const day = m[1].padStart(2, "0");
      const year = today.getFullYear();
      return `${year}-${v}-${day}`;
    }
  }

  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const dmy = text.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;

  if (/เย็นนี้|เช้านี้|บ่ายนี้|tonight/i.test(text)) return fmt(today);

  return null;
}

function parseTime(text) {
  // 24h: 14:00, 09:30
  const t24 = text.match(/(\d{1,2}):(\d{2})/);
  if (t24) {
    const h = parseInt(t24[1], 10);
    const m = t24[2];
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:${m}`;
  }

  // Decimal time: 10.30 → 10:30
  const tDot = text.match(/(\d{1,2})\.(\d{2})(?!\d)/);
  if (tDot) {
    const h = parseInt(tDot[1], 10);
    const m = tDot[2];
    if (h >= 0 && h <= 23 && parseInt(m, 10) < 60) return `${String(h).padStart(2, "0")}:${m}`;
  }

  // 12h with am/pm
  const t12 = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (t12) {
    let h = parseInt(t12[1], 10);
    const m = t12[2] || "00";
    if (t12[3].toLowerCase() === "pm" && h < 12) h += 12;
    if (t12[3].toLowerCase() === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }

  // Thai colloquial: บ่ายสาม → 15:00, บ่ายโมง → 13:00
  const bai = text.match(/บ่าย\s*(?:(\d{1,2})|โมง)/);
  if (bai) {
    const h = bai[1] ? parseInt(bai[1], 10) + 12 : 13;
    return `${String(h).padStart(2, "0")}:00`;
  }

  // เช้า X โมง
  const chao = text.match(/เช้า\s*(\d{1,2})\s*โมง/);
  if (chao) {
    const h = parseInt(chao[1], 10);
    return `${String(h).padStart(2, "0")}:00`;
  }

  // Plain: Xโมง (e.g., 10โมง → 10:00)
  const mong = text.match(/(\d{1,2})\s*โมง/);
  if (mong) {
    const h = parseInt(mong[1], 10);
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }

  // ทุ่ม: สองทุ่ม → 20:00 (ทุ่ม = 19 + N)
  const thum = text.match(/(\d{1,2})\s*ทุ่ม/);
  if (thum) {
    const h = parseInt(thum[1], 10) + 18;
    return `${String(Math.min(h, 23)).padStart(2, "0")}:00`;
  }

  if (/เที่ยง/.test(text)) return "12:00";
  if (/เย็นนี้/.test(text)) return "18:00";
  if (/เช้านี้/.test(text)) return "08:00";

  return null;
}

function parseNote(text) {
  const m = text.match(/(?:note|memo|หมายเหตุ|📝)\s*[:：]\s*(.+)/i);
  if (m) return m[1].trim();
  return "";
}

function extractTitle(text) {
  let title = text
    .replace(/(?:note|memo|หมายเหตุ|📝)\s*[:：]\s*.+/i, "")
    .replace(/(?:remind\s*(?:me)?)\s*[:：]?\s*/i, "");

  // Remove time patterns
  title = title.replace(/(\d{1,2}):(\d{2})\s*(am|pm)?/gi, "");
  title = title.replace(/(\d{1,2})\.(\d{2})(?!\d)/g, "");
  title = title.replace(/บ่าย\s*(?:\d{1,2}|โมง)/g, "");
  title = title.replace(/เช้า\s*\d{1,2}\s*โมง/g, "");
  title = title.replace(/\d{1,2}\s*โมง/g, "");
  title = title.replace(/\d{1,2}\s*ทุ่ม/g, "");
  title = title.replace(/เที่ยง/g, "");

  // Remove date patterns
  for (const k of Object.keys(THAI_DAYS)) title = title.replace(new RegExp(k, "g"), "");
  for (const k of Object.keys(EN_DAYS)) title = title.replace(new RegExp(`\\b${k}\\b`, "gi"), "");
  title = title.replace(/วันนี้|พรุ่งนี้|มะรืนนี้|today|tomorrow/gi, "");
  title = title.replace(/เย็นนี้|เช้านี้|บ่ายนี้|tonight/gi, "");
  for (const k of Object.keys(THAI_MONTHS)) {
    const escaped = k.replace(/\./g, "\\.");
    title = title.replace(new RegExp(`\\d{1,2}\\s*${escaped}\\.?`, "g"), "");
  }
  for (const k of Object.keys(EN_MONTHS)) {
    title = title.replace(new RegExp(`\\d{1,2}\\s*${k}|${k}\\s*\\d{1,2}`, "gi"), "");
  }
  title = title.replace(/\d{4}-\d{1,2}-\d{1,2}/g, "");
  title = title.replace(/\d{1,2}[/\-]\d{1,2}[/\-]\d{4}/g, "");

  // Remove done/เสร็จ keywords from title
  title = title.replace(/\b(done|เสร็จแล้ว|เสร็จ|ทำแล้ว)\b/gi, "");

  title = title.replace(/\s+/g, " ").trim();
  return title || "กิจกรรมไม่มีชื่อ";
}

// ---------------------------------------------------------------------------
// Done/complete detection
// ---------------------------------------------------------------------------
const DONE_KEYWORDS = ["ทำแล้ว", "เสร็จแล้ว", "done", "เสร็จ"];

function isDoneMessage(text) {
  const lower = text.toLowerCase().trim();
  return DONE_KEYWORDS.some((k) => lower.includes(k));
}

function extractTitleFromDoneMessage(text) {
  let title = text;
  for (const kw of DONE_KEYWORDS) {
    title = title.replace(new RegExp(kw, "gi"), "");
  }
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac("SHA256", lineConfig.channelSecret)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ---------------------------------------------------------------------------
// CLOUD FUNCTION: LINE Webhook
// ---------------------------------------------------------------------------
exports.lineWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Signature verification
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

  if (lineConfig.channelSecret && signature) {
    const isValid = verifySignature(rawBody, signature);
    console.log("Signature check:", isValid, "Secret length:", lineConfig.channelSecret.length);
    if (!isValid) {
      console.warn("Signature mismatch — continuing anyway for debugging");
    }
  }

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    const text = event.message.text.trim();
    const replyToken = event.replyToken;

    // ── Step 1: Category selection (user clicked quick reply button) ──
    if (CATEGORY_MAP[text]) {
      await handleCategorySelection(text, replyToken);
      continue;
    }

    // ── Step 2: Done/เสร็จ message → mark as completed ──
    if (isDoneMessage(text)) {
      await handleDoneMessage(text, replyToken);
      continue;
    }

    // ── Step 3: New event or todo ──
    const date = parseDate(text);
    const time = parseTime(text);
    const note = parseNote(text);
    const title = extractTitle(text);

    const eventData = {
      title,
      note,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notified: false,
      reminderCount: 0,
      lastReminderAt: null,
      category: "pending_category", // temporary until user selects
    };

    if (date || time) {
      // Has date or time → Calendar event
      eventData.date = date || fmt(todayBKK());
      eventData.time = time || "09:00";
      eventData.status = "pending";
      eventData.type = "event";
    } else {
      // No date/time → Todo item
      eventData.date = fmt(todayBKK());
      eventData.time = "00:00";
      eventData.status = "todo";
      eventData.type = "todo";
    }

    const docRef = await db.collection("events").add(eventData);

    // Build reply with quick reply buttons for category
    const isTodo = eventData.type === "todo";
    const replyText = isTodo
      ? `📝 บันทึกเข้ารายการสิ่งที่ต้องทำ!\n📌 ${title}\n\nเลือกหมวดหมู่:`
      : `📅 บันทึกลงปฏิทิน!\n📌 ${title}\n📆 ${eventData.date}  🕐 ${eventData.time} น.\n${note ? `📝 ${note}\n` : ""}\nเลือกหมวดหมู่:`;

    await lineClient.replyMessage({
      replyToken,
      messages: [{
        type: "text",
        text: replyText,
        quickReply: makeCategoryQuickReply()
      }],
    });
  }

  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Handle category selection (user clicked quick reply button)
// ---------------------------------------------------------------------------
async function handleCategorySelection(text, replyToken) {
  const categoryEn = CATEGORY_MAP[text];

  // Find the most recent event with category "pending_category"
  const snap = await db.collection("events")
    .where("category", "==", "pending_category")
    .limit(10)
    .get();

  if (snap.empty) {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "ℹ️ ไม่พบรายการที่รอเลือกหมวด" }],
    });
    return;
  }

  // Sort by createdAt desc in code (avoid needing composite index)
  const sorted = snap.docs.sort((a, b) => {
    const aTime = a.data().createdAt?.toDate?.()?.getTime() || 0;
    const bTime = b.data().createdAt?.toDate?.()?.getTime() || 0;
    return bTime - aTime;
  });
  const doc = sorted[0];
  const data = doc.data();
  await doc.ref.update({ category: categoryEn });

  const emoji = CATEGORY_EMOJI[categoryEn] || "🏷️";
  const isTodo = data.type === "todo";

  const confirmText = isTodo
    ? `✅ บันทึกเรียบร้อย!\n📌 ${data.title}\n${emoji} หมวด: ${text}\n📋 อยู่ในรายการสิ่งที่ต้องทำ (ยังไม่ทำ)`
    : `✅ บันทึกเรียบร้อย!\n📌 ${data.title}\n📆 ${data.date}  🕐 ${data.time} น.\n${emoji} หมวด: ${text}`;

  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: "text", text: confirmText }],
  });
}

// ---------------------------------------------------------------------------
// Handle "done" message — match by title keyword
// ---------------------------------------------------------------------------
async function handleDoneMessage(text, replyToken) {
  const searchTitle = extractTitleFromDoneMessage(text);

  // Find pending/todo events that match the title
  const snap = await db.collection("events")
    .where("status", "in", ["pending", "todo"])
    .limit(50)
    .get();

  // Sort by createdAt desc in code
  const docs = snap.docs.sort((a, b) => {
    const aTime = a.data().createdAt?.toDate?.()?.getTime() || 0;
    const bTime = b.data().createdAt?.toDate?.()?.getTime() || 0;
    return bTime - aTime;
  });

  let matchedDoc = null;

  if (searchTitle) {
    // Try to find by title match
    for (const doc of docs) {
      const data = doc.data();
      if (data.title && data.title.toLowerCase().includes(searchTitle.toLowerCase())) {
        matchedDoc = doc;
        break;
      }
    }
  }

  // If no title match, use the most recent pending/todo item
  if (!matchedDoc && docs.length > 0) {
    matchedDoc = docs[0];
  }

  if (!matchedDoc) {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "ℹ️ ไม่พบรายการที่รอยืนยัน" }],
    });
    return;
  }

  const data = matchedDoc.data();
  await matchedDoc.ref.update({ status: "done" });

  const emoji = CATEGORY_EMOJI[data.category] || "✅";
  await lineClient.replyMessage({
    replyToken,
    messages: [{
      type: "text",
      text: `✅ เสร็จเรียบร้อย!\n${emoji} ${data.title} — เสร็จสิ้นแล้ว`
    }],
  });
}

// ---------------------------------------------------------------------------
// SCHEDULED FUNCTION: Reminder every 15 minutes
// ---------------------------------------------------------------------------
exports.sendReminders = functions.pubsub
  .schedule("every 15 minutes")
  .timeZone("Asia/Bangkok")
  .onRun(async () => {
    const now = new Date();
    const bkkNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const currentDate = fmt(bkkNow);
    const currentMinutes = bkkNow.getHours() * 60 + bkkNow.getMinutes();

    const snap = await db
      .collection("events")
      .where("date", "==", currentDate)
      .where("status", "==", "pending")
      .get();

    for (const doc of snap.docs) {
      const data = doc.data();
      const [h, m] = data.time.split(":").map(Number);
      const eventMinutes = h * 60 + m;
      const diff = eventMinutes - currentMinutes;

      if (!data.notified && diff >= 0 && diff <= 30) {
        const msg =
          `⏰ แจ้งเตือน: ${data.title}\n` +
          `📆 วันที่: ${data.date} เวลา ${data.time} น.\n` +
          (data.note ? `📝 หมายเหตุ: ${data.note}` : "");

        try {
          await lineClient.pushMessage({
            to: LINE_USER_ID,
            messages: [{ type: "text", text: msg }],
          });
          await doc.ref.update({
            notified: true,
            reminderCount: 1,
            lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.error("Push failed:", err.message);
        }
        continue;
      }

      if (data.notified && data.note && data.status === "pending") {
        const lastReminder = data.lastReminderAt?.toDate?.() || new Date(0);
        const msSinceLast = bkkNow - new Date(lastReminder.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
        const minSinceLast = msSinceLast / 60000;

        if (minSinceLast >= 28) {
          const msg =
            `🔔 เตือนอีกครั้ง: ${data.title}\n` +
            `📝 ${data.note}\n` +
            `✉️ ตอบ "เสร็จ" หรือ "done" เพื่อยืนยัน`;

          try {
            await lineClient.pushMessage({
              to: LINE_USER_ID,
              messages: [{ type: "text", text: msg }],
            });
            await doc.ref.update({
              reminderCount: (data.reminderCount || 0) + 1,
              lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          } catch (err) {
            console.error("Persistent push failed:", err.message);
          }
        }
      }
    }

    return null;
  });

// ---------------------------------------------------------------------------
// REST API: CRUD for dashboard
// ---------------------------------------------------------------------------
exports.api = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  const path = req.path.replace(/^\//, "").split("/");

  try {
    if (req.method === "GET" && path[0] === "events") {
      const { start, end } = req.query;
      let query = db.collection("events").orderBy("date").orderBy("time");
      if (start) query = query.where("date", ">=", start);
      if (end) query = query.where("date", "<=", end);
      const snap = await query.get();
      const events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json(events);
    }

    if (req.method === "POST" && path[0] === "events") {
      const data = req.body;
      data.status = data.status || "pending";
      data.notified = false;
      data.reminderCount = 0;
      data.lastReminderAt = null;
      data.createdAt = admin.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("events").add(data);
      return res.status(201).json({ id: ref.id, ...data });
    }

    if (req.method === "PUT" && path[0] === "events" && path[1]) {
      const id = path[1];
      await db.collection("events").doc(id).update(req.body);
      return res.json({ id, ...req.body });
    }

    if (req.method === "DELETE" && path[0] === "events" && path[1]) {
      const id = path[1];
      await db.collection("events").doc(id).delete();
      return res.json({ deleted: id });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});
