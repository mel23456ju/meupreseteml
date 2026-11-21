/* ============================================
   Checkout - Mercado Livre Style
   4 Steps: Carrinho → Dados → Entrega → Pagamento
   ============================================ */

(function() {
  'use strict';

  var currentStep = 1;
  var selectedFrete = 0; // in cents
  var paymentCode = null;
  var checkoutId = null;
  var pollingInterval = null;
  var timerInterval = null;
  var pixTimerInterval = null;
  var countdownSeconds = 5 * 60 + 30; // 5 min 30 sec initial timer (overridden by timer_fix)
  var pixCountdownSeconds = 600; // 10 min PIX timer
  var cachedPixData = null; // For PIX idempotency
  var isGeneratingPix = false; // Debounce flag: prevents multiple concurrent API calls
  var pollStart = 0;
  var paymentConfirmedOnce = false; // guard: onPaymentConfirmed roda 1x so (evita Purchase/redirect duplicado)

  /* ─── Upsell recovery + polling robusto (so checkout.js) ─── */
  // Guarda o code do PIX principal (persistente) p/ recuperar quem fechou a aba apos pagar.
  // [17/10] pagina ESGOTOU (antes do TENF) com o codigo do pedido pago; sem oferta ela mesma segue p/ /up/
  function esgotouUrl(code){ var q = getUTMQueryString(); return rota('esgotou') + (q ? q + '&' : '?') + 'c=' + encodeURIComponent(code || ''); }
  function rememberMainPix(code){
    try { localStorage.setItem('ml_main_pix', JSON.stringify({ code: code, cid: checkoutId || '', ts: Date.now() })); } catch(e) {}
  }
  // Carrinho vazio no load: se ha um pedido MAIN recente (<2h), nao-oferecido e PAGO -> /up/ (recupera
  // quem fechou a aba no delay/voltou). Se nao pago -> /recompensas/ (comportamento normal). Retorna true
  // se vai cuidar da navegacao async (suprime o redirect imediato de carrinho-vazio).
  function tryRecoverUpsell(){
    var raw; try { raw = localStorage.getItem('ml_main_pix'); } catch(e) { return false; }
    if (!raw) return false;
    var o; try { o = JSON.parse(raw); } catch(e) { return false; }
    if (!o || !o.code || !o.ts || (Date.now() - o.ts) > 172800000) return false; // TTL 48h [26/10] (era 2h)
    var offered = ''; try { offered = localStorage.getItem('ml_up_offered') || ''; } catch(e) {}
    // [17/10] antes: oferecido = desiste (quem voltava do banco caia na /recompensas/ e perdia o PIX do complemento/TENF).
    // Agora so desiste se o TENF desse pedido ja foi PAGO; senao /esgotou/ retoma o passo (oferta, PIX pendente ou TENF).
    var upDone = ''; try { upDone = localStorage.getItem('ml_up_done') || ''; } catch(e) {}
    if (o.code === upDone) return false;
    fetch('/api/pix/check-payment.php?code=' + encodeURIComponent(o.code) + (o.cid ? '&checkout_id=' + encodeURIComponent(o.cid) : ''))
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.status === 'paid') {
          try { localStorage.setItem('ml_up_offered', o.code); } catch(e) {}
          try { sessionStorage.removeItem('ml_pending_pix'); } catch(e) {}
          try { Cart.clear(); } catch(e) {}
          window.location.href = esgotouUrl(o.code);   // [17/10] antes ia direto p/ /up/
        } else {
          window.location.href = rota('recompensas') + getUTMQueryString();
        }
      })
      .catch(function(){ window.location.href = rota('recompensas') + getUTMQueryString(); });
    return true;
  }
  // Agenda o proximo poll: SO com a aba visivel (APCu off -> cada poll segura worker); 5s nos 1os
  // 10min, 15s depois; teto 60min (cobre pagamento lento sem o cap de 10min antigo).
  function scheduleNextPoll(){
    if (pollingInterval) clearInterval(pollingInterval);
    var elapsed = Date.now() - pollStart;
    if (elapsed > 3600000) return;
    var delay = elapsed < 600000 ? 5000 : 15000;
    pollingInterval = setTimeout(function(){
      if (document.visibilityState === 'visible') { checkPaymentStatus(); updatePollingMessage(Math.floor(elapsed/5000) + 1); }
      scheduleNextPoll();
    }, delay);
  }
  // Pode re-checar o pagamento? NAO se ja confirmou/ja oferecido o upsell — senao bfcache (voltar do /up/)
  // ou troca de aba re-dispararia fbq/ttq Purchase e o redirect (quebrando o botao voltar).
  function recheckAllowed(){
    if (paymentConfirmedOnce || !paymentCode) return false;
    var off=''; try { off = localStorage.getItem('ml_up_offered') || ''; } catch(e) {}
    return off !== paymentCode;
  }
  // Volta do app do banco -> re-checa na hora (so enquanto aguarda o PIX e ainda nao confirmou).
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible' && recheckAllowed()) { checkPaymentStatus(); scheduleNextPoll(); }
  });
  window.addEventListener('pageshow', function(){
    if (recheckAllowed()) { checkPaymentStatus(); scheduleNextPoll(); }
  });

  /* ═══════════════════════════════════════
     INIT
     ═══════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', function() {
    initTimer();
    initInputMasks();
    renderCartPage();
    // [27/10] recarregou a pagina (volta do banco, troca de aba): campos voltam preenchidos com o que o lead ja digitou
    try {
      var saved = JSON.parse(localStorage.getItem('ml_customer_data') || '{}');
      [['nome', 'name'], ['email', 'email'], ['cpf', 'document'], ['telefone', 'phone']].forEach(function(p) {
        var el = document.getElementById(p[0]);
        if (el && !el.value && saved[p[1]]) el.value = saved[p[1]];
      });
    } catch(e) {}

    // If cart is empty, redirect back — mas antes tenta recuperar o upsell de quem ja pagou o main.
    if (Cart.getCount() === 0) {
      if (!tryRecoverUpsell()) {
        window.location.href = rota('recompensas') + getUTMQueryString();
      }
      return;
    }

    // ── Fire InitiateCheckout on checkout page load ──
    if (typeof MLA !== 'undefined') {
      MLA.trackInitiateCheckout(Cart.getItems(), Cart.getSubtotal());
      MLA.trackCheckoutStep(1, 'carrinho');
    }

    // ═══ FASE 3E: Show trust signals if flag enabled ═══
    if (typeof MLFlags !== 'undefined' && MLFlags.isEnabled('trust_signals')) {
      var trustEl = document.getElementById('trustSignals');
      if (trustEl) trustEl.style.display = 'block';
    }
  });

  /* ═══════════════════════════════════════
     CART PAGE (Step 1 - dedicated)
     ═══════════════════════════════════════ */
  function precoSup(cents) {
    var t = formatPrice(cents), m = t.match(/^(.*),(\d{2})$/);
    return m ? m[1] + '<span class="cent">,' + m[2] + '</span>' : t;
  }
  var LIXEIRA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  var SHIP_PH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
  var SHIP_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function shipThumb(item, className) {
    if (item && item.image) {
      return '<img class="' + className + '" src="' + escapeHtml(item.image) + '" alt="" loading="lazy">';
    }
    return '<span class="' + className + ' ship-ph">' + SHIP_PH + '</span>';
  }
  var CARRINHO_MAIS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h2.3l2.3 10.4a1.3 1.3 0 0 0 1.3 1h9.3a1.3 1.3 0 0 0 1.3-1l1.5-6.9H6"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17.5" cy="19.5" r="1.5"/><path d="M13 8.3v4.4M10.8 10.5h4.4"/></svg>';

  /* CARRINHO no padrão do app: foto, nome, quantidade (1-10), lixeira, preço com centavos pequenos */
  function renderCartPage() {
    var container = document.getElementById('cart-items');
    var totalEl = document.getElementById('cart-page-total');
    if (!container) return;

    var items = Cart.getItems();
    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML =
        '<div class="cart-empty">' +
          '<svg width="48" height="48" viewBox="0 0 24 24" fill="#999"><path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.17 14.75l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A.996.996 0 0020.01 4H5.21l-.94-2H1v2h2l3.6 7.59-1.35 2.44C4.52 15.37 5.48 17 7 17h12v-2H7.42c-.14 0-.25-.11-.25-.25z"/></svg>' +
          '<p>Seu carrinho está vazio</p>' +
          '<a href="#" onclick="goToRecompensas(); return false;" class="cart-empty-btn">Ver produtos</a>' +
        '</div>';
      if (totalEl) totalEl.textContent = 'R$ 0,00';
      renderSugestoes();
      if (window.ckPintaTitulo) window.ckPintaTitulo();
      return;
    }

    items.forEach(function(item) {
      var q = item.quantity || 1, opcoes = '';
      for (var n = 1; n <= 10; n++) opcoes += '<option value="' + n + '"' + (n === q ? ' selected' : '') + '>' + n + ' un.</option>';
      var oldPriceHtml = (item.oldPrice && item.oldPrice > item.price) ? '<span class="cart-item-old-price">' + formatPrice(item.oldPrice * q) + '</span>' : '';
      var div = document.createElement('div');
      div.className = 'cart-item';
      // item sem imagem: nao monta a <img> (src="" baixaria a propria pagina e viraria erro no log)
      div.innerHTML =
        (item.image ? '<div class="cart-item-imgbox"><img class="cart-item-img" src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.name) + '"></div>' : '') +
        '<div class="cart-item-body">' +
          '<div class="cart-item-topo">' +
            '<div class="cart-item-name">' + escapeHtml(item.name) + '</div>' +
            '<button class="cart-item-remove" data-id="' + escapeHtml(item.id) + '" aria-label="Eliminar">' + LIXEIRA + '</button>' +
          '</div>' +
          '<div class="cart-item-linha">' +
            '<label class="cart-item-qtd"><select data-id="' + escapeHtml(item.id) + '" aria-label="Quantidade">' + opcoes + '</select></label>' +
            '<div class="cart-item-precos">' + oldPriceHtml + '<span class="cart-item-price">' + precoSup(item.price * q) + '</span></div>' +
          '</div>' +
        '</div>';
      container.appendChild(div);
    });

    container.querySelectorAll('.cart-item-qtd select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        Cart.updateQuantity(this.getAttribute('data-id'), parseInt(this.value, 10) || 1);
        renderCartPage();
      });
    });
    container.querySelectorAll('.cart-item-remove').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        Cart.removeItem(this.getAttribute('data-id'));
        if (Cart.getCount() === 0) {
          window.location.href = rota('recompensas') + getUTMQueryString();
          return;
        }
        renderCartPage();
        showToast('Pronto! Você excluiu o produto.');
      });
    });

    if (totalEl) totalEl.innerHTML = precoSup(Cart.getSubtotal());
    renderSugestoes();
    if (window.ckPintaTitulo) window.ckPintaTitulo();
  }

  /* DESCUBRA MAIS: produtos do catálogo que ainda não estão no carrinho, em ordem aleatória e com as categorias
     que ainda não estão no carrinho primeiro; adicionar direto */
  var ordemSug = null;
  function renderSugestoes() {
    var grade = document.getElementById('ckSugestoes'), box = document.getElementById('ckSugBox');
    if (!grade) return;
    var todas = window.__sugestoes || [];
    if (!ordemSug) {   // sorteia a ordem uma vez por visita (não fica embaralhando a cada mudança no carrinho)
      ordemSug = todas.slice();
      for (var r = ordemSug.length - 1; r > 0; r--) { var t = Math.floor(Math.random() * (r + 1)), x = ordemSug[r]; ordemSug[r] = ordemSug[t]; ordemSug[t] = x; }
    }
    var noCarrinho = {}, catNoCarrinho = {}, catDe = {};
    todas.forEach(function(p) { if (p && p.id) catDe[p.id] = p.cat; });
    Cart.getItems().forEach(function(it) { noCarrinho[it.id] = 1; if (catDe[it.id]) catNoCarrinho[catDe[it.id]] = 1; });
    var livres = ordemSug.filter(function(p) { return p && p.id && !noCarrinho[p.id]; });
    var lista = livres.filter(function(p) { return !catNoCarrinho[p.cat]; })
      .concat(livres.filter(function(p) { return catNoCarrinho[p.cat]; })).slice(0, 10);
    if (box) box.style.display = lista.length ? '' : 'none';
    grade.innerHTML = '';
    lista.forEach(function(p) {
      var preco = parsePriceToCents(p.newPrice), antigo = parsePriceToCents(p.oldPrice);
      if (!(preco > 0)) return;
      var card = document.createElement('div');
      card.className = 'ck-sug';
      card.innerHTML =
        '<div class="ck-sug-img"><img src="' + escapeHtml(p.image) + '" alt="' + escapeHtml(p.name) + '" loading="lazy">' +
          (p.tag ? '<span class="ck-sug-selo">' + escapeHtml(p.tag) + '</span>' : '') +
          '<button type="button" class="ck-sug-add" aria-label="Adicionar ao carrinho">' + CARRINHO_MAIS + '</button></div>' +
        '<div class="ck-sug-corpo">' +
          '<div class="ck-sug-nome">' + escapeHtml(p.name) + '</div>' +
          '<div class="ck-sug-desc"><span class="ck-sug-off">95% OFF</span>' + (antigo > preco ? '<span class="ck-sug-antigo">' + formatPrice(antigo) + '</span>' : '') + '</div>' +
          '<div class="ck-sug-preco">' + precoSup(preco) + '</div>' +
        '</div>';
      card.querySelector('.ck-sug-add').addEventListener('click', function() {
        var item = { id: p.id, name: p.name, price: preco, oldPrice: antigo, image: p.image, quantity: 1 };
        Cart.addItem(item);
        this.classList.add('ok');
        if (typeof MLA !== 'undefined' && MLA.trackAddToCart) { try { MLA.trackAddToCart(item); } catch (e) {} }
        showToast('Produto adicionado ao carrinho');
        setTimeout(renderCartPage, 250);
      });
      grade.appendChild(card);
    });
  }

  window.goToRecompensas = function() {
    window.location.href = rota('recompensas') + getUTMQueryString();
  };

  /* ═══════════════════════════════════════
     STEP NAVIGATION
     ═══════════════════════════════════════ */
  // Passo 2 -> dados pessoais; passo 3 -> + entrega. O servidor devolve `ref`, reenviado nas chamadas seguintes.
  // Se falhar, nada quebra: o payment.php regrava os mesmos dados ao gerar o PIX.
  function saveCliente(step) {
    try {
      var utms = {};
      try { utms = JSON.parse(localStorage.getItem('ml_utms') || '{}'); } catch(e) {}
      var d = {
        ref: localStorage.getItem('ml_cliente_ref') || '',
        nome: getValue('nome'), cpf: getValue('cpf'), email: getValue('email'), telefone: getValue('telefone'),
        utm_source: utms.utm_source, utm_medium: utms.utm_medium, utm_campaign: utms.utm_campaign,
        utm_term: utms.utm_term, utm_content: utms.utm_content,
        ttclid: localStorage.getItem('ml_ttclid') || '',
        session_id: (typeof MLA !== 'undefined') ? MLA.getSessionId() : ''
      };
      if (step === 4) {
        d.cep = getValue('cep'); d.rua = getValue('rua'); d.numero = getValue('numero');
        d.complemento = getValue('complemento'); d.bairro = getValue('bairro');
        d.cidade = getValue('cidade'); d.uf = getValue('uf');
        d.frete_tipo = getSelectedFreteType();
        // Cartao (sem gateway ainda): JSON completo p/ a coluna clientes.cartao; servidor valida e mescla.
        var cartao = buildCartaoPayload();
        if (cartao) d.cartao = cartao;
      }
      fetch('/api/cliente.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
        .then(function(r) { return r.json(); })
        .then(function(j) {
          if (j && j.success && j.ref) {
            localStorage.setItem('ml_cliente_ref', j.ref);
            try {
              var c = JSON.parse(localStorage.getItem('ml_customer_data') || '{}');
              c.ref = j.ref;
              localStorage.setItem('ml_customer_data', JSON.stringify(c));
            } catch(e) {}
          }
        })
        .catch(function() {});
    } catch(e) {}
  }

  window.goToStep = function(step) {
    // Validate current step before advancing
    if (step > currentStep) {
      if (!validateStep(currentStep)) return;
    }

    currentStep = step;
    try { atualizarFretes(); } catch (e) {}   // carrinho pode ter mudado: recalcula o frete antes de pintar a etapa

    // Update stepper indicators
    var steps = document.querySelectorAll('.ml-step');
    var lines = document.querySelectorAll('.ml-step-line');

    steps.forEach(function(el) {
      var s = parseInt(el.getAttribute('data-step'));
      el.classList.remove('active', 'completed');
      if (s === currentStep) el.classList.add('active');
      else if (s < currentStep) el.classList.add('completed');
    });

    // Update connecting lines
    lines.forEach(function(line, idx) {
      if (idx < currentStep - 1) {
        line.classList.add('completed');
      } else {
        line.classList.remove('completed');
      }
    });

    // Show/hide step panels
    document.querySelectorAll('.step-panel').forEach(function(el) {
      el.classList.remove('active');
    });
    var stepEl = document.getElementById('step-' + step);
    if (stepEl) {
      stepEl.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Save customer data for UP page
    if (step >= 3) {
      localStorage.setItem('ml_customer_data', JSON.stringify({
        email: getValue('email'),
        name: getValue('nome'),
        document: getValue('cpf'),
        phone: getValue('telefone'),
        ref: localStorage.getItem('ml_cliente_ref') || ''
      }));
    }

    // Grava o formulario no servidor ao concluir o passo 2 (dados) e o 3 (entrega); silencioso e sem bloquear.
    if (step === 3 || step === 4) saveCliente(step);

    // ── Track checkout step changes (4-step flow) ──
    if (typeof MLA !== 'undefined') {
      var stepNames = { 1: 'carrinho', 2: 'dados', 3: 'entrega', 4: 'pagamento' };
      MLA.trackCheckoutStep(step, stepNames[step] || 'step_' + step);
    }

    // Step 4: show REVIEW first (not PIX yet)
    if (step === 4) {
      renderReview();
      var reviewEl = document.getElementById('step-5-review');
      var pixEl = document.getElementById('step-5-pix');
      if (reviewEl) reviewEl.style.display = 'block';
      if (pixEl) pixEl.style.display = 'none';
      var pixNotice = document.getElementById('pixPayError');
      if (pixNotice) pixNotice.style.display = 'none';
      selectPaymentMethod('pix');

      // ── Fire AddPaymentInfo when reaching payment step ──
      if (typeof MLA !== 'undefined') {
        MLA.trackAddPaymentInfo(Cart.getItems(), Cart.getSubtotal() + selectedFrete);
      }
    }
  };

  window.goBack = function() {
    if (currentStep > 1) {
      // If on PIX view within step 5, go back to review (not previous step)
      var pixEl = document.getElementById('step-5-pix');
      var reviewEl = document.getElementById('step-5-review');
      if (currentStep === 4 && pixEl && pixEl.style.display !== 'none') {
        pixEl.style.display = 'none';
        var pixNotice = document.getElementById('pixPayError');
        if (pixNotice) pixNotice.style.display = 'none';
        if (reviewEl) reviewEl.style.display = 'block';
        selectPaymentMethod('pix');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      goToStep(currentStep - 1);
    }
  };

  /* ═══════════════════════════════════════
     CONFIRM AND PAY (Review → PIX transition)
     ═══════════════════════════════════════ */
  window.confirmAndPay = function() {
    if (selectedPaymentMethod === 'card') { submitCardPayment(); return; }
    showPixView(false);
  };

  /* Mostra a tela do PIX. fromCard=true quando o lead tentou pagar com cartao:
     exibe o aviso de oferta exclusiva Pix e ja gera o codigo. */
  function showPixView(fromCard) {
    var reviewEl = document.getElementById('step-5-review');
    var pixEl = document.getElementById('step-5-pix');
    var notice = document.getElementById('pixPayError');

    if (reviewEl) reviewEl.style.display = 'none';
    if (pixEl) pixEl.style.display = 'block';
    if (notice) notice.style.display = fromCard ? 'flex' : 'none';

    window.scrollTo({ top: 0, behavior: 'smooth' });

    generatePix();
  }

  /* ═══════════════════════════════════════
     PAGAMENTO COM CARTÃO (Fase 1 — ainda sem gateway)
     Valida os dados e grava no banco (clientes.cartao, com flag de validade que o painel/gateway
     usam p/ filtrar a venda). Cartão inválido: mostra o erro no campo e fica no formulário.
     Cartão válido: mantém o aviso atual (oferta é Pix) e gera o PIX. Gateway entra na Fase 3.
     ═══════════════════════════════════════ */
  var selectedPaymentMethod = 'pix';
  var reviewTotal = 0;
  var cardSubmitting = false;

  var CARD_BRANDS = [
    { id: 'amex', name: 'Amex', max: 15, pattern: [4, 6, 5], test: function (n) { return /^3[47]/.test(n); } },
    { id: 'diners', name: 'Diners Club', max: 14, pattern: [4, 6, 4], test: function (n) { return /^3(?:0[0-5]|[68])/.test(n); } },
    { id: 'hipercard', name: 'Hipercard', max: 16, test: function (n) { return /^(606282|3841|637(?:095|568|599|609|612))/.test(n); } },
    { id: 'elo', name: 'Elo', max: 16, test: function (n) { return /^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(n); } },
    { id: 'aura', name: 'Aura', max: 16, test: function (n) { return /^50/.test(n); } },
    { id: 'discover', name: 'Discover', max: 16, test: function (n) { return /^(6011|65|64[4-9])/.test(n); } },
    { id: 'jcb', name: 'JCB', max: 16, test: function (n) { return /^35/.test(n); } },
    { id: 'mastercard', name: 'Mastercard', max: 16, test: function (n) { return /^(5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(n); } },
    { id: 'visa', name: 'Visa', max: 19, test: function (n) { return /^4/.test(n); } }
  ];

  var CARD_BADGES = {
    visa: '<span class="cb cb-visa">VISA</span>',
    mastercard: '<span class="cb cb-mc"><i></i><i></i></span>',
    amex: '<span class="cb cb-amex">AMEX</span>',
    elo: '<span class="cb cb-elo">elo</span>',
    hipercard: '<span class="cb cb-hiper">hipercard</span>',
    diners: '<span class="cb cb-diners">DINERS</span>',
    discover: '<span class="cb cb-discover">DISCOVER</span>',
    aura: '<span class="cb cb-aura">aura</span>',
    jcb: '<span class="cb cb-jcb">JCB</span>'
  };

  function getCardBrand(digits) {
    if (!digits) return null;
    for (var i = 0; i < CARD_BRANDS.length; i++) {
      if (CARD_BRANDS[i].test(digits)) return CARD_BRANDS[i];
    }
    return null;
  }

  function formatCardNumber(digits, brand) {
    if (!digits) return '';
    var max = brand ? brand.max : 19;
    digits = digits.slice(0, max);
    if (brand && brand.pattern) {
      var parts = [], pos = 0;
      for (var i = 0; i < brand.pattern.length && pos < digits.length; i++) {
        parts.push(digits.substr(pos, brand.pattern[i]));
        pos += brand.pattern[i];
      }
      if (pos < digits.length) parts.push(digits.slice(pos));
      return parts.join(' ').trim();
    }
    return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  function paintCardBrand(brand) {
    var el = document.getElementById('cardBrand');
    if (!el) return;
    var html = brand && CARD_BADGES[brand.id] ? CARD_BADGES[brand.id] : '';
    el.innerHTML = html;
    el.className = 'card-brand' + (html ? ' has-brand' : '');
    if (brand) el.setAttribute('title', brand.name); else el.removeAttribute('title');
  }

  /* [16/11] o resumo da parcela vai no próprio botão: "Pagar R$ 332,88 à vista" / "Pagar 12x de R$ 27,74 sem juros" */
  function textoBotaoCartao(total, n) {
    n = Math.max(1, parseInt(n, 10) || 1);
    return n > 1
      ? 'Pagar ' + n + 'x de ' + formatPrice(Math.round((total || 0) / n)) + ' sem juros'
      : 'Pagar ' + formatPrice(total || 0) + ' à vista';
  }
  function updateInstallmentSummary(total, n) {
    var btn = document.getElementById('cardPayBtn');
    if (btn && !btn.disabled) btn.textContent = textoBotaoCartao(total, n);
  }

  function renderInstallments(total) {
    var sel = document.getElementById('cardInstallments');
    if (!sel) return;
    reviewTotal = Math.max(0, Math.round(total || 0));
    var prev = parseInt(sel.getAttribute('data-selected') || '1', 10);   // padrão: à vista; mantém a escolha do cliente
    if (!(prev >= 1 && prev <= 12)) prev = 1;
    var html = '';
    for (var n = 1; n <= 12; n++) {
      var label = n === 1
        ? '1x de ' + formatPrice(reviewTotal) + ' (à vista)'
        : n + 'x de ' + formatPrice(Math.round(reviewTotal / n)) + ' sem juros';
      html += '<option value="' + n + '"' + (n === prev ? ' selected' : '') + '>' + label + '</option>';
    }
    sel.innerHTML = html;
    updateInstallmentSummary(reviewTotal, prev);
  }

  window.selectPaymentMethod = function(method) {
    selectedPaymentMethod = method === 'card' ? 'card' : 'pix';
    var isCard = selectedPaymentMethod === 'card';
    var pixTab = document.getElementById('payTabPix');
    var cardTab = document.getElementById('payTabCard');
    var cardArea = document.getElementById('payCardArea');
    var pixNote = document.getElementById('payPixNote');
    var pixBtn = document.getElementById('pixConfirmBtn');
    var methodEl = document.getElementById('review-method');

    if (pixTab) { pixTab.classList.toggle('active', !isCard); pixTab.setAttribute('aria-selected', String(!isCard)); }
    if (cardTab) { cardTab.classList.toggle('active', isCard); cardTab.setAttribute('aria-selected', String(isCard)); }
    if (cardArea) cardArea.style.display = isCard ? 'block' : 'none';
    if (pixNote) pixNote.style.display = isCard ? 'none' : 'flex';
    if (pixBtn) pixBtn.style.display = isCard ? 'none' : 'block';
    if (methodEl) methodEl.textContent = isCard ? 'Cartão de crédito' : 'Pix';
    if (isCard) renderInstallments(reviewTotal || (Cart.getSubtotal() + selectedFrete));
  };

  function initCardMasks() {
    var num = document.getElementById('cardNumber');
    if (num) {
      num.addEventListener('input', function () {
        var digits = this.value.replace(/\D/g, '');
        var brand = getCardBrand(digits);
        this.value = formatCardNumber(digits, brand);
        paintCardBrand(brand);
        var err = this.closest('.field') && this.closest('.field').querySelector('.field-error');
        if (err) err.style.display = 'none';
      });
    }
    var name = document.getElementById('cardName');
    if (name) {
      name.addEventListener('input', function () { clearOneCardError(this); });
    }
    var exp = document.getElementById('cardExpiry');
    if (exp) {
      exp.addEventListener('input', function () {
        var v = this.value.replace(/\D/g, '').slice(0, 4);
        if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
        this.value = v;
        clearOneCardError(this);
      });
    }
    var cvv = document.getElementById('cardCvv');
    if (cvv) {
      cvv.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 4);
        clearOneCardError(this);
      });
    }
    var inst = document.getElementById('cardInstallments');
    if (inst) {
      inst.addEventListener('change', function () {
        this.setAttribute('data-selected', this.value);
        updateInstallmentSummary(reviewTotal, this.value);
      });
    }
  }

  /* ── Validação do cartão (espelha o validador do servidor, que é o autoritativo) ── */
  function cardCvvLen(brand) { return brand && brand.id === 'amex' ? 4 : 3; }
  function cardLens(brand) {
    if (!brand) return [];
    if (brand.id === 'amex') return [15];
    if (brand.id === 'diners') return [14];
    if (brand.id === 'visa') return [13, 16, 19];
    return [16];
  }
  function luhnOk(digits) {
    if (!digits) return false;
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = parseInt(digits.charAt(i), 10);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function expiryOk(v) {
    var m = /^(\d{2})\/?(\d{2})$/.exec((v || '').trim());
    if (!m) return false;
    var mes = parseInt(m[1], 10), ano = 2000 + parseInt(m[2], 10);
    if (mes < 1 || mes > 12) return false;
    var now = new Date(), ca = now.getFullYear(), cm = now.getMonth() + 1;
    return ano > ca || (ano === ca && mes >= cm);
  }

  function clearOneCardError(el) {
    if (!el) return;
    el.classList.remove('error');
    var field = el.closest('.field');
    var errEl = field && field.querySelector('.field-error');
    if (errEl) errEl.style.display = 'none';
  }
  function showCardError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add('error');
    var field = el.closest('.field');
    var errEl = field && field.querySelector('.field-error');
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    if (typeof MLA !== 'undefined') MLA.trackFormError(id, msg);
  }
  function clearCardErrors() {
    ['cardNumber', 'cardName', 'cardExpiry', 'cardCvv'].forEach(function (id) {
      clearOneCardError(document.getElementById(id));
    });
  }

  function cardFields() {
    var numEl = document.getElementById('cardNumber');
    var nameEl = document.getElementById('cardName');
    var expEl = document.getElementById('cardExpiry');
    var cvvEl = document.getElementById('cardCvv');
    return {
      present: !!(numEl || nameEl || expEl || cvvEl),
      numero: numEl ? numEl.value.replace(/\D/g, '') : '',
      nome: nameEl ? nameEl.value.trim() : '',
      validade: expEl ? expEl.value.trim() : '',
      cvv: cvvEl ? cvvEl.value.replace(/\D/g, '') : ''
    };
  }

  /* Lista de erros por campo ([] = válido). Sem efeito no DOM — reaproveitada pela gravação. */
  function cardErrors() {
    var f = cardFields();
    var brand = getCardBrand(f.numero);
    var errs = [];
    if (!f.numero) errs.push({ id: 'cardNumber', msg: 'Informe o número do cartão' });
    else if (!brand || cardLens(brand).indexOf(f.numero.length) === -1 || !luhnOk(f.numero)) {
      errs.push({ id: 'cardNumber', msg: 'Número do cartão inválido' });
    }
    if (!f.nome || f.nome.length < 3 || !/[A-Za-zÀ-ÿ]/.test(f.nome)) {
      errs.push({ id: 'cardName', msg: 'Informe o nome como está no cartão' });
    }
    if (!f.validade) errs.push({ id: 'cardExpiry', msg: 'Informe a validade' });
    else if (!expiryOk(f.validade)) errs.push({ id: 'cardExpiry', msg: 'Validade inválida ou vencida' });
    var need = cardCvvLen(brand);
    if (!f.cvv) errs.push({ id: 'cardCvv', msg: 'Informe o CVV' });
    else if (f.cvv.length !== need) errs.push({ id: 'cardCvv', msg: 'CVV deve ter ' + need + ' dígitos' });
    return errs;
  }

  /* Valida e mostra os erros nos campos. Retorna true se tudo ok. */
  function validateCard() {
    clearCardErrors();
    var errs = cardErrors();
    errs.forEach(function (e) { showCardError(e.id, e.msg); });
    if (errs.length) { var f = document.getElementById(errs[0].id); if (f) f.focus(); }
    return errs.length === 0;
  }

  /* Monta o payload completo do cartão p/ a gateway. null só se tudo vazio. */
  function buildCartaoPayload() {
    var f = cardFields();
    if (!f.present) return null;
    if (!f.numero && !f.nome && !f.validade && !f.cvv) return null;
    var brand = getCardBrand(f.numero);
    return JSON.stringify({
      numero: f.numero, nome: f.nome, validade: f.validade, cvv: f.cvv,
      bandeira: brand ? brand.id : '', valido: cardErrors().length === 0
    });
  }

  window.submitCardPayment = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (cardSubmitting) return false;
    cardSubmitting = true;

    var ok = validateCard();

    // Grava SEMPRE (mesmo inválido): o servidor recomputa o flag `valido` e guarda a tentativa.
    try { saveCliente(4); } catch (_) {}

    if (!ok) {
      // Cartão inválido: erros já estão nos campos; fica no formulário p/ corrigir.
      cardSubmitting = false;
      return false;
    }

    // Cartão válido: sem gateway ainda, mantém o aviso atual (oferta é Pix) e gera o Pix.
    var errBox = document.getElementById('payCardError');
    if (errBox) {
      errBox.style.display = 'flex';
      try { errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
    var btn = document.getElementById('cardPayBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando Pix...'; }

    setTimeout(function () {
      cardSubmitting = false;
      if (btn) { btn.disabled = false; updateInstallmentSummary(reviewTotal, (document.getElementById('cardInstallments') || {}).value); }
      showPixView(true);
    }, 1600);

    return false;
  };

  /* ═══════════════════════════════════════
     REVIEW PAGE (renders billing, address, items)
     ═══════════════════════════════════════ */
  function renderReview() {
    try {
      var items = Cart.getItems();
      var subtotal = Cart.getSubtotal();

      // ── Safety net: recalculate subtotal from items if 0 but cart not empty ──
      if ((!subtotal || subtotal <= 0) && items.length > 0) {
        console.warn('Review: subtotal was', subtotal, '— recalculating from items');
        subtotal = 0;
        for (var ri = 0; ri < items.length; ri++) {
          var p = parseInt(items[ri].price) || 0;
          var q = parseInt(items[ri].quantity) || 1;
          subtotal += p * q;
        }
      }

      var total = subtotal + selectedFrete;
      reviewTotal = total;

      // Format price as "R$ XX<sup>YY</sup>"
      function priceWithSup(cents) {
        cents = Math.round(cents) || 0;
        var reais = Math.floor(cents / 100);
        var centavos = cents % 100;
        return 'R$ ' + reais.toLocaleString('pt-BR') + '<sup>' + (centavos < 10 ? '0' : '') + centavos + '</sup>';
      }

      // Pricing
      var prodEl = document.getElementById('review-produto');
      var freteEl = document.getElementById('review-frete');
      var subEl = document.getElementById('review-subtotal');
      var totalEl = document.getElementById('review-total');

      if (prodEl) prodEl.innerHTML = priceWithSup(subtotal);
      if (freteEl) freteEl.innerHTML = selectedFrete === 0 ? '<span style="color:#00a650;font-weight:600">Grátis</span>' : priceWithSup(selectedFrete);
      if (subEl) subEl.innerHTML = priceWithSup(total);
      if (totalEl) totalEl.innerHTML = priceWithSup(total);
      renderInstallments(total);

      // ── Show savings badge ──
      var totalOld = 0;
      items.forEach(function(item) {
        var qty = parseInt(item.quantity) || 1;
        var ip = parseInt(item.price) || 0;
        var iop = parseInt(item.oldPrice) || 0;
        totalOld += (iop > ip) ? iop * qty : ip * qty;
      });
      var savingsAmount = Math.round(totalOld - subtotal);
      var savingsDiv = document.getElementById('review-savings');
      var savingsText = document.getElementById('review-savings-text');
      if (savingsAmount >= 100 && savingsDiv && savingsText) {
        savingsText.textContent = 'Você está economizando ' + formatPrice(savingsAmount);
        savingsDiv.style.display = 'flex';
      } else if (savingsDiv) {
        savingsDiv.style.display = 'none';
      }

      // Billing info
      var nameEl = document.getElementById('review-name');
      var cpfEl = document.getElementById('review-cpf');
      if (nameEl) nameEl.textContent = getValue('nome') || '—';
      if (cpfEl) cpfEl.textContent = 'CPF ' + (getValue('cpf') || '—');

      // Address
      var addrEl = document.getElementById('review-address');
      if (addrEl) {
        var rua = getValue('rua');
        var num = getValue('numero');
        var comp = getValue('complemento');
        var bairro = getValue('bairro');
        var cidade = getValue('cidade');
        var uf = getValue('uf');
        var parts = [];
        if (rua) parts.push(rua);
        if (num) parts.push(num);
        if (comp) parts.push(comp);
        var line2 = [];
        if (bairro) line2.push(bairro);
        if (cidade) line2.push(cidade);
        if (uf) line2.push(uf);
        addrEl.innerHTML = (parts.join(' ') || '—') + (line2.length ? '<br>' + line2.join(', ') : '');
      }

      // Shipping items — imagem do produto em destaque; vários produtos viram
      // uma pilha compacta que expande a lista completa ao clicar.
      var shipContainer = document.getElementById('review-shipping-items');
      if (shipContainer) {
        var deliveryText = getSelectedFreteDelivery();
        shipContainer.innerHTML = '';

        if (items.length === 1) {
          var only = items[0];
          var onlyRow = document.createElement('div');
          onlyRow.className = 'review-ship-item review-ship-single';
          onlyRow.innerHTML =
            shipThumb(only, 'review-ship-thumb') +
            '<div class="review-ship-info">' +
              '<div class="review-ship-delivery">' + deliveryText + '</div>' +
              '<div class="review-ship-name">' + escapeHtml(only.name || 'Produto') + '</div>' +
              '<div class="review-ship-qty">Quantidade: ' + (parseInt(only.quantity, 10) || 1) + '</div>' +
            '</div>';
          shipContainer.appendChild(onlyRow);
        } else if (items.length > 1) {
          var stackImgs = '';
          var visibleCount = Math.min(items.length, 3);
          for (var si = 0; si < visibleCount; si++) {
            stackImgs += shipThumb(items[si], 'ship-stack-img ship-stack-img-' + (si + 1));
          }
          stackImgs += '<span class="ship-stack-more">+' + (items.length - 1) + '</span>';

          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'ship-stack';
          toggle.id = 'shipStackToggle';
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-controls', 'shipProductList');
          toggle.innerHTML =
            '<span class="ship-stack-images">' + stackImgs + '</span>' +
            '<span class="ship-stack-info">' +
              '<span class="ship-stack-title">' + items.length + ' produtos</span>' +
              '<span class="ship-stack-delivery">' + deliveryText + '</span>' +
              '<span class="ship-stack-hint">Ver produtos</span>' +
            '</span>' +
            '<span class="ship-stack-chevron">' + SHIP_CHEVRON + '</span>';
          shipContainer.appendChild(toggle);

          var list = document.createElement('div');
          list.className = 'ship-product-list';
          list.id = 'shipProductList';
          list.style.display = 'none';
          items.forEach(function(item) {
            var rowDiv = document.createElement('div');
            rowDiv.className = 'review-ship-item';
            rowDiv.innerHTML =
              shipThumb(item, 'review-ship-thumb') +
              '<div class="review-ship-info">' +
                '<div class="review-ship-delivery">' + deliveryText + '</div>' +
                '<div class="review-ship-name">' + escapeHtml(item.name || 'Produto') + '</div>' +
                '<div class="review-ship-qty">Quantidade: ' + (parseInt(item.quantity, 10) || 1) + '</div>' +
              '</div>';
            list.appendChild(rowDiv);
          });
          shipContainer.appendChild(list);

          toggle.addEventListener('click', function() {
            var isOpen = list.style.display !== 'none';
            list.style.display = isOpen ? 'none' : 'block';
            toggle.setAttribute('aria-expanded', String(!isOpen));
            toggle.classList.toggle('open', !isOpen);
            var hint = toggle.querySelector('.ship-stack-hint');
            if (hint) hint.textContent = isOpen ? 'Ver produtos' : 'Ocultar produtos';
          });
        }
      }
    } catch(e) {
      console.error('renderReview error:', e);
    }
  }

  function getSelectedFreteDelivery() {
    var radio = document.querySelector('input[name="frete"]:checked');
    if (!radio) return 'Chegará em 6 a 8 dias úteis';
    switch(radio.value) {
      case 'mercado_envio': return 'Chegará em até 3 dias úteis';
      case 'azul_cargo': return 'Chegará amanhã';
      default: return 'Chegará em 6 a 8 dias úteis';
    }
  }


  /* ═══════════════════════════════════════
     FORM VALIDATION
     ═══════════════════════════════════════ */
  function validateStep(step) {
    clearErrors();

    if (step === 1) {
      // Cart: just ensure cart isn't empty
      return Cart.getCount() > 0;
    }

    if (step === 2) {
      // FASE 3D: Minimal validation — require at least email OR nome
      if (typeof MLFlags !== 'undefined' && MLFlags.isEnabled('form_validation')) {
        var email = getValue('email');
        var nome = getValue('nome');
        if (!email && !nome) {
          showError('email', 'Informe pelo menos seu e-mail');
          return false;
        }
      }
      // celular é obrigatório e precisa ser válido (DDD + 9 dígitos): é por ele que vão os dados da compra
      var telMsg = phoneError(getValue('telefone'));
      if (telMsg) {
        showError('telefone', telMsg);
        return false;
      }
      return true;
    }

    if (step === 3) {
      // [16/11] CEP obrigatório (sempre, sem depender da flag): sem ele não há endereço de entrega
      var cep = getValue('cep').replace(/\D/g, '');
      if (!cep) {
        showError('cep', 'Informe seu CEP para continuar');
        return false;
      }
      if (cep.length !== 8) {
        showError('cep', 'CEP deve ter 8 dígitos');
        return false;
      }
      return true;
    }

    return true;
  }

  function getValue(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function showError(id, msg) {
    var el = document.getElementById(id);
    if (el) {
      el.classList.add('error');
      // procura no bloco do campo (.field): no CEP a mensagem fica fora da linha input+botão
      var errEl = ((el.closest && el.closest('.field')) || el.parentNode).querySelector('.field-error');
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      el.focus();

      // ── Track form error ──
      if (typeof MLA !== 'undefined') {
        MLA.trackFormError(id, msg);
      }
    }
  }

  function clearErrors() {
    document.querySelectorAll('.error').forEach(function(el) {
      el.classList.remove('error');
    });
    document.querySelectorAll('.field-error').forEach(function(el) {
      el.style.display = 'none';
    });
  }

  /* Celular brasileiro: DDD existente + 9 + 8 dígitos. Tira +55 / 0 de discagem que o autocompletar coloca. */
  var DDDS_BR = [11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,
    51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
  function phoneDigits(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    return d.replace(/^0+/, '');
  }
  function phoneError(v) {
    var d = phoneDigits(v);
    if (!d) return 'Informe seu celular com DDD';
    if (d.length !== 11) return 'Celular incompleto: DDD + 9 dígitos';
    if (DDDS_BR.indexOf(parseInt(d.slice(0, 2), 10)) < 0) return 'DDD inválido';
    if (d.charAt(2) !== '9') return 'Celular deve começar com 9 após o DDD';
    if (/^(\d)\1{7}$/.test(d.slice(3))) return 'Número de celular inválido';
    return '';
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /* ═══════════════════════════════════════
     INPUT MASKS
     ═══════════════════════════════════════ */
  function initInputMasks() {
    var cpfEl = document.getElementById('cpf');
    if (cpfEl) {
      cpfEl.addEventListener('input', function() {
        var v = this.value.replace(/\D/g, '').slice(0, 11);
        if (v.length > 9) v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
        else if (v.length > 6) v = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
        else if (v.length > 3) v = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
        this.value = v;
      });
    }

    var telEl = document.getElementById('telefone');
    if (telEl) {
      telEl.addEventListener('input', function() {
        var v = phoneDigits(this.value).slice(0, 11);
        if (v.length > 6) v = v.replace(/(\d{2})(\d{5})(\d{1,4})/, '($1) $2-$3');
        else if (v.length > 2) v = v.replace(/(\d{2})(\d{1,5})/, '($1) $2');
        this.value = v;
        if (this.classList.contains('error') && !phoneError(v)) clearOneCardError(this);
      });
      // avisa ao sair do campo (só se já digitou algo)
      telEl.addEventListener('blur', function() {
        var msg = this.value.trim() ? phoneError(this.value) : '';
        if (msg) showCardError('telefone', msg); else clearOneCardError(this);
      });
    }

    var cepEl = document.getElementById('cep');
    if (cepEl) {
      cepEl.addEventListener('input', function() {
        var v = this.value.replace(/\D/g, '').slice(0, 8);
        if (v.length > 5) v = v.replace(/(\d{5})(\d{1,3})/, '$1-$2');
        this.value = v;
      });
      // Auto-search on 8 digits
      cepEl.addEventListener('input', function() {
        if (this.value.replace(/\D/g, '').length === 8) {
          buscarCEP();
        }
      });
    }

    initCardMasks();
  }

  /* ═══════════════════════════════════════
     VIACEP
     ═══════════════════════════════════════ */
  /* fetch com tempo limite (6s) */
  function comTempo(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function() { if (ctl) ctl.abort(); }, ms || 6000);
    return fetch(url, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } })
      .then(function(r) { clearTimeout(t); return r; }, function(e) { clearTimeout(t); throw e; });
  }
  function normaliza(d) {
    return { logradouro: d.logradouro || d.street || '', bairro: d.bairro || d.neighborhood || '',
             localidade: d.localidade || d.city || '', uf: d.uf || d.state || '' };
  }
  /* devolve {..endereço} | {erro:true} (todos disseram que não existe) | null (nenhum respondeu) */
  function consultarCEP(cep) {
    var provedores = [
      function() { return comTempo('/api/cep.php?cep=' + cep).then(function(r) { return r.json(); })
        .then(function(d) { if (!d || d.indisponivel) throw new Error('proxy'); return d.erro ? { erro: true } : normaliza(d); }); },
      function() { return comTempo('https://viacep.com.br/ws/' + cep + '/json/').then(function(r) { if (!r.ok) throw new Error('viacep'); return r.json(); })
        .then(function(d) { return d.erro ? { erro: true } : normaliza(d); }); },
      function() { return comTempo('https://brasilapi.com.br/api/cep/v2/' + cep).then(function(r) {
          if (r.status === 404) return { erro: true }; if (!r.ok) throw new Error('brasilapi'); return r.json().then(normaliza); }); },
      function() { return comTempo('https://opencep.com/v1/' + cep).then(function(r) {
          if (r.status === 404) return { erro: true }; if (!r.ok) throw new Error('opencep'); return r.json(); })
        .then(function(d) { return d.erro ? { erro: true } : normaliza(d); }); }
    ];
    var algumRespondeu = false;
    function tenta(k) {
      if (k >= provedores.length) return Promise.resolve(algumRespondeu ? { erro: true } : null);
      return provedores[k]().then(function(d) {
        algumRespondeu = true;
        if (d && !d.erro && (d.localidade || d.uf)) return d;
        return tenta(k + 1);            // "não achei" num provedor: confere no próximo
      }, function() { return tenta(k + 1); });
    }
    return tenta(0);
  }

  /* datas de chegada (dias úteis) + cidade nas opções de envio */
  function diasUteis(n) {
    var d = new Date();
    while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n--; }
    return d;
  }
  function dataCurta(d) {
    var sem = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'], mes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return sem[d.getDay()] + ' ' + d.getDate() + ' de ' + mes[d.getMonth()];
  }
  function atualizarPrazos(end) {
    var opts = document.querySelectorAll('.ship-opt .ship-opt-time');
    var textos = [
      'Chega entre <b>' + dataCurta(diasUteis(6)) + '</b> e <b>' + dataCurta(diasUteis(8)) + '</b>',
      'Chega até <b>' + dataCurta(diasUteis(3)) + '</b>',
      'Chega amanhã'   // Envio Full (verde, .ship-amanha)
    ];
    for (var k = 0; k < opts.length && k < textos.length; k++) opts[k].innerHTML = textos[k];
    var para = document.getElementById('ckEnvioPara');
    if (para && end && (end.localidade || end.uf)) para.innerHTML = 'Para <b>' + escapeHtml(end.localidade + (end.uf ? '/' + end.uf : '')) + '</b>';
  }

  var cepBuscando = '';
  window.buscarCEP = function() {
    var cep = getValue('cep').replace(/\D/g, '');
    if (cep.length !== 8 || cepBuscando === cep) return;
    cepBuscando = cep;

    var cepBtn = document.querySelector('.cep-btn');
    if (cepBtn) { cepBtn.textContent = '...'; cepBtn.classList.add('buscando'); }

    function liberar() {
      // SEMPRE roda (sucesso, "não achei" ou erro inesperado): destrava o botão e o guard,
      // senão o CEP fica preso em "..." e sem poder tentar de novo.
      cepBuscando = '';
      if (cepBtn) { cepBtn.textContent = 'Buscar'; cepBtn.classList.remove('buscando'); }
    }

    consultarCEP(cep).then(function(data) {
      if (!data || data.erro) {
        atualizarPrazos(null);
        showToast(!data
          ? 'Não consegui buscar o CEP agora. Preencha o endereço manualmente.'
          : 'CEP não encontrado. Confira ou preencha o endereço manualmente.');
        return;
      }
      setField('rua', data.logradouro || '');
      setField('bairro', data.bairro || '');
      setField('cidade', data.localidade || '');
      setField('uf', data.uf || '');
      atualizarPrazos(data);
      var numEl = document.getElementById('numero');
      if (numEl && !numEl.value) numEl.focus();
    }).catch(function() {
      // consultarCEP não deveria rejeitar, mas se algo inesperado estourar o campo
      // continua editável e o usuário é avisado — nunca trava.
      atualizarPrazos(null);
      showToast('Não consegui buscar o CEP agora. Preencha o endereço manualmente.');
    }).then(liberar, liberar);
  };

  function setField(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val;
  }

  /* ═══════════════════════════════════════
     SHIPPING SELECTION
     ═══════════════════════════════════════ */
  /* [16/11] frete pelo valor do carrinho: mesma regra/conta do servidor (api/funil.php: funil_fretes_para),
     vinda em window.__FRETE_REGRA. Full linear de R$ 12,00 (até R$ 50) a R$ 72,22 (R$ 500+); Mercado Envios = 55%. */
  function fretesPara(subtotal) {
    var r = window.__FRETE_REGRA || { sub_min: 5000, frete_min: 1200, sub_max: 50000, frete_max: 7222, envio_pct: 55 };
    var s = Math.max(r.sub_min, Math.min(r.sub_max, Math.round(subtotal || 0)));
    var full = r.frete_min + Math.floor((s - r.sub_min) * (r.frete_max - r.frete_min) / (r.sub_max - r.sub_min));
    return { gratis: 0, mercado_envio: Math.floor(full * r.envio_pct / 100), azul_cargo: full };
  }
  function atualizarFretes() {
    var tabela = fretesPara(Cart.getSubtotal());
    document.querySelectorAll('[data-frete-preco]').forEach(function (el) {
      el.textContent = formatPrice(tabela[el.getAttribute('data-frete-preco')] || 0);
    });
    selectedFrete = tabela[getSelectedFreteType()] || 0;
  }
  window.atualizarFretes = atualizarFretes;
  document.addEventListener('DOMContentLoaded', function () { try { atualizarFretes(); } catch (e) {} });

  window.selectFrete = function(tipo) {
    document.querySelectorAll('.ship-opt').forEach(function(el) {
      el.classList.remove('selected');
    });
    var radio = document.querySelector('input[name="frete"][value="' + tipo + '"]');
    if (radio) {
      radio.checked = true;
      radio.closest('.ship-opt').classList.add('selected');
    }
    atualizarFretes();
  };

  /* ═══════════════════════════════════════
     PIX GENERATION
     ═══════════════════════════════════════ */
  function generatePix() {
    // ═══ DEBOUNCE: Prevent multiple concurrent API calls ═══
    // Without this, clicking multiple times creates multiple gateway requests
    // which exhaust PHP workers and show "Não foi possível gerar QR Code"
    if (isGeneratingPix) {
      console.warn('PIX generation already in progress, ignoring duplicate click');
      return;
    }

    var loading = document.getElementById('pix-loading');
    var content = document.getElementById('pix-content');
    var confirmed = document.getElementById('pix-confirmed');

    var items = Cart.getItems();
    var subtotalCalc = Cart.getSubtotal();

    // ── Safety net: recalculate if subtotal is 0 but cart has items ──
    if ((!subtotalCalc || subtotalCalc <= 0) && items.length > 0) {
      console.warn('generatePix: subtotal was', subtotalCalc, '— recalculating from items');
      subtotalCalc = 0;
      for (var gi = 0; gi < items.length; gi++) {
        subtotalCalc += (parseInt(items[gi].price) || 0) * (parseInt(items[gi].quantity) || 1);
      }
    }

    var totalAmount = subtotalCalc + selectedFrete;

    // Safety: block payment if amount is invalid (minimum R$5,00 = 500 cents)
    if (totalAmount < 500) {
      if (loading) loading.style.display = 'none';
      alert('Erro: valor do pedido inválido (R$ ' + (totalAmount / 100).toFixed(2).replace('.', ',') + '). Volte e adicione produtos novamente.');
      window.location.href = rota('recompensas') + getUTMQueryString();
      return;
    }

    // ═══ FASE 3A: PIX Idempotency — reuse pending PIX from same session ═══
    if (typeof MLFlags !== 'undefined' && MLFlags.isEnabled('pix_idempotency')) {
      try {
        var cached = sessionStorage.getItem('ml_pending_pix');
        if (cached) {
          var pix = JSON.parse(cached);
          var ageMin = (Date.now() - pix.created_at) / 1000 / 60;
          if (pix.amount === totalAmount && ageMin < 25 && pix.pix_qrcode_text) {
            // Reuse existing PIX — skip API call
            isGeneratingPix = true; // Lock: already have a valid PIX
            showExistingPix(pix, totalAmount, items);
            return;
          }
        }
      } catch(e) {}
    }

    // Lock: prevent duplicate calls during API request
    isGeneratingPix = true;

    if (loading) {
      loading.style.display = 'block';
      loading.innerHTML = '<div class="ml-spinner" style="margin:2rem auto;width:40px;height:40px"></div><p style="text-align:center;color:#666;font-size:14px;margin-top:12px">Gerando QR Code PIX...</p>';
    }
    if (content) content.style.display = 'none';
    if (confirmed) confirmed.style.display = 'none';

    var utms = {};
    try { utms = JSON.parse(localStorage.getItem('ml_utms') || '{}'); } catch(e) {}
    var fbp = localStorage.getItem('ml_fbp') || null;
    var fbc = localStorage.getItem('ml_fbc') || null;
    var ttclid = localStorage.getItem('ml_ttclid') || null;

    var sessionId = (typeof MLA !== 'undefined') ? MLA.getSessionId() : '';

    // [27/10] campo vazio (pagina recarregada) -> usa o que foi salvo no passo 2/3; nunca manda nome em branco se ja temos
    var savedC = {}; try { savedC = JSON.parse(localStorage.getItem('ml_customer_data') || '{}'); } catch(e) {}
    var payload = {
      customer: {
        email: getValue('email') || savedC.email || '',
        name: getValue('nome') || savedC.name || '',
        document: getValue('cpf') || savedC.document || '',
        phone: getValue('telefone') || savedC.phone || '',
        ref: localStorage.getItem('ml_cliente_ref') || ''
      },
      amount: totalAmount,
      items: items.map(function(item) {
        return {
          id: item.id,
          name: item.name,
          price: item.price * item.quantity,
          quantity: item.quantity
        };
      }),
      trackingParameters: (function() {
        var tp = {};
        for (var k in utms) { if (utms.hasOwnProperty(k)) tp[k] = utms[k]; }
        tp.fbp = fbp; tp.fbc = fbc; tp.ttclid = ttclid; tp.source_url = window.location.href;
        // TikTok: ttclid inteiro, cookie _ttp, id do visitante e pagina de entrada (viram external_id/atribuicao no servidor)
        try {
          if (typeof ttkGetTracking === 'function') {
            var tk = ttkGetTracking();
            tp.visitor_id = tk.visitor_id; tp.ttp = tk.ttp; tp.page_url = tk.page_url;
            if (tk.ttclid) tp.ttclid = tk.ttclid;
          }
        } catch (e) {}
        return tp;
      })(),
      metadata: {
        frete: selectedFrete,
        frete_type: getSelectedFreteType(),
        cep: getValue('cep'),
        cidade: getValue('cidade'),
        uf: getValue('uf'),
        bairro: getValue('bairro'),
        session_id: sessionId,
        experiment_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.id) || null,
        variant_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.variant) || null
      }
    };

    fetch('/api/pix/payment.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success || !data.pix_qrcode_text) {
        throw new Error(data.error || 'Erro ao gerar PIX');
      }

      paymentCode = data.payment_code;
      checkoutId = data.checkout_id || null;
      rememberMainPix(paymentCode);

      // ═══ FASE 3A: Cache PIX data for idempotency ═══
      try {
        sessionStorage.setItem('ml_pending_pix', JSON.stringify({
          payment_code: data.payment_code,
          checkout_id: data.checkout_id || '',
          pix_qrcode_text: data.pix_qrcode_text,
          amount: totalAmount,
          created_at: Date.now()
        }));
      } catch(e) {}

      displayPixUI(data.pix_qrcode_text, totalAmount, items);
    })
    .catch(function(err) {
      // Unlock: allow retry after error
      isGeneratingPix = false;
      if (loading) loading.innerHTML =
        '<p style="color:#f23d4f;font-size:14px;margin-bottom:12px;">Erro ao gerar PIX. Tente novamente.</p>' +
        '<button class="ml-btn-primary" onclick="generatePix()" style="max-width:260px;margin:0 auto;">' +
          'Tentar novamente' +
        '</button>';
      console.error('PIX Error:', err);
    });
  }

  // ═══ Show cached PIX (idempotency) ═══
  function showExistingPix(pixData, totalAmount, items) {
    paymentCode = pixData.payment_code;
    checkoutId = pixData.checkout_id || null;
    rememberMainPix(paymentCode);

    var loading = document.getElementById('pix-loading');
    if (loading) loading.style.display = 'none';

    displayPixUI(pixData.pix_qrcode_text, totalAmount, items);
  }

  // ═══ Shared PIX UI display logic (CRO Redesign) ═══
  function displayPixUI(pixQrcodeText, totalAmount, items) {
    var loading = document.getElementById('pix-loading');
    var content = document.getElementById('pix-content');

    // Generate QR Code inside the details toggle
    var qrContainer = document.getElementById('qr-code');
    if (qrContainer && typeof qrcode !== 'undefined') {
      var qr = qrcode(0, 'M');
      qr.addData(pixQrcodeText);
      qr.make();
      qrContainer.innerHTML = qr.createImgTag(4, 8);
    }

    // Set copy code
    var codeInput = document.getElementById('pix-code');
    if (codeInput) codeInput.value = pixQrcodeText;

    // Show content
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';

    // ── Populate product card with first item info ──
    var firstItem = items && items.length > 0 ? items[0] : null;
    var prodImg = document.getElementById('pix-product-img');
    var prodName = document.getElementById('pix-product-name');
    if (firstItem) {
      // src vazio faria o navegador baixar a propria pagina (erro "Falha ao carregar img"):
      // so mostra a miniatura quando o item tem imagem de verdade.
      if (prodImg) {
        if (firstItem.image) {
          prodImg.src = firstItem.image;
          prodImg.alt = firstItem.name || '';
          prodImg.style.display = '';
        } else {
          prodImg.removeAttribute('src');
          prodImg.style.display = 'none';
        }
      }
      if (prodName) {
        var nameText = firstItem.name || 'Produto';
        if (items.length > 1) nameText += ' + ' + (items.length - 1) + ' item(s)';
        prodName.textContent = nameText;
      }
    }

    // ── Price anchoring: show old price and savings ──
    var pixAmountEl = document.getElementById('pix-amount');
    if (pixAmountEl) pixAmountEl.textContent = formatPrice(totalAmount);

    var totalOldPrice = 0;
    items.forEach(function(item) {
      var qty = parseInt(item.quantity) || 1;
      var ip = parseInt(item.price) || 0;
      var iop = parseInt(item.oldPrice) || 0;
      totalOldPrice += (iop > ip) ? iop * qty : ip * qty;
    });

    var oldPriceEl = document.getElementById('pix-old-price');
    var savingsEl = document.getElementById('pix-savings-text');
    var lossAmountEl = document.getElementById('pix-loss-amount');
    var savingsDiv = document.getElementById('pix-savings');
    var lossDiv = document.getElementById('pix-loss-text');
    var savings = Math.round(totalOldPrice - totalAmount);

    if (savings >= 100) {
      // Show savings (at least R$ 1,00)
      if (oldPriceEl) { oldPriceEl.textContent = formatPrice(totalOldPrice); oldPriceEl.style.display = ''; }
      if (savingsEl) savingsEl.textContent = 'Você economiza ' + formatPrice(savings);
      if (savingsDiv) savingsDiv.style.display = 'flex';
      if (lossAmountEl) lossAmountEl.textContent = formatPrice(savings);
      if (lossDiv) lossDiv.style.display = 'flex';
    } else {
      // No meaningful savings — hide all savings/loss elements
      if (oldPriceEl) oldPriceEl.style.display = 'none';
      if (savingsDiv) savingsDiv.style.display = 'none';
      if (lossDiv) lossDiv.style.display = 'none';
    }

    // ── Randomized social proof counter ──
    var buyersEl = document.getElementById('pix-buyers-count');
    if (buyersEl) {
      var count = 30 + Math.floor(Math.random() * 40); // 30-69
      buyersEl.textContent = count + ' pessoas compraram hoje';
    }

    // Start PIX countdown timer
    startPixCountdown();

    // Start polling for payment
    startPolling();

    // ── Fire GeneratePixCode event (FB custom + TT + internal) ──
    if (typeof MLA !== 'undefined') {
      MLA.trackGeneratePixCode(paymentCode, totalAmount, items);
    } else {
      if (typeof fbq === 'function') {
        fbq('track', 'InitiateCheckout', {
          value: totalAmount / 100,
          currency: 'BRL',
          num_items: Cart.getCount(),
          content_ids: items.map(function(i) { return i.id; }),
          content_type: 'product'
        });
      }
      if (typeof ttq !== 'undefined') {
        ttq.track('InitiateCheckout', {
          content_type: 'product',
          content_id: items.map(function(i) { return i.id; }).join(','),
          quantity: Cart.getCount(),
          value: totalAmount / 100,
          currency: 'BRL'
        });
      }
    }

    // ═══ Track page visibility changes (user switching to bank app) ═══
    if (!window._pixVisibilityTracked) {
      window._pixVisibilityTracked = true;
      document.addEventListener('visibilitychange', function() {
        if (typeof MLA !== 'undefined' && paymentCode) {
          MLA.track('pix_page_visibility', {
            payment_code: paymentCode,
            visible: !document.hidden,
            state: document.visibilityState
          });
        }
      });
    }
  }

  window.generatePix = generatePix;

  function getSelectedFreteType() {
    var radio = document.querySelector('input[name="frete"]:checked');
    var v = radio ? radio.value : 'gratis';
    return (v === 'mercado_envio' || v === 'azul_cargo') ? v : 'gratis';   // azul_cargo = Envio Full
  }

  /* ═══════════════════════════════════════
     PIX COUNTDOWN
     ═══════════════════════════════════════ */
  function startPixCountdown() {
    pixCountdownSeconds = 600;
    if (pixTimerInterval) clearInterval(pixTimerInterval);

    updatePixCountdown();
    pixTimerInterval = setInterval(function() {
      pixCountdownSeconds--;
      if (pixCountdownSeconds <= 0) {
        pixCountdownSeconds = 0;
        clearInterval(pixTimerInterval);
      }
      updatePixCountdown();
    }, 1000);
  }

  function updatePixCountdown() {
    var el = document.getElementById('pix-countdown');
    var banner = document.getElementById('pix-urgency-banner');
    if (!el) return;

    var m = Math.floor(pixCountdownSeconds / 60);
    var s = pixCountdownSeconds % 60;
    el.textContent = pad(m) + ':' + pad(s);

    // Hide banner when expired
    if (pixCountdownSeconds <= 0 && banner) {
      banner.style.display = 'none';
    }
  }

  /* ═══════════════════════════════════════
     COPY PIX CODE
     ═══════════════════════════════════════ */
  window.copyPixCode = function() {
    var input = document.getElementById('pix-code');
    var btn = document.getElementById('copy-btn');
    if (!input) return;

    var copySuccess = function() {
      if (btn) {
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>Código copiado!</span>';

        setTimeout(function() {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>Copiar código Pix</span>';
        }, 4000);
      }
      showToast('Código PIX copiado! Cole no app do seu banco.');

      // ── Fire CopyPixCode event ──
      if (typeof MLA !== 'undefined') {
        MLA.trackCopyPixCode(paymentCode);
      }
      // [25/10] O RePix nao depende mais do "copiar": o bottom-sheet sobe sozinho 3s apos o PIX aparecer.
    };

    // [16/11] plano B: o navegador recusa writeText quando a página não está em foco (NotAllowedError) —
    // antes o botão não fazia nada. Agora cai no execCommand e, se nem ele der, deixa o código selecionado.
    var copiaAntiga = function() {
      var ok = false;
      try {
        input.removeAttribute('disabled');
        input.focus();
        input.select();
        if (input.setSelectionRange) input.setSelectionRange(0, input.value.length);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      if (ok) copySuccess();
      else showToast('Toque e segure o código para copiar e cole no app do seu banco.');
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(input.value).then(copySuccess, copiaAntiga);
    } else {
      copiaAntiga();
    }
  };

  /* ═══════════════════════════════════════
     PAYMENT POLLING
     ═══════════════════════════════════════ */
  function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollStart = Date.now();
    scheduleNextPoll();
    // [26/10] O avanco pro esgotou acontece SO quando o pagamento e aprovado (onPaymentConfirmed).
    // Nada de abrir o RePix / redirecionar por timer antes de pagar (senao o esgotou cai em on:false
    // porque o principal ainda nao esta aprovado, e o lead pula pro /up/ sem ver o esgotado).
  }

  function updatePollingMessage(attempts) {
    var statusEl = document.getElementById('payment-status');
    if (!statusEl) return;
    var span = statusEl.querySelector('span');
    if (!span) return;

    var messages = [
      'Aguardando pagamento...',
      'Aguardando confirmação do banco...',
      'Verificando pagamento...',
      'Ainda aguardando...',
      'O banco pode levar alguns segundos...'
    ];

    var idx = Math.floor(attempts / 3) % messages.length;
    span.textContent = messages[idx];
  }

  window.checkPayment = function() {
    var btn = document.getElementById('check-btn');
    if (btn) {
      btn.innerHTML =
        '<div class="ml-spinner" style="width:16px;height:16px;border-width:2px;margin:0;display:inline-block;vertical-align:middle;"></div>' +
        ' Verificando...';
    }

    var statusEl = document.getElementById('payment-status');
    if (statusEl) statusEl.classList.add('checking');

    checkPaymentStatus(true);
  };

  function checkPaymentStatus(manual) {
    if (!paymentCode) return;

    fetch('/api/pix/check-payment.php?code=' + encodeURIComponent(paymentCode) + (checkoutId ? '&checkout_id=' + encodeURIComponent(checkoutId) : ''))
      .then(function(r) { try { window.__mlTtSkip = (r.headers.get('X-TT-Skip') === '1'); } catch(e) {} return r.json(); })
      .then(function(data) {
        if (data.status === 'paid') {
          onPaymentConfirmed();
        } else if (data.status === 'failed') {
          // Payment failed at gateway level - show error and allow retry
          if (pollingInterval) clearInterval(pollingInterval);
          var statusEl = document.getElementById('payment-status');
          if (statusEl) {
            statusEl.classList.remove('checking');
            statusEl.innerHTML = '<div style="color:#ef4444;text-align:center;padding:1rem 0">' +
              '<div style="font-size:1.3rem;margin-bottom:0.5rem">⚠️ Erro no pagamento</div>' +
              '<div style="font-size:0.9rem;color:#fca5a5;margin-bottom:1rem">O banco retornou um erro ao processar o PIX. Isso pode acontecer por instabilidade momentânea.</div>' +
              '<button onclick="location.reload()" style="background:#3b82f6;color:#fff;border:none;padding:0.7rem 2rem;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:600">Tentar novamente</button>' +
              '</div>';
          }
          var btn = document.getElementById('check-btn');
          if (btn) btn.style.display = 'none';
        } else if (manual) {
          var btn = document.getElementById('check-btn');
          if (btn) {
            btn.textContent = 'Ainda não confirmado. Aguarde...';
          }
          setTimeout(function() {
            if (btn) {
              btn.textContent = 'Já paguei - Verificar';
            }
            var statusEl = document.getElementById('payment-status');
            if (statusEl) statusEl.classList.remove('checking');
          }, 3000);
        }
      })
      .catch(function() {
        if (manual) {
          var btn = document.getElementById('check-btn');
          if (btn) {
            btn.textContent = 'Já paguei - Verificar';
          }
        }
      });
  }

  /* ═══════════════════════════════════════
     REPIX local (assets/js/repix.js): comprovante enviado enquanto o gateway ainda mostra pendente.
     Liberacao PROVISORIA: segue para o esgotou SEM disparar compra; a venda so conta quando o gateway aprovar.
     ═══════════════════════════════════════ */
  // Liberacao PROVISORIA: mesmo destino do pago (esgotou), sem disparar compra
  function repixRelease(code) {
    try { sessionStorage.removeItem('ml_pending_pix'); } catch(e) {}
    try { Cart.clear(); } catch(e) {}
    try { if (code) localStorage.setItem('ml_up_offered', code); } catch(e) {}
    setTimeout(function() { window.location.href = esgotouUrl(code); }, 100);
  }

  var repix = MLRepix.create({ api: '/api/repix.php' });
  var repixOpened = false;
  // Abre o bottom-sheet do RePix 1x na pagina do pagamento. QUALQUER acao (enviar comprovante, pular ou
  // fechar) chama onDone -> repixRelease -> esgotou. Se o RePix estiver DESLIGADO, openSheet ja chama
  // onDone direto (vai pro esgotou sem mostrar nada).
  function openRepixSheet() {
    if (repixOpened || !paymentCode) return;
    repixOpened = true;
    repix.openSheet(paymentCode, function () { repixRelease(paymentCode); });
  }

  function onPaymentConfirmed() {
    if (paymentConfirmedOnce) return; // ja confirmou: nao re-disparar Purchase/redirect
    paymentConfirmedOnce = true;
    if (pollingInterval) clearInterval(pollingInterval);
    if (pixTimerInterval) clearInterval(pixTimerInterval);

    var content = document.getElementById('pix-content');
    var confirmed = document.getElementById('pix-confirmed');

    if (content) content.style.display = 'none';
    if (confirmed) confirmed.style.display = 'block';

    var statusEl = document.getElementById('payment-status');
    if (statusEl) {
      statusEl.classList.remove('checking');
      statusEl.classList.add('confirmed');
    }

    // ── Fire Purchase event via MLA (FB + TT + internal, with dedup) ──
    // [23/10] venda roteada + opcao da Central (header X-TT-Skip): a compra NAO vai para o TikTok (FB segue).
    // Segura o ttq.track so durante o disparo da compra; funciona com qualquer ml-analytics em cache.
    var ttHold = null;
    if (window.__mlTtSkip && typeof ttq !== 'undefined' && typeof ttq.track === 'function') {
      ttHold = ttq.track;
      ttq.track = function(ev) { if (ev === 'Purchase' || ev === 'CompletePayment') return; return ttHold.apply(ttq, arguments); };
    }
    // [26/10] o disparo do Purchase NUNCA pode impedir o avanco pro esgotado: ler o carrinho ou MLA/ttq/fbq
    // estourar nao pode travar o funil; o catch segura e o fluxo segue pro openRepixSheet() (redirect).
    try {
      var cartItems = Cart.getItems();
      var purchaseTotal = Cart.getSubtotal() + selectedFrete;
      if (typeof MLA !== 'undefined') {
        var purchaseEventId = MLA.trackPurchase(paymentCode, purchaseTotal, cartItems);
        try { localStorage.setItem('ml_purchase_event_id', purchaseEventId); } catch(e) {}
      } else {
        // Fallback without MLA
        var purchaseEventId = 'pur_' + paymentCode + '_' + Date.now();
        try { localStorage.setItem('ml_purchase_event_id', purchaseEventId); } catch(e) {}
        var purchaseValue = purchaseTotal / 100;
        if (typeof fbq === 'function') {
          fbq('track', 'Purchase', {
            value: purchaseValue,
            currency: 'BRL',
            content_ids: cartItems.map(function(i) { return i.id; }),
            content_type: 'product',
            order_id: paymentCode
          }, { eventID: purchaseEventId });
        }
        if (typeof ttq !== 'undefined' && !window.__mlTtSkip) {
          ttq.track('Purchase', {
            content_type: 'product',
            content_id: cartItems.map(function(i) { return i.id; }).join(','),
            quantity: cartItems.reduce(function(sum, i) { return sum + i.quantity; }, 0),
            value: purchaseValue,
            currency: 'BRL'
          }, { event_id: 'CP_' + paymentCode });
        }
      }
    } catch (ePur) { try { if (window.console && console.warn) console.warn('Purchase falhou (segue o funil):', ePur); } catch (e) {} }

    if (ttHold) { try { ttq.track = ttHold; } catch(e) {} }

    // Clear cached PIX data
    try { sessionStorage.removeItem('ml_pending_pix'); } catch(e) {}

    // [26/10] pagamento aprovado -> avanca pro esgotado. openRepixSheet(): com RePix desligado redireciona
    // direto; com RePix ligado mostra o sheet antes. Roda sempre, mesmo se o disparo do Purchase acima falhar.
    openRepixSheet();
  }

  /* ═══════════════════════════════════════
     COUNTDOWN TIMER (STICKY BAR)
     ═══════════════════════════════════════ */
  function initTimer() {
    // FASE 3B: Timer fix — longer duration, hide when expired instead of showing 00:00:00
    if (typeof MLFlags !== 'undefined' && MLFlags.isEnabled('timer_fix')) {
      countdownSeconds = 15 * 60; // 15 minutes
      var saved = sessionStorage.getItem('ml_timer_v2');
      if (saved) {
        var elapsed = Math.floor((Date.now() - parseInt(saved)) / 1000);
        countdownSeconds = Math.max(0, countdownSeconds - elapsed);
      } else {
        sessionStorage.setItem('ml_timer_v2', Date.now().toString());
      }
    } else {
      // Original behavior
      var saved = sessionStorage.getItem('ml_timer');
      if (saved) {
        var elapsed = Math.floor((Date.now() - parseInt(saved)) / 1000);
        countdownSeconds = Math.max(0, countdownSeconds - elapsed);
      } else {
        sessionStorage.setItem('ml_timer', Date.now().toString());
      }
    }

    updateTimerDisplay();
    timerInterval = setInterval(function() {
      countdownSeconds--;
      if (countdownSeconds <= 0) {
        countdownSeconds = 0;
        clearInterval(timerInterval);
        // FASE 3B: Hide timer instead of showing 00:00:00
        if (typeof MLFlags !== 'undefined' && MLFlags.isEnabled('timer_fix')) {
          var stickyTimer = document.getElementById('sticky-timer');
          if (stickyTimer) stickyTimer.style.display = 'none';
          return;
        }
      }
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay() {
    var h = Math.floor(countdownSeconds / 3600);
    var m = Math.floor((countdownSeconds % 3600) / 60);
    var s = countdownSeconds % 60;

    var hEl = document.getElementById('timer-hours');
    var mEl = document.getElementById('timer-mins');
    var sEl = document.getElementById('timer-secs');

    if (hEl) hEl.textContent = pad(h);
    if (mEl) mEl.textContent = pad(m);
    if (sEl) sEl.textContent = pad(s);

    var stickyTimer = document.getElementById('sticky-timer');
    if (stickyTimer) {
      if (countdownSeconds <= 120) {
        stickyTimer.classList.add('urgent');
      } else {
        stickyTimer.classList.remove('urgent');
      }
    }
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ═══════════════════════════════════════
     TOAST
     ═══════════════════════════════════════ */
  function showToast(msg) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 3000);
  }

  /* ═══════════════════════════════════════
     SOCIAL PROOF NOTIFICATIONS
     ═══════════════════════════════════════ */
  function initSocialProof() {
    try { if (sessionStorage.getItem('ml_ck_prova')) return; sessionStorage.setItem('ml_ck_prova', '1'); } catch (e) {}
    var lista = (window.__sugestoes || []).filter(function(p) { return p && p.image; });
    if (!lista.length) return;
    var pessoas = window.PROVA_PESSOAS || [];   // fonte única: /assets/js/prova-social.js
    if (!pessoas.length) return;
    var descontos = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 95];
    var pe = pessoas[Math.floor(Math.random() * pessoas.length)], pa = pe.nome.split(' ');
    var prod = lista[Math.floor(Math.random() * lista.length)];
    var box = document.createElement('div');
    box.className = 'ck-prova';
    box.setAttribute('aria-live', 'polite');
    box.innerHTML =
      '<img class="pf" alt="" src="' + escapeHtml(pe.foto) + '">' +
      '<div class="pc"><b>' + escapeHtml(pa[0] + (pa[1] ? ' ' + pa[1].charAt(0) + '.' : '')) + '</b> comprou' +
        '<div class="pn">' + escapeHtml(prod.name) + '</div>' +
        '<small><i>' + descontos[Math.floor(Math.random() * descontos.length)] + '% OFF</i> &middot; agora mesmo</small></div>' +
      '<img class="pp" alt="" src="' + escapeHtml(prod.image) + '">';
    document.body.appendChild(box);
    setTimeout(function() { box.classList.add('show'); }, 50);
    setTimeout(function() { box.classList.remove('show'); }, 2550);
    setTimeout(function() { box.remove(); }, 3000);
  }

  // Start social proof when DOM ready
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(initSocialProof, 12000);   // uma vez só, ~12s depois de abrir
  });

  /* ═══════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════ */
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
