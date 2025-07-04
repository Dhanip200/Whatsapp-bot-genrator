// whatsapp-gpt-bot.js

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Show QR code on terminal
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Scan the QR code above with WhatsApp');
});

// Notify when client is ready
client.on('ready', () => {
  console.log('✅ WhatsApp bot is ready!');
});

// System prompt
const systemMessage = {
  role: 'system',
  content: `
You are mimicking the user's personal WhatsApp style.
Reply casually, in lowercase, short and direct. Use informal grammar ("r", "u", "got", "don’t", "coz").
No emojis or formal language. Never say you're an AI.
`
};

// In-memory conversation store (per user)
const userConversations = {}; // { userId: [message1, message2, ...] }

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(media) {
  const filePath = path.join(__dirname, 'voice.ogg');
  fs.writeFileSync(filePath, media.data, { encoding: 'base64' });

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1'
  });

  fs.unlinkSync(filePath); // clean up
  return transcription.text;
}

// Convert text to speech using OpenAI
async function textToSpeech(text, fileName = 'reply.mp3') {
  const mp3Path = path.join(__dirname, fileName);
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'onyx',
    input: text
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  fs.writeFileSync(mp3Path, buffer);
  return mp3Path;
}

// Main message handler
client.on('message', async (message) => {
  try {
    if (message.fromMe) return;

    const userId = message.from;
    let userInput = message.body;
    let isVoiceNote = false;

    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (media && media.mimetype === 'audio/ogg; codecs=opus') {
        console.log('🎙️ Voice message received. Transcribing...');
        userInput = await transcribeAudio(media);
        isVoiceNote = true;
        console.log('📝 Transcription:', userInput);
      }
    }

    // Initialize history if not present
    if (!userConversations[userId]) {
      userConversations[userId] = [systemMessage];
    }

    // Add user message to history
    userConversations[userId].push({
      role: 'user',
      content: userInput
    });

    // Limit history (keep only last 10 messages to control token usage)
    const history = userConversations[userId].slice(-10);

    console.time('⏱️ OpenAI Response Time');
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-0125',
      messages: history,
      max_tokens: 100,
      temperature: 0.7
    });
    console.timeEnd('⏱️ OpenAI Response Time');

    const replyText = gptResponse.choices[0].message.content.trim();

    // Add GPT reply to conversation history
    userConversations[userId].push({
      role: 'assistant',
      content: replyText
    });

    // Send response (as voice if user sent voice)
    if (isVoiceNote) {
      const audioPath = await textToSpeech(replyText);
      const audioData = fs.readFileSync(audioPath, { encoding: 'base64' });
      const media = new MessageMedia('audio/mpeg', audioData, 'reply.mp3');
      await message.reply(media);
      fs.unlinkSync(audioPath);
    } else {
      await message.reply(replyText);
    }

  } catch (err) {
    console.error('❌ Error:', err);
    await message.reply('sorry, something went wrong');
  }
});

// Start bot
client.initialize();
