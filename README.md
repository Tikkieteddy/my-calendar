# 📅 LINE Calendar Dashboard

A personal calendar system that integrates with LINE Official Account. Send events via LINE chat in natural Thai/English, view them on a web dashboard, and receive persistent reminders until you confirm completion.

## Architecture

```
LINE App ──► LINE Webhook (Cloud Function) ──► Firestore
                                                  ▲
Web Dashboard (Firebase Hosting) ◄── real-time ───┘
                                                  │
Scheduler (Cloud Function, every 15 min) ──► LINE Push
```

## Prerequisites

- Node.js 18+
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with Firestore enabled
- A LINE Official Account with Messaging API enabled

## Setup

### 1. LINE Official Account

1. Go to [LINE Developers Console](https://developers.line.biz/)
2. Create a provider → create a **Messaging API** channel
3. Under **Messaging API** tab, issue a **Channel access token (long-lived)**
4. Note your **Channel secret** from the **Basic settings** tab
5. To find your **User ID**: send a message to the OA, check the webhook logs, or find it under **Your user ID** in Basic settings

### 2. Firebase Project

```bash
firebase login
firebase init    # select Firestore, Functions, Hosting
```

### 3. Set Environment Variables

```bash
# Set LINE secrets for Cloud Functions
firebase functions:config:set \
  line.channel_secret="YOUR_CHANNEL_SECRET" \
  line.channel_access_token="YOUR_CHANNEL_ACCESS_TOKEN" \
  line.user_id="YOUR_LINE_USER_ID"
```

### 4. Update Dashboard Config

Edit `index.html` and replace the `firebaseConfig` object with your Firebase project's web config (found in Firebase Console → Project Settings → General → Your apps).

### 5. Deploy

```bash
cd functions && npm install && cd ..
firebase deploy
```

### 6. Set LINE Webhook URL

In the LINE Developers Console, set the Webhook URL to:

```
https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/lineWebhook
```

Enable **Use webhook** and optionally disable **Auto-reply messages**.

### 7. Create Firestore Index

Create a composite index for the reminder query:

- Collection: `events`
- Fields: `userId` (Asc), `status` (Asc), `notified` (Asc), `lastReminderAt` (Desc)

Firebase will prompt you with an index creation link if needed when the function first runs.

## Usage

### Sending Events via LINE

Send natural language messages:

| Message | Parsed Result |
|---|---|
| `ประชุมลูกค้า วันพฤหัส 14:00 note: เตรียม slide` | Thu 14:00, Work |
| `remind me: ส่งรายงาน 28 มี.ค. 09:00` | Mar 28 09:00, Work |
| `เย็นนี้ 18:00 ออกกำลังกาย` | Today 18:00, Health |
| `tomorrow 3pm lunch with team` | Tomorrow 15:00, Social |

### Completing Events

When you receive a reminder, reply with any of:
- `ทำแล้ว`, `เสร็จแล้ว`, `done`, `ok`, `✓`

The system will mark the event as done and stop sending reminders.

### Dashboard

- Click any time slot to add an event
- Click an event card to edit or delete
- Navigate weeks with ◀ ▶ buttons
- Events sync in real-time via Firestore

## File Structure

```
├── index.html              # Dashboard web app
├── firebase.json           # Firebase config (hosting + functions + rewrites)
├── firestore.rules         # Firestore security rules
├── .env.example            # Environment variable template
├── README.md               # This file
└── functions/
    ├── index.js            # Cloud Functions (webhook, scheduler, REST API)
    └── package.json        # Node.js dependencies
```

## Reminder Flow

1. Scheduler runs every 15 minutes
2. Finds events within 30 minutes of their start time → sends first LINE push
3. For events with a `note` field: continues sending reminders every 30 minutes
4. User replies "done" / "ทำแล้ว" → event marked complete, reminders stop
