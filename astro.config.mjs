// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://tracepod.co.uk',
  base: '/',
  integrations: [
    starlight({
      title: 'Tracepod Docs',
      description: 'eBPF-based container hardening — documentation',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/tracepod/tracepod' },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', slug: 'docs/getting-started/introduction' },
            { label: 'Installation', slug: 'docs/getting-started/installation' },
            { label: 'Quickstart', slug: 'docs/getting-started/quickstart' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How profiling works', slug: 'docs/concepts/how-profiling-works' },
            { label: 'Observation sources & confidence', slug: 'docs/concepts/observation-sources' },
            { label: 'Outputs', slug: 'docs/concepts/outputs' },
            { label: 'Known limitations', slug: 'docs/concepts/known-limitations' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Kubernetes deployment', slug: 'docs/guides/kubernetes' },
            { label: 'GitHub Action', slug: 'docs/guides/github-action' },
            { label: 'CVE reporting', slug: 'docs/guides/cve-reporting' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI reference', slug: 'docs/reference/cli' },
            { label: 'Runtime presets', slug: 'docs/reference/presets' },
          ],
        },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
    }),
  ],
});
