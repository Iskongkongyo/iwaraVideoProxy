// ==UserScript==
// @name         Iwara 视频反代加速播放
// @namespace    https://github.com/Iskongkongyo/iwaraVideoProxy
// @version      1.2.4
// @description  在 Iwara 原生播放器中切换官方/反代线路；支持 MSE/ManagedMediaSource、Range 与 Seek；流式异常先尝试原生反代播放，再回退完整下载。
// @author       流萤可爱捏
// @match        https://www.iwara.tv/*
// @match        https://www.iwara.ai/*
// @match        https://iwara.tv/*
// @match        https://iwara.ai/*
// @require      https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ss.ixq.pp.ua
// @connect      ss.iys.pp.ua
// @connect      iww.de5.net
// @connect      22335-agqydboltcngwl3mybgo4doycy.instabox.tech
// @sandbox      raw
// @run-at       document-idle
// @icon      data:image/jpeg;base64,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
// @noframes
// @license MIT
// @downloadURL https://update.greasyfork.org/scripts/603553/Iwara%20%E8%A7%86%E9%A2%91%E5%8F%8D%E4%BB%A3%E5%8A%A0%E9%80%9F%E6%92%AD%E6%94%BE.user.js
// @updateURL https://update.greasyfork.org/scripts/603553/Iwara%20%E8%A7%86%E9%A2%91%E5%8F%8D%E4%BB%A3%E5%8A%A0%E9%80%9F%E6%92%AD%E6%94%BE.meta.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================== 配置 ============================== */

  const SOURCES = [
    { key: 'official',     host: null,           label: '官方线路',     buttonLabel: '官方' },
    { key: 'ss.ixq.pp.ua', host: 'ss.ixq.pp.ua', label: '线路① ixq',   buttonLabel: '源①' },
    { key: 'ss.iys.pp.ua', host: 'ss.iys.pp.ua', label: '线路② iys',   buttonLabel: '源②' },
    { key: 'iww.de5.net',  host: 'iww.de5.net',  label: '线路③ iww',   buttonLabel: '源③' },
    { key: 'insrabox',  host: '22335-agqydboltcngwl3mybgo4doycy.instabox.tech',  label: '线路④ insrabox',   buttonLabel: '源④' },
  ];

  const STORE_KEY = 'iwaraSourceKey';
  const CHUNK_BYTES = 2 * 1024 * 1024;
  const SEEK_CHUNK_BYTES = 2 * 1024 * 1024;
  const AHEAD_SECONDS = 60;
  const BEHIND_SECONDS = 120;
  const FIRST_CHUNK_BYTES = 1024 * 1024;
  const FIRST_SEGMENT_TIMEOUT_MS = 60_000;
  const SEEK_BUFFER_TIMEOUT_MS = 45_000;
  const MAX_QUEUE = 6;
  const RANGE_TIMEOUT_MS = 35_000;
  const METADATA_TIMEOUT_MS = 25_000;
  const NATIVE_STALL_TIMEOUT_MS = 35_000;
  const MAX_METADATA_BOX_BYTES = 64 * 1024 * 1024;
  const MAX_METADATA_BOXES = 16;
  const MAX_FALLBACK_BYTES = 800 * 1024 * 1024;

  /* ============================== 工具 ============================== */

  const log = (...args) => {
    try { console.debug('[IwaraSource]', ...args); } catch (_) { }
  };

  function getMP4BoxLibrary() {
    // @require 通常会把 MP4Box 暴露为全局变量；不同脚本管理器/沙箱下 window 属性可能不同。
    try {
      if (typeof MP4Box !== 'undefined' && MP4Box && typeof MP4Box.createFile === 'function') return MP4Box;
    } catch (_) { }
    try {
      if (window.MP4Box && typeof window.MP4Box.createFile === 'function') return window.MP4Box;
    } catch (_) { }
    return null;
  }

  function getSourceByKey(key) {
    return SOURCES.find(source => source.key === key) || SOURCES[0];
  }

  function getSavedKey() {
    try { return getSourceByKey(GM_getValue(STORE_KEY, 'official')).key; }
    catch (_) { return 'official'; }
  }

  function saveKey(key) {
    try { GM_setValue(STORE_KEY, key); } catch (_) { }
  }

  function normalizeOfficial(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    const value = raw.trim();
    if (value.startsWith('//')) return 'https:' + value;
    try { return new URL(value, location.href).href; }
    catch (_) { return ''; }
  }

  function isOfficialMediaUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) &&
        /^[a-z0-9-]+\.iwara\.tv$/i.test(url.hostname) &&
        url.pathname === '/view' && !!url.search;
    } catch (_) { return false; }
  }

  // worker.js 会先由 URLSearchParams 解码一次，再显式 decodeURIComponent 一次，因此这里双重编码，
  // 避免官方 URL 自身含有 %2F、%3D 等转义参数时被 Worker 过度解码。
  function buildProxyUrl(host, officialUrl) {
    return 'https://' + host + '/view?url=' + encodeURIComponent(encodeURIComponent(officialUrl));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function revokeLater(url, wait = 10_000) {
    if (!url) return;
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (_) { }
    }, wait);
  }

  function parseContentRange(headers) {
    const match = /content-range\s*:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(headers || '');
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === '*' ? null : Number(match[3]),
    };
  }

  function abortError() {
    const error = new Error('aborted');
    error.aborted = true;
    return error;
  }

  // 独立计时/取消：部分移动端管理器不会可靠触发 ontimeout/onabort。
  // 不依赖底层回调来结束等待，迟到回调也不能再覆盖新线路。
  function gmRequest(options) {
    let xhr = null;
    let settled = false;
    let timer = null;
    let finish;
    const abortTransport = () => {
      try { if (xhr && typeof xhr.abort === 'function') xhr.abort(); } catch (_) { }
    };
    const promise = new Promise((resolve, reject) => {
      finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(response);
      };
      const timeout = Math.max(1, Number(options.timeout) || RANGE_TIMEOUT_MS);
      timer = setTimeout(() => {
        finish(new Error('请求超时（脚本独立计时）'));
        abortTransport();
      }, timeout);
      try {
        xhr = GM_xmlhttpRequest(Object.assign({}, options, {
          onload: response => finish(null, response),
          onerror: () => finish(new Error('网络错误')),
          ontimeout: () => finish(new Error('请求超时')),
          onabort: () => finish(abortError()),
          onprogress: response => {
            if (settled || !options.onprogress) return;
            try { options.onprogress(response); }
            catch (error) { finish(error); abortTransport(); }
          },
        }));
      } catch (error) { finish(error); }
    });
    return {
      promise,
      abort() { finish(abortError()); abortTransport(); },
    };
  }

  function nativeArrayBuffer(value) {
    // MP4Box 与请求响应可能来自不同 realm，复制到本脚本的 ArrayBuffer。
    let bytes;
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error('响应不是 ArrayBuffer；请检查移动端脚本管理器的二进制请求支持');
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  function mediaSourceConstructor() {
    if (typeof MediaSource === 'function') return MediaSource;
    if (typeof ManagedMediaSource === 'function') return ManagedMediaSource;
    return null;
  }

  function prepareMediaElement(player) {
    const video = player.el() && player.el().querySelector('video');
    if (video) {
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'auto';
    }
    try { if (typeof player.preload === 'function') player.preload('auto'); } catch (_) { }
    return video;
  }

  function tryPlay(player, onBlocked = () => { }) {
    const failed = error => {
      if (error && error.name === 'NotAllowedError') onBlocked();
      else log('播放请求未完成', error && error.message || error);
    };
    try {
      const result = player.play();
      // 部分旧版 Video.js/移动端 Tech 的 play() 不返回 Promise。
      if (result && typeof result.catch === 'function') result.catch(failed);
    } catch (error) { failed(error); }
  }

  /**
   * mp4box 0.5.2 的 ISOFile.seek(time, useRap) 返回的是 { offset, time } 对象，
   * 不是字节偏移数值。旧版脚本把返回值直接当 number 用 Number.isFinite() 校验，
   * 于是只要起播位置 > 0.5 秒（切线路、切清晰度、带进度接管）或拖动到未缓冲区间，
   * 就必然抛错并回退整段下载。这里统一提取 .offset。
   */
  function mp4boxSeekOffset(mp4boxFile, time) {
    const result = mp4boxFile.seek(Math.max(0, Number(time) || 0), true);
    const offset = (result && typeof result === 'object') ? result.offset : result;
    if (!Number.isFinite(offset) || offset < 0) throw new Error('MP4Box 无法计算目标时间对应的偏移');
    return offset;
  }

  /**
   * 发送一个严格的 HTTP Range 请求。
   * Worker 已验证会把 Range 转发给 Iwara；这里拒绝静默退化成 200 全量响应，避免误把整段文件当作分块。
   */
  function gmRange(url, start, end, timeoutMs = RANGE_TIMEOUT_MS) {
    const request = gmRequest({
      method: 'GET', url,
      headers: { Range: 'bytes=' + start + '-' + end },
      responseType: 'arraybuffer', timeout: timeoutMs,
    });
    const promise = request.promise.then(response => {
      if (response.status !== 206) {
        const error = new Error(response.status === 200
          ? '上游没有正确响应 Range（HTTP 200）'
          : 'HTTP ' + response.status);
        error.status = response.status;
        error.responseHeaders = response.responseHeaders || '';
        throw error;
      }
      const buf = nativeArrayBuffer(response.response);
      const range = parseContentRange(response.responseHeaders);
      if (!range) {
        throw new Error('Range 响应缺少 Content-Range');
      }
      if (range.start !== start || range.end < range.start || range.end > end) {
        throw new Error('Range 响应区间不匹配');
      }
      if (range.total !== null && (!Number.isSafeInteger(range.total) || range.total <= 0 || range.end >= range.total)) {
        throw new Error('Range 响应总长度无效');
      }
      const expectedEnd = range.total === null ? end : Math.min(end, range.total - 1);
      if (range.end !== expectedEnd) {
        throw new Error('Range 响应区间不完整');
      }
      const expectedLength = range.end - range.start + 1;
      if (buf.byteLength !== expectedLength) {
        throw new Error('Range 响应长度与 Content-Range 不一致');
      }
      return { buf, total: range.total, start: range.start, end: range.end };
    });
    return { promise, abort: request.abort };
  }

  function readUint64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) throw new Error('MP4 box 长度超出安全整数范围');
    return value;
  }

  /* ============================== 状态浮层 ============================== */

  const layer = {
    el: null,
    hideTimer: null,

    ensure(playerEl) {
      if (this.el && this.el.isConnected && this.el.parentElement === playerEl) return;
      this.destroy();
      const el = document.createElement('div');
      el.className = 'iwsrc-status-layer';
      el.style.cssText = [
        'position:absolute', 'top:10px', 'right:12px', 'z-index:60',
        'background:rgba(20,20,28,.78)', 'color:#fff',
        'padding:4px 10px', 'border-radius:6px',
        'font:12px/1.6 monospace', 'pointer-events:none',
        'max-width:65%', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        'transition:opacity .35s', 'opacity:0',
      ].join(';');
      playerEl.appendChild(el);
      this.el = el;
    },

    show(message, sticky = false, durationMs = 2800) {
      if (!this.el) return;
      this.el.textContent = message;
      this.el.style.opacity = '1';
      clearTimeout(this.hideTimer);
      if (!sticky) {
        this.hideTimer = setTimeout(() => {
          if (this.el) this.el.style.opacity = '0';
        }, Math.max(300, Number(durationMs) || 2800));
      }
    },

    hide() {
      if (!this.el) return;
      clearTimeout(this.hideTimer);
      this.el.style.opacity = '0';
    },

    destroy() {
      clearTimeout(this.hideTimer);
      if (this.el && this.el.isConnected) this.el.remove();
      this.el = null;
    },
  };

  /* ============================== MSE 流式代理 ============================== */

  class MseProxy {
    constructor(player, proxyHost, officialUrl, hooks = {}) {
      this.p = player;
      this.v = player.el() && player.el().querySelector('video');
      this.proxyHost = proxyHost;
      this.officialUrl = officialUrl;
      this.url = buildProxyUrl(proxyHost, officialUrl);
      this.onStatus = hooks.onStatus || (() => { });
      this.onFatal = hooks.onFatal || (() => { });

      const lib = getMP4BoxLibrary();
      this.mp4box = lib ? lib.createFile() : null;

      this.dead = false;
      this.ms = null;
      this.blobUrl = null;
      this.sbMap = new Map();
      this.total = null;
      this.feedPos = 0;
      this.fetching = null;
      this.pumpGen = 0;
      this.startedAt = 0;
      this.autoPlay = false;
      this.seekDebounce = null;
      this.seekSequence = 0;
      this._seekHandler = null;
      this.trackInfo = null;
      this.duration = 0;
      this._fatalSent = false;
      this.cancelOpen = null;
      this.remotePlaybackState = null;
      this.playbackReady = false;
      this.managed = false;
      this.managedStreaming = true;
      this.managedCleanup = [];
      this.managedEvicted = [];
      this.managedRecoveryTimer = null;
      this.managedRecovering = false;
    }

    async start(startTime = 0) {
      if (!this.mp4box) throw new Error('MP4Box 未加载，请检查油猴 @require');
      if (!this.v) throw new Error('未找到原生 video 元素');
      const Source = mediaSourceConstructor();
      if (!Source) throw new Error('当前浏览器不支持 MSE/ManagedMediaSource');

      this.startedAt = Math.max(0, Number(startTime) || 0);
      this.autoPlay = !this.p.paused() || !!this.p.autoplay();
      this.v = prepareMediaElement(this.p);

      // iPhone 的 ManagedMediaSource 需要 AirPlay 备选地址或禁用远程播放。
      // 只在本次代理期间禁用，停止后恢复原值。
      if (typeof ManagedMediaSource === 'function' && Source === ManagedMediaSource) {
        this.managed = true;
        this.remotePlaybackState = {
          video: this.v, disabled: this.v.disableRemotePlayback,
          attribute: this.v.getAttribute('disableRemotePlayback'),
        };
        this.v.disableRemotePlayback = true;
        this.v.setAttribute('disableRemotePlayback', '');
      }

      // 先建立 MSE，再解析 MP4 元数据；媒体数据只会在 mp4box.start() 后请求，避免首块样本被丢弃。
      this.onStatus('初始化媒体引擎…', { sticky: true });
      const ms = this.ms = new Source();
      if (this.managed) this._watchManagedSource(ms);
      this.blobUrl = URL.createObjectURL(ms);
      const opened = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ms.removeEventListener('sourceopen', onOpen);
          ms.removeEventListener('error', onError);
          this.cancelOpen = null;
          if (error) reject(error); else resolve();
        };
        const onOpen = () => finish();
        const onError = () => finish(new Error('MediaSource 打开失败'));
        const timer = setTimeout(() => finish(new Error('MediaSource sourceopen 超时')), 10_000);
        ms.addEventListener('sourceopen', onOpen, { once: true });
        ms.addEventListener('error', onError, { once: true });
        this.cancelOpen = () => finish(abortError());
      });
      opened.catch(() => { });
      try {
        this.p.src({ src: this.blobUrl, type: 'video/mp4' });
        if (typeof this.p.load === 'function') this.p.load();
        // 在线路点击的同步调用栈里发起播放，避免等网络请求完成才丢失用户激活。
        if (this.autoPlay) tryPlay(this.p, () => {
          if (!this.dead) this.onStatus('请点播放器 ▶ 继续加载', { sticky: true });
        });
      } catch (error) {
        if (this.cancelOpen) this.cancelOpen();
        throw error;
      }
      await opened;
      if (this.dead) throw new Error('aborted');

      // 只下载 ftyp/moov 等元数据盒，不把 moov 后面的 mdat 样本提前交给尚未 start 的 MP4Box。
      this.onStatus('读取 MP4 元数据…', { sticky: true });
      const info = await this._loadMoov();
      if (this.dead) throw new Error('aborted');

      const videoTrack = info.tracks.find(track => track.video);
      const audioTrack = info.tracks.find(track => track.audio);
      if (!videoTrack) throw new Error('MP4 中没有视频轨');
      if (!videoTrack.codec) throw new Error('无法识别视频编码格式');
      this.trackInfo = { video: videoTrack, audio: audioTrack };
      this.duration = info.timescale ? info.duration / info.timescale : 0;
      if (this.duration > 0 && this.startedAt >= this.duration) this.startedAt = 0;

      const videoMime = 'video/mp4; codecs="' + videoTrack.codec + '"';
      if (Source.isTypeSupported && !Source.isTypeSupported(videoMime)) {
        throw new Error('浏览器不支持视频编码：' + videoTrack.codec);
      }
      const videoBuffer = ms.addSourceBuffer(videoMime);
      this.sbMap.set(videoTrack.id, {
        trackId: videoTrack.id, kind: 'video', sb: videoBuffer,
        queue: [], busy: false, count: 0,
      });

      if (audioTrack) {
        if (!audioTrack.codec) throw new Error('无法识别音频编码格式');
        const audioMime = 'audio/mp4; codecs="' + audioTrack.codec + '"';
        if (Source.isTypeSupported && !Source.isTypeSupported(audioMime)) {
          throw new Error('浏览器不支持音频编码：' + audioTrack.codec);
        }
        const audioBuffer = ms.addSourceBuffer(audioMime);
        this.sbMap.set(audioTrack.id, {
          trackId: audioTrack.id, kind: 'audio', sb: audioBuffer,
          queue: [], busy: false, count: 0,
        });
      }

      if (this.managed) {
        this.sbMap.forEach(cell => {
          const onChange = event => {
            const removed = event.removedRanges;
            if (this.dead || !removed) return;
            const current = this.playbackReady ? this.v.currentTime : this.startedAt;
            for (let i = 0; i < removed.length; i++) {
              // 忽略自己清理的已播内容，只记录仍需播放的区间。
              if (removed.end(i) > current + 0.05) {
                this.managedEvicted.push({ cell, start: removed.start(i), end: removed.end(i) });
              }
            }
            this._scheduleManagedRecovery();
          };
          cell.sb.addEventListener('bufferedchange', onChange);
          this.managedCleanup.push(() => cell.sb.removeEventListener('bufferedchange', onChange));
        });
      }

      this.mp4box.setSegmentOptions(videoTrack.id, videoTrack.id, { nbSamples: 24 });
      if (audioTrack) this.mp4box.setSegmentOptions(audioTrack.id, audioTrack.id, { nbSamples: 96 });

      this.mp4box.onSegment = (id, user, buffer, sampleNumber, isLast) => {
        const cell = this.sbMap.get(user);
        if (!cell || this.dead) return;
        cell.queue.push({ buffer, sampleNumber, isLast, init: false });
        this._drain(cell);
      };

      const initSegments = this.mp4box.initializeSegmentation();
      if (!Array.isArray(initSegments)) {
        throw new Error('MP4Box 初始化分片接口不兼容，请确认使用 mp4box 0.5.2');
      }
      for (const segment of initSegments) {
        const cell = this.sbMap.get(segment.id);
        if (!cell) continue;
        const ok = await this._append(cell, segment.buffer);
        if (!ok) throw new Error('MSE 初始化分片追加失败');
      }

      try {
        if (this.duration > 0) ms.duration = this.duration;
      } catch (_) { }

      this.mp4box.start();

      let startOffset = this.feedPos;
      if (this.startedAt > 0.5) {
        if (typeof this.mp4box.seek !== 'function') throw new Error('当前 MP4Box 版本不支持按时间定位');
        try {
          startOffset = mp4boxSeekOffset(this.mp4box, this.startedAt);
        } catch (_) {
          throw new Error('无法计算起播位置');
        }
      }

      this._seekHandler = () => this._onSeeking();
      this.p.on('seeking', this._seekHandler);

      this._pumpFrom(startOffset).catch(error => this._fatal(error));
      this.onStatus('缓冲首个可播放分片…', { sticky: true });
      await this._waitForFirstSegments(this.startedAt);
      if (this.dead) return;

      if (this.startedAt > 0.1) this.p.currentTime(this.startedAt);
      this.playbackReady = true;
      if (this.managed) this._scheduleManagedRecovery();
      this.onStatus(this.p.paused() ? '已连接 · 请点播放器 ▶ 播放' : '边下边播 · ' + this.proxyHost);
      if (this.autoPlay) tryPlay(this.p, () => {
        if (!this.dead) this.onStatus('已连接 · 请点播放器 ▶ 播放', { sticky: true });
      });
    }

    stop() {
      if (this.dead) return;
      this.dead = true;
      this.pumpGen++;
      clearTimeout(this.seekDebounce);
      this.seekSequence++;
      clearTimeout(this.managedRecoveryTimer);
      this.managedRecoveryTimer = null;
      this.managedCleanup.forEach(cleanup => { try { cleanup(); } catch (_) { } });
      this.managedCleanup.length = 0;
      this.managedEvicted.length = 0;
      if (this.cancelOpen) this.cancelOpen();
      if (this.remotePlaybackState) {
        const state = this.remotePlaybackState;
        try {
          state.video.disableRemotePlayback = state.disabled;
          if (state.attribute === null) state.video.removeAttribute('disableRemotePlayback');
          else state.video.setAttribute('disableRemotePlayback', state.attribute);
        } catch (_) { }
        this.remotePlaybackState = null;
      }
      try { this.mp4box && this.mp4box.stop(); } catch (_) { }
      try {
        if (this.mp4box) {
          this.mp4box.onSegment = null;
          this.mp4box.onReady = null;
          this.mp4box.onError = null;
        }
      } catch (_) { }
      if (this.fetching) {
        this.fetching.abort();
        this.fetching = null;
      }
      try { if (this._seekHandler) this.p.off('seeking', this._seekHandler); } catch (_) { }
      if (this.blobUrl) revokeLater(this.blobUrl);
      this.blobUrl = null;
      this.sbMap.forEach(cell => { cell.queue.length = 0; });
      this.sbMap.clear();
    }

    /* ---------- ManagedMediaSource：遵循取流信号并补回被回收的未来缓存 ---------- */

    _watchManagedSource(ms) {
      this.managedStreaming = ms.streaming !== false;
      const onStart = () => {
        this.managedStreaming = true;
        this._scheduleManagedRecovery();
      };
      const onEnd = () => { this.managedStreaming = false; };
      const onTime = () => this._scheduleManagedRecovery();
      ms.addEventListener('startstreaming', onStart);
      ms.addEventListener('endstreaming', onEnd);
      this.p.on('timeupdate', onTime);
      this.managedCleanup.push(() => {
        ms.removeEventListener('startstreaming', onStart);
        ms.removeEventListener('endstreaming', onEnd);
        this.p.off('timeupdate', onTime);
      });
    }

    _scheduleManagedRecovery() {
      if (this.dead || !this.managed || !this.playbackReady || !this.managedStreaming ||
          this.managedRecovering || !this.managedEvicted.length || this.managedRecoveryTimer !== null) return;
      this.managedRecoveryTimer = setTimeout(() => {
        this.managedRecoveryTimer = null;
        if (this.dead || !this.managedStreaming || this.v.seeking) return;
        try {
          const current = Math.max(0, Number(this.v.currentTime) || 0);
          let missing = Infinity;
          this.managedEvicted = this.managedEvicted.filter(range => {
            if (range.end <= current + 0.05) return false;
            let from = Math.max(current, range.start);
            const buffered = range.cell.sb.buffered;
            for (let i = 0; i < buffered.length && from < range.end; i++) {
              if (buffered.end(i) <= from) continue;
              if (buffered.start(i) > from + 0.05) break;
              from = Math.max(from, buffered.end(i));
            }
            if (from >= range.end - 0.05) return false;
            if (from < current + AHEAD_SECONDS) missing = Math.min(missing, from);
            return true;
          });
          if (Number.isFinite(missing)) this._recoverManagedBuffer(missing);
        } catch (error) { this._fatal(error); }
      }, 120);
    }

    async _recoverManagedBuffer(target) {
      if (this.dead || this.managedRecovering) return;
      this.managedRecovering = true;
      const sequence = this.seekSequence;
      const generation = ++this.pumpGen;
      try {
        if (this.fetching) {
          this.fetching.abort();
          this.fetching = null;
        }
        // 等旧追加完成再修改 MP4Box 的样本位置，避免旧队列释放新一轮样本。
        const drained = await this._waitForQueueDrain(generation);
        if (this.dead || sequence !== this.seekSequence || generation !== this.pumpGen) return;
        if (!drained) throw new Error('等待托管缓存队列排空超时');
        const offset = mp4boxSeekOffset(this.mp4box, Math.max(0, target - 0.1));
        if (this.total && offset >= this.total) throw new Error('托管缓存补拉位置超出文件范围');
        // 从最早缺口重新顺序取流，也会补齐其后的缺口；后续新回收仍单独记录。
        this.managedEvicted.length = 0;
        this.onStatus('系统回收了缓存，正在补充…');
        this._pumpFrom(offset).catch(error => this._fatal(error));
      } catch (error) {
        if (!this.dead && sequence === this.seekSequence && generation === this.pumpGen) {
          this._fatal(new Error('托管缓存恢复失败：' + (error.message || error)));
        }
      } finally {
        this.managedRecovering = false;
        this._scheduleManagedRecovery();
      }
    }

    /* ---------- 解析 MP4 元数据（fast-start 文件） ---------- */

    async _readRange(start, end, timeout = RANGE_TIMEOUT_MS) {
      if (this.dead) throw new Error('aborted');
      const request = gmRange(this.url, start, end, timeout);
      this.fetching = request;
      try {
        const result = await request.promise;
        if (result.total) this.total = result.total;
        return result;
      } finally {
        if (this.fetching === request) this.fetching = null;
      }
    }

    async _loadMoov() {
      // 快速路径：绝大多数 Iwara 文件是 ftyp + moov 开头，moov 在 1 MB 内。
      // 一次 Range 取回文件头即可完成元数据解析，避免逐盒往返（每盒 2 次请求）
      // 在慢线路上拖长接管时间、放大竞态窗口。快速路径不适用时回落到逐盒扫描。
      try {
        return await this._loadMoovFromHead();
      } catch (error) {
        if (error && error.useBoxWalk) return this._loadMoovByBoxes();
        throw error;
      }
    }

    async _loadMoovFromHead() {
      const headWanted = FIRST_CHUNK_BYTES;
      const head = await this._readRange(0, headWanted - 1, METADATA_TIMEOUT_MS);
      const buf = head.buf;
      const view = new DataView(buf);
      const bytes = new Uint8Array(buf);
      let offset = 0;

      const readyPromise = new Promise((resolve, reject) => {
        this.mp4box.onReady = resolve;
        this.mp4box.onError = error => reject(new Error('MP4Box 解析失败：' + String(error || 'unknown')));
      });
      readyPromise.catch(() => { });

      const inapplicable = () => {
        const error = new Error('文件头结构不适合快速解析，改用逐盒扫描');
        error.useBoxWalk = true;
        return error;
      };

      for (let index = 0; index < MAX_METADATA_BOXES; index++) {
        if (this.dead) throw new Error('aborted');
        if (offset + 8 > buf.byteLength) throw inapplicable();
        const size32 = view.getUint32(offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        let headerSize = 8;
        let boxSize = size32;
        if (size32 === 1) {
          if (offset + 16 > buf.byteLength) throw inapplicable();
          boxSize = readUint64(view, offset + 8);
          headerSize = 16;
        } else if (size32 === 0) {
          throw new Error('遇到长度延伸至文件末尾的 MP4 盒，无法安全进行 Range 流式解析');
        }
        if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) {
          throw new Error('MP4 盒长度无效：' + type);
        }
        if (type === 'mdat') {
          throw new Error('MP4 的 moov 位于 mdat 之后，当前版本将回退完整下载');
        }
        if (boxSize > MAX_METADATA_BOX_BYTES) {
          throw new Error('MP4 元数据盒过大，当前版本将回退完整下载');
        }
        if (this.total && offset + boxSize > this.total) {
          throw new Error('MP4 元数据盒超出文件长度');
        }

        if (type === 'moov') {
          let moovBuf;
          if (offset + boxSize <= buf.byteLength) {
            moovBuf = buf.slice(offset, offset + boxSize);
          } else {
            const tail = await this._readRange(offset, offset + boxSize - 1, METADATA_TIMEOUT_MS);
            if (tail.buf.byteLength !== boxSize) throw new Error('MP4 元数据盒下载不完整：moov');
            moovBuf = tail.buf;
          }
          // 先喂 moov 之前的盒（通常只有 ftyp），再喂 moov 本身，保证 fileStart 对齐。
          if (offset > 0) {
            const before = buf.slice(0, offset);
            before.fileStart = 0;
            try { this.mp4box.appendBuffer(before); }
            catch (error) { throw new Error('MP4Box 读取文件头失败：' + (error && error.message || error)); }
          }
          moovBuf.fileStart = offset;
          try { this.mp4box.appendBuffer(moovBuf); }
          catch (error) { throw new Error('MP4Box 读取 moov 盒失败：' + (error && error.message || error)); }
          let parsedInfo;
          try {
            parsedInfo = await Promise.race([
              readyPromise,
              delay(METADATA_TIMEOUT_MS).then(() => { throw new Error('等待 MP4 moov 解析超时'); }),
            ]);
          } catch (error) {
            throw error;
          }
          this.feedPos = offset + boxSize;
          return parsedInfo;
        }

        offset += boxSize;
        if (offset > buf.byteLength) throw inapplicable();
      }
      throw inapplicable();
    }

    async _loadMoovByBoxes() {
      let offset = 0;
      let parsedInfo = null;
      let parseError = null;
      const readyPromise = new Promise((resolve, reject) => {
        this.mp4box.onReady = resolve;
        this.mp4box.onError = error => reject(new Error('MP4Box 解析失败：' + String(error || 'unknown')));
      });
      // onError 可能早于 moov 盒到达；先挂一个拒绝处理器，稍后仍会 await 原 Promise。
      readyPromise.catch(() => { });

      for (let index = 0; index < MAX_METADATA_BOXES; index++) {
        if (this.dead) throw new Error('aborted');

        const headerResult = await this._readRange(offset, offset + 7, METADATA_TIMEOUT_MS);
        const header = headerResult.buf;
        if (header.byteLength < 8) throw new Error('MP4 文件头不完整');
        const headerView = new DataView(header);
        const size32 = headerView.getUint32(0);
        const headerBytes = new Uint8Array(header);
        const type = String.fromCharCode(headerBytes[4], headerBytes[5], headerBytes[6], headerBytes[7]);
        let headerSize = 8;
        let boxSize = size32;

        if (size32 === 1) {
          const extended = await this._readRange(offset, offset + 15, METADATA_TIMEOUT_MS);
          if (extended.buf.byteLength < 16) throw new Error('MP4 扩展盒头不完整');
          boxSize = readUint64(new DataView(extended.buf), 8);
          headerSize = 16;
        } else if (size32 === 0) {
          throw new Error('遇到长度延伸至文件末尾的 MP4 盒，无法安全进行 Range 流式解析');
        }

        if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) {
          throw new Error('MP4 盒长度无效：' + type);
        }
        if (type === 'mdat') {
          throw new Error('MP4 的 moov 位于 mdat 之后，当前版本将回退完整下载');
        }
        if (boxSize > MAX_METADATA_BOX_BYTES) {
          throw new Error('MP4 元数据盒过大，当前版本将回退完整下载');
        }
        if (this.total && offset + boxSize > this.total) {
          throw new Error('MP4 元数据盒超出文件长度');
        }

        const boxResult = await this._readRange(offset, offset + boxSize - 1, METADATA_TIMEOUT_MS);
        if (boxResult.buf.byteLength !== boxSize) throw new Error('MP4 元数据盒下载不完整：' + type);
        boxResult.buf.fileStart = offset;

        try {
          this.mp4box.appendBuffer(boxResult.buf);
        } catch (error) {
          throw new Error('MP4Box 读取 ' + type + ' 盒失败：' + (error && error.message || error));
        }

        offset += boxSize;
        if (type === 'moov') {
          try {
            parsedInfo = await Promise.race([
              readyPromise,
              delay(METADATA_TIMEOUT_MS).then(() => { throw new Error('等待 MP4 moov 解析超时'); }),
            ]);
          } catch (error) {
            parseError = error;
          }
          if (parseError) throw parseError;
          this.feedPos = offset;
          return parsedInfo;
        }
      }

      throw new Error('在 MP4 前 ' + MAX_METADATA_BOXES + ' 个盒中未找到 moov');
    }

    /* ---------- SourceBuffer 追加与队列 ---------- */

    async _waitSourceBufferIdle(sb, timeoutMs = 15_000) {
      if (!sb.updating) return true;
      return new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sb.removeEventListener('updateend', onEnd);
          sb.removeEventListener('error', onEnd);
          sb.removeEventListener('abort', onEnd);
          resolve(value);
        };
        const onEnd = () => finish(!sb.updating);
        const timer = setTimeout(() => finish(!sb.updating), timeoutMs);
        sb.addEventListener('updateend', onEnd);
        sb.addEventListener('error', onEnd);
        sb.addEventListener('abort', onEnd);
      });
    }

    async _append(cell, buffer) {
      if (this.dead) return false;
      const sb = cell.sb;
      cell.lastError = null;
      const idle = await this._waitSourceBufferIdle(sb);
      if (!idle || this.dead) {
        cell.lastError = new Error('SourceBuffer 等待空闲超时');
        return false;
      }

      return new Promise(resolve => {
        let settled = false;
        const finish = (ok, error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sb.removeEventListener('updateend', onUpdateEnd);
          sb.removeEventListener('error', onError);
          sb.removeEventListener('abort', onAbort);
          if (error) cell.lastError = error;
          resolve(ok);
        };
        const onUpdateEnd = () => finish(true);
        const onError = () => finish(false, new Error('SourceBuffer append error'));
        const onAbort = () => finish(false, new Error('SourceBuffer append aborted'));
        const timer = setTimeout(() => finish(false, new Error('SourceBuffer append 超时')), 15_000);
        sb.addEventListener('updateend', onUpdateEnd);
        sb.addEventListener('error', onError);
        sb.addEventListener('abort', onAbort);
        try { sb.appendBuffer(buffer); }
        catch (error) { finish(false, error); }
      });
    }

    async _drain(cell) {
      if (cell.busy || this.dead) return;
      cell.busy = true;
      while (cell.queue.length && !this.dead) {
        const item = cell.queue.shift();
        let ok = await this._append(cell, item.buffer);
        if (!ok && !this.dead && cell.lastError && cell.lastError.name === 'QuotaExceededError' && !item.quotaRetried) {
          // MSE 缓冲配额不足：强制清理已播区间后重试一次，避免直接整段回退。
          item.quotaRetried = true;
          this._trimBuffer(cell, true);
          await delay(150);
          ok = await this._append(cell, item.buffer);
        }
        if (!ok) {
          if (!this.dead) {
            const detail = cell.lastError ? '：' + (cell.lastError.name || cell.lastError.message || '') : '';
            this._fatal(new Error('MSE 分片追加失败（' + cell.kind + detail + '）'));
          }
          cell.queue.length = 0;
          break;
        }
        if (!item.init) {
          cell.count++;
          if (Number.isFinite(item.sampleNumber) && this.mp4box && typeof this.mp4box.releaseUsedSamples === 'function') {
            try { this.mp4box.releaseUsedSamples(cell.trackId, item.sampleNumber); } catch (_) { }
          }
        }
      }
      cell.busy = false;
      this._trimBuffer(cell);
    }

    _trimBuffer(cell, force = false) {
      try {
        const sb = cell.sb;
        if (sb.updating && !force) return;
        if (sb.updating) return;
        const buffered = sb.buffered;
        if (!buffered.length) return;
        const currentTime = this.v.currentTime;
        const cutoff = currentTime - (force ? 10 : BEHIND_SECONDS);
        const firstStart = buffered.start(0);
        const firstEnd = buffered.end(0);
        if (firstStart < cutoff && cutoff > firstStart) {
          sb.remove(firstStart, Math.min(cutoff, firstEnd));
        }
      } catch (_) { }
    }

    async _waitForFirstSegments(targetTime) {
      const start = Date.now();
      while (!this.dead && Date.now() - start < FIRST_SEGMENT_TIMEOUT_MS) {
        const videoCell = this.trackInfo && this.sbMap.get(this.trackInfo.video.id);
        if (videoCell && videoCell.count > 0) {
          const buffered = this.v.buffered;
          for (let i = 0; i < buffered.length; i++) {
            const from = buffered.start(i);
            const to = buffered.end(i);
            if (targetTime <= 0.5 && from <= 0.5 && to > 0.2) return;
            if (targetTime > 0.5 && targetTime >= from - 0.5 && targetTime <= to + 0.5) return;
          }
        }
        await delay(120);
      }
      if (this.dead) throw new Error('aborted');
      throw new Error('等待首个可播放分片超时');
    }

    async _waitForQueueDrain(gen) {
      const start = Date.now();
      while (!this.dead && gen === this.pumpGen && Date.now() - start < 30_000) {
        let pending = false;
        this.sbMap.forEach(cell => {
          if (cell.queue.length || cell.busy || cell.sb.updating) pending = true;
        });
        if (!pending) return true;
        await delay(100);
      }
      return false;
    }

    _isCurrentBlob() {
      try {
        if (!this.blobUrl || !this.v) return false;
        // 移动端 currentSrc 可能在 load 后短暂保留旧官方地址；用已设置的 src 辅助判断。
        return this.v.currentSrc === this.blobUrl || this.v.src === this.blobUrl;
      } catch (_) { return false; }
    }

    _fatal(error) {
      if (this.dead || this._fatalSent) return;
      // 若播放器已经被外部（站点自身/清晰度菜单）切到别的地址，我们的
      // SourceBuffer 被移除后追加必然抛 InvalidStateError；这不是流式失败，
      // 静默停机即可，不要再触发整段下载去覆盖用户正在看的画面。
      if (this.blobUrl && this.v && this.v.currentSrc && !this._isCurrentBlob()) {
        log('播放器已被外部切换，静默停止代理，不再回退下载');
        this.onStatus('', { hide: true });
        this.stop();
        return;
      }
      this._fatalSent = true;
      this.onFatal(error instanceof Error ? error : new Error(String(error)));
    }

    /* ---------- Range 顺序拉流 ---------- */

    async _pumpFrom(startPosition) {
      const generation = ++this.pumpGen;
      let position = Math.max(0, Math.floor(startPosition));
      let first = true;
      let retries = 0;

      while (!this.dead && generation === this.pumpGen) {
        if (await this._waitBackpressure(generation)) return;
        if (this.dead || generation !== this.pumpGen) return;

        if (this.total && position >= this.total) {
          await this._finishStream(generation);
          return;
        }

        const wanted = first ? SEEK_CHUNK_BYTES : CHUNK_BYTES;
        first = false;
        const end = this.total ? Math.min(position + wanted - 1, this.total - 1) : position + wanted - 1;
        const wantedBytes = end - position + 1;
        const request = gmRange(this.url, position, end);
        this.fetching = request;

        let result;
        try {
          result = await request.promise;
        } catch (error) {
          if (this.fetching === request) this.fetching = null;
          if (this.dead || generation !== this.pumpGen || error.aborted || error.message === 'aborted') return;
          if (error.status === 416) {
            const match = /content-range\s*:\s*bytes\s+\*\/(\d+)/i.exec(error.responseHeaders || '');
            if (match) this.total = Number(match[1]);
            if (this.total && position >= this.total) {
              await this._finishStream(generation);
            } else {
              this._fatal(new Error('上游拒绝当前 Range 请求（416），但请求位置尚未到达文件末尾'));
            }
            return;
          }
          retries++;
          if (retries > 3) {
            this._fatal(new Error('Range 拉流连续失败：' + (error.message || error)));
            return;
          }
          this.onStatus('网络波动，重试 ' + retries + '/3…');
          await delay(700 * retries);
          continue;
        }
        if (this.fetching === request) this.fetching = null;
        if (this.dead || generation !== this.pumpGen) return;
        retries = 0;

        if (result.total) this.total = result.total;
        if (!result.buf.byteLength) {
          this._fatal(new Error('Range 返回空数据'));
          return;
        }

        const buffer = result.buf;
        buffer.fileStart = position;
        position += buffer.byteLength;
        this.feedPos = position;

        try {
          this.mp4box.appendBuffer(buffer);
        } catch (error) {
          this._fatal(new Error('MP4 分片处理失败：' + (error && error.message || error)));
          return;
        }

        const reachedEnd = (this.total && position >= this.total) || buffer.byteLength < wantedBytes;
        if (reachedEnd) {
          await this._finishStream(generation);
          return;
        }
      }
    }

    async _finishStream(generation) {
      if (this.dead || generation !== this.pumpGen) return;
      try { this.mp4box.flush(); } catch (error) {
        this._fatal(new Error('MP4 结束分片处理失败：' + (error && error.message || error)));
        return;
      }
      const drained = await this._waitForQueueDrain(generation);
      if (!drained) {
        if (!this.dead && generation === this.pumpGen) this._fatal(new Error('等待 MSE 分片队列排空超时'));
        return;
      }
      if (this.dead || generation !== this.pumpGen) return;
      try {
        if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream();
      } catch (_) { }
      this.onStatus('缓冲完成');
      layer.show('◈ 缓冲完成');
    }

    async _waitBackpressure(generation) {
      while (!this.dead && generation === this.pumpGen) {
        // 已经在途的块允许完成；后续请求等浏览器再次允许取流。
        if (this.managed && !this.managedStreaming) {
          await delay(200);
          continue;
        }
        const currentTime = this.v.currentTime;
        const buffered = this.v.buffered;
        let ahead = 0;
        for (let i = 0; i < buffered.length; i++) {
          if (buffered.start(i) <= currentTime + 0.5 && buffered.end(i) > currentTime) {
            ahead = buffered.end(i) - currentTime;
            break;
          }
        }
        let queueFull = false;
        this.sbMap.forEach(cell => {
          if (cell.queue.length > MAX_QUEUE) queueFull = true;
        });
        if (ahead < AHEAD_SECONDS && !queueFull) return false;
        await delay(800);
      }
      return true;
    }

    /* ---------- Seek ---------- */

    _onSeeking() {
      clearTimeout(this.seekDebounce);
      const sequence = ++this.seekSequence;
      this.seekDebounce = setTimeout(() => {
        if (this.dead || sequence !== this.seekSequence) return;
        const target = this.v.currentTime;
        const buffered = this.v.buffered;
        for (let i = 0; i < buffered.length; i++) {
          if (target >= buffered.start(i) + 0.3 && target <= buffered.end(i) - 0.3) {
            // 用户跳到了已有缓冲区，清除上一次可能遗留的“跳转中”提示。
            this.onStatus('', { hide: true });
            return;
          }
        }
        this._seekTo(target, sequence);
      }, 260);
    }

    async _waitForSeekBuffer(target, generation, sequence) {
      const start = Date.now();
      while (!this.dead && sequence === this.seekSequence && generation === this.pumpGen &&
             Date.now() - start < SEEK_BUFFER_TIMEOUT_MS) {
        try {
          const buffered = this.v.buffered;
          let containsTarget = false;
          for (let i = 0; i < buffered.length; i++) {
            if (target >= buffered.start(i) - 0.25 && target <= buffered.end(i) + 0.05) {
              containsTarget = true;
              break;
            }
          }
          if (containsTarget && !this.v.seeking) return true;
        } catch (_) { }
        await delay(120);
      }
      if (this.dead || sequence !== this.seekSequence || generation !== this.pumpGen) return false;
      throw new Error('等待目标位置的媒体分片超时');
    }

    async _seekTo(target, sequence) {
      try {
        if (!this.mp4box || typeof this.mp4box.seek !== 'function') {
          throw new Error('MP4Box 不支持时间定位');
        }
        if (this.dead || sequence !== this.seekSequence) return;

        // 先计算偏移；若计算失败，不要提前中断当前正常拉流。
        const offset = mp4boxSeekOffset(this.mp4box, target);
        if (this.total && offset >= this.total) throw new Error('目标位置超出媒体文件范围');
        if (this.dead || sequence !== this.seekSequence) return;

        this.onStatus('跳转中… ' + this._formatTime(target), { sticky: true });
        this.pumpGen++;
        if (this.fetching) {
          this.fetching.abort();
          this.fetching = null;
        }

        // _pumpFrom 会同步递增 pumpGen；捕获该代号用于判断是否被后续 Seek/换源取消。
        this._pumpFrom(offset).catch(error => this._fatal(error));
        const generation = this.pumpGen;
        const ready = await this._waitForSeekBuffer(target, generation, sequence);
        if (!ready || this.dead || sequence !== this.seekSequence) return;

        // 成功提示替换“跳转中”，短暂显示后自动淡出，不再永久遮挡画面。
        this.onStatus('已跳转至 ' + this._formatTime(target), { duration: 1800 });
      } catch (error) {
        if (this.dead || sequence !== this.seekSequence || error.aborted || error.message === 'aborted') return;
        this.onStatus('跳转失败：' + (error && error.message || error), { duration: 4500 });
        log('seek error', error);
      }
    }

    _formatTime(seconds) {
      const value = Math.max(0, Math.floor(seconds || 0));
      return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
    }
  }

  /* ============================== 整段下载回退 ============================== */

  function fullDownloadAndPlay(player, proxyHost, officialUrl, startTime, autoPlay, isCurrent, onProgress) {
    const request = gmRequest({
      method: 'GET',
      url: buildProxyUrl(proxyHost, officialUrl),
      responseType: 'arraybuffer',
      timeout: 15 * 60 * 1000,
      onprogress(response) {
        if (!isCurrent()) return;
        const total = response.total || 0;
        onProgress(total
          ? '⇩ 整段下载 ' + Math.floor(response.loaded / total * 100) + '%'
          : '⇩ 已下载 ' + (response.loaded / 1024 / 1024).toFixed(0) + ' MB');
      },
    });
    const promise = request.promise.then(response => {
      if (!isCurrent()) throw abortError();
      if (response.status !== 200) throw new Error('HTTP ' + response.status + '（整段下载预期 HTTP 200）');
      // 整段文件无需交给 MP4Box，直接构造 Blob，避免额外复制大文件占用手机内存。
      const buf = response.response;
      if ((!ArrayBuffer.isView(buf) && Object.prototype.toString.call(buf) !== '[object ArrayBuffer]') || !buf.byteLength) {
        throw new Error('下载响应为空或不是二进制数据');
      }
      let objectUrl = '';
      try {
        objectUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
        prepareMediaElement(player);
        player.one('loadedmetadata', () => {
          if (!isCurrent()) return;
          try { player.currentTime(Math.max(0, startTime || 0)); } catch (_) { }
          if (autoPlay) tryPlay(player, () => {
            if (isCurrent()) onProgress('✓ 下载完成 · 请点播放器 ▶ 播放');
          });
        });
        player.src({ src: objectUrl, type: 'video/mp4' });
        if (typeof player.load === 'function') player.load();
        return objectUrl;
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        throw error;
      }
    });
    return { promise, abort: request.abort };
  }

  /* ============================== 原生反代回退 ============================== */

  // MSE 不可用或脚本管理器的 Range 请求不兼容时，由浏览器直接加载同一反代 URL。
  // 仍使用选中的线路，浏览器自行处理 Range/解码，避免立即把整个视频下载进手机内存。
  class NativeProxy {
    constructor(player, proxyHost, officialUrl, hooks = {}) {
      this.p = player;
      this.proxyHost = proxyHost;
      this.officialUrl = officialUrl;
      this.url = buildProxyUrl(proxyHost, officialUrl);
      this.onStatus = hooks.onStatus || (() => { });
      this.onFatal = hooks.onFatal || (() => { });
      this.dead = false;
      this.playbackReady = false;
      this.cleanup = null;
      this.cancel = null;
    }

    start(startTime, autoPlay) {
      return new Promise((resolve, reject) => {
        let metadataReady = false;
        let settled = false;
        let failed = false;
        let timer = null;
        let stallTimer = null;
        let lastTime = 0;
        const video = prepareMediaElement(this.p);
        const clearStall = () => { clearTimeout(stallTimer); stallTimer = null; };
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const fail = error => {
          if (this.dead || failed) return;
          failed = true;
          clearStall();
          if (!settled) finish(error); else this.onFatal(error);
        };
        const armStartup = (timeout, message) => {
          clearTimeout(timer);
          timer = setTimeout(() => fail(new Error(message)), timeout);
        };
        const onBlocked = () => {
          if (!this.dead && !failed) this.onStatus('请点播放器 ▶ 继续原生加载', { sticky: true });
        };
        const onCanPlay = () => {
          if (this.dead || failed || !metadataReady || (video && video.seeking)) return;
          const readyState = video ? video.readyState : (this.p.readyState && this.p.readyState());
          if (!(readyState >= 3)) return;
          this.playbackReady = true;
          clearStall();
          if (!settled) {
            finish();
            this.onStatus(this.p.paused() ? '原生反代已连接 · 请点 ▶ 播放' : '原生反代已就绪 · ' + this.proxyHost);
          }
        };
        const onMetadata = () => {
          if (this.dead || metadataReady || failed) return;
          metadataReady = true;
          // 元数据不代表目标位置有可播放数据；恢复进度后继续守护首帧缓冲。
          armStartup(FIRST_SEGMENT_TIMEOUT_MS, '原生反代等待可播放数据超时');
          try { this.p.currentTime(Math.max(0, Number(startTime) || 0)); } catch (_) { }
          this.onStatus('原生反代缓冲目标位置…', { sticky: true });
          if (autoPlay) tryPlay(this.p, onBlocked);
          onCanPlay();
        };
        const onPlaying = () => {
          if (this.dead || failed || !metadataReady) return;
          this.playbackReady = true;
          finish();
          clearStall();
          lastTime = Number(this.p.currentTime()) || 0;
          this.onStatus('原生反代播放 · ' + this.proxyHost);
        };
        const onWaiting = () => {
          if (this.dead || failed || !settled || this.p.paused() || stallTimer !== null ||
              (typeof this.p.ended === 'function' && this.p.ended())) return;
          stallTimer = setTimeout(() => fail(new Error('原生反代播放缓冲停滞超时')), NATIVE_STALL_TIMEOUT_MS);
        };
        const onPlay = () => {
          const readyState = video ? video.readyState : (this.p.readyState && this.p.readyState());
          if (!(readyState >= 3) || (video && video.seeking)) onWaiting();
        };
        const onTime = () => {
          const current = Number(this.p.currentTime());
          const readyState = video ? video.readyState : (this.p.readyState && this.p.readyState());
          if (Number.isFinite(current) && current > lastTime + 0.05 && readyState >= 3 &&
              !(video && video.seeking)) clearStall();
          if (Number.isFinite(current)) lastTime = current;
        };
        const onError = () => {
          if (this.dead) return;
          const detail = this.p.error && this.p.error();
          const error = new Error('原生反代播放失败' + (detail && detail.code ? '（媒体错误 ' + detail.code + '）' : ''));
          fail(error);
        };
        const listeners = {
          loadedmetadata: onMetadata, canplay: onCanPlay, seeked: onCanPlay, playing: onPlaying,
          waiting: onWaiting, stalled: onWaiting, seeking: onWaiting, play: onPlay,
          timeupdate: onTime, pause: clearStall, ended: clearStall, error: onError,
        };
        this.cleanup = () => {
          clearTimeout(timer);
          clearStall();
          Object.entries(listeners).forEach(([name, listener]) => this.p.off(name, listener));
        };
        this.cancel = () => finish(abortError());
        Object.entries(listeners).forEach(([name, listener]) => this.p.on(name, listener));
        armStartup(METADATA_TIMEOUT_MS, '原生反代连接超时');
        try {
          this.onStatus('尝试原生反代连接…', { sticky: true });
          this.p.src({ src: this.url, type: 'video/mp4' });
          if (typeof this.p.load === 'function') this.p.load();
          if (autoPlay) tryPlay(this.p, onBlocked);
        } catch (error) { fail(error); }
      });
    }

    stop() {
      if (this.dead) return;
      this.dead = true;
      if (this.cancel) this.cancel();
      if (this.cleanup) this.cleanup();
      this.cancel = null;
      this.cleanup = null;
    }
  }

  /* ============================== 控制器 ============================== */

  const ctrl = {
    player: null,
    playerEl: null,
    mode: 'official',
    active: null,
    lastOfficialUrl: '',
    operationId: 0,
    fallbackRequest: null,
    fallbackBlobUrl: null,
    lastRoute: location.pathname,
    lastKnownTime: 0,
    lastHandledOfficialUrl: '',
    watchTimer: null,
    pendingUrl: '',
    pendingSince: 0,
    sourceWatchGraceUntil: 0,
    preserveLastKnownTime: false,

    boot(player) {
      this.player = player;
      this.playerEl = player.el();
      this.mode = getSavedKey();
      this.lastRoute = location.pathname;
      this.lastKnownTime = 0;
      this.lastOfficialUrl = '';
      this.lastHandledOfficialUrl = '';
      this.pendingUrl = '';
      this.pendingSince = 0;
      this.sourceWatchGraceUntil = 0;
      this.preserveLastKnownTime = false;
      layer.ensure(this.playerEl);

      // 实测当前 Iwara 的 Video.js 构建在切换官方清晰度时不会向播放器派发
      // sourceset 事件，仅靠 sourceset 监听会漏掉切源：旧代理会继续向已被
      // 移除的 SourceBuffer 追加并误报流式失败、回退整段下载。因此增加
      // currentSrc 轮询监视作为主感知通道（sourceset 保留作兼容）。
      if (this.watchTimer) clearInterval(this.watchTimer);
      this.watchTimer = setInterval(() => {
        try { this._watchExternalSource(); }
        catch (error) { log('源监视失败', error); }
      }, 700);

      player.on('sourceset', event => {
        if (this.player !== player) return;
        this._onSourceset(event);
      });
      const rememberTime = () => {
        if (this.player !== player) return;
        // currentSrc 已变、轮询尚未接管的短暂窗口内，也不要把旧进度覆盖成 0。
        if (this.mode !== 'official' && this.lastHandledOfficialUrl) {
          const current = normalizeOfficial(player.currentSrc());
          if (isOfficialMediaUrl(current) && current !== this.lastHandledOfficialUrl) return;
        }
        const time = Number(player.currentTime());
        if (!Number.isFinite(time) || time < 0) return;
        // 外部清晰度切换可能先把 currentTime 短暂归零；等新源恢复到有效进度后再更新快照。
        if (this.preserveLastKnownTime && time <= 0.5) return;
        this.lastKnownTime = time;
        if (time > 0.5) this.preserveLastKnownTime = false;
      };
      player.on('timeupdate', rememberTime);
      player.on('seeking', rememberTime);

      // 脚本晚于播放器初始化时，接管已经存在的官方源。
      setTimeout(() => {
        if (this.player !== player) return;
        const current = normalizeOfficial(player.currentSrc());
        if (isOfficialMediaUrl(current)) this._onSourceset({ src: current });
      }, 800);
    },

    beginOperation() {
      this.operationId++;
      if (this.fallbackRequest) {
        this.fallbackRequest.abort();
        this.fallbackRequest = null;
      }
      this.stopProxy();
      if (this.fallbackBlobUrl) {
        revokeLater(this.fallbackBlobUrl);
        this.fallbackBlobUrl = null;
      }
      return this.operationId;
    },

    detachPlayer() {
      if (this.watchTimer) {
        clearInterval(this.watchTimer);
        this.watchTimer = null;
      }
      this.beginOperation();
      this.player = null;
      this.playerEl = null;
      ui.destroy();
      layer.destroy();
    },

    stopProxy() {
      if (this.active) {
        this.active.stop();
        this.active = null;
      }
    },

    _onSourceset(event) {
      if (!this.player) return;
      const raw = event && (event.src || (event.source && event.source.src));
      const sourceUrl = normalizeOfficial(raw || this.player.currentSrc());
      if (!sourceUrl || sourceUrl.startsWith('blob:')) return;

      if (!isOfficialMediaUrl(sourceUrl)) {
        if (!this.lastOfficialUrl) this.lastOfficialUrl = sourceUrl;
        return;
      }

      const previousHandledUrl = this.lastHandledOfficialUrl;
      const routeChanged = location.pathname !== this.lastRoute;
      this.lastOfficialUrl = sourceUrl;
      this.lastHandledOfficialUrl = sourceUrl;
      // sourceset 事件有时先于 currentSrc 更新；短暂忽略轮询读到的旧地址，避免反向误接管。
      this.sourceWatchGraceUntil = Date.now() + 1800;
      this.pendingUrl = '';
      this.lastRoute = location.pathname;
      if (routeChanged) {
        this.lastKnownTime = 0;
        this.preserveLastKnownTime = false;
      } else if (previousHandledUrl && previousHandledUrl !== sourceUrl && this.mode !== 'official') {
        this.preserveLastKnownTime = true;
      }
      if (this.mode === 'official') return;
      if (this.active && !this.active.dead && this.active.officialUrl === sourceUrl) return;

      const liveTime = Number(this.player.currentTime()) || 0;
      const startTime = routeChanged ? 0 : (liveTime > 0.5 ? liveTime : this.lastKnownTime);
      const operation = this.beginOperation();
      this._startProxy(sourceUrl, startTime, operation);
    },

    _watchExternalSource() {
      if (!this.player || this.mode === 'official' || Date.now() < this.sourceWatchGraceUntil) return;
      let current = '';
      try { current = normalizeOfficial(this.player.currentSrc()); } catch (_) { return; }
      if (!current || current.startsWith('blob:') || !isOfficialMediaUrl(current)) {
        this.pendingUrl = '';
        return;
      }
      if (current === this.lastHandledOfficialUrl) {
        this.pendingUrl = '';
        return;
      }
      if (this.active && !this.active.dead && this.active.officialUrl === current) {
        this.lastHandledOfficialUrl = current;
        this.pendingUrl = '';
        return;
      }
      // 去抖 600ms：等站点播放器完成清晰度切换的进度恢复后再接管，
      // 接管进度由 lastKnownTime/liveTime 决定，不会从头播放。
      if (this.pendingUrl !== current) {
        this.pendingUrl = current;
        this.pendingSince = Date.now();
        return;
      }
      if (Date.now() - this.pendingSince < 600) return;
      this.pendingUrl = '';
      log('监视到外部源变化，重新接管', current);
      this._onSourceset({ src: current });
    },

    _startProxy(officialUrl, startTime, operation) {
      const source = getSourceByKey(this.mode);
      if (!source.host || operation !== this.operationId) return;
      const player = this.player;
      const autoPlay = !player.paused() || !!player.autoplay();
      const isCurrent = () => operation === this.operationId && this.player === player;
      this.lastHandledOfficialUrl = officialUrl;

      const showStatus = (message, options = {}) => {
        if (!isCurrent()) return;
        if (options.hide || !message) { layer.hide(); return; }
        layer.show('◈ ' + message, !!options.sticky, options.duration || 2800);
      };
      const externalOfficial = () => {
        let current = '';
        try { current = normalizeOfficial(player.currentSrc()); } catch (_) { }
        // 初始连接失败时 currentSrc 可能仍为本次官方地址，不能因此跳过兼容回退。
        return isOfficialMediaUrl(current) && current !== officialUrl;
      };
      let fallbackTime = Math.max(0, Number(startTime) || 0);
      const resumeTime = () => {
        const live = Number(player.currentTime());
        // 每次换源都会短暂归零，下一阶段失败时仍沿用上次有效进度。
        // 已就绪的源允许用户主动回到开头，不能只取历史最大进度。
        if (Number.isFinite(live) && live >= 0 &&
            (live > 0.5 || (this.active && this.active.playbackReady))) fallbackTime = live;
        this.lastKnownTime = fallbackTime;
        return fallbackTime;
      };

      let nativeStarted = false;
      let downloadStarted = false;
      let native = null;
      const proxy = new MseProxy(player, source.host, officialUrl, {
        onStatus: (message, options) => {
          if (this.active === proxy) showStatus(message, options);
        },
        onFatal: error => startNative(error),
      });
      this.active = proxy;
      showStatus('连接 ' + source.host + ' …', { sticky: true });

      const startDownload = error => {
        if (downloadStarted || !isCurrent() || this.active !== native) return;
        downloadStarted = true;
        const position = resumeTime();
        native.stop();
        this.active = null;
        if (externalOfficial()) return;
        log('原生反代失败，准备完整下载：', error && error.message || error);

        if (proxy.total && proxy.total > MAX_FALLBACK_BYTES) {
          const allow = window.confirm(
            '当前视频约 ' + (proxy.total / 1024 / 1024).toFixed(0) + ' MB，流式播放失败。\n' +
            '完整下载会占用较多内存，是否仍要继续？'
          );
          if (!allow || !isCurrent()) {
            if (isCurrent()) {
              this.switchSource('official');
              layer.show('⚠ 已取消完整下载，已恢复官方线路');
            }
            return;
          }
        }

        showStatus('兼容播放失败，回退完整下载…', { sticky: true });
        const task = fullDownloadAndPlay(
          player, source.host, officialUrl, position, autoPlay, isCurrent,
          message => { if (isCurrent()) layer.show(message, true); }
        );
        this.fallbackRequest = task;
        task.promise.then(objectUrl => {
          if (isCurrent()) {
            this.fallbackBlobUrl = objectUrl;
            this.fallbackRequest = null;
            layer.show('✓ 完整下载完成 · 请点 ▶ 播放');
          } else { revokeLater(objectUrl); }
        }).catch(fallbackError => {
          if (!isCurrent() || fallbackError.aborted || fallbackError.message === 'aborted') return;
          this.fallbackRequest = null;
          this.switchSource('official');
          layer.show('✕ 反代失败，已恢复官方线路：' + (fallbackError.message || fallbackError), false, 6000);
          log('完整下载回退失败', fallbackError);
        });
      };

      const startNative = error => {
        if (nativeStarted || !isCurrent() || this.active !== proxy) return;
        nativeStarted = true;
        const position = resumeTime();
        proxy.stop();
        this.active = null;
        if (externalOfficial()) return;
        log('MSE 失败，尝试原生反代：', error && error.message || error);
        native = new NativeProxy(player, source.host, officialUrl, {
          onStatus: (message, options) => {
            if (this.active === native) showStatus(message, options);
          },
          onFatal: error => startDownload(error),
        });
        this.active = native;
        native.start(position, autoPlay).catch(error => {
          if (!native.dead && isCurrent()) startDownload(error);
        });
      };

      proxy.start(startTime).catch(error => {
        if (proxy.dead || !isCurrent()) return;
        startNative(error);
      });
    },

    switchSource(key) {
      if (!this.player) return;
      const selected = getSourceByKey(key);
      const operation = this.beginOperation();
      this.mode = selected.key;
      saveKey(selected.key);
      ui.refresh();

      if (!selected.host) {
        layer.show('◈ 已切换：官方线路');
        const officialUrl = this.lastOfficialUrl;
        if (officialUrl && isOfficialMediaUrl(officialUrl)) {
          const player = this.player;
          const liveTime = Number(player.currentTime()) || 0;
          const currentTime = liveTime > 0.5 ? liveTime : this.lastKnownTime;
          this.lastKnownTime = currentTime;
          const wasPlaying = !player.paused();
          player.one('loadedmetadata', () => {
            if (operation !== this.operationId || this.player !== player) return;
            try { player.currentTime(currentTime); } catch (_) { }
            if (wasPlaying) tryPlay(player, () => layer.show('◈ 请点播放器 ▶ 播放'));
          });
          player.src({ src: officialUrl, type: 'video/mp4' });
        }
        return;
      }

      let officialUrl = this.lastOfficialUrl;
      const current = normalizeOfficial(this.player.currentSrc());
      if (isOfficialMediaUrl(current)) officialUrl = current;
      if (!officialUrl || !isOfficialMediaUrl(officialUrl)) {
        layer.show('✕ 当前页面没有可代理的官方视频源');
        return;
      }

      const liveTime = Number(this.player.currentTime()) || 0;
      const currentTime = liveTime > 0.5 ? liveTime : this.lastKnownTime;
      this.lastKnownTime = currentTime;
      this.lastOfficialUrl = officialUrl;
      this._startProxy(officialUrl, currentTime, operation);
    },
  };

  /* ============================== 控制栏 UI ============================== */

  const ui = {
    btn: null,
    labelEl: null,
    hovering: false,

    inject() {
      const bar = ctrl.playerEl && ctrl.playerEl.querySelector('.vjs-control-bar');
      if (!bar) return false;

      if (this.btn && this.btn.isConnected && this.btn.parentElement === bar) {
        return true;
      }
      this.destroy();

      const anchor = bar.querySelector('.vjs-resolution-button, .vjs-settings-button');
      if (!anchor || !anchor.parentNode) return false;

      const wrap = document.createElement('div');
      wrap.className = 'vjs-menu-button-popup vjs-control vjs-button iwsrc-source-button';
      wrap.title = '播放源';
      wrap.innerHTML = [
        '<button class="vjs-menu-button vjs-menu-button-popup vjs-button" type="button" aria-haspopup="true" aria-expanded="false" aria-label="播放源">',
        '  <span class="vjs-icon-placeholder iwsrc-btn-label" aria-hidden="true">源</span>',
        '  <span class="vjs-control-text">播放源</span>',
        '</button>',
        '<div class="vjs-menu" role="presentation" style="display:none;">',
        '  <ul class="vjs-menu-content" role="menu"></ul>',
        '</div>',
      ].join('');

      const label = wrap.querySelector('.iwsrc-btn-label');
      const list = wrap.querySelector('.vjs-menu-content');
      for (const source of SOURCES) {
        const item = document.createElement('li');
        item.className = 'vjs-menu-item';
        item.dataset.sourceKey = source.key;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');
        item.tabIndex = 0;
        item.textContent = source.label;
        item.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          ctrl.switchSource(source.key);
          this.closeMenu();
        });
        item.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            ctrl.switchSource(source.key);
            this.closeMenu();
          }
        });
        list.appendChild(item);
      }

      const button = wrap.querySelector('button');
      // 鼠标/可悬停触控笔：进入按钮或菜单区域即展开，离开整个组件才收起。
      // 触屏设备不依赖 hover，点击按钮负责展开/收起，组件外点击负责关闭。
      wrap.addEventListener('pointerenter', event => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        this.hovering = true;
        this.setMenuOpen(true);
      });
      wrap.addEventListener('pointerleave', event => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        this.hovering = false;
        this.setMenuOpen(false);
      });

      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const open = wrap.classList.contains('iwsrc-open');
        // 鼠标悬停时点击不应把刚弹出的菜单立即关闭；触屏则按点击切换。
        this.setMenuOpen(this.hovering ? true : !open);
      });

      const style = document.createElement('style');
      style.className = 'iwsrc-source-style';
      style.textContent = [
        '.video-js .iwsrc-source-button{position:relative;}',
        '.video-js .iwsrc-source-button>button{display:flex;align-items:center;justify-content:center;}',
        '.video-js .iwsrc-source-button .iwsrc-btn-label{display:flex;align-items:center;justify-content:center;width:100%;font-size:11px;font-weight:700;letter-spacing:0;white-space:nowrap;text-align:center;}',
        '.video-js .iwsrc-source-button .iwsrc-btn-label:before{content:none!important;}',
        '.video-js .iwsrc-source-button .vjs-menu{display:none;left:50%!important;right:auto!important;transform:translateX(-50%)!important;width:136px!important;min-width:136px!important;max-width:136px!important;box-sizing:border-box;}',
        '.video-js .iwsrc-source-button.iwsrc-open .vjs-menu{display:block;}',
        '.video-js .iwsrc-source-button .vjs-menu-content{width:100%;max-height:60vh;overflow-y:auto;box-sizing:border-box;text-align:center;}',
        '.video-js .iwsrc-source-button .vjs-menu-item{display:flex;align-items:center;justify-content:center;width:100%;min-height:2.4em;box-sizing:border-box;padding:0 8px!important;white-space:nowrap;text-align:center!important;}',
        '.video-js .iwsrc-source-button .vjs-menu-item.vjs-selected{font-weight:700;}',
      ].join('');
      if (!document.querySelector('style.iwsrc-source-style')) {
        (document.head || document.documentElement).appendChild(style);
      }

      anchor.parentNode.insertBefore(wrap, anchor);
      this.btn = wrap;
      this.labelEl = label;
      this.refresh();
      return true;
    },

    setMenuOpen(open) {
      if (!this.btn) return;
      const isOpen = !!open;
      this.btn.classList.toggle('iwsrc-open', isOpen);
      const button = this.btn.querySelector('button');
      const menu = this.btn.querySelector('.vjs-menu');
      if (button) button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (menu) menu.style.display = isOpen ? 'block' : 'none';
    },

    closeMenu() { this.setMenuOpen(false); },

    refresh() {
      if (!this.btn) return;
      const current = getSourceByKey(ctrl.mode || getSavedKey());
      if (this.labelEl) this.labelEl.textContent = current.buttonLabel;
      const button = this.btn.querySelector('button');
      if (button) button.setAttribute('aria-label', '当前播放源：' + current.label + '；点击选择播放源');
      this.btn.querySelectorAll('.vjs-menu-item').forEach(item => {
        const active = item.dataset.sourceKey === current.key;
        item.classList.toggle('active', active);
        item.classList.toggle('vjs-selected', active);
        item.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    },

    destroy() {
      if (this.btn && this.btn.isConnected) this.btn.remove();
      this.btn = null;
      this.labelEl = null;
      this.hovering = false;
    },
  };

  /* ============================== 播放器发现 / SPA 监听 ============================== */

  function findPlayer() {
    for (const element of document.querySelectorAll('.video-js')) {
      const player = element.player;
      if (player && typeof player.el === 'function' && typeof player.src === 'function') return player;
    }
    return null;
  }

  function tryBoot() {
    const player = findPlayer();
    if (!player) {
      if (ctrl.player) ctrl.detachPlayer();
      return false;
    }
    if (ctrl.player !== player || ctrl.playerEl !== player.el()) {
      ctrl.detachPlayer();
      ctrl.boot(player);
      ui.inject();
      log('播放器已接管', player.currentSrc && player.currentSrc());
      return true;
    }
    return ui.inject();
  }

  function startWatch() {
    const tick = () => {
      try { tryBoot(); }
      catch (error) { log('播放器初始化失败', error); }
    };

    document.addEventListener('click', event => {
      if (ui.btn && !ui.btn.contains(event.target)) ui.closeMenu();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') ui.closeMenu();
    }, true);

    const observer = new MutationObserver(() => {
      if (!ui.btn || !ui.btn.isConnected || (ctrl.playerEl && !ctrl.playerEl.contains(ui.btn))) tick();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(tick, 450);
      }
    }, 500);
    setInterval(tick, 1500);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWatch, { once: true });
  } else {
    startWatch();
  }
})();
