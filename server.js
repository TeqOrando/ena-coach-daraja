import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.DARAJA_BASE_URL || 'https://sandbox.safaricom.co.ke').replace(/\/$/, '');
const SHORTCODE = process.env.DARAJA_SHORTCODE || '247247';
const ACCOUNT = '0320185161128';
const PASSKEY = process.env.DARAJA_PASSKEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

app.use(express.json({ limit: '200kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.static(path.join(__dirname, 'public')));

const payments = new Map();

function normalizePhone(value) {
  const raw = String(value || '').replace(/\D/g, '');
  if (/^2547\d{8}$/.test(raw) || /^2541\d{8}$/.test(raw)) return raw;
  if (/^07\d{8}$/.test(raw) || /^01\d{8}$/.test(raw)) return `254${raw.slice(1)}`;
  throw new Error('Enter a valid Kenyan M-Pesa number, e.g. 0712345678.');
}

function timestamp() {
  // Daraja expects YYYYMMDDHHMMSS. Kenya is UTC+3.
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function password(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

function configStatus() {
  return {
    configured: Boolean(process.env.DARAJA_CONSUMER_KEY && process.env.DARAJA_CONSUMER_SECRET && PASSKEY && PUBLIC_BASE_URL),
    production: BASE === 'https://api.safaricom.co.ke',
    callbackUrl: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/mpesa/callback` : null
  };
}

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data.access_token) {
    console.error('Daraja OAuth error:', response.status, text);
    throw new Error(data.errorMessage || data.error_description || `Daraja authentication failed (HTTP ${response.status}).`);
  }
  return data.access_token;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ena-coach-daraja', ...configStatus() }));

app.post('/api/stkpush', async (req, res) => {
  try {
    if (!configStatus().configured) {
      return res.status(500).json({ success: false, code: 'NOT_CONFIGURED', message: 'Daraja backend is not configured. Add Consumer Key, Consumer Secret, STK Passkey and a public HTTPS callback URL.' });
    }

    const phone = normalizePhone(req.body.phone);
    const amount = Math.round(Number(req.body.amount));
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid payment amount.');

    const ts = timestamp();
    const token = await getAccessToken();
    const callbackUrl = `${PUBLIC_BASE_URL}/api/mpesa/callback`;
    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: ACCOUNT,
      TransactionDesc: 'ENA COACH booking'
    };

    console.log('Sending STK request:', { phone, amount, callbackUrl, base: BASE, shortcode: SHORTCODE });
    const response = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}

    if (!response.ok || data.ResponseCode !== '0') {
      console.error('Daraja STK error:', response.status, text);
      return res.status(502).json({ success: false, code: 'DARAJA_REJECTED', message: data.errorMessage || data.ResponseDescription || `Daraja rejected the STK request (HTTP ${response.status}).` });
    }

    payments.set(data.CheckoutRequestID, {
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID,
      phone, amount, status: 'PENDING', createdAt: new Date().toISOString(), booking: req.body.booking || null
    });

    return res.json({ success: true, checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage || 'STK prompt sent. Enter your M-Pesa PIN on your phone.' });
  } catch (err) {
    console.error('STK request error:', err);
    return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message || 'Unable to send the M-Pesa prompt.' });
  }
});

app.get('/api/stkpush/status/:checkoutRequestId', (req, res) => {
  const payment = payments.get(req.params.checkoutRequestId);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
  res.json({ success: true, status: payment.status, receipt: payment.receipt || null, amount: payment.amount, resultDesc: payment.resultDesc || null });
});

app.post('/api/mpesa/callback', (req, res) => {
  // Acknowledge Safaricom immediately.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const cb = req.body?.Body?.stkCallback;
    console.log('M-Pesa callback:', JSON.stringify(req.body));
    if (!cb?.CheckoutRequestID) return;
    const payment = payments.get(cb.CheckoutRequestID);
    if (!payment) return;

    if (Number(cb.ResultCode) === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const get = name => items.find(x => x.Name === name)?.Value;
      payment.status = 'PAID';
      payment.receipt = get('MpesaReceiptNumber') || null;
      payment.callbackAmount = get('Amount') || null;
      payment.callbackPhone = get('PhoneNumber') || null;
      payment.paidAt = new Date().toISOString();
    } else {
      payment.status = 'FAILED';
      payment.resultCode = cb.ResultCode;
      payment.resultDesc = cb.ResultDesc || 'Payment failed.';
    }
  } catch (err) { console.error('Callback processing error:', err); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ENA Coach Daraja backend listening on port ${PORT}`);
  console.log('Config:', configStatus());
});
