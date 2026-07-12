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
          label: 'Installation',
          items: [
            { label: 'Overview', slug: 'docs/installation/overview' },
          ],
        },
        {
          label: 'Quickstart',
          items: [
            { label: 'Quickstart guide', slug: 'docs/quickstart/guide' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How it works', slug: 'docs/concepts/how-it-works' },
          ],
        },
        {
          label: 'Kubernetes',
          items: [
            { label: 'Helm chart', slug: 'docs/kubernetes/helm' },
          ],
        },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
    }),
  ],
});
