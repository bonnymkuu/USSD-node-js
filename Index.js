// ============================= // USSD WALLET — NODE.JS STARTER // Single-file reference implementation for quick prototyping // ============================= // Features: // - Registration (first-time users) // - PIN setup with confirmation // - Login by PIN for sensitive actions // - Check Balance // - Send Money (atomic MongoDB transaction) // - Mini Statement (last 5 transactions) // - Change PIN // - In-memory USSD session store (swap with Redis in prod) // - Basic rate limiting // - Secure PIN hashing (bcrypt) // // NOTE: For production, split into modules and replace InMemorySessionStore with Redis.

// ============================= // 0) Quick Start // ============================= // 1. Create a new folder and paste this file as server.js. // 2. npm init -y // 3. npm i express body-parser mongoose bcrypt jsonwebtoken express-rate-limit dotenv morgan // 4. Start MongoDB (local or remote). Example local: mongod // 5. Create a .env file next to server.js with: //    PORT=3000 //    MONGO_URI=mongodb://localhost:27017/ussd_wallet //    JWT_SECRET=change_me // 6. Run: node server.js // 7. Point your USSD gateway to POST https://<your-host>/ussd (Content-Type: application/x-www-form-urlencoded) //    Required fields commonly sent by gateways: sessionId, serviceCode, phoneNumber, text

// ============================= // 1) Imports & Setup // ============================= const express = require('express'); const bodyParser = require('body-parser'); const mongoose = require('mongoose'); const bcrypt = require('bcrypt'); const rateLimit = require('express-rate-limit'); const dotenv = require('dotenv'); const morgan = require('morgan');

dotenv.config();

const app = express(); app.use(bodyParser.urlencoded({ extended: false })); app.use(bodyParser.json()); app.use(morgan('tiny'));

// Basic rate limiter (tune for your infra) const limiter = rateLimit({ windowMs: 10 * 1000, max: 50 }); app.use('/ussd', limiter);

// ============================= // 2) Database Models // ============================= mongoose.set('strictQuery', true); mongoose .connect(process.env.MONGO_URI, { dbName: undefined }) .then(() => console.log('✅ MongoDB connected')) .catch((err) => { console.error('❌ MongoDB connection error:', err.message); process.exit(1); });

const { Schema } = mongoose;

const userSchema = new Schema( { phoneNumber: { type: String, unique: true, index: true, required: true }, pinHash: { type: String, required: true }, balance: { type: Number, default: 0 }, // store minor units in prod (e.g., cents) status: { type: String, enum: ['active', 'blocked'], default: 'active' }, }, { timestamps: true } );

const txnSchema = new Schema( { type: { type: String, enum: ['deposit', 'withdrawal', 'transfer'], required: true }, amount: { type: Number, required: true }, from: { type: String, default: null }, // phoneNumber to: { type: String, default: null }, // phoneNumber status: { type: String, enum: ['success', 'failed'], default: 'success' }, meta: { type: Object, default: {} }, }, { timestamps: true } );

const User = mongoose.model('User', userSchema); const Txn = mongoose.model('Txn', txnSchema);

// ============================= // 3) USSD Session Store (In-Memory) // ============================= // Replace this with Redis for multi-instance or high scale deployments class InMemorySessionStore { constructor() { this.store = new Map(); } get(id) { return this.store.get(id) || {}; } set(id, data) { this.store.set(id, data); } clear(id) { this.store.delete(id); } } const sessionStore = new InMemorySessionStore();

// Helper: sanitize and normalize phone numbers to E.164-lite function normalizeMsisdn(msisdn) { if (!msisdn) return ''; // remove spaces and non-digits except leading + let n = (msisdn + '').trim(); if (n.startsWith('00')) n = '+' + n.slice(2); if (!n.startsWith('+')) { // naive: assume country code is present on gateway; if not, attach your default // e.g., for TZ: +255, KE: +254, SA: +27, etc. // Adjust per deployment } return n; }

// USSD helpers const USSD = { con: (msg) => CON ${msg}, end: (msg) => END ${msg}, };

// ============================= // 4) Menu Rendering // ============================= function mainMenu() { return USSD.con( [ 'Welcome to Telco Wallet', '1. Check Balance', '2. Send Money', '3. Mini Statement', '4. Change PIN', ].join('\n') ); }

function askForPIN(prefix = 'Enter PIN') { return USSD.con(${prefix} (4 digits):); } function askRecipient() { return USSD.con('Enter recipient phone number:'); } function askAmount() { return USSD.con('Enter amount:'); } function confirmTransfer(recipient, amount) { return USSD.con(Send ${amount} to ${recipient}?\n1. Yes\n2. No); } function pinMismatch() { return USSD.con('PINs do not match. Enter new PIN:'); }

// ============================= // 5) Core Handlers // ============================= // Flow keys used in sessionStore per sessionId: // state: 'register_pin1' | 'register_pin2' | 'enter_pin' | 'send_recipient' | 'send_amount' | 'send_confirm' | 'change_pin_old' | 'change_pin_new1' | 'change_pin_new2' | null // temp: { recipient, amount, pin1 }

app.post('/ussd', async (req, res) => { try { const { sessionId, serviceCode, phoneNumber, text } = req.body; const msisdn = normalizeMsisdn(phoneNumber); const session = sessionStore.get(sessionId);

// Split text by '*', gateway accumulates selections
const parts = (text || '').split('*').filter(Boolean);

// If first hit, initialize state
if (!session.state && parts.length === 0) {
  // Check if user exists
  const existing = await User.findOne({ phoneNumber: msisdn });
  if (!existing) {
    session.state = 'register_pin1';
    sessionStore.set(sessionId, session);
    return res.send(USSD.con('Welcome! Create your 4-digit PIN:'));
  } else {
    session.state = 'enter_pin';
    sessionStore.set(sessionId, session);
    return res.send(askForPIN('Enter PIN to continue'));
  }
}

// Fetch or create user lazily when needed
let user = await User.findOne({ phoneNumber: msisdn });

// Handle registration flows
if (session.state === 'register_pin1') {
  const pin1 = parts[parts.length - 1];
  if (!/^\d{4}$/.test(pin1)) return res.send(USSD.con('Invalid PIN. Enter 4 digits:'));
  session.temp = { ...(session.temp || {}), pin1 };
  session.state = 'register_pin2';
  sessionStore.set(sessionId, session);
  return res.send(USSD.con('Confirm PIN:'));
}

if (session.state === 'register_pin2') {
  const pin2 = parts[parts.length - 1];
  if (!/^\d{4}$/.test(pin2)) return res.send(USSD.con('Invalid PIN. Confirm 4 digits:'));
  if (session.temp?.pin1 !== pin2) {
    // restart new pin
    session.state = 'register_pin1';
    session.temp = {};
    sessionStore.set(sessionId, session);
    return res.send(pinMismatch());
  }
  // create user
  const hash = await bcrypt.hash(pin2, 10);
  user = await User.create({ phoneNumber: msisdn, pinHash: hash, balance: 0 });
  // proceed to menu
  session.state = null;
  session.temp = {};
  sessionStore.set(sessionId, session);
  return res.send(mainMenu());
}

// If we are here for an existing user and state may be 'enter_pin' or null
if (session.state === 'enter_pin') {
  const pin = parts[parts.length - 1];
  if (!/^\d{4}$/.test(pin)) return res.send(USSD.con('Invalid PIN. Enter 4 digits:'));
  if (!user) return res.send(USSD.end('Account not found.'));
  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) return res.send(USSD.end('Wrong PIN.'));
  session.state = null; // authenticated for this session
  session.auth = true;
  sessionStore.set(sessionId, session);
  return res.send(mainMenu());
}

// When user is authenticated (or after registration), handle menu selections
// Determine current step from accumulated text when no explicit state
if (!session.state) {
  const choice = parts[0];
  switch (choice) {
    case '1': // Balance
      if (!user) return res.send(USSD.end('Account missing.'));
      return res.send(USSD.end(`Balance: ${user.balance.toFixed(2)}`));

    case '2': // Send Money
      if (!session.auth) {
        session.state = 'enter_pin';
        sessionStore.set(sessionId, session);
        return res.send(askForPIN('Enter PIN to send money'));
      }
      if (parts.length === 1) {
        session.state = 'send_recipient';
        sessionStore.set(sessionId, session);
        return res.send(askRecipient());
      }
      break;

    case '3': // Mini Statement
      if (!user) return res.send(USSD.end('Account missing.'));
      {
        const txns = await Txn.find({ $or: [{ from: user.phoneNumber }, { to: user.phoneNumber }] })
          .sort({ createdAt: -1 })
          .limit(5);
        if (txns.length === 0) return res.send(USSD.end('No transactions yet.'));
        const lines = txns.map((t) => {
          const ts = new Date(t.createdAt).toLocaleString();
          if (t.type === 'transfer') {
            if (t.from === user.phoneNumber) return `- ${ts} Sent ${t.amount.toFixed(2)} to ${t.to}`;
            if (t.to === user.phoneNumber) return `+ ${ts} From ${t.from} ${t.amount.toFixed(2)}`;
          }
          if (t.type === 'deposit') return `+ ${ts} Deposit ${t.amount.toFixed(2)}`;
          if (t.type === 'withdrawal') return `- ${ts} Withdrawal ${t.amount.toFixed(2)}`;
          return `${ts} ${t.type} ${t.amount.toFixed(2)}`;
        });
        return res.send(USSD.end(lines.join('\n')));
      }

    case '4': // Change PIN
      if (!session.auth) {
        session.state = 'enter_pin';
        sessionStore.set(sessionId, session);
        return res.send(askForPIN('Enter current PIN'));
      }
      session.state = 'change_pin_old';
      sessionStore.set(sessionId, session);
      return res.send(askForPIN('Enter current PIN'));

    default:
      return res.send(USSD.end('Invalid option.'));
  }
}

// SEND MONEY FLOW
if (session.state === 'send_recipient') {
  const recipient = parts[parts.length - 1];
  // TODO: add stricter validation per market
  if (!recipient || recipient.length < 6) return res.send(askRecipient());
  session.temp = { ...(session.temp || {}), recipient };
  session.state = 'send_amount';
  sessionStore.set(sessionId, session);
  return res.send(askAmount());
}

if (session.state === 'send_amount') {
  const amountStr = parts[parts.length - 1];
  const amount = Number(amountStr);
  if (!(amount > 0)) return res.send(askAmount());
  session.temp = { ...(session.temp || {}), amount };
  session.state = 'send_confirm';
  sessionStore.set(sessionId, session);
  return res.send(confirmTransfer(session.temp.recipient, amount));
}

if (session.state === 'send_confirm') {
  const conf = parts[parts.length - 1];
  if (conf !== '1') {
    // cancel
    session.state = null; session.temp = {}; sessionStore.set(sessionId, session);
    return res.send(USSD.end('Cancelled.'));
  }
  // Do atomic transfer
  const { recipient, amount } = session.temp || {};
  if (!user) return res.send(USSD.end('Account not found.'));
  if (amount > user.balance) {
    session.state = null; session.temp = {}; sessionStore.set(sessionId, session);
    return res.send(USSD.end('Insufficient balance.'));
  }

  // Normalize recipient and ensure account exists
  const recip = normalizeMsisdn(recipient);
  const sessionMongo = await mongoose.startSession();
  try {
    await sessionMongo.withTransaction(async () => {
      const sender = await User.findOne({ phoneNumber: msisdn }).session(sessionMongo);
      const receiver = await User.findOneAndUpdate(
        { phoneNumber: recip },
        { $setOnInsert: { pinHash: await bcrypt.hash('0000', 10), balance: 0, status: 'active' } },
        { upsert: true, new: true, session: sessionMongo }
      );

      if (!sender || sender.balance < amount) throw new Error('INSUFFICIENT_FUNDS');

      // debit/credit
      sender.balance -= amount;
      receiver.balance += amount;
      await sender.save({ session: sessionMongo });
      await receiver.save({ session: sessionMongo });

      await Txn.create([
        { type: 'transfer', amount, from: sender.phoneNumber, to: receiver.phoneNumber, status: 'success' },
      ], { session: sessionMongo });
    });
  } catch (e) {
    await sessionMongo.endSession();
    session.state = null; session.temp = {}; sessionStore.set(sessionId, session);
    if (e.message === 'INSUFFICIENT_FUNDS') return res.send(USSD.end('Insufficient balance.'));
    console.error('Transfer error:', e.message);
    return res.send(USSD.end('Transaction failed. Try again.'));
  }
  await sessionMongo.endSession();

  session.state = null; session.temp = {}; sessionStore.set(sessionId, session);
  return res.send(USSD.end(`Sent ${Number(amount).toFixed(2)} to ${recip}.`));
}

// CHANGE PIN FLOW
if (session.state === 'change_pin_old') {
  const oldPin = parts[parts.length - 1];
  const ok = user && /^\d{4}$/.test(oldPin) && await bcrypt.compare(oldPin, user.pinHash);
  if (!ok) return res.send(USSD.end('Wrong PIN.'));
  session.state = 'change_pin_new1';
  sessionStore.set(sessionId, session);
  return res.send(USSD.con('Enter new 4-digit PIN:'));
}

if (session.state === 'change_pin_new1') {
  const p1 = parts[parts.length - 1];
  if (!/^\d{4}$/.test(p1)) return res.send(USSD.con('Invalid PIN. Enter new 4-digit PIN:'));
  session.temp = { ...(session.temp || {}), pin1: p1 };
  session.state = 'change_pin_new2';
  sessionStore.set(sessionId, session);
  return res.send(USSD.con('Confirm new PIN:'));
}

if (session.state === 'change_pin_new2') {
  const p2 = parts[parts.length - 1];
  if (!/^\d{4}$/.test(p2)) return res.send(USSD.con('Invalid PIN. Confirm new 4-digit PIN:'));
  if (session.temp?.pin1 !== p2) {
    session.state = 'change_pin_new1';
    sessionStore.set(sessionId, session);
    return res.send(pinMismatch());
  }
  const newHash = await bcrypt.hash(p2, 10);
  await User.updateOne({ phoneNumber: msisdn }, { $set: { pinHash: newHash } });
  session.state = null; session.temp = {}; sessionStore.set(sessionId, session);
  return res.send(USSD.end('PIN changed.'));
}

// Fallback
return res.send(USSD.end('Session ended.'));

} catch (err) { console.error('USSD error:', err); return res.send(USSD.end('System error.')); } });

// Health check app.get('/ping', (_req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log(🚀 USSD server listening on :${PORT}));

// ============================= // 6) Testing Tips // ============================= // Use Postman/Insomnia: POST http://localhost:3000/ussd // Body (x-www-form-urlencoded): //  sessionId=abc123 //  serviceCode=123# //  phoneNumber=+255700000001 //  text= // Each subsequent step append to text with * separators, e.g. //  text=1 //  text=2+255700000002 //  text=2*+25570000000250 //  text=2+255700000002501 // // Gateways differ slightly in payload names; adapt the req.body extraction accordingly.

// ============================= // 7) Production Notes // ============================= // - Replace in-memory session store with Redis (ioredis), keyed by sessionId, with TTL ~ 180s. // - Store currency in minor units (cents) to avoid float errors; use Decimal128 or integers. // - Enforce KYC/AML: user profiles, limits, velocity checks. // - Add idempotency: ignore duplicate confirm requests using a per-session nonce. // - Observability: log txns, add correlation IDs. // - Security: hash PINs (done), consider device fingerprinting, lockouts after N wrong PIN attempts. // - Compliance: obtain central bank approvals; maintain a trust (float) account mirroring wallet liabilities.

