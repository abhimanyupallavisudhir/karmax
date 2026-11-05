// Folder listings and file views for project Files (wiki features/project-files),
// shared by the console's Files tab and the public page of a shared snapshot
// (/share/files/…), which loads this without the console's application.
// A view never fetches folders itself: its caller hands it a node
// (GET …/files or …/shared-files) and says how to link, read and render.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TEXT_MAX = 2 * 1024 * 1024;      // shown in the page; larger files download
  const HIGHLIGHT_MAX = 512 * 1024;      // coloured; larger text stays plain
  const PDF_MAX = 50 * 1024 * 1024;
  const THUMB_MAX = 3 * 1024 * 1024;     // images this small get a thumbnail in their folder
  const TABLE_ROWS = 5000;
  const svg = (body, width = 16, stroke = 1.8) => `<svg viewBox="0 0 24 24" width="${width}" height="${width}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    directory: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    file: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>'),
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
    video: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>'),
    symlink: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M9 16v-2a3 3 0 0 1 3-3h3"/><path d="m13 9 2 2-2 2"/>'),
    submodule: svg('<circle cx="12" cy="12" r="3"/><path d="M3 12h6m6 0h6"/>'),
    repository: svg('<path d="M5 19.5V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12"/><path d="M9 7h6"/>'),
    data: svg('<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>'),
    up: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', 16, 2),
    open: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 15, 2),
    download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>', 15, 2),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 15, 2),
    share: svg('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>', 15, 2),
  };
  const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
  const VIDEO = /\.(?:mp4|webm|mov|m4v)$/i;
  const AUDIO = /\.(?:mp3|m4a|wav|ogg|oga|opus|flac)$/i;

  const parts = (value) => String(value || '').split('/').filter(Boolean);
  const join = (...values) => values.flatMap(parts).join('/');
  const parent = (value) => parts(value).slice(0, -1).join('/');
  // Resolve `target` (a symlink's or a Markdown link's) against `dir`: null when it climbs out.
  function resolve(dir, target) {
    const out = String(target || '').startsWith('/') ? [] : parts(dir);
    for (const part of String(target || '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
    }
    return out.join('/');
  }
  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes, unit = -1;
    do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
    return `${Number(amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2))} ${units[unit]}`;
  }

  // ── folders ───────────────────────────────────────────────────────────────
  // `ctx.href(path)` links a place; `ctx.raw(path)` is a file's bytes; `ctx.link`
  // is extra attributes for in-page links (the console's data-spa).
  function listingHtml(node, ctx) {
    const entries = node.entries || [];
    if (!entries.length) return `<div class="files-status muted">${node.path ? 'Empty folder' : esc(ctx.emptyRoot || 'Empty folder')}</div>`;
    const icon = (entry) => entry.mount === 'data' ? ICONS.data : entry.mount ? ICONS.repository
      : entry.kind === 'file' && IMAGE.test(entry.name) ? ICONS.image : entry.kind === 'file' && VIDEO.test(entry.name) ? ICONS.video
        : ICONS[entry.kind] || ICONS.file;
    // An image small enough is its own icon.
    const thumb = (entry, where) => entry.kind === 'file' && IMAGE.test(entry.name) && (entry.size ?? Infinity) <= THUMB_MAX
      ? `<img class="files-thumb" src="${esc(ctx.raw(where))}" alt="" loading="lazy" decoding="async">` : '';
    const badge = (entry) => entry.mount === 'data' ? '<span class="files-badge" title="Data resource mounted here">data</span>'
      : entry.mount === 'wiki' ? '<span class="files-badge" title="The project wiki">wiki</span>' : '';
    return `<ul class="files-list" role="list">${entries.map((entry) => {
      const where = join(node.path, entry.name);
      return `<li class="files-row kind-${esc(entry.kind)}${entry.mount ? ` mount-${esc(entry.mount)}` : ''}">
      <a class="files-link" href="${esc(ctx.href(where))}"${ctx.link || ''}><span class="files-icon">${icon(entry)}${thumb(entry, where)}</span><span class="files-name">${esc(entry.name)}</span>${badge(entry)}</a>
      <span class="files-size">${entry.size !== undefined && entry.kind !== 'directory' ? esc(formatBytes(entry.size)) : ''}</span></li>`;
    }).join('')}</ul>`;
  }

  // ↑/↓ move through the rows; `from` (a name) gets the focus, as when coming back up.
  function wireListing(body, from) {
    const links = [...body.querySelectorAll('.files-link')];
    body.querySelectorAll('.files-thumb').forEach((img) => {
      img.addEventListener('load', () => img.closest('.files-icon')?.classList.add('has-thumb'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
    });
    body.querySelector('.files-list')?.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const at = links.indexOf(document.activeElement);
      links[Math.max(0, Math.min(links.length - 1, at < 0 ? 0 : at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    const back = from ? links.find((link) => link.querySelector('.files-name')?.textContent === from) : null;
    if (back) back.focus();
  }

  // ── files ─────────────────────────────────────────────────────────────────
  // Which highlight.js language a file may be, from its name; null = plain text.
  // The caller checks it against the loaded library (hljs.getLanguage).
  function language(name) {
    const lower = String(name).toLowerCase();
    const special = { makefile: 'makefile', dockerfile: 'bash', 'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', '.bashrc': 'bash', '.zshrc': 'bash', '.env': 'bash' };
    if (special[lower]) return special[lower];
    if (lower.startsWith('.env.')) return 'bash';
    const ext = lower.includes('.') ? lower.split('.').pop() : '';
    const aliases = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', vue: 'xml', svelte: 'xml',
      htm: 'xml', svg: 'xml', toml: 'ini', cfg: 'ini', conf: 'ini', jsonl: 'json', ndjson: 'json', ipynb: 'json', webmanifest: 'json', tf: 'ini', zsh: 'bash', ps1: 'powershell', txt: null, log: null, csv: null, tsv: null };
    if (ext in aliases) return aliases[ext];
    return ext && /^[a-z0-9+#-]{1,12}$/.test(ext) ? ext : null;
  }

  function loadHighlighter() {
    if (globalThis.hljs) return Promise.resolve(globalThis.hljs);
    return (loadHighlighter.pending ||= new Promise((done) => {
      const script = document.createElement('script');
      script.src = '/vendor/highlight.min.js';
      script.onload = () => done(globalThis.hljs || null);
      script.onerror = () => { loadHighlighter.pending = null; done(null); };
      document.head.appendChild(script);
    }));
  }

  // highlight.js's HTML split into lines, each closing and reopening the spans
  // that cross it, so every line is a well-formed element of its own.
  function splitHighlightedLines(html) {
    const lines = [], open = [];
    let line = '', match;
    const token = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
    while ((match = token.exec(html))) {
      const t = match[0];
      if (t === '\n') { lines.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
      else if (t.startsWith('<span')) { open.push(t); line += t; }
      else if (t === '</span>') { open.pop(); line += t; }
      else line += t;
    }
    lines.push(line + '</span>'.repeat(open.length));
    return lines;
  }

  const linesHtml = (lines) => `<div class="files-code" role="table" aria-label="File contents">${lines.map((line, i) =>
    `<div class="files-line" id="L${i + 1}" role="row"><a class="files-ln" href="#L${i + 1}" data-line="${i + 1}" aria-label="Line ${i + 1}" tabindex="-1"></a><span class="files-lc" role="cell">${line || ' '}</span></div>`).join('')}</div>`;

  // RFC 4180 rows (quotes, doubled quotes, newlines inside quotes), at most `limit`.
  function parseDelimited(text, delimiter, limit) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length && rows.length < limit; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === delimiter) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if ((field || row.length) && rows.length < limit) { row.push(field); rows.push(row); }
    return rows;
  }

  // Line numbers link to the line (#L12); shift-click a second one for a range.
  function wireLines(content) {
    const mark = () => {
      content.querySelectorAll('.files-line.selected').forEach((line) => line.classList.remove('selected'));
      const match = /^#L(\d+)(?:-L(\d+))?$/.exec(location.hash);
      if (!match) return null;
      const from = Number(match[1]), to = Number(match[2] || match[1]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) content.querySelector(`#L${n}`)?.classList.add('selected');
      return content.querySelector(`#L${Math.min(from, to)}`);
    };
    mark()?.scrollIntoView({ block: 'center' });
    content.addEventListener('click', (event) => {
      const link = event.target.closest('.files-ln');
      if (!link) return;
      event.preventDefault();
      const line = Number(link.dataset.line);
      const anchor = /^#L(\d+)/.exec(location.hash)?.[1];
      const hash = event.shiftKey && anchor && Number(anchor) !== line
        ? `#L${Math.min(Number(anchor), line)}-L${Math.max(Number(anchor), line)}` : `#L${line}`;
      history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
      mark();
    });
  }

  /** Draw a file into `body`. `ctx`: raw(path, download?), href(path), link,
   * fetch(url) → Response, shows() → still wanted, markdown(el, text, after),
   * markdownTools (extra head HTML for Markdown) and wireTools(body), copy(text),
   * errorText(message). */
  async function renderFile(body, node, ctx) {
    const name = parts(node.path).pop() || 'file';
    const raw = ctx.raw(node.path), download = ctx.raw(node.path, true);
    const head = (meta = '', tools = '') => `<div class="files-file-head"><span class="files-file-name">${esc(name)}</span><span class="files-file-meta">${meta}</span><span class="files-spacer"></span>${tools}
      <a class="btn sm icon" href="${esc(raw)}" target="_blank" rel="noopener" title="Open raw file in a new tab" aria-label="Open raw">${ICONS.open}</a>
      <a class="btn sm icon" href="${esc(download)}" download="${esc(name)}" title="Download" aria-label="Download">${ICONS.download}</a></div>`;
    const size = formatBytes(node.size ?? 0);
    const status = (html, kind = 'muted') => `<div class="files-status ${kind}">${html}</div>`;
    if (IMAGE.test(name)) {
      body.innerHTML = `<div class="files-file">${head(esc(size))}<div class="files-media files-image"><img src="${esc(raw)}" alt="${esc(name)}"></div></div>`;
      const img = body.querySelector('.files-image img');
      img.addEventListener('load', () => {
        const meta = body.querySelector('.files-file-meta');
        if (meta && img.naturalWidth) meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${size}`;
      }, { once: true });
      img.addEventListener('error', () => { img.parentElement.outerHTML = status(`Couldn’t show this image. <a href="${esc(download)}" download="${esc(name)}">Download</a>`); }, { once: true });
      return;
    }
    if (VIDEO.test(name) || AUDIO.test(name)) {
      const tag = VIDEO.test(name) ? 'video' : 'audio';
      body.innerHTML = `<div class="files-file">${head(esc(size))}<div class="files-media"><${tag} controls playsinline preload="metadata" src="${esc(raw)}"></${tag}></div></div>`;
      body.querySelector(tag).addEventListener('error', (event) => {
        event.target.parentElement.outerHTML = status(`This browser can’t play this file. <a href="${esc(download)}" download="${esc(name)}">Download</a>`);
      }, { once: true });
      return;
    }
    const pdf = /\.pdf$/i.test(name);
    if ((node.size ?? 0) > (pdf ? PDF_MAX : TEXT_MAX)) {
      body.innerHTML = `<div class="files-file">${head(esc(size))}${status(`Too large to show here. <a href="${esc(download)}" download="${esc(name)}">Download</a>`)}</div>`;
      return;
    }
    body.innerHTML = `<div class="files-file">${head(esc(size))}<div class="files-status" role="status" aria-busy="true">Loading…</div></div>`;
    let response;
    try {
      response = await ctx.fetch(raw);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    } catch (error) {
      if (!ctx.shows()) return;
      body.querySelector('.files-status').outerHTML = `<div class="files-status error" role="alert">${esc(ctx.errorText ? ctx.errorText(error.message) : error.message)}</div>`;
      return;
    }
    if (pdf) {
      const blob = await response.blob();
      if (!ctx.shows()) return;
      const frame = document.createElement('iframe');
      frame.className = 'files-pdf';
      frame.title = name;
      frame.src = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      body.querySelector('.files-status').replaceWith(frame);
      return;
    }
    if (/octet-stream/.test(response.headers.get('content-type') || '')) {
      response.body?.cancel().catch(() => {});
      if (!ctx.shows()) return;
      body.querySelector('.files-status').outerHTML = status(`Binary file. <a href="${esc(download)}" download="${esc(name)}">Download</a>`);
      return;
    }
    const text = await response.text();
    const kind = /\.(?:md|markdown|mdx)$/i.test(name) ? 'markdown' : /\.(?:csv|tsv)$/i.test(name) ? 'table' : 'code';
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const guess = language(name);
    // Colouring needs the library: wait for it only when this file wants it.
    const hljs = guess && text.length <= HIGHLIGHT_MAX ? await loadHighlighter() : null;
    const lang = hljs?.getLanguage(guess) ? guess : null;
    if (!ctx.shows()) return;
    const meta = `${lines.length.toLocaleString()} line${lines.length === 1 ? '' : 's'} · ${esc(size)}`;
    const modes = kind === 'code' ? '' : `<div class="segmented sm files-modes" role="group" aria-label="View">
      <button type="button" data-mode="rendered" aria-pressed="true">${kind === 'markdown' ? 'Preview' : 'Table'}</button><button type="button" data-mode="code" aria-pressed="false">Code</button></div>`;
    const copy = `<button class="btn sm icon files-copy" type="button" title="Copy contents" aria-label="Copy contents">${ICONS.copy}</button>`;
    body.innerHTML = `<div class="files-file">${head(meta, `${modes}${kind === 'markdown' ? ctx.markdownTools || '' : ''}${copy}`)}<div class="files-content" id="files-content"></div></div>`;
    const content = body.querySelector('#files-content');
    let codeHtml = null;
    const code = () => {
      if (codeHtml === null) {
        let html = null;
        try { if (lang) html = hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value; } catch { html = null; }
        codeHtml = linesHtml(html ? splitHighlightedLines(html) : lines.map(esc));
      }
      content.className = 'files-content files-source-view';
      content.innerHTML = codeHtml;
      wireLines(content);
    };
    const rendered = () => {
      content.className = 'files-content files-rendered';
      if (kind === 'markdown') {
        content.classList.add('msg-text', 'md');
        ctx.markdown(content, text, (el) => {
          // Relative links go to their file in this tree.
          el.querySelectorAll('a[data-md-local]').forEach((link) => {
            let local = link.dataset.mdLocal.split(/[?#]/)[0];
            try { local = decodeURIComponent(local); } catch { /* as written */ }
            const target = resolve(parent(node.path), local);
            if (target === null) return;
            link.href = ctx.href(target);
            for (const attribute of (ctx.link || '').trim().split(/\s+/).filter(Boolean)) link.setAttribute(attribute, '');
          });
        });
        ctx.wireTools?.(body);
        return;
      }
      const rows = parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : ',', TABLE_ROWS + 1);
      const [header = [], ...rest] = rows;
      content.innerHTML = `<div class="files-table-wrap"><table class="files-table"><thead><tr>${header.map((cell) => `<th>${esc(cell)}</th>`).join('')}</tr></thead>
        <tbody>${rest.slice(0, TABLE_ROWS).map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        ${rest.length > TABLE_ROWS ? status(`First ${TABLE_ROWS.toLocaleString()} rows. Switch to Code for the rest.`) : ''}`;
    };
    // A line link (#L12) opens the code, even of a Markdown file.
    const showCode = kind === 'code' || /^#L\d+/.test(location.hash);
    if (showCode) code(); else rendered();
    body.querySelectorAll('.files-modes [data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String((button.dataset.mode === 'code') === showCode));
      button.addEventListener('click', () => {
        body.querySelectorAll('.files-modes [data-mode]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
        if (button.dataset.mode === 'code') code(); else rendered();
      });
    });
    body.querySelector('.files-copy')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      Promise.resolve(ctx.copy(text)).then(() => button.blur(), () => {});
    });
  }

  /** Draw any node: a folder's rows, a link, a submodule, or a file. */
  function render(body, node, ctx) {
    if (node.kind === 'directory') { body.innerHTML = listingHtml(node, ctx); wireListing(body, ctx.from); return; }
    if (node.kind === 'symlink') {
      const target = resolve(parent(node.path), node.target);
      body.innerHTML = `<div class="files-status">${ICONS.symlink}<span>Link to <code>${esc(node.target)}</code></span>
        ${target !== null ? `<a class="btn sm" href="${esc(ctx.href(target))}"${ctx.link || ''}>Open</a>` : ''}</div>`;
      return;
    }
    if (node.kind === 'submodule') {
      body.innerHTML = `<div class="files-status">${ICONS.submodule}<span>Submodule at <code>${esc(String(node.target || '').slice(0, 12))}</code></span></div>`;
      return;
    }
    return renderFile(body, node, ctx);
  }

  /** The chip saying where a place's content comes from. */
  function sourceHtml(source) {
    if (!source || source.kind === 'project') return '';
    if (source.kind === 'repository') return `<span class="files-chip" title="${esc(source.role === 'project-wiki' ? 'Project wiki' : 'Branch')} ${esc(source.branch)} · commit ${esc(source.commit)}">${ICONS.repository}<span>${esc(source.branch)}</span><code>${esc(String(source.commit).slice(0, 7))}</code></span>`;
    return `<span class="files-chip data" title="Data resource ${esc(source.name)}">${ICONS.data}<span>${esc(source.name)}</span></span>`;
  }

  globalThis.KarmaxFileView = { ICONS, parts, join, parent, resolve, formatBytes, render, sourceHtml, listingHtml, wireListing, language, splitHighlightedLines, parseDelimited };
})();
