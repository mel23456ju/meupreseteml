const { cors, hashFb, fbCapiSend } = require('./_config');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const body = req.body || {};
  const eventName = (body.event_name || '').trim();
  const eventId = (body.event_id || '').trim();
  const eventTime = parseInt(body.event_time) || Math.floor(Date.now() / 1000);
  const sourceUrl = (body.source_url || '').trim();
  const userData = body.user_data || {};
  const customData = body.custom_data || {};

  if (!eventName) return res.status(400).json({ success: false, error: 'event_name required' });

  const user = {};
  if (userData.em) user.em = [hashFb(userData.em)];
  if (userData.ph) user.ph = [hashFb(String(userData.ph).replace(/\D/g, ''))];
  if (userData.fn) user.fn = [hashFb(userData.fn)];
  if (userData.cpf) user.external_id = [hashFb(String(userData.cpf).replace(/\D/g, ''))];
  if (userData.fbp) user.fbp = userData.fbp;
  if (userData.fbc) user.fbc = userData.fbc;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (ip) user.client_ip_address = ip;
  if (req.headers['user-agent']) user.client_user_agent = req.headers['user-agent'];
  user.country = [hashFb('br')];

  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'website',
    user_data: user,
  };
  if (eventId) event.event_id = eventId;
  if (sourceUrl) event.event_source_url = sourceUrl;
  if (Object.keys(customData).length) event.custom_data = customData;

  const r = await fbCapiSend([event]);
  const ok = r.code >= 200 && r.code < 300;
  if (!ok) console.error('[fb-capi] event=' + eventName + ' code=' + r.code + ' raw=' + (r.raw || '').substring(0, 500));

  res.json({ success: ok, fb_code: r.code });
};
