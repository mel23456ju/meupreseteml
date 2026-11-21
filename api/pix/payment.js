const { cors, genCode, txSave, zenithFetch } = require('../_config');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const body = req.body || {};
  const customer = body.customer || {};
  const name = (customer.name || '').trim();
  const email = (customer.email || '').trim();
  const document = (customer.document || '').replace(/\D/g, '');
  const phone = (customer.phone || '').replace(/\D/g, '');
  const amount = parseInt(body.amount) || 0;

  if (amount < 100) return res.status(400).json({ success: false, error: 'Valor inválido' });
  if (!document || document.length < 11) return res.status(400).json({ success: false, error: 'CPF/CNPJ obrigatório' });

  const paymentCode = genCode();
  const idempotencyKey = crypto.randomBytes(16).toString('hex');

  const zenithBody = {
    amount,
    currency: 'BRL',
    referenceId: paymentCode,
    idempotencyKey,
    customer: {
      name: name || 'Cliente',
      email: email || 'cliente@email.com',
      document,
      phone,
    },
  };

  const r = await zenithFetch('POST', '/api-sales/pix', zenithBody);
  const j = r.json;

  let pixCode = '';
  let checkoutId = '';
  let status = 'pending';

  if (r.code >= 200 && r.code < 300 && j) {
    checkoutId = String(j.id || '');
    status = String(j.status || j.payment?.status || 'pending').toLowerCase();
    const pix = j.pix || {};
    pixCode = String(pix.copyPaste || pix.qrCode || '');
  }

  if (!pixCode) {
    const apiError = j ? String(j.message || j.error || j.code || '') : (r.error || '');
    console.error('[zenith] payment failed code=' + r.code + ' raw=' + (r.raw || '').substring(0, 500));
    return res.status(502).json({ success: false, error: apiError || 'Não foi possível gerar o PIX. Tente novamente.', debug: r.code });
  }

  const trackingIn = body.trackingParameters || {};
  const tracking = {
    fbp: (trackingIn.fbp || '').trim(),
    fbc: (trackingIn.fbc || '').trim(),
    utms: trackingIn.utms || (trackingIn.utm_source ? trackingIn : {}),
    source_url: (trackingIn.source_url || body.source_url || '').trim(),
  };

  const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();

  const tx = {
    payment_code: paymentCode,
    checkout_id: checkoutId,
    status,
    paid: false,
    amount,
    name, email, document, phone,
    pix_code: pixCode,
    created_at: Math.floor(Date.now() / 1000),
    tracking,
    client_ip: clientIp,
    client_ua: req.headers['user-agent'] || '',
    raw_response: j,
  };
  txSave(tx);

  res.status(200).json({ success: true, payment_code: paymentCode, checkout_id: checkoutId, pix_qrcode_text: pixCode, amount, status });
};
