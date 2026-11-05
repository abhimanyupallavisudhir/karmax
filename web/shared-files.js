// The public page of a shared snapshot of project files (/share/files/<id>[/<path>]),
// drawn with web/file-view.js without loading the console. Navigation inside the
// shared folder stays on this page (history entries per place).
(() => {
  try {
    const theme = localStorage.getItem('karmax-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {}
  const root = document.getElementById('shared-files');
  if (!root) return;
  const FV = globalThis.KarmaxFileView;
  const share = root.dataset.share;
  const rootName = root.dataset.root || 'Files';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = `/share/files/${share}`;
  const href = (where) => `${base}${FV.parts(where).length ? `/${FV.parts(where).map(encodeURIComponent).join('/')}` : ''}`;
  const raw = (where, download) => `/api/shared-files/${share}/raw?path=${encodeURIComponent(where)}${download ? '&download=1' : ''}`;
  const here = () => location.pathname.slice(base.length).split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  }).join('/');
  let math = true;
  try { math = localStorage.getItem('karmax-mathjax') !== '0'; } catch {}
  const created = new Date(root.dataset.created);
  root.innerHTML = `<header class="shared-heading"><div class="shared-eyebrow">Shared files</div>
      <div class="shared-toolbar"><p title="A fixed snapshot: later changes aren’t included.">Snapshot · <time datetime="${esc(root.dataset.created)}">${esc(created.toISOString().slice(0, 10))}</time></p></div></header>
    <div class="files-page shared-files-view">
      <div class="files-bar"><a class="btn sm icon files-up" data-local aria-label="Up a folder" title="Up a folder">${FV.ICONS.up}</a>
        <div class="files-address"><nav class="files-crumbs" aria-label="Path"></nav></div><span class="files-source"></span></div>
      <div class="files-body"><div class="files-status" role="status" aria-busy="true">Loading…</div></div></div>`;
  const body = root.querySelector('.files-body');
  let revision = 0, previous = null;

  const draw = async () => {
    const current = ++revision;
    const where = here();
    const parts = FV.parts(where);
    const up = root.querySelector('.files-up');
    up.href = href(FV.parent(where));
    up.classList.toggle('disabled', !parts.length);
    root.querySelector('.files-crumbs').innerHTML = [`<a class="files-crumb files-crumb-root" data-local href="${esc(href(''))}">${esc(rootName)}</a>`,
      ...parts.map((part, i) => `<span class="files-sep" aria-hidden="true">/</span><a class="files-crumb" data-local href="${esc(href(parts.slice(0, i + 1).join('/')))}"${i === parts.length - 1 ? ' aria-current="page"' : ''}>${esc(part)}</a>`)].join('');
    body.innerHTML = '<div class="files-status" role="status" aria-busy="true">Loading…</div>';
    let node;
    try {
      const response = await fetch(`/api/shared-files/${share}?path=${encodeURIComponent(where)}`);
      node = await response.json();
      if (!response.ok) throw new Error(node.error || `HTTP ${response.status}`);
    } catch (error) {
      if (current !== revision) return;
      body.innerHTML = `<div class="files-status error" role="alert">${esc(error.message)}</div>`;
      return;
    }
    if (current !== revision) return;
    document.title = `${parts.at(-1) || rootName} · ${document.title.split(' · ').pop()}`;
    root.querySelector('.files-source').innerHTML = FV.sourceHtml(node.source);
    // A shared file's node is named by the file itself; its address is the link.
    const shown = node.shared?.kind === 'directory' ? node : { ...node, path: node.path || rootName };
    const from = previous && FV.parent(previous) === where ? FV.parts(previous).pop() : null;
    previous = where;
    FV.render(body, shown, {
      href, raw: (path, download) => raw(node.shared?.kind === 'directory' ? path : '', download), link: ' data-local', from,
      shows: () => current === revision, fetch: (url) => fetch(url),
      markdown: async (el, text, after) => {
        el.innerHTML = KarmaxMarkdown.renderMarkdown(text, { math });
        after(el);
        if (!math || !el.querySelector('.md-math') || !(await KarmaxMarkdown.ensureMathJax())) return;
        try { await window.MathJax.typesetPromise([...el.querySelectorAll('.md-math')]); } catch { /* readable TeX stays */ }
      },
      copy: (text) => navigator.clipboard.writeText(text),
    });
  };

  // Places inside the snapshot open here; everything else navigates normally.
  root.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-local]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (link.classList.contains('disabled')) { event.preventDefault(); return; }
    event.preventDefault();
    if (link.getAttribute('href') !== location.pathname) history.pushState({}, '', link.getAttribute('href'));
    draw();
  });
  addEventListener('popstate', draw);
  draw();
})();
