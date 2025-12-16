# WhatsApp Insurance Agent Demo Bot

A conversational WhatsApp bot that simulates a friendly insurance sales agent, powered by **Twilio WhatsApp Sandbox** and **OpenAI GPT-4o-mini**.

## Features

- 🤖 **Natural conversation** - Powered by OpenAI, responds like a real sales agent
- 📊 **Lead classification** - Automatically categorizes leads as Hot/Warm/Cold
- ⏰ **Smart follow-ups** - Scheduled nudges based on lead temperature
- 🎮 **Demo-friendly** - Configurable timing for quick demonstrations

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | From [Twilio Console](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | From [Twilio Console](https://console.twilio.com) |
| `WHATSAPP_FROM` | Sandbox number: `whatsapp:+14155238886` |
| `DEMO_TO` | Your phone: `whatsapp:+60123456789` |
| `OPENAI_API_KEY` | From [OpenAI Platform](https://platform.openai.com/api-keys) |
| `FOLLOWUP_MINUTES` | Minutes between follow-ups (default: 3) |
| `PORT` | Server port (default: 3000) |

### 3. Start the bot

```bash
npm start
```

---

## Twilio WhatsApp Sandbox Setup

### Step 1: Enable WhatsApp Sandbox

1. Go to [Twilio Console](https://console.twilio.com)
2. Navigate to **Messaging** → **Try it out** → **Send a WhatsApp message**
3. Note your sandbox number and join code

### Step 2: Join the Sandbox

From your WhatsApp:
1. Add the sandbox number to your contacts
2. Send the join message: `join <your-sandbox-code>`
3. Wait for confirmation

### Step 3: Expose Local Server

```bash
# Install ngrok if needed
brew install ngrok

# Start ngrok tunnel
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### Step 4: Configure Webhook

1. In Twilio Console → **Messaging** → **Try it out** → **WhatsApp sandbox settings**
2. Set **"When a message comes in"** to:
   ```
   https://<your-ngrok-url>/whatsapp
   ```
3. Method: **POST**
4. Click **Save**

### Step 5: Test!

Send a message from WhatsApp and watch the magic happen! ✨

---

## Commands

| Command | Action |
|---------|--------|
| `reset` | Clear all state, start fresh conversation |
| `stop` | Set Do-Not-Contact flag, stop all follow-ups |

---

## Behavior

### Lead Classification

The bot automatically classifies leads based on message content:

- **🔥 Hot**: Mentions "quote", "price", "buy", "call me", "proceed"
- **🌡️ Warm**: "interested", "comparing", "benefits", "tell me more"
- **❄️ Cold**: "not interested", "later", "maybe", "busy"

### Follow-up Limits

| Category | Max Follow-ups |
|----------|----------------|
| Hot | 8 |
| Warm | 5 |
| Cold | 3 |

### Follow-up Rules

- Only sends if user has messaged within the last 24 hours
- Respects `FOLLOWUP_MINUTES` gap between messages
- Stops immediately when DNC flag is set
- Never messages first (waits for user to initiate)

---

## API Endpoints

### `GET /`
Health check - returns current bot state

### `POST /whatsapp`
Twilio webhook endpoint for incoming messages

---

## Project Structure

```
whatsapp/
├── index.js        # Main application
├── package.json    # Dependencies
├── .env.example    # Environment template
├── .env            # Your configuration (gitignored)
└── README.md       # This file
```

---

## Logs

The bot logs useful information to the console:

```
📩 Incoming from whatsapp:+60123456789: "Hi, I'm interested in insurance"
📤 Reply: "Hey! Great to hear from you 😊 What kind of coverage..."
📊 State: WARM | Stage: discovery | Follow-ups: 0
⏰ Sending scheduled follow-up...
📤 Follow-up sent: "Hey! Just checking in - any questions about..."
```

---

## License

MIT
