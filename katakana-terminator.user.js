// ==UserScript==
// @name        Katakana Terminator
// @description Convert gairaigo (Japanese loan words) back to English with parenthetical glosses
// @author      Arnie97
// @license     MIT
// @copyright   2017-2026, Katakana Terminator Contributors (https://github.com/Arnie97/katakana-terminator/graphs/contributors)
// @namespace   https://github.com/Arnie97
// @homepageURL https://github.com/JohnsonRan/katakana-terminator
// @supportURL  https://greasyfork.org/scripts/33268/feedback
// @downloadURL https://github.com/JohnsonRan/katakana-terminator/raw/master/katakana-terminator.user.js
// @updateURL   https://github.com/JohnsonRan/katakana-terminator/raw/master/katakana-terminator.user.js
// @icon        https://upload.wikimedia.org/wikipedia/commons/2/28/Ja-Ruby.png
// @match       *://*/*
// @exclude     *://*.bilibili.com/video/*
// @run-at      document-idle
// @grant       GM.xmlHttpRequest
// @grant       GM_xmlhttpRequest
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM.getValue
// @grant       GM.setValue
// @grant       GM.registerMenuCommand
// @connect     translate.google.cn
// @connect     translate.google.com
// @connect     translate.googleapis.com
// @version     2026.07.30.5
// @name:ja-JP  カタカナターミネーター
// @name:zh-CN  片假名终结者
// @description:zh-CN 在网页中的日语外来语后用括号标注英文原词
// ==/UserScript==

(function () {
    'use strict';

    // ---- GM polyfills (Greasemonkey 4 / modern managers) ----
    var gmXmlHttpRequest = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (typeof GM === 'object' && GM && typeof GM.xmlHttpRequest === 'function'
            ? GM.xmlHttpRequest
            : null);

    function gmGetValueAsync(key, def) {
        try {
            if (typeof GM_getValue === 'function') {
                return Promise.resolve(GM_getValue(key, def));
            }
            if (typeof GM === 'object' && GM && typeof GM.getValue === 'function') {
                return Promise.resolve(GM.getValue(key, def));
            }
        } catch (err) {
            console.warn('Katakana Terminator: getValue failed', err);
        }
        return Promise.resolve(def);
    }

    function gmSetValue(key, val) {
        try {
            if (typeof GM_setValue === 'function') {
                return GM_setValue(key, val);
            }
            if (typeof GM === 'object' && GM && typeof GM.setValue === 'function') {
                return GM.setValue(key, val);
            }
        } catch (err) {
            console.warn('Katakana Terminator: setValue failed', err);
        }
    }

    var gmRegisterMenuCommand = typeof GM_registerMenuCommand === 'function'
        ? GM_registerMenuCommand
        : (typeof GM === 'object' && GM && typeof GM.registerMenuCommand === 'function'
            ? GM.registerMenuCommand
            : null);

    function gmAddStyle(css) {
        if (typeof GM_addStyle === 'function') {
            return GM_addStyle(css);
        }
        var head = document.getElementsByTagName('head')[0];
        if (!head) {
            return null;
        }
        var style = document.createElement('style');
        style.setAttribute('type', 'text/css');
        style.textContent = css;
        head.appendChild(style);
        return style;
    }

    if (!gmXmlHttpRequest) {
        console.error('Katakana Terminator: GM.xmlHttpRequest is unavailable');
        return;
    }

    // ---- Storage keys / tunables ----
    var STORAGE_CACHE = 'kt_translations_v1';
    var STORAGE_ENABLED = 'kt_enabled';
    var STORAGE_BLACKLIST = 'kt_blacklist';
    var CACHE_MAX_ENTRIES = 2500;
    var CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    var FAIL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
    var RESCAN_DEBOUNCE_MS = 200;
    var RESCAN_FALLBACK_MS = 4000;
    var VIEWPORT_RESCAN_MS = 250;
    // Slightly expand the viewport so words near the edge are ready while scrolling.
    var VIEWPORT_MARGIN_PX = 80;
    var MAX_URL_QUERY_BYTES = 1600;
    var MAX_INFLIGHT_REQUESTS = 2;
    var MIN_JP_CHARS_FOR_EAGER = 15;

    // ---- Runtime state ----
    var queue = {}; // {"カタカナ": [rtNodeA, rtNodeB]}
    var cachedTranslations = {}; // {"ターミネーター": "Terminator"}
    var cacheMeta = {}; // {phrase: lastUsedMs}
    var failedTranslations = {}; // {phrase: failedAtMs}
    var newNodes = new Set();
    var visibilityCache = new WeakMap(); // element -> rendered?
    var userVisibleCache = new WeakMap(); // element -> currently on-screen?
    var clipStyleCache = new WeakMap(); // element -> clips descendants?
    var rescanTimer = null;
    var viewportRescanTimer = null;
    var persistTimer = null;
    var observer = null;
    var started = false;
    var eagerMode = false;
    var inflightRequests = 0;
    var pendingChunks = []; // [{phrases, apiIndex}]
    var translateScheduled = false;

    var KATAKANA_RE = /[\u30A1-\u30FA\u30FD-\u30FF][\u3099\u309A\u30A1-\u30FF]*[\u3099\u309A\u30A1-\u30FA\u30FC-\u30FF]|[\uFF66-\uFF6F\uFF71-\uFF9D][\uFF65-\uFF9F]*[\uFF66-\uFF9F]/;
    var JP_CHAR_RE = /[\u3040-\u30FF\u3400-\u9FFF\uFF66-\uFF9D]/g;

    var EXCLUDE_TAGS = {
        code: true, kbd: true, math: true, noscript: true, option: true,
        pre: true, ruby: true, samp: true, script: true, select: true,
        style: true, svg: true, template: true, textarea: true,
    };

    // ---- Settings (in-memory mirrors loaded at startup) ----
    var settingEnabled = true;
    var settingBlacklist = [];

    function writeEnabled(enabled) {
        settingEnabled = !!enabled;
        gmSetValue(STORAGE_ENABLED, settingEnabled);
    }

    function writeBlacklist(list) {
        settingBlacklist = list;
        gmSetValue(STORAGE_BLACKLIST, JSON.stringify(list));
    }

    function hostBlacklisted(hostname) {
        hostname = (hostname || '').toLowerCase();
        for (var i = 0; i < settingBlacklist.length; i++) {
            var item = String(settingBlacklist[i] || '').toLowerCase();
            if (!item) {
                continue;
            }
            if (hostname === item || hostname.endsWith('.' + item)) {
                return true;
            }
        }
        return false;
    }

    function isScriptActive() {
        return settingEnabled && !hostBlacklisted(location.hostname);
    }

    function parseBlacklist(raw) {
        try {
            var list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(list) ? list : [];
        } catch (err) {
            return [];
        }
    }

    // ---- Persistent translation cache ----
    function applyPersistentCache(raw) {
        if (!raw) {
            return;
        }
        try {
            var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!data || typeof data !== 'object') {
                return;
            }
            var now = Date.now();
            var entries = data.entries || data;
            Object.keys(entries).forEach(function (phrase) {
                var item = entries[phrase];
                if (!item) {
                    return;
                }
                if (typeof item === 'string') {
                    cachedTranslations[phrase] = item;
                    cacheMeta[phrase] = now;
                    return;
                }
                if (item.t && item.u && (now - item.u) < CACHE_TTL_MS) {
                    cachedTranslations[phrase] = item.t;
                    cacheMeta[phrase] = item.u;
                }
            });
        } catch (err) {
            console.warn('Katakana Terminator: cache load failed', err);
        }
    }

    function schedulePersistCache() {
        if (persistTimer) {
            return;
        }
        persistTimer = setTimeout(function () {
            persistTimer = null;
            persistCache();
        }, 1500);
    }

    function persistCache() {
        var phrases = Object.keys(cachedTranslations).filter(function (p) {
            return typeof cachedTranslations[p] === 'string' && cachedTranslations[p];
        });
        phrases.sort(function (a, b) {
            return (cacheMeta[b] || 0) - (cacheMeta[a] || 0);
        });
        if (phrases.length > CACHE_MAX_ENTRIES) {
            phrases = phrases.slice(0, CACHE_MAX_ENTRIES);
        }
        var entries = {};
        var now = Date.now();
        phrases.forEach(function (phrase) {
            entries[phrase] = {
                t: cachedTranslations[phrase],
                u: cacheMeta[phrase] || now,
            };
        });
        try {
            gmSetValue(STORAGE_CACHE, JSON.stringify({
                v: 1,
                savedAt: now,
                entries: entries,
            }));
        } catch (err) {
            console.warn('Katakana Terminator: cache save failed', err);
        }
    }

    function rememberTranslation(original, translated) {
        cachedTranslations[original] = translated;
        cacheMeta[original] = Date.now();
        delete failedTranslations[original];
        schedulePersistCache();
    }

    function isOnCooldown(phrase) {
        var failedAt = failedTranslations[phrase];
        if (!failedAt) {
            return false;
        }
        if (Date.now() - failedAt > FAIL_COOLDOWN_MS) {
            delete failedTranslations[phrase];
            return false;
        }
        return true;
    }

    function markFailed(phrases) {
        var now = Date.now();
        phrases.forEach(function (phrase) {
            failedTranslations[phrase] = now;
            if (cachedTranslations[phrase] === null) {
                delete cachedTranslations[phrase];
            }
        });
    }

    // ---- Visibility ----
    // Two layers:
    // 1) isRenderedElement — CSS says the node participates in rendering
    // 2) isUserVisible — the node currently paints inside the viewport and is
    //    not clipped away by overflow/aria-hidden ancestors (what the user sees).
    function isAriaOrInertHidden(element) {
        // Hidden menus/panels often stay in the layout tree with aria-hidden/inert
        // even when checkVisibility() still reports them as visible.
        var current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            if (current.inert) {
                return true;
            }
            if (current.getAttribute && current.getAttribute('aria-hidden') === 'true') {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }

    function getViewportRect(margin) {
        margin = margin || 0;
        var viewport = window.visualViewport;
        var left = (viewport ? viewport.offsetLeft : 0) - margin;
        var top = (viewport ? viewport.offsetTop : 0) - margin;
        var width = (viewport ? viewport.width : window.innerWidth) + margin * 2;
        var height = (viewport ? viewport.height : window.innerHeight) + margin * 2;
        return {
            left: left,
            top: top,
            right: left + width,
            bottom: top + height,
            width: width,
            height: height,
        };
    }

    function rectsIntersect(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    function intersectRects(a, b) {
        var left = Math.max(a.left, b.left);
        var top = Math.max(a.top, b.top);
        var right = Math.min(a.right, b.right);
        var bottom = Math.min(a.bottom, b.bottom);
        if (right <= left || bottom <= top) {
            return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        }
        return {
            left: left,
            top: top,
            right: right,
            bottom: bottom,
            width: right - left,
            height: bottom - top,
        };
    }

    function elementClipsDescendants(element) {
        if (clipStyleCache.has(element)) {
            return clipStyleCache.get(element);
        }
        var style = window.getComputedStyle(element);
        var overflowX = style.overflowX;
        var overflowY = style.overflowY;
        var clips = overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto' ||
            overflowX === 'scroll' || overflowY === 'hidden' || overflowY === 'clip' ||
            overflowY === 'auto' || overflowY === 'scroll' || style.contain === 'paint' ||
            style.contain === 'strict' || style.contain === 'content' ||
            style.contentVisibility === 'auto' || style.contentVisibility === 'hidden' ||
            (style.clipPath && style.clipPath !== 'none');
        clipStyleCache.set(element, clips);
        return clips;
    }

    // True when the element's box currently intersects the (margined) viewport
    // after clipping by overflow ancestors. This is the "is it on screen now?" test.
    function isUserVisible(element, margin) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (userVisibleCache.has(element)) {
            return userVisibleCache.get(element);
        }
        if (!isRenderedElement(element) || isAriaOrInertHidden(element)) {
            userVisibleCache.set(element, false);
            return false;
        }

        var rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            userVisibleCache.set(element, false);
            return false;
        }

        var viewportRect = getViewportRect(margin == null ? VIEWPORT_MARGIN_PX : margin);
        var visibleRect = {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };

        if (!rectsIntersect(visibleRect, viewportRect)) {
            userVisibleCache.set(element, false);
            return false;
        }

        var parent = element.parentElement;
        while (parent && parent.nodeType === Node.ELEMENT_NODE &&
            parent !== document.documentElement) {
            if (elementClipsDescendants(parent)) {
                var parentRect = parent.getBoundingClientRect();
                visibleRect = intersectRects(visibleRect, parentRect);
                if (!visibleRect.width || !visibleRect.height) {
                    userVisibleCache.set(element, false);
                    return false;
                }
            }
            parent = parent.parentElement;
        }

        var visible = rectsIntersect(visibleRect, viewportRect);
        userVisibleCache.set(element, visible);
        return visible;
    }

    // Whether a DOM Range currently paints inside the viewport after overflow clip.
    function isRangeUserVisible(range, clipRoot, margin) {
        if (!range) {
            return false;
        }
        var rects;
        try {
            rects = range.getClientRects();
        } catch (err) {
            return false;
        }
        if (!rects || !rects.length) {
            return false;
        }

        var viewportRect = getViewportRect(margin == null ? VIEWPORT_MARGIN_PX : margin);
        var parent = clipRoot;
        for (var i = 0; i < rects.length; i++) {
            var rect = rects[i];
            if (!rect.width && !rect.height) {
                continue;
            }
            var visibleRect = {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
            };
            if (!rectsIntersect(visibleRect, viewportRect)) {
                continue;
            }

            var ancestor = parent;
            var clippedOut = false;
            while (ancestor && ancestor.nodeType === Node.ELEMENT_NODE &&
                ancestor !== document.documentElement) {
                if (elementClipsDescendants(ancestor)) {
                    visibleRect = intersectRects(visibleRect, ancestor.getBoundingClientRect());
                    if (!visibleRect.width || !visibleRect.height) {
                        clippedOut = true;
                        break;
                    }
                }
                ancestor = ancestor.parentElement;
            }
            if (clippedOut) {
                continue;
            }
            if (rectsIntersect(visibleRect, viewportRect)) {
                return true;
            }
        }
        return false;
    }

    // Text-node geometry matters: a tall parent can intersect the viewport while
    // the katakana itself is still below the fold.
    function isTextNodeUserVisible(textNode, margin) {
        var parent = textNode && textNode.parentElement;
        if (!parent || !textNode.nodeValue || !isRenderedElement(parent) ||
            isAriaOrInertHidden(parent)) {
            return false;
        }

        try {
            var range = document.createRange();
            range.selectNodeContents(textNode);
            return isRangeUserVisible(range, parent, margin);
        } catch (err) {
            return isUserVisible(parent, margin);
        }
    }

    function isMatchUserVisible(textNode, start, end, margin) {
        var parent = textNode && textNode.parentElement;
        if (!parent || !isRenderedElement(parent) || isAriaOrInertHidden(parent)) {
            return false;
        }
        try {
            var range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, end);
            return isRangeUserVisible(range, parent, margin);
        } catch (err) {
            return isUserVisible(parent, margin);
        }
    }

    // Can this element's descendants possibly paint on screen? Used to prune DFS.
    // Overflow:visible parents may paint children outside their own box, so only
    // prune when the element itself clips (or has no box while rendered as a box).
    function canSubtreeBeUserVisible(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (!isRenderedElement(element) || isAriaOrInertHidden(element)) {
            return false;
        }
        var style = window.getComputedStyle(element);
        if (style.display === 'contents') {
            return true;
        }
        var rect = element.getBoundingClientRect();
        if (!rect.width && !rect.height) {
            // Zero-box elements can still host overflowing visible children.
            return !elementClipsDescendants(element);
        }
        if (!elementClipsDescendants(element)) {
            return true;
        }
        return rectsIntersect(rect, getViewportRect(VIEWPORT_MARGIN_PX));
    }

    function isRenderedElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (visibilityCache.has(element)) {
            return visibilityCache.get(element);
        }

        var visible;
        if (isAriaOrInertHidden(element)) {
            visibilityCache.set(element, false);
            return false;
        }

        var ownStyle = window.getComputedStyle(element);
        // display:contents has no box of its own, but its descendants can still be
        // visible. Let the ancestor fallback handle that case.
        if (ownStyle.display !== 'contents' &&
            typeof element.checkVisibility === 'function') {
            visible = element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
            });
            visibilityCache.set(element, visible);
            return visible;
        }

        // Fallback for browsers without Element.checkVisibility(). Walk ancestors
        // because getComputedStyle(element) alone does not expose display:none on a
        // parent. "hidden" is checked explicitly for older browser engines.
        var current = element;
        visible = true;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            if (visibilityCache.has(current)) {
                visible = visibilityCache.get(current);
                break;
            }
            if (current.hidden) {
                visible = false;
                break;
            }
            var style = current === element ? ownStyle : window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || parseFloat(style.opacity) === 0 ||
                style.contentVisibility === 'hidden') {
                visible = false;
                break;
            }
            current = current.parentElement;
        }

        // Cache the result on the element and positive ancestors for this scan pass.
        visibilityCache.set(element, visible);
        return visible;
    }

    function resetVisibilityCache() {
        visibilityCache = new WeakMap();
        userVisibleCache = new WeakMap();
        clipStyleCache = new WeakMap();
    }

    function shouldSkipElement(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return true;
        }
        if (node.classList.contains('katakana-terminator-word') ||
            node.classList.contains('katakana-terminator-gloss')) {
            return true;
        }
        var tag = node.tagName && node.tagName.toLowerCase();
        if (tag && tag in EXCLUDE_TAGS) {
            return true;
        }
        if (node.isContentEditable) {
            return true;
        }
        return false;
    }

    function nodeHasKatakana(node) {
        if (!node) {
            return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return !!(node.nodeValue && KATAKANA_RE.test(node.nodeValue));
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            // textContent is cheaper than a full walk for the sparse-mode gate.
            var text = node.textContent;
            return !!(text && KATAKANA_RE.test(text));
        }
        return false;
    }

    // Iterative DFS — avoids deep recursion and intermediate child arrays.
    // Only wraps katakana that is currently user-visible; off-screen / clipped /
    // aria-hidden text is left alone until a later viewport rescan.
    function scanTextNodes(root) {
        if (!root || !document.body || !document.body.contains(root)) {
            return;
        }

        var stack = [root];
        while (stack.length) {
            var node = stack.pop();
            if (!node) {
                continue;
            }

            // Node may have been detached while waiting in the buffer.
            if (node !== document.body && (!node.parentNode || !document.body.contains(node))) {
                continue;
            }

            if (node.nodeType === Node.ELEMENT_NODE) {
                if (shouldSkipElement(node) || !canSubtreeBeUserVisible(node)) {
                    continue;
                }
                var children = node.childNodes;
                for (var i = children.length - 1; i >= 0; i--) {
                    stack.push(children[i]);
                }
                continue;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                if (!isTextNodeUserVisible(node)) {
                    continue;
                }
                while ((node = addRuby(node)));
            }
        }
    }

    // Wrap visible katakana matches and append an empty gloss slot for the English.
    // Inspired by http://www.the-art-of-web.com/javascript/search-highlight/
    // Result: カタカナ（Katakana）
    function addRuby(node) {
        var match;
        if (!node.nodeValue || !(match = KATAKANA_RE.exec(node.nodeValue))) {
            return false;
        }

        var start = match.index;
        var end = start + match[0].length;
        // Only wrap the specific match when that glyph box is on-screen. Off-screen
        // matches are left as plain text and picked up by a later viewport rescan.
        if (!isMatchUserVisible(node, start, end)) {
            if (end >= node.nodeValue.length) {
                return false;
            }
            return node.splitText(end);
        }

        var word = document.createElement('span');
        word.classList.add('katakana-terminator-word');
        word.appendChild(document.createTextNode(match[0]));
        var gloss = document.createElement('span');
        gloss.classList.add('katakana-terminator-gloss');
        word.appendChild(gloss);

        queue[match[0]] = queue[match[0]] || [];
        queue[match[0]].push(gloss);

        // <span>[startカナmiddleテストend]</span> =>
        // <span>start<span class="word">カナ<span class="gloss"></span></span>[middleテストend]</span>
        var after = node.splitText(start);
        node.parentNode.insertBefore(word, after);
        after.nodeValue = after.nodeValue.substring(match[0].length);
        return after;
    }

    // ---- Translation / API ----
    function buildQueryString(params) {
        return '?' + Object.keys(params).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');
    }

    // Split by encoded query length so GET URLs stay under practical limits.
    function chunkPhrasesByUrlLimit(phrases, api) {
        var chunks = [];
        var current = [];
        var baseParams = api.params([]);
        delete baseParams.q;
        // base query + "&q=" prefix for the joined payload
        var baseLen = buildQueryString(baseParams).length + 3;
        var currentQLen = 0;

        phrases.forEach(function (phrase) {
            var encodedLen = encodeURIComponent(phrase).length;
            var extra = current.length ? 3 + encodedLen : encodedLen; // %0A separators

            // Always allow a single oversized phrase through (server may still reject).
            if (current.length && baseLen + currentQLen + extra > MAX_URL_QUERY_BYTES) {
                chunks.push(current);
                current = [phrase];
                currentQLen = encodedLen;
                return;
            }
            current.push(phrase);
            currentQLen += extra;
        });
        if (current.length) {
            chunks.push(current);
        }
        return chunks;
    }

    function translateTextNodes() {
        var apiRequestCount = 0;
        var phraseCount = 0;
        var pending = [];

        Object.keys(queue).forEach(function (phrase) {
            phraseCount++;
            if (isOnCooldown(phrase)) {
                return;
            }
            if (typeof cachedTranslations[phrase] === 'string' && cachedTranslations[phrase]) {
                cacheMeta[phrase] = Date.now();
                updateRubyByCachedTranslations(phrase);
                return;
            }
            // null means in-flight; skip until response or failure handling clears it.
            if (cachedTranslations[phrase] === null) {
                return;
            }
            pending.push(phrase);
        });

        if (!pending.length) {
            if (phraseCount) {
                console.debug('Katakana Terminator:', phraseCount, 'phrases handled from cache, frame', window.location.href);
            }
            return;
        }

        var api = APIS[0];
        var chunks = chunkPhrasesByUrlLimit(pending, api);
        chunks.forEach(function (chunk) {
            apiRequestCount++;
            enqueueTranslate(chunk, 0);
        });

        console.debug('Katakana Terminator:', pending.length, 'phrases queued in', apiRequestCount, 'requests, frame', window.location.href);
        pumpTranslateQueue();
    }

    function enqueueTranslate(phrases, apiIndex) {
        pendingChunks.push({ phrases: phrases, apiIndex: apiIndex || 0 });
    }

    function pumpTranslateQueue() {
        if (translateScheduled) {
            return;
        }
        translateScheduled = true;
        // Microtask-ish: allow callers to enqueue a batch first.
        setTimeout(function () {
            translateScheduled = false;
            while (inflightRequests < MAX_INFLIGHT_REQUESTS && pendingChunks.length) {
                var job = pendingChunks.shift();
                translate(job.phrases, job.apiIndex);
            }
        }, 0);
    }

    function translate(phrases, apiIndex) {
        if (!phrases || !phrases.length) {
            return;
        }
        apiIndex = apiIndex || 0;

        if (apiIndex >= APIS.length) {
            console.error('Katakana Terminator: fallbacks exhausted', phrases);
            markFailed(phrases);
            pumpTranslateQueue();
            return;
        }

        // Prevent duplicate HTTP requests before the request completes.
        phrases.forEach(function (phrase) {
            cachedTranslations[phrase] = null;
        });

        var api = APIS[apiIndex];
        var url = 'https://' + api.hosts[0] + api.path + buildQueryString(api.params(phrases));
        inflightRequests++;

        gmXmlHttpRequest({
            method: 'GET',
            url: url,
            onload: function (dom) {
                inflightRequests--;
                try {
                    api.callback(phrases, JSON.parse(dom.responseText.replace("'", '\u2019')));
                } catch (err) {
                    console.error('Katakana Terminator: invalid response from', api.name, err);
                    // Retry the same phrases on the next API — do not permanently
                    // destroy the global API list on a single transient failure.
                    phrases.forEach(function (phrase) {
                        if (cachedTranslations[phrase] === null) {
                            delete cachedTranslations[phrase];
                        }
                    });
                    enqueueTranslate(phrases, apiIndex + 1);
                }
                pumpTranslateQueue();
            },
            onerror: function () {
                inflightRequests--;
                console.error('Katakana Terminator: request error', api.name, url);
                phrases.forEach(function (phrase) {
                    if (cachedTranslations[phrase] === null) {
                        delete cachedTranslations[phrase];
                    }
                });
                enqueueTranslate(phrases, apiIndex + 1);
                pumpTranslateQueue();
            },
        });
    }

    var APIS = [
        {
            // https://github.com/Arnie97/katakana-terminator/pull/8
            name: 'Google Translate',
            hosts: ['translate.googleapis.com'],
            path: '/translate_a/single',
            params: function (phrases) {
                var joinedText = phrases.join('\n').replace(/\s+$/, '');
                return {
                    sl: 'ja',
                    tl: 'en',
                    dt: 't',
                    client: 'gtx',
                    q: joinedText,
                };
            },
            callback: function (phrases, resp) {
                resp[0].forEach(function (item) {
                    var translated = item[0].replace(/\s+$/, '');
                    var original = item[1].replace(/\s+$/, '');
                    rememberTranslation(original, translated);
                    updateRubyByCachedTranslations(original);
                });
            },
        },
        {
            // https://github.com/ssut/py-googletrans/issues/268
            name: 'Google Dictionary',
            hosts: ['translate.google.cn'],
            path: '/translate_a/t',
            params: function (phrases) {
                var joinedText = phrases.join('\n').replace(/\s+$/, '');
                return {
                    sl: 'ja',
                    tl: 'en',
                    dt: 't',
                    client: 'dict-chrome-ex',
                    q: joinedText,
                };
            },
            callback: function (phrases, resp) {
                // ["katakana\nterminator"]
                if (!resp.sentences) {
                    var translated = resp[0].split('\n');
                    if (translated.length !== phrases.length) {
                        throw [phrases, resp];
                    }
                    translated.forEach(function (trans, i) {
                        var orig = phrases[i];
                        rememberTranslation(orig, trans);
                        updateRubyByCachedTranslations(orig);
                    });
                    return;
                }

                resp.sentences.forEach(function (s) {
                    if (!s.orig) {
                        return;
                    }
                    var original = s.orig.trim();
                    var translatedText = s.trans.trim();
                    rememberTranslation(original, translatedText);
                    updateRubyByCachedTranslations(original);
                });
            },
        },
    ];

    // ---- Annotations ----
    // Append the English gloss in parentheses after the original katakana:
    // カタカナ（Terminator）. Stays in normal text flow — no overlay, no extra line box.
    function updateRubyByCachedTranslations(phrase) {
        if (!cachedTranslations[phrase]) {
            return;
        }
        (queue[phrase] || []).forEach(function (node) {
            if (!node || !node.isConnected) {
                return;
            }
            var translation = cachedTranslations[phrase];
            node.dataset.rt = translation;
            node.textContent = '（' + translation + '）';
            if (node.parentNode) {
                node.parentNode.title = phrase + ' — ' + translation;
            }
        });
        delete queue[phrase];
    }

    // ---- Mutation handling / rescan scheduling ----
    function mutationHandler(mutationList) {
        for (var i = 0; i < mutationList.length; i++) {
            var mutationRecord = mutationList[i];
            var added = mutationRecord.addedNodes;
            for (var j = 0; j < added.length; j++) {
                newNodes.add(added[j]);
            }
            // A hidden panel can become visible through a class/style/hidden change.
            // Rescan that subtree then; already annotated ruby nodes are ignored.
            if (mutationRecord.type === 'attributes') {
                var target = mutationRecord.target;
                if (target.nodeType === Node.ELEMENT_NODE &&
                    !target.closest('.katakana-terminator-word, .katakana-terminator-gloss')) {
                    newNodes.add(target);
                }
            }
        }
        if (newNodes.size) {
            scheduleRescan();
        }
    }

    function scheduleRescan() {
        if (rescanTimer) {
            return;
        }
        rescanTimer = setTimeout(function () {
            rescanTimer = null;
            rescanTextNodes();
        }, RESCAN_DEBOUNCE_MS);
    }

    // Off-screen text is intentionally skipped during the first pass. When the
    // user scrolls/resizes, re-walk the document for newly visible katakana.
    function scheduleViewportRescan() {
        if (viewportRescanTimer) {
            return;
        }
        viewportRescanTimer = setTimeout(function () {
            viewportRescanTimer = null;
            if (!isScriptActive() || !started || !document.body) {
                return;
            }
            newNodes.add(document.body);
            scheduleRescan();
        }, VIEWPORT_RESCAN_MS);
    }

    function detectEagerMode() {
        if (eagerMode) {
            return true;
        }
        var lang = (document.documentElement.lang || document.documentElement.getAttribute('xml:lang') || '').toLowerCase();
        if (lang.indexOf('ja') === 0) {
            eagerMode = true;
            return true;
        }
        var sample = '';
        try {
            sample = (document.body && document.body.innerText || '').slice(0, 8000);
        } catch (err) {
            sample = '';
        }
        var matches = sample.match(JP_CHAR_RE);
        if (matches && matches.length >= MIN_JP_CHARS_FOR_EAGER) {
            eagerMode = true;
            return true;
        }
        return false;
    }

    function rescanTextNodes() {
        if (!isScriptActive() || !started) {
            return;
        }
        if (observer) {
            mutationHandler(observer.takeRecords());
        }
        if (!newNodes.size) {
            return;
        }

        resetVisibilityCache();
        detectEagerMode();

        var nodes = Array.from(newNodes);
        newNodes.clear();

        var scanned = 0;
        nodes.forEach(function (node) {
            // Sparse mode on non-Japanese pages: only descend into nodes that
            // already contain katakana, so English-heavy sites stay cheap.
            if (!eagerMode && !nodeHasKatakana(node)) {
                return;
            }
            if (!eagerMode && nodeHasKatakana(node)) {
                eagerMode = true;
            }
            scanTextNodes(node);
            scanned++;
        });

        if (scanned) {
            console.debug('Katakana Terminator:', scanned, 'nodes scanned, frame', window.location.href);
        }
        translateTextNodes();
    }

    function installMenu() {
        if (!gmRegisterMenuCommand) {
            return;
        }
        gmRegisterMenuCommand('Katakana Terminator: Toggle on this browser', function () {
            var next = !settingEnabled;
            writeEnabled(next);
            window.alert('Katakana Terminator ' + (next ? 'enabled' : 'disabled') +
                '. Reload the page to apply.');
        });
        gmRegisterMenuCommand('Katakana Terminator: Toggle blacklist for this site', function () {
            var host = location.hostname;
            var list = settingBlacklist.slice();
            var idx = list.map(function (h) { return String(h).toLowerCase(); }).indexOf(host.toLowerCase());
            if (idx >= 0) {
                list.splice(idx, 1);
                writeBlacklist(list);
                window.alert('Removed from blacklist: ' + host + '\nReload to apply.');
            } else {
                list.push(host);
                writeBlacklist(list);
                window.alert('Blacklisted: ' + host + '\nReload to apply.');
            }
        });
        gmRegisterMenuCommand('Katakana Terminator: Clear translation cache', function () {
            cachedTranslations = {};
            cacheMeta = {};
            gmSetValue(STORAGE_CACHE, JSON.stringify({ v: 1, savedAt: Date.now(), entries: {} }));
            window.alert('Translation cache cleared.');
        });
    }

    function start() {
        installMenu();

        if (!isScriptActive()) {
            console.debug('Katakana Terminator: inactive on', location.hostname);
            return;
        }
        if (!document.body) {
            return;
        }

        // Parenthetical gloss after the word: カタカナ（Katakana）
        gmAddStyle(
            '.katakana-terminator-word {' +
            '  display: inline !important;' +
            '  margin: 0 !important;' +
            '  padding: 0 !important;' +
            '  border: 0 !important;' +
            '  background: transparent !important;' +
            '  color: inherit !important;' +
            '  font: inherit !important;' +
            '  letter-spacing: inherit !important;' +
            '  line-height: inherit !important;' +
            '  text-indent: 0 !important;' +
            '  white-space: inherit !important;' +
            '}' +
            '.katakana-terminator-gloss:empty {' +
            '  display: none !important;' +
            '}' +
            '.katakana-terminator-gloss {' +
            '  display: inline !important;' +
            '  margin: 0 !important;' +
            '  padding: 0 !important;' +
            '  border: 0 !important;' +
            '  background: transparent !important;' +
            '  color: inherit !important;' +
            '  font-family: inherit !important;' +
            '  font-size: 0.85em !important;' +
            '  font-style: normal !important;' +
            '  font-weight: normal !important;' +
            '  letter-spacing: normal !important;' +
            '  line-height: inherit !important;' +
            '  opacity: 0.72 !important;' +
            '  text-decoration: none !important;' +
            '  text-indent: 0 !important;' +
            '  text-transform: none !important;' +
            '  white-space: nowrap !important;' +
            '  user-select: none !important;' +
            '}'
        );

        // Discover katakana that has just entered the viewport.
        window.addEventListener('scroll', scheduleViewportRescan, true);
        window.addEventListener('resize', scheduleViewportRescan);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('scroll', scheduleViewportRescan);
            window.visualViewport.addEventListener('resize', scheduleViewportRescan);
        }

        observer = new MutationObserver(mutationHandler);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert'],
        });

        started = true;
        newNodes.add(document.body);
        rescanTextNodes();

        // Low-frequency fallback for observers missing edge cases (e.g. some
        // virtualized lists). Only runs work when nodes are buffered.
        setInterval(function () {
            if (newNodes.size) {
                scheduleRescan();
            }
        }, RESCAN_FALLBACK_MS);
    }

    // Load settings/cache (supports both sync GM_* and async GM.* APIs).
    Promise.all([
        gmGetValueAsync(STORAGE_ENABLED, true),
        gmGetValueAsync(STORAGE_BLACKLIST, '[]'),
        gmGetValueAsync(STORAGE_CACHE, null),
    ]).then(function (values) {
        var enabledVal = values[0];
        settingEnabled = enabledVal !== false && enabledVal !== 'false';
        settingBlacklist = parseBlacklist(values[1]);
        applyPersistentCache(values[2]);
        start();
    }).catch(function (err) {
        console.warn('Katakana Terminator: settings load failed, using defaults', err);
        start();
    });
})();
