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
  //
  // Every file comes from one pinned release and is integrity-checked: the entry
  // bundle here, and whatever MathJax's own loader fetches later (ui/safe, TeX
  // extensions pulled in by autoload or \require) through `loader.require`, which
  // refuses any file this table does not pin. Regenerate the table with
  // `node scripts/mathjax-integrity.mjs` when the release changes.
  const MATHJAX_ROOT = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/';
  const MATHJAX_INTEGRITY = {
    'tex-svg': 'sha384-KKWa9jJ1MZvssLeOoXG6FiOAZfAgmzsIIfw8BXwI9+kYm0lPCbC6yTQPBC00F1/L',
    'a11y/assistive-mml': 'sha384-qSxBwhwvtvRyFQg5tIdeWHfceQdw8SyGOF6mQJlXrR2xIkv0MhdNVoQ47EjFLHK7',
    'input/tex/extensions/action': 'sha384-PY+ttyB5xUWU3vWZAgp/O8oPFVbYUe02ASBZxCu2RQ4EAccyrmJCHmUjy+LwhLbT',
    'input/tex/extensions/all-packages': 'sha384-5jv4tuho7ZYU9LpjRU7iBQHU8semS1AWEA+8xD86BZiJGK2aqVlvfCIm8LsCjb/d',
    'input/tex/extensions/ams': 'sha384-VkLIFB4IrvgzmtOf8Q13gM/lTJnF91FOfAZXcfUkDY94FnbBPbVU3cyhESqBzNa/',
    'input/tex/extensions/amscd': 'sha384-es5T1F+CeXLEJNCY8oyWXCMMF3OG3XZkjm9NaKsH0VsvKJ5KIv0+UzLsXVT8SuAw',
    'input/tex/extensions/autoload': 'sha384-byPhdtsMhI2d4TAdqfk01YEcjXqT5v/xk5fEHEmvhpqGsa5nVzMGQnlqQeq9R4G0',
    'input/tex/extensions/bbox': 'sha384-I4gnUmwoHTR+/u+XafWkn/T0em8dkv0APufIvx99glfdWavSFpndWwIogE63diS+',
    'input/tex/extensions/boldsymbol': 'sha384-m7IgUOndpCawN1qQw/yHbl8Owz0gCZWtO23dTNqPARGk/v54JLqLIG88NbzJkdZf',
    'input/tex/extensions/braket': 'sha384-zKoj5hkO1udEwbNQwB8VS5s52sy4MPkoJrB2OtKfnEVG+4BwxBG+LXwTI06Tb4i8',
    'input/tex/extensions/bussproofs': 'sha384-hjII5qg0Sq5FqXnLGU2bOf5jXtd3mM3U1rsI7U7w+Ucu2bj0ozjL8qhXEmExgQgY',
    'input/tex/extensions/cancel': 'sha384-Q0WkNOaovkeett90kCzEDj+iNtwY1YZYn/P699lTwaoBPpTY7XiKaI3yR1fABEwj',
    'input/tex/extensions/cases': 'sha384-6hfnPmtF/EiP1F+zmLYzdL/RbDZQcTOSCDs4XWxCu7tztnZoYVBOI6xMnDDlR6Oa',
    'input/tex/extensions/centernot': 'sha384-DlyRewLqhFjdD7tLijMVfpR3ec14hrbhCKTQoThNfkTgj0Z7dywCXCFnZap5eUVB',
    'input/tex/extensions/color': 'sha384-MD7Q10XmadwswyGCjioiT030pwt0JMbzlEIabTz6FO4GftpOoasSzgtCBYbJxtYR',
    'input/tex/extensions/colortbl': 'sha384-KLcatUDnqHArbThLcgchTAaCZZB5CRBnuBRPUyJJC1UFGkNxj6qQn2iBEx9Q/zgP',
    'input/tex/extensions/colorv2': 'sha384-NuDgXFnc8AMwP+8oXxBfGPPLZYJTErMmMjczXIlgZcubC/rr+cjmIlfLJu3BJBTg',
    'input/tex/extensions/configmacros': 'sha384-iaA8KoDHshQ6w/z5EZV2GQIzWEDHoqVowLcxdjDXRSNwf+cPE8vfkOnX5vNm0iqA',
    'input/tex/extensions/empheq': 'sha384-NDrQ3nLXyj+QXfkFtCHcUO7Ne9OwBVa54sjftuKLJDS+QAT0Bdu9F2Trmx47+GEJ',
    'input/tex/extensions/enclose': 'sha384-sDDHCXb1Na2LxKaRYrhPgSMx4b8u3t6XGCE3pmB940s7+9FFlJgalFLz4NxED4GZ',
    'input/tex/extensions/extpfeil': 'sha384-BCtWPkWwg6JjzCIJal0gDonYJQ6xBBkzK3iULG4IndlDrsHPXh6qureIkRc4LlOH',
    'input/tex/extensions/gensymb': 'sha384-KGbCyKPF+J6LFt+3DGxPWqI1A2a5tmYoNnOsj8LRoYOaAfjaPmj+BC4S+52Z0aPJ',
    'input/tex/extensions/html': 'sha384-6wlucvU0GPBpKSp7j0ux0wi8lDnvzWQuPXpYBwhTqRaTHm0rdCcM6brLKy7yqZhD',
    'input/tex/extensions/mathtools': 'sha384-TdOgJf69C0d2sJoYGwsmRvexBSVd6kK1t4cOCTC3DshuqrWxyfqdqNuIGKP9/YkI',
    'input/tex/extensions/mhchem': 'sha384-G2viS3iW7b46EkElgsoYinFdp3u+p9pP3W5m7mrWQiv3KOeHpFj+AiA292ibBTq9',
    'input/tex/extensions/newcommand': 'sha384-IRsdg68rX3FWNm27QOx+SVJYsE5hP9wdIPe4WeWGJ0n++1VQeaL26iPyLKreQkw8',
    'input/tex/extensions/noerrors': 'sha384-yoLuYEI/Q9pBmUdE7vvg82dPBdtzAFR+u1109LTxSoH5kQZbFk9kzBUu+cVu02pd',
    'input/tex/extensions/noundefined': 'sha384-fch4rg47Pu3x/HF2Yj5k2XlcVGLnxFRkDKiLFPlfUCLuFiW0PRPPZCtI0ZcJuKdN',
    'input/tex/extensions/physics': 'sha384-uDmrF1tLROBL+9qI8qJ3eWmAve6NlSOMnIdeZ6WXI6IELq0WIwifITCkeb+MrTfM',
    'input/tex/extensions/require': 'sha384-2olh1gVZV9hKPmVyYBifQM29Og2sCHIWhiNfIHcLftlqdQXncV8R/VMbHQVPqceS',
    'input/tex/extensions/setoptions': 'sha384-HHd0JDin1nf0pZ4gNNMMEVjsshbCcFxQ0e9RquiKyxS9gtMKG7qSNU7c9w4BN3pF',
    'input/tex/extensions/tagformat': 'sha384-wklnj9jcwLTCQnPCOM0m1GuMJ45jUAi89j4010BwJR7NDCQ9elSCS93J3Ht+0xCg',
    'input/tex/extensions/textcomp': 'sha384-/k0pbTRYKP1boPXI456tWN87qaf7ua6c1bmCxYVD2sGW4WuFy/AM9bYzDv78Y77U',
    'input/tex/extensions/textmacros': 'sha384-5n28pmVjAtqrt7IAgwK3xBYAq4EaEWF/b8u6NSDI1+Pa/A0C9Or+Y0lxaPDEd7bZ',
    'input/tex/extensions/unicode': 'sha384-0lGBc3eOwLh9yc8/zACEPaZx3B+EwFAYTOHk6r/Bu9A3DuoudomuHbHdhPI3FDaG',
    'input/tex/extensions/upgreek': 'sha384-z1OOiA8tK1fI419+erxWaYBkugaJ2XnN5jNbZJMuUiFS5mdrgb3bz06xoHEQbvSw',
    'input/tex/extensions/verb': 'sha384-+G9ZvDcejeTyTqze0Uz6l4UmagCECucAn4WpmW07v38mTstLfF9vRX2m6LaaxRpY',
    'ui/safe': 'sha384-BAIqbtawDyB5QXh8BrGd4h2FmhlZB70FJqMpHt2LxKkPSRa29VXhrB/DV3xLP+/B',
  };
  function loadPinnedScript(url) {
    const file = url.startsWith(MATHJAX_ROOT) ? url.slice(MATHJAX_ROOT.length).replace(/\.js$/, '') : '';
    const integrity = Object.hasOwn(MATHJAX_INTEGRITY, file) ? MATHJAX_INTEGRITY[file] : '';
    if (!integrity) return Promise.reject(new Error(`${url} is not a pinned MathJax file`));
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`could not load ${url}`));
      document.head.appendChild(script);
    });
  }
  let mathjaxLoad = null;
  function ensureMathJax() {
    if (mathjaxLoad) return mathjaxLoad;
    mathjaxLoad = new Promise((resolve) => {
      window.MathJax = {
        loader: { load: ['ui/safe'], require: loadPinnedScript },
        tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
        options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
          safeOptions: { allow: { URLs: 'none', classes: 'safe', cssIDs: 'safe', styles: 'safe' } } },
        startup: { typeset: false, ready: () => { window.MathJax.startup.defaultReady(); resolve(true); } },
      };
      loadPinnedScript(`${MATHJAX_ROOT}tex-svg.js`).catch(() => resolve(false));
    });
    return mathjaxLoad;
  }
  globalThis.KarmaxMarkdown = { renderMarkdown, ensureMathJax };
})();
