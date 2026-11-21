/**
 * TikTok Pixel Helper — Shared utilities for browser-side event tracking.
 * Used across all pages: landing, rewards, pagamento, upsells, capacete.
 *
 * Provides:
 *  - ttkEventId(): consistent event IDs for dedup with server events
 *  - ttkTrack(): wrapper that sends to all loaded pixels with proper params
 *  - ttkCaptureTtclid(): captures ttclid from URL (sessionStorage + localStorage + cookie 7d)
 *  - ttkGetTtclid(): retrieves stored ttclid
 *  - ttkVisitorId(): stable visitor ID shared by all funnel steps (external_id on browser AND server)
 *  - ttkGetTracking(): {visitor_id, ttclid, ttp, page_url, page_referrer} sent to /api/pagamento.php
 *  - ttkIdentify(): ttq.identify({external_id}) — runs automatically once the pixel loads
 */

var TTK_COOKIE_DAYS_VISITOR = 90;
var TTK_COOKIE_DAYS_TTCLID = 7;
var TTK_LANDING_HOURS = 2;

function ttkReadCookie(name) {
    try {
        var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
        return '';
    }
}

function ttkWriteCookie(name, value, maxAgeSeconds) {
    try {
        document.cookie = name + '=' + encodeURIComponent(value) + ';max-age=' + maxAgeSeconds + ';path=/;SameSite=Lax';
    } catch (e) {}
}

function ttkStorageGet(storage, key) {
    try { return window[storage].getItem(key) || ''; } catch (e) { return ''; }
}

function ttkStorageSet(storage, key, value) {
    try { window[storage].setItem(key, value); } catch (e) {}
}

/**
 * Generate a consistent event ID for deduplication between browser and server.
 * Format: {EventPrefix}_{transactionId}_{unixTimestamp}
 *
 * @param {string} prefix - Event prefix (e.g. 'IC', 'CP')
 * @param {string} txnId  - Transaction ID
 * @param {number} [ts]   - Optional Unix timestamp (seconds). Uses current time if omitted.
 * @returns {string}
 */
function ttkEventId(prefix, txnId, ts) {
    var timestamp = ts || Math.floor(Date.now() / 1000);
    return prefix + '_' + txnId + '_' + timestamp;
}

/**
 * Send a TikTok pixel event to all loaded pixels.
 * Wraps ttq.track with standard parameter formatting.
 *
 * @param {string} eventName  - TikTok standard event name
 * @param {Object} params     - Event parameters
 * @param {string} [eventId]  - Event ID for deduplication
 */
function ttkTrack(eventName, params, eventId) {
    if (typeof ttq === 'undefined') {
        console.warn('[TikTok Pixel] ttq not loaded, skipping:', eventName);
        return;
    }

    var properties = {
        content_type: params.content_type || 'product',
        content_id: params.content_id || '',
        content_name: params.content_name || '',
        value: params.value || 0,
        currency: params.currency || 'BRL'
    };

    if (params.order_id) {
        properties.order_id = params.order_id;
    }

    if (params.contents) {
        properties.contents = params.contents;
    }

    var opts = eventId ? { event_id: eventId } : {};

    ttq.track(eventName, properties, opts);

    console.log('[TikTok Pixel] ' + eventName, properties, opts);
}

/**
 * Fire an event only once per event_id in this browser (reload of the paid page must not re-fire).
 * @returns {boolean} true if fired now
 */
function ttkTrackOnce(eventName, params, eventId) {
    var key = 'ttk_sent_' + eventId;
    if (ttkStorageGet('localStorage', key)) return false;
    if (typeof ttq === 'undefined') return false;
    ttkTrack(eventName, params, eventId);
    ttkStorageSet('localStorage', key, '1');
    return true;
}

/**
 * Capture ttclid from URL and persist it (sessionStorage + localStorage + cookie 7 days),
 * so it survives closing the TikTok in-app browser and coming back.
 */
function ttkCaptureTtclid() {
    try {
        var qs = new URLSearchParams(window.location.search);
        var ttclid = qs.get('ttclid') || qs.get('tiktok_clid');
        if (ttclid && ttclid !== 'null' && ttclid !== 'undefined') {
            ttkStorageSet('sessionStorage', 'ttclid', ttclid);
            ttkStorageSet('localStorage', 'ttclid', ttclid);
            ttkWriteCookie('ttclid', ttclid, TTK_COOKIE_DAYS_TTCLID * 86400);
        }
    } catch (e) {}
}

/**
 * Retrieve the stored ttclid value.
 * @returns {string|null}
 */
function ttkGetTtclid() {
    try {
        return new URLSearchParams(window.location.search).get('ttclid')
            || new URLSearchParams(window.location.search).get('tiktok_clid')
            || ttkStorageGet('sessionStorage', 'ttclid')
            || ttkStorageGet('localStorage', 'ttclid')
            || ttkReadCookie('ttclid')
            || null;
    } catch (e) {
        return null;
    }
}

/**
 * Landing URL (first page of the session, carries ttclid/UTMs) and its referrer.
 */
function ttkCaptureLanding() {
    if (ttkStorageGet('sessionStorage', 'ttk_landing_url') || ttkReadCookie('ttk_landing_url')) return;
    var url = window.location.href;
    ttkStorageSet('sessionStorage', 'ttk_landing_url', url);
    ttkWriteCookie('ttk_landing_url', url.slice(0, 1500), TTK_LANDING_HOURS * 3600);
    if (document.referrer) {
        ttkStorageSet('sessionStorage', 'ttk_landing_referrer', document.referrer);
        ttkWriteCookie('ttk_landing_referrer', document.referrer.slice(0, 1000), TTK_LANDING_HOURS * 3600);
    }
}

/**
 * Stable visitor ID (localStorage + cookie 90 days). Links all 7 steps to the same person:
 * external_id on ttq.identify and on server events, and key of the Subscribe total.
 * @returns {string}
 */
function ttkVisitorId() {
    var vid = ttkStorageGet('localStorage', 'ttk_vid') || ttkReadCookie('ttk_vid');
    if (!/^v_[a-z0-9]{8,40}$/.test(vid)) {
        var rand = '';
        try {
            var bytes = new Uint8Array(12);
            window.crypto.getRandomValues(bytes);
            for (var i = 0; i < bytes.length; i++) rand += ('0' + bytes[i].toString(16)).slice(-2);
        } catch (e) {
            rand = (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
        }
        vid = 'v_' + rand;
    }
    ttkStorageSet('localStorage', 'ttk_vid', vid);
    ttkWriteCookie('ttk_vid', vid, TTK_COOKIE_DAYS_VISITOR * 86400);
    return vid;
}

/**
 * Tracking data for /api/pagamento.php (stored on the order and reused by server events).
 */
function ttkGetTracking() {
    return {
        visitor_id: ttkVisitorId(),
        ttclid: ttkGetTtclid() || '',
        ttp: ttkReadCookie('_ttp'),
        page_url: ttkStorageGet('sessionStorage', 'ttk_landing_url') || ttkReadCookie('ttk_landing_url') || window.location.href,
        page_referrer: ttkStorageGet('sessionStorage', 'ttk_landing_referrer') || ttkReadCookie('ttk_landing_referrer') || document.referrer || ''
    };
}

/**
 * SHA-256 hex (lowercase + trim), same normalization as the server (TikTokEvents::hashForTikTok).
 * crypto.subtle only exists on HTTPS/localhost; without it the raw value is passed and the
 * TikTok pixel hashes it itself before sending.
 */
function ttkSha256(value, cb) {
    var normalized = String(value).trim().toLowerCase();
    try {
        if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') throw new Error('no subtle');
        window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)).then(function (buf) {
            var arr = Array.prototype.slice.call(new Uint8Array(buf));
            cb(arr.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''));
        }, function () { cb(normalized); });
    } catch (e) {
        cb(normalized);
    }
}

var ttkIdentified = false;

/**
 * ttq.identify with the visitor external_id (+ optional real email/phone).
 * @param {Object} [extra] {email, phone} — only REAL customer data
 */
function ttkIdentify(extra) {
    if (typeof ttq === 'undefined' || typeof ttq.identify !== 'function') return false;
    var data = { external_id: ttkVisitorId() };
    extra = extra || {};
    if (extra.email) data.email = extra.email;
    if (extra.phone) {
        var d = String(extra.phone).replace(/\D/g, '');
        if (d) data.phone_number = (d.indexOf('55') === 0 && (d.length === 12 || d.length === 13)) ? '+' + d : '+55' + d.replace(/^0+/, '');
    }
    var keys = Object.keys(data);
    var out = {};
    var pending = keys.length;
    keys.forEach(function (k) {
        ttkSha256(data[k], function (h) {
            out[k] = h;
            if (--pending === 0) {
                try { ttq.identify(out); } catch (e) {}
            }
        });
    });
    ttkIdentified = true;
    return true;
}

// catalog_sku (produto do anuncio de catalogo): guarda em toda pagina para chegar ate o pagamento
(function () {
    try {
        var sku = new URLSearchParams(window.location.search).get('catalog_sku');
        if (sku) { ttkStorageSet('localStorage', 'catalog_sku', sku); }
    } catch (e) {}
})();

// Auto-capture on load
ttkCaptureTtclid();
ttkCaptureLanding();
ttkVisitorId();

// Identify as soon as the pixel (loaded async from /api/pixel-config.php) is available
(function () {
    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        if (ttkIdentified || ttkIdentify() || tries >= 40) clearInterval(timer);
    }, 250);
})();
