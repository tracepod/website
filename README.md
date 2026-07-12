# Tracepod website

Product and documentation website for [Tracepod](https://tracepod.co.uk) — an eBPF-based container hardening tool.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) for the docs section. Outputs a fully static site for GitHub Pages.

## Getting started

```bash
npm install
npm run dev          # dev server at http://localhost:4321
npm run build        # production build → ./dist/
npm run preview      # preview the built output locally
```

## Pages

| Route | File |
|-------|------|
| `/` | `src/pages/index.astro` |
| `/open-source` | `src/pages/open-source.astro` |
| `/platform` | `src/pages/platform.astro` |
| `/contact` | `src/pages/contact.astro` |
| `/docs` | Starlight — `src/content/docs/docs/` |

## Contact form (Web3Forms)

The contact form (`src/pages/contact.astro`) POSTs to Web3Forms. Before deploying:

1. Sign up at https://web3forms.com/ and get a free access key.
2. Open `src/pages/contact.astro` and replace `WEB3FORMS_ACCESS_KEY_PLACEHOLDER` with your real key:

```html
<input type="hidden" name="access_key" value="YOUR_KEY_HERE" />
```

The form includes a honeypot field (`botcheck`) per Web3Forms documentation for basic spam protection.

## Dashboard screenshots

The `/platform` page has placeholder slots for three screenshots. Place images at:

- `public/screenshots/dashboard.png` — fleet dashboard overview
- `public/screenshots/workload-detail.png` — workload detail / manifest view
- `public/screenshots/cve-delta.png` — CVE delta report

Images will render automatically when present; the placeholder boxes are shown when missing.

## Design

- **Palette:** near-black (`#0d0f10`) background, electric teal (`#00d4aa`) accent, full light-mode support
- **Typography:** Inter (body), JetBrains Mono (code/terminal/labels)
- **Theme:** defaults to dark, respects `prefers-color-scheme`, stored in `localStorage`
- **Starlight** docs are styled to match via `src/styles/starlight-custom.css`

## Deployment (GitHub Pages)

The `public/CNAME` file contains `tracepod.co.uk`. Set `site: 'https://tracepod.co.uk'` is already in `astro.config.mjs`.

Recommended workflow:

```yaml
# .github/workflows/deploy.yml
- run: npm ci
- run: npm run build
- uses: actions/upload-pages-artifact@v3
  with:
    path: dist/
```
