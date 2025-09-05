/* eslint-disable @typescript-eslint/no-var-requires */
const vscode = require('vscode');
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const HAS_TW_KEY = 'tailwindPreview.hasTailwind';

  const openPreviewCmd = vscode.commands.registerCommand('tailwindPreview.openPreview', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'html') {
      vscode.window.showInformationMessage('Open an HTML file to preview.');
      return;
    }

    const doc = editor.document;
    const htmlText = doc.getText();
    const panel = vscode.window.createWebviewPanel(
      'tailwindPreview',
      `Tailwind Preview: ${doc.uri.path.split('/').pop()}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: getLocalResourceRoots(doc.uri),
      }
    );

    panel.webview.html = buildPreviewHtml(panel.webview, doc.uri, htmlText);

    // Refresh preview on save of the same document
    const saveSub = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === doc.uri.toString()) {
        panel.webview.html = buildPreviewHtml(panel.webview, doc.uri, saved.getText());
      }
    });
    panel.onDidDispose(() => saveSub.dispose());
  });

  context.subscriptions.push(openPreviewCmd);

  // Update context key when active editor changes or doc content changes
  const updateContextForEditor = (editor) => {
    const hasTw = !!(editor && editor.document.languageId === 'html' && hasTailwind(editor.document.getText()));
    vscode.commands.executeCommand('setContext', HAS_TW_KEY, hasTw);
  };

  updateContextForEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => updateContextForEditor(ed)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const active = vscode.window.activeTextEditor;
      if (active && e.document === active.document) updateContextForEditor(active);
    }),
    vscode.workspace.onDidOpenTextDocument(() => updateContextForEditor(vscode.window.activeTextEditor)),
    vscode.workspace.onDidSaveTextDocument(() => updateContextForEditor(vscode.window.activeTextEditor))
  );
}

/**
 * @param {vscode.Uri} docUri
 */
function getLocalResourceRoots(docUri) {
  const roots = [];
  try {
    const docDir = (docUri && docUri.scheme === 'file')
      ? vscode.Uri.file(path.dirname(docUri.fsPath))
      : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
          ? vscode.workspace.workspaceFolders[0].uri
          : undefined);
    if (docDir) roots.push(docDir);
  } catch {}
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) roots.push(f.uri);
  return roots;
}

/**
 * Heuristic check if HTML likely uses Tailwind.
 * @param {string} html
 */
function hasTailwind(html) {
  const h = html.toLowerCase();
  if (h.includes('cdn.tailwindcss.com')) return true;
  if (/(<link|<script)[^>]+(?:href|src)=["'][^"']*tailwind[^"']*["']/i.test(html)) return true;
  // Utility-class heuristic
  if (/class=["'][^"']*(?:\bflex\b|\bgrid\b|\bp-(?:x|y|t|r|b|l|\d)|\bm-(?:x|y|t|r|b|l|\d)|\btext-|\bbg-|\bw-|\bh-|\brounded|\bshadow|\bjustify-|\bitems-|\bgap-|\bspace-[xy]-|\bring-)/i.test(html))
    return true;
  return false;
}

/**
 * Build webview HTML that renders the user HTML with Tailwind and adds a hover tooltip.
 * - Injects <base> so relative resources resolve via asWebviewUri
 * - Relaxes CSP to allow https resources (for CDN) and local webview resources
 * - Injects a small script + styles to show classes on hover
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} docUri
 * @param {string} sourceHtml
 */
function buildPreviewHtml(webview, docUri, sourceHtml) {
  let html = sourceHtml;

  // Normalize line endings for simpler regex ops
  // 1) Inject <base> into <head> if not present, or create <head>
  const docDir = (docUri && docUri.scheme === 'file')
    ? vscode.Uri.file(path.dirname(docUri.fsPath))
    : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
        ? vscode.workspace.workspaceFolders[0].uri
        : docUri);
  const baseHref = webview.asWebviewUri(docDir).toString();

  const hasHead = /<head[^>]*>/i.test(html);
  const hasBase = /<base\s+href=/i.test(html);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource} https:; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https:; font-src ${webview.cspSource} https: data:; connect-src ${webview.cspSource} https:; frame-src ${webview.cspSource} https:;">`;
  const baseTag = `<base href="${baseHref}/">`;

  if (hasHead) {
    // Insert CSP + base right after <head ...>
    html = html.replace(/<head[^>]*>/i, (m) => {
      const inserts = [cspMeta, !hasBase ? baseTag : ''].filter(Boolean).join('');
      return m + inserts;
    });
  } else {
    // Create <head> with CSP + base before first <body> or at top
    const headBlock = `<head>${cspMeta}${!hasBase ? baseTag : ''}</head>`;
    if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html[^>]*>/i, (m) => m + headBlock);
    } else if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/<body[^>]*>/i, headBlock + '$&');
    } else {
      html = headBlock + html;
    }
  }

  // 2) Rewrite absolute-root URLs (/path) to workspace root webview resource, if possible
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length > 0) {
    const rootUri = webview.asWebviewUri(folders[0].uri).toString();
    // Replace src="/..." or href="/..." (but not protocol-relative "//...")
    html = html.replace(/(src|href)=("|')\/(?!\/)([^"']+)(\2)/gi, (_, attr, q, p, q2) => `${attr}=${q}${rootUri}/${p}${q2}`);
    // url(/...) in CSS
    html = html.replace(/url\(("|')?\/(?!\/)([^\)"']+)(\1)?\)/gi, (_, q, p) => `url(${rootUri}/${p})`);
  }

  // 3) Inject hover tooltip/highlight script just before </body> or at end
  const helperScript = getHelperScript();
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, helperScript + '</body>');
  } else {
    html = html + helperScript;
  }

  // Ensure there is an <html> wrapper for a valid doc
  if (!/<html[^>]*>/i.test(html)) {
    html = `<!DOCTYPE html><html><head>${cspMeta}${baseTag}</head><body>${html}${helperScript}</body></html>`;
  }

  return html;
}

function getHelperScript() {
  // Styles + script for tooltip and highlight overlay
  return `
<style>
  #twv-hover-outline { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #06b6d4; border-radius: 2px; box-shadow: 0 0 0 2px rgba(6,182,212,0.25); }
  #twv-tooltip { position: fixed; pointer-events: none; z-index: 2147483647; background: rgba(3, 7, 18, 0.9); color: #e5e7eb; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; padding: 6px 8px; border-radius: 6px; max-width: 70vw; white-space: pre-wrap; line-height: 1.3; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
  #twv-tooltip .twv-tag { color: #93c5fd; }
  #twv-tooltip .twv-classes { color: #fde68a; }
  #twv-tooltip .twv-none { color: #9ca3af; font-style: italic; }
  #twv-tooltip.hidden, #twv-hover-outline.hidden { display: none; }
  html, body { min-height: 100%; }
  /* Avoid covering dev content with our tooltip if near bottom-right */
@media (max-width: 500px) { #twv-tooltip { max-width: 90vw; } }
</style>
<script>
  (function(){
    try {
      const d = document;
      const outline = d.createElement('div'); outline.id = 'twv-hover-outline'; outline.className='hidden'; d.documentElement.appendChild(outline);
      const tooltip = d.createElement('div'); tooltip.id = 'twv-tooltip'; tooltip.className='hidden'; d.documentElement.appendChild(tooltip);

      function isOurNode(node) {
        return node && (node.id === 'twv-hover-outline' || node.id === 'twv-tooltip' || node.closest && (node.closest('#twv-hover-outline') || node.closest('#twv-tooltip')));
      }

      function updateUI(target, x, y) {
        if (!target || isOurNode(target) || !(target instanceof Element)) { hideUI(); return; }
        const rect = target.getBoundingClientRect();
        outline.style.left = rect.left + 'px';
        outline.style.top = rect.top + 'px';
        outline.style.width = rect.width + 'px';
        outline.style.height = rect.height + 'px';
        outline.classList.remove('hidden');

        const classes = Array.from(target.classList || []);
        const tag = target.tagName.toLowerCase();
        const id = target.id ? '#' + target.id : '';
        const clsStr = classes.length ? classes.join(' ') : '';
        tooltip.innerHTML = '<span class="twv-tag">' + tag + id + '</span>' + (clsStr ? ' · <span class="twv-classes">' + clsStr.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' : ' · <span class="twv-none">no classes</span>');

        const tw = tooltip.getBoundingClientRect().width;
        const th = tooltip.getBoundingClientRect().height;
        let tx = x + 12; let ty = y + 12;
        const vw = window.innerWidth; const vh = window.innerHeight;
        if (tx + tw + 8 > vw) tx = Math.max(8, vw - tw - 8);
        if (ty + th + 8 > vh) ty = Math.max(8, vh - th - 8);
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
        tooltip.classList.remove('hidden');
      }

      function hideUI(){ outline.classList.add('hidden'); tooltip.classList.add('hidden'); }

      let lastEl = null;
      function onMove(e){
        const x = e.clientX; const y = e.clientY;
        // Move tooltip away first so elementFromPoint can hit underlying element
        tooltip.style.left = '-10000px'; tooltip.style.top = '-10000px';
        const el = d.elementFromPoint(x, y);
        if (!el || isOurNode(el)) { hideUI(); return; }
        if (el !== lastEl) { lastEl = el; }
        updateUI(el, x, y);
      }
      d.addEventListener('mousemove', onMove, { capture: true, passive: true });
      d.addEventListener('mouseleave', hideUI, { capture: true, passive: true });
      window.addEventListener('scroll', () => { if (lastEl) { const r = lastEl.getBoundingClientRect(); outline.style.left=r.left+'px'; outline.style.top=r.top+'px'; outline.style.width=r.width+'px'; outline.style.height=r.height+'px'; } }, { passive: true });
    } catch (e) { console.error('twv helper error', e); }
  })();
</script>
`;
}

function deactivate() {}

module.exports = { activate, deactivate };
