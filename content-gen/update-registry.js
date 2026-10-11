const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = 'D:/mscms-content/registry.json';

// Read existing registry
let registry = { assets: [], updatedAt: new Date().toISOString() };
if (fs.existsSync(REGISTRY_PATH)) {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  registry.assets = Array.isArray(parsed) ? parsed : (parsed.assets || []);
}

// New assets to add
const newAssets = [
  {
    id: 'img_' + Date.now(),
    type: 'image',
    path: 'D:/mscms-content/images/Minimalist_flat_design_marketi_2026-09-04T05-46-29.png',
    filename: 'Minimalist_flat_design_marketi_2026-09-04T05-46-29.png',
    prompt: 'Minimalist flat design marketing illustration: smartphone social media dashboard',
    size: 1035000,
    width: 1024,
    height: 1024,
    provider: 'agnes-image-2.1-flash',
    createdAt: new Date().toISOString()
  },
  {
    id: 'vid_' + Date.now(),
    type: 'video',
    path: 'D:/mscms-content/videos/A_sleek_smartphone_on_a_modern_2026-09-04T05-47-05.mp4',
    filename: 'A_sleek_smartphone_on_a_modern_2026-09-04T05-47-05.mp4',
    prompt: 'Smartphone social media dashboard with animated charts',
    duration: 5,
    resolution: '720P',
    provider: 'agnes-video-v2.0',
    createdAt: new Date().toISOString()
  }
];

// Add new assets (avoid duplicates by filename)
const existingFilenames = new Set(registry.assets.map(a => a.filename));
newAssets.forEach(asset => {
  if (!existingFilenames.has(asset.filename)) {
    registry.assets.push(asset);
    console.log(`Added: ${asset.filename}`);
  } else {
    console.log(`Skipped (exists): ${asset.filename}`);
  }
});

registry.updatedAt = new Date().toISOString();

// Write back
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
console.log(`Registry updated: ${registry.assets.length} total assets`);
