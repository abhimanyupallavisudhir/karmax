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

// ── scenes ──────────────────────────────────────────────────────────────────
const scenes = [];
// A scene owns a layer shown in [start, end) with fades; update(lt, dur) poses it.
function scene(start, end, build, { fadeIn = 0.35, fadeOut = 0.35 } = {}) {
  const layer = el('div', 'layer', stage);
  const update = build(layer, end - start);
  scenes.push({ start, end, layer, update, fadeIn, fadeOut });
}
const host = (path) => `<b>tavya.io</b>${path}`;
// Window entrance: rises and sharpens; exit: drops back slightly.
const enter = (w, lt, dur, from = 60) => {
  const q = ramp(lt, 0.1, 0.85, ease.outQuint);
  const out = ramp(lt, dur - 0.35, dur, ease.in);
  w.place(260, 212 + (1 - q) * from + out * 20, (1400 / 1440) * (0.97 + 0.03 * q), q * (1 - out),
    `perspective(2400px) rotateX(${(1 - q) * 8}deg)`);
};

let T = 0;
const next = (d) => { const a = T; T += d; return [a, T]; };

// 0 · Mark, name, tagline.
scene(...next(3.0), (L) => {
  L.id = 'intro';
  const mark = el('img', 'mark', L); setSrc(mark, A + 'brand/icon-512.png'); mark.style.top = '300px';
  const glow = el('div', '', L); Object.assign(glow.style, { position: 'absolute', left: '50%', top: '384px', width: '700px', height: '700px', margin: '-350px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(240,191,85,.28), transparent 65%)' });
  const name = el('div', 'wordmark', L, 'tavya'); name.style.top = '498px';
  const tag = el('div', 'tagline', L, 'The agentic to-do list that finishes itself.'); tag.style.top = '660px';
  return (lt) => {
    const q = ramp(lt, 0.1, 1.1, ease.outQuint);
    mark.style.transform = `scale(${0.55 + 0.45 * q}) rotate(${(1 - q) * -12}deg)`; mark.style.opacity = q;
    glow.style.opacity = ramp(lt, 0.2, 1.4) * 0.9; glow.style.transform = `scale(${0.7 + 0.3 * ramp(lt, 0.2, 2.5)})`;
    const n = ramp(lt, 0.7, 1.4, ease.outQuint); name.style.opacity = n; name.style.transform = `translateY(${(1 - n) * 30}px)`; name.style.letterSpacing = `${-0.045 + (1 - n) * 0.08}em`;
    const g = ramp(lt, 1.35, 1.95, ease.out); tag.style.opacity = g; tag.style.transform = `translateY(${(1 - g) * 16}px)`;
  };
}, { fadeIn: 0.01 });

// 1 · One list: the organization's work across projects.
scene(...next(5.0), (L, dur) => {
  const h = headline(L, 'Every project. *One list.*', null);
  // Under the headline, three small boxes instead of a subtitle (owner's change, 2026-11-06).
  const boxes = el('div', 'boxes', L);
  const box = ['Code, apps, websites', 'Research', 'Random bureaucratic work'].map((t) => el('span', 'box', boxes, t));
  const w = browserWindow(L, { screens: ['home'] }); w.url(host('/personal'));
  w.show({ home: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    box.forEach((b, k) => { const q = ramp(lt, 0.35 + k * 0.12, 0.9 + k * 0.12, ease.outQuint); b.style.opacity = q; b.style.transform = `translateY(${(1 - q) * 12}px)`; });
    const [z, fx, fy] = kf(lt, [[0.6, [1, 720, 450]], [4.6, [1.2, 640, 470]]], ease.inOut);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1100, 860], [1.2, 1050, 700], [2.4, 498, 160], [3.6, 498, 160], [4.8, 700, 420]], [], ramp(lt, 0.8, 1.2));
  };
});

// 2 · Say what needs doing: the real prompt, typed.
const PROMPT_FRAMES = 47;
scene(...next(6.4), (L, dur) => {
  const h = headline(L, 'Say what needs doing.', 'In plain words. Pick the agent and model, or keep your defaults.');
  const w = browserWindow(L, { screens: ['form-empty', 'form-type/', 'models'] }); w.url(host('/personal/personal-website/tasks/new'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const typing = ramp(lt, 0.9, 3.5, (p) => p);
    const frame = Math.round(typing * (PROMPT_FRAMES - 1));
    w.seq('form-type/', 'form-type', frame);
    const showModels = ramp(lt, 4.15, 4.35);
    w.show({ 'form-empty': lt < 0.9 ? 1 : 0, 'form-type/': lt >= 0.9 ? 1 - showModels * ramp(lt, 4.15, 4.35) : 0, models: showModels * (1 - ramp(lt, 5.2, 5.35)) });
    if (lt >= 5.2) w.show({ 'form-type/': 1 });
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [1.0, [1.55, 660, 200]], [3.6, [1.55, 660, 200]], [4.2, [1.3, 640, 520]], [5.2, [1.3, 640, 520]], [5.9, [1.15, 1000, 700]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 600], [0.6, 600, 230], [3.6, 640, 330], [4.05, 560, 483], [4.9, 560, 483], [5.6, 1290, 868], [6.4, 1290, 868]], [4.1, 5.75], ramp(lt, 0.3, 0.6));
  };
});

// 3 · The agent works, on its own computer — the real run, replayed.
const WORK = Array.from({ length: 11 }, (_, i) => `work-${String(i).padStart(2, '0')}`);
scene(...next(5.6), (L, dur) => {
  const h = headline(L, 'Agents work on *their own computers.*', 'Your repos, a terminal, a browser — in parallel, while you do something else.');
  const w = browserWindow(L, { screens: WORK }); w.url(host('/personal/personal-website/tasks/5'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const p = ramp(lt, 0.5, dur - 0.5, (q) => q) * (WORK.length - 1);
    const i = Math.floor(p), f = clamp((p - i) * 4, 0, 1);
    const weights = {}; weights[WORK[i]] = 1; if (WORK[i + 1]) weights[WORK[i + 1]] = f;
    w.show(weights);
    const [z, fx, fy] = kf(lt, [[0.3, [1, 720, 450]], [1.6, [1.38, 640, 460]], [dur, [1.45, 660, 480]]]);
    w.camera(z, fx, fy);
    w.pointer(0, 0, 0);
  };
});

// 4 · Big jobs fan out into sub-tasks.
scene(...next(4.2), (L, dur) => {
  const h = headline(L, 'Big jobs *fan out.*', 'One codebase review became 25 sub-tasks, each with its own agent.');
  const w = browserWindow(L, { screens: ['subtasks'] }); w.url(host('/personal/tavya/tasks/367'));
  w.show({ subtasks: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [2.0, [1.5, 1290, 300]], [dur, [1.5, 1290, 560]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 5 · Review the result: open what the agent attached, then Confirm.
scene(...next(7.4), (L, dur) => {
  const h = headline(L, 'Review the *result,* not the process.', 'Agents attach screenshots, reports and commands to check. You approve; it lands.');
  const w = browserWindow(L, { screens: ['review', 'review-viewer', 'review-done'] }); w.url(host('/personal/personal-website/tasks/5'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const viewer = ramp(lt, 2.0, 2.25) * (1 - ramp(lt, 4.1, 4.3));
    const done = ramp(lt, 5.75, 6.0);
    w.show({ review: 1 - done, 'review-viewer': viewer * (1 - done), 'review-done': done });
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [1.4, [1.3, 640, 480]], [2.1, [1.3, 640, 480]], [2.6, [1.05, 720, 380]], [4.1, [1.05, 720, 380]], [4.6, [1.3, 600, 640]], [5.8, [1.3, 600, 640]], [6.5, [1.6, 1260, 60]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 1000, 700], [1.0, 600, 560], [1.75, 494, 452], [2.1, 494, 452], [2.6, 1100, 300], [3.9, 1770 - 410, 50], [4.4, 700, 760], [5.3, 455, 868], [6.6, 455, 868]], [1.9, 4.05, 5.6], ramp(lt, 0.6, 0.9) * (1 - ramp(lt, 6.1, 6.4)));
  };
});

// 6 · Not just code: what agents made in other projects.
scene(...next(5.0), (L, dur) => {
  const h = headline(L, 'Not just code.', 'Experiments, figures, papers, websites — from the same list.');
  const w = browserWindow(L, { screens: ['made-legibench', 'made-lvpm'] });
  const pages = [el('div', 'page', L), el('div', 'page', L)];
  ['made-paper-pdf-01', 'made-paper-pdf-02'].forEach((n, i) => setSrc(el('img', '', pages[i]), `${A}${n}.png`));
  const tag = el('div', 'tag', L);
  return (lt) => {
    h(lt);
    const a = ramp(lt, 1.65, 1.9);
    enter(w, lt, 3.4 + 0.35);
    w.show({ 'made-legibench': 1 - a, 'made-lvpm': a });
    w.url(host(lt < 1.8 ? '/personal/legibench3/tasks/19' : '/personal/lvpm/tasks/8'));
    w.camera(kf(lt, [[0.2, 1], [1.7, 1.12], [1.8, 1], [3.3, 1.12]]), 760, 420);
    w.pointer(0, 0, 0);
    pages.forEach((p, i) => {
      const q = ramp(lt, 3.2 + i * 0.15, 3.9 + i * 0.15, ease.outQuint);
      p.style.width = '520px'; p.style.left = `${700 + i * 300 - 120}px`; p.style.top = `${300 + (1 - q) * 80}px`;
      p.style.opacity = q * (1 - ramp(lt, dur - 0.3, dur)); p.style.transform = `rotate(${(i ? 5 : -4) * q}deg)`;
    });
    tag.innerHTML = lt < 1.8 ? 'legibench3<small>Human study: which models explain best</small>' : lt < 3.3 ? 'lvpm<small>Oversight study, nine figures</small>' : 'legibench3<small>The paper, co-written with Claude</small>';
    tag.style.left = '300px'; tag.style.top = '990px'; tag.style.opacity = ramp(lt, 0.6, 1.0) * (1 - ramp(lt, dur - 0.3, dur));
  };
});

// 7 · Accounts, keys and a card.
scene(...next(4.6), (L, dur) => {
  const h = headline(L, 'Give agents *accounts, keys and a card.*', 'They sign up, sign in and pay — only with what you allow.');
  const w = browserWindow(L, { screens: ['vault'] }); w.url(host('/personal/settings#settings-payments'));
  w.show({ vault: 1 });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const [z, fx, fy] = kf(lt, [[0.4, [1, 720, 450]], [2.2, [1.45, 600, 330]], [dur, [1.45, 760, 600]]]);
    w.camera(z, fx, fy);
    pointerAt(w, lt, [[0, 900, 700], [1.6, 560, 410], [3.2, 1120, 410], [dur, 1120, 520]], [], ramp(lt, 1.0, 1.4));
  };
});

// 8 · The autonomous company (was: Work that starts itself).
scene(...next(5.2), (L, dur) => {
  const h = headline(L, 'The *autonomous company.*', null);
  // Under the headline, three small boxes instead of a subtitle (owner's change, 2026-11-06).
  const boxes = el('div', 'boxes', L);
  const box = ['Agents can start, manage and approve tasks', 'Tasks can be triggered by webhooks and events', 'Tasks can run on schedules, or after other tasks']
    .map((t) => el('span', 'box', boxes, t));
  const w = browserWindow(L, { screens: ['auto-repeatable', 'auto-upgrade'] });
  return (lt) => {
    h(lt); enter(w, lt, dur);
    box.forEach((b, k) => { const q = ramp(lt, 0.35 + k * 0.12, 0.9 + k * 0.12, ease.outQuint); b.style.opacity = q; b.style.transform = `translateY(${(1 - q) * 12}px)`; });
    const b = ramp(lt, 2.4, 2.65);
    w.show({ 'auto-repeatable': 1 - b, 'auto-upgrade': b });
    w.url(host(lt < 2.5 ? '/personal/tavya?q=is:series' : '/personal/tavya/tasks/832'));
    const [z, fx, fy] = lt < 2.5 ? kf(lt, [[0.4, [1, 720, 450]], [2.4, [1.5, 760, 220]]]) : kf(lt, [[2.5, [1.25, 720, 330]], [dur, [1.4, 1050, 330]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 9 · Any model, your subscription.
scene(...next(4.6), (L, dur) => {
  const h = headline(L, 'Any model. *Your subscription.*', 'Claude, Codex or OpenCode — on your Claude or ChatGPT plan, or an API key.');
  const w = browserWindow(L, { screens: ['models', 'models-compare'] }); w.url(host('/personal/personal-website/tasks/new'));
  return (lt) => {
    h(lt); enter(w, lt, dur);
    const b = ramp(lt, 2.1, 2.35);
    w.show({ models: 1 - b, 'models-compare': b });
    const [z, fx, fy] = lt < 2.2 ? kf(lt, [[0.3, [1, 720, 450]], [2.1, [1.55, 520, 590]]]) : kf(lt, [[2.2, [1.15, 720, 450]], [dur, [1.32, 720, 440]]]);
    w.camera(z, fx, fy); w.pointer(0, 0, 0);
  };
});

// 10 · Everywhere else.
scene(...next(4.0), (L) => {
  const h = headline(L, 'In your pocket, too.', null);
  const phones = ['mobile-home', 'mobile-task'].map((n) => { const p = el('div', 'phone', L); setSrc(el('img', '', p), `${A}${n}.png`); return p; });
  const chips = el('div', 'chips', L);
  const items = ['Project wiki & skills', 'Sub-tasks', 'Teams & Avatārs', 'MCP for any agent', 'tavya CLI', 'Your own cloud accounts'];
  const nodes = items.map((t) => el('span', 'chip', chips, t));
  return (lt) => {
    h(lt);
    phones.forEach((p, i) => {
      const q = ramp(lt, 0.2 + i * 0.15, 1.0 + i * 0.15, ease.outQuint);
      p.style.left = `${960 - 430 + i * 460}px`; p.style.top = `${190 + (1 - q) * 120 + (i ? 30 : 0)}px`;
      p.style.transform = `scale(.86) rotate(${(i ? 3 : -3) * q}deg)`; p.style.transformOrigin = '50% 0'; p.style.opacity = q;
    });
    chips.style.top = '960px';
    nodes.forEach((n, i) => { const q = ramp(lt, 1.0 + i * 0.12, 1.5 + i * 0.12, ease.outQuint); n.style.opacity = q; n.style.transform = `translateY(${(1 - q) * 16}px)`; });
  };
});

// 11 · End card.
scene(...next(4.4), (L) => {
  L.id = 'end';
  const mark = el('img', 'mark', L); setSrc(mark, A + 'brand/icon-512.png'); mark.style.top = '250px';
  const name = el('div', 'wordmark', L, 'tavya'); name.style.top = '440px';
  const tag = el('div', 'tagline', L, 'Just do things.'); tag.style.top = '600px';
  const cta = el('div', 'cta', L, 'tavya.io'); cta.style.top = '720px';
  const note = el('div', 'tagline', L, 'Open to everyone, starting today.'); note.style.top = '840px'; note.style.fontSize = '26px';
  return (lt) => {
    const q = ramp(lt, 0.0, 0.9, ease.outQuint);
    mark.style.opacity = q; mark.style.transform = `scale(${0.8 + 0.2 * q})`;
    const n = ramp(lt, 0.2, 0.9, ease.outQuint); name.style.opacity = n; name.style.transform = `translateY(${(1 - n) * 24}px)`;
    const g = ramp(lt, 0.6, 1.2, ease.out); tag.style.opacity = g;
    const c = ramp(lt, 1.0, 1.6, ease.outQuint); cta.style.opacity = c; cta.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * c})`;
    note.style.opacity = ramp(lt, 1.5, 2.1);
  };
}, { fadeOut: 0.6 });

const DURATION = T;
async function seek(t) {
  for (const s of scenes) {
    const on = t >= s.start - 0.001 && t < s.end;
    if (!on) { s.layer.style.opacity = 0; s.layer.style.display = 'none'; continue; }
    s.layer.style.display = 'block';
    const lt = t - s.start;
    s.layer.style.opacity = Math.min(ramp(lt, 0, s.fadeIn, (p) => p), 1 - ramp(lt, s.end - s.start - s.fadeOut, s.end - s.start, (p) => p));
    s.update(lt, s.end - s.start);
  }
  const waits = [...pending].map((img) => img.decode().catch(() => {}));
  pending.clear();
  await Promise.all(waits);
}
window.seek = seek;
window.DURATION = DURATION;
window.FPS = FPS;
window.SCENES = scenes.map((s) => [s.start, s.end]);
// Cursor clicks (scene, offset) — the score puts a tick on each.
window.CLICKS = [[2, 4.1], [2, 5.75], [5, 1.9], [5, 4.05], [5, 5.6]].map(([i, d]) => scenes[i].start + d);
