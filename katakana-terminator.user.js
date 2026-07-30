// ==UserScript==
// @name        Katakana Terminator
// @description Convert gairaigo (Japanese loan words) back to English
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
// @version     2026.07.30.1
// @name:ja-JP  カタカナターミネーター
// @name:zh-CN  片假名终结者
// @description:zh-CN 在网页中的日语外来语上方标注英文原词
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
    var MAX_URL_QUERY_BYTES = 1600;
    var MAX_INFLIGHT_REQUESTS = 2;
    var MIN_JP_CHARS_FOR_EAGER = 15;

    // ---- Runtime state ----
    var queue = {}; // {"カタカナ": [rtNodeA, rtNodeB]}
    var cachedTranslations = {}; // {"ターミネーター": "Terminator"}
    var cacheMeta = {}; // {phrase: lastUsedMs}
    var failedTranslations = {}; // {phrase: failedAtMs}
    var newNodes = new Set();
    var annotationLayer = null;
    var annotatedNodes = [];
    var labelMap = new WeakMap();
    var annotationUpdatePending = false;
    var visibilityCache = new WeakMap();
    var rescanTimer = null;
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
    // Return whether an element is currently rendered. Hidden subtrees are skipped
    // before ruby nodes are created, so their text is not sent for translation.
    // Do not test viewport intersection here: off-screen page content is still part
    // of the visible document and should be ready when the user scrolls to it.
    function isRenderedElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (visibilityCache.has(element)) {
            return visibilityCache.get(element);
        }

        var visible;
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
    }

    function shouldSkipElement(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return true;
        }
        if (node.classList.contains('katakana-terminator-ruby') ||
            node.classList.contains('katakana-terminator-layer') ||
            node.classList.contains('katakana-terminator-label')) {
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
                if (shouldSkipElement(node) || !isRenderedElement(node)) {
                    continue;
                }
                var children = node.childNodes;
                for (var i = children.length - 1; i >= 0; i--) {
                    stack.push(children[i]);
                }
                continue;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                if (!node.parentElement || !isRenderedElement(node.parentElement)) {
                    continue;
                }
                while ((node = addRuby(node)));
            }
        }
    }

    // Recursively add ruby tags to text nodes
    // Inspired by http://www.the-art-of-web.com/javascript/search-highlight/
    function addRuby(node) {
        var match;
        if (!node.nodeValue || !(match = KATAKANA_RE.exec(node.nodeValue))) {
            return false;
        }
        var ruby = document.createElement('ruby');
        ruby.classList.add('katakana-terminator-ruby');
        ruby.appendChild(document.createTextNode(match[0]));
        var rt = document.createElement('rt');
        rt.classList.add('katakana-terminator-rt');
        ruby.appendChild(rt);

        queue[match[0]] = queue[match[0]] || [];
        queue[match[0]].push(rt);

        // <span>[startカナmiddleテストend]</span> =>
        // <span>start<ruby>カナ<rt data-rt="Kana"></rt></ruby>[middleテストend]</span>
        var after = node.splitText(match.index);
        node.parentNode.insertBefore(ruby, after);
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
    function getAnnotationBackdrop(color) {
        var match = color && color.match(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i);
        if (!match) {
            return 'rgba(255, 255, 255, 0.92)';
        }
        var luminance = 0.299 * match[1] + 0.587 * match[2] + 0.114 * match[3];
        return luminance > 170 ? 'rgba(0, 0, 0, 0.82)' : 'rgba(255, 255, 255, 0.92)';
    }

    function createAnnotation(node, translation) {
        if (!annotationLayer) {
            return;
        }
        var label = labelMap.get(node);
        if (label && !label.isConnected) {
            label = null;
            labelMap.delete(node);
        }
        if (!label) {
            label = document.createElement('span');
            label.className = 'katakana-terminator-label';
            annotationLayer.appendChild(label);
            labelMap.set(node, label);
            annotatedNodes.push(node);
        }
        label.textContent = translation;
        scheduleAnnotationUpdate();
    }

    function updateAnnotationPositions() {
        annotationUpdatePending = false;
        annotatedNodes = annotatedNodes.filter(function (node) {
            var ruby = node.parentNode;
            var label = labelMap.get(node);
            if (!ruby || !ruby.isConnected || !label) {
                if (label) {
                    label.remove();
                }
                labelMap.delete(node);
                return false;
            }

            var viewport = window.visualViewport;
            var viewportLeft = viewport ? viewport.offsetLeft : 0;
            var viewportTop = viewport ? viewport.offsetTop : 0;
            var viewportRight = viewportLeft + (viewport ? viewport.width : window.innerWidth);
            var viewportBottom = viewportTop + (viewport ? viewport.height : window.innerHeight);
            var rect = ruby.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.bottom <= viewportTop || rect.top >= viewportBottom ||
                rect.right <= viewportLeft || rect.left >= viewportRight) {
                label.classList.add('katakana-terminator-label-hidden');
                return true;
            }

            var color = window.getComputedStyle(ruby).color;
            label.classList.remove('katakana-terminator-label-hidden');
            label.style.color = color;
            label.style.backgroundColor = getAnnotationBackdrop(color);
            // Store positions in document coordinates. Unlike fixed labels that
            // have to chase every scroll frame from JavaScript, absolute labels
            // then move with the page in the browser's compositor. This prevents
            // visible lag and flicker during mobile scrolling.
            label.style.left = window.scrollX + rect.left + rect.width / 2 + 'px';
            label.style.top = window.scrollY + rect.top + 'px';
            label.style.transform = 'translate(-50%, -100%)';

            // Keep the annotation inside the viewport and place it below the word
            // when there is not enough room above it.
            var labelRect = label.getBoundingClientRect();
            var offset = 0;
            if (labelRect.left < viewportLeft + 2) {
                offset = viewportLeft + 2 - labelRect.left;
            } else if (labelRect.right > viewportRight - 2) {
                offset = viewportRight - 2 - labelRect.right;
            }
            if (offset) {
                label.style.marginLeft = offset + 'px';
            } else {
                label.style.marginLeft = '0';
            }
            if (labelRect.top < viewportTop + 2) {
                label.style.top = window.scrollY + rect.bottom + 'px';
                label.style.transform = 'translate(-50%, 0)';
                labelRect = label.getBoundingClientRect();
                if (labelRect.bottom > viewportBottom - 2) {
                    label.style.top = window.scrollY + Math.max(
                        viewportTop + 2, viewportBottom - labelRect.height - 2
                    ) + 'px';
                }
            }
            return true;
        });
    }

    function scheduleAnnotationUpdate() {
        if (annotationUpdatePending) {
            return;
        }
        annotationUpdatePending = true;
        window.requestAnimationFrame(updateAnnotationPositions);
    }

    function updateRubyByCachedTranslations(phrase) {
        if (!cachedTranslations[phrase]) {
            return;
        }
        (queue[phrase] || []).forEach(function (node) {
            node.dataset.rt = cachedTranslations[phrase];
            // Preserve access to long translations that are visually truncated.
            node.parentNode.title = phrase + ' — ' + cachedTranslations[phrase];
            createAnnotation(node, cachedTranslations[phrase]);
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
                    !target.closest('.katakana-terminator-ruby, .katakana-terminator-layer, .katakana-terminator-label')) {
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

        gmAddStyle(
            'ruby.katakana-terminator-ruby > rt.katakana-terminator-rt {' +
            '  display: none !important;' +
            '}' +
            '.katakana-terminator-layer {' +
            '  position: absolute !important;' +
            '  z-index: 2147483647 !important;' +
            '  inset: auto !important;' +
            '  top: 0 !important;' +
            '  left: 0 !important;' +
            '  width: 0 !important;' +
            '  height: 0 !important;' +
            '  margin: 0 !important;' +
            '  padding: 0 !important;' +
            '  border: 0 !important;' +
            '  overflow: visible !important;' +
            '  background: transparent !important;' +
            '  pointer-events: none !important;' +
            '  user-select: none !important;' +
            '}' +
            '.katakana-terminator-label {' +
            '  position: absolute !important;' +
            '  display: block !important;' +
            '  box-sizing: border-box !important;' +
            '  max-width: min(24em, 60vw) !important;' +
            '  overflow: hidden !important;' +
            '  padding: 1px 2px !important;' +
            '  border-radius: 2px !important;' +
            '  font-family: sans-serif !important;' +
            '  font-size: 10px !important;' +
            '  font-style: normal !important;' +
            '  font-weight: normal !important;' +
            '  letter-spacing: normal !important;' +
            '  line-height: 1 !important;' +
            '  text-align: center !important;' +
            '  text-decoration: none !important;' +
            '  text-overflow: ellipsis !important;' +
            '  text-transform: none !important;' +
            '  white-space: nowrap !important;' +
            '  word-spacing: normal !important;' +
            '  pointer-events: none !important;' +
            '}' +
            '.katakana-terminator-label-hidden {' +
            '  display: none !important;' +
            '}'
        );

        annotationLayer = document.createElement('div');
        annotationLayer.className = 'katakana-terminator-layer';
        annotationLayer.setAttribute('aria-hidden', 'true');
        // The popover top layer is not clipped by overflow or stacking contexts.
        // Fall back to an ordinary document-level layer in older browsers.
        if (typeof annotationLayer.showPopover === 'function') {
            annotationLayer.setAttribute('popover', 'manual');
        }
        document.body.appendChild(annotationLayer);
        if (typeof annotationLayer.showPopover === 'function') {
            try {
                annotationLayer.showPopover();
            } catch (err) {
                annotationLayer.removeAttribute('popover');
            }
        }

        // Document scrolling already moves absolute labels together with their
        // words, so rewriting every label during a root/visual-viewport scroll is
        // unnecessary and can force repaints that flicker on mobile. Nested scroll
        // containers still need a position update because the layer is outside of
        // those containers.
        window.addEventListener('scroll', function (event) {
            if (event.target !== document && event.target !== document.documentElement &&
                event.target !== document.body) {
                scheduleAnnotationUpdate();
            }
        }, true);
        window.addEventListener('resize', scheduleAnnotationUpdate);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleAnnotationUpdate);
        }

        observer = new MutationObserver(mutationHandler);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden'],
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
