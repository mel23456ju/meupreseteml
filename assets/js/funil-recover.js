/* [26/10] Recuperacao do upsell em QUALQUER pagina do funil (incluido por api/pixel.php).
 * Problema medido: a maioria paga o PIX com a pagina do checkout fechada (app do banco) e, quando volta
 * ao site, entra pelo anuncio e recomeca o funil sem nunca ver o esgotado. Aqui: se houver um pedido
 * principal recente (ml_main_pix, ate 48h) ja PAGO e a TENF desse pedido ainda nao foi paga, manda
 * para /esgotou/?c=<code> (que por sua vez retoma a etapa certa: oferta, PIX pendente ou /up/).
 * Nao roda em /esgotou/ e /up/ (sao os destinos) nem com um PIX em andamento no checkout. */
(function () {
  'use strict';
  var path = location.pathname || '';
  if (/\/(esgotou|up)\//.test(path)) return;
  try { if (sessionStorage.getItem('ml_pending_pix')) return; } catch (e) {}
  var raw; try { raw = localStorage.getItem('ml_main_pix'); } catch (e) { return; }
  if (!raw) return;
  var o; try { o = JSON.parse(raw); } catch (e) { return; }
  if (!o || !o.code || !o.ts || (Date.now() - o.ts) > 172800000) return; // 48h
  var upDone = ''; try { upDone = localStorage.getItem('ml_up_done') || ''; } catch (e) {}
  if (o.code === upDone) return;
  // evita loop: 1 tentativa por pedido a cada 60s
  var k = 'ml_recover_' + o.code, last = 0;
  try { last = parseInt(sessionStorage.getItem(k) || '0', 10) || 0; } catch (e) {}
  if (Date.now() - last < 60000) return;
  try { sessionStorage.setItem(k, String(Date.now())); } catch (e) {}
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/pix/check-payment.php?code=' + encodeURIComponent(o.code) + (o.cid ? '&checkout_id=' + encodeURIComponent(o.cid) : ''));
  xhr.onload = function () {
    var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) {}
    if (!d || d.status !== 'paid') return;
    try { localStorage.setItem('ml_up_offered', o.code); } catch (e) {}
    var q = new URLSearchParams(location.search); q.delete('c');
    var s = q.toString();
    location.replace(rota('esgotou') + '?' + (s ? s + '&' : '') + 'c=' + encodeURIComponent(o.code));
  };
  xhr.send();
})();
