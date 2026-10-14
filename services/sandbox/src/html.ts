/** Minimal page shell for the sandbox's own pages, always carrying the notice. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:72rem;margin:1.5rem auto;padding:0 1rem;color:#1a1a1a}
.notice{background:#fff3cd;border:1px solid #e0c36b;padding:.5rem .75rem;margin-bottom:1rem}
h1{font-size:1.35rem}h2{font-size:1.05rem;margin:1.2rem 0 .4rem}code{font-size:.9em}
table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:.25rem .5rem;text-align:left;vertical-align:top}`;

/** `body` is trusted HTML built by the sandbox; the title is escaped. */
export function page(title: string, body: string, notice: string, extraHead = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style>${extraHead}</head><body><div class="notice" role="note">${escapeHtml(notice)}</div><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
