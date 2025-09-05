# Tailwind Preview + Hover

Preview any HTML file that uses Tailwind (CDN or local build) and hover elements to see applied classes in a tooltip.

Features:

- Editor title button on HTML files detected to use Tailwind.
- Opens a live preview in a Webview beside the editor.
- Hover over elements to see their classes in a tooltip, with a highlight box.

Notes:

- Detection looks for the Tailwind CDN, references to files with "tailwind" in their name, or common Tailwind utility classes in `class` attributes.
- For local resources, the preview resolves relative links via a `<base>` tag. Absolute root paths (`/assets/...`) are rewritten to the first workspace folder.
- The preview allows loading HTTPS resources (e.g., the Tailwind CDN).

Commands:

- Tailwind: Open Preview (`tailwindPreview.openPreview`)

