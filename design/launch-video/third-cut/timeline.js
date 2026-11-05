// The launch video's timeline. seek(t) poses every element for time t (seconds).
/* global document, window */
const A = 'assets/';
const FPS = 30;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = {
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: (p) => 1 - Math.pow(1 - p, 3),
  outQuint: (p) => 1 - Math.pow(1 - p, 5),
  in: (p) => p * p * p,
};
const ramp = (t, a, b, e = ease.inOut) => (t <= a ? 0 : t >= b ? 1 : e((t - a) / (b - a)));
// Piecewise keyframes [[t, value | [values]], …], eased between neighbours.
function kf(t, keys, e = ease.inOut) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) {
      const p = e((t - t0) / (t1 - t0));
      return Array.isArray(v0) ? v0.map((v, j) => lerp(v, v1[j], p)) : lerp(v0, v1, p);
    }
  }
  return keys[keys.length - 1][1];
}
const el = (tag, cls, parent, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  parent?.appendChild(n);
  return n;
};
const stage = document.getElementById('stage');
const pending = new Set();
const setSrc = (img, src) => { if (img.getAttribute('src') !== src) { img.src = src; pending.add(img); } };

// ── components ──────────────────────────────────────────────────────────────
function headline(parent, title, sub) {
  const h = el('div', 'headline', parent);
  const h1 = el('h1', '', h);
  const words = [];
  for (const part of title.split(/(\*[^*]+\*)/)) {
    if (!part) continue;
    const gold = part.startsWith('*');
    for (const w of part.replace(/\*/g, '').split(' ')) {
      if (!w) continue;
      const s = el('span', `word${gold ? ' gold' : ''}`, h1, w);
      words.push(s); h1.appendChild(document.createTextNode(' '));
    }
  }
  const p = sub ? el('p', '', h, sub) : null;
  return (lt) => {
    words.forEach((w, i) => {
      const q = ramp(lt, 0.05 + i * 0.055, 0.6 + i * 0.055, ease.outQuint);
      w.style.opacity = q; w.style.transform = `translateY(${(1 - q) * 28}px)`;
      w.style.filter = `blur(${(1 - q) * 6}px)`;
    });
    if (p) { const q = ramp(lt, 0.35, 0.95, ease.out); p.style.opacity = q; p.style.transform = `translateY(${(1 - q) * 14}px)`; }
  };
}

const CURSOR = `<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5v17.2l4.6-4.3 3 6.8 2.9-1.3-3-6.6h6.3z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

// A browser window showing 1440×900 screens with a camera (zoom z at focus fx, fy).
function browserWindow(parent, { screens, x = 260, y = 212, scale = 1400 / 1440 }) {
  const win = el('div', 'win', parent);
  const chrome = el('div', 'chrome', win, '<i></i><i></i><i></i>');
  const bar = el('div', 'url', chrome);
  const content = el('div', 'content', win);
  const imgs = {};
  for (const s of screens) {
    const img = el('img', 'screen', content);
    img.style.opacity = 0;
    if (!s.endsWith('/')) setSrc(img, A + s + (s.includes('.') ? '' : '.png'));
    imgs[s] = img;
  }
  const cursor = el('div', 'cursor', content, CURSOR);
  const ripple = el('div', 'ripple', content);
  let cam = { z: 1, tx: 0, ty: 0 };
  return {
    win, imgs,
    place(px = x, py = y, s = scale, opacity = 1, extra = '') {
      win.style.left = `${px}px`; win.style.top = `${py}px`; win.style.width = '1440px';
      win.style.transform = `scale(${s}) ${extra}`; win.style.opacity = opacity;
    },
    url(text) { bar.innerHTML = text; },
    show(weights) { for (const [k, img] of Object.entries(imgs)) img.style.opacity = weights[k] ?? 0; },
    seq(key, dir, frame) { setSrc(imgs[key], `${A}${dir}/${String(frame).padStart(4, '0')}.jpg`); },
    camera(z, fx, fy) {
      const tx = clamp(720 - fx * z, 1440 - 1440 * z, 0);
      const ty = clamp(450 - fy * z, 900 - 900 * z, 0);
      cam = { z, tx, ty };
      for (const img of Object.values(imgs)) img.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    },
    // Cursor at content point (cx, cy); press 0..1 shrinks it; ripple p 0..1.
    pointer(cx, cy, visible = 1, press = 0) {
      const sx = cx * cam.z + cam.tx, sy = cy * cam.z + cam.ty;
      cursor.style.left = `${sx}px`; cursor.style.top = `${sy}px`; cursor.style.opacity = visible;
      cursor.style.transform = `scale(${1 - press * 0.18})`;
    },
    click(cx, cy, p) {
      const sx = cx * cam.z + cam.tx, sy = cy * cam.z + cam.ty;
      ripple.style.left = `${sx}px`; ripple.style.top = `${sy}px`;
      ripple.style.opacity = p > 0 && p < 1 ? 1 - p : 0; ripple.style.transform = `scale(${0.4 + p * 1.2})`;
    },
  };
}
// Pointer motion: keys [[t, x, y]], clicks [t…] (ripple 0.45 s, press dip 0.15 s).
function pointerAt(w, lt, keys, clicks = [], visible = 1) {
  const [x, y] = kf(lt, keys.map(([t, x, y]) => [t, [x, y]]));
  let press = 0, rip = -1, rx = x, ry = y;
  for (const c of clicks) {
    const d = lt - c;
    if (d > -0.12 && d < 0.18) press = Math.max(press, 1 - Math.abs(d - 0.03) / 0.15);
    if (d >= 0 && d < 0.45) { rip = d / 0.45; [rx, ry] = kf(c, keys.map(([t, x, y]) => [t, [x, y]])); }
  }
  w.pointer(x, y, visible, clamp(press, 0, 1));
  w.click(rx, ry, rip);
}

// ── third cut: what the capture recorded (boxes to aim at, the CLI's real output) ──
const getJSON = (u) => { try { const x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); return JSON.parse(x.responseText); } catch { return {}; } };
const SHOTS = getJSON(A + 'v3-shots.json');
const CLI = getJSON(A + 'cli.json');
const bx = (shot, key) => SHOTS[shot]?.boxes?.[key] ?? null;
/** Camera [z, fx, fy] aimed at a box: its centre, or for a big box its top-left part. */
const at = (shot, key, z, dx = 0, dy = 0) => {
  const b = bx(shot, key);
  if (!b) return [z, 720, 450];
  return [z, b.x + Math.min(b.w / 2, 0.42 * 1440 / z) + dx, b.y + Math.min(b.h / 2, 0.36 * 900 / z) + dy];
};
const mid = (shot, key, fallback = [720, 450]) => { const b = bx(shot, key); return b ? [b.x + b.w / 2, b.y + b.h / 2] : fallback; };
const seqFrames = (name) => SHOTS[name]?.frames ?? 1;

/** A headline whose last phrase swaps: prefix stays, each variant {at, text, sub} takes its place. */
function swapHeadline(parent, prefix, variants) {
  const h = el('div', 'headline swap', parent);
  const h1 = el('h1', '', h);
  const pre = el('span', 'pre', h1);
  const preWords = prefix.split(' ').map((w, i, all) => { const s = el('span', 'word', pre, w); if (i < all.length - 1) pre.appendChild(document.createTextNode(' ')); return s; });
  const boxEl = el('span', 'swapbox', h1);
  const vs = variants.map((v) => {
    const s = el('span', 'variant', boxEl);
    const words = v.text.split(' ').map((w, i, all) => { const x = el('span', 'word gold', s, w); if (i < all.length - 1) s.appendChild(document.createTextNode(' ')); return x; });
    const p = el('p', 'alt', h, v.sub || '');
    return { ...v, s, words, p };
  });
  let widths = null;
  return (lt) => {
    if (!widths) widths = vs.map((v) => v.s.getBoundingClientRect().width);
    preWords.forEach((w, i) => {
      const q = ramp(lt, 0.05 + i * 0.055, 0.6 + i * 0.055, ease.outQuint);
      w.style.opacity = q; w.style.transform = `translateY(${(1 - q) * 28}px)`; w.style.filter = `blur(${(1 - q) * 6}px)`;
    });
    let i = 0; vs.forEach((v, j) => { if (lt >= v.at) i = j; });
    const delay = i === 0 ? preWords.length * 0.055 : 0;
    vs.forEach((v, j) => {
      let o = 0, dy = 0, bl = 0;
      v.words.forEach((w, k) => {
        if (j === i) { const q = ramp(lt, v.at + delay + 0.05 + k * 0.055, v.at + delay + 0.6 + k * 0.055, ease.outQuint); o = q; dy = (1 - q) * 28; bl = (1 - q) * 6; }
        else if (j === i - 1) { const q = ramp(lt, vs[i].at - 0.28, vs[i].at, ease.in); o = 1 - q; dy = -q * 22; bl = q * 6; }
        else { o = 0; }
        w.style.opacity = o; w.style.transform = `translateY(${dy}px)`; w.style.filter = `blur(${bl}px)`;
      });
      const sq = j === i ? ramp(lt, v.at + 0.3, v.at + 0.85, ease.out) : j === i - 1 ? 1 - ramp(lt, vs[i].at - 0.28, vs[i].at) : 0;
      v.p.style.opacity = sq; v.p.style.transform = `translateY(${(1 - sq) * (j === i ? 12 : -8)}px)`;
    });
    const wv = i === 0 ? widths[0] : lerp(widths[i - 1], widths[i], ramp(lt, vs[i].at - 0.15, vs[i].at + 0.45, ease.inOut));
    boxEl.style.width = `${wv}px`;
  };
}

/** A terminal: entries [{cwd, cmd, out}] typed one after another from `t0`, `cps` characters a second. */
function terminal(parent, title) {
  const t = el('div', 'term', parent);
  el('div', 'tbar', t, `<i></i><i></i><i></i><span>${title}</span>`);
  const pre = el('pre', '', t);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return {
    t,
    render(lt, entries, { t0 = 0, cps = 38, gap = 0.45 } = {}) {
      let html = '', at = t0;
      for (const e of entries) {
        if (lt < at) break;
        const n = Math.min(e.cmd.length, Math.floor((lt - at) * cps));
        html += `<span class="p">${esc(e.cwd)}</span> <span class="dim">$</span> ${esc(e.cmd.slice(0, n))}`;
        at += e.cmd.length / cps + 0.25;
        if (n < e.cmd.length || lt < at) { html += '<span class="caret"></span>'; break; }
        const out = e.out.split('\n').map((l) => (/^(Cloned|Pushed|Pulled|✓)/.test(l) ? `<span class="ok">${esc(l)}</span>` : esc(l))).join('\n');
        html += `\n${out}${out ? '\n' : ''}`;
        at += gap;
        if (lt < at) { html += '<span class="caret"></span>'; break; }
      }
      pre.innerHTML = html;
      pre.scrollTop = pre.scrollHeight;
    },
  };
}

/** The opening card: the mark and name, then the tagline and the address. At lt = 0 it is
 *  also the film's last frame (the delivered video, zoomed into), so the film loops. */
function titleCard(L) {
  L.classList.add('introcard');
  const mark = el('img', 'mark', L); setSrc(mark, A + 'brand/icon-512.png'); mark.style.top = '268px';
  const glow = el('div', 'glow', L);
  const name = el('div', 'wordmark', L, 'tavya'); name.style.top = '466px';
  const tag = el('div', 'tagline', L, 'The agentic to-do list that <span class="gold">completes itself.</span>'); tag.style.top = '628px';
  const cta = el('div', 'cta', L, 'tavya.io'); cta.style.top = '736px';
  return (lt) => {
    glow.style.opacity = 0.9;
    const g = ramp(lt, 0.35, 1.05, ease.out); tag.style.opacity = g; tag.style.transform = `translateY(${(1 - g) * 16}px)`;
    const c = ramp(lt, 0.9, 1.5, ease.outQuint); cta.style.opacity = c; cta.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * c})`;
  };
}

// ── scenes ──────────────────────────────────────────────────────────────────
const scenes = [];
function scene(start, end, build, { fadeIn = 0.35, fadeOut = 0.35 } = {}) {
  const layer = el('div', 'layer', stage);
  const update = build(layer, end - start);
  scenes.push({ start, end, layer, update, fadeIn, fadeOut });
}
const host = (path) => `<b>tavya.io</b>${path}`;
const enter = (w, lt, dur, from = 60) => {
  const q = ramp(lt, 0.1, 0.85, ease.outQuint);
  const out = ramp(lt, dur - 0.35, dur, ease.in);
  w.place(260, 212 + (1 - q) * from + out * 20, (1400 / 1440) * (0.97 + 0.03 * q), q * (1 - out),
    `perspective(2400px) rotateX(${(1 - q) * 8}deg)`);
};
let T = 0;
const next = (d) => { const a = T; T += d; return [a, T]; };
/** Shows one screen of `list` per time window [[t, screen], …], crossfading over `x` seconds. */
const showAt = (w, lt, list, x = 0.22) => {
  const weights = {};
  list.forEach(([t, s], i) => {
    const nextT = list[i + 1]?.[0] ?? Infinity;
    weights[s] = Math.max(weights[s] ?? 0, ramp(lt, t - x, t) * (1 - ramp(lt, nextT - x, nextT)) + (i === 0 && lt < t ? 1 : 0));
  });
  w.show(weights);
};

// 0 · The title card (also the end of the loop).
scene(...next(3.4), (L) => { L.id = 'intro'; return titleCard(L); }, { fadeIn: 0 });

// 1 · One list.
scene(...next(4.4), (L, dur) => {
  const h = headline(L, 'Every project. *One list.*', 'Code, research papers, grocery shopping, your CV.');
  const w = browserWindow(L, { screens: ['home'] }); w.url(host('/personal'));
  w.show({ home: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.6, [1, 720, 450]], [dur, at('home', 'first', 1.3)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1100, 860], [1.4, 900, 600], [dur, ...mid('home', 'first')]], [], ramp(lt, 0.8, 1.2));
  };
});

// 2 · Say what needs doing: the CV, typed; the model picker.
scene(...next(6.0), (L, dur) => {
  const N = seqFrames('cv-type');
  const h = headline(L, 'Say what needs doing.', 'In plain words. Pick the agent and model, or keep your defaults.');
  const w = browserWindow(L, { screens: ['cv-type/', 'cv-models'] }); w.url(host('/personal/personal-website'));
  const field = mid('cv-models', 'field', [640, 480]);
  return (lt) => {
    h(lt); enter(w, lt, dur);
    w.seq('cv-type/', 'cv-type', Math.round(ramp(lt, 0.9, 3.3, (p) => p) * (N - 1)));
    const m = ramp(lt, 3.9, 4.1) * (1 - ramp(lt, 5.1, 5.3));
    w.show({ 'cv-type/': 1 - m, 'cv-models': m });
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [1.0, at('cv-type', 'prompt', 1.6)], [3.4, at('cv-type', 'prompt', 1.6)], [4.0, [1.3, field[0], field[1] + 120]], [5.1, [1.3, field[0], field[1] + 120]], [5.8, [1.15, 1000, 700]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 600], [0.6, 600, 230], [3.4, 640, 330], [3.8, field[0] - 200, field[1]], [4.9, field[0] - 200, field[1]], [5.6, 1290, 868], [dur, 1290, 868]], [3.85, 5.65], ramp(lt, 0.3, 0.6));
  };
});

// 3 · The agent works, on its own computer — a real run, replayed.
const WORK = Array.from({ length: 11 }, (_, i) => `work-${String(i).padStart(2, '0')}`);
scene(...next(5.0), (L, dur) => {
  const h = headline(L, 'Agents work on *their own computers.*', 'Your repos, a terminal, a browser — in parallel, while you do something else.');
  const w = browserWindow(L, { screens: WORK }); w.url(host('/personal/personal-website/tasks/5'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const p = ramp(lt, 0.5, dur - 0.5, (q) => q) * (WORK.length - 1);
    const i = Math.floor(p), f = clamp((p - i) * 4, 0, 1);
    const weights = {}; weights[WORK[i]] = 1; if (WORK[i + 1]) weights[WORK[i + 1]] = f;
    w.show(weights);
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.6, [1.38, 640, 460]], [dur, [1.45, 660, 480]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 4 · Accounts, keys and a card.
scene(...next(4.0), (L, dur) => {
  const h = headline(L, 'Give agents *accounts, keys and a card.*', 'They sign up, sign in and pay — only with what you allow.');
  const w = browserWindow(L, { screens: ['vault'] }); w.url(host('/personal/settings#settings-payments'));
  w.show({ vault: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [2.0, [1.45, 600, 330]], [dur, [1.45, 760, 600]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 700], [1.6, 560, 410], [3.0, 1120, 410], [dur, 1120, 520]], [], ramp(lt, 1.0, 1.4));
  };
});

// 5 · …so it can [buy a website] [ship an app] [order groceries].
scene(...next(14.0), (L, dur) => {
  const h = swapHeadline(L, '…so it can', [
    { at: 0, text: 'buy you a website, and deploy to it.', sub: 'A domain on its $25 budget, a login saved to the vault, a deploy on every push.' },
    { at: 4.6, text: 'put your app on Google Play, and stay on top of it.', sub: 'It asks for each account as it needs it. You approve with a click.' },
    { at: 9.6, text: 'order your groceries.', sub: 'Your login, your card, your budget. It never sees the password.' },
  ]);
  const w = browserWindow(L, { screens: ['domain-work', 'domain-done', 'play-ask', 'play-gmail', 'play-done', 'grocery-ask', 'grocery-done'] });
  const ap = mid('play-ask', 'approve'), al = mid('play-gmail', 'allow'), ag = mid('grocery-ask', 'approve');
  return (lt) => {
    h(lt); enter(w, lt, dur);
    showAt(w, lt, [[0, 'domain-work'], [1.9, 'domain-done'], [4.6, 'play-ask'], [6.55, 'play-gmail'], [7.9, 'play-done'], [9.6, 'grocery-ask'], [11.3, 'grocery-done']]);
    w.url(host(lt < 4.6 ? '/personal/tavya/tasks/815' : lt < 9.6 ? '/personal/tavya/tasks/816' : '/personal/admin_docs/tasks/4'));
    const [z, fx, fy] = kf(lt, [
      [0.3, [1, 720, 450]], [1.6, at('domain-work', 'body', 1.3)], [1.9, at('domain-work', 'body', 1.3)], [2.6, at('domain-done', 'msg', 1.45)], [4.3, at('domain-done', 'msg', 1.45, 0, 60)],
      [4.6, [1, 720, 450]], [5.3, at('play-ask', 'msg', 1.35)], [6.0, [1.2, ap[0], ap[1] - 60]], [6.5, [1.2, ap[0], ap[1] - 60]], [6.9, [1.25, al[0], al[1] - 80]], [7.6, [1.25, al[0], al[1] - 80]], [8.4, at('play-done', 'msg', 1.4)], [9.4, at('play-done', 'msg', 1.4, 0, 40)],
      [9.6, [1, 720, 450]], [10.3, at('grocery-ask', 'msg', 1.35)], [10.7, [1.2, ag[0], ag[1] - 60]], [11.2, [1.2, ag[0], ag[1] - 60]], [11.9, at('grocery-done', 'msg', 1.45)], [dur, at('grocery-done', 'msg', 1.45, 0, 30)],
    ]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1100, 760], [5.6, 1000, 700], [6.2, ...ap], [6.6, ...ap], [7.3, ...al], [7.8, al[0] + 60, al[1] + 120], [10.4, 1000, 700], [10.9, ...ag], [11.4, ag[0] + 50, ag[1] + 100], [dur, ag[0] + 50, ag[1] + 100]],
      [6.35, 7.4, 11.0], ramp(lt, 5.3, 5.6) * (1 - ramp(lt, 8.0, 8.3)) + ramp(lt, 10.2, 10.5) * (1 - ramp(lt, 11.6, 11.9)));
  };
});

// 6 · Big jobs fan out into sub-tasks.
scene(...next(4.0), (L, dur) => {
  const h = headline(L, 'Big jobs *fan out.*', 'One codebase review became 25 sub-tasks, each with its own agent.');
  const w = browserWindow(L, { screens: ['subtasks'] }); w.url(host('/personal/tavya/tasks/367'));
  w.show({ subtasks: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [2.0, [1.5, 1290, 300]], [dur, [1.5, 1290, 560]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 7 · Review the result: open what the agent attached, then Confirm.
scene(...next(7.0), (L, dur) => {
  const h = headline(L, 'Review the *result,* not the process.', 'Agents attach screenshots, reports and commands to check. You approve; it lands.');
  const w = browserWindow(L, { screens: ['review', 'review-viewer', 'review-done'] }); w.url(host('/personal/personal-website/tasks/5'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const viewer = ramp(lt, 2.0, 2.25) * (1 - ramp(lt, 4.0, 4.2));
    const done = ramp(lt, 5.5, 5.75);
    w.show({ review: 1 - done, 'review-viewer': viewer * (1 - done), 'review-done': done });
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [1.4, [1.3, 640, 480]], [2.1, [1.3, 640, 480]], [2.6, [1.05, 720, 380]], [4.0, [1.05, 720, 380]], [4.5, [1.3, 600, 640]], [5.6, [1.3, 600, 640]], [6.3, [1.6, 1260, 60]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1000, 700], [1.0, 600, 560], [1.75, 494, 452], [2.1, 494, 452], [2.6, 1100, 300], [3.8, 1360, 50], [4.3, 700, 760], [5.1, 455, 868], [dur, 455, 868]], [1.9, 3.95, 5.4], ramp(lt, 0.6, 0.9) * (1 - ramp(lt, 5.9, 6.2)));
  };
});

// 8 · The autonomous company.
scene(...next(14.0), (L, dur) => {
  const h = swapHeadline(L, 'The autonomous company:', [
    { at: 0, text: 'let AI agents review tasks.', sub: 'Hand Review to an agent, with your instructions. It checks, then it lands.' },
    { at: 4.8, text: 'agents can create and manage tasks.', sub: 'tavya agents can manage tavya through MCP.' },
    { at: 9.0, text: 'work that starts itself.', sub: 'Tasks can have dependencies, schedules or be triggered by webhooks and events.' },
  ]);
  const w = browserWindow(L, { screens: ['ai-route', 'ai-reviewed', 'mcp-trigger', 'series', 'store'] });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    showAt(w, lt, [[0, 'ai-route'], [2.4, 'ai-reviewed'], [4.8, 'mcp-trigger'], [9.0, 'series'], [11.6, 'store']]);
    w.url(host(lt < 2.4 ? '/personal/tavya/tasks/817/parameters' : lt < 4.8 ? '/personal/tavya/tasks/817' : lt < 9.0 ? '/personal/tavya/tasks/818' : lt < 11.6 ? '/personal/tavya?q=is:series' : '/personal/tavya?q=is:store'));
    const [z, fx, fy] = kf(lt, [
      [0.3, [1, 720, 450]], [1.4, at('ai-route', 'row', 1.4)], [2.3, at('ai-route', 'row', 1.4)], [3.0, at('ai-reviewed', 'msg', 1.45)], [4.6, at('ai-reviewed', 'msg', 1.45, 0, 50)],
      [4.8, [1, 720, 450]], [5.8, at('mcp-trigger', 'msg', 1.4)], [8.8, at('mcp-trigger', 'msg', 1.4, 0, 120)],
      [9.0, [1, 720, 450]], [10.0, at('series', 'list', 1.45)], [11.4, at('series', 'list', 1.45, 0, 40)], [11.6, [1, 720, 450]], [12.5, at('store', 'first', 1.35)], [dur, at('store', 'first', 1.35, 0, 30)],
    ]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 9 · Not just code: what agents made in research projects.
scene(...next(4.6), (L, dur) => {
  const h = headline(L, 'Not just code.', 'Experiments, figures, papers, websites — from the same list.');
  const w = browserWindow(L, { screens: ['made-legibench', 'made-lvpm'] });
  const pages = [el('div', 'page', L), el('div', 'page', L)];
  ['made-paper-pdf-01', 'made-paper-pdf-02'].forEach((n, i) => setSrc(el('img', '', pages[i]), `${A}${n}.png`));
  const tag = el('div', 'tag', L);
  return (lt) => {
    h(lt);
    const a = ramp(lt, 1.5, 1.75);
    enter(w, lt, 3.1 + 0.35);
    w.show({ 'made-legibench': 1 - a, 'made-lvpm': a });
    w.url(host(lt < 1.6 ? '/personal/legibench3/tasks/19' : '/personal/lvpm/tasks/8'));
    w.camera(kf(lt, [[0.2, 1], [1.5, 1.12], [1.6, 1], [3.0, 1.12]]), 760, 420);
    w.pointer(0, 0, 0);
    pages.forEach((p, i) => {
      const q = ramp(lt, 2.9 + i * 0.15, 3.6 + i * 0.15, ease.outQuint);
      p.style.width = '520px'; p.style.left = `${700 + i * 300 - 120}px`; p.style.top = `${300 + (1 - q) * 80}px`;
      p.style.opacity = q * (1 - ramp(lt, dur - 0.3, dur)); p.style.transform = `rotate(${(i ? 5 : -4) * q}deg)`;
    });
    tag.innerHTML = lt < 1.6 ? 'legibench3<small>Human study: which models explain best</small>' : lt < 3.0 ? 'lvpm<small>Oversight study, nine figures</small>' : 'legibench3<small>The paper, co-written with Claude</small>';
    tag.style.left = '300px'; tag.style.top = '990px'; tag.style.opacity = ramp(lt, 0.6, 1.0) * (1 - ramp(lt, dur - 0.3, dur));
  };
});

// 10 · Dump all your files in: photos from a laptop, sorted, and back.
scene(...next(8.4), (L, dur) => {
  const h = headline(L, 'Dump all *your files* in…', 'Photos, documents, notes: pushed from your laptop, sorted by an agent, pulled back.');
  const w = browserWindow(L, { screens: ['photos-review', 'albums'] });
  w.url(host('/personal/random/tasks/2'));
  const term = terminal(L, 'abhimanyu — ~/random');
  const push = CLI.slice(0, 3), pull = CLI.slice(3, 4);
  const CPS = 75, GAP = 0.18;
  const pushDur = push.reduce((a, e) => a + e.cmd.length / CPS + 0.25 + GAP, 0);
  const tile = mid('photos-review', 'tile');
  return (lt) => {
    h(lt);
    const tq = ramp(lt, 0.15, 0.6, ease.outQuint) * (1 - ramp(lt, 3.9, 4.2)) + ramp(lt, 6.7, 7.0, ease.outQuint);
    term.t.style.opacity = tq; term.t.style.transform = `translate(-50%, ${(1 - tq) * 30}px) scale(${0.97 + 0.03 * tq})`;
    term.render(lt, lt < 6.6 ? push : [...push, ...pull], { t0: lt < 6.6 ? 0.4 : 6.9 - pushDur, cps: CPS, gap: GAP });
    const wq = ramp(lt, 4.0, 4.6, ease.outQuint) * (1 - ramp(lt, 6.5, 6.8));
    w.place(260, 212 + (1 - wq) * 60, (1400 / 1440) * (0.97 + 0.03 * wq), wq, `perspective(2400px) rotateX(${(1 - wq) * 8}deg)`);
    showAt(w, lt, [[0, 'photos-review'], [5.1, 'albums']]);
    const [z, fx, fy] = kf(lt, [[4.1, [1.25, tile[0], tile[1]]], [5.0, [1.25, tile[0], tile[1]]], [5.3, [1.05, 720, 420]], [dur, [1.12, 720, 420]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[4.1, tile[0] + 140, tile[1] + 120], [4.8, ...tile], [dur, tile[0] + 300, tile[1] + 200]], [4.9], ramp(lt, 4.3, 4.6) * (1 - ramp(lt, 5.2, 5.4)));
  };
});

// 11 · …and let it run your life.
scene(...next(5.2), (L, dur) => {
  const h = headline(L, '…and let it *run your life.*', 'It reads your documents, uses your logins and pays, with your OK.');
  const w = browserWindow(L, { screens: ['flight-ask', 'flight-booked'] }); w.url(host('/personal/admin_docs/tasks/5'));
  const ap = mid('flight-ask', 'approve');
  return (lt) => {
    h(lt); enter(w, lt, dur);
    showAt(w, lt, [[0, 'flight-ask'], [2.4, 'flight-booked']]);
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.1, at('flight-ask', 'msg', 1.35)], [1.6, [1.2, ap[0], ap[1] - 60]], [2.3, [1.2, ap[0], ap[1] - 60]], [3.0, at('flight-booked', 'msg', 1.45)], [dur, at('flight-booked', 'msg', 1.45, 0, 50)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1000, 700], [1.3, 1000, 700], [1.9, ...ap], [2.4, ap[0] + 60, ap[1] + 110], [dur, ap[0] + 60, ap[1] + 110]], [2.05], ramp(lt, 1.1, 1.4) * (1 - ramp(lt, 2.6, 2.9)));
  };
});

// 12 · Any model, your subscription.
scene(...next(4.0), (L, dur) => {
  const h = headline(L, 'Any model. *Your subscription.*', 'Claude, Codex or OpenCode — on your Claude or ChatGPT plan, or an API key.');
  const w = browserWindow(L, { screens: ['cv-models', 'models-compare'] }); w.url(host('/personal/personal-website'));
  const field = mid('cv-models', 'field', [640, 480]);
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const b = ramp(lt, 1.9, 2.15);
    w.show({ 'cv-models': 1 - b, 'models-compare': b });
    const [z, fx, fy] = lt < 2.0 ? kf(lt, [[0.3, [1, 720, 450]], [1.9, [1.5, field[0] - 120, field[1] + 130]]]) : kf(lt, [[2.0, [1.15, 720, 450]], [dur, [1.32, 720, 440]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 13 · In your pocket.
scene(...next(3.6), (L) => {
  const h = headline(L, 'In your pocket, too.', null);
  const phones = ['mobile-home', 'mobile-task'].map((n) => { const p = el('div', 'phone', L); setSrc(el('img', '', p), `${A}${n}.png`); return p; });
  const chips = el('div', 'chips', L);
  const items = ['Project wiki & skills', 'Teams & Avatārs', 'Live previews', 'Your own cloud accounts', 'Insights'];
  const nodes = items.map((t) => el('span', 'chip', chips, t));
  return (lt) => {
    h(lt);
    phones.forEach((p, i) => {
      const q = ramp(lt, 0.2 + i * 0.15, 1.0 + i * 0.15, ease.outQuint);
      p.style.left = `${960 - 430 + i * 460}px`; p.style.top = `${190 + (1 - q) * 120 + (i ? 30 : 0)}px`;
      p.style.transform = `scale(.86) rotate(${(i ? 3 : -3) * q}deg)`; p.style.transformOrigin = '50% 0'; p.style.opacity = q;
    });
    chips.style.top = '960px';
    nodes.forEach((n, i) => { const q = ramp(lt, 0.9 + i * 0.12, 1.4 + i * 0.12, ease.outQuint); n.style.opacity = q; n.style.transform = `translateY(${(1 - q) * 16}px)`; });
  };
});

// 14 · Your turn: a new project, and its first task.
scene(...next(8.0), (L, dur) => {
  const NP = seqFrames('ending-project'), NT = seqFrames('ending-task');
  const h = headline(L, 'Your *turn.*', 'A new project, one sentence, and an agent on it.');
  const w = browserWindow(L, { screens: ['ending-home', 'ending-project/', 'ending-empty', 'ending-task/', 'ending-started'] });
  const add = mid('ending-home', 'add', [300, 260]), create = mid('ending-project', 'create', [900, 600]), newTask = mid('ending-empty', 'add', [720, 120]);
  return (lt) => {
    h(lt); enter(w, lt, dur);
    w.seq('ending-project/', 'ending-project', Math.round(ramp(lt, 1.35, 2.25, (p) => p) * (NP - 1)));
    w.seq('ending-task/', 'ending-task', Math.round(ramp(lt, 3.85, 5.05, (p) => p) * (NT - 1)));
    showAt(w, lt, [[0, 'ending-home'], [1.2, 'ending-project/'], [2.95, 'ending-empty'], [3.7, 'ending-task/'], [5.55, 'ending-started']], 0.18);
    w.url(host(lt < 2.95 ? '/personal' : lt < 5.55 ? '/personal/big-idea' : '/personal/big-idea/tasks/1'));
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.0, [1.35, add[0] + 160, add[1] + 90]], [1.2, [1.25, 720, 420]], [2.4, [1.35, ...mid('ending-project', 'name', [720, 400])]], [2.9, [1.25, 720, 420]],
      [3.2, [1, 720, 450]], [3.9, at('ending-task', 'prompt', 1.6)], [5.2, at('ending-task', 'prompt', 1.6)], [5.6, [1, 720, 450]], [6.4, at('ending-started', 'msg', 1.45)], [dur, at('ending-started', 'msg', 1.5)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 600], [0.8, ...add], [1.1, ...add], [2.3, create[0] + 80, create[1] + 60], [2.65, ...create], [3.0, create[0], create[1]], [3.4, ...newTask], [3.7, ...newTask], [5.6, newTask[0] + 120, newTask[1] + 200], [dur, newTask[0] + 120, newTask[1] + 200]],
      [0.95, 2.75, 3.55], ramp(lt, 0.4, 0.7) * (1 - ramp(lt, 3.8, 4.1)));
  };
});

// 15 · The end card.
scene(...next(4.4), (L) => {
  L.id = 'end';
  const update = titleCard(L);
  const note = el('div', 'tagline', L, 'Open to everyone, starting today.'); note.style.top = '850px'; note.style.fontSize = '26px';
  return (lt) => { update(lt); note.style.opacity = ramp(lt, 1.5, 2.1); };
}, { fadeOut: 0.6 });

const DURATION = T;
async function seek(t) {
  for (const s of scenes) {
    const on = t >= s.start - 0.001 && t < s.end + (s === scenes[scenes.length - 1] ? 1 : 0);
    if (!on) { s.layer.style.opacity = 0; s.layer.style.display = 'none'; continue; }
    s.layer.style.display = 'block';
    const dur = s.end - s.start, lt = Math.min(t - s.start, dur);
    const fin = s.fadeIn ? ramp(lt, 0, s.fadeIn, (p) => p) : 1, fout = s.fadeOut ? 1 - ramp(lt, dur - s.fadeOut, dur, (p) => p) : 1;
    s.layer.style.opacity = Math.min(fin, fout);
    s.update(lt, dur);
  }
  const waits = [...pending].map((img) => img.decode().catch(() => {}));
  pending.clear();
  await Promise.all(waits);
}
window.seek = seek;
window.DURATION = DURATION;
window.FPS = FPS;
window.SCENES = scenes.map((s) => [s.start, s.end]);
window.CLICKS = [];
