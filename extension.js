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

    // Store mapping from preview element uid -> source class attr offsets
    let classOffsetMap = new Map();
    const setPreview = () => {
      const prepared = preparePreviewHtml(panel.webview, doc.uri, htmlText);
      classOffsetMap = prepared.mapping;
      panel.webview.html = prepared.html;
    };

    setPreview();

    // Refresh preview on save of the same document
    const saveSub = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === doc.uri.toString()) {
        const prepared = preparePreviewHtml(panel.webview, doc.uri, saved.getText());
        classOffsetMap = prepared.mapping;
        panel.webview.html = prepared.html;
      }
    });
    panel.onDidDispose(() => saveSub.dispose());

    // Handle class updates from the preview
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (!msg || !msg.type) return;
        if (msg.type === 'updateClasses') {
          const { uid, newValue } = msg;
          if (!uid || typeof newValue !== 'string') return;

          const info = classOffsetMap.get(String(uid));
          if (!info) {
            vscode.window.showWarningMessage('Could not map edited element back to source. Reopen preview.');
            return;
          }

          // Compute range in the current document from recorded offsets
          const startPos = doc.positionAt(info.start);
          const endPos = doc.positionAt(info.end);
          const currentText = doc.getText(new vscode.Range(startPos, endPos));
          // Optional safety: if the source diverged, warn and skip
          if (typeof info.original === 'string' && currentText !== info.original) {
            vscode.window.showWarningMessage('Source changed since preview was opened. Please reopen the preview.');
            return;
          }

          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, new vscode.Range(startPos, endPos), newValue);
          const ok = await vscode.workspace.applyEdit(edit);
          if (!ok) {
            vscode.window.showErrorMessage('Failed to apply Tailwind class edit to source.');
            return;
          }
          // Update our record to the new value so subsequent edits validate correctly
          classOffsetMap.set(String(uid), { ...info, original: newValue });
        } else if (msg.type === 'updateDynamicTemplate') {
          const before = (msg && typeof msg.before === 'string') ? msg.before : '';
          const after = (msg && typeof msg.after === 'string') ? msg.after : '';
          if (!before || !after || before === after) return;

          const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const dqRe = new RegExp(`"${escapeRe(before)}"`, 'g');
          const sqRe = new RegExp(`'${escapeRe(before)}'`, 'g');
          const btRe = new RegExp('`' + escapeRe(before) + '`', 'g');

          const edits = new vscode.WorkspaceEdit();
          const changed = new Set();

          // 1) Inline <script> blocks within this HTML file
          {
            const full = doc.getText();
            const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
            let m;
            let newText = '';
            let lastIndex = 0;
            while ((m = scriptRe.exec(full)) !== null) {
              const openEnd = m.index + m[0].indexOf('>') + 1;
              const innerStart = openEnd;
              const innerEnd = m.index + m[0].length - '</script>'.length;
              const beforeScript = full.slice(lastIndex, innerStart);
              const inner = full.slice(innerStart, innerEnd);
              const afterScript = full.slice(innerEnd, scriptRe.lastIndex);
              let replacedInner = inner.replace(dqRe, `"${after}"`).replace(sqRe, `'${after}'`).replace(btRe, '`' + after + '`');
              newText += beforeScript + replacedInner + afterScript;
              lastIndex = scriptRe.lastIndex;
            }
            newText += full.slice(lastIndex);
            if (newText !== full) {
              const all = new vscode.Range(doc.positionAt(0), doc.positionAt(full.length));
              edits.replace(doc.uri, all, newText);
              changed.add(doc.uri.toString());
            }
          }

          // 2) External <script src="..."> files (workspace-local)
          try {
            const full = doc.getText();
            const srcRe = /<script\b[^>]*\bsrc=("|')([^"']+)\1[^>]*>/gi;
            let m;
            const files = [];
            const docDir = (doc.uri.scheme === 'file') ? vscode.Uri.file(path.dirname(doc.uri.fsPath)) : null;
            while ((m = srcRe.exec(full)) !== null) {
              const src = (m[2] || '').trim();
              if (!src || /^https?:/i.test(src) || /^\/\//.test(src)) continue;
              let uri = null;
              if (src.startsWith('/')) {
                const folders = vscode.workspace.workspaceFolders || [];
                if (folders.length > 0) uri = vscode.Uri.joinPath(folders[0].uri, ...src.slice(1).split('/'));
              } else if (docDir) {
                uri = vscode.Uri.joinPath(docDir, ...src.split('/'));
              }
              if (uri) files.push(uri);
            }
            for (const uri of files) {
              try {
                const buf = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(buf).toString('utf8');
                const replaced = text.replace(dqRe, `"${after}"`).replace(sqRe, `'${after}'`).replace(btRe, '`' + after + '`');
                if (replaced !== text) {
                  const fileDoc = await vscode.workspace.openTextDocument(uri);
                  const all = new vscode.Range(fileDoc.positionAt(0), fileDoc.positionAt(text.length));
                  edits.replace(uri, all, replaced);
                  changed.add(uri.toString());
                }
              } catch {}
            }
          } catch {}

          if (changed.size > 0) {
            const ok = await vscode.workspace.applyEdit(edits);
            if (!ok) vscode.window.showErrorMessage('Failed to update dynamic class template in source.');
          }
        }
      } catch (e) {
        console.error('Failed to handle updateClasses', e);
        vscode.window.showErrorMessage('Error updating classes in source. Check console for details.');
      }
    });
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
function preparePreviewHtml(webview, docUri, sourceHtml) {
  const { annotatedHtml, mapping } = annotateHtmlForClassOffsets(sourceHtml);
  let html = annotatedHtml;

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

  return { html, mapping };
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
  #twv-editor { position: fixed; z-index: 2147483647; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.45); width: min(70vw, 560px); }
  #twv-editor textarea { display:block; width: 100%; background: #0b1220; color: #e5e7eb; border: 1px solid #374151; border-radius: 4px; padding: 6px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow: hidden; resize: none; min-height: 28px; max-height: 60vh; box-sizing: border-box; }
  #twv-editor .twv-actions { margin-top: 6px; display: flex; gap: 6px; justify-content: flex-end; }
  #twv-editor button { background: #0ea5e9; color: #0b1220; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; }
  #twv-editor button.twv-cancel { background: #374151; color: #e5e7eb; }
  /* Pause/Play controls */
  #twv-controls { position: fixed; top: 8px; right: 8px; z-index: 2147483648; display: flex; gap: 6px; }
  #twv-controls button { background: rgba(17,24,39,0.9); color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  #twv-controls button:hover { background: #111827; }
  #twv-controls svg { width: 14px; height: 14px; fill: currentColor; }
  /* Interaction shield shown when paused */
  #twv-shield { position: fixed; inset: 0; z-index: 2147483644; background: transparent; display: none; pointer-events: none; }
  html.twv-paused #twv-shield { display: block; }
  /* Freeze animations and transitions when paused */
  html.twv-paused body, html.twv-paused body * { cursor: default !important; }
  html.twv-paused *, html.twv-paused *::before, html.twv-paused *::after { animation-play-state: paused !important; transition: none !important; }
</style>
<script>
  (function(){
    try {
      const d = document;
      const outline = d.createElement('div'); outline.id = 'twv-hover-outline'; outline.className='hidden'; d.documentElement.appendChild(outline);
      const tooltip = d.createElement('div'); tooltip.id = 'twv-tooltip'; tooltip.className='hidden'; d.documentElement.appendChild(tooltip);
      const editor = d.createElement('div'); editor.id = 'twv-editor'; editor.style.display = 'none';
      editor.innerHTML = '<div id="twv-title" style="margin-bottom:6px;color:#9ca3af">Edit Tailwind classes</div>'+
        '<textarea id="twv-input" spellcheck="false" rows="1" wrap="soft" aria-label="Tailwind classes"></textarea>'+
        '<div class="twv-actions"><button class="twv-cancel">Cancel</button><button class="twv-save">Save</button></div>';
      d.documentElement.appendChild(editor);
      const input = editor.querySelector('#twv-input');
      const titleEl = editor.querySelector('#twv-title');
      const btnSave = editor.querySelector('.twv-save');
      const btnCancel = editor.querySelector('.twv-cancel');
      const vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;

      // Runtime class template rules: when a dynamic element is edited (no source uid),
      // remember its original->new class set and apply to future matching elements.
      const runtimeClassRules = [];
      function canonTokens(str) { return (str || '').trim().split(/\s+/).filter(Boolean).sort(); }
      function canonKey(str) { return canonTokens(str).join(' '); }
      function findAnchor(tokens) {
        // Pick a simple, CSS-safe class token to anchor queries (e.g., 'token-word')
        for (const t of tokens) { if (/^[A-Za-z_][\w-]*$/.test(t)) return t; }
        return null;
      }
      function applyRulesToElement(el) {
        if (!(el instanceof Element)) return;
        const curKey = canonKey(el.getAttribute('class') || '');
        for (const r of runtimeClassRules) {
          if (curKey === r.oldKey) { el.setAttribute('class', r.newValue); break; }
        }
      }
      function applyRuleGlobally(rule) {
        try {
          const anchor = rule.anchorClass;
          if (anchor) {
            // Escape CSS identifier safely for simple classes
            const sel = '.' + anchor.replace(/([^A-Za-z0-9_-])/g, '\\$1');
            d.querySelectorAll(sel).forEach(applyRulesToElement);
          } else {
            // Fallback: scan a bounded set if no safe anchor
            Array.from(d.querySelectorAll('[class]')).slice(0, 5000).forEach(applyRulesToElement);
          }
        } catch (e) { console.warn('applyRuleGlobally error', e); }
      }
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            m.addedNodes && m.addedNodes.forEach((n) => {
              if (n.nodeType === 1) {
                applyRulesToElement(n);
                // Also apply to descendants
                n.querySelectorAll && n.querySelectorAll('[class]').forEach(applyRulesToElement);
              }
            });
          }
        }
      });
      mo.observe(d.documentElement, { childList: true, subtree: true });

      // Interaction shield and pause/resume controls
      const shield = d.createElement('div');
      shield.id = 'twv-shield';
      d.documentElement.appendChild(shield);
      const controls = d.createElement('div');
      controls.id = 'twv-controls';
      controls.innerHTML = '<button id="twv-toggle" title="Pause interactions"><span class="twv-icon"></span><span class="twv-label">Pause</span></button>';
      d.documentElement.appendChild(controls);
      const toggleBtn = controls.querySelector('#twv-toggle');
      const iconSpan = toggleBtn.querySelector('.twv-icon');
      const labelSpan = toggleBtn.querySelector('.twv-label');
      let paused = false;
      const playSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      const pauseSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
      function setPaused(on) {
        paused = !!on;
        d.documentElement.classList.toggle('twv-paused', paused);
        if (paused) {
          iconSpan.innerHTML = playSvg; labelSpan.textContent = 'Resume'; toggleBtn.title = 'Resume interactions';
          try { d.querySelectorAll('video, audio').forEach(el => { try { if (!el.paused && typeof el.pause === 'function') el.pause(); } catch(_){} }); } catch(_){}
        } else {
          iconSpan.innerHTML = pauseSvg; labelSpan.textContent = 'Pause'; toggleBtn.title = 'Pause interactions';
        }
      }
      // Initialize button state
      iconSpan.innerHTML = pauseSvg;
      toggleBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setPaused(!paused); });
      d.addEventListener('keydown', (e) => { if ((e.key === 'p' || e.key === 'P') && !(e.metaKey||e.ctrlKey||e.altKey||e.shiftKey)) { e.stopPropagation(); setPaused(!paused); } }, { capture: true });

      function isOurNode(node) {
        return node && (
          node.id === 'twv-hover-outline' || node.id === 'twv-tooltip' || node.id === 'twv-editor' || node.id === 'twv-shield' || node.id === 'twv-controls' ||
          (node.closest && (node.closest('#twv-hover-outline') || node.closest('#twv-tooltip') || node.closest('#twv-editor') || node.closest('#twv-controls')))
        );
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
      function findPointerNoneOverlayAt(x, y) {
        if (!paused) return null;
        try {
          const cand = Array.from(d.querySelectorAll('.pointer-events-none, [style*="pointer-events: none"]'))
            .filter((n) => n instanceof Element && !isOurNode(n))
            .filter((n) => {
              const r = n.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            })
            .map((n) => {
              const cs = getComputedStyle(n);
              const zi = parseInt(cs.zIndex, 10);
              const z = Number.isFinite(zi) ? zi : 0;
              const pos = cs.position || '';
              const bonus = (pos === 'fixed' ? 3 : pos === 'sticky' ? 2 : pos === 'absolute' ? 1 : 0);
              return { n, z: z * 10 + bonus };
            })
            .sort((a, b) => b.z - a.z);
          return cand.length ? cand[0].n : null;
        } catch { return null; }
      }

      function underlyingElementAt(x, y) {
        // Temporarily move our tooltip away so it doesn't block hit testing
        const prevLeft = tooltip.style.left, prevTop = tooltip.style.top;
        tooltip.style.left = '-10000px'; tooltip.style.top = '-10000px';
        // Prefer elementsFromPoint to include elements with pointer-events:none (e.g., tooltips)
        let el = null;
        if (typeof d.elementsFromPoint === 'function') {
          const list = d.elementsFromPoint(x, y) || [];
          el = list.find((n) => n instanceof Element && !isOurNode(n)) || null;
        } else {
          el = d.elementFromPoint(x, y);
          if (el && isOurNode(el)) el = null;
        }
        // If paused, prefer a visually-overlapping pointer-events:none overlay at this point
        const maybeOverlay = findPointerNoneOverlayAt(x, y);
        if (maybeOverlay) el = maybeOverlay;
        // Restore tooltip position
        tooltip.style.left = prevLeft; tooltip.style.top = prevTop;
        return el;
      }
      function onMove(e){
        const x = e.clientX; const y = e.clientY;
        const el = underlyingElementAt(x, y);
        if (!el || isOurNode(el)) { hideUI(); return; }
        if (el !== lastEl) { lastEl = el; }
        updateUI(el, x, y);
      }
      d.addEventListener('mousemove', onMove, { capture: true, passive: true });
      d.addEventListener('mouseleave', hideUI, { capture: true, passive: true });
      window.addEventListener('scroll', () => { if (lastEl) { const r = lastEl.getBoundingClientRect(); outline.style.left=r.left+'px'; outline.style.top=r.top+'px'; outline.style.width=r.width+'px'; outline.style.height=r.height+'px'; } }, { passive: true });

      function openEditorFor(el, x, y) {
        try {
          if (!el || !(el instanceof Element)) return;
          // Find a source-mapped element if present (may be the same as el)
          const uidEl = (el.closest && el.closest('[data-twv-uid]')) || null;
          const uid = uidEl ? uidEl.getAttribute('data-twv-uid') : null;
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth; const vh = window.innerHeight;
          const ex = Math.min(vw - 16, Math.max(8, (x || rect.left) + 12));
          const ey = Math.min(vh - 16, Math.max(8, (y || rect.top) + 12));
          input.value = (el.getAttribute('class') || '').trim();
          editor.style.left = ex + 'px'; editor.style.top = ey + 'px';
          editor.style.display = 'block';

          // Auto-size the textarea to fit content up to a max height
          function autosize() {
            try {
              input.style.height = 'auto';
              // Use scrollHeight to grow; clamp by max-height via CSS
              const sh = input.scrollHeight;
              input.style.height = Math.min(sh, Math.round(window.innerHeight * 0.6)) + 'px';
              // Keep editor within viewport if content growth pushes it off-screen
              fitInViewport();
            } catch {}
          }
          function fitInViewport() {
            const r = editor.getBoundingClientRect();
            let nx = r.left; let ny = r.top;
            if (r.right > vw - 8) nx = Math.max(8, vw - 8 - r.width);
            if (r.bottom > vh - 8) ny = Math.max(8, vh - 8 - r.height);
            if (r.left < 8) nx = 8;
            if (r.top < 8) ny = 8;
            editor.style.left = nx + 'px';
            editor.style.top = ny + 'px';
          }

          autosize();
          input.focus(); input.select();
          // Keep resizing as the user types or pastes
          input.addEventListener('input', autosize);
          // Resize on window changes too
          window.addEventListener('resize', autosize, { passive: true });
          if (titleEl) {
            if (uid && uidEl === el) {
              titleEl.textContent = 'Edit Tailwind classes';
            } else if (uid) {
              titleEl.textContent = 'Edit Tailwind classes (preview only)';
            } else {
              titleEl.textContent = 'Edit Tailwind classes (preview only)';
            }
          }

          function commit() {
            const beforeVal = (el.getAttribute('class') || '').trim();
            const newVal = input.value.trim();
            el.setAttribute('class', newVal);
            if (beforeVal !== newVal) {
              // Only persist to source if we are editing the mapped element itself
              if (vscodeApi && uid && uidEl === el) {
                vscodeApi.postMessage({ type: 'updateClasses', uid, newValue: newVal });
              } else if (vscodeApi) {
                // Register a runtime rule so future dynamic nodes match the new classes
                const oldKey = canonKey(beforeVal);
                const newKey = canonKey(newVal);
                if (oldKey && newKey) {
                  const anchorClass = findAnchor(canonTokens(beforeVal));
                  runtimeClassRules.push({ oldKey, newValue: newVal, anchorClass });
                  applyRuleGlobally({ oldKey, newValue: newVal, anchorClass });
                }
                // Suggest updating string literals inside <script> tags in source
                vscodeApi.postMessage({ type: 'updateDynamicTemplate', before: beforeVal, after: newVal });
              }
            }
            close();
          }
          function close() {
            editor.style.display = 'none';
            input.blur();
            d.removeEventListener('keydown', onKey);
            input.removeEventListener('input', autosize);
            window.removeEventListener('resize', autosize);
          }
          function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            // Enter without Shift commits; Shift+Enter inserts newline
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); commit(); }
          }
          d.addEventListener('keydown', onKey, { capture: true });
          btnCancel.onclick = (ev) => { ev.preventDefault(); close(); };
          btnSave.onclick = (ev) => { ev.preventDefault(); commit(); };
        } catch (e) { console.error('openEditor error', e); }
      }

      d.addEventListener('dblclick', (e) => {
        let el = e.target;
        if (!el || isOurNode(el) || paused) {
          el = underlyingElementAt(e.clientX, e.clientY);
        }
        if (!el || isOurNode(el)) return;
        e.preventDefault(); e.stopPropagation();
        openEditorFor(el, e.clientX, e.clientY);
      }, { capture: true });

      // Swallow most interactions while paused to avoid mutating app state
      const swallow = (ev) => {
        if (!paused) return;
        // Allow interactions with our own UI controls/editor
        const path = ev.composedPath ? ev.composedPath() : [];
        const t = ev.target;
        const inOurUi = (n) => !!n && (
          (n.id === 'twv-controls' || n.id === 'twv-editor' || n.id === 'twv-tooltip' || n.id === 'twv-hover-outline') ||
          (n.closest && (n.closest('#twv-controls') || n.closest('#twv-editor') || n.closest('#twv-tooltip') || n.closest('#twv-hover-outline')))
        );
        if (inOurUi(t) || (Array.isArray(path) && path.some(inOurUi))) return;
        ev.stopImmediatePropagation();
        ev.preventDefault();
      };
      [
        'click','dblclick','mousedown','mouseup','pointerdown','pointerup','pointermove','mousemove','contextmenu',
        'touchstart','touchend','dragstart','dragover','drop',
        'mouseover','mouseout','mouseenter','mouseleave'
      ].forEach(t => { d.addEventListener(t, swallow, { capture: true }); });
    } catch (e) { console.error('twv helper error', e); }
  })();
</script>
`;
}

// Annotate the HTML source by adding data-twv-uid to elements with a class attribute
// and compute a mapping of uid -> { start, end, original }
function annotateHtmlForClassOffsets(sourceHtml) {
  try {
    const mapping = new Map();
    let out = '';
    let last = 0;
    let uidCounter = 1;

    const tagRe = /<([a-zA-Z][\w:-]*)([^>]*)>/g; // start tags (simple heuristic)
    let m;
    while ((m = tagRe.exec(sourceHtml)) !== null) {
      const full = m[0];
      const tagName = m[1];
      const attrs = m[2] || '';
      // Ignore closing or doctype etc (already filtered by regex)

      // Find class attribute in attrs
      const classRe = /\bclass\s*=\s*(["'])([\s\S]*?)\1/i; // match quoted value, don't cross tag because attrs excludes '>'
      const cm = classRe.exec(attrs);
      if (!cm) continue;

      // Compute offsets for the class value inside the document
      const quote = cm[1];
      const classValue = cm[2];
      const attrsStartInFull = 1 + tagName.length; // after '<tag'
      // Position of the opening quote within attrs string
      const openQuoteInAttrs = cm.index + (cm[0].indexOf(quote));
      const valueStartInAttrs = openQuoteInAttrs + 1;
      const valueEndInAttrs = valueStartInAttrs + classValue.length;

      const tagStartInDoc = m.index;
      const valueStartInDoc = tagStartInDoc + attrsStartInFull + valueStartInAttrs;
      const valueEndInDoc = tagStartInDoc + attrsStartInFull + valueEndInAttrs;

      // Inject data-twv-uid before the closing '>' (or '/>')
      const closeIsSelf = /\/>\s*$/.test(full);
      const injection = ` data-twv-uid="${uidCounter}"`;
      const insertPosInFull = full.length - (closeIsSelf ? 2 : 1);
      const newStartTag = full.slice(0, insertPosInFull) + injection + full.slice(insertPosInFull);

      // Append replaced segment to output
      out += sourceHtml.slice(last, tagStartInDoc) + newStartTag;
      last = tagStartInDoc + full.length;

      mapping.set(String(uidCounter), { start: valueStartInDoc, end: valueEndInDoc, original: classValue });
      uidCounter++;
    }

    out += sourceHtml.slice(last);
    return { annotatedHtml: out, mapping };
  } catch (e) {
    console.error('annotateHtmlForClassOffsets error', e);
    // Fallback: no annotation
    return { annotatedHtml: sourceHtml, mapping: new Map() };
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
