// Generates public/og-default.png (1200x630 social card). Run: node scripts/make-og.mjs
import sharp from 'sharp';

const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0d0f10"/>
  <rect x="0" y="624" width="1200" height="6" fill="#00d4aa"/>
  <g transform="translate(80,120)">
    <polygon points="36,0 68,18 68,54 36,72 4,54 4,18" fill="none" stroke="#00d4aa" stroke-width="4"/>
    <polyline points="12,36 26,36 32,20 42,52 48,36 60,36" fill="none" stroke="#e8eaed" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="80" y="300" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#e8eaed">tracepod</text>
  <text x="80" y="390" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#9aa3ab">Harden containers based on what</text>
  <text x="80" y="438" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#9aa3ab">they actually do <tspan fill="#00d4aa">at runtime.</tspan></text>
  <text x="80" y="540" font-family="Courier New, monospace" font-size="22" fill="#5c666f">OPEN-CORE &#183; AGPL-3.0 &#183; KUBERNETES-NATIVE</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('public/og-default.png');
console.log('og-default.png written');
