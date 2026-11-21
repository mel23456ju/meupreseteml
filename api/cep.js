const https = require('https');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const cep = (req.query.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return res.json({ erro: true });

  const url = 'https://viacep.com.br/ws/' + cep + '/json/';
  https.get(url, { timeout: 6000 }, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => { res.end(data); });
  }).on('error', () => {
    res.json({ indisponivel: true });
  });
};
