// Cam player: live HLS stream (via the site proxy) with a rewind mode that
// scrubs back through Surfline's 10-minute archive clips.
//
// Rewind discovery is layered, because the endpoints are unofficial:
//   1. services clip-listing endpoints (if they answer, we trust them)
//   2. probe `${rewindBaseUrl}.<UTC stamp>.mp4` on 10-minute marks
//   3. otherwise the rewind UI stays hidden — live/still always works.

import { proxied, probeUrl, getRewindClips } from '../api.js';
import { el, esc, toast, fmtHour, fmtDayShort } from '../format.js';

let hlsLoader = null;
function loadHls() {
  if (window.Hls) return Promise.resolve();
  if (!hlsLoader) {
    hlsLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/hls.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return hlsLoader;
}

const CLIP_SECONDS = 600;
const REWIND_DAYS = 5;

export function createCamPlayer(container, spot) {
  const cams = (spot.cameras || []).filter((c) => c.streamUrl || c.stillUrl);
  if (!cams.length) return null;

  const off = spot.utcOffset ?? 0;
  let cam = cams[0];
  let hls = null;
  let mode = 'live';        // live | rewind
  let clips = [];           // [{url, start}] for the selected day, ascending
  let clipIndex = -1;
  let dayOffset = 0;        // 0 = today, 1 = yesterday …
  let probePattern = null;  // discovered rewind URL pattern fn(tsUTCsec) -> url
  let destroyed = false;

  container.innerHTML = `
  <div class="cam">
    <div class="cam-frame">
      <video playsinline muted autoplay preload="metadata"></video>
      <img class="cam-still" alt="Latest still from the cam" hidden>
      <div class="cam-msg" hidden></div>
      <div class="cam-live-badge"><span class="pulse"></span><span class="txt">LIVE</span></div>
      <div class="cam-overlay">
        <button class="iconbtn" data-act="snap" aria-label="Save snapshot" title="Snapshot">
          <svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7l1.5-2.5h4L15.5 7"/></svg>
        </button>
        <button class="iconbtn" data-act="fs" aria-label="Fullscreen" title="Fullscreen">
          <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
        </button>
      </div>
    </div>
    <div class="cam-bar">
      <span class="cam-picker"></span>
      <span class="grow"></span>
      <button class="cambtn on" data-act="live">Live</button>
      <button class="cambtn" data-act="rewind">Rewind</button>
      <button class="cambtn" data-act="mute" aria-label="Unmute">
        <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="mute-x" d="M16 9l5 6M21 9l-5 6"/></svg>
      </button>
    </div>
    <div class="rewind" hidden>
      <div class="rw-head">
        <span class="label">Rewind — past ${REWIND_DAYS} days</span>
        <span class="small faint rw-status"></span>
      </div>
      <div class="rw-days"></div>
      <div class="rw-clips"></div>
      <div class="rw-scrub" hidden>
        <input type="range" min="0" max="600" value="0" step="1" style="width:100%" aria-label="Scrub within clip">
        <div class="cam-bar" style="margin-top:6px">
          <button class="cambtn" data-act="prevclip" aria-label="Previous clip" title="Previous 10 min">
            <svg viewBox="0 0 24 24"><path d="M17 5l-8 7 8 7M7 5v14"/></svg>
          </button>
          <button class="cambtn" data-act="back10" title="Back 10s">−10s</button>
          <button class="cambtn" data-act="playpause" aria-label="Play / pause">
            <svg viewBox="0 0 24 24" class="pp-pause"><path d="M8 5v14M16 5v14"/></svg>
          </button>
          <button class="cambtn" data-act="fwd10" title="Forward 10s">+10s</button>
          <button class="cambtn" data-act="nextclip" aria-label="Next clip" title="Next 10 min">
            <svg viewBox="0 0 24 24"><path d="M7 5l8 7-8 7M17 5v14"/></svg>
          </button>
          <span class="grow"></span>
          <button class="cambtn" data-act="speed" title="Playback speed">1×</button>
          <a class="cambtn" data-act="dl" download title="Download this clip">
            <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          </a>
        </div>
      </div>
    </div>
  </div>`;

  const $ = (sel) => container.querySelector(sel);
  const video = $('video');
  const still = $('.cam-still');
  const msg = $('.cam-msg');
  const badge = $('.cam-live-badge');
  const badgeTxt = $('.cam-live-badge .txt');
  const rewindBox = $('.rewind');
  const rwStatus = $('.rw-status');
  const scrubBox = $('.rw-scrub');
  const scrub = scrubBox.querySelector('input');
  const speeds = [1, 2, 4, 8, 0.5];
  let speedIdx = 0;

  function showMsg(html) {
    msg.innerHTML = `<svg class="wavey" viewBox="0 0 60 24"><path d="M2 15c6-10 10-10 16 0s10 10 16 0 10-10 16 0"/></svg><div>${html}</div>`;
    msg.hidden = false;
  }
  function hideMsg() { msg.hidden = true; }

  function showStill() {
    if (cam.stillUrl) { still.src = proxied(cam.stillUrl); still.hidden = false; }
  }

  function teardownStream() {
    if (hls) { try { hls.destroy(); } catch { /* */ } hls = null; }
    video.removeAttribute('src');
    try { video.load(); } catch { /* */ }
  }

  // ------------------------------------------------------------------ live
  async function playLive() {
    mode = 'live';
    badge.classList.remove('rewinding');
    badgeTxt.textContent = 'LIVE';
    $('[data-act="live"]').classList.add('on');
    $('[data-act="rewind"]').classList.remove('on');
    rewindBox.hidden = true;
    teardownStream();
    hideMsg();
    still.hidden = true;
    video.playbackRate = 1;

    if (cam.isDown) {
      showStill();
      showMsg('This cam is reported down. Showing the latest still.');
      return;
    }
    if (!cam.streamUrl) {
      showStill();
      showMsg(cam.isPremium ? 'Premium-only cam — no free stream.' : 'No live stream for this cam.');
      return;
    }

    const src = proxied(cam.streamUrl);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => { /* autoplay policies */ });
      return;
    }
    try {
      await loadHls();
    } catch {
      showStill(); showMsg('Player failed to load.'); return;
    }
    if (destroyed || mode !== 'live') return;
    if (!window.Hls.isSupported()) { showStill(); showMsg('HLS not supported in this browser.'); return; }
    hls = new window.Hls({ maxBufferLength: 20, liveSyncDurationCount: 3 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => { /* */ }));
    hls.on(window.Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      teardownStream();
      showStill();
      showMsg(cam.isPremium
        ? 'Stream unavailable (premium cam). Showing the latest still.'
        : 'Live stream unavailable right now. Showing the latest still.');
    });
  }

  // ---------------------------------------------------------------- rewind
  function utcStamp(tsSec) {
    const d = new Date(tsSec * 1000);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
  }
  // Two clip-name patterns seen in the wild:
  //   <base>.<YYYYMMDDTHHMMSS>.mp4        (UTC stamp)
  //   <base>.<HHMM>.<YYYY-MM-DD>.mp4      (cam-local time)
  function patternUrlUtc(tsSec) {
    return `${cam.rewindBaseUrl}.${utcStamp(tsSec)}.mp4`;
  }
  function patternUrlLocal(tsSec) {
    const d = new Date(tsSec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${cam.rewindBaseUrl}.${p(d.getHours())}${p(d.getMinutes())}.${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.mp4`;
  }

  async function discoverPattern() {
    if (!cam.rewindBaseUrl) return false;
    const nowAligned = Math.floor(Date.now() / 1000 / CLIP_SECONDS) * CLIP_SECONDS;
    const tries = [2, 3, 5, 8].map((n) => nowAligned - n * CLIP_SECONDS);
    for (const fn of [patternUrlUtc, patternUrlLocal]) {
      const results = await Promise.all(tries.map((t) => probeUrl(fn(t))));
      if (results.some(Boolean)) { probePattern = fn; return true; }
    }
    return false;
  }

  async function loadDay(offset) {
    dayOffset = offset;
    clips = [];
    clipIndex = -1;
    renderDays();
    renderClips([]);
    rwStatus.textContent = 'Looking for clips…';

    const now = new Date();
    const dayStartLocal = new Date(now); dayStartLocal.setHours(0, 0, 0, 0);
    const start = new Date(dayStartLocal.getTime() - offset * 86400_000);
    const end = new Date(start.getTime() + 86400_000);

    // 1) listing endpoint
    const iso = (d) => d.toISOString().slice(0, 10);
    let list = cam.id ? await getRewindClips(cam.id, iso(start), iso(end)) : null;
    if (list && list.length) {
      clips = list
        .map((c) => ({ url: c.url, start: typeof c.start === 'number' ? c.start : Date.parse(c.start) / 1000 }))
        .filter((c) => c.url && isFinite(c.start))
        .sort((a, b) => a.start - b.start);
      rwStatus.textContent = `${clips.length} clips`;
      renderClips(clips);
      return;
    }

    // 2) probed URL pattern (10-minute marks, assumed UTC-stamped)
    if (probePattern === null && cam.rewindBaseUrl) await discoverPattern();
    if (probePattern) {
      const from = Math.floor(start.getTime() / 1000 / CLIP_SECONDS) * CLIP_SECONDS;
      const to = Math.min(Date.now() / 1000, end.getTime() / 1000);
      for (let t = from; t < to; t += CLIP_SECONDS) clips.push({ url: probePattern(t), start: t, probed: true });
      rwStatus.textContent = 'archive (availability varies)';
      renderClips(clips);
      return;
    }

    rwStatus.textContent = '';
    renderClips([]);
    $('.rw-clips').innerHTML = '<div class="empty">No rewind archive reachable for this cam.</div>';
  }

  function renderDays() {
    const box = $('.rw-days');
    box.innerHTML = '';
    for (let i = 0; i < REWIND_DAYS; i++) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday'
        : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
      const b = el(`<button class="chip ${i === dayOffset ? 'on' : ''}">${esc(label)}</button>`);
      b.addEventListener('click', () => loadDay(i));
      box.appendChild(b);
    }
  }

  function renderClips(list) {
    const box = $('.rw-clips');
    box.innerHTML = '';
    list.forEach((c, i) => {
      const d = new Date(c.start * 1000);
      const mins = d.getMinutes();
      const label = mins === 0 ? `${((d.getHours() % 12) || 12)}${d.getHours() < 12 ? 'a' : 'p'}` : '';
      const b = el(`<button class="rw-clip avail" title="${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}">${label}</button>`);
      b.addEventListener('click', () => playClip(i));
      c.el = b;
      box.appendChild(b);
    });
  }

  function playClip(i) {
    if (i < 0 || i >= clips.length) return;
    const c = clips[i];
    clipIndex = i;
    clips.forEach((x) => x.el?.classList.remove('playing'));
    c.el?.classList.add('playing');
    c.el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

    mode = 'rewind';
    teardownStream();
    hideMsg();
    still.hidden = true;
    badge.classList.add('rewinding');
    const d = new Date(c.start * 1000);
    badgeTxt.textContent = `REWIND · ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    scrubBox.hidden = false;
    $('[data-act="dl"]').href = proxied(c.url);
    $('[data-act="dl"]').setAttribute('download', `rewind-${utcStamp(c.start)}.mp4`);

    video.src = proxied(c.url);
    video.playbackRate = speeds[speedIdx];
    video.play().catch(() => { /* */ });

    video.onerror = () => {
      if (c.probed) {
        c.el?.classList.remove('avail');
        c.el?.classList.add('gone');
        rwStatus.textContent = 'Clip missing — trying the next one…';
        if (clipIndex === i && i + 1 < clips.length) playClip(i + 1);
      } else {
        showMsg('Clip failed to load.');
      }
    };
  }

  // ------------------------------------------------------------- controls
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'live') playLive();
    if (act === 'rewind') {
      $('[data-act="live"]').classList.remove('on');
      btn.classList.add('on');
      rewindBox.hidden = false;
      badge.classList.add('rewinding');
      if (!clips.length) loadDay(0);
    }
    if (act === 'mute') {
      video.muted = !video.muted;
      btn.querySelector('.mute-x').style.display = video.muted ? '' : 'none';
      btn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    }
    if (act === 'fs') {
      const frame = $('.cam-frame');
      if (frame.requestFullscreen) frame.requestFullscreen().catch(() => { /* */ });
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
    if (act === 'snap') {
      try {
        const cv = document.createElement('canvas');
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        if (!cv.width) { toast('No frame yet'); return; }
        cv.getContext('2d').drawImage(video, 0, 0);
        cv.toBlob((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(spot.name || 'cam').replace(/\W+/g, '-').toLowerCase()}-${Date.now()}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }, 'image/png');
      } catch { toast('Snapshot failed'); }
    }
    if (act === 'playpause') video.paused ? video.play() : video.pause();
    if (act === 'back10') video.currentTime = Math.max(0, video.currentTime - 10);
    if (act === 'fwd10') video.currentTime = Math.min(video.duration || 600, video.currentTime + 10);
    if (act === 'prevclip') playClip(clipIndex - 1);
    if (act === 'nextclip') playClip(clipIndex + 1);
    if (act === 'speed') {
      speedIdx = (speedIdx + 1) % speeds.length;
      video.playbackRate = speeds[speedIdx];
      btn.textContent = `${speeds[speedIdx]}×`;
    }
  });

  video.addEventListener('timeupdate', () => {
    if (mode !== 'rewind') return;
    if (video.duration) scrub.max = Math.round(video.duration);
    scrub.value = Math.round(video.currentTime);
  });
  video.addEventListener('ended', () => {
    if (mode === 'rewind' && clipIndex + 1 < clips.length) playClip(clipIndex + 1);
  });
  scrub.addEventListener('input', () => { video.currentTime = +scrub.value; });

  // cam picker
  if (cams.length > 1) {
    const picker = $('.cam-picker');
    cams.forEach((c, i) => {
      const b = el(`<button class="cambtn ${i === 0 ? 'on' : ''}">${esc(c.title || `Cam ${i + 1}`)}</button>`);
      b.addEventListener('click', () => {
        picker.querySelectorAll('.cambtn').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        cam = c; clips = []; probePattern = null;
        if (mode === 'rewind') { rewindBox.hidden = false; loadDay(dayOffset); }
        playLive();
      });
      picker.appendChild(b);
    });
  }

  playLive();

  return {
    destroy() {
      destroyed = true;
      teardownStream();
    },
  };
}
