/* fm-replay.js — snippet do módulo Replay (FoxMod). O MESMO arquivo em qualquer site; não editar.
   Grava a sessão com rrweb (rrweb-record.min.js, carregado da mesma pasta) e manda em lotes para o
   coletor do próprio site. Configuração pelos atributos da tag:
     data-endpoint  rota do coletor            (padrão /replay/coletar)
     data-amostra   % de sessões gravadas      (padrão 100)
     data-desligado "1" não grava nada
   Privacidade por padrão: todo campo de formulário vira "*", CPF/CNPJ/cartão/e-mail/telefone/CEP/PIX
   são mascarados no texto, [data-rr-block]/.rr-block some, [data-rr-mask]/.rr-mask tem o texto todo
   mascarado. Nunca grava corpo de requisição, cookies nem storage. Se der erro, para em silêncio. */
(function () {
  'use strict';
  if (window.__fmReplay) return;
  window.__fmReplay = true;

  var tag = document.currentScript;
  if (!tag) return;
  var attr = function (n, d) { var v = tag.getAttribute(n); return v === null || v === '' ? d : v; };
  if (attr('data-desligado', '') === '1') return;
  if (navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|bytespider/i.test(navigator.userAgent)) return;

  var ENDPOINT = attr('data-endpoint', '/replay/coletar');
  var AMOSTRA = Math.max(0, Math.min(100, Number(attr('data-amostra', '100')) || 0));
  var BASE = tag.src.replace(/[^/]*(\?.*)?$/, '');
  var LOTE_MS = 5000, LOTE_MAX_EV = 400, PARADO_MS = 30 * 60 * 1000, BEACON_MAX = 60000, CORPO_MAX = 1500000, LOTE_CHARS = 1250000;

  // ---------- armazenamento local (sem quebrar se o navegador bloquear) ----------
  function ler(st, k) { try { return window[st].getItem(k); } catch (e) { return null; } }
  function gravar(st, k, v) { try { window[st].setItem(k, v); } catch (e) {} }
  function uuid() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  // Sessão: por aba (sessionStorage); nova depois de 30 min parada. A decisão da amostra vale a sessão toda.
  var agora = Date.now();
  var sid = ler('sessionStorage', 'fmr_sid');
  var visto = Number(ler('sessionStorage', 'fmr_visto')) || 0;
  if (!sid || !/^[a-f0-9]{32}$/.test(sid) || agora - visto > PARADO_MS) {
    sid = uuid();
    gravar('sessionStorage', 'fmr_sid', sid);
    gravar('sessionStorage', 'fmr_pg', '-1');
    gravar('sessionStorage', 'fmr_hist', '[]');
    gravar('sessionStorage', 'fmr_amostra', Math.random() * 100 < AMOSTRA ? '1' : '0');
  }
  if (ler('sessionStorage', 'fmr_amostra') !== '1') return;
  gravar('sessionStorage', 'fmr_visto', String(agora));

  // ttk_vid (gerado pelo helper do TikTok mais tarde) pode ainda não existir no boot: resolve a CADA lote.
  // O fallback fmr_vid nasce no MESMO formato v_+hex24 do ttk_vid, para nunca divergir do visitor_id nas vendas.
  var fmr = String(ler('localStorage', 'fmr_vid') || '').slice(0, 80);
  function vidNovo() {
    var b = new Uint8Array(12), v = '';
    (window.crypto || window.msCrypto).getRandomValues(b);
    for (var i = 0; i < b.length; i++) v += ('0' + b[i].toString(16)).slice(-2);
    return 'v_' + v;
  }
  function vid() {
    var t = String(ler('localStorage', 'ttk_vid') || '').slice(0, 80);
    if (t) return t;
    if (!/^(v_)?[a-f0-9]{24,32}$/.test(fmr)) { fmr = vidNovo(); gravar('localStorage', 'fmr_vid', fmr); }
    return fmr;
  }

  var pg = (Number(ler('sessionStorage', 'fmr_pg')) || 0) + 1;
  if (pg < 0) pg = 0;
  gravar('sessionStorage', 'fmr_pg', String(pg));
  var caminho = location.pathname || '/';

  // ---------- mascaramento ----------
  // Ordem importa: PIX copia e cola e cartão antes de telefone/CPF (que casariam pedaços deles).
  var PADROES = [
    // query string de qualquer URL (token do cloaker, ids de clique) some; fica o :linha:coluna do stack
    [/(https?:\/\/[^\s?#"'()]+)\?[^\s#"'()]*?(?=(?::\d+){1,2}(?=[\s"')]|$)|[\s"')]|$)/g, '$1'],
    [/000201[0-9A-Za-z.\-/:@*_ ]{20,}/g, '[PIX]'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[chave]'],
    [/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '[e-mail]'],
    [/\b(?:\d[ .\-]?){13,19}\b/g, '[cartão]'],
    [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]'],
    [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]'],
    [/(?:\+?55[ \-]?)?\(?\b\d{2}\)?[ \-]?9?\d{4}[ \-]?\d{4}\b/g, '[telefone]'],
    [/\b\d{5}-\d{3}\b/g, '[CEP]']
  ];
  function filtrar(t) {
    t = String(t == null ? '' : t);
    if (!/\d|@|\?/.test(t)) return t;
    for (var i = 0; i < PADROES.length; i++) t = t.replace(PADROES[i][0], PADROES[i][1]);
    return t;
  }
  function mascaraTexto(t, el) {
    if (el && el.closest && el.closest('.rr-mask,[data-rr-mask]')) return t.replace(/\S/g, '*');
    return filtrar(t);
  }
  function corta(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) : t; }

  // URL gravada sem parâmetros sensíveis (token do cloaker, chaves, ids de clique).
  var SENSIVEIS = /^(s|clk|dev|key|token|ttclid|fbclid|gclid|email|cpf|tel|phone)$/i;
  function limparUrl(u) {
    try {
      var url = new URL(u, location.href), tira = [];
      url.searchParams.forEach(function (v, k) { if (SENSIVEIS.test(k)) tira.push(k); });
      tira.forEach(function (k) { url.searchParams.delete(k); });
      url.hash = '';
      return url.toString();
    } catch (e) { return ''; }
  }

  // href/src também circulam nos atributos do DOM (os links do funil repassam a query inteira do anúncio:
  // token do cloaker e ids de clique não podem ir para o banco). Vale para o snapshot completo e para
  // atributos/nós novos que chegam por mutação.
  function limparAttrs(o) {
    if (!o || typeof o !== 'object') return;
    for (var k in o) if ((k === 'href' || k === 'src') && typeof o[k] === 'string') o[k] = limparUrl(o[k]);
  }
  function limparNo(n) {
    if (!n || typeof n !== 'object') return;
    limparAttrs(n.attributes);
    if (Array.isArray(n.childNodes)) for (var i = 0; i < n.childNodes.length; i++) limparNo(n.childNodes[i]);
  }

  // ---------- estado da página ----------
  var fila = [], seq = 0, timer = null, parar = null, morto = false, saindo = false;
  var devagar = 0;                // espera extra (backoff) quando o coletor responde 429/500
  var sinais = [];
  var pag = { cliques: 0, rolagem: 0, ativo: 0, ultimoAtivo: 0 };
  var inicioPag = Date.now();

  // ---------- carregamento da página (o que o visitante esperou) ----------
  // ttfb = servidor respondeu · fcp = 1º conteúdo na tela · lcp = maior elemento na tela (métrica do Google para
  // "carregou") · fontes = última fonte terminou de baixar · load = evento load. Tudo em ms desde a navegação.
  var lcp = 0, restaurada = false;
  try {
    new PerformanceObserver(function (l) { var e = l.getEntries(); if (e.length) lcp = Math.round(e[e.length - 1].startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  function msOuNada(x) { return x > 0 && x < 120000 ? Math.round(x) : null; }
  function carga() {
    if (restaurada || !window.performance || !performance.getEntriesByType) return null;
    try {
      var n = performance.getEntriesByType('navigation')[0] || {};
      var f = performance.getEntriesByName('first-contentful-paint')[0];
      var fontes = 0;
      performance.getEntriesByType('resource').forEach(function (r) {
        if (/\.(woff2?|ttf|otf)(\?|$)/i.test(r.name) && r.responseEnd > fontes) fontes = r.responseEnd;
      });
      return { ttfb: msOuNada(n.responseStart), fcp: msOuNada(f && f.startTime), lcp: msOuNada(lcp), fontes: msOuNada(fontes), load: msOuNada(n.loadEventEnd) };
    } catch (e) { return null; }
  }
  var reacao = 0;                 // último instante em que a página reagiu (rolagem, digitação, resposta de clique)
  var cliquePendente = 0;         // clique esperando resposta: mutação DOM em até 1 s depois conta como resposta
  var cliques = [];               // para clique de raiva
  var ultimoClique = 0;
  var ultimoMorto = { a: '', t: 0 };
  var form = { ultimo: '' };      // último campo em que digitou; limpa ao enviar ou clicar num botão

  function sinal(tipo, extra) {
    if (sinais.length > 200) return;
    var s = { t: Date.now(), tipo: tipo };
    for (var k in extra) if (extra[k] !== undefined && extra[k] !== '') s[k] = corta(filtrar(extra[k]), 300);
    sinais.push(s);
    try { window.rrwebRecord.record.addCustomEvent('fm', s); } catch (e) {}
  }

  // Seletor curto e legível (tag#id.classe ou tag[name]), sem textos digitados.
  function alvo(el) {
    if (!el || el.nodeType !== 1) return '';
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    if (el.getAttribute('name')) return s + '[name=' + el.getAttribute('name') + ']';
    var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return s + (c.length ? '.' + c.join('.') : '');
  }
  function textoDe(el) {
    if (!el || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return '';
    return corta((el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0, 200).replace(/\s+/g, ' ').trim(), 60);
  }
  function interativo(el) {
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      if (/^(A|BUTTON|SUMMARY|IMG|SVG|LABEL|VIDEO)$/i.test(n.tagName) || n.getAttribute('role') === 'button' || n.hasAttribute('onclick')) return n;
      if (n.tagName === 'INPUT' && /^(submit|button|image|checkbox|radio)$/i.test(n.type)) return n;
      try { if (getComputedStyle(n).cursor === 'pointer') return n; } catch (e) {}
    }
    return null;
  }
  function marcaAtivo() {
    var t = Date.now();
    if (pag.ultimoAtivo && t - pag.ultimoAtivo < 5000) pag.ativo += t - pag.ultimoAtivo;
    pag.ultimoAtivo = t;
  }

  // ---------- envio ----------
  function meta(extra) {
    var m = {
      v: 1, sid: sid, vid: vid(), pg: pg, seq: seq++, caminho: caminho, z: 0,
      pag: { cliques: pag.cliques, rolagem: pag.rolagem, ativo: pag.ativo, t_ini: inicioPag, carga: carga() },
      sinais: sinais.splice(0, sinais.length)
    };
    if (pg === 0) { // ini em TODO lote da página de entrada: se o 1º (seq=0) cair, a sessão não fica sem aparelho/UTM
      var q = new URLSearchParams(location.search);
      m.ini = {
        ua: corta(navigator.userAgent, 300), tela: screen.width + 'x' + screen.height,
        vp: innerWidth + 'x' + innerHeight, lang: navigator.language || '',
        ref: (function () { try { return document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { return ''; } })(),
        utm_source: corta(q.get('utm_source'), 100), utm_medium: corta(q.get('utm_medium'), 100),
        utm_campaign: corta(q.get('utm_campaign'), 150), utm_content: corta(q.get('utm_content'), 150),
        ttclid: q.has('ttclid') ? 1 : 0,
        session_cloacker: (function () { try { var c = document.cookie.match(/(?:^|; )fx_cs=([^;]*)/); return c ? decodeURIComponent(c[1]).slice(0, 64) : ''; } catch (e) { return ''; } })()
      };
    }
    for (var k in extra) m[k] = extra[k];
    return m;
  }
  function corpo(m, dados) { return new Blob([JSON.stringify(m) + '\n', dados], { type: 'text/plain' }); }
  // devolve o status HTTP (0 = sem resposta)
  function manda(b) {
    try {
      return fetch(ENDPOINT, { method: 'POST', body: b, keepalive: b.size < BEACON_MAX, credentials: 'same-origin' })
        .then(function (r) { return r.status; }, function () { return 0; });
    } catch (e) { return Promise.resolve(0); }
  }
  function post(b) {
    manda(b).then(function (st) {
      if (st === 403 || st === 410) desligar();
      else if (st === 429 || st >= 500 || st === 0) devagar = Math.min(240000, devagar < LOTE_MS ? LOTE_MS : devagar * 2);
      else devagar = 0;
    });
  }
  function gzip(texto) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var s = new Blob([texto]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(s).blob();
    } catch (e) { return Promise.resolve(null); }
  }
  // Lote grande sai em PEDAÇOS que caibam no CORPO_MAX com folga (o servidor recusa > 1,6 MB e o lote
  // inteiro entre 1,5 e 6 MB era descartado em silêncio). Cada pedaço tem seq própria: o servidor grava
  // cada um como uma "parte" da mesma página, na ordem que chegou. Em 429/500 o que sobrou volta pra fila
  // (um mesmo pedaço reenviado pode gerar seq nova e repetir trecho — o caso é raro; antes era perda total).
  function fatiar(evs) {
    var pedacos = [], atual = [], txt = '', n = 0;
    for (var i = 0; i < evs.length; i++) {
      var s = JSON.stringify(evs[i]);
      if (n && txt.length + s.length > LOTE_CHARS) { pedacos.push({ ev: atual, txt: '[' + txt + ']', n: n }); atual = []; txt = ''; n = 0; }
      txt += (n ? ',' : '') + s; atual.push(evs[i]); n++;
    }
    pedacos.push({ ev: atual, txt: '[' + txt + ']', n: n });
    return pedacos;
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (morto || (!fila.length && !sinais.length)) return;
    var pedacos = fatiar(fila.splice(0, fila.length));
    (function enviar(i) {
      if (i >= pedacos.length || morto) return;
      var p = pedacos[i];
      var m = meta(p.n ? { t0: p.ev[0].timestamp, t1: p.ev[p.n - 1].timestamp } : {});
      gzip(p.txt).then(function (gz) {
        if (morto) return;
        var b;
        if (gz && gz.size <= CORPO_MAX) { m.z = 1; b = corpo(m, gz); }
        else if (p.txt.length <= CORPO_MAX) b = corpo(m, p.txt);
        if (!b) { desligar(); return; } // pedaço que não cabe nem cru (evento único gigante): desliga
        manda(b).then(function (st) {
          if (st === 403 || st === 410) { desligar(); return; }
          if (st === 429 || st >= 500 || st === 0) { // devagar: devolve o resto para o próximo flush
            devagar = Math.min(240000, devagar < LOTE_MS ? LOTE_MS : devagar * 2);
            fila = pedacos.slice(i).concat(fila);
            return;
          }
          devagar = 0;
          enviar(i + 1);
        });
      });
    })(0);
  }
  // Saída da página: síncrono (sendBeacon), sem gzip, em partes de até 60 KB.
  function flushSaida() {
    if (morto) return;
    marcaAtivo();
    if (form.ultimo) { sinal('abandono', { alvo: form.ultimo, pagina: caminho }); form.ultimo = ''; }
    var ev = fila.splice(0, fila.length);
    var partes = [], atual = [], tam = 0;
    for (var i = 0; i < ev.length; i++) {
      var s = JSON.stringify(ev[i]);
      if (tam + s.length > BEACON_MAX - 4000 && atual.length) { partes.push(atual); atual = []; tam = 0; }
      atual.push(ev[i]); tam += s.length;
    }
    if (atual.length || !partes.length) partes.push(atual);
    partes.forEach(function (p, i) {
      var m = meta(p.length ? { t0: p[0].timestamp, t1: p[p.length - 1].timestamp } : {});
      if (i === partes.length - 1) m.fim = 1;
      var b = corpo(m, JSON.stringify(p));
      try { if (b.size < BEACON_MAX && navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, b)) return; } catch (e) {}
      post(b);
    });
  }
  function desligar() { morto = true; try { if (parar) parar(); } catch (e) {} fila = []; }

  // ---------- eventos rrweb ----------
  function emit(e) {
    if (morto) return;
    try {
      if (e.type === 4 && e.data && e.data.href) e.data.href = limparUrl(e.data.href);
      if (e.type === 2 && e.data) limparNo(e.data.node); // snapshot completo: href/src dos elementos
      if (e.type === 3 && e.data) {
        var src = e.data.source;
        if (src === 3 || src === 5) reacao = e.timestamp; // rolagem e digitação são sempre resposta do usuário
        else if (src === 0) {
          // Mutação DOM: contador animado ("347 assistindo") gira SOZINHO — sem clique não é reação. Conta
          // só se vier até 1 s depois de um clique pendente (a página respondeu ao clique).
          (e.data.attributes || []).forEach(function (x) { limparAttrs(x && x.attributes); });
          (e.data.adds || []).forEach(function (x) { limparNo(x && x.node); });
          if (cliquePendente && e.timestamp - cliquePendente < 1000) { reacao = e.timestamp; cliquePendente = 0; }
        }
      }
      // Console: o plugin já pega console.error/warn, erro não tratado e promise rejeitada.
      if (e.type === 6 && e.data && e.data.plugin === 'rrweb/console@1' && e.data.payload) {
        var lg = e.data.payload;
        lg.payload = (lg.payload || []).map(function (x) { return filtrar(corta(x, 500)); });
        lg.trace = (lg.trace || []).slice(0, 5).map(function (x) { return filtrar(corta(x, 300)); });
        if (lg.level === 'error') {
          erroVisto(lg.payload.map(function (x) { return x.replace(/^"|"$/g, ''); }).join(' '), lg.trace[0] || '');
        }
      }
      fila.push(e);
      if (e.type === 2) { setTimeout(flush, 50); return; } // snapshot completo sai logo
      if (fila.length >= LOTE_MAX_EV) flush();
      else if (!timer) timer = setTimeout(flush, LOTE_MS + devagar);
    } catch (err) { desligar(); }
  }

  var errosVistos = {};
  var RUIDO = /^Script error\.?$|ResizeObserver loop|AutofillPlugin/i;
  function erroVisto(msg, origem) {
    msg = corta(msg, 300);
    if (!msg || RUIDO.test(msg) || errosVistos[msg] && Date.now() - errosVistos[msg] < 1000) return;
    errosVistos[msg] = Date.now();
    // B7: sem isso o mapa cresce sem limite na aba aberta por horas
    if (Object.keys(errosVistos).length > 40) { var corte = Date.now() - 300000; for (var k in errosVistos) if (errosVistos[k] < corte) delete errosVistos[k]; }
    sinal('erro', { msg: msg, alvo: corta(origem, 200), pagina: caminho });
    if (Date.now() - ultimoClique < 1000) sinal('erro_clique', { msg: msg, pagina: caminho });
  }

  // ---------- sinais de comportamento ----------
  function aoClicar(ev) {
    var t = Date.now(), el = ev.target;
    ultimoClique = t;
    pag.cliques++;
    marcaAtivo();
    var x = ev.clientX || 0, y = ev.clientY || 0;
    cliques = cliques.filter(function (c) { return t - c.t < 1500 && Math.abs(c.x - x) < 40 && Math.abs(c.y - y) < 40; });
    cliques.push({ t: t, x: x, y: y });
    if (cliques.length === 3) sinal('raiva', { alvo: alvo(el), texto: textoDe(el), pagina: caminho });
    if (el && /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) return;
    var foco = interativo(el);
    if (!foco) return;
    cliquePendente = t; // espera a página responder: mutação DOM em ~1 s conta como reação (B5)
    if (foco.tagName !== 'LABEL') form.ultimo = ''; // clicou em botão/link depois de preencher: seguiu em frente
    var antes = reacao;
    setTimeout(function () {
      if (morto || document.visibilityState === 'hidden' || reacao !== antes || saindo) return;
      var a = alvo(foco);
      if (ultimoMorto.a === a && t - ultimoMorto.t < 2000) return; // rajada no mesmo botão = 1 clique morto
      ultimoMorto = { a: a, t: t };
      sinal('morto', { alvo: a, texto: textoDe(foco), pagina: caminho });
    }, 1000);
  }

  function aoRolar() {
    marcaAtivo();
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var pct = h > innerHeight ? Math.round((scrollY + innerHeight) / h * 100) : 100;
    if (pct > pag.rolagem) pag.rolagem = Math.min(100, pct);
  }

  function nomeCampo(el) {
    if (!el || !el.tagName) return '';
    var id = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.type || '';
    return corta(el.tagName.toLowerCase() + '[' + id + ']', 80);
  }

  // Volta rápida: ficou < 10 s numa página e voltou (botão voltar do navegador/celular).
  function veioDoVoltar() {
    try { var n = performance.getEntriesByType('navigation')[0]; return !!n && n.type === 'back_forward'; } catch (e) { return false; }
  }
  function voltaRapida(voltou) {
    var hist;
    try { hist = JSON.parse(ler('sessionStorage', 'fmr_hist') || '[]'); } catch (e) { hist = []; }
    var ant = hist[hist.length - 1];
    if (voltou && ant && ant.c !== caminho && inicioPag - ant.t < 10000) {
      sinais.push({ t: inicioPag, tipo: 'volta_rapida', pagina: ant.c });
    }
    hist.push({ c: caminho, t: inicioPag });
    gravar('sessionStorage', 'fmr_hist', JSON.stringify(hist.slice(-5)));
  }

  // Falha de rede: só método, caminho e status (nunca corpo nem query).
  function rede(metodo, url, status) {
    try {
      var u = new URL(url, location.href);
      if (u.pathname === new URL(ENDPOINT, location.href).pathname) return;
      // POST interno do funil (error-log e afins já pagam sua falha no próprio log) não gera 'rede' duplicado
      if (u.origin === location.origin && (met || 'GET').toUpperCase() === 'POST' && u.pathname.indexOf('/api/') === 0) return;
      sinal('rede', { msg: (metodo || 'GET').toUpperCase() + ' ' + (u.origin === location.origin ? '' : u.host) + u.pathname + ' → ' + (status || 'sem resposta'), pagina: caminho });
    } catch (e) {}
  }
  function vigiarRede() {
    if (window.fetch) {
      var f0 = window.fetch;
      window.fetch = function (inp, init) {
        var url = typeof inp === 'string' ? inp : (inp && inp.url) || '';
        var met = (init && init.method) || (inp && inp.method) || 'GET';
        return f0.apply(this, arguments).then(function (r) { if (r.status >= 400) rede(met, url, r.status); return r; },
          function (err) { rede(met, url, 0); throw err; });
      };
    }
    var X = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (X) {
      var open0 = X.open, send0 = X.send;
      X.open = function (m, u) { this.__fmr = [m, u]; return open0.apply(this, arguments); };
      X.send = function () {
        var x = this;
        x.addEventListener('loadend', function () { if (x.__fmr && (x.status === 0 || x.status >= 400)) rede(x.__fmr[0], x.__fmr[1], x.status); });
        return send0.apply(this, arguments);
      };
    }
  }

  // ---------- início ----------
  function iniciar() {
    var R = window.rrwebRecord, C = window.rrwebPluginConsoleRecord;
    if (!R || !R.record) return;
    voltaRapida(veioDoVoltar());
    document.addEventListener('click', aoClicar, true);
    addEventListener('scroll', aoRolar, { passive: true });
    ['keydown', 'touchstart', 'mousemove'].forEach(function (n) { addEventListener(n, marcaAtivo, { passive: true, capture: true }); });
    // Abandono: campos dentro ou fora de <form> (checkout de funil costuma não ter <form>).
    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(button|submit|reset|checkbox|radio|range|file|image|hidden)$/i.test(el.type || '')) form.ultimo = nomeCampo(el);
    }, true);
    document.addEventListener('submit', function () { form.ultimo = ''; }, true);
    vigiarRede();
    addEventListener('pagehide', function () { saindo = true; flushSaida(); });
    // Voltou pelo cache do navegador (botão voltar): a página não recarrega, então vira uma página nova
    // na sessão, com snapshot completo (senão as mudanças cairiam em cima da página errada no player).
    addEventListener('pageshow', function (e) {
      if (!e.persisted || morto) return;
      saindo = false;
      pg = (Number(ler('sessionStorage', 'fmr_pg')) || 0) + 1;
      gravar('sessionStorage', 'fmr_pg', String(pg));
      gravar('sessionStorage', 'fmr_visto', String(Date.now()));
      seq = 0; inicioPag = Date.now();
      pag = { cliques: 0, rolagem: 0, ativo: 0, ultimoAtivo: 0 };
      restaurada = true; // voltou do cache: não houve carregamento para medir
      form = { ultimo: '' };
      voltaRapida(true);
      try { window.rrwebRecord.record.takeFullSnapshot(true); } catch (err) {}
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { flushSaida(); }
      else gravar('sessionStorage', 'fmr_visto', String(Date.now()));
    });

    // O rrweb guarda só a `class` de um elemento bloqueado; com a classe rr-block o player o pinta de
    // cinza (senão um QR desenhado por CSS da própria classe continuaria aparecendo).
    try { document.querySelectorAll('[data-rr-block]').forEach(function (el) { el.classList.add('rr-block'); }); } catch (e) {}
    var plugins = [];
    if (C && C.getRecordConsolePlugin) {
      plugins.push(C.getRecordConsolePlugin({ level: ['error', 'warn'], lengthThreshold: 200, stringifyOptions: { stringLengthLimit: 500, numOfKeysLimit: 20, depthOfLimit: 2 } }));
    }
    parar = R.record({
      emit: emit,
      plugins: plugins,
      maskAllInputs: true,
      maskInputFn: function (t) { return String(t || '').replace(/./g, '*'); },
      maskTextSelector: '*',
      maskTextFn: mascaraTexto,
      blockSelector: '.rr-block,[data-rr-block],iframe',
      ignoreSelector: '.rr-ignore,[data-rr-ignore]',
      // sem input: 'last' — com ele o rrweb só grava no blur e o campo abandonado ficaria vazio no replay
      sampling: { mousemove: 100, scroll: 150, media: 800 },
      slimDOMOptions: 'all',
      recordCanvas: false,
      collectFonts: false,
      errorHandler: function () { return true; }
    });
  }

  function carregar() {
    var s = document.createElement('script');
    s.src = BASE + 'rrweb-record.min.js?v=2.2.0-1';
    s.async = true;
    s.onload = function () { try { iniciar(); } catch (e) { desligar(); } };
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.readyState === 'complete') carregar();
  else addEventListener('load', carregar);
})();
