/**
 * Firebase Cloud Functions — LINE OA Calendar Webhook + Scheduler
 *
 * ENV vars required (set via `firebase functions:config:set` or .env):
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const line = require("@line/bot-sdk");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// LINE config – pulled from Firebase environment config
// ---------------------------------------------------------------------------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || functions.config().line?.channel_secret || "",
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || functions.config().line?.channel_access_token || "",
};
const LINE_USER_ID = process.env.LINE_USER_ID || functions.config().line?.user_id || "";

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

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
  // Returns a Date object set to Bangkok midnight
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

  // Relative: วันนี้ / today
  if (/วันนี้|today/i.test(text)) return fmt(today);

  // Relative: พรุ่งนี้ / tomorrow
  if (/พรุ่งนี้|tomorrow/i.test(text)) {
    today.setDate(today.getDate() + 1);
    return fmt(today);
  }

  // Relative: มะรืนนี้ / day after tomorrow
  if (/มะรืนนี้|day after tomorrow/i.test(text)) {
    today.setDate(today.getDate() + 2);
    return fmt(today);
  }

  // Thai day names
  for (const [k, v] of Object.entries(THAI_DAYS)) {
    if (text.includes(k)) return fmt(nextWeekday(v));
  }

  // English day names
  for (const [k, v] of Object.entries(EN_DAYS)) {
    const re = new RegExp(`\\b${k}\\b`, "i");
    if (re.test(text)) return fmt(nextWeekday(v));
  }

  // DD Thai-month pattern: 28 มี.ค.
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

  // DD English-month or English-month DD
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

  // ISO-ish: YYYY-MM-DD or DD/MM/YYYY or DD-MM-YYYY
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const dmy = text.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;

  // เย็นนี้ / เช้านี้ / บ่ายนี้  → today
  if (/เย็นนี้|เช้านี้|บ่ายนี้|tonight/i.test(text)) return fmt(today);

  return null; // could not parse
}

function parseTime(text) {
  // 24h: 14:00, 09:30
  const t24 = text.match(/(\d{1,2}):(\d{2})/);
  if (t24) {
    const h = parseInt(t24[1], 10);
    const m = t24[2];
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:${m}`;
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

  // ทุ่ม: สองทุ่ม → 20:00 (ทุ่ม = 19 + N)
  const thum = text.match(/(\d{1,2})\s*ทุ่ม/);
  if (thum) {
    const h = parseInt(thum[1], 10) + 18;
    return `${String(Math.min(h, 23)).padStart(2, "0")}:00`;
  }

  // เที่ยง
  if (/เที่ยง/.test(text)) return "12:00";

  // เย็นนี้ default
  if (/เย็นนี้/.test(text)) return "18:00";

  // เช้านี้ default
  if (/เช้านี้/.test(text)) return "08:00";

  return null;
}

function parseNote(text) {
  // note: ..., memo: ..., หมายเหตุ: ...
  const m = text.match(/(?:note|memo|หมายเหตุ|📝)\s*[:：]\s*(.+)/i);
  if (m) return m[1].trim();
  return "";
}

function guessCategory(text) {
  const lower = text.toLowerCase();
  if (/ประชุม|meeting|งาน|work|deadline|ส่งรายงาน|report|slide|เรียน|สัมมนา/.test(lower)) return "work";
  if (/ออกกำลังกาย|gym|วิ่ง|run|yoga|health|หมอ|doctor|ยา/.test(lower)) return "health";
  if (/เพื่อน|friend|ปาร์ตี้|party|สังสรรค์|hangout|social/.test(lower)) return "social";
  if (/ซื้อ|buy|ซ่อม|fix|จ่าย|pay|ธนาคาร|bank|errand|ธุระ/.test(lower)) return "errands";
  return "personal";
}

function extractTitle(text) {
  // Remove known note/date/time fragments, keep what remains as title
  let title = text
    .replace(/(?:note|memo|หมายเหตุ|📝)\s*[:：]\s*.+/i, "")
    .replace(/(?:remind\s*(?:me)?)\s*[:：]?\s*/i, "");

  // Remove time patterns
  title = title.replace(/(\d{1,2}):(\d{2})\s*(am|pm)?/gi, "");
  title = title.replace(/บ่าย\s*(?:\d{1,2}|โมง)/g, "");
  title = title.replace(/เช้า\s*\d{1,2}\s*โมง/g, "");
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

  title = title.replace(/\s+/g, " ").trim();
  return title || "กิจกรรมไม่มีชื่อ";
}

function parseMessage(text) {
  const date = parseDate(text) || fmt(todayBKK());
  const time = parseTime(text) || "09:00";
  const note = parseNote(text);
  const category = guessCategory(text);
  const title = extractTitle(text);

  return { title, date, time, note, category, status: "pending" };
}

// ---------------------------------------------------------------------------
// Completion keywords
// ---------------------------------------------------------------------------
const DONE_KEYWORDS = ["ทำแล้ว", "เสร็จแล้ว", "done", "ok", "✓", "✅", "เสร็จ"];

function isDoneMessage(text) {
  const lower = text.toLowerCase().trim();
  return DONE_KEYWORDS.some((k) => lower.includes(k));
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

  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    console.warn("Invalid signature");
    return res.status(403).send("Forbidden");
  }

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    const text = event.message.text;
    const replyToken = event.replyToken;
    const userId = event.source.userId;

    // Check if it's a "done" message
    if (isDoneMessage(text)) {
      await handleDoneMessage(replyToken);
      continue;
    }

    // Parse as new event (single-user: no userId tracking needed)
    const parsed = parseMessage(text);
    parsed.createdAt = admin.firestore.FieldValue.serverTimestamp();
    parsed.notified = false;
    parsed.reminderCount = 0;
    parsed.lastReminderAt = null;

    const docRef = await db.collection("events").add(parsed);

    const CATEGORY_TH = { work: "งาน", health: "สุขภาพ", personal: "ส่วนตัว", social: "สังคม", errands: "ธุระ" };
    const replyText =
      `📅 บันทึกเรียบร้อย!\n` +
      `📌 ${parsed.title}\n` +
      `📆 วันที่ ${parsed.date}  🕐 เวลา ${parsed.time} น.\n` +
      (parsed.note ? `📝 หมายเหตุ: ${parsed.note}\n` : "") +
      `🏷️ หมวด: ${CATEGORY_TH[parsed.category] || parsed.category}`;

    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: replyText }],
    });
  }

  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Handle "done" reply
// ---------------------------------------------------------------------------
async function handleDoneMessage(replyToken) {
  // Find most recent notified event (single-user, no userId filter)
  const snap = await db
    .collection("events")
    .where("status", "==", "pending")
    .where("notified", "==", true)
    .orderBy("lastReminderAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "ℹ️ ไม่พบกิจกรรมที่รอยืนยัน" }],
    });
    return;
  }

  const doc = snap.docs[0];
  const data = doc.data();

  await doc.ref.update({ status: "done" });

  await lineClient.replyMessage({
    replyToken,
    messages: [
      { type: "text", text: `✅ บันทึกเรียบร้อย: ${data.title} — เสร็จสิ้นแล้ว` },
    ],
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

    // Get all pending events for today
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
      // ── First-time notification (within 30 min before event) ──
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

      // ── Persistent reminder for events with notes (every 30 min) ──
      if (data.notified && data.note && data.status === "pending") {
        const lastReminder = data.lastReminderAt?.toDate?.() || new Date(0);
        const msSinceLast = bkkNow - new Date(lastReminder.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
        const minSinceLast = msSinceLast / 60000;

        if (minSinceLast >= 28) {
          // ~30 min tolerance
          const msg =
            `🔔 เตือนอีกครั้ง: ${data.title}\n` +
            `📝 ${data.note}\n` +
            `✉️ ตอบ "ทำแล้ว" หรือ "done" เพื่อยืนยัน`;

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
  // CORS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  const path = req.path.replace(/^\//, "").split("/");

  try {
    // GET /events?start=YYYY-MM-DD&end=YYYY-MM-DD
    if (req.method === "GET" && path[0] === "events") {
      const { start, end } = req.query;
      let query = db.collection("events").orderBy("date").orderBy("time");
      if (start) query = query.where("date", ">=", start);
      if (end) query = query.where("date", "<=", end);
      const snap = await query.get();
      const events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json(events);
    }

    // POST /events — create
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

    // PUT /events/:id — update
    if (req.method === "PUT" && path[0] === "events" && path[1]) {
      const id = path[1];
      await db.collection("events").doc(id).update(req.body);
      return res.json({ id, ...req.body });
    }

    // DELETE /events/:id
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
