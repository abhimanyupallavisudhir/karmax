// The recording stage. In the top page (/__stage) it builds a brand backdrop,
// a browser window holding the real console in an iframe, a caption band, a
// cursor, title cards, a terminal and a checklist; `window.__demo` drives them.
// Inside the console's frame it only makes the console show Mac shortcuts.
(() => {
  try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); } catch {}
  if (window !== window.top || !location.pathname.startsWith('/__stage')) return;
  const W = 1440, H = 810, S = 0.84, BAR = 32, Z = 4 / 3;
  const WW = Math.round(W * S), WH = Math.round(H * S), X0 = Math.round((W - WW) / 2), Y0 = 20;
  const css = `
  html{margin:0;width:${W * Z}px;height:${H * Z}px;overflow:hidden;background:#eef0f5}
  /* Laid out at 1440×810, drawn at 1920×1080: the transform re-rasterises everything at full resolution. */
  body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;transform:scale(${Z});transform-origin:0 0;position:relative}
  #bg{position:absolute;inset:0;background:radial-gradient(1100px 620px at 50% 38%,#ffffff 0%,#f3f4f8 55%,#e7e9f1 100%)}
  #bg:after{content:"";position:absolute;inset:0;background:radial-gradient(700px 300px at 18% 105%,rgba(91,91,214,.10),transparent 70%),radial-gradient(600px 280px at 88% 100%,rgba(214,164,60,.10),transparent 70%)}
  #win{position:absolute;left:${X0}px;top:${Y0}px;width:${WW}px;height:${WH + BAR}px;border-radius:12px;overflow:hidden;background:#fff;
    box-shadow:0 30px 80px rgba(30,30,60,.18),0 8px 24px rgba(30,30,60,.10),0 0 0 1px rgba(20,20,40,.08);transform-origin:0 0;will-change:transform}
  #win .bar{height:${BAR}px;display:flex;align-items:center;gap:7px;padding:0 13px;background:#f4f4f7;border-bottom:1px solid #e3e3ea;box-sizing:border-box}
  #win .dot{width:11px;height:11px;border-radius:50%}
  #win .url{margin:0 auto;transform:translateX(-24px);height:21px;min-width:360px;padding:0 14px;border-radius:7px;background:#fff;border:1px solid #e3e3ea;
    display:flex;align-items:center;justify-content:center;gap:6px;font-size:12.5px;color:#55556a;letter-spacing:.005em}
  #win .url b{color:#16161d;font-weight:600}
  #win .view{position:relative;width:${WW}px;height:${WH}px;overflow:hidden}
  #app{position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;transform:scale(${S});transform-origin:0 0;background:#f7f8fa}
  #band{position:absolute;left:0;right:0;top:${Y0 + BAR + WH}px;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  #caption{font-size:26px;font-weight:600;letter-spacing:-.015em;color:#16161d;opacity:0;transform:translateY(10px);transition:opacity .35s ease,transform .5s cubic-bezier(.2,.9,.25,1);white-space:nowrap;
    padding:9px 22px;border-radius:14px;background:rgba(255,255,255,.82);backdrop-filter:blur(12px);box-shadow:0 6px 24px rgba(30,30,60,.10),0 0 0 1px rgba(20,20,40,.05)}
  #still{position:absolute;z-index:26;object-fit:cover;transform-origin:0 0}
  #caption.on{opacity:1;transform:none}
  #caption em{font-style:normal;color:#5b5bd6}
  #caption kbd{font:600 21px Inter,system-ui;padding:2px 9px;border-radius:7px;background:#16161d;color:#fff;margin:0 2px;vertical-align:2px}
  #layer{position:absolute;inset:0;pointer-events:none;z-index:10}
  #cursor{position:absolute;left:0;top:0;width:24px;height:24px;transform:translate(-100px,-100px);will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3));transition:opacity .25s;z-index:30}
  .ripple{position:absolute;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;border:3px solid rgba(91,91,214,.7);background:rgba(91,91,214,.12);animation:rip .5s ease-out forwards;z-index:29}
  @keyframes rip{from{transform:scale(.35);opacity:1}to{transform:scale(1.25);opacity:0}}
  #card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0;transition:opacity .55s ease;text-align:center;color:#16161d;z-index:20;
    background:radial-gradient(900px 560px at 50% 44%,#ffffff 0%,#f6f7f9 62%,#eceef4 100%)}
  #card.on{opacity:1}
  #card .mark{width:112px;height:112px;margin-bottom:28px;filter:drop-shadow(0 14px 30px rgba(40,30,10,.2));transform:scale(.86);opacity:0;transition:all .8s cubic-bezier(.2,.9,.25,1) .05s}
  #card .word{font-size:88px;font-weight:700;letter-spacing:-.05em;line-height:1;opacity:0;transform:translateY(14px);transition:all .8s cubic-bezier(.2,.9,.25,1) .15s}
  #card .sub{margin-top:22px;font-size:30px;font-weight:500;color:#5b5bd6;letter-spacing:-.01em;opacity:0;transform:translateY(12px);transition:all .8s cubic-bezier(.2,.9,.25,1) .35s}
  #card .url{margin-top:40px;font-size:22px;font-weight:600;color:#fff;background:#5b5bd6;opacity:0;transition:opacity .7s ease .6s;padding:12px 26px;border-radius:12px}
  #card.on .mark,#card.on .word,#card.on .sub,#card.on .url{opacity:1;transform:none}
  #scrim{position:absolute;inset:0;background:rgba(230,232,240,.45);backdrop-filter:blur(6px);opacity:0;transition:opacity .45s ease;z-index:12}
  #scrim.on{opacity:1}
  #term{position:absolute;left:50%;top:${Y0 + 40}px;width:920px;transform:translate(-50%,18px) scale(.97);opacity:0;transition:all .45s cubic-bezier(.2,.9,.25,1);z-index:14;
    background:#15151d;border-radius:12px;box-shadow:0 40px 110px rgba(10,10,30,.45),0 0 0 1px rgba(255,255,255,.07);overflow:hidden}
  #term.on{opacity:1;transform:translate(-50%,0)}
  #term .tbar{height:32px;background:#202029;display:flex;align-items:center;padding:0 13px;gap:7px;color:#9a9ab0;font-size:13px;font-weight:500}
  #term .dot{width:11px;height:11px;border-radius:50%}
  #term .title{flex:1;text-align:center;margin-right:48px}
  #term pre{margin:0;padding:18px 22px 22px;height:520px;overflow:hidden;font:16px/1.6 "DejaVu Sans Mono",ui-monospace,monospace;color:#e8e8f2;white-space:pre-wrap;word-break:break-word}
  #term .p{color:#9d98ff}#term .ok{color:#62d6a0}#term .dim{color:#8a8aa2}
  #term .caret{display:inline-block;width:9px;height:18px;background:#e8e8f2;vertical-align:-3px;animation:blink 1s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  #list{position:absolute;left:50%;top:50%;width:860px;transform:translate(-50%,-47%);opacity:0;transition:all .5s cubic-bezier(.2,.9,.25,1);z-index:14;
    background:#fff;border-radius:20px;box-shadow:0 40px 110px rgba(30,30,60,.25),0 0 0 1px rgba(20,20,40,.06);padding:26px 32px 18px;color:#16161d}
  #list.on{opacity:1;transform:translate(-50%,-50%)}
  #list h2{margin:0 0 10px;font-size:28px;letter-spacing:-.02em}
  #list .row{display:flex;align-items:center;gap:15px;padding:10px 4px;border-top:1px solid #ececf1;font-size:21px;font-weight:500;opacity:0;transform:translateY(8px);transition:all .35s ease}
  #list .row.on{opacity:1;transform:none}
  #list .box{flex:none;width:25px;height:25px;border-radius:8px;border:2px solid #c9c9d6;display:grid;place-items:center;transition:all .22s ease}
  #list .row.done .box{background:#5b5bd6;border-color:#5b5bd6}
  #list .box svg{opacity:0;transform:scale(.4);transition:all .25s cubic-bezier(.2,.9,.25,1.4)}
  #list .row.done .box svg{opacity:1;transform:none}
  #list .hint{margin-left:auto;font-size:16px;color:#8a8aa2;font-weight:500}`;
  const MARK = '<img src="/brand/icon.svg" width="100%" height="100%" alt="">';
  const CURSOR = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5v18l4.6-4.3 2.9 6.7 3.2-1.4-2.9-6.6h6.5z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const TICK = '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const $ = (q) => document.querySelector(q);
  let pos = [W / 2, H / 2 + 60];
  const ease = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const place = () => { $('#cursor').style.transform = `translate(${pos[0] - 4}px,${pos[1] - 2}px)`; };
  function build(src) {
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    document.body.innerHTML = `<div id="bg"></div>
      <div id="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
        <div class="url"><svg width="10" height="11" viewBox="0 0 10 11"><rect x="1" y="5" width="8" height="6" rx="1.5" fill="#8a8aa2"/><path d="M3 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="#8a8aa2" stroke-width="1.4"/></svg><b>tavya.io</b><span id="path"></span></div></div>
        <div class="view"><iframe id="app" name="app" src="${src}"></iframe></div></div>
      <div id="band"><div id="caption"></div></div>
      <div id="layer"><div id="scrim"></div><div id="term"><div class="tbar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">zsh</span></div><pre></pre></div>
        <div id="list"></div><div id="card"></div><div id="cursor">${CURSOR}</div></div>`;
    place();
    setInterval(() => { try { const l = $('#app').contentWindow.location; const p = decodeURIComponent(l.pathname + l.search); $('#path').textContent = p === '/' ? '' : p; } catch {} }, 150);
  }
  const api = {
    build,
    geometry: { W, H, S, BAR, X0, Y0, WW, WH, Z },
    move(x, y, ms = 600) {
      const from = [...pos], t0 = performance.now();
      return new Promise((resolve) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms), e = ease(t);
          const lift = Math.sin(Math.PI * t) * Math.min(36, Math.hypot(x - from[0], y - from[1]) * .07);
          pos = [from[0] + (x - from[0]) * e, from[1] + (y - from[1]) * e - lift]; place();
          if (t < 1) requestAnimationFrame(step); else { pos = [x, y]; place(); resolve(); }
        };
        requestAnimationFrame(step);
      });
    },
    where() { return pos; },
    ripple() { const r = document.createElement('div'); r.className = 'ripple'; r.style.left = `${pos[0]}px`; r.style.top = `${pos[1]}px`; $('#layer').appendChild(r); setTimeout(() => r.remove(), 600); },
    cursorVisible(on) { $('#cursor').style.opacity = on ? '1' : '0'; },
    caption(html) {
      const c = $('#caption');
      if (!html) { c.classList.remove('on'); return; }
      const show = () => { c.innerHTML = html; void c.offsetWidth; c.classList.add('on'); };
      if (c.classList.contains('on')) { c.classList.remove('on'); setTimeout(show, 280); } else show();
    },
    /** Zoom the window so stage point (fx, fy) is centred at scale s. */
    camera(s = 1, fx = W / 2, fy = H / 2, ms = 900) {
      const w = $('#win');
      const tx = s === 1 ? 0 : W / 2 - (fx - X0) * s - X0, ty = s === 1 ? 0 : H / 2 - (fy - Y0) * s - Y0;
      w.style.transition = ms ? `transform ${ms}ms cubic-bezier(.45,.05,.2,1)` : 'none';
      w.style.transform = s === 1 ? '' : `translate(${tx}px,${ty}px) scale(${s})`;
      return new Promise((r) => setTimeout(r, ms));
    },
    card({ word = 'tavya', sub = '', url = '' } = {}) {
      const c = $('#card');
      if (word === null) { c.classList.remove('on'); return; }
      c.innerHTML = `<div class="mark">${MARK}</div><div class="word">${word}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${url ? `<div class="url">${url}</div>` : ''}`;
      void c.offsetWidth; c.classList.add('on');
    },
    // The tagline's line is laid out (invisible) from the first frame, so adding it moves nothing.
    cardInstant(sub = 'The to-do list for AI agents.') { const c = $('#card'); c.style.transition = 'none'; c.innerHTML = `<div class="mark">${MARK}</div><div class="word">tavya</div><div class="sub" style="opacity:0">${sub}</div>`; c.querySelectorAll('*').forEach((e) => { e.style.transition = 'none'; }); c.classList.add('on'); void c.offsetWidth; c.style.transition = ''; },
    /** A still laid exactly over stage rect (x, y, w, h), then grown to fill the stage. */
    still(src, x, y, w, h, ms = 1500) {
      const img = document.createElement('img'); img.id = 'still'; img.src = src;
      Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      $('#layer').appendChild(img);
      return new Promise((resolve) => img.decode().then(() => {
        img.style.transition = `all ${ms}ms cubic-bezier(.45,.05,.2,1)`;
        requestAnimationFrame(() => Object.assign(img.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` }));
        setTimeout(resolve, ms);
      }));
    },
    /** Fades in the title card's tagline (its line is already laid out). */
    cardSub() {
      const sub = $('#card .sub'); sub.style.transform = 'translateY(12px)'; void sub.offsetWidth;
      sub.style.transition = 'all .8s cubic-bezier(.2,.9,.25,1) .15s'; sub.style.opacity = '1'; sub.style.transform = 'none';
    },
    scrim(on) { $('#scrim').classList.toggle('on', !!on); },
    term: {
      open(title) { const t = $('#term'); if (title) t.querySelector('.title').textContent = title; t.querySelector('pre').innerHTML = ''; t.classList.add('on'); },
      close() { $('#term').classList.remove('on'); },
      html(h) { const pre = $('#term pre'); pre.querySelector('.caret')?.remove(); pre.insertAdjacentHTML('beforeend', h); pre.scrollTop = pre.scrollHeight; },
      caret() { const pre = $('#term pre'); pre.querySelector('.caret')?.remove(); pre.insertAdjacentHTML('beforeend', '<span class="caret"></span>'); },
      async type(text, ms = 36) {
        const pre = $('#term pre');
        for (const ch of text) { pre.querySelector('.caret')?.remove(); pre.insertAdjacentText('beforeend', ch); api.term.caret(); await new Promise((r) => setTimeout(r, ms * (0.6 + Math.random() * 0.8))); }
      },
    },
    list: {
      open(title, rows) {
        const l = $('#list');
        l.innerHTML = `<h2>${title}</h2>` + rows.map(([text, hint]) => `<div class="row"><span class="box">${TICK}</span><span class="txt">${text}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`).join('');
        void l.offsetWidth; l.classList.add('on');
      },
      show(i) { document.querySelectorAll('#list .row')[i]?.classList.add('on'); },
      tick(i) { document.querySelectorAll('#list .row')[i]?.classList.add('done'); },
      close() { $('#list').classList.remove('on'); },
    },
  };
  window.__demo = api;
})();
