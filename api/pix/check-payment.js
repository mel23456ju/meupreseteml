const { cors, txLoad, txSave, zenithFetch, hashFb, fbCapiSend } = require('../_config');

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ success: false, error: 'code required' });

  const tx = txLoad(code);
  if (!tx) return res.status(404).json({ success: false, status: 'not_found' });

  if (tx.paid) return res.json({ success: true, status: 'paid', payment_code: code });

  const checkoutId = String(tx.checkout_id || '');
  if (!checkoutId) return res.json({ success: true, status: tx.status || 'pending', payment_code: code });

  const r = await zenithFetch('GET', '/api-sales/pix/' + encodeURIComponent(checkoutId));
  const j = r.json;

  let zenithStatus = '';
  if (r.code >= 200 && r.code < 300 && j) {
    zenithStatus = String(j.status || j.payment?.status || '').toUpperCase();
  }

  const isPaid = ['COMPLETED', 'SUCCEEDED', 'AUTHORIZED', 'CAPTURED', 'PAID', 'APPROVED'].includes(zenithStatus);
  const isFailed = ['FAILED', 'CANCELED', 'CANCELLED', 'REFUNDED', 'EXPIRED'].includes(zenithStatus);

  if (isPaid && !tx.paid) {
    tx.paid = true;
    tx.status = 'paid';
    tx.paid_at = Math.floor(Date.now() / 1000);
    tx.raw_check = j;
    txSave(tx);

    // CAPI Purchase
    try {
      const tracking = tx.tracking || {};
      const user = {};
      if (tx.email) user.em = [hashFb(tx.email)];
      if (tx.phone) user.ph = [hashFb(tx.phone.replace(/\D/g, ''))];
      if (tx.name) user.fn = [hashFb(tx.name)];
      if (tx.document) user.external_id = [hashFb(tx.document.replace(/\D/g, ''))];
      if (tracking.fbp) user.fbp = tracking.fbp;
      if (tracking.fbc) user.fbc = tracking.fbc;
      const ip = tx.client_ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (ip) user.client_ip_address = ip;
      const ua = tx.client_ua || req.headers['user-agent'] || '';
      if (ua) user.client_user_agent = ua;
      user.country = [hashFb('br')];

      const purchaseEvent = {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: 'pur_' + code,
        action_source: 'website',
        user_data: user,
        custom_data: { currency: 'BRL', value: Math.round(tx.amount / 100 * 100) / 100 },
      };
      if (tracking.source_url) purchaseEvent.event_source_url = tracking.source_url;

      const fbRes = await fbCapiSend([purchaseEvent]);
      if (fbRes.code < 200 || fbRes.code >= 300) {
        console.error('[fb-capi] Purchase FAIL code=' + code + ' fb=' + fbRes.code + ' ' + (fbRes.raw || '').substring(0, 300));
      }
    } catch (e) {
      console.error('[fb-capi] Purchase error:', e.message);
    }
  }

  if (isFailed && tx.status !== 'failed') {
    tx.status = 'failed';
    tx.raw_check = j;
    txSave(tx);
  }

  let outStatus = 'pending';
  if (isPaid) outStatus = 'paid';
  else if (isFailed) outStatus = 'failed';

  res.json({ success: true, status: outStatus, payment_code: code });
};
