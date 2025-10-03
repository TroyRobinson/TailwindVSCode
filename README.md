# Tailwind Preview + Hover

Preview any HTML file that uses Tailwind (CDN or local build) and hover elements to see applied classes in a tooltip.

Quick start: command+shift+p then Tailwind: Open Server Preview

Features:

- Editor title button on HTML files detected to use Tailwind.
- Opens a live preview in a Webview beside the editor.
- Hover over elements to see their classes in a tooltip, with a highlight box.
- Pause/Resume control in preview to disable all interactivity for safe inspection and editing.
- Editing runtime UI: When you edit classes on dynamically created elements, the extension applies the change to similar elements and updates inline/external script templates in the source when possible.
- **NEW: AI-Powered Class Editing**: Use LLMs to edit Tailwind classes with natural language prompts! In the class editor, type your classes followed by " -- " and a description of how you want to modify them (e.g., "p-4 bg-blue-500 -- make it red with larger padding"). Press Enter or click "Send to LLM" to automatically generate the updated classes.
- NEW: Server Preview for Vite/SSR dev servers. Open a URL (e.g., http://localhost:5173) in a webview, inject a lightweight client helper into your app, and edit Tailwind classes live. The extension persists exact string-literal class edits across your workspace (React/Vue/Svelte/HTML/etc.).
  - Includes a Pause/Resume toggle in the preview toolbar to suppress app interactions while selecting elements.

Notes:

- Detection looks for the Tailwind CDN, references to files with "tailwind" in their name, or common Tailwind utility classes in `class` attributes.
- For local resources, the preview resolves relative links via a `<base>` tag. Absolute root paths (`/assets/...`) are rewritten to the first workspace folder.
- The preview allows loading HTTPS resources (e.g., the Tailwind CDN).

Commands:

- Tailwind: Open Preview (`tailwindPreview.openPreview`)
- Tailwind: Open Server Preview (`tailwindPreview.openServerPreview`)

**Development Notes**
- Preview pipeline: The extension injects a helper script and styles into the webview. It inserts a `<base>` tag and a permissive CSP to allow Tailwind CDN and local assets. Absolute-root URLs (`/assets/...`) are rewritten to the first workspace folder.
- Tailwind detection: Command/menu enabled via `tailwindPreview.hasTailwind` context key; checks for CDN, filenames containing "tailwind", or common utility classes.
- Class-to-source mapping: Uses a robust HTML parser (parse5) with location info to map `class` attribute value byte offsets precisely, even with complex attributes. Start tags with a `class` attribute get `data-twv-uid` in the preview. Edits persist only when you double‑click the mapped element. Offsets are adjusted in-memory after each edit so subsequent edits remain accurate; saving also refreshes the mapping.
- Pause/Resume: Toggle in the preview’s top‑right (and `p` key) freezes interactions. We:
  - Show a non-interactive shield and pause CSS animations/transitions; pause playing audio/video.
  - Swallow most pointer events in capture phase but allow our UI controls/editor; keyboard events are not suppressed so `p` works.
  - Picking uses `elementsFromPoint` and ignores our overlay so you can highlight/select runtime overlays (e.g., tooltips) while paused.
- Editing behavior:
  - Double‑click any element to edit its `class`. If it has `data-twv-uid`, we persist to the HTML source at the recorded offsets.
  - If it’s runtime‑only (no uid), we still edit in the preview and register a runtime rule so similar elements (now/future) adopt the change. We also attempt to persist by rewriting matching class string literals inside inline `<script>` blocks and local external scripts referenced by the HTML.
- Runtime rules for dynamic nodes: Rules match by exact class set (order‑agnostic). We pick a simple anchor class (CSS‑safe token) to limit DOM scans; otherwise we scan a bounded number of nodes. A `MutationObserver` applies rules to newly added elements.
- Source persistence for dynamic edits: String‑literal replacement is performed for "…", '…', and `…` inside inline scripts and workspace‑local `<script src="…">` targets. It does not rewrite bundled/minified outputs, template expressions, or concatenations.
- URL/CSP quirks: CSP allows inline/eval for the helper script and Tailwind CDN. Local resources are allowed via `webview.asWebviewUri`. If an app depends on blocked external origins (e.g., fonts), extend the CSP or use local copies.
- Known limitations:
  - Class mapping is best‑effort; complicated HTML, framework hydration, or post‑render modifications can break uid match. Reopen the preview to re-sync.
  - CSS `:hover` cannot be “locked”; Pause preserves the current hover, but moving away will drop pure CSS hovers. JS‑driven overlays generally remain because we suppress their hide handlers.
  - Dynamic source updates only cover exact string matches in JS; broader persistence may require workspace‑wide find/replace or AST transforms.
  - Server Preview cannot access cross‑origin iframe DOM. The remote client helper script must be included in your app’s HTML template to enable hover/edit inside the app frame.
  - Some dev servers/frameworks set `X-Frame-Options` or `Content-Security-Policy: frame-ancestors 'none'` which will block embedding in the webview’s iframe. Disable these in development to use Server Preview.

Server Preview: how it works
- The extension spins up a tiny localhost server to serve a client helper script at `http://127.0.0.1:7832/twv-client.js` (port may vary if in use).
- You open your dev server URL in a webview iframe. The iframe is allowed by the webview CSP (`frame-src http: https:`). The extension does not access iframe DOM.
- You add `<script src="http://127.0.0.1:7832/twv-client.js"></script>` to your app’s root HTML template (e.g., `index.html` for Vite) during development. The client overlays hover + an editor on double‑click inside your app and posts updates to the parent webview.
- The extension receives the edit (before/after class string) and performs a workspace‑wide exact string‑literal replacement across common web files (`html, js, jsx, ts, tsx, vue, svelte, astro`) while skipping `node_modules`, build outputs, etc. Vite/SSR HMR picks up changes immediately and recompiles Tailwind JIT.

Server Preview gotchas and CORS/CSP notes
- Iframe blocking: If your dev app refuses to load in an iframe, remove `X-Frame-Options` and any `Content-Security-Policy` `frame-ancestors` restrictions in development.
- HTTP vs HTTPS: The webview CSP allows both `http:` and `https:` for `frame-src`, `script-src`, and `connect-src`. If your dev server is HTTPS with a self‑signed cert, your OS/trust store may prompt separately.
- CORS: The client helper loads via a classic `<script src>` tag and does not require CORS. For fetch/XHR made by your app, the webview does not interfere. The helper server sets `Access-Control-Allow-Origin: *` in case your app explicitly uses CORS‑mode fetch to load it.
- CSP in your app: If your app sets a strict CSP that blocks external scripts, whitelist `http://127.0.0.1:7832` (or the port shown in the Server Preview toolbar) under `script-src` in development.

Step-by-step: test Server Preview
1) Start a Vite app: `npm run dev` (e.g., http://localhost:5173).
2) In VS Code, run “Tailwind: Open Server Preview”. Enter your dev URL when prompted.
3) Click “Copy Client Script Tag” in the preview toolbar. Paste it into your app’s root HTML (e.g., `index.html`), near the end of `<body>` for dev only: `index.html: <body> … <script src="http://127.0.0.1:7832/twv-client.js"></script>`
4) Reload the page if needed. Hover elements inside the preview to see classes. Double‑click an element to edit its classes.
5) Use the Pause/Resume button (or press `p`) to pause interactions while you pick a target element.
6) On save, the extension replaces exact string‑literal occurrences of the old classes with the new classes across your workspace. Watch the Vite console for HMR and verify the UI updates.
7) Revert when done: remove the client script tag from your app (only needed during dev editing).

Step-by-step: test classic HTML Preview
1) Open an HTML file that uses Tailwind (CDN or local build).
2) Click "Tailwind: Open Preview" in the editor title.
3) Hover to inspect classes; double‑click to edit. Edits persist to the HTML source for mapped elements; dynamic edits attempt to update inline/external scripts referenced by the HTML.

## AI-Powered Class Editing

The extension now includes LLM integration to help you edit Tailwind classes using natural language prompts!

### How to use:

1. **Double-click an element** in the preview to open the class editor
2. **Type your current classes**, followed by ` -- ` (space-dash-dash-space), and then a description of how you want to change them
3. **Press Enter** or click the **"Send to LLM"** button (purple button that appears when you type "--")
4. The LLM will process your request and update the classes automatically
5. **See changes live** - The preview updates in real-time as you type or as the LLM generates new classes
6. When you're happy with the result, click **"Save"** to persist the changes to your HTML source file
7. **Cancel to undo** - Click "Cancel" or press Escape to instantly revert to the original classes

### Examples:

- `p-4 bg-blue-500 text-white -- make it red`
- `text-sm font-normal -- make the text larger and bold`
- `bg-green-600 text-white p-6 rounded shadow-lg -- increase the shadow and padding`
- `flex gap-4 items-center -- make it a grid with 3 columns`
- `bg-gradient-to-r from-cyan-500 to-blue-500 -- change to a purple gradient`

### Debugging:

- Open your browser console (F12 in the preview window) to see detailed debugging logs
- All LLM operations are logged with `[TWV LLM]` prefix
- Logs include: API requests, responses, class extraction, and any errors

### Technical details:

- Uses OpenRouter API with the `openai/gpt-oss-120b` model
- The LLM receives your classes and prompt in a structured format
- Response is parsed from `<edited_tw>` tags
- Falls back to raw response if tags aren't found
- Works in both regular preview and server preview modes
