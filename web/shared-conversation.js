// Public snapshots use the console's renderer without loading its application.
(() => {
  try {
    const theme = localStorage.getItem('karmax-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {}
  const thread = document.querySelector('.shared-thread');
  if (!thread) return;
  const messages = [...thread.querySelectorAll('.msg-text')].map(node => ({ node, source: node.textContent }));
  const toggle = document.querySelector('.conversation-math');
  let math = true;
  try { math = localStorage.getItem('karmax-mathjax') !== '0'; } catch {}
  let revision = 0;
  const draw = async () => {
    const current = ++revision;
    window.MathJax?.typesetClear?.([thread]);
    let forms = 0;
    for (const { node, source } of messages) {
      node.classList.add('md');
      node.innerHTML = KarmaxMarkdown.renderMarkdown(source, { math });
      // A relative image names a file in the task's world, which a public page cannot read: its alt text.
      node.querySelectorAll('img[data-md-src]').forEach((img) => img.replaceWith(document.createTextNode(img.alt || '')));
      node.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.replaceWith(document.createTextNode(img.alt || '')), { once: true }));
      // An agent's form, as it was asked: read-only here.
      node.querySelectorAll('pre.lang-form').forEach((pre) => {
        const { form } = KarmaxMarkdown.parseForm(pre.textContent);
        if (form) pre.outerHTML = KarmaxMarkdown.renderForm(form, { key: `shared-${++forms}` });
      });
    }
    toggle.setAttribute('aria-pressed', String(math));
    if (!math || !thread.querySelector('.md-math')) return;
    const loaded = await KarmaxMarkdown.ensureMathJax();
    if (!loaded || !math || current !== revision || !thread.isConnected) return;
    try { await window.MathJax.typesetPromise([...thread.querySelectorAll('.md-math')]); }
    catch { /* Keep readable TeX if typesetting is unavailable. */ }
  };
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    math = !math;
    try { localStorage.setItem('karmax-mathjax', math ? '1' : '0'); } catch {}
    draw();
  });
  draw();
})();
