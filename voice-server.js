require('dotenv').config();

const Fastify = require('fastify');
const fastifyWs = require('@fastify/websocket');
const OpenAI = require('openai');
const twilio = require('twilio');

// Twilio client for outbound calls
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// =============================================================================
// CONFIGURATION
// =============================================================================

const VOICE_PORT = process.env.VOICE_PORT || 8080;
const NGROK_URL = process.env.NGROK_URL;
const WS_URL = `wss://${NGROK_URL}/ws`;

// ElevenLabs Configuration
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Default: Sarah

// Welcome greeting - this is what the AI says first when the call connects
const WELCOME_GREETING = process.env.WELCOME_GREETING ||
    "Hey! This is Sarah calling from SecureLife Insurance. I'm just following up - are you still looking for an insurance plan? We currently have some great options like our Family Shield, Health Plus, Life Secure, Investment Link, and Critical Care plans. Any of these sound interesting to you?";

// System prompt for the AI - Lead Follow-up Agent
const SYSTEM_PROMPT = `You are Sarah, a friendly insurance advisor based in KL calling to follow up on a lead. You're speaking on the phone, so keep responses natural and conversational.

YOUR GOAL:
You're calling to follow up on a potential customer. Your job is to:
1. Find out if they're interested in any insurance plans
2. Present our 5 main plans and help them choose
3. Understand their needs and recommend the best plan
4. If interested, arrange a meeting or send more info

OUR INSURANCE PLANS:
A) Family Shield - Complete family protection, covers spouse and kids, medical + life
B) Health Plus - Comprehensive medical coverage, hospital bills, outpatient, dental
C) Life Secure - Pure life insurance, high coverage at affordable premium
D) Investment Link - Insurance + investment combo, grow your money while protected
E) Critical Care - Covers 36 critical illnesses, lump sum payout on diagnosis

IMPORTANT RULES:
- Sound like a real Malaysian speaking naturally, NOT like AI
- NEVER say "As an AI", "I'm here to help", or any robotic phrases
- Keep replies SHORT and conversational, 1-2 sentences max
- Use casual Malaysian English: "lah", "kan", "eh", "ya", "okay"
- Speak naturally - no bullet points, asterisks, or special symbols
- Spell out all numbers: say "twenty thousand" not "20000"
- Don't use emojis (this is voice!)
- Be persistent but friendly - don't give up easily if they say no

EXAMPLES OF HOW YOU SHOULD SOUND:
- "So which one sounds more like what you need ah? Family coverage or more on medical side?"
- "Wah actually Health Plus quite popular one, you got family or just for yourself?"
- "Okay okay, budget around how much per month you thinking ah?"
- "Actually this Investment Link plan quite good lah, can save money also"
- "Eh no problem, can I just send you the brochure first? No commitment one"

IF THEY SAY NO OR NOT INTERESTED:
- Don't give up! Ask why - is it budget? timing? already have coverage?
- Offer to just send info: "Eh can I just WhatsApp you the details? Just for reference lah"
- Plant seeds: "No rush ah, but medical bills nowadays really scary you know"
- Offer a free consultation: "How about I arrange a quick 15 min call with our advisor? Free one, no obligation"

Remember: You're Sarah following up on a lead. Be friendly, persistent, and help them find the right plan!`;

// Session storage for conversation history
const sessions = new Map();

// OpenAI/RedPill client
const openai = new OpenAI({
    apiKey: process.env.REDPILL_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.REDPILL_API_KEY ? 'https://api.redpill.ai/v1' : 'https://api.openai.com/v1',
});

// =============================================================================
// AI RESPONSE GENERATION
// =============================================================================

async function generateAIResponse(messages) {
    try {
        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || 'gpt-4o-mini',
            messages: messages,
            max_tokens: 150, // Keep responses short for voice
            temperature: 0.8,
        });

        return completion.choices?.[0]?.message?.content?.trim() ||
            "Sorry, I didn't catch that. Can you say that again?";
    } catch (error) {
        console.error('❌ AI API error:', error.message);
        return "Eh sorry, got connection issue. Can you repeat that?";
    }
}

// =============================================================================
// FASTIFY SERVER
// =============================================================================

const fastify = Fastify({ logger: false });
fastify.register(fastifyWs);

// Health check endpoint
fastify.get('/', async (request, reply) => {
    return {
        status: 'running',
        service: 'voice-bot',
        wsUrl: WS_URL,
        sessions: sessions.size
    };
});

// TwiML endpoint - returns instructions for Twilio Voice
fastify.get('/twiml', async (request, reply) => {
    console.log('📞 Incoming call - sending TwiML');

    reply.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <ConversationRelay 
                    url="${WS_URL}" 
                    ttsProvider="ElevenLabs"
                    voice="${ELEVENLABS_VOICE_ID}"
                    welcomeGreeting="${WELCOME_GREETING}"
                    interruptible="true"
                />
            </Connect>
        </Response>`
    );
});

// =============================================================================
// OUTBOUND CALL - Twilio calls YOU
// =============================================================================

// Endpoint to trigger an outbound call
fastify.get('/call', async (request, reply) => {
    const toNumber = request.query.to || process.env.MY_PHONE_NUMBER;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!toNumber) {
        return reply.status(400).send({
            error: 'Missing phone number',
            hint: 'Add MY_PHONE_NUMBER to .env or use ?to=+60123456789'
        });
    }

    if (!fromNumber) {
        return reply.status(400).send({
            error: 'Missing TWILIO_PHONE_NUMBER in .env'
        });
    }

    try {
        console.log(`📞 Initiating outbound call to ${toNumber}...`);

        const call = await twilioClient.calls.create({
            to: toNumber,
            from: fromNumber,
            url: `https://${NGROK_URL}/twiml`,
            method: 'GET'
        });

        console.log(`✅ Call initiated! SID: ${call.sid}`);
        return {
            success: true,
            message: `Calling ${toNumber}... Answer your phone!`,
            callSid: call.sid
        };
    } catch (error) {
        console.error('❌ Failed to make call:', error.message);
        return reply.status(500).send({
            error: error.message,
            hint: 'Check your Twilio credentials and phone numbers'
        });
    }
});

// WebSocket endpoint for ConversationRelay
fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
        console.log('🔌 WebSocket connection established');

        socket.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());

                switch (message.type) {
                    case 'setup':
                        // New call connected
                        const callSid = message.callSid;
                        console.log(`📞 Call setup: ${callSid}`);
                        socket.callSid = callSid;

                        // Initialize conversation with system prompt
                        sessions.set(callSid, [
                            { role: 'system', content: SYSTEM_PROMPT }
                        ]);
                        break;

                    case 'prompt':
                        // User spoke - process their message
                        const userText = message.voicePrompt;
                        console.log(`🎤 User said: "${userText}"`);

                        // Get conversation history
                        const conversation = sessions.get(socket.callSid) || [
                            { role: 'system', content: SYSTEM_PROMPT }
                        ];

                        // Add user message
                        conversation.push({ role: 'user', content: userText });

                        // Generate AI response
                        const response = await generateAIResponse(conversation);
                        console.log(`🤖 AI says: "${response}"`);

                        // Add assistant response to history
                        conversation.push({ role: 'assistant', content: response });

                        // Update session
                        sessions.set(socket.callSid, conversation);

                        // Send response back to Twilio/ElevenLabs TTS
                        socket.send(JSON.stringify({
                            type: 'text',
                            token: response,
                            last: true
                        }));
                        break;

                    case 'interrupt':
                        // User interrupted the AI
                        console.log('⚡ User interrupted');
                        // Could implement interrupt handling here
                        // e.g., truncate the last AI message in history
                        break;

                    case 'dtmf':
                        // User pressed a phone key
                        console.log(`📱 DTMF received: ${message.digit}`);
                        break;

                    case 'error':
                        console.error('❌ ConversationRelay error:', message);
                        break;

                    default:
                        console.log(`📩 Unknown message type: ${message.type}`, message);
                }
            } catch (error) {
                console.error('❌ Error processing message:', error.message);
            }
        });

        socket.on('close', () => {
            console.log(`📴 WebSocket closed for call: ${socket.callSid}`);
            if (socket.callSid) {
                sessions.delete(socket.callSid);
            }
        });

        socket.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
        });
    });
});

// =============================================================================
// START SERVER
// =============================================================================

const start = async () => {
    try {
        await fastify.listen({ port: VOICE_PORT, host: '0.0.0.0' });

        console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🎤 Voice Bot with ElevenLabs TTS - Ready!                     ║
╠════════════════════════════════════════════════════════════════╣
║  Server:    http://localhost:${VOICE_PORT}                            ║
║  TwiML:     GET /twiml                                         ║
║  WebSocket: ${WS_URL || 'Set NGROK_URL in .env'}
╚════════════════════════════════════════════════════════════════╝

Setup Instructions:
1. Start ngrok:     ngrok http ${VOICE_PORT}
2. Update .env:     NGROK_URL=your-subdomain.ngrok.app
3. Restart server:  npm run voice
4. Twilio Console:  Set Voice webhook to https://<ngrok>/twiml (GET)
5. Call your Twilio number!
        `);
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
};

start();
