/* error-log.js — manda para /api/log.php os erros que acontecem no navegador do usuario.
   Carregar o mais cedo possivel no <head>. Nunca envia valores de formulario nem a chave PIX.
   Cobre: erros JS, promises rejeitadas, recursos que falharam (script/css/img), fetch com
   falha de rede ou HTTP >= 400, e console.error. Limites: 15 por pagina, 60 por sessao. */
(function () {
  'use strict';
  if (window.__errLogOn) return;
  window.__errLogOn = true;

  var ENDPOINT = '/api/log.php';
  var MAX_PAGE = 15, MAX_SESSION = 60;
  var sent = 0, seen = {}, queue = [], timer = null;

  function sessionCount() {
    try { return parseInt(sessionStorage.getItem('errlog_n') || '0', 10) || 0; } catch (e) { return 0; }
  }
  function bump() {
    try { sessionStorage.setItem('errlog_n', String(sessionCount() + 1)); } catch (e) {}
  }
  function visitor() {
    try { return localStorage.getItem('ttk_vid') || ''; } catch (e) { return ''; }
  }
  function clip(v, n) { v = String(v == null ? '' : v); return v.length > n ? v.slice(0, n) : v; }

  function flush() {
    timer = null;
    if (!queue.length) return;
    var body = JSON.stringify({ events: queue.splice(0, 10) });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    } catch (e) {}
  }

  // Ruido que nao e do site: plugin de autofill do app do TikTok, beacon do Cloudflare, script injetado
  // por terceiros no aparelho, erro de script sem detalhe (cross-origin) e API interna do app.
  var NOISE_MSG = /AutofillPlugin|^Script error\.?$|login-payment requires window\.runtime|ResizeObserver loop/i;
  var NOISE_SRC = /cloudflareinsights\.com|inetstats\.org/i;

  function report(type, message, extra) {
    try {
      message = clip(message, 500);
      if (NOISE_MSG.test(message) || NOISE_SRC.test(String((extra && extra.source) || ''))) return;
      if (!message || sent >= MAX_PAGE || sessionCount() >= MAX_SESSION) return;
      extra = extra || {};
      var key = type + '|' + message + '|' + (extra.source || '') + '|' + (extra.line || '');
      if (seen[key]) return;
      seen[key] = 1;
      sent++; bump();
      var conn = navigator.connection || {};
      queue.push({
        type: type,
        message: message,
        source: clip(extra.source, 300),
        line: extra.line || 0,
        col: extra.col || 0,
        stack: clip(extra.stack, 1500),
        page: clip(location.pathname + location.search, 1000),
        visitor_id: visitor(),
        extra: {
          ref: clip(document.referrer, 120),
          online: navigator.onLine,
          net: conn.effectiveType || '',
          vw: window.innerWidth + 'x' + window.innerHeight,
          lang: navigator.language,
          info: extra.info || ''
        }
      });
      if (!timer) timer = setTimeout(flush, 800);
    } catch (e) { /* o log nunca pode quebrar a pagina */ }
  }

  window.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== window && (t.src || t.href)) {
      report('resource_error', 'Falha ao carregar ' + (t.tagName || '').toLowerCase(), { source: t.src || t.href });
      return;
    }
    report('js_error', ev.message || 'Erro de script', {
      source: ev.filename, line: ev.lineno, col: ev.colno, stack: ev.error && ev.error.stack
    });
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    report('promise_rejection', (r && (r.message || r)) || 'Promise rejeitada', { stack: r && r.stack });
  });

  // fetch: falha de rede ou HTTP >= 400 (o proprio endpoint de log e ignorado)
  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/log.php') !== -1) return nativeFetch.apply(this, arguments);
      return nativeFetch.apply(this, arguments).then(function (res) {
        if (res && res.status >= 400) {
          var base = 'HTTP ' + res.status + ' em ' + url.split('?')[0];
          var action = (url.match(/action=([a-z]+)/) || [])[1] || '';
          var done = function (reason) {
            report('http_error', base + (action ? ' [' + action + ']' : '') + (reason ? ': ' + reason : ''), { source: url.split('?')[0], info: 'status ' + res.status });
          };
          try {
            res.clone().json().then(function (j) { done(j && j.error ? clip(j.error, 120) : ''); }, function () { done(''); });
          } catch (e) { done(''); }
        }
        return res;
      }, function (err) {
        report('fetch_error', (err && err.message) || 'Falha de rede', { source: url.split('?')[0], stack: err && err.stack });
        throw err;
      });
    };
  }

  // console.error das proprias paginas
  if (window.console && console.error) {
    var nativeErr = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length && i < 3; i++) {
          var a = arguments[i];
          parts.push(a && a.message ? a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)));
        }
        report('console_error', parts.join(' '), {});
      } catch (e) {}
      return nativeErr.apply(console, arguments);
    };
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  window.errLog = report; // uso manual: errLog('tipo', 'mensagem', {info:'...'})
})();
