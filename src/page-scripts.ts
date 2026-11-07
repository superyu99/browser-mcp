export function inspectPageScript(maxDepth: number, maxNodes: number, includeHidden: boolean): string {
  return `(() => {
    const maxDepth = ${maxDepth}, maxNodes = ${maxNodes}, includeHidden = ${includeHidden};
    let count = 0, clipped = false;
    const esc = value => String(value).replace(/\\s+/g, ' ').trim();
    const label = element => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? '#' + CSS.escape(element.id) : '';
      const classes = [...element.classList].slice(0, 3).map(x => '.' + CSS.escape(x)).join('');
      const attrs = ['role', 'aria-label', 'name', 'type', 'href', 'src', 'alt']
        .filter(x => element.hasAttribute(x)).map(x => '[' + x + '="' + esc(element.getAttribute(x)).slice(0, 100) + '"]').join('');
      return tag + id + classes + attrs;
    };
    const walk = (element, depth) => {
      if (count >= maxNodes) { clipped = true; return null; }
      const style = getComputedStyle(element);
      if (!includeHidden && (style.display === 'none' || style.visibility === 'hidden')) return null;
      count++;
      const node = { element: label(element) };
      const ownText = [...element.childNodes].filter(x => x.nodeType === Node.TEXT_NODE)
        .map(x => esc(x.textContent)).filter(Boolean).join(' ').slice(0, 160);
      if (ownText) node.text = ownText;
      if (depth < maxDepth) {
        const children = [...element.children, ...(element.shadowRoot ? [...element.shadowRoot.children] : [])]
          .map(x => walk(x, depth + 1)).filter(Boolean);
        if (children.length) node.children = children;
      }
      return node;
    };
    return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight },
      tree: walk(document.body ?? document.documentElement, 0), nodes: count, clipped };
  })()`;
}

export function inspectElementScript(selector: string, maxHtmlChars: number): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)}, element = document.querySelector(selector);
    if (!element) throw new Error('No element matches selector: ' + selector);
    const uniqueSelector = element => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        let part = node.tagName.toLowerCase();
        const classes = [...node.classList].slice(0, 2); if (classes.length) part += classes.map(x => '.' + CSS.escape(x)).join('');
        const parent = node.parentElement;
        if (parent && parent.querySelectorAll(':scope > ' + part).length > 1) part += ':nth-child(' + ([...parent.children].indexOf(node) + 1) + ')';
        parts.unshift(part); if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      }
      return parts.join(' > ');
    };
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const properties = ['display','position','visibility','opacity','z-index','width','height','color','background-color','background-image','font-size','font-family','overflow'];
    const attributes = Object.fromEntries([...element.attributes].slice(0, 40).map(x => [x.name, x.value.slice(0, 500)]));
    return { selector: uniqueSelector(element), tag: element.tagName.toLowerCase(), attributes,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      computed: Object.fromEntries(properties.map(x => [x, style.getPropertyValue(x)])),
      parent: element.parentElement ? { tag: element.parentElement.tagName.toLowerCase(), selector: uniqueSelector(element.parentElement) } : null,
      children: [...element.children].slice(0, 12).map(x => ({ tag: x.tagName.toLowerCase(), selector: uniqueSelector(x) })),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
      html: element.outerHTML.slice(0, ${maxHtmlChars}), htmlClipped: element.outerHTML.length > ${maxHtmlChars} };
  })()`;
}

function pickerBody(onDone: string, interactionPrompt?: string): string {
  return `
    const previous = window.__browserMcpPicker; if (previous?.cancel) previous.cancel();
    const overlay = document.createElement('div');
    const banner = document.createElement('div'), cursorStyle = document.createElement('style');
    Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483646', border: '2px solid #7c3aed', background: 'rgba(124,58,237,.12)', boxSizing: 'border-box', display: 'none' });
    Object.assign(banner.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '9px 14px', borderRadius: '8px', background: '#111827', color: '#fff', font: '13px/1.4 system-ui,sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.3)' });
    banner.textContent = ${JSON.stringify(interactionPrompt ?? "browser-mcp is ready — click an element · Esc to cancel")};
    cursorStyle.textContent = '* { cursor: crosshair !important; }';
    document.documentElement.append(overlay, banner, cursorStyle);
    let current = null;
    const selector = element => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        let part = node.tagName.toLowerCase();
        const stable = [...node.classList].filter(x => !/^(active|hover|focus|selected)$/.test(x)).slice(0, 2);
        if (stable.length) part += stable.map(x => '.' + CSS.escape(x)).join('');
        const parent = node.parentElement;
        if (parent && parent.querySelectorAll(':scope > ' + part).length > 1) part += ':nth-child(' + ([...parent.children].indexOf(node) + 1) + ')';
        parts.unshift(part); if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      }
      return parts.join(' > ');
    };
    const cleanup = () => { overlay.remove(); banner.remove(); cursorStyle.remove(); removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true); delete window.__browserMcpPicker; };
    const done = value => { cleanup(); ${onDone}; };
    const move = event => { current = event.target; const r = current.getBoundingClientRect(); Object.assign(overlay.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
    const click = event => { event.preventDefault(); event.stopImmediatePropagation(); const element = event.target; const r = element.getBoundingClientRect(); done({ cancelled: false, selectedAt: Date.now(), selector: selector(element), tag: element.tagName.toLowerCase(), text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300), box: { x: r.x, y: r.y, width: r.width, height: r.height }, html: element.outerHTML.slice(0, 2000) }); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); done({ cancelled: true }); } };
    window.__browserMcpPicker = { cancel: () => done({ cancelled: true, reason: 'replaced' }) };
    addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true);
    `;
}

export function pickElementScript(interactionPrompt?: string): string {
  return `new Promise(resolve => {${pickerBody("resolve(value)", interactionPrompt)}\n})`;
}
