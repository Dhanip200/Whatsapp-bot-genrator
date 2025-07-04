// server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');
const { ChatOpenAI } = require('@langchain/openai');
require('dotenv').config();

const app = express();
const PORT = 3000;
const publicPath = path.join(__dirname, 'public');
const sessions = {};

const SESSION_TIMEOUT = 1000 * 60 * 30; // 30 minutes

if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath);

app.use(express.static(publicPath));
app.use(express.json());

const openai = new ChatOpenAI({
  modelName: 'gpt-3.5-turbo',
  temperature: 0.7,
  openAIApiKey: process.env.OPENAI_API_KEY,
});

// Auto close session
function autoCloseSession(sessionId) {
  setTimeout(() => {
    if (sessions[sessionId]) {
      sessions[sessionId].client.destroy();
      delete sessions[sessionId];
      console.log(`🧹 Session ${sessionId} auto-closed due to inactivity.`);
    }
  }, SESSION_TIMEOUT);
}

// Create new session
app.get('/session/new', async (req, res) => {
  const sessionId = uuidv4();
  const qrPath = path.join(publicPath, `qr-${sessionId}.png`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      executablePath: puppeteer.executablePath(),
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  sessions[sessionId] = {
    client,
    prompt: 'You are a helpful assistant.',
    qrPath,
    users: {}
  };

  client.on('qr', qr => {
    qrcode.toFile(qrPath, qr, { width: 300 }, err => {
      if (err) console.error('❌ Failed to save QR:', err);
    });
  });

  client.on('ready', () => {
    console.log(`✅ ${sessionId} is ready!`);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
  });

  client.on('disconnected', () => {
    console.log(`❌ ${sessionId} disconnected.`);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
    delete sessions[sessionId];
  });

  client.on('message', async message => {
    const text = message.body;
    const chat = await message.getChat();
    if (!text || chat.isGroup) return;

    const session = sessions[sessionId];
    const userId = message.from;

    if (!session.users[userId]) {
      session.users[userId] = { history: [] };
    }

    const userHistory = session.users[userId].history;
    userHistory.push({ role: 'user', content: text });

    const context = [
      { role: 'system', content: session.prompt },
      ...userHistory.slice(-10)
    ];

    try {
      const response = await openai.call(context);
      const reply = response.content;

      userHistory.push({ role: 'assistant', content: reply });
      await session.client.sendMessage(message.from, reply);
    } catch (err) {
      console.error('🔴 OpenAI error:', err);
      await session.client.sendMessage(message.from, '⚠️ Sorry, something went wrong.');
    }
  });

  client.initialize();
  autoCloseSession(sessionId);

  res.redirect(`/session/${sessionId}`);
});

// Serve session HTML
app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve QR code image
app.get('/qr/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session || !fs.existsSync(session.qrPath)) return res.status(404).send('QR not found');
  res.sendFile(session.qrPath);
});

// Serve QR code as base64
app.get('/qr/:id/base64', (req, res) => {
  const session = sessions[req.params.id];
  if (!session || !fs.existsSync(session.qrPath)) return res.status(404).json({ error: 'QR not found' });
  const qrBuffer = fs.readFileSync(session.qrPath);
  res.json({ base64: `data:image/png;base64,${qrBuffer.toString('base64')}` });
});

// Set system prompt
app.post('/session/:id/set-prompt', (req, res) => {
  const { id } = req.params;
  const { prompt } = req.body;
  if (!sessions[id]) return res.status(404).json({ message: 'Session not found' });
  sessions[id].prompt = prompt;
  res.json({ message: 'Prompt updated' });
});

// Clear user history
app.post('/session/:id/clear-history/:userId', (req, res) => {
  const { id, userId } = req.params;
  if (!sessions[id] || !sessions[id].users[userId]) {
    return res.status(404).json({ message: 'Session or user not found' });
  }
  sessions[id].users[userId].history = [];
  res.json({ message: 'User history cleared' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  for (const id in sessions) {
    await sessions[id].client.destroy();
  }
  process.exit(0);
});

app.listen(PORT, () => console.log(`🌐 Server running: http://localhost:${PORT}`));
