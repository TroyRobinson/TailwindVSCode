# Tailwind Preview + Hover

Preview any HTML file that uses Tailwind (CDN or local build) and hover elements to see applied classes in a tooltip.

Features:

- Editor title button on HTML files detected to use Tailwind.
- Opens a live preview in a Webview beside the editor.
- Hover over elements to see their classes in a tooltip, with a highlight box.
- Pause/Resume control in preview to disable all interactivity for safe inspection and editing.
- Editing runtime UI: When you edit classes on dynamically created elements, the extension applies the change to similar elements and updates inline/external script templates in the source when possible.

Notes:

- Detection looks for the Tailwind CDN, references to files with "tailwind" in their name, or common Tailwind utility classes in `class` attributes.
- For local resources, the preview resolves relative links via a `<base>` tag. Absolute root paths (`/assets/...`) are rewritten to the first workspace folder.
- The preview allows loading HTTPS resources (e.g., the Tailwind CDN).

Commands:

- Tailwind: Open Preview (`tailwindPreview.openPreview`)

**Development Notes**
- Preview pipeline: The extension injects a helper script and styles into the webview. It inserts a `<base>` tag and a permissive CSP to allow Tailwind CDN and local assets. Absolute-root URLs (`/assets/...`) are rewritten to the first workspace folder.
- Tailwind detection: Command/menu enabled via `tailwindPreview.hasTailwind` context key; checks for CDN, filenames containing "tailwind", or common utility classes.
- Class-to-source mapping: At preview build, start tags with a `class` attribute get `data-twv-uid` and we record byte offsets for the class value. Edits only persist if you double‑click the exact mapped element. If the source diverges after opening the preview, we warn and skip; reopen the preview to re-sync.
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
