require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 3000;
const FOLLOWUP_MINUTES = parseInt(process.env.FOLLOWUP_MINUTES) || 3;
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886';
const DEMO_TO = process.env.DEMO_TO;

// Twilio client for outbound messages
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Phala RedPill API client (OpenAI-compatible)
const openai = new OpenAI({
    apiKey: process.env.REDPILL_API_KEY,
    baseURL: 'https://api.redpill.ai/v1',
});

// =============================================================================
// IN-MEMORY STATE (single user for demo)
// =============================================================================

let state = {
    lastInboundAt: null,      // Date when user last messaged
    lastOutboundAt: null,     // Date when we last sent a message
    category: 'warm',         // hot | warm | cold
    stage: 'greeting',        // greeting | discovery | followup
    notes: '',                // Short summary of conversation
    dncFlag: false,           // Do Not Contact flag
    followUpCount: 0,         // Number of follow-ups sent
    conversationHistory: [],  // Chat history for OpenAI context
};

function resetState() {
    state = {
        lastInboundAt: null,
        lastOutboundAt: null,
        category: 'warm',
        stage: 'greeting',
        notes: '',
        dncFlag: false,
        followUpCount: 0,
        conversationHistory: [],
    };
    console.log('🔄 State reset');
}

// Follow-up limits per category
const FOLLOWUP_LIMITS = {
    hot: 8,
    warm: 5,
    cold: 3,
};

// =============================================================================
// OPENAI - INSURANCE AGENT PERSONA
// =============================================================================

const SYSTEM_PROMPT = `You are Sarah, a friendly insurance advisor based in KL. You chat like a normal Malaysian, mix of English with occasional Malay words.

IMPORTANT RULES:
- Sound like a real Malaysian texting a friend, NOT like AI
- NEVER say "As an AI", "I'm here to help", "How can I assist you" or any robotic stuff
- Keep replies SHORT, 1-2 sentences max, like WhatsApp chat
- Use casual Malaysian English: "lah", "kan", "eh", "ya", "okay"
- Occasional emoji is fine but don't overdo

EXAMPLES OF HOW YOU SHOULD SOUND:
- "Eh hello! You looking for insurance coverage ah?"
- "Wah that's a good question lah"
- "Okay okay, family coverage ya? Got kids?"
- "Actually this plan quite popular one"
- "Can can, let me check for you"

WHEN LEAD SEEMS HESITANT OR SAYS NO:
- Don't give up easily! Gently highlight why insurance is important
- Mention real scenarios: "FD ok lah, but kalau emergency hospital bills? That one can wipe out savings fast"
- Be friendly but plant seeds: "No rush ah, just something to think about"
- Offer value: "Eh you know what, let me send you one comparison, FD vs insurance returns. Free info only!"
- Ask what's the real concern: budget? timing? trust?

CONVERSATION FLOW:
1. First message, casual greeting, ask what kind of coverage they want
2. Follow up, understand their situation (family? budget? timeline?)
3. If hesitant, gently educate on insurance value, don't just accept "no"
4. If interested, offer to arrange a call or send more info

DON'T:
- Give up when they say no or later
- Sound formal or corporate
- Use big words or jargon
- Write long paragraphs

Remember: You're Sarah, a persistent but friendly Malaysian insurance agent. Don't let leads slip away easily!`;

async function generateResponse(userMessage, isFollowUp = false) {
    try {
        // Add user message to history
        if (!isFollowUp) {
            state.conversationHistory.push({
                role: 'user',
                content: userMessage,
            });
        }

        // Build context message about current state
        const contextMessage = `[INTERNAL CONTEXT - Current lead status: ${state.category.toUpperCase()}, Stage: ${state.stage}, Notes: ${state.notes || 'none'}${isFollowUp ? ', This is a FOLLOW-UP message' : ''}]`;

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: contextMessage },
            ...state.conversationHistory.slice(-10), // Keep last 10 messages for context
        ];

        if (isFollowUp) {
            messages.push({
                role: 'user',
                content: '[Generate a short, friendly follow-up message based on the conversation history and lead status. Keep it to 1-2 sentences.]',
            });
        }

        const completion = await openai.chat.completions.create({
            model: 'openai/gpt-oss-20b',
            messages,
            max_tokens: 300,
            temperature: 0.8,
        });

        const reply = completion.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            console.error('❌ API returned empty response:', JSON.stringify(completion));
            return "Eh sorry, connection issue kejap. Apa you cakap tadi?";
        }

        // Add assistant reply to history
        state.conversationHistory.push({
            role: 'assistant',
            content: reply,
        });

        // Analyze and update category
        await analyzeAndUpdateCategory(userMessage);

        return reply;
    } catch (error) {
        console.error('❌ OpenAI error:', error.message);
        return "Hey! Sorry, had a quick tech hiccup on my end. What were you saying? 😊";
    }
}

async function analyzeAndUpdateCategory(userMessage) {
    const lowerMsg = userMessage.toLowerCase();

    // Hot signals
    const hotKeywords = ['quote', 'price', 'premium', 'cost', 'buy', 'purchase', 'proceed', 'call me', 'sign up', 'ready', 'how much', 'let\'s do it'];
    if (hotKeywords.some(kw => lowerMsg.includes(kw))) {
        if (state.category !== 'hot') {
            state.category = 'hot';
            console.log('🔥 Lead upgraded to HOT');
        }
        return;
    }

    // Cold signals
    const coldKeywords = ['not interested', 'no thanks', 'later', 'maybe', 'busy', 'don\'t need', 'already have'];
    if (coldKeywords.some(kw => lowerMsg.includes(kw))) {
        if (state.category !== 'cold') {
            state.category = 'cold';
            console.log('❄️ Lead downgraded to COLD');
        }
        return;
    }

    // Warm signals (default escalation path)
    const warmKeywords = ['interested', 'comparing', 'options', 'benefits', 'tell me more', 'curious', 'thinking'];
    if (warmKeywords.some(kw => lowerMsg.includes(kw))) {
        if (state.category === 'cold') {
            state.category = 'warm';
            console.log('🌡️ Lead upgraded to WARM');
        }
    }
}

// =============================================================================
// EXPRESS SERVER & WEBHOOK
// =============================================================================

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        state: {
            category: state.category,
            stage: state.stage,
            dncFlag: state.dncFlag,
            followUpCount: state.followUpCount,
            lastInboundAt: state.lastInboundAt,
        },
    });
});

// Twilio WhatsApp webhook
app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body?.trim() || '';
    const from = req.body.From;

    console.log(`\n📩 Incoming from ${from}: "${incomingMsg}"`);

    // Handle commands
    const lowerMsg = incomingMsg.toLowerCase();

    if (lowerMsg === 'reset') {
        resetState();
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message("Fresh start! 👋 Hey there! I'm Sarah from SecureLife. Looking for the right insurance coverage? I'd love to help - what's most important to you right now, protecting your family or building savings?");
        state.lastInboundAt = new Date();
        state.lastOutboundAt = new Date();
        return res.type('text/xml').send(twiml.toString());
    }

    if (lowerMsg === 'stop') {
        state.dncFlag = true;
        console.log('🛑 DNC flag set - stopping all follow-ups');
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message("No problem at all! I've noted that down. If you ever need insurance advice in the future, just text me anytime. Take care! 👋");
        return res.type('text/xml').send(twiml.toString());
    }

    // Update timestamps
    state.lastInboundAt = new Date();
    state.dncFlag = false; // Reset DNC if they message again

    // Update stage
    if (state.stage === 'greeting') {
        state.stage = 'discovery';
    }

    // Generate AI response
    const reply = await generateResponse(incomingMsg);

    // Update notes with summary
    state.notes = `Last msg: "${incomingMsg.substring(0, 50)}${incomingMsg.length > 50 ? '...' : ''}"`;

    // Send TwiML response (instant reply)
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    state.lastOutboundAt = new Date();

    console.log(`📤 Reply: "${reply}"`);
    console.log(`📊 State: ${state.category.toUpperCase()} | Stage: ${state.stage} `);

    res.type('text/xml').send(twiml.toString());
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🤖 WhatsApp Insurance Bot - Ready!                        ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                      ║
║  Webhook: POST / whatsapp                              ║
║  Demo number:   ${DEMO_TO || 'Not set'}
╚════════════════════════════════════════════════════════════╝

WhatsApp commands: "reset"(start fresh) | "stop"(opt out)

Setup:
1. ngrok http ${PORT}
2. Set Twilio webhook to: https://<ngrok-url>/whatsapp
3. Send a WhatsApp message!
    `);
});

