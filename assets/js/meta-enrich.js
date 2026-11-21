/* meta-enrich.js — completa a linha de metadados do acesso.
 *
 * A portaria (blindagem.php) ja gravou a linha com o session_cloacker (cookie fx_cs) + UTMs/ttclid.
 * Aqui mandamos o que SO existe no navegador: _ttp (TikTok), _fbp/_fbc (Facebook) e ttclid (reforco),
 * casados pelo fx_cs. Dispara 1x por sessao, via sendBeacon. Falha em silencio (nunca quebra a pagina).
 */
(function () {
  function cookie(nome) {
    try {
      var m = document.cookie.match('(?:^|; )' + nome.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function run() {
    try {
      if (sessionStorage.getItem('fx_meta_ok')) return;

      var cs = cookie('fx_cs');
      if (!cs) return; // acesso sem token do cloaker: nada pra ligar

      var ttclid = cookie('ttclid');
      if (!ttclid) { try { ttclid = localStorage.getItem('ml_ttclid') || ''; } catch (e) {} }

      var body = {
        session_cloacker: cs,
        ttp: cookie('_ttp'),     // TikTok
        fbp: cookie('_fbp'),     // Facebook
        fbc: cookie('_fbc'),     // Facebook
        ttclid: ttclid
      };
      if (!body.ttp && !body.fbp && !body.fbc && !body.ttclid) return; // pixels ainda nao setaram; tenta na proxima pagina

      var json = JSON.stringify(body);
      var url = '/api/metadados.php';
      var enviado = false;
      if (navigator.sendBeacon) {
        try { enviado = navigator.sendBeacon(url, new Blob([json], { type: 'application/json' })); } catch (e) {}
      }
      if (!enviado && window.fetch) {
        fetch(url, { method: 'POST', body: json, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
      }
      sessionStorage.setItem('fx_meta_ok', '1');
    } catch (e) {}
  }

  // espera os pixels (TikTok/Facebook) setarem os cookies antes de enviar
  setTimeout(run, 2500);
})();
