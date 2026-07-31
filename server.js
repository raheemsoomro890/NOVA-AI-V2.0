'use strict';

/* =============================================================
   NOVA-AI-V2.0 — server.js
   Express server: serves the frontend, exposes a secure
   POST /api/chat endpoint proxying Google Gemini, with CORS,
   rate limiting, and centralized error handling.

   The GEMINI_API_KEY is read only from environment variables
   (.env) and is never sent to the client or logged.
============================================================= */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* -------------------------------------------------------------
   1. Environment validation
------------------------------------------------------------- */
const {
  NODE_ENV = 'development',
  PORT = '4000',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-1.5-flash',
  CORS_ORIGIN = '*',
} = process.env;

if (!GEMINI_API_KEY) {
  console.error('[NOVA-AI] FATAL: GEMINI_API_KEY is not set in the environment.');
  process.exit(1);
}

/* -------------------------------------------------------------
   2. Gemini client (server-side only, key never exposed)
------------------------------------------------------------- */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function generateChatReply(message, history = []) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const contents = [
    ...history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.content ?? '') }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const result = await model.generateContent({ contents });
  const response = result?.response;
  const text = typeof response?.text === 'function' ? response.text() : '';

  if (!text) {
    throw new Error('Empty response received from the AI provider.');
  }

  return text;
}

/* -------------------------------------------------------------
   3. App setup
------------------------------------------------------------- */
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json({ limit: '32kb' }));

/* -------------------------------------------------------------
   4. Rate limiting
------------------------------------------------------------- */
const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please slow down and try again shortly.',
  },
});

const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP. Please try again later.',
  },
});

app.use(globalRateLimiter);

/* -------------------------------------------------------------
   5. Static frontend
------------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

/* -------------------------------------------------------------
   6. Validation helpers
------------------------------------------------------------- */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateChatPayload(body) {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a JSON object.';
  }
  if (!isNonEmptyString(body.message)) {
    return 'Field "message" is required and must be a non-empty string.';
  }
  if (body.message.length > 4000) {
    return 'Field "message" exceeds the maximum allowed length of 4000 characters.';
  }
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) {
      return 'Field "history" must be an array when provided.';
    }
    if (body.history.length > 20) {
      return 'Field "history" cannot contain more than 20 entries.';
    }
    const invalidEntry = body.history.some(
      (turn) =>
        !turn ||
        typeof turn !== 'object' ||
        !isNonEmptyString(turn.content) ||
        !['user', 'assistant'].includes(turn.role)
    );
    if (invalidEntry) {
      return 'Each "history" entry must have role "user" or "assistant" and non-empty "content".';
    }
  }
  return null;
}

/* -------------------------------------------------------------
   7. Routes
------------------------------------------------------------- */
app.get('/api/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok', environment: NODE_ENV });
});

app.post('/api/chat', chatRateLimiter, async (req, res, next) => {
  try {
    const validationError = validateChatPayload(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const { message, history } = req.body;
    const reply = await generateChatReply(message.trim(), history);

    return res.status(200).json({
      success: true,
      data: { reply },
    });
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------------
   8. SPA fallback (serves index.html for non-API GET routes)
------------------------------------------------------------- */
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

/* -------------------------------------------------------------
   9. 404 handler for unmatched API routes
------------------------------------------------------------- */
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found.' });
});

/* -------------------------------------------------------------
   10. Centralized error handler
------------------------------------------------------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isProduction = NODE_ENV === 'production';

  console.error('[NOVA-AI] Unhandled error:', isProduction ? err.message : err);

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Malformed JSON in request body.' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request payload is too large.' });
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  const message =
    status === 500
      ? 'An unexpected error occurred while processing your request.'
      : err.message || 'Request could not be processed.';

  return res.status(status).json({ success: false, error: message });
});

/* -------------------------------------------------------------
   11. Process-level safety nets
------------------------------------------------------------- */
process.on('unhandledRejection', (reason) => {
  console.error('[NOVA-AI] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[NOVA-AI] Uncaught exception:', err);
  process.exit(1);
});

/* -------------------------------------------------------------
   12. Start server
------------------------------------------------------------- */
const server = app.listen(PORT, () => {
  console.log(`[NOVA-AI] Server running in ${NODE_ENV} mode on port ${PORT}`);
});

const shutdown = (signal) => {
  console.log(`[NOVA-AI] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('[NOVA-AI] Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
