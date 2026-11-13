// The final cut's timeline (the first cut's look, every screen captured fresh by
// capture.cjs). seek(t) poses every element for time t (seconds).
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
const SHOTS = getJSON(A + 'shots.json');
const bx = (shot, key) => SHOTS[shot]?.boxes?.[key] ?? null;
/** Camera [z, fx, fy] aimed at a box: its centre, or for a big box its top-left part. */
const at = (shot, key, z, dx = 0, dy = 0) => {
  const b = bx(shot, key);
  if (!b) return [z, 720, 450];
  return [z, b.x + Math.min(b.w / 2, 0.42 * 1440 / z) + dx, b.y + Math.min(b.h / 2, 0.36 * 900 / z) + dy];
};
const mid = (shot, key, fallback = [720, 450]) => { const b = bx(shot, key); return b ? [b.x + b.w / 2, b.y + b.h / 2] : fallback; };
const seqFrames = (name) => SHOTS[name]?.frames ?? 1;

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


// ── this cut's parts ───────────────────────────────────────────────────────────
/** Pills under a headline, each popping in at its own moment ([text, at]), with a brief glow. */
function pills(parent, items, top = 128) {
  const row = el('div', 'pills', parent); row.style.top = `${top}px`;
  const nodes = items.map(([text]) => el('span', 'pill', row, text));
  return (lt) => nodes.forEach((n, i) => {
    const t0 = items[i][1];
    const q = ramp(lt, t0, t0 + 0.45, ease.outQuint);
    n.style.opacity = q;
    n.style.transform = `translateY(${(1 - q) * 18}px) scale(${0.86 + 0.14 * q})`;
    n.style.filter = `blur(${(1 - q) * 6}px)`;
    const glow = Math.max(0, 1 - Math.abs(lt - t0 - 0.35) / 0.45);
    n.style.boxShadow = `0 0 ${28 * glow}px rgba(240,191,85,${0.45 * glow}), inset 0 0 0 1px rgba(240,191,85,${0.25 + 0.5 * glow})`;
  });
}
/** A prominent line under the headline that swaps: variants [{at, text}], words arriving one by one. */
function lead(parent, variants, top = 126) {
  const box = el('div', 'lead', parent); box.style.top = `${top}px`;
  const vs = variants.map((v) => {
    const line = el('div', 'lead-line', box);
    // *…* marks the gold phrase, which may span words.
    const words = [];
    for (const part of v.text.split(/(\*[^*]+\*)/)) {
      if (!part) continue;
      const gold = part.startsWith('*');
      for (const w of part.replace(/\*/g, '').split(' ')) {
        if (!w) continue;
        words.push(el('span', `word${gold ? ' gold' : ''}`, line, w)); line.appendChild(document.createTextNode(' '));
      }
    }
    return { ...v, line, words };
  });
  return (lt) => {
    let i = 0; vs.forEach((v, j) => { if (lt >= v.at) i = j; });
    vs.forEach((v, j) => {
      const out = j < i ? ramp(lt, vs[i].at - 0.3, vs[i].at, ease.in) : 0;
      v.line.style.opacity = j > i ? 0 : 1 - out;
      v.line.style.transform = `translateY(${-out * 20}px)`;
      v.line.style.filter = `blur(${out * 6}px)`;
      v.words.forEach((w, k) => {
        const q = j === i ? ramp(lt, v.at + 0.15 + k * 0.06, v.at + 0.65 + k * 0.06, ease.outQuint) : j < i ? 1 : 0;
        w.style.opacity = q; w.style.transform = `translateY(${(1 - q) * 20}px)`; w.style.filter = `blur(${(1 - q) * 5}px)`;
      });
    });
  };
}
/** The title card: mark, name, line. `still` poses it settled (for the film's own first frame). */
function titleCard(L, tagline, still = false) {
  L.classList.add('introcard');
  const glow = el('div', 'glow', L);
  const mark = el('img', 'mark', L); setSrc(mark, A + 'brand/icon-512.png'); mark.style.top = '268px';
  const name = el('div', 'wordmark', L, 'tavya'); name.style.top = '466px';
  const tag = el('div', 'tagline', L, tagline); tag.style.top = '628px';
  return (lt) => {
    const at = still ? 9 : lt;
    const q = ramp(at, 0.1, 1.1, ease.outQuint);
    mark.style.transform = `scale(${0.55 + 0.45 * q}) rotate(${(1 - q) * -12}deg)`; mark.style.opacity = q;
    glow.style.opacity = ramp(at, 0.2, 1.4) * 0.9;
    const n = ramp(at, 0.7, 1.4, ease.outQuint); name.style.opacity = n; name.style.transform = `translateY(${(1 - n) * 30}px)`; name.style.letterSpacing = `${-0.045 + (1 - n) * 0.08}em`;
    const g = ramp(at, 1.35, 1.95, ease.out); tag.style.opacity = g; tag.style.transform = `translateY(${(1 - g) * 16}px)`;
  };
}
const TAGLINE = 'Do <span class="gold">anything</span> with agents.';

// 0 · Title card.
scene(...next(3.0), (L) => { L.id = 'intro'; return titleCard(L, TAGLINE); }, { fadeIn: 0.01 });

// 1 · Every project, one list: the kinds of work, one at a time.
scene(...next(5.2), (L, dur) => {
  const h = headline(L, 'Every project. *One list.*', null);
  const p = pills(L, [['Code, apps, websites', 0.55], ['Research', 1.0], ['Random admin work', 1.45]]);
  const w = browserWindow(L, { screens: ['home'] }); w.url(host('/personal'));
  w.show({ home: 1 });
  return (lt) => {
    h(lt); p(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.8, [1, 720, 450]], [dur, at('home', 'first', 1.3, 0, 120)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1100, 860], [1.6, 950, 650], [dur, ...mid('home', 'first')]], [], ramp(lt, 1.0, 1.4));
  };
});

// 2 · Say what needs doing: the homepage redesign, typed.
scene(...next(5.4), (L, dur) => {
  const N = seqFrames('say');
  const h = headline(L, 'Say what *needs doing.*', null);
  const w = browserWindow(L, { screens: ['say/'] }); w.url(host('/personal/personal-website'));
  w.show({ 'say/': 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    w.seq('say/', 'say', Math.round(ramp(lt, 0.8, 3.6, (p) => p) * (N - 1)));
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [0.9, at('say', 'prompt', 1.6)], [4.0, at('say', 'prompt', 1.6)], [dur, [1.2, 720, 420]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 600], [0.7, 640, 330], [dur, 640, 330]], [], ramp(lt, 0.3, 0.6) * (1 - ramp(lt, 1.0, 1.3)));
  };
});

// 3 · Its agent at work, on its own computer: the task's real run on tavya.io, replayed.
scene(...next(4.2), (L, dur) => {
  const N = seqFrames('work');
  const h = headline(L, 'Agents work on *their own computers.*', 'GitHub repos, large files and databases, project secrets, MCPs.');
  const w = browserWindow(L, { screens: ['work/'] }); w.url(host(SHOTS.work?.url || '/personal/personal-website/tasks/7'));
  w.show({ 'work/': 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    w.seq('work/', 'work', Math.round(ramp(lt, 0.3, dur - 0.4, (p) => p) * (N - 1)));
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.4, at('work', 'thread', 1.35, 0, 60)], [dur, at('work', 'thread', 1.42, 0, 90)]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 4 · Big jobs fan out.
scene(...next(4.6), (L, dur) => {
  const h = headline(L, 'Big jobs *fan out.*', 'Big tasks can spawn hundreds of sub-tasks with their own agents, all orchestrated by the parent agent.');
  const w = browserWindow(L, { screens: ['fanout'] }); w.url(host('/personal/tavya/tasks/367'));
  w.show({ fanout: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [1.8, at('fanout', 'panel', 1.5)], [dur, at('fanout', 'panel', 1.5, 0, 160)]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 5 · Accounts, keys and a card.
scene(...next(4.0), (L, dur) => {
  const h = headline(L, 'Give agents *accounts, keys and a card.*', 'They sign up, sign in and pay, only with what you allow.');
  const w = browserWindow(L, { screens: ['vault'] }); w.url(host('/personal/settings#settings-payments'));
  w.show({ vault: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [2.0, at('vault', 'dialog', 1.4)], [dur, at('vault', 'dialog', 1.4, 60, 120)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 700], [1.6, 700, 420], [dur, 980, 520]], [], ramp(lt, 1.0, 1.4));
  };
});

// 6 · Review the result: the video this task made, attached; then approve.
scene(...next(6.4), (L, dur) => {
  const h = headline(L, 'Review the *result,* and approve.', null);
  const ld = lead(L, [{ at: 0.45, text: '(or leave the review to an agent)' }]);
  const w = browserWindow(L, { screens: ['review', 'review-viewer', 'review-done'] }); w.url(host('/personal/tavya/tasks/820'));
  const tile = mid('review', 'tile'), confirm = mid('review', 'confirm'), close = mid('review-viewer', 'close', [1300, 70]);
  // The video in the viewer, on its first frame: this film's title card.
  const pic = bx('review-viewer', 'picture');
  const mini = el('div', 'mini', w.win.querySelector('.content'));
  el('div', 'bgfill', mini);
  titleCard(el('div', 'mini-card', mini), TAGLINE, true)(0);
  mini.style.zIndex = 3;
  return (lt) => {
    h(lt); ld(lt); enter(w, lt, dur);
    const viewer = ramp(lt, 1.55, 1.75) * (1 - ramp(lt, 3.55, 3.75));
    const done = ramp(lt, 4.55, 4.8);
    w.show({ review: 1 - done, 'review-viewer': viewer * (1 - done), 'review-done': done });
    if (pic) { mini.style.opacity = viewer * (1 - done); mini.style.transform = `translate(${pic.x}px, ${pic.y}px) scale(${pic.w / 1920})`; }
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.2, [1.3, tile[0] + 120, tile[1] - 40]], [1.6, [1, 720, 450]], [3.6, [1, 720, 450]], [4.1, [1.3, confirm[0] + 160, confirm[1] - 90]], [dur, [1.32, confirm[0] + 160, confirm[1] - 90]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1000, 700], [1.0, ...tile], [1.5, ...tile], [2.6, close[0] - 120, close[1] + 80], [3.4, ...close], [3.9, confirm[0] + 80, confirm[1] - 40], [4.4, ...confirm], [dur, confirm[0] + 30, confirm[1] + 30]], [1.45, 3.45, 4.45], ramp(lt, 0.5, 0.8));
  };
});

// 7 · The autonomous company: agents create, manage and approve; work starts itself.
scene(...next(13.2), (L, dur) => {
  const h = headline(L, 'Build the *autonomous company.*', null);
  const ld = lead(L, [{ at: 0.45, text: 'Agents can *create, manage and approve* tasks.' }, { at: 6.0, text: 'Tasks can *auto-run* on schedules, events or dependencies.' }]);
  const w = browserWindow(L, { screens: ['auto-project/', 'auto-review/', 'auto-created', 'auto-deps', 'auto-wiki', 'auto-dream'] });
  const toggle = mid('auto-project', 'toggle', [600, 600]), agent = mid('auto-review', 'agent', [600, 600]);
  return (lt) => {
    h(lt); ld(lt); enter(w, lt, dur);
    w.seq('auto-project/', 'auto-project', lt >= 1.9 ? 1 : 0);
    w.seq('auto-review/', 'auto-review', lt >= 4.5 ? 1 : 0);
    showAt(w, lt, [[0, 'auto-project/'], [3.1, 'auto-review/'], [6.0, 'auto-created'], [8.7, 'auto-deps'], [10.1, 'auto-wiki'], [11.5, 'auto-dream']], 0.18);
    w.url(host(lt < 3.1 ? '/personal' : lt < 6.0 ? '/personal/tavya' : lt < 8.7 ? '/personal/tavya/tasks/824' : '/personal/tavya?q=is:series'));
    const [z, fx, fy] = kf(lt, [
      [0.3, [1, 720, 450]], [1.2, [1.55, toggle[0] + 150, toggle[1] - 60]], [2.9, [1.55, toggle[0] + 150, toggle[1] - 60]],
      [3.1, [1, 720, 450]], [3.8, [1.5, agent[0] + 200, agent[1] + 40]], [5.8, [1.5, agent[0] + 200, agent[1] + 40]],
      [6.0, [1, 720, 450]], [6.8, at('auto-created', 'msg', 1.55)], [8.5, at('auto-created', 'msg', 1.55)],
      [8.7, at('auto-deps', 'head', 1.35)], [10.0, at('auto-deps', 'head', 1.38)], [10.1, at('auto-wiki', 'head', 1.35)], [11.4, at('auto-wiki', 'head', 1.38)],
      [11.5, at('auto-dream', 'head', 1.35)], [dur, at('auto-dream', 'head', 1.4)]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1000, 700], [1.4, toggle[0] + 60, toggle[1] + 40], [1.8, ...toggle], [2.6, toggle[0] + 40, toggle[1] + 30], [3.6, agent[0] + 80, agent[1] + 60], [4.4, ...agent], [5.6, agent[0] + 60, agent[1] + 40]], [1.85, 4.45], ramp(lt, 0.6, 0.9) * (1 - ramp(lt, 5.6, 5.9)));
  };
});

// 8 · Any model, your subscription.
scene(...next(3.6), (L, dur) => {
  const h = headline(L, 'Any model. *Your subscription.*', 'Claude, Codex or OpenCode, on your Claude or ChatGPT plan, or an API key.');
  const w = browserWindow(L, { screens: ['models'] }); w.url(host('/personal/tavya'));
  w.show({ models: 1 });
  const field = mid('models', 'field', [640, 480]);
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.8, [1.5, field[0] - 120, field[1] + 140]], [dur, [1.52, field[0] - 100, field[1] + 170]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 9 · Not just code: a paper, a website, an image, a film, a chore.
scene(...next(4.4), (L, dur) => {
  const h = headline(L, 'Not just *code.*', null);
  const p = pills(L, [['Papers.', 0.45], ['Websites.', 1.1], ['Images and video.', 1.75], ['Chores.', 2.4]]);
  const card = (cls, x, y, wpx, rot, t0, html) => {
    const c = el('div', `ex ${cls}`, L, html); c.style.left = `${x}px`; c.style.top = `${y}px`; c.style.width = `${wpx}px`;
    return (lt) => { const q = ramp(lt, t0, t0 + 0.6, ease.outQuint); c.style.opacity = q * (1 - ramp(lt, dur - 0.35, dur)); c.style.transform = `translateY(${(1 - q) * 70}px) rotate(${rot * q}deg) scale(${0.94 + 0.06 * q})`; };
  };
  const img = (src) => `<img src="${A}${src}">`;
  const parts = [
    card('page', 90, 300, 300, -5, 0.5, img('ex-paper-1.png')),
    card('page', 230, 330, 300, 3, 0.65, img('ex-paper-4.png')),
    card('browser', 610, 285, 540, -1.5, 1.15, `<div class="chrome"><i></i><i></i><i></i><div class="url"><b>tavya.io</b></div></div>${img('ex-website.png')}`),
    card('photo', 1230, 270, 590, 2, 1.8, img('ex-image.jpg')),
    card('player', 1250, 715, 540, -2, 2.1, `${img('ex-film.jpg')}<div class="bar"><span class="play"></span><span class="track"><i></i></span><b>0:59</b></div>`),
    card('chat', 640, 715, 540, 1.5, 2.45, img('ex-chore.png')),
  ];
  return (lt) => { h(lt); p(lt); parts.forEach((f) => f(lt)); };
});

// 10 · End card, with what people say.
const QUOTES = [
  ['Every man a CEO, and no one has a moat.', 'N.H.'],
  ['tavya is such an addictive toy man… it has replaced my evening PS-5 sessions for me.', 'D.A.'],
  ['I can really just do *anything* now.', 'R.S.'],
];
scene(...next(8.0), (L) => {
  L.id = 'end';
  const mark = el('img', 'mark', L); setSrc(mark, A + 'brand/icon-512.png'); mark.style.top = '96px'; mark.style.transformOrigin = '50% 50%';
  const name = el('div', 'wordmark', L, 'tavya'); name.style.top = '262px';
  const tag = el('div', 'tagline', L, 'Just do things.'); tag.style.top = '410px';
  const cta = el('div', 'cta', L, 'tavya.io'); cta.style.top = '492px';
  const quotes = QUOTES.map(([text, who], i) => {
    const q = el('figure', 'quote', L, `<blockquote>${text.replace(/\*([^*]+)\*/g, '<em>$1</em>')}</blockquote><figcaption>— ${who}</figcaption>`);
    q.style.left = `${120 + i * 572}px`; q.style.top = '640px';
    return q;
  });
  const note = el('div', 'tagline', L, 'Open to everyone, starting today.'); note.style.top = '960px'; note.style.fontSize = '26px';
  return (lt) => {
    const q = ramp(lt, 0.0, 0.9, ease.outQuint);
    mark.style.opacity = q; mark.style.transform = `scale(${(0.8 + 0.2 * q) * 0.8})`;
    const n = ramp(lt, 0.2, 0.9, ease.outQuint); name.style.opacity = n; name.style.transform = `translateY(${(1 - n) * 24}px)`;
    const g = ramp(lt, 0.5, 1.1, ease.out); tag.style.opacity = g;
    const c = ramp(lt, 0.8, 1.4, ease.outQuint); cta.style.opacity = c; cta.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * c})`;
    quotes.forEach((el2, i) => {
      const k = ramp(lt, 1.3 + i * 0.75, 1.9 + i * 0.75, ease.outQuint);
      el2.style.opacity = k; el2.style.transform = `translateY(${(1 - k) * 30}px)`; el2.style.filter = `blur(${(1 - k) * 5}px)`;
    });
    note.style.opacity = ramp(lt, 3.6, 4.2);
  };
}, { fadeOut: 0.6 });

const DURATION = T;
async function seek(t) {
  for (const s of scenes) {
    const on = t >= s.start - 0.001 && t < s.end;
    if (!on) { s.layer.style.opacity = 0; s.layer.style.display = 'none'; continue; }
    s.layer.style.display = 'block';
    const dur = s.end - s.start, lt = t - s.start;
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
// Cursor clicks (scene, offset) and the pills' arrivals: the score (../first-cut/music.py) ticks on each.
window.CLICKS = [[6, 1.45], [6, 3.45], [6, 4.45], [7, 1.85], [7, 4.45], [1, 0.55], [1, 1.0], [1, 1.45], [9, 0.45], [9, 1.1], [9, 1.75], [9, 2.4], [10, 1.3], [10, 2.05], [10, 2.8]]
  .map(([i, d]) => scenes[i].start + d).sort((a, b) => a - b);
