/* ============================================
   ML Analytics - Smart Tracking Library v2.0
   MIGRATED TO POSTHOG CLOUD

   Changes from v1:
   - Internal events now sent to PostHog Cloud (posthog.capture)
   - NO MORE requests to /api/event.php (eliminates PHP worker load)
   - NO MORE tracking pixel to /api/track.php (eliminated separately)
   - Facebook Pixel + CAPI dedup: UNCHANGED
   - TikTok Pixel + Events API dedup: UNCHANGED
   - Session tracking, ttclid capture: UNCHANGED
   - Public API: 100% backward-compatible (zero breaking changes)
   ============================================ */

var MLA = (function() {
  'use strict';

  // [31/10] PostHog REMOVIDO: nao era usado e so gerava erro no navegador do visitante
  // (fetch falhando em us.i.posthog.com). As chamadas posthog.capture/register que sobraram
  // no arquivo sao protegidas por `typeof posthog !== 'undefined'`, entao viram no-op.

  // ── Session ID: persist per browser session ──
  var SESSION_KEY = 'ml_session_id';
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'ses_' + Date.now() + '_' + rand(8);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ── Debug mode ──
  var DEBUG = (window.location.search.indexOf('ml_debug=1') !== -1);
  if (DEBUG) {
    try { localStorage.setItem('ml_debug', '1'); } catch(e) {}
  } else {
    try { DEBUG = localStorage.getItem('ml_debug') === '1'; } catch(e) {}
  }

  // ── Capture ttclid (TikTok Click ID) ──
  (function captureTTClid() {
    var params = new URLSearchParams(window.location.search);
    var ttclid = params.get('ttclid');
    if (ttclid) {
      try {
        localStorage.setItem('ml_ttclid', ttclid);
        // Also set as cookie for pixel auto-read
        document.cookie = 'ttclid=' + ttclid + '; max-age=2592000; path=/; SameSite=Lax';
      } catch(e) {}
    }
  })();

  // ── [08/10] catalog_sku do anuncio de catalogo TikTok (vem na URL do clique e segue pelo funil).
  //    Vira content_id nos eventos do pixel = mesmo que o servidor manda (casa com o sku_id do catalogo). ──
  //    So da URL ATUAL (igual ao servidor, que le o Referer do checkout) -> nunca um sku velho de outro clique.
  var SKU_RE = /^[A-Za-z0-9._\-]{1,64}$/;
  function getCatalogSku() {
    try {
      var sku = new URLSearchParams(window.location.search).get('catalog_sku') || '';
      return SKU_RE.test(sku) ? sku : '';
    } catch(e) { return ''; }
  }

  // ── [08/10] Advanced Matching: email/telefone do checkout -> SHA-256 -> ttq.identify (antes dos eventos).
  //    Mesma normalizacao do servidor (email trim+lower; fone E.164 +55). Falha silenciosa: nunca quebra o checkout. ──
  (function ttAdvancedMatching() {
    try {
      if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') return;
      var last = '';
      var sha = function(s) {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function(b) {
          return Array.prototype.map.call(new Uint8Array(b), function(x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        });
      };
      var run = function() {
        try {
          var e = document.getElementById('email'), p = document.getElementById('telefone');
          if (!e && !p) return;
          var em = ((e && e.value) || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) em = '';
          var d = ((p && p.value) || '').replace(/\D/g, '');
          var ph = (d.length === 10 || d.length === 11) ? '+55' + d
                 : ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) ? '+' + d : '';
          var key = em + '|' + ph;
          if (key === '|' || key === last) return;
          last = key;
          Promise.all([em ? sha(em) : '', ph ? sha(ph) : '']).then(function(h) {
            var o = {};
            if (h[0]) o.email = h[0];
            if (h[1]) o.phone_number = h[1];
            if (typeof ttq !== 'undefined' && ttq.identify && (o.email || o.phone_number)) { ttq.identify(o); log('TT identify', Object.keys(o)); }
          }).catch(function() {});
        } catch(x) {}
      };
      var onField = function(ev) { var id = ev && ev.target && ev.target.id; if (id === 'email' || id === 'telefone') run(); };
      document.addEventListener('change', onField, true);
      document.addEventListener('blur', onField, true);
      document.addEventListener('click', function() { setTimeout(run, 0); }, true);   // botao Continuar/Confirmar
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { setTimeout(run, 800); });
      else setTimeout(run, 800);
    } catch(e) {}
  })();

  // ── Helpers ──
  function rand(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    for (var i = 0; i < len; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  function generateEventId(prefix) {
    // UUID-like: prefix_timestamp_random
    prefix = prefix || 'evt';
    return prefix + '_' + Date.now() + '_' + rand(8);
  }

  function log() {
    if (DEBUG && console && console.log) {
      var args = ['[MLA]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    }
  }

  function getPageName() {
    var path = window.location.pathname;
    // Detect funnel stage from URL
    if (path.indexOf('/prevsl') !== -1) return 'prevsl';
    if (path.indexOf('/vsl') !== -1) return 'vsl';
    if (path.indexOf('/questionario') !== -1) return 'questionario';
    if (path.indexOf('/roleta') !== -1) return 'roleta';
    if (path.indexOf('/recompensas') !== -1) return 'recompensas';
    if (path.indexOf('/produtos/') !== -1) {
      var parts = path.split('/').filter(function(p) { return p && p !== 'index.html'; });
      return 'produto:' + (parts[parts.length - 1] || 'unknown');
    }
    if (path.indexOf('/checkout') !== -1) return 'checkout';
    if (path.indexOf('/up') !== -1) return 'upsell';
    return path;
  }

  function getFunnelStage() {
    var stages = {
      'prevsl': 1,
      'vsl': 2,
      'questionario': 3,
      'roleta': 4,
      'recompensas': 5,
      'checkout': 7,
      'upsell': 8
    };
    var page = getPageName();
    if (page.indexOf('produto:') === 0) return 6;
    return stages[page] || 0;
  }

  function getStoredUTMs() {
    try {
      return JSON.parse(localStorage.getItem('ml_utms') || '{}');
    } catch(e) { return {}; }
  }

  function getStoredFBP() {
    // Try cookie first, then localStorage
    var match = document.cookie.match(/(?:^|;\s*)_fbp=([^;]*)/);
    if (match) return match[1];
    return localStorage.getItem('ml_fbp') || null;
  }

  function getStoredFBC() {
    var match = document.cookie.match(/(?:^|;\s*)_fbc=([^;]*)/);
    if (match) return match[1];
    return localStorage.getItem('ml_fbc') || null;
  }

  function getStoredTTClid() {
    return localStorage.getItem('ml_ttclid') || null;
  }

  // ── Track internal analytics event → POSTHOG ──
  function track(eventName, data) {
    data = data || {};

    var props = {
      session_id: sessionId,
      page: getPageName(),
      funnel_stage: getFunnelStage(),
      page_url: window.location.href,
      page_referrer: document.referrer || '',
      client_timestamp: new Date().toISOString(),
      experiment_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.id) ? window.__ML_EXPERIMENT.id : null,
      variant_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.variant) ? window.__ML_EXPERIMENT.variant : null
    };

    // Merge UTMs as flat properties
    var utms = getStoredUTMs();
    if (utms) {
      for (var uk in utms) {
        if (utms.hasOwnProperty(uk)) props['utm_' + uk.replace('utm_', '')] = utms[uk];
      }
    }

    // Merge custom data as flat properties (prefixed with "d_" to avoid collisions)
    for (var dk in data) {
      if (data.hasOwnProperty(dk)) props[dk] = data[dk];
    }

    log('track:', eventName, props);

    // ── Send to PostHog instead of /api/event.php ──
    try {
      if (window.location.protocol === 'file:') {
        log('SKIP (file:// protocol)');
        return;
      }
      if (typeof posthog !== 'undefined' && posthog.capture) {
        posthog.capture(eventName, props);
      } else {
        log('PostHog not loaded, event queued internally');
      }
    } catch(e) {
      log('track error:', e);
    }
  }

  // ── Facebook Pixel with dedup ──
  function fbTrack(eventName, customData, eventId) {
    if (typeof fbq !== 'function') {
      log('FB Pixel not loaded, skip:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('fb');

    var opts = { eventID: eventId };

    if (eventName === 'PageView') {
      // PageView is auto-tracked, but we can fire it explicitly
      fbq('track', 'PageView', {}, opts);
    } else {
      fbq('track', eventName, customData || {}, opts);
    }

    log('FB Pixel:', eventName, 'eventID:', eventId, customData);
    return eventId;
  }

  // ── Facebook Custom Event with dedup ──
  function fbTrackCustom(eventName, customData, eventId) {
    if (typeof fbq !== 'function') {
      log('FB Pixel not loaded, skip custom:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('fb');
    fbq('trackCustom', eventName, customData || {}, { eventID: eventId });
    log('FB Custom:', eventName, 'eventID:', eventId, customData);
    return eventId;
  }

  // ── TikTok Pixel with dedup ──
  function ttTrack(eventName, properties, eventId) {
    if (typeof ttq === 'undefined') {
      log('TikTok Pixel not loaded, skip:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('tt');

    var opts = {
      event_id: eventId
    };

    // Merge properties
    var data = {};
    if (properties) {
      for (var key in properties) {
        if (properties.hasOwnProperty(key)) {
          data[key] = properties[key];
        }
      }
    }

    // [08/10] produto = sku do catalogo do anuncio clicado (igual ao servidor) quando existir
    try {
      var sku = getCatalogSku();
      if (sku) {
        data.content_type = 'product';
        data.content_id = sku;
        var qty = data.quantity || 1;
        data.contents = [{ content_id: sku, content_type: 'product', quantity: qty, price: (data.value || 0) / qty }];
      }
    } catch(e) {}

    ttq.track(eventName, data, opts);
    log('TT Pixel:', eventName, 'event_id:', eventId, data);
    return eventId;
  }

  // ── Combined: Fire both FB + TT + internal analytics ──
  function fireEvent(eventName, opts) {
    opts = opts || {};
    var eventId = opts.eventId || generateEventId(eventName.toLowerCase().replace(/[^a-z]/g, ''));

    // Internal analytics → PostHog
    var analyticsData = opts.analyticsData || {};
    analyticsData.event_id = eventId;
    track(eventName, analyticsData);

    // Facebook Pixel
    if (opts.fb !== false) {
      var fbData = opts.fbData || opts.customData || {};
      if (opts.fbCustom) {
        fbTrackCustom(eventName, fbData, eventId);
      } else {
        fbTrack(opts.fbEventName || eventName, fbData, eventId);
      }
    }

    // TikTok Pixel
    if (opts.tt !== false) {
      var ttData = opts.ttData || opts.customData || {};
      ttTrack(opts.ttEventName || eventName, ttData, eventId);
    }

    return eventId;
  }

  // ── Specific funnel events ──

  // ViewContent: product page
  function trackViewContent(product) {
    var eventId = generateEventId('vc');
    var value = (product.price || 0) / 100;

    track('ViewContent', {
      event_id: eventId,
      product_id: product.id,
      product_name: product.name,
      value: value
    });

    fbTrack('ViewContent', {
      content_ids: [product.id],
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('ViewContent', {
      content_id: product.id,
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // AddToCart: product page
  function trackAddToCart(product) {
    var eventId = generateEventId('atc');
    var value = (product.price || 0) / 100;

    track('AddToCart', {
      event_id: eventId,
      product_id: product.id,
      product_name: product.name,
      value: value
    });

    fbTrack('AddToCart', {
      content_ids: [product.id],
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('AddToCart', {
      content_id: product.id,
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // InitiateCheckout: checkout page load (step 1)
  function trackInitiateCheckout(items, totalValue) {
    var eventId = generateEventId('ic');
    var value = (totalValue || 0) / 100;
    var contentIds = items.map(function(i) { return i.id; });

    track('InitiateCheckout', {
      event_id: eventId,
      num_items: items.length,
      value: value,
      content_ids: contentIds
    });

    fbTrack('InitiateCheckout', {
      content_ids: contentIds,
      content_type: 'product',
      num_items: items.length,
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('InitiateCheckout', {
      content_type: 'product',
      content_id: contentIds.join(','),
      quantity: items.length,
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // AddPaymentInfo: checkout step 5 (confirm)
  function trackAddPaymentInfo(items, totalValue) {
    var eventId = generateEventId('api');
    var value = (totalValue || 0) / 100;

    track('AddPaymentInfo', {
      event_id: eventId,
      payment_method: 'pix',
      value: value,
      num_items: items.length
    });

    fbTrack('AddPaymentInfo', {
      content_type: 'product',
      value: value,
      currency: 'BRL',
      content_ids: items.map(function(i) { return i.id; })
    }, eventId);

    ttTrack('AddPaymentInfo', {
      content_type: 'product',
      value: value,
      currency: 'BRL',
      description: 'PIX'
    }, eventId);

    return eventId;
  }

  // GeneratePixCode: custom event when QR appears
  function trackGeneratePixCode(paymentCode, totalValue, items) {
    var eventId = generateEventId('gpx');
    var value = (totalValue || 0) / 100;

    track('GeneratePixCode', {
      event_id: eventId,
      payment_code: paymentCode,
      value: value,
      num_items: (items || []).length
    });

    fbTrackCustom('GeneratePixCode', {
      value: value,
      currency: 'BRL',
      payment_method: 'pix',
      order_id: paymentCode,
      content_type: 'product',
      content_ids: (items || []).map(function(i) { return i.id; })
    }, eventId);

    // TikTok custom event
    ttTrack('GeneratePixCode', {
      value: value,
      currency: 'BRL',
      order_id: paymentCode,
      description: 'PIX QR Code Generated'
    }, eventId);

    return eventId;
  }

  // CopyPixCode: custom event when user copies PIX code
  function trackCopyPixCode(paymentCode) {
    var eventId = generateEventId('cpx');

    track('CopyPixCode', {
      event_id: eventId,
      payment_code: paymentCode
    });

    // Only browser-side (no server visibility)
    fbTrackCustom('CopyPixCode', {
      payment_method: 'pix',
      order_id: paymentCode
    }, eventId);

    ttTrack('ClickButton', {
      description: 'Copy PIX Code',
      order_id: paymentCode
    }, eventId);

    return eventId;
  }

  // Purchase: when payment confirmed on client
  // IMPORTANT: event_id MUST match server-side (fireApprovalTracking) for dedup
  function trackPurchase(paymentCode, totalValue, items) {
    var eventId = 'pur_' + paymentCode;
    var value = (totalValue || 0) / 100;
    var contentIds = (items || []).map(function(i) { return i.id; });

    track('Purchase', {
      event_id: eventId,
      payment_code: paymentCode,
      value: value,
      num_items: (items || []).length
    });

    fbTrack('Purchase', {
      value: value,
      currency: 'BRL',
      content_ids: contentIds,
      content_type: 'product',
      order_id: paymentCode
    }, eventId);

    // Mesmo nome e event_id do evento do servidor (Events API: Purchase / CP_<codigo>) => 1 venda so no TikTok
    ttTrack('Purchase', {
      content_type: 'product',
      content_id: contentIds.join(','),
      quantity: (items || []).reduce(function(sum, i) { return sum + (i.quantity || 1); }, 0),
      value: value,
      currency: 'BRL'
    }, 'CP_' + paymentCode);

    return eventId;
  }

  // Checkout step tracking
  function trackCheckoutStep(step, stepName) {
    track('checkout_step', {
      step: step,
      step_name: stepName || ('step_' + step)
    });
  }

  // Form error tracking
  function trackFormError(field, message) {
    track('form_error', {
      field: field,
      message: message
    });
  }

  // Funnel page view
  function trackFunnelView(page) {
    track('funnel_view', {
      page: page || getPageName(),
      funnel_stage: getFunnelStage()
    });
  }

  // ── Auto-track funnel page view on load ──
  document.addEventListener('DOMContentLoaded', function() {
    trackFunnelView();

    // Set PostHog super properties now that DOM is ready
    if (typeof posthog !== 'undefined' && posthog.register) {
      posthog.register({
        ml_session_id: sessionId,
        funnel_stage: getFunnelStage(),
        page_name: getPageName()
      });
    }
  });

  // ── Public API ──
  return {
    // Core
    track: track,
    fbTrack: fbTrack,
    fbTrackCustom: fbTrackCustom,
    ttTrack: ttTrack,
    fireEvent: fireEvent,
    generateEventId: generateEventId,

    // Specific funnel events
    trackViewContent: trackViewContent,
    trackAddToCart: trackAddToCart,
    trackInitiateCheckout: trackInitiateCheckout,
    trackAddPaymentInfo: trackAddPaymentInfo,
    trackGeneratePixCode: trackGeneratePixCode,
    trackCopyPixCode: trackCopyPixCode,
    trackPurchase: trackPurchase,
    trackCheckoutStep: trackCheckoutStep,
    trackFormError: trackFormError,
    trackFunnelView: trackFunnelView,

    // Utilities
    getSessionId: function() { return sessionId; },
    getPageName: getPageName,
    getFunnelStage: getFunnelStage,
    getStoredFBP: getStoredFBP,
    getStoredFBC: getStoredFBC,
    getStoredTTClid: getStoredTTClid,
    getStoredUTMs: getStoredUTMs,
    isDebug: function() { return DEBUG; }
  };

})();
