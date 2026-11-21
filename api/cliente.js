const { cors } = require('./_config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false });

  const body = req.body || {};
  let ref = (body.ref || '').trim();
  if (!ref) ref = 'cli_' + crypto.randomBytes(6).toString('hex');

  const dir = '/tmp/clientes';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data = {
    ref,
    nome: (body.nome || '').trim(),
    email: (body.email || '').trim(),
    cpf: (body.cpf || '').trim(),
    telefone: (body.telefone || '').trim(),
    cep: (body.cep || '').trim(),
    rua: (body.rua || '').trim(),
    numero: (body.numero || '').trim(),
    complemento: (body.complemento || '').trim(),
    bairro: (body.bairro || '').trim(),
    cidade: (body.cidade || '').trim(),
    uf: (body.uf || '').trim(),
    updated_at: Math.floor(Date.now() / 1000),
  };

  const safe = ref.replace(/[^a-zA-Z0-9_-]/g, '');
  fs.writeFileSync(path.join(dir, safe + '.json'), JSON.stringify(data));

  res.json({ success: true, ref });
};
