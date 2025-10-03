/* eslint-disable @typescript-eslint/no-var-requires */
const vscode = require('vscode');
const path = require('path');
let parse5 = null; // lazy-loaded for preview mapping

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const HAS_TW_KEY = 'tailwindPreview.hasTailwind';
  // Track the most recently modified document so server preview undo/redo can target it
  /** @type {vscode.Uri | null} */
  let lastTouchedDocUri = null;

  // Lazy HTTP server for serving the remote preview client helper script
  let clientServer = null;
  let clientServerPort = null;
  async function getOrStartClientServer() {
    if (clientServer && clientServerPort) return { port: clientServerPort };
    const http = require('http');
    const net = require('net');
    const CLIENT_PATH = '/twv-client.js';
    const script = getRemoteClientScript();

    // Pick a port: try 7832, fall back to an ephemeral port
    async function findPort(preferred) {
      function tryListen(p) {
        return new Promise((resolve) => {
          const srv = net.createServer();
          srv.once('error', () => resolve(null));
          srv.once('listening', () => srv.close(() => resolve(p)));
          srv.listen(p, '127.0.0.1');
        });
      }
      let p = preferred ? await tryListen(preferred) : null;
      if (!p) p = await tryListen(0); // ephemeral
      return p;
    }

    const port = await findPort(7832);
    clientServerPort = port;
    clientServer = http.createServer((req, res) => {
      try {
        // Basic routing
        const u = new URL(req.url || '/', `http://localhost:${port}`);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        if (u.pathname === CLIENT_PATH && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(script);
          return;
        }
        if (u.pathname === '/health') {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end('ok');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end('not found');
      } catch (e) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
          res.end('error');
        } catch {}
      }
    });
    await new Promise((resolve) => clientServer.listen(port, '127.0.0.1', resolve));
    context.subscriptions.push({ dispose: () => { try { clientServer && clientServer.close(); } catch {} } });
    return { port };
  }

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

    // Handle class updates, undo/redo, and clipboard from the preview
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (!msg || !msg.type) return;
        if (msg.type === 'twvClipboardWrite' && typeof msg.text === 'string') {
          try { await vscode.env.clipboard.writeText(msg.text); } catch {}
          return;
        }
        if (msg.type === 'undo' || msg.type === 'redo') {
          try {
            // Bring the source document to the foreground, run undo/redo, save, then re-focus preview
            await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
            await vscode.commands.executeCommand(msg.type === 'undo' ? 'undo' : 'redo');
            try { await doc.save(); } catch {}
            try { panel.reveal(); } catch {}
          } catch (e) {
            console.error('Undo/redo failed', e);
            vscode.window.showErrorMessage('Undo/redo failed.');
          }
          return;
        }
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
          // Auto-save the edited document
          try { await doc.save(); lastTouchedDocUri = doc.uri; } catch {}
          // Update our mapping in-memory to reflect the new lengths so follow-up edits work pre-save
          try {
            const oldLen = (info.end - info.start);
            const newLen = newValue.length;
            const delta = newLen - oldLen;
            const updated = { ...info, original: newValue, end: info.start + newLen };
            classOffsetMap.set(String(uid), updated);
            if (delta !== 0) {
              // Shift subsequent offsets appearing after this range
              for (const [k, v] of classOffsetMap.entries()) {
                if (k === String(uid)) continue;
                if (typeof v.start === 'number' && v.start > info.end) {
                  classOffsetMap.set(k, { ...v, start: v.start + delta, end: v.end + delta });
                }
              }
            }
          } catch {}
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
            if (!ok) {
              vscode.window.showErrorMessage('Failed to update dynamic class template in source.');
            } else {
              // Auto-save each changed file
              for (const uriStr of changed) {
                try {
                  const uri = vscode.Uri.parse(uriStr);
                  const docToSave = await vscode.workspace.openTextDocument(uri);
                  await docToSave.save();
                  lastTouchedDocUri = uri;
                } catch {}
              }
            }
          }
        }
      } catch (e) {
        console.error('Failed to handle updateClasses', e);
        vscode.window.showErrorMessage('Error updating classes in source. Check console for details.');
      }
    });
  });

  context.subscriptions.push(openPreviewCmd);

  const openServerPreviewCmd = vscode.commands.registerCommand('tailwindPreview.openServerPreview', async () => {
    try {
      const { port } = await getOrStartClientServer();

      // Ask for server URL (default vite port)
      const lastUrl = context.globalState.get('tailwindPreview.serverUrl') || 'http://localhost:5173/';
      const serverUrl = await vscode.window.showInputBox({
        title: 'Enter dev server URL (Vite, etc.)',
        value: lastUrl,
        prompt: 'Example: http://localhost:5173/',
        validateInput: (val) => {
          try { new URL(val); return ''; } catch { return 'Invalid URL'; }
        }
      });
      if (!serverUrl) return;
      context.globalState.update('tailwindPreview.serverUrl', serverUrl);

      const panel = vscode.window.createWebviewPanel(
        'tailwindPreviewServer',
        `Tailwind Server Preview`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      const iframeUrl = serverUrl;
      const clientUrl = `http://127.0.0.1:${port}/twv-client.js`;
      panel.webview.html = buildServerPreviewHtml(panel.webview, iframeUrl, clientUrl);

      panel.webview.onDidReceiveMessage(async (msg) => {
        try {
          if (!msg || !msg.type) return;
          if (msg.type === 'twvClipboardWrite' && typeof msg.text === 'string') {
            try { await vscode.env.clipboard.writeText(msg.text); } catch {}
            return;
          }
          if (msg.type === 'serverUndo' || msg.type === 'serverRedo') {
            try {
              // Prefer undo/redo on the last touched document
              try {
                const uri = (typeof lastTouchedDocUri !== 'undefined' && lastTouchedDocUri) ? lastTouchedDocUri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document && vscode.window.activeTextEditor.document.uri);
                if (uri) {
                  const d = await vscode.workspace.openTextDocument(uri);
                  await vscode.window.showTextDocument(d, { preserveFocus: false, preview: false });
                }
              } catch {}
              await vscode.commands.executeCommand(msg.type === 'serverUndo' ? 'undo' : 'redo');
              // Save the active file to encourage dev servers to reload
              try { await vscode.commands.executeCommand('workbench.action.files.save'); } catch {}
            } catch (e) {
              console.error('server undo/redo error', e);
              vscode.window.showErrorMessage('Server preview undo/redo failed.');
            }
            return;
          }
          if (msg.type === 'copyToClipboard' && typeof msg.text === 'string') {
            try {
              await vscode.env.clipboard.writeText(msg.text);
              vscode.window.showInformationMessage('Copied script tag to clipboard.');
            } catch (e) {
              vscode.window.showErrorMessage('Failed to copy to clipboard.');
            }
            return;
          }
          if (msg.type === 'serverUpdateClasses' || msg.type === 'serverUpdateDynamicTemplate' || msg.type === 'updateDynamicTemplate') {
            const before = (msg && typeof msg.before === 'string') ? msg.before : '';
            const after = (msg && typeof msg.after === 'string') ? msg.after : '';
            if (!before || !after || before === after) return;
            const result = await persistDynamicClassEditSmart(before, after, { text: (msg && typeof msg.text === 'string') ? msg.text : '', tag: (msg && typeof msg.tag === 'string') ? msg.tag : '', id: (msg && typeof msg.id === 'string') ? msg.id : '' });
            const changedCount = (result && typeof result.changed === 'number') ? result.changed : (typeof result === 'number' ? result : 0);
            if (changedCount > 0) {
              try { if (result && result.lastUri) { lastTouchedDocUri = vscode.Uri.parse(result.lastUri); } } catch {}
              vscode.window.showInformationMessage(`Updated and saved ${changedCount} file(s) with new Tailwind classes.`);
            } else if (changedCount === 0) {
              vscode.window.showInformationMessage('No matching class string found to persist. The classes may be composed dynamically; try editing the template/HTML or ensure the exact class string exists in a string literal.');
            }
          }
        } catch (e) {
          console.error('server preview message error', e);
        }
      });
    } catch (e) {
      vscode.window.showErrorMessage('Failed to open server preview. See console for details.');
      console.error(e);
    }
  });

  context.subscriptions.push(openServerPreviewCmd);

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

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} http: https: data:; media-src ${webview.cspSource} http: https:; style-src 'unsafe-inline' ${webview.cspSource} http: https:; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} http: https:; font-src ${webview.cspSource} http: https: data:; connect-src ${webview.cspSource} http: https:; frame-src ${webview.cspSource} http: https:;">`;
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
  #twv-editor button.twv-llm { background: #8b5cf6; color: #fff; display: none; }
  #twv-editor button.twv-llm.visible { display: inline-block; }
  /* Pause/Play controls */
  #twv-controls { position: fixed; top: 8px; right: 8px; z-index: 2147483648; display: flex; gap: 6px; }
  #twv-controls button { background: rgba(17,24,39,0.9); color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  #twv-controls button:hover { background: #111827; }
  #twv-controls svg { width: 14px; height: 14px; fill: currentColor; }
  /* Settings modal */
  #twv-settings-overlay { position: fixed; inset: 0; z-index: 2147483649; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; }
  #twv-settings-overlay.visible { display: flex; }
  #twv-settings-modal { background: #111827; border: 1px solid #374151; border-radius: 8px; padding: 20px; width: min(90vw, 480px); box-shadow: 0 20px 50px rgba(0,0,0,0.6); position: relative; }
  #twv-settings-modal h3 { margin: 0 0 16px 0; color: #e5e7eb; font-size: 18px; font-weight: 600; }
  #twv-settings-modal .close-btn { position: absolute; top: 12px; right: 12px; background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 24px; line-height: 1; padding: 4px 8px; }
  #twv-settings-modal .close-btn:hover { color: #e5e7eb; }
  #twv-settings-modal label { display: block; color: #9ca3af; font-size: 13px; margin-bottom: 6px; margin-top: 12px; }
  #twv-settings-modal label:first-of-type { margin-top: 0; }
  #twv-settings-modal input { display: block; width: 100%; background: #0b1220; color: #e5e7eb; border: 1px solid #374151; border-radius: 4px; padding: 8px 10px; font-size: 13px; font-family: ui-monospace, monospace; box-sizing: border-box; }
  #twv-settings-modal input:focus { outline: none; border-color: #0ea5e9; }
  #twv-settings-modal .hint { color: #6b7280; font-size: 11px; margin-top: 4px; }
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
      editor.innerHTML = '<div id="twv-title" style="margin-bottom:4px;color:#9ca3af;font-size:13px;font-weight:500;">Edit Tailwind classes</div>'+
        '<div style="margin-bottom:8px;color:#6b7280;font-size:11px;line-height:1.4;">Type " -- [prompt]" to the end of your classes for AI edits</div>'+
        '<textarea id="twv-input" spellcheck="false" rows="1" wrap="soft" aria-label="Tailwind classes"></textarea>'+
        '<div class="twv-actions"><button class="twv-cancel">Cancel</button><button class="twv-llm">Send to LLM</button><button class="twv-save">Save</button></div>';
      d.documentElement.appendChild(editor);
      const input = editor.querySelector('#twv-input');
      const titleEl = editor.querySelector('#twv-title');
      const btnSave = editor.querySelector('.twv-save');
      const btnCancel = editor.querySelector('.twv-cancel');
      const btnLLM = editor.querySelector('.twv-llm');
      
      // LLM API Configuration (defaults)
      const DEFAULT_OPENROUTER_API_KEY = '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';
      const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-oss-120b';
      
      // Get current settings (custom or default)
      function getLLMSettings() {
        try {
          const customKey = localStorage.getItem('twv-openrouter-key');
          const customModel = localStorage.getItem('twv-openrouter-model');
          return {
            apiKey: customKey || DEFAULT_OPENROUTER_API_KEY,
            model: customModel || DEFAULT_OPENROUTER_MODEL
          };
        } catch (e) {
          console.error('[TWV LLM] Error reading settings:', e);
          return {
            apiKey: DEFAULT_OPENROUTER_API_KEY,
            model: DEFAULT_OPENROUTER_MODEL
          };
        }
      }
      
      // Detect "--" in input and show/hide LLM button
      function updateLLMButtonVisibility() {
          try {
            const value = input.value || '';
            if (value.includes(' -- ')) {
              btnLLM.classList.add('visible');
            } else {
              btnLLM.classList.remove('visible');
            }
          } catch (e) {
            console.error('[TWV LLM] Error updating button visibility:', e);
          }
      }
      
      // Call OpenRouter API to edit classes
      async function callLLMToEditClasses(classesText, userPrompt) {
        try {
          const settings = getLLMSettings();
          console.log('[TWV LLM] Starting API call');
          console.log('[TWV LLM] Using model:', settings.model);
          console.log('[TWV LLM] Classes:', classesText);
          console.log('[TWV LLM] User prompt:', userPrompt);
          
          const systemPrompt = 'Edit these tailwind classes <tailwind_classes>' + classesText + '</tailwind_classes> and return the new, full, edited tailwind, according to the following prompt: <user_prompt>' + userPrompt + '</user_prompt> Return your classes in the format: <edited_tw> updated class list here </edited_tw>';
          
          console.log('[TWV LLM] Sending request to OpenRouter API');
          
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + settings.apiKey,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/user/TailwindVSCode',
              'X-Title': 'Tailwind VSCode Extension'
            },
            body: JSON.stringify({
              model: settings.model,
              messages: [
                { role: 'user', content: systemPrompt }
              ]
            })
          });
          
          console.log('[TWV LLM] Response status:', response.status);
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('[TWV LLM] API error response:', errorText);
            throw new Error('OpenRouter API request failed: ' + response.status + ' - ' + errorText);
          }
          
          const data = await response.json();
          console.log('[TWV LLM] API response data:', JSON.stringify(data, null, 2));
          
          const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (!content) {
            console.error('[TWV LLM] No content in response');
            throw new Error('No content in API response');
          }
          
          console.log('[TWV LLM] Raw content:', content);
          
          // Extract classes from <edited_tw> tags
          const match = content.match(/<edited_tw>\s*([\s\S]*?)\s*<\/edited_tw>/i);
          if (!match || !match[1]) {
            console.error('[TWV LLM] Could not find <edited_tw> tags in response');
            // Fallback: try to use the content directly if it looks like classes
            const trimmed = content.trim();
            if (trimmed && !trimmed.includes('\\n') && trimmed.split(' ').length < 50) {
              console.log('[TWV LLM] Using raw content as fallback:', trimmed);
              return trimmed;
            }
            throw new Error('Could not extract edited classes from response');
          }
          
          const editedClasses = match[1].trim();
          console.log('[TWV LLM] Extracted classes:', editedClasses);
          return editedClasses;
        } catch (e) {
          console.error('[TWV LLM] Error calling API:', e);
          throw e;
        }
      }
      
      // Handle LLM button click
      async function handleLLMEdit() {
        try {
          const value = input.value || '';
          const separatorIndex = value.indexOf(' -- ');
          
          if (separatorIndex === -1) {
            console.warn('[TWV LLM] No -- separator found');
            return;
          }
          
          const classesText = value.substring(0, separatorIndex).trim();
          const userPrompt = value.substring(separatorIndex + 4).trim();
          
          if (!classesText || !userPrompt) {
            console.warn('[TWV LLM] Empty classes or prompt');
            alert('Please provide both classes and a prompt separated by --');
            return;
          }
          
          console.log('[TWV LLM] Processing edit request');
          btnLLM.disabled = true;
          btnLLM.textContent = 'Processing...';
          
          try {
            const editedClasses = await callLLMToEditClasses(classesText, userPrompt);
            console.log('[TWV LLM] Successfully got edited classes:', editedClasses);
            
            // Update the input with the new classes
            input.value = editedClasses;
            console.log('[TWV LLM] Updated input value');
            
            // Trigger input event to update UI
            input.dispatchEvent(new Event('input', { bubbles: true }));
            
            // Hide the LLM button since we no longer have "--"
            updateLLMButtonVisibility();
            
            console.log('[TWV LLM] Edit complete');
          } catch (e) {
            console.error('[TWV LLM] Error during edit:', e);
            alert('Error editing classes with LLM: ' + e.message);
          } finally {
            btnLLM.disabled = false;
            btnLLM.textContent = 'Send to LLM';
          }
        } catch (e) {
          console.error('[TWV LLM] Error in handleLLMEdit:', e);
        }
      }
      
      // Listen for input changes to show/hide LLM button
      input.addEventListener('input', updateLLMButtonVisibility);
      
      // LLM button click handler
      btnLLM.addEventListener('click', (ev) => {
        ev.preventDefault();
        handleLLMEdit();
      });
      
      // Common editing shortcuts inside textarea (select/copy/cut/undo/redo)
      try {
        input.addEventListener('keydown', (ev) => {
          try {
            const k = String(ev.key || '').toLowerCase();
            const mod = !!(ev.metaKey || ev.ctrlKey);
            if (!mod) return;
            if (k === 'a') { ev.preventDefault(); ev.stopPropagation(); try { input.select(); } catch(_) {} return; }
            if (k === 'c') { ev.preventDefault(); ev.stopPropagation(); let ok=false; try { ok = !!document.execCommand('copy'); } catch(_) {} if (!ok && vscodeApi) { try { const s = input.selectionStart|0; const e = input.selectionEnd|0; const txt = (e> s) ? input.value.slice(s, e) : String(input.value||''); vscodeApi.postMessage({ type: 'twvClipboardWrite', text: txt }); } catch(_) {} } return; }
            if (k === 'x') { ev.preventDefault(); ev.stopPropagation(); let ok=false; try { ok = !!document.execCommand('cut'); } catch(_) {} if (!ok && vscodeApi) { try { const s = input.selectionStart|0; const e = input.selectionEnd|0; if (e> s) { const txt = input.value.slice(s, e); vscodeApi.postMessage({ type: 'twvClipboardWrite', text: txt }); input.value = input.value.slice(0, s) + input.value.slice(e); input.dispatchEvent(new Event('input', { bubbles: true })); } } catch(_) {} } return; }
            if (k === 'z') { ev.preventDefault(); ev.stopPropagation(); try { document.execCommand(ev.shiftKey ? 'redo' : 'undo'); } catch(_) {} return; }
            if (k === 'y') { ev.preventDefault(); ev.stopPropagation(); try { document.execCommand('redo'); } catch(_) {} return; }
          } catch(_) {}
        }, { capture: true });
      } catch(_) {}
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
      controls.innerHTML = '<button id="twv-toggle" title="Pause interactions"><span class="twv-icon"></span><span class="twv-label">Pause</span></button><button id="twv-settings-btn" title="Settings">⚙️</button>';
      d.documentElement.appendChild(controls);
      
      // Settings modal
      const settingsOverlay = d.createElement('div');
      settingsOverlay.id = 'twv-settings-overlay';
      settingsOverlay.innerHTML = '<div id="twv-settings-modal"><button class="close-btn" aria-label="Close">&times;</button><h3>Settings</h3><label>OpenRouter API Key<div class="hint">Leave empty to use default</div></label><input type="text" id="twv-api-key" placeholder="sk-or-v1-..." /><label>Model Name<div class="hint">Default: openai/gpt-oss-120b</div></label><input type="text" id="twv-model" placeholder="openai/gpt-oss-120b" /><div style="margin-top:20px;padding-top:16px;border-top:1px solid #374151;display:flex;justify-content:flex-end;"><button id="twv-save-settings" style="background:#0ea5e9;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:12px;">Save</button></div></div>';
      d.documentElement.appendChild(settingsOverlay);
      const toggleBtn = controls.querySelector('#twv-toggle');
      const settingsBtn = controls.querySelector('#twv-settings-btn');
      const iconSpan = toggleBtn.querySelector('.twv-icon');
      const labelSpan = toggleBtn.querySelector('.twv-label');
      const apiKeyInput = settingsOverlay.querySelector('#twv-api-key');
      const modelInput = settingsOverlay.querySelector('#twv-model');
      const settingsCloseBtn = settingsOverlay.querySelector('.close-btn');
      const settingsSaveBtn = settingsOverlay.querySelector('#twv-save-settings');
      
      // Load saved settings from localStorage
      try {
        const savedKey = localStorage.getItem('twv-openrouter-key');
        const savedModel = localStorage.getItem('twv-openrouter-model');
        if (savedKey) apiKeyInput.value = savedKey;
        if (savedModel) modelInput.value = savedModel;
      } catch(_) {}
      
      // Settings modal handlers
      function openSettings() {
        settingsOverlay.classList.add('visible');
        console.log('[TWV LLM] Settings modal opened');
      }
      function closeSettings() {
        settingsOverlay.classList.remove('visible');
        // Save settings to localStorage
        try {
          const key = apiKeyInput.value.trim();
          const model = modelInput.value.trim();
          if (key) {
            localStorage.setItem('twv-openrouter-key', key);
            console.log('[TWV LLM] API key saved');
          } else {
            localStorage.removeItem('twv-openrouter-key');
            console.log('[TWV LLM] API key cleared (using default)');
          }
          if (model) {
            localStorage.setItem('twv-openrouter-model', model);
            console.log('[TWV LLM] Model saved:', model);
          } else {
            localStorage.removeItem('twv-openrouter-model');
            console.log('[TWV LLM] Model cleared (using default)');
          }
        } catch(e) {
          console.error('[TWV LLM] Error saving settings:', e);
        }
      }
      
      settingsBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openSettings(); });
      settingsCloseBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeSettings(); });
      settingsSaveBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeSettings(); });
      settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
      
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
          node.id === 'twv-hover-outline' || node.id === 'twv-tooltip' || node.id === 'twv-editor' || node.id === 'twv-shield' || node.id === 'twv-controls' || node.id === 'twv-settings-overlay' ||
          (node.closest && (node.closest('#twv-hover-outline') || node.closest('#twv-tooltip') || node.closest('#twv-editor') || node.closest('#twv-controls') || node.closest('#twv-settings-overlay')))
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
          const originalClasses = (el.getAttribute('class') || '').trim();
          
          // Prevent scroll jumping when editor opens
          const savedScrollY = window.scrollY;
          const savedScrollX = window.scrollX;
          
          input.value = originalClasses;
          editor.style.left = ex + 'px'; editor.style.top = ey + 'px';
          editor.style.display = 'block';
          
          // Restore scroll position immediately after display
          window.scrollTo(savedScrollX, savedScrollY);

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

          // Live preview: update element classes in real-time as user types
          function livePreview() {
            try {
              const newVal = input.value.trim();
              el.setAttribute('class', newVal);
            } catch (e) {
              console.error('[TWV LLM] Error in live preview:', e);
            }
          }

          autosize();
          
          // Focus without scrolling
          input.focus({ preventScroll: true }); 
          input.select();
          
          // Restore scroll position after focus (in case preventScroll isn't supported)
          window.scrollTo(savedScrollX, savedScrollY);
          
          // Keep resizing as the user types or pastes
          input.addEventListener('input', autosize);
          // Live preview on input changes
          input.addEventListener('input', livePreview);
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
          function close(restoreOriginal) {
            if (restoreOriginal) {
              el.setAttribute('class', originalClasses);
              console.log('[TWV LLM] Cancelled - restored original classes:', originalClasses);
            }
            editor.style.display = 'none';
            input.blur();
            d.removeEventListener('keydown', onKey);
            input.removeEventListener('input', autosize);
            input.removeEventListener('input', livePreview);
            window.removeEventListener('resize', autosize);
          }
          function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); close(true); }
            // Enter without Shift: if input contains " -- ", trigger LLM; otherwise commit
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || !ev.shiftKey)) { 
              ev.preventDefault(); 
              const value = input.value || '';
              if (value.includes(' -- ')) {
                console.log('[TWV LLM] Enter pressed with -- detected, triggering LLM');
                handleLLMEdit();
              } else {
                commit(); 
              }
            }
          }
          // Editing shortcuts handled by input-level keydown listener above
          d.addEventListener('keydown', onKey, { capture: true });
          btnCancel.onclick = (ev) => { ev.preventDefault(); close(true); };
          btnSave.onclick = (ev) => { ev.preventDefault(); commit(); };
        } catch (e) { console.error('openEditor error', e); }
      }

      d.addEventListener('dblclick', (e) => {
        const t = e.target;
        // If the dblclick occurred inside our editor UI, allow native selection behavior.
        if (t && (t.id === 'twv-editor' || (t.closest && t.closest('#twv-editor')))) {
          return;
        }
        let el = t;
        // For our non-editor UI (tooltip/outline) or when paused, resolve the underlying element.
        if (!el || paused || (isOurNode(el) && !(el.closest && el.closest('#twv-editor')))) {
          el = underlyingElementAt(e.clientX, e.clientY);
        }
        if (!el || isOurNode(el)) return;
        e.preventDefault(); e.stopPropagation();
        openEditorFor(el, e.clientX, e.clientY);
      }, { capture: true });

      // Swallow most interactions while paused to avoid mutating app state
      const swallow = (ev) => {
        if (!paused) return;
        // Allow interactions with our own UI controls/editor/settings
        const path = ev.composedPath ? ev.composedPath() : [];
        const t = ev.target;
        const inOurUi = (n) => !!n && (
          (n.id === 'twv-controls' || n.id === 'twv-editor' || n.id === 'twv-tooltip' || n.id === 'twv-hover-outline' || n.id === 'twv-settings-overlay') ||
          (n.closest && (n.closest('#twv-controls') || n.closest('#twv-editor') || n.closest('#twv-tooltip') || n.closest('#twv-hover-outline') || n.closest('#twv-settings-overlay')))
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

      // Global undo/redo when not editing in our textarea
      d.addEventListener('keydown', (ev) => {
        try {
          const k = String(ev.key || '').toLowerCase();
          const meta = !!(ev.metaKey || ev.ctrlKey);
          const inOurEditor = !!(d.activeElement && (d.activeElement.closest && d.activeElement.closest('#twv-editor')));
          if (!meta || (k !== 'z')) return;
          if (inOurEditor) return; // let the textarea handle its own undo stack
          ev.preventDefault(); ev.stopPropagation();
          if (vscodeApi) {
            vscodeApi.postMessage({ type: ev.shiftKey ? 'redo' : 'undo' });
          }
        } catch(_) {}
      }, { capture: true });
    } catch (e) { console.error('twv helper error', e); }
  })();
</script>
`;
}

// Annotate the HTML source by adding data-twv-uid to elements with a class attribute
// and compute a mapping of uid -> { start, end, original }
function annotateHtmlForClassOffsets(sourceHtml) {
  // Prefer robust parse5-based mapping. Fallback to regex approach on failure.
  try {
    if (!parse5) {
      try { parse5 = require('parse5'); } catch (e) { parse5 = null; }
    }
    if (!parse5) throw new Error('parse5 not available');

    const doc = parse5.parse(sourceHtml, { sourceCodeLocationInfo: true });
    const mapping = new Map();
    let uidCounter = 1;

    /** @param {any} node */
    const visit = (node) => {
      if (node && Array.isArray(node.childNodes)) {
        for (const child of node.childNodes) visit(child);
      }
      if (!node || !Array.isArray(node.attrs) || !node.sourceCodeLocation) return;

      const hasClassAttr = node.attrs.find((a) => a.name === 'class');
      const locs = node.sourceCodeLocation.attrs || {};
      const classLoc = locs['class'];
      if (!hasClassAttr || !classLoc) return;

      // Compute value start/end offsets within original source for this class attribute
      const valueOffsets = computeAttrValueOffsetsFromSpan(sourceHtml, classLoc.startOffset, classLoc.endOffset);
      if (!valueOffsets) return;
      const { valueStart, valueEnd } = valueOffsets;
      const classValue = sourceHtml.slice(valueStart, valueEnd);

      // Ensure a clean data-twv-uid attribute on this node in the preview
      node.attrs = node.attrs.filter((a) => a.name !== 'data-twv-uid');
      node.attrs.push({ name: 'data-twv-uid', value: String(uidCounter) });

      mapping.set(String(uidCounter), { start: valueStart, end: valueEnd, original: classValue });
      uidCounter++;
    };
    visit(doc);

    const annotatedHtml = parse5.serialize(doc);
    return { annotatedHtml, mapping };
  } catch (e) {
    try { console.error('annotateHtmlForClassOffsets error (parse5 path)', e && e.message ? e.message : e); } catch {}
    // Fallback: keep previous heuristic approach
    try {
      const mapping = new Map();
      let out = '';
      let last = 0;
      let uidCounter = 1;
      const tagRe = /<([a-zA-Z][\w:-]*)([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(sourceHtml)) !== null) {
        const full = m[0];
        const tagName = m[1];
        const attrs = m[2] || '';
        const classRe = /\bclass\s*=\s*(["'])([\s\S]*?)\1/i;
        const cm = classRe.exec(attrs);
        if (!cm) continue;
        const quote = cm[1];
        const classValue = cm[2];
        const attrsStartInFull = 1 + tagName.length;
        const openQuoteInAttrs = cm.index + cm[0].indexOf(quote);
        const valueStartInAttrs = openQuoteInAttrs + 1;
        const valueEndInAttrs = valueStartInAttrs + classValue.length;
        const tagStartInDoc = m.index;
        const valueStartInDoc = tagStartInDoc + attrsStartInFull + valueStartInAttrs;
        const valueEndInDoc = tagStartInDoc + attrsStartInFull + valueEndInAttrs;
        const closeIsSelf = /\/>\s*$/.test(full);
        const injection = ` data-twv-uid="${uidCounter}"`;
        const insertPosInFull = full.length - (closeIsSelf ? 2 : 1);
        const newStartTag = full.slice(0, insertPosInFull) + injection + full.slice(insertPosInFull);
        out += sourceHtml.slice(last, tagStartInDoc) + newStartTag;
        last = tagStartInDoc + full.length;
        mapping.set(String(uidCounter), { start: valueStartInDoc, end: valueEndInDoc, original: classValue });
        uidCounter++;
      }
      out += sourceHtml.slice(last);
      return { annotatedHtml: out, mapping };
    } catch (e2) {
      try { console.error('annotateHtmlForClassOffsets error (fallback path)', e2 && e2.message ? e2.message : e2); } catch {}
      return { annotatedHtml: sourceHtml, mapping: new Map() };
    }
  }
}

// Compute the start/end offsets of an attribute's VALUE within the document given the attribute span
// Handles quoted (single/double) and unquoted values.
function computeAttrValueOffsetsFromSpan(source, attrStart, attrEnd) {
  try {
    const seg = source.slice(attrStart, attrEnd);
    const eqIdx = seg.indexOf('=');
    if (eqIdx === -1) return null; // boolean/no-value attribute (unexpected for class)
    // Skip whitespace after '='
    let i = eqIdx + 1;
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) return null;
    let valueStartInSeg = i;
    let valueEndInSeg = seg.length;
    const ch = seg[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      valueStartInSeg = i + 1;
      const close = seg.indexOf(q, valueStartInSeg);
      const endIdx = (close === -1) ? seg.length : close; // fall back to end if malformed
      valueEndInSeg = endIdx;
    } else {
      // Unquoted: read until whitespace
      let j = i;
      while (j < seg.length && !/\s/.test(seg[j])) j++;
      valueStartInSeg = i;
      valueEndInSeg = j;
    }
    const valueStart = attrStart + valueStartInSeg;
    const valueEnd = attrStart + valueEndInSeg;
    if (valueStart >= valueEnd) return null;
    return { valueStart, valueEnd };
  } catch {
    return null;
  }
}

// Build a webview page that embeds an iframe to a dev server and relays messages.
function buildServerPreviewHtml(webview, iframeUrl, clientScriptUrl) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} http: https: data:; media-src ${webview.cspSource} http: https:; style-src 'unsafe-inline' ${webview.cspSource} http: https:; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} http: https:; font-src ${webview.cspSource} http: https: data:; connect-src ${webview.cspSource} http: https:; frame-src ${webview.cspSource} http: https:;">`;
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html = `<!doctype html>
<html>
  <head>
    ${csp}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tailwind Server Preview</title>
    <style>
      html, body { height: 100%; }
      body { margin: 0; font: 12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #e5e7eb; }
      #bar { display:flex; align-items:center; gap:8px; padding:6px 8px; background:#111827; border-bottom:1px solid #374151; }
      #bar input { flex: 1 1 auto; padding:6px 8px; border:1px solid #374151; border-radius:6px; font-size:12px; background:#0b1220; color:#e5e7eb; }
      #bar button { padding:6px 8px; font-size:12px; border:1px solid #374151; border-radius:6px; background:#1f2937; color:#e5e7eb; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
      #bar button:hover { background:#374151; }
      #bar button svg { width:16px; height:16px; fill:currentColor; }
      #bar #pause { color: #9ca3af; }
      #bar #pause.playing { color: #0ea5e9; }
      #bar .hint { color:#9ca3af; }
      #settings-overlay { position: fixed; inset: 0; z-index: 999999; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; }
      #settings-overlay.visible { display: flex; }
      #settings-modal { background: #111827; border: 1px solid #374151; border-radius: 8px; padding: 20px; width: min(90vw, 480px); box-shadow: 0 20px 50px rgba(0,0,0,0.6); position: relative; }
      #settings-modal h3 { margin: 0 0 16px 0; color: #e5e7eb; font-size: 18px; font-weight: 600; }
      #settings-modal .close-btn { position: absolute; top: 12px; right: 12px; background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 24px; line-height: 1; padding: 4px 8px; }
      #settings-modal .close-btn:hover { color: #e5e7eb; }
      #settings-modal label { display: block; color: #9ca3af; font-size: 13px; margin-bottom: 6px; margin-top: 12px; }
      #settings-modal label:first-of-type { margin-top: 0; }
      #settings-modal input { display: block; width: 100%; background: #0b1220; color: #e5e7eb; border: 1px solid #374151; border-radius: 4px; padding: 8px 10px; font-size: 13px; font-family: ui-monospace, monospace; box-sizing: border-box; }
      #settings-modal input:focus { outline: none; border-color: #0ea5e9; }
      #settings-modal .hint { color: #6b7280; font-size: 11px; margin-top: 4px; }
      #settings-modal .section-divider { margin-top: 20px; padding-top: 16px; border-top: 1px solid #374151; }
      #settings-modal button.save-btn { background: #0ea5e9; color: #fff; border: 1px solid #0284c7; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; }
      #settings-modal button.save-btn:hover { background: #0284c7; }
      #settings-modal input[readonly] { cursor: text; user-select: all; }
      #frame { width: 100%; height: calc(100% - 40px); border:0; }
      #warn { padding: 8px; background: #fff7ed; border-top: 1px solid #fde68a; color: #7c2d12; display:none; }
    </style>
  </head>
  <body>
    <div id="bar">
      <span class="hint">URL:</span>
      <input id="url" value="${esc(iframeUrl)}" />
      <button id="go" title="Reload"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
      <button id="pause" title="Resume interactions (p)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button>
      <button id="settings-btn" title="Settings">⚙️</button>
    </div>
    <iframe id="frame" src="${esc(iframeUrl)}"></iframe>
    <div id="warn"></div>
    <div id="settings-overlay">
      <div id="settings-modal">
        <button class="close-btn" aria-label="Close">&times;</button>
        <h3>Settings</h3>
        <label>OpenRouter API Key<div class="hint">Leave empty to use default</div></label>
        <input type="text" id="api-key" placeholder="sk-or-v1-..." />
        <label>Model Name<div class="hint">Default: openai/gpt-oss-120b</div></label>
        <input type="text" id="model" placeholder="openai/gpt-oss-120b" />
        <div class="section-divider">
          <label style="margin-top: 0;">Client Script URL<div class="hint">Add this script tag to your HTML</div></label>
          <input type="text" id="client" readonly value="${esc(clientScriptUrl)}" style="font-size:11px;" />
          <button id="copy" class="save-btn" style="margin-top:8px;width:100%;">Copy Client Script Tag</button>
        </div>
        <div class="section-divider" style="display:flex;justify-content:flex-end;">
          <button id="save-settings" class="save-btn">Save</button>
        </div>
      </div>
    </div>
    <script>
      const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
      const input = document.getElementById('url');
      const btn = document.getElementById('go');
      const warn = document.getElementById('warn');
      const iframe = document.getElementById('frame');
      const pauseBtn = document.getElementById('pause');
      const settingsBtn = document.getElementById('settings-btn');
      const settingsOverlay = document.getElementById('settings-overlay');
      const settingsCloseBtn = settingsOverlay.querySelector('.close-btn');
      const apiKeyInput = document.getElementById('api-key');
      const modelInput = document.getElementById('model');
      const copy = document.getElementById('copy');
      const client = document.getElementById('client');
      const saveSettingsBtn = document.getElementById('save-settings');
      let paused = true;
      
      // Load saved settings
      try {
        const savedKey = localStorage.getItem('twv-openrouter-key');
        const savedModel = localStorage.getItem('twv-openrouter-model');
        if (savedKey) apiKeyInput.value = savedKey;
        if (savedModel) modelInput.value = savedModel;
      } catch(_) {}
      
      // Settings modal handlers
      function openSettings() {
        settingsOverlay.classList.add('visible');
        console.log('[TWV Server] Settings modal opened');
      }
      function closeSettings() {
        settingsOverlay.classList.remove('visible');
        // Save settings
        try {
          const key = apiKeyInput.value.trim();
          const model = modelInput.value.trim();
          if (key) {
            localStorage.setItem('twv-openrouter-key', key);
            console.log('[TWV Server] API key saved');
          } else {
            localStorage.removeItem('twv-openrouter-key');
            console.log('[TWV Server] API key cleared (using default)');
          }
          if (model) {
            localStorage.setItem('twv-openrouter-model', model);
            console.log('[TWV Server] Model saved:', model);
          } else {
            localStorage.removeItem('twv-openrouter-model');
            console.log('[TWV Server] Model cleared (using default)');
          }
          // Notify iframe to clear cached settings
          try {
            iframe.contentWindow.postMessage({
              source: 'twv-host',
              type: 'clearSettingsCache'
            }, '*');
            console.log('[TWV Server] Notified client to clear settings cache');
          } catch(e) {
            console.log('[TWV Server] Could not notify client (may not be loaded yet)');
          }
        } catch(e) {
          console.error('[TWV Server] Error saving settings:', e);
        }
      }
      
      settingsBtn.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
      settingsCloseBtn.addEventListener('click', (e) => { e.preventDefault(); closeSettings(); });
      saveSettingsBtn.addEventListener('click', (e) => { e.preventDefault(); closeSettings(); });
      settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
      btn.onclick = () => { try { const u = new URL(input.value); iframe.src = u.toString(); warn.style.display='none'; } catch { alert('Invalid URL'); } };
      copy.onclick = async () => {
        const tag = '<script src="${esc(clientScriptUrl)}"><' + '/script>';
        try {
          if (vscode) {
            vscode.postMessage({ type: 'copyToClipboard', text: tag });
          } else if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(tag);
            alert('Copied script tag to clipboard.');
          } else {
            throw new Error('no clipboard api');
          }
        } catch (_) {
          try { await navigator.clipboard.writeText(tag); alert('Copied script tag to clipboard.'); } catch { prompt('Copy this tag:', tag); }
        }
      };
      const playSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      const pauseSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
      function updatePauseButton(){ 
        pauseBtn.innerHTML = paused ? playSvg : pauseSvg;
        pauseBtn.title = paused ? 'Resume interactions (p)' : 'Pause interactions (p)';
        pauseBtn.classList.toggle('playing', !paused);
      }
      function sendPause(){ try { iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ source:'twv-host', type:'setPaused', value: paused }, '*'); } catch(_){} }
      pauseBtn.onclick = () => { paused = !paused; updatePauseButton(); sendPause(); };
      window.addEventListener('keydown', (e) => {
        // Toggle pause with 'p'
        if ((e.key==='p'||e.key==='P') && !(e.metaKey||e.ctrlKey||e.altKey||e.shiftKey)) { e.preventDefault(); paused = !paused; updatePauseButton(); sendPause(); return; }
        // Undo/redo when focus is inside the host page
        const k = String(e.key||'').toLowerCase();
        const meta = !!(e.metaKey||e.ctrlKey);
        if (meta && k === 'z') {
          e.preventDefault();
          if (vscode) vscode.postMessage({ type: e.shiftKey ? 'serverRedo' : 'serverUndo' });
        }
      });
      updatePauseButton();

      // Relay messages from iframe client to the extension
      window.addEventListener('message', (ev) => {
        try {
          if (!iframe || ev.source !== iframe.contentWindow) return;
          const data = ev.data || {};
          if (data && data.source === 'twv-client' && data.type) {
            // Handle settings request from client
            if (data.type === 'getSettings') {
              try {
                const apiKey = localStorage.getItem('twv-openrouter-key') || '';
                const model = localStorage.getItem('twv-openrouter-model') || '';
                console.log('[TWV Server] Sending settings to client');
                iframe.contentWindow.postMessage({
                  source: 'twv-host',
                  type: 'settings',
                  requestId: data.requestId,
                  apiKey: apiKey,
                  model: model
                }, '*');
              } catch (e) {
                console.error('[TWV Server] Error sending settings:', e);
              }
              return;
            }
            if (!vscode) return;
            if (data.type === 'undo' || data.type === 'redo') {
              vscode.postMessage({ type: data.type === 'undo' ? 'serverUndo' : 'serverRedo' });
            } else if (data.type === 'clipboardWrite') {
              vscode.postMessage({ type: 'twvClipboardWrite', text: data.text || '' });
            } else {
              vscode.postMessage({ type: 'serverUpdateDynamicTemplate', before: data.before || '', after: data.after || '', text: data.text || '', tag: data.tag || '', id: data.id || '' });
            }
          }
        } catch (e) { console.error('message relay error', e); }
      });

      // Show a note if the site refuses to be framed
      iframe.addEventListener('load', () => { warn.style.display='none'; sendPause(); });
      iframe.addEventListener('error', () => { warn.textContent = 'The app refused to load in an <iframe> (X-Frame-Options/Content-Security-Policy). Disable these in dev to use Server Preview.'; warn.style.display='block'; });
    </script>
  </body>
</html>`;
  return html;
}

// Workspace-wide persistence: replace exact string-literal occurrences of `before` with `after` in common web files.
async function persistDynamicClassEditWorkspace(before, after) {
  try {
    const vscode = require('vscode');
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dqRe = new RegExp('"' + escapeRe(before) + '"', 'g');
    const sqRe = new RegExp("'" + escapeRe(before) + "'", 'g');
    const btRe = new RegExp('`' + escapeRe(before) + '`', 'g');
    const files = await vscode.workspace.findFiles('**/*.{html,js,jsx,ts,tsx,vue,svelte,astro}', '**/{node_modules,dist,build,.next,.nuxt,out,coverage,.git}/**', 5000);
    let changedFiles = 0;
    const edit = new vscode.WorkspaceEdit();
    const toSave = [];
    for (const uri of files) {
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        const replaced = text.replace(dqRe, '"' + after + '"').replace(sqRe, "'" + after + "'").replace(btRe, '`' + after + '`');
        if (replaced !== text) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const full = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
          edit.replace(uri, full, replaced);
          changedFiles++;
          toSave.push(uri);
        }
      } catch {}
    }
    if (changedFiles > 0) {
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        for (const uri of toSave) {
          try { const doc = await vscode.workspace.openTextDocument(uri); await doc.save(); } catch {}
        }
      }
    }
    return changedFiles;
  } catch (e) {
    console.error('persistDynamicClassEditWorkspace error', e);
    return 0;
  }
}

// Smart persistence for server preview edits (safer by default):
// - Scan workspace for occurrences of the class string in string literals
// - If multiple files contain matches, prefer the active editor's file.
// - If still ambiguous, prompt the user to choose files to update, defaulting to the active file.
// - Avoids silently global edits to reduce unintended side effects.
async function persistDynamicClassEditSmart(before, after, hint) {
  try {
    const vscode = require('vscode');
    const files = await vscode.workspace.findFiles('**/*.{html,js,jsx,ts,tsx,vue,svelte,astro}', '**/{node_modules,dist,build,.next,.nuxt,out,coverage,.git}/**', 5000);

    // Helpers
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normWs = (s) => s.replace(/\s+/g, ' ').trim();
    const canonTokens = (s) => normWs(s).split(/\s+/).filter(Boolean).sort();
    const eqTokens = (a, b) => {
      if (a.length !== b.length) return false; for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false; return true;
    };
    const beforeTokens = canonTokens(before);

    let changedFiles = 0;
    let lastUriStr = '';

    // First pass: simple exact literal replacement for speed (scoped)
    const dqRe = new RegExp('"' + escapeRe(before) + '"', 'g');
    const sqRe = new RegExp("'" + escapeRe(before) + "'", 'g');
    const btRe = new RegExp('`' + escapeRe(before) + '`', 'g');

    const exactMatches = [];
    for (const uri of files) {
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        if (dqRe.test(text) || sqRe.test(text) || btRe.test(text)) {
          exactMatches.push({ uri, text });
        }
      } catch {}
    }

    let singleTargetMode = false;
    if (exactMatches.length > 0) {
      // Determine scope: prefer active editor's file when present
      const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document && vscode.window.activeTextEditor.document.uri;
      const activeMatch = active ? exactMatches.find(m => m.uri.toString() === active.toString()) : undefined;

      // If more than one file matches, prompt the user to choose scope
      let targets = [];
      if (exactMatches.length === 1) {
        targets = [exactMatches[0]];
      } else if (activeMatch) {
        // Prefer active file by default; ask whether to update others as well
        const rel = (u) => {
          const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
          if (wf) return vscode.workspace.asRelativePath(u, false);
          return u.fsPath || u.path || String(u);
        };
        const choice = await vscode.window.showInformationMessage(
          `The edited class string appears in ${exactMatches.length} files. Update only the active file (${rel(activeMatch.uri)}) or all matches?`,
          { modal: false },
          'Only Active File',
          'Update All Files'
        );
        if (choice === 'Update All Files') {
          targets = exactMatches;
        } else {
          targets = [activeMatch];
          singleTargetMode = true;
        }
      } else {
        // No active match; let the user choose one or all
        const items = exactMatches.map((m) => {
          const rel = vscode.workspace.asRelativePath(m.uri, false);
          return { label: rel, description: m.uri.fsPath || m.uri.path, data: m };
        });
        const pick = await vscode.window.showQuickPick(items.concat([{ label: '$(check) Update All Files', description: 'Apply to every matching file', data: null }]), {
          placeHolder: 'Select a file to update Tailwind classes, or choose Update All Files',
          canPickMany: false,
        });
        if (!pick) return 0;
        if (pick.data === null) {
          targets = exactMatches;
        } else {
          targets = [pick.data];
          singleTargetMode = true;
        }
      }

      for (const m of targets) {
        try {
          const doc = await vscode.workspace.openTextDocument(m.uri);
          const text = doc.getText();
          const replaced = text.replace(dqRe, '"' + after + '"').replace(sqRe, "'" + after + "'").replace(btRe, '`' + after + '`');
          if (replaced !== text) {
            const edit = new vscode.WorkspaceEdit();
            const full = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
            edit.replace(m.uri, full, replaced);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) { try { await doc.save(); lastUriStr = m.uri.toString(); } catch {} changedFiles++; }
          }
        } catch {}
      }
    }

    // If we intentionally targeted a single file in exact pass, stop here to avoid touching other files
    if (singleTargetMode && changedFiles > 0) {
      return { changed: changedFiles, lastUri: lastUriStr };
    }

    // Second pass: tolerant matching (order/whitespace agnostic) for HTML-like files (single-file intent)
    for (const uri of files) {
      const ext = (uri.path || uri.fsPath || '').toLowerCase();
      if (!/(\.html$|\.vue$|\.svelte$|\.astro$)/.test(ext)) continue;
      try {
        if (!parse5) { try { parse5 = require('parse5'); } catch { parse5 = null; } }
        if (!parse5) break;
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        const doc = parse5.parse(text, { sourceCodeLocationInfo: true });
        const repls = [];
        const visit = (n) => {
          if (!n) return; if (Array.isArray(n.childNodes)) n.childNodes.forEach(visit);
          if (!Array.isArray(n.attrs) || !n.sourceCodeLocation) return;
          const cls = n.attrs.find(a => a.name === 'class');
          const locs = n.sourceCodeLocation.attrs || {};
          const loc = locs['class'];
          if (!cls || !loc) return;
          const v = cls.value || '';
          const valTokens = canonTokens(v);
          if (!valTokens.length) return;
          if (eqTokens(valTokens, beforeTokens)) {
            // Compute value offsets within the attribute span
            const off = computeAttrValueOffsetsFromSpan(text, loc.startOffset, loc.endOffset);
            if (off && off.valueStart < off.valueEnd) {
              repls.push(off);
            }
          }
        };
        visit(doc);
        if (repls.length > 0) {
          // Build replaced text via slices
          repls.sort((a,b) => a.valueStart - b.valueStart);
          let last = 0; let out = '';
          for (const r of repls) { out += text.slice(last, r.valueStart) + after; last = r.valueEnd; }
          out += text.slice(last);
          if (out !== text) {
            const d = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const full = new vscode.Range(d.positionAt(0), d.positionAt(text.length));
            edit.replace(uri, full, out);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) { try { await d.save(); lastUriStr = uri.toString(); } catch {} changedFiles++; }
          }
        }
      } catch {}
    }

    // Third pass: tolerant string-literal matching across JS-like files (single-file intent)
    const strRe = /(["'`])(?:\\.|(?!\1)[\s\S])*\1/g; // naive string literal matcher (handles escapes roughly)
    for (const uri of files) {
      const ext = (uri.path || uri.fsPath || '').toLowerCase();
      if (!/(\.js$|\.jsx$|\.ts$|\.tsx$|\.vue$|\.svelte$|\.astro$|\.html$)/.test(ext)) continue;
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        let m; let out = ''; let last = 0; let did = false;
        while ((m = strRe.exec(text)) !== null) {
          const full = m[0]; const q = full[0];
          const inner = full.slice(1, -1);
          const tokens = canonTokens(inner);
          if (tokens.length && eqTokens(tokens, beforeTokens)) {
            out += text.slice(last, m.index) + q + after + q;
            last = m.index + full.length;
            did = true;
          }
        }
        if (did) {
          out += text.slice(last);
          if (out !== text) {
            const d = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(d.positionAt(0), d.positionAt(text.length));
            edit.replace(uri, fullRange, out);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) { try { await d.save(); lastUriStr = uri.toString(); } catch {} changedFiles++; }
          }
        }
      } catch {}
    }

    if (changedFiles > 0) return { changed: changedFiles, lastUri: lastUriStr };

    // Fourth pass: try updating a base constant string by removing only the removed tokens
    const afterTokens = canonTokens(after);
    const removedTokens = beforeTokens.filter(t => !afterTokens.includes(t));
    const addedTokens = afterTokens.filter(t => !beforeTokens.includes(t));
    if (removedTokens.length > 0 && addedTokens.length === 0) {
      const assignRe = /(?:^|[^\w$])(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\3)[\s\S])*)\3/gm;
      const candidates = [];
      for (const uri of files) {
        const ext = (uri.path || uri.fsPath || '').toLowerCase();
        if (!/(\.js$|\.jsx$|\.ts$|\.tsx$|\.vue$|\.svelte$|\.astro$)/.test(ext)) continue;
        try {
          const buf = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(buf).toString('utf8');
          let m; assignRe.lastIndex = 0;
          while ((m = assignRe.exec(text)) !== null) {
            const q = m[3];
            const inner = m[4];
            const toks = canonTokens(inner);
            if (!toks.length) continue;
            // The constant must be a subset of before tokens and contain all removed tokens
            const isSubset = toks.every(t => beforeTokens.includes(t));
            const hasAllRemoved = removedTokens.every(rt => toks.includes(rt));
            if (isSubset && hasAllRemoved) {
              candidates.push({ uri, index: m.index, length: m[0].length, quote: q, inner, toks, full: m[0] });
            }
          }
        } catch {}
      }
      if (candidates.length === 1) {
        const c = candidates[0];
        try {
          const doc = await vscode.workspace.openTextDocument(c.uri);
          const text = doc.getText();
          // Re-run regex to compute exact slice positions within current doc text
          assignRe.lastIndex = 0;
          let pos = -1; let match;
          while ((match = assignRe.exec(text)) !== null) {
            if (match[0] === c.full) { pos = match.index; break; }
          }
          if (pos >= 0) {
            const startInner = pos + match[0].indexOf(match[3]) + 1; // after opening quote
            const endInner = startInner + match[4].length;
            const newInner = c.toks.filter(t => !removedTokens.includes(t)).join(' ');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(c.uri, new vscode.Range(doc.positionAt(startInner), doc.positionAt(endInner)), newInner);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) { try { await doc.save(); lastUriStr = c.uri.toString(); } catch {} changedFiles += 1; }
          }
        } catch {}
      }
    }

    if (changedFiles > 0) return { changed: changedFiles, lastUri: lastUriStr };

    // Fifth pass: hint-assisted proximity replacement (uses element text content to narrow file and region)
    try {
      const t = hint && typeof hint.text === 'string' ? hint.text.trim() : '';
      if (t && t.length >= 4) {
        const textEsc = escapeRe(t);
        const dqText = new RegExp('"' + textEsc + '"', 'g');
        const sqText = new RegExp("'" + textEsc + "'", 'g');
        const btText = new RegExp('`' + textEsc + '`', 'g');
        const strRe = /(["'`])(?:\\.|(?!\1)[\s\S])*\1/g;
        const proximity = 3000; // chars to scan around the hint text
        const nearClassCtx = /(className|setAttribute\(\s*['\"]class['\"])\s*[:=]/;
        for (const uri of files) {
          const ext = (uri.path || uri.fsPath || '').toLowerCase();
          if (!/(\.js$|\.jsx$|\.ts$|\.tsx$|\.vue$|\.svelte$|\.astro$|\.html$)/.test(ext)) continue;
          try {
            const buf = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(buf).toString('utf8');
            let idx = -1;
            let m1 = dqText.exec(text); if (m1) idx = m1.index;
            if (idx < 0) { let m2 = sqText.exec(text); if (m2) idx = m2.index; }
            if (idx < 0) { let m3 = btText.exec(text); if (m3) idx = m3.index; }
            if (idx < 0) continue;
            const start = Math.max(0, idx - proximity);
            const end = Math.min(text.length, idx + t.length + proximity);
            const win = text.slice(start, end);
            let best = null; let bestScore = Infinity;
            let sm;
            strRe.lastIndex = 0;
            while ((sm = strRe.exec(win)) !== null) {
              const full = sm[0]; const q = full[0];
              const inner = full.slice(1, -1);
              const tokens = canonTokens(inner);
              if (!tokens.length) continue;
              const isSuperset = beforeTokens.every(bt => tokens.includes(bt));
              if (!isSuperset) continue;
              // Prefer literals near class context
              const litPos = start + sm.index;
              const ctxStart = Math.max(0, litPos - 160);
              const ctxEnd = Math.min(text.length, litPos + full.length + 160);
              const ctx = text.slice(ctxStart, ctxEnd);
              const nearClass = nearClassCtx.test(ctx) ? 0 : 1;
              // Distance to hint
              const dist = Math.abs((start + sm.index) - idx);
              const score = nearClass * 100000 + dist;
              if (!best || score < bestScore) {
                best = { litPos, full, q, inner, score };
                bestScore = score;
              }
            }
            if (best) {
              const doc = await vscode.workspace.openTextDocument(uri);
              const replaceWith = best.q + after + best.q;
              const edit = new vscode.WorkspaceEdit();
              edit.replace(uri, new vscode.Range(doc.positionAt(best.litPos), doc.positionAt(best.litPos + best.full.length)), replaceWith);
              const ok = await vscode.workspace.applyEdit(edit);
              if (ok) { try { await doc.save(); lastUriStr = uri.toString(); } catch {} changedFiles += 1; }
              if (changedFiles > 0) return { changed: changedFiles, lastUri: lastUriStr };
            }
          } catch {}
        }
      }
    } catch {}

    return { changed: changedFiles, lastUri: lastUriStr };
  } catch (e) {
    console.error('persistDynamicClassEditSmart error', e);
    return { changed: 0, lastUri: '' };
  }
}

// Remote client helper JS: runs inside the dev server page, overlays hover/tooltip, edits classes,
// and posts updates to the parent (the webview) for workspace persistence.
function getRemoteClientScript() {
  return "(()=>{"+
    "try {"+
      "const d = document;"+
      "if (d.getElementById('twv-remote-client')) return;"+
      "const style = d.createElement('style'); style.id = 'twv-remote-client'; style.textContent = '"+
        "#twv-hover-outline { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #06b6d4; border-radius: 2px; box-shadow: 0 0 0 2px rgba(6,182,212,0.25); }"+
        "#twv-tooltip { position: fixed; pointer-events: none; z-index: 2147483647; background: rgba(3, 7, 18, 0.9); color: #e5e7eb; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \\\"Liberation Mono\\\", \\\"Courier New\\\", monospace; font-size: 12px; padding: 6px 8px; border-radius: 6px; max-width: 70vw; white-space: pre-wrap; line-height: 1.3; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }"+
        "#twv-tooltip .twv-tag { color: #93c5fd; }"+
        "#twv-tooltip .twv-classes { color: #fde68a; }"+
        "#twv-tooltip .twv-none { color: #9ca3af; font-style: italic; }"+
        "#twv-tooltip.hidden, #twv-hover-outline.hidden { display: none; }"+
        "#twv-editor { position: fixed; z-index: 2147483647; background: #0b1220; color: #e5e7eb; padding: 10px; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); width: min(80vw, 720px); max-width: 720px; border: 1px solid #334155; }"+
        "#twv-editor textarea { width: 100%; min-height: 42px; resize: vertical; font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \\\"Liberation Mono\\\", \\\"Courier New\\\", monospace; padding: 8px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #e5e7eb; }"+
        "#twv-editor .twv-actions { margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end; }"+
        "#twv-editor .twv-actions button { padding: 6px 10px; font-size: 12px; border: 1px solid #334155; border-radius: 6px; background: #111827; color: #e5e7eb; cursor: pointer; }"+
        "#twv-editor button.twv-llm { background: #8b5cf6; color: #fff; display: none; }"+
        "#twv-editor button.twv-llm.visible { display: inline-block; }"+
        "#twv-shield { position: fixed; inset: 0; z-index: 2147483630; pointer-events: none; }"+
        "html.twv-paused { cursor: default !important; }"+
      "'; d.documentElement.appendChild(style);"+
      "const outline = d.createElement('div'); outline.id = 'twv-hover-outline'; outline.className='hidden'; d.documentElement.appendChild(outline);"+
      "const tooltip = d.createElement('div'); tooltip.id = 'twv-tooltip'; tooltip.className='hidden'; d.documentElement.appendChild(tooltip);"+
      "const editor = d.createElement('div'); editor.id = 'twv-editor'; editor.style.display = 'none';"+
      "editor.innerHTML = '<div id=\\\"twv-title\\\" style=\\\"margin-bottom:4px;color:#9ca3af;font-size:13px;font-weight:500;\\\">Edit Tailwind classes</div>'+"+
        "'<div style=\\\"margin-bottom:8px;color:#6b7280;font-size:11px;line-height:1.4;\\\">Type \\\" -- [prompt]\\\" to the end of your classes for AI edits</div>'+"+
        "'<textarea id=\\\"twv-input\\\" spellcheck=\\\"false\\\" rows=\\\"1\\\" wrap=\\\"soft\\\" aria-label=\\\"Tailwind classes\\\"></textarea>'+"+
        "'<div class=\\\"twv-actions\\\"><button class=\\\"twv-cancel\\\">Cancel</button><button class=\\\"twv-llm\\\">Send to LLM</button><button class=\\\"twv-save\\\">Save</button></div>';"+
      "d.documentElement.appendChild(editor);"+
      "const input = editor.querySelector('#twv-input');"+
      "const btnSave = editor.querySelector('.twv-save');"+
      "const btnCancel = editor.querySelector('.twv-cancel');"+
      "const btnLLM = editor.querySelector('.twv-llm');"+
      "const DEFAULT_OPENROUTER_API_KEY = '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';"+
      "const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-oss-120b';"+
      "let cachedSettings = null;"+
      "async function getLLMSettings() { if (cachedSettings) return cachedSettings; return new Promise((resolve) => { try { if (window.parent && window.parent !== window) { var msgId = 'settings-' + Date.now(); var timeout = setTimeout(() => { console.warn('[TWV LLM Remote] Settings request timeout, using defaults'); resolve({ apiKey: DEFAULT_OPENROUTER_API_KEY, model: DEFAULT_OPENROUTER_MODEL }); }, 2000); window.addEventListener('message', function handler(ev) { try { if (ev.data && ev.data.source === 'twv-host' && ev.data.type === 'settings' && ev.data.requestId === msgId) { clearTimeout(timeout); window.removeEventListener('message', handler); var settings = { apiKey: ev.data.apiKey || DEFAULT_OPENROUTER_API_KEY, model: ev.data.model || DEFAULT_OPENROUTER_MODEL }; cachedSettings = settings; console.log('[TWV LLM Remote] Received settings from parent'); resolve(settings); } } catch(_) {} }); window.parent.postMessage({ source: 'twv-client', type: 'getSettings', requestId: msgId }, '*'); } else { resolve({ apiKey: DEFAULT_OPENROUTER_API_KEY, model: DEFAULT_OPENROUTER_MODEL }); } } catch(e) { console.error('[TWV LLM Remote] Error requesting settings:', e); resolve({ apiKey: DEFAULT_OPENROUTER_API_KEY, model: DEFAULT_OPENROUTER_MODEL }); } }); }"+
      "function updateLLMButtonVisibility() { try { var value = input.value || ''; if (value.includes(' -- ')) { btnLLM.classList.add('visible'); } else { btnLLM.classList.remove('visible'); } } catch(e) { console.error('[TWV LLM Remote] Error updating button:', e); } }"+
      "async function callLLMToEditClasses(classesText, userPrompt) { try { var settings = await getLLMSettings(); console.log('[TWV LLM Remote] API call starting'); console.log('[TWV LLM Remote] Using model:', settings.model); console.log('[TWV LLM Remote] Classes:', classesText); console.log('[TWV LLM Remote] Prompt:', userPrompt); var systemPrompt = 'Edit these tailwind classes <tailwind_classes>' + classesText + '</tailwind_classes> and return the new, full, edited tailwind, according to the following prompt: <user_prompt>' + userPrompt + '</user_prompt> Return your classes in the format: <edited_tw> updated class list here </edited_tw>'; var response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/user/TailwindVSCode', 'X-Title': 'Tailwind VSCode Extension' }, body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: systemPrompt }] }) }); console.log('[TWV LLM Remote] Response status:', response.status); if (!response.ok) { var errorText = await response.text(); console.error('[TWV LLM Remote] API error:', errorText); throw new Error('API request failed: ' + response.status); } var data = await response.json(); console.log('[TWV LLM Remote] Response data:', JSON.stringify(data, null, 2)); var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content; if (!content) { console.error('[TWV LLM Remote] No content in response'); throw new Error('No content in API response'); } console.log('[TWV LLM Remote] Raw content:', content); var match = content.match(/<edited_tw>\\s*([\\s\\S]*?)\\s*<\\/edited_tw>/i); if (!match || !match[1]) { console.error('[TWV LLM Remote] Could not find <edited_tw> tags'); var trimmed = content.trim(); if (trimmed && !trimmed.includes('\\n') && trimmed.split(' ').length < 50) { console.log('[TWV LLM Remote] Using raw content as fallback'); return trimmed; } throw new Error('Could not extract edited classes'); } var editedClasses = match[1].trim(); console.log('[TWV LLM Remote] Extracted classes:', editedClasses); return editedClasses; } catch(e) { console.error('[TWV LLM Remote] Error calling API:', e); throw e; } }"+
      "async function handleLLMEdit() { try { var value = input.value || ''; var separatorIndex = value.indexOf(' -- '); if (separatorIndex === -1) { console.warn('[TWV LLM Remote] No -- separator found'); return; } var classesText = value.substring(0, separatorIndex).trim(); var userPrompt = value.substring(separatorIndex + 4).trim(); if (!classesText || !userPrompt) { console.warn('[TWV LLM Remote] Empty classes or prompt'); alert('Please provide both classes and a prompt separated by --'); return; } console.log('[TWV LLM Remote] Processing edit request'); btnLLM.disabled = true; btnLLM.textContent = 'Processing...'; try { var editedClasses = await callLLMToEditClasses(classesText, userPrompt); console.log('[TWV LLM Remote] Successfully got edited classes:', editedClasses); input.value = editedClasses; console.log('[TWV LLM Remote] Updated input value'); input.dispatchEvent(new Event('input', { bubbles: true })); updateLLMButtonVisibility(); console.log('[TWV LLM Remote] Edit complete'); } catch(e) { console.error('[TWV LLM Remote] Error during edit:', e); alert('Error editing classes with LLM: ' + e.message); } finally { btnLLM.disabled = false; btnLLM.textContent = 'Send to LLM'; } } catch(e) { console.error('[TWV LLM Remote] Error in handleLLMEdit:', e); } }"+
      "input.addEventListener('input', updateLLMButtonVisibility);"+
      "btnLLM.addEventListener('click', function(ev) { ev.preventDefault(); handleLLMEdit(); });"+
      // Common editing shortcuts inside textarea (select/copy/cut/undo/redo) with clipboard fallback
      "try { input.addEventListener('keydown', function(ev){ try { const k = String(ev.key||'').toLowerCase(); const mod = !!(ev.metaKey||ev.ctrlKey); if (!mod) return; if (k==='a'){ ev.preventDefault(); ev.stopPropagation(); try{ input.select(); }catch(_){} return; } if (k==='c'){ ev.preventDefault(); ev.stopPropagation(); var ok=false; try{ ok = !!document.execCommand('copy'); }catch(_){} if (!ok) { try { var s = (input.selectionStart|0), e = (input.selectionEnd|0); var txt = (e>s) ? input.value.slice(s,e) : String(input.value||''); window.parent && window.parent.postMessage({ source:'twv-client', type:'clipboardWrite', text: txt }, '*'); } catch(_){} } return; } if (k==='x'){ ev.preventDefault(); ev.stopPropagation(); var ok=false; try{ ok = !!document.execCommand('cut'); }catch(_){} if (!ok) { try { var s = (input.selectionStart|0), e = (input.selectionEnd|0); if (e>s) { var txt = input.value.slice(s,e); window.parent && window.parent.postMessage({ source:'twv-client', type:'clipboardWrite', text: txt }, '*'); input.value = input.value.slice(0,s) + input.value.slice(e); input.dispatchEvent(new Event('input', { bubbles:true })); } } catch(_){} } return; } if (k==='z'){ ev.preventDefault(); ev.stopPropagation(); try{ document.execCommand(ev.shiftKey ? 'redo' : 'undo'); }catch(_){} return; } if (k==='y'){ ev.preventDefault(); ev.stopPropagation(); try{ document.execCommand('redo'); }catch(_){} return; } } catch(_){} }, { capture: true }); } catch(_){}"+
      
      "function updateUI(target, x, y) {"+
        "if (!(target instanceof Element)) { outline.classList.add('hidden'); tooltip.classList.add('hidden'); return; }"+
        "const rect = target.getBoundingClientRect();"+
        "outline.style.left = rect.left + 'px'; outline.style.top = rect.top + 'px'; outline.style.width = rect.width + 'px'; outline.style.height = rect.height + 'px'; outline.classList.remove('hidden');"+
        "const classes = Array.from(target.classList || []);"+
        "const tag = target.tagName.toLowerCase(); const id = target.id ? '#' + target.id : '';"+
        "const clsStr = classes.length ? classes.join(' ') : '';"+
        "tooltip.innerHTML = '<span class=\\\"twv-tag\\\">' + tag + id + '</span>' + (clsStr ? ' · <span class=\\\"twv-classes\\\">' + clsStr.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' : ' · <span class=\\\"twv-none\\\">no classes</span>');"+
        "const tw = tooltip.getBoundingClientRect().width; const th = tooltip.getBoundingClientRect().height; let tx = x + 12; let ty = y + 12; const vw = window.innerWidth; const vh = window.innerHeight; if (tx + tw + 8 > vw) tx = Math.max(8, vw - tw - 8); if (ty + th + 8 > vh) ty = Math.max(8, vh - th - 8);"+
        "tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px'; tooltip.classList.remove('hidden');"+
      "}"+
      "function hideUI(){ outline.classList.add('hidden'); tooltip.classList.add('hidden'); }"+
      
      "let lastEl = null;"+
      "d.addEventListener('mousemove', (e) => { const el = e.target; if (!(el instanceof Element)) { hideUI(); return; } if (el !== lastEl) lastEl = el; updateUI(el, e.clientX, e.clientY); }, { capture: true });"+
      "d.addEventListener('mouseleave', hideUI, { capture: true });"+
      "const shield = d.createElement('div'); shield.id = 'twv-shield'; d.documentElement.appendChild(shield);"+
      "let paused = false; function setPaused(on){ paused = !!on; d.documentElement.classList.toggle('twv-paused', paused); }"+
      "window.addEventListener('message', (ev) => { try { const data = ev.data || {}; if (data && data.source === 'twv-host') { if (data.type === 'setPaused') { setPaused(!!data.value); } else if (data.type === 'clearSettingsCache') { cachedSettings = null; console.log('[TWV LLM Remote] Settings cache cleared'); } } } catch(_){} });"+
      
      "function openEditorFor(el, x, y) {"+
        "const originalClasses = (el.getAttribute('class') || '').trim();"+
        "var savedScrollY = window.scrollY; var savedScrollX = window.scrollX;"+
        "input.value = originalClasses; editor.style.display = 'block'; editor.style.transform = 'none';"+
        "window.scrollTo(savedScrollX, savedScrollY);"+
        "input.focus({ preventScroll: true }); window.scrollTo(savedScrollX, savedScrollY); try { input.setSelectionRange(originalClasses.length, originalClasses.length); } catch(_) {}"+
        "const target = el.getBoundingClientRect(); const vw = window.innerWidth; const vh = window.innerHeight; let r = editor.getBoundingClientRect();"+
        "let ex = (typeof x === 'number' ? x : (target.left + target.right)/2) - r.width/2; ex = Math.max(8, Math.min(vw - r.width - 8, ex));"+
        "let below = (typeof y === 'number' ? y : target.bottom) + 12; let above = (typeof y === 'number' ? y : target.top) - r.height - 12; let ey = below; if (ey + r.height + 8 > vh && above >= 8) ey = Math.max(8, above); ey = Math.max(8, Math.min(vh - r.height - 8, ey));"+
        "editor.style.left = ex + 'px'; editor.style.top = ey + 'px';"+
        "function livePreview(){ try { var newVal = input.value.trim(); el.setAttribute('class', newVal); } catch(e) { console.error('[TWV LLM Remote] Error in live preview:', e); } }"+
        "function autosize(){ input.style.height = 'auto'; input.style.height = Math.min(280, input.scrollHeight + 2) + 'px'; r = editor.getBoundingClientRect(); let ny = r.top; if (r.bottom > vh - 8) ny = Math.max(8, vh - 8 - r.height); editor.style.top = ny + 'px'; }"+
        "autosize(); input.addEventListener('input', autosize); input.addEventListener('input', livePreview); window.addEventListener('resize', autosize, { passive: true });"+
        "function close(restoreOriginal){ if (restoreOriginal) { el.setAttribute('class', originalClasses); console.log('[TWV LLM Remote] Cancelled - restored original classes:', originalClasses); } editor.style.display = 'none'; input.removeEventListener('input', autosize); input.removeEventListener('input', livePreview); d.removeEventListener('keydown', onKey, true); }"+
        "async function commit(){ const before = originalClasses; const after = (input.value || '').trim(); el.setAttribute('class', after); try { var txt=''; try{ txt=(el.textContent||'').trim().slice(0,160);}catch(_){txt='';} window.parent && window.parent.postMessage({ source:'twv-client', type:'update', before: before, after: after, text: txt, tag: (el.tagName||'').toLowerCase(), id: el.id||'' }, '*'); } catch(e){} close(); }"+
        "function onKey(ev){ if (ev.key === 'Escape') { ev.preventDefault(); close(true); } if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); var value = input.value || ''; if (value.includes(' -- ')) { console.log('[TWV LLM Remote] Enter pressed with -- detected, triggering LLM'); handleLLMEdit(); } else { commit(); } } }"+
        "d.addEventListener('keydown', onKey, { capture:true }); btnCancel.onclick = (ev) => { ev.preventDefault(); close(true); }; btnSave.onclick = (ev) => { ev.preventDefault(); commit(); };"+
      "}"+
      "d.addEventListener('dblclick', (e) => { const t = e.target; if (t && t.closest && t.closest('#twv-editor')) return; if (!(t instanceof Element)) return; e.preventDefault(); e.stopPropagation(); openEditorFor(t, e.clientX, e.clientY); }, { capture: true });"+
      "const swallow = (ev) => { if (!paused) return; const path = ev.composedPath ? ev.composedPath() : []; const t = ev.target; const inEditor = (n) => !!n && (n.id === 'twv-editor' || (n.closest && n.closest('#twv-editor'))); if (inEditor(t) || (Array.isArray(path) && path.some(inEditor))) return; ev.stopImmediatePropagation(); ev.preventDefault(); };"+
      "['click','dblclick','mousedown','mouseup','pointerdown','pointerup','pointermove','mousemove','contextmenu','touchstart','touchend','dragstart','dragover','drop','mouseover','mouseout','mouseenter','mouseleave'].forEach(t => { d.addEventListener(t, swallow, { capture: true }); });"+
      // Global undo/redo when not editing inside our textarea
      "d.addEventListener('keydown', (ev) => { try { const k = String(ev.key||'').toLowerCase(); const meta = !!(ev.metaKey||ev.ctrlKey); if (!meta || k !== 'z') return; if (d.activeElement && d.activeElement.closest && d.activeElement.closest('#twv-editor')) return; ev.preventDefault(); ev.stopPropagation(); window.parent && window.parent.postMessage({ source:'twv-client', type: (ev.shiftKey ? 'redo' : 'undo') }, '*'); } catch(_){} }, { capture: true });"+
    "} catch (e) { console.error('twv remote client error', e); }"+
  "})();";
}

function deactivate() {}

module.exports = { activate, deactivate };
