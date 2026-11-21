const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ZENITH_API_URL = 'https://api.zenithworld.com.br';
const ZENITH_PUBLIC_KEY = 'zp_pub_b95cd26018748aa6450cf8b794648bc3';
const ZENITH_SECRET_KEY = 'zp_sec_43b45ee4fe38757d211c4a39e6a1b09c8d57545a96e12014';

const FB_PIXEL_ID = '2027107937966810';
const FB_CAPI_TOKEN = 'EAAUUUjCZAP4sBTDgWz9etLIY7xJ9alXGxjDPTsM38kcWj3ZCBoqD4REb1TgZCH8SdYjcbkARPaNd9x1jASssD2DO2XHtg3ZA6RABilxCyxwZA5QBlEwrl6argJuRUEusj9d3ZC1ZC8yObR4zlPyCzd0QKDH4KoBI8BDs0jjgZAITevKN3G6ZAyrMAhOGLhMIg2wZDZD';
const FB_API_VERSION = 'v18.0';

const TX_DIR = '/tmp/transactions';

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function genCode() {
  return 'pedido_' + Math.floor(Date.now() / 1000).toString(16) + crypto.randomBytes(4).toString('hex');
}

function txPath(code) {
  const safe = code.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(TX_DIR, safe + '.json');
}

function txSave(tx) {
  if (!fs.existsSync(TX_DIR)) fs.mkdirSync(TX_DIR, { recursive: true });
  fs.writeFileSync(txPath(tx.payment_code), JSON.stringify(tx));
}

function txLoad(code) {
  const p = txPath(code);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function hashFb(val) {
  val = (val || '').trim().toLowerCase();
  return val ? crypto.createHash('sha256').update(val).digest('hex') : '';
}

function zenithFetch(method, urlPath, body) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, ZENITH_API_URL);
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': ZENITH_PUBLIC_KEY,
        'X-API-Secret': ZENITH_SECRET_KEY,
      },
      timeout: 30000,
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ code: resp.statusCode, raw: data, json, error: '' });
      });
    });
    req.on('error', (e) => resolve({ code: 0, raw: '', json: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, raw: '', json: null, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fbCapiSend(events) {
  return new Promise((resolve) => {
    const url = new URL(`/${FB_API_VERSION}/${FB_PIXEL_ID}/events`, 'https://graph.facebook.com');
    url.searchParams.set('access_token', FB_CAPI_TOKEN);
    const payload = JSON.stringify({ data: events });
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ code: resp.statusCode, raw: data, json, error: '' });
      });
    });
    req.on('error', (e) => resolve({ code: 0, raw: '', json: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, raw: '', json: null, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  ZENITH_API_URL, ZENITH_PUBLIC_KEY, ZENITH_SECRET_KEY,
  FB_PIXEL_ID, FB_CAPI_TOKEN, FB_API_VERSION, TX_DIR,
  cors, genCode, txPath, txSave, txLoad, hashFb,
  zenithFetch, fbCapiSend,
};
