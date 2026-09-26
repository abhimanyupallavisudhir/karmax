// Shared by the console and public conversation reader. No application state.
(() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // A compact, dependency-free Markdown renderer. It escapes first (untrusted
  // agent/user text), then applies a small, common subset: fenced + inline code,
  // headings, lists, blockquotes, rules, bold/italic/strike, links, and — when
  // math is on — $…$ / $$…$$ and \(…\) / \[…\] spans left intact for MathJax to
  // typeset. Code and math are stashed up front so inline formatting can't
  // corrupt their contents;
  // the single stash is restored once at the end (nested blocks recurse through
  // mdBlocks, never renderMarkdown, so indices never clash).
  function renderMarkdown(src, opts = {}) {
    const withMath = !!opts.math;
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    const source = String(src ?? '').replace(/\r\n?/g, '\n');
    let s = source;
    // Fenced code blocks first (a blank line around the placeholder keeps it its
    // own block).
    s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) =>
      `\n${keep(`<pre class="md-code"><code>${esc(body.replace(/\n$/, ''))}</code></pre>`)}\n`);
    if (withMath) s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => keep(`<span class="md-math">$$${esc(body)}$$</span>`));
    if (withMath) s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => keep(`<span class="md-math">\\[${esc(body)}\\]</span>`));
    s = s.replace(/`([^`\n]+)`/g, (_, body) => keep(`<code class="md-inline">${esc(body)}</code>`));
    if (withMath) s = s.replace(/\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (_, body) => keep(`<span class="md-math">$${esc(body)}$</span>`));
    if (withMath) s = s.replace(/\\\(([^\n]+?)\\\)/g, (_, body) => keep(`<span class="md-math">\\(${esc(body)}\\)</span>`));
    let html = mdBlocks(s, stash);
    html = html.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] ?? '');
    return sanitizeMarkdownHtml(html, source);
  }

  // Parse the renderer's output in a detached fragment before it becomes part of
  // the page. Besides enforcing the renderer's small element/attribute allowlist,
  // this makes the browser repair and close any accidentally malformed formatting
  // tags *inside this message*. Formatting-element recovery can otherwise carry an
  // unclosed <strong>/<em> through later siblings, affecting subsequent messages
  // and even controls outside the conversation. Raw message text was escaped
  // before rendering; if the allowlist ever fails, fall back to escaped text.
  function sanitizeMarkdownHtml(html, source) {
    if (typeof document === 'undefined' || !document.createElement) return html;
    const fallback = () => esc(source).replace(/\n/g, '<br>');
    try {
      const template = document.createElement('template');
      template.innerHTML = html;
      const allowedTags = new Set([
        'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'HR', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH',
        'THEAD', 'TR', 'UL',
      ]);
      for (const el of template.content.querySelectorAll('*')) {
        if (!allowedTags.has(el.tagName)) return fallback();
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          const value = attr.value;
          if (name === 'class') continue;
          if (el.tagName === 'A' && name === 'href') {
            if (!/^(?:https?:|mailto:|\/|#)/i.test(value)) return fallback();
            continue;
          }
          if (el.tagName === 'A' && name === 'target' && value === '_blank') continue;
          if (el.tagName === 'A' && name === 'rel' && value === 'noopener noreferrer') continue;
          if (el.tagName === 'A' && name === 'data-md-local') continue;
          if (el.tagName === 'OL' && name === 'start' && /^-?\d+$/.test(value)) continue;
          if ((el.tagName === 'TH' || el.tagName === 'TD') && name === 'style'
            && /^text-align:\s*(?:left|center|right);?$/i.test(value)) continue;
          return fallback();
        }
      }
      return template.innerHTML;
    } catch {
      return fallback();
    }
  }

  function mdBlocks(s, stash) {
    const lines = s.split('\n');
    const out = [];
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
    // A GFM pipe table: a header row followed by a |---|:--:| delimiter row.
    const isTableStart = (idx) => idx + 1 < lines.length && lines[idx].includes('|')
      && mdIsDelimiterRow(lines[idx + 1]) && mdSplitRow(lines[idx]).length > 1;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        out.push(`<h${m[1].length} class="md-h">${mdInline(m[2].trim())}</h${m[1].length}>`);
        i++; continue;
      }
      if (rule.test(line)) { out.push('<hr class="md-hr"/>'); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote class="md-quote">${mdBlocks(buf.join('\n'), stash)}</blockquote>`);
        continue;
      }
      if (bullet.test(line)) {
        const { html, next } = mdParseList(lines, i, stash);
        out.push(html);
        i = next;
        continue;
      }
      if (isTableStart(i)) {
        const headers = mdSplitRow(lines[i]);
        const aligns = mdSplitRow(lines[i + 1]).map(mdCellAlign);
        i += 2;
        const rows = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes('|') && !mdIsDelimiterRow(lines[i])) {
          rows.push(mdSplitRow(lines[i])); i++;
        }
        const al = (x) => (aligns[x] ? ` style="text-align:${aligns[x]}"` : '');
        const head = `<thead><tr>${headers.map((h, x) => `<th${al(x)}>${mdInline(h)}</th>`).join('')}</tr></thead>`;
        const body = rows.length
          ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, x) => `<td${al(x)}>${mdInline(r[x] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '';
        out.push(`<table class="md-table">${head}${body}</table>`);
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i])
        && !bullet.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !rule.test(lines[i]) && !isTableStart(i)) {
        buf.push(lines[i]); i++;
      }
      const joined = buf.join('\n');
      const sole = /^\u0000(\d+)\u0000$/.exec(joined.trim());
      if (sole) { out.push(joined.trim()); continue; } // a lone code/display-math block: no wrapping <p>
      out.push(`<p class="md-p">${mdInline(joined).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  // One list-item line: leading indent, the marker (bullet or `N.`/`N)`), the gap
  // after it, and the item's first-line content.
  const MD_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
  const mdListKind = (marker) => (/^\d/.test(marker) ? 'ol' : 'ul');
  // Leading-whitespace width of a line (a tab counts as 4 columns).
  function mdIndent(line) {
    let w = 0;
    for (const c of line) { if (c === ' ') w++; else if (c === '\t') w += 4; else break; }
    return w;
  }

  // Parse a bullet/number list starting at lines[start]; returns { html, next }.
  // This is deliberately thorough because loose lists are where naive renderers
  // break: blank lines between items must NOT split one list into many one-item
  // lists (that is the classic bug where every ordered item shows "1."). It also
  // honours an arbitrary ordered start value (start=N), nested sublists by
  // indentation, and multi-line / multi-paragraph item bodies.
  function mdParseList(lines, start, stash) {
    const first = MD_ITEM.exec(lines[start]);
    const baseIndent = mdIndent(lines[start]);
    const kind = mdListKind(first[2]);
    const startNum = kind === 'ol' ? parseInt(first[2], 10) : 1;

    // Extent of the whole list block: sibling markers at this indent, their more-
    // indented continuation/nested lines, and interior blank lines (a blank counts
    // as interior only when a later line resumes the list).
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (/^\s*$/.test(line)) {
        let j = end;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j >= lines.length) break;
        const nm = MD_ITEM.exec(lines[j]);
        const sameList = nm && mdIndent(lines[j]) === baseIndent && mdListKind(nm[2]) === kind;
        const deeper = mdIndent(lines[j]) > baseIndent;
        if (sameList || deeper) { end = j; continue; }
        break;
      }
      const m = MD_ITEM.exec(line);
      if (m && mdIndent(line) === baseIndent) {
        if (mdListKind(m[2]) !== kind) break; // a switch of marker type starts a new list
        end++; continue;
      }
      if (mdIndent(line) > baseIndent) { end++; continue; } // continuation / nested
      break; // a dedented, non-item line ends the list
    }

    // A list is "loose" if any blank line falls inside its extent — CommonMark then
    // wraps each item's text in a paragraph; we mirror that with extra spacing.
    let loose = false;
    for (let k = start; k < end - 1; k++) { if (/^\s*$/.test(lines[k])) { loose = true; break; } }

    // Split the extent into items at each sibling marker; dedent each item's body
    // by its own content indent so nested markup parses at the right level.
    const items = [];
    let k = start;
    while (k < end) {
      const m = MD_ITEM.exec(lines[k]);
      if (!(m && mdIndent(lines[k]) === baseIndent && mdListKind(m[2]) === kind)) { k++; continue; }
      const contentIndent = m[1].length + m[2].length + m[3].length;
      const body = [m[4]];
      k++;
      while (k < end) {
        const sib = MD_ITEM.exec(lines[k]);
        if (sib && mdIndent(lines[k]) === baseIndent && mdListKind(sib[2]) === kind) break;
        body.push(/^\s*$/.test(lines[k]) ? '' : lines[k].slice(contentIndent));
        k++;
      }
      items.push(body.join('\n').replace(/\s+$/, ''));
    }

    // Render each item. A loose list wraps every item body in paragraphs (via
    // mdBlocks). In a tight list, a plain item renders inline; one that carries a
    // nested sublist keeps its lead text inline and parses only the sublist as a
    // block, so tight lists don't sprout stray paragraph margins.
    const li = items.map((text) => {
      const rows = text.split('\n');
      if (loose) return `<li>${mdBlocks(text, stash)}</li>`;
      const cut = rows.findIndex((l, x) => x > 0 && MD_ITEM.test(l));
      if (cut > 0) {
        const lead = rows.slice(0, cut).join('\n').trim();
        const rest = rows.slice(cut).join('\n');
        const leadHtml = lead ? mdInline(lead).replace(/\n/g, '<br>') : '';
        return `<li>${leadHtml}${leadHtml ? '\n' : ''}${mdBlocks(rest, stash)}</li>`;
      }
      return `<li>${mdInline(text).replace(/\n/g, '<br>')}</li>`;
    }).join('');

    const attr = kind === 'ol' && startNum !== 1 ? ` start="${startNum}"` : '';
    return { html: `<${kind} class="md-list${loose ? ' md-loose' : ''}"${attr}>${li}</${kind}>`, next: end };
  }

  // Split one pipe-table row into trimmed cells, tolerating optional leading and
  // trailing pipes and backslash-escaped `\|` inside a cell.
  function mdSplitRow(line) {
    const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  // The row under a table header: every cell is dashes with optional alignment
  // colons (`---`, `:--`, `--:`, `:-:`). The pipe requirement keeps a bare `---`
  // (a horizontal rule) from being mistaken for a one-column delimiter.
  function mdIsDelimiterRow(line) {
    if (!line.includes('|') || !line.includes('-')) return false;
    const cells = mdSplitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }

  function mdCellAlign(cell) {
    const s = cell.trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  }

  // Inline formatting over already-block-split text. Escaping happens here so the
  // stash placeholders (bare digits) survive untouched.
  function mdInline(t) {
    let x = esc(t);
    // Backslash escapes: stash the escaped punctuation (as \u0001N\u0001) so the
    // emphasis/link passes treat it as a literal, then restore it at the very end.
    const lit = [];
    x = x.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, ch) => `\u0001${lit.push(ch) - 1}\u0001`);
    // Generated anchors must not go through the emphasis regexes: doing so lets
    // Markdown punctuation in a URL rewrite the generated href attribute. Keep
    // each complete anchor behind an opaque placeholder until formatting is done.
    const links = [];
    const keepLink = (html) => `\u0002${links.push(html) - 1}\u0002`;
    const format = (value) => {
      let out = value;
      out = out.replace(/\*\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*\*/g, '<strong><em>$1</em></strong>');
      out = out.replace(/___([^\s](?:[\s\S]*?[^\s])?)___/g, '<strong><em>$1</em></strong>');
      out = out.replace(/\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/__([^\s](?:[\s\S]*?[^\s])?)__/g, '<strong>$1</strong>');
      out = out.replace(/(^|[^*])\*([^\s*][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
      out = out.replace(/(^|[^_\w])_([^\s_][^_]*?)_(?![_\w])/g, '$1<em>$2</em>');
      return out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
    };
    // Inline links [text](url "optional title") — safe schemes only; the title is
    // dropped. Runs before autolinking so a bare URL inside a link is left alone.
    // A target without a leading URI scheme (so `javascript:`/`data:` are
    // neutralised, while an editor suffix like `file.ts:12` remains local) rides in
    // data-md-local so an in-app resolver (e.g. the wiki view) can route it to a
    // page, while it stays inert (href="#") everywhere else.
    x = x.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (_, txt, href) => {
      if (/^(https?:|mailto:|\/)/i.test(href))
        return keepLink(`<a href="${href}" target="_blank" rel="noopener noreferrer">${format(txt)}</a>`);
      if (href[0] === '#') return keepLink(`<a href="${href}">${format(txt)}</a>`);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return keepLink(`<a href="#" data-md-local="${href}">${format(txt)}</a>`);
      return keepLink(`<a href="#" target="_blank" rel="noopener noreferrer">${format(txt)}</a>`);
    });
    // Autolink bare http(s) URLs (explicit links are opaque placeholders now).
    // A closing emphasis marker adjacent to the URL belongs to the surrounding
    // Markdown when the matching opener occurs before it. Strip that delimiter
    // first, then ordinary sentence punctuation, and keep both outside the anchor.
    x = x.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (whole, pre, matchedUrl, offset, input) => {
      let url = matchedUrl;
      let markdownTail = '';
      const marker = (url.match(/(\*{1,3}|_{1,3}|~~)$/) || [])[1];
      const before = input.slice(0, offset + pre.length);
      if (marker && before.includes(marker)) {
        url = url.slice(0, -marker.length);
        markdownTail = marker;
      }
      const tail = (url.match(/[.,;:!?]+$/) || [''])[0];
      const bare = url.slice(0, url.length - tail.length);
      return `${pre}${keepLink(`<a href="${bare}" target="_blank" rel="noopener noreferrer">${bare}</a>`)}${tail}${markdownTail}`;
    });
    x = format(x);
    x = x.replace(/\u0002(\d+)\u0002/g, (_, n) => links[Number(n)] ?? '');
    x = x.replace(/\u0001(\d+)\u0001/g, (_, n) => lit[Number(n)]);
    return x;
  }

  // MathJax is loaded lazily from a CDN the first time a rendered message actually
  // contains math, and only while the flag is on. If it can't load (offline), the
  // raw $…$ simply stays visible — a graceful, non-fatal degradation.
  let mathjaxLoad = null;
  function ensureMathJax() {
    if (mathjaxLoad) return mathjaxLoad;
    mathjaxLoad = new Promise((resolve) => {
      window.MathJax = {
        loader: { load: ['ui/safe'] },
        tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
        options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
          safeOptions: { allow: { URLs: 'none', classes: 'safe', cssIDs: 'safe', styles: 'safe' } } },
        startup: { typeset: false, ready: () => { window.MathJax.startup.defaultReady(); resolve(true); } },
      };
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js';
      script.integrity = 'sha384-KKWa9jJ1MZvssLeOoXG6FiOAZfAgmzsIIfw8BXwI9+kYm0lPCbC6yTQPBC00F1/L';
      script.crossOrigin = 'anonymous';
      script.async = true;
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return mathjaxLoad;
  }
  globalThis.TavyaMarkdown = { renderMarkdown, ensureMathJax };
})();
