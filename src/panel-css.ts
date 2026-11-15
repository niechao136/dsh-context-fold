/**
 * The conversation tab's stylesheet.
 *
 * ## Why a stylesheet instead of inline styles
 *
 * The first version rendered with inline `style` objects: no hover states, no
 * dark-theme variants, no transitions, and a monospace wall that ignored the
 * shell's design language. The shell already ships a token layer
 * (`--dsw-alias-*` for colour, `--ds-transition-duration` / `--ds-ease-in-out`
 * for motion) plus a `data-ds-dark-theme` body attribute, so the tab should
 * consume those instead of inventing a palette.
 *
 * ## How it reaches the page
 *
 * A client bundle cannot import a CSS file — the loader executes the bundle as a
 * classic script — so the sheet is injected once at module scope as
 * `<style data-plugin-css>`. The `data-plugin-css` marker makes the injection
 * idempotent across HMR and re-mounts, which is the same mechanism the bundled
 * first-party plugins use.
 *
 * @module dsh-context-fold/panel-css
 */

/** Unique key so the sheet is injected at most once per document. */
const CSS_KEY = 'dsh-context-fold/panel.css'

/**
 * Every rule is scoped under `.cf-`, so nothing here can leak into the shell.
 *
 * Colours come from the alias tokens with literal fallbacks: if a token is ever
 * renamed, the tab still renders legibly rather than going transparent.
 */
const CSS = `
.cf-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px 32px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  background: var(--dsw-alias-bg-base, transparent);
}

.cf-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.cf-head-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .01em;
}

.cf-head-note {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
}

.cf-card {
  border: .5px solid var(--dsw-alias-border-l3, #3a3a40);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #1c1c20);
  padding: 14px 16px;
}

.cf-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.cf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
}

.cf-metric {
  border: .5px solid var(--dsw-alias-border-l2, #303036);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #202024);
  padding: 10px 12px;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out),
    border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-metric:hover {
  background: var(--dsw-alias-interactive-bg-hover, #26262c);
}

.cf-metric-label {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cf-metric-value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.cf-metric-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
  font-variant-numeric: tabular-nums;
}

.cf-good { color: var(--dsw-alias-state-success-primary, #4ade80); }
.cf-bad { color: var(--dsw-alias-state-error-primary, #f87171); }
.cf-warn { color: var(--dsw-alias-state-warn-primary, #facc15); }
.cf-dim { color: var(--dsw-alias-label-tertiary, #8b8b93); }

.cf-bar {
  display: flex;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, #2a2a30);
  margin-top: 10px;
}

.cf-bar-seg {
  height: 100%;
  transition: width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-bar-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.cf-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cf-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}

.cf-notice {
  display: flex;
  gap: 8px;
  border-radius: 8px;
  border: .5px solid var(--dsw-alias-border-l3, #3a3a40);
  background: var(--dsw-alias-bg-layer-2, #202024);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.cf-notice-strong {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e8e8ea);
}

.cf-notice.cf-notice-warn {
  border-color: var(--dsw-alias-state-warn-primary, #facc15);
}

.cf-folds {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cf-fold {
  border: .5px solid var(--dsw-alias-border-l2, #303036);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #1c1c20);
  overflow: hidden;
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-fold:hover {
  border-color: var(--dsw-alias-border-l4, #4a4a52);
}

.cf-fold[open] {
  border-color: var(--dsw-alias-border-l4, #4a4a52);
}

.cf-fold-head {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 9px 12px;
  list-style: none;
  user-select: none;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-fold-head::-webkit-details-marker { display: none; }

.cf-fold-head:hover {
  background: var(--dsw-alias-interactive-bg-hover, #26262c);
}

.cf-caret {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
  transition: transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-fold[open] .cf-caret { transform: rotate(90deg); }

.cf-tag {
  flex: none;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  background: var(--dsw-alias-bg-layer-3, #2a2a30);
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.cf-tag-reasoning {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #6b8afd) 18%, transparent);
  color: var(--dsw-alias-brand-primary, #8aa2ff);
}

.cf-fold-pos {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
}

.cf-fold-saving {
  margin-left: auto;
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary, #4ade80);
}

.cf-fold-body {
  padding: 0 12px 12px;
  border-top: .5px solid var(--dsw-alias-border-l2, #303036);
}

.cf-label {
  margin: 10px 0 4px;
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
}

.cf-pre {
  margin: 0;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3, #2a2a30);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 16em;
  overflow: auto;
}

.cf-pre-original {
  max-height: 26em;
  border-left: 2px solid var(--dsw-alias-brand-primary, #6b8afd);
}

.cf-locator {
  margin-top: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
  word-break: break-all;
}

.cf-empty {
  padding: 24px 4px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
}

.cf-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  margin-bottom: 6px;
}

.cf-aside {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
}

.cf-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}

.cf-search {
  flex: 1 1 200px;
  min-width: 160px;
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 7px;
  border: .5px solid var(--dsw-alias-border-l3, #3a3a40);
  background: var(--dsw-alias-bg-layer-2, #202024);
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-family: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-search::placeholder { color: var(--dsw-alias-label-tertiary, #8b8b93); }

.cf-search:focus {
  border-color: var(--dsw-alias-brand-primary, #6b8afd);
}

.cf-seg {
  display: inline-flex;
  border-radius: 7px;
  border: .5px solid var(--dsw-alias-border-l3, #3a3a40);
  background: var(--dsw-alias-bg-layer-2, #202024);
  overflow: hidden;
  flex: none;
}

.cf-seg-btn {
  border: 0;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  background: transparent;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-seg-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #26262c); }

.cf-seg-on {
  background: var(--dsw-alias-interactive-bg-active, #303038);
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-weight: 600;
}

.cf-turns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.cf-turn {
  border: .5px solid var(--dsw-alias-border-l2, #303036);
  border-radius: 999px;
  padding: 3px 9px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  background: transparent;
  font-variant-numeric: tabular-nums;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out),
    border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}

.cf-turn:hover {
  background: var(--dsw-alias-interactive-bg-hover, #26262c);
}

.cf-turn-on {
  border-color: var(--dsw-alias-brand-primary, #6b8afd);
  color: var(--dsw-alias-brand-primary, #8aa2ff);
  font-weight: 600;
}

.cf-list-note {
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b8b93);
  font-variant-numeric: tabular-nums;
}
`

/**
 * Inject the sheet once.
 *
 * Safe to call on every mount: the `data-plugin-css` key makes a second call a
 * no-op, and a non-browser environment (tests, SSR) simply returns.
 */
export function ensurePanelCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_KEY)}]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-context-fold'
  style.dataset.pluginCss = CSS_KEY
  style.textContent = CSS
  document.head.appendChild(style)
}
