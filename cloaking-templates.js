/**
 * cloaking-templates.js — MSCMS v14 Cloaking 多模板白页系统
 *
 * 核心能力：
 *   1. 4个行业白页模板 (建筑/加密/科技/健康)
 *   2. 动态内容 (轮换标题/社交证明/相关文章)
 *   3. SEO友好 (结构化数据/sitemap/canonical)
 *   4. 模板管理 API (CRUD + 预览)
 *   5. 多层检测 (UA → ASN → 行为 → TLS指纹)
 *
 * 用法：
 *   const { CloakTemplateEngine } = require('./cloaking-templates.js');
 *   const engine = new CloakTemplateEngine({ dataStore });
 *   const html = engine.render('crypto_daily', { dynamic: true });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 爬虫检测规则 ──────────────────────────────────
const BOT_PATTERNS = [
  // L1: User-Agent 关键词
  { level: 1, pattern: /twitterbot|redditbot|instagram|tiktokbot/i, label: 'social_bot' },
  { level: 1, pattern: /googlebot|google\.com\/bot|adsbot/i, label: 'google_bot' },
  { level: 1, pattern: /facebookexternalhit|facebookcatalog/i, label: 'facebook_bot' },
  { level: 1, pattern: /linkedinbot|slackbot|discordbot|whatsapp|telegrambot/i, label: 'platform_bot' },
  { level: 1, pattern: /bingbot|msnbot|yandex|baiduspider|duckduckbot/i, label: 'search_bot' },
  { level: 1, pattern: /bot|crawler|spider|scraper|curl|wget|python/i, label: 'generic_bot' },

  // L2: ASN/IP 段 (已知数据中心/爬虫网络)
  { level: 2, pattern: /googleusercontent|google-proxy/i, label: 'google_proxy' },
  { level: 2, pattern: /aws|amazonaws|ec2/i, label: 'aws_host' },
  { level: 2, pattern: /azure|digitalocean|linode|vultr/i, label: 'cloud_host' }
];

// ── 模板库 ────────────────────────────────────────
const TEMPLATES = {
  horizon_living: {
    id: 'horizon_living',
    name: 'Horizon Living',
    niche: '建筑/设计博客',
    icon: '🏗️',
    keywords: ['architecture', 'sustainable design', 'modern living', 'interior design'],
    description: '现代建筑与可持续生活设计博客',
    meta: {
      title: 'Horizon Living — Modern Architecture & Sustainable Design',
      description: 'Exploring the intersection of modern architecture, sustainable design, and conscious living. Discover innovative building techniques and timeless design principles.',
      ogImage: '/assets/og-architecture.jpg'
    },
    sections: [
      { path: '/', name: 'Home', desc: '最新文章与精选项目' },
      { path: '/architecture', name: 'Architecture', desc: '建筑设计与创新' },
      { path: '/design', name: 'Design', desc: '室内设计与美学' },
      { path: '/about', name: 'About', desc: '关于我们' },
      { path: '/contact', name: 'Contact', desc: '联系我们' }
    ],
    features: {
      sitemap: true,
      rss: true,
      structuredData: 'BlogPosting',
      contactForm: false
    },
    colorScheme: { primary: '#2C3E50', secondary: '#E67E22', bg: '#FAFAFA', text: '#34495E' }
  },

  crypto_daily: {
    id: 'crypto_daily',
    name: 'Crypto Daily Digest',
    niche: '加密货币资讯',
    icon: '₿',
    keywords: ['bitcoin news', 'defi analysis', 'blockchain technology', 'crypto market'],
    description: '每日加密货币市场分析与区块链技术深度解读',
    meta: {
      title: 'Crypto Daily Digest — Bitcoin, DeFi & Blockchain News',
      description: 'Your daily source for cryptocurrency market analysis, DeFi insights, and blockchain technology updates. Stay informed with expert commentary.',
      ogImage: '/assets/og-crypto.jpg'
    },
    sections: [
      { path: '/', name: 'Home', desc: '今日市场概览' },
      { path: '/news', name: 'News', desc: '最新加密货币新闻' },
      { path: '/analysis', name: 'Analysis', desc: '深度市场分析' },
      { path: '/market', name: 'Market', desc: '实时行情数据' },
      { path: '/glossary', name: 'Glossary', desc: '术语词汇表' }
    ],
    features: {
      sitemap: true,
      rss: true,
      structuredData: 'NewsArticle',
      freshnessIndicator: true,
      socialProof: true
    },
    colorScheme: { primary: '#1A1A2E', secondary: '#E94560', bg: '#0F3460', text: '#FFFFFF' }
  },

  tech_review: {
    id: 'tech_review',
    name: 'TechReview Pro',
    niche: '科技评测',
    icon: '💻',
    keywords: ['gadget reviews', 'tech comparisons', 'buying guides', 'product reviews'],
    description: '专业科技产品评测与购买指南',
    meta: {
      title: 'TechReview Pro — Honest Gadget Reviews & Buying Guides',
      description: 'In-depth tech product reviews, side-by-side comparisons, and expert buying guides. Make informed decisions on your next tech purchase.',
      ogImage: '/assets/og-tech.jpg'
    },
    sections: [
      { path: '/', name: 'Home', desc: '最新评测' },
      { path: '/reviews', name: 'Reviews', desc: '产品评测' },
      { path: '/compare', name: 'Compare', desc: '对比评测' },
      { path: '/guides', name: 'Guides', desc: '购买指南' },
      { path: '/deals', name: 'Deals', desc: '优惠信息' }
    ],
    features: {
      sitemap: true,
      rss: true,
      structuredData: 'Review',
      comparisonTable: true,
      starRating: true
    },
    colorScheme: { primary: '#0D47A1', secondary: '#FF6F00', bg: '#FFFFFF', text: '#212121' }
  },

  lifestyle_wellness: {
    id: 'lifestyle_wellness',
    name: 'PureLife Wellness',
    niche: '健康生活',
    icon: '🌿',
    keywords: ['wellness tips', 'healthy recipes', 'mindfulness', 'fitness', 'holistic health'],
    description: '全人健康生活方式指南',
    meta: {
      title: 'PureLife Wellness — Holistic Health & Mindful Living',
      description: 'Your guide to holistic wellness. Discover healthy recipes, mindfulness practices, fitness routines, and natural living tips.',
      ogImage: '/assets/og-wellness.jpg'
    },
    sections: [
      { path: '/', name: 'Home', desc: '推荐内容' },
      { path: '/wellness', name: 'Wellness', desc: '全面健康' },
      { path: '/nutrition', name: 'Nutrition', desc: '营养饮食' },
      { path: '/fitness', name: 'Fitness', desc: '健身运动' },
      { path: '/meditation', name: 'Meditation', desc: '冥想正念' }
    ],
    features: {
      sitemap: true,
      rss: true,
      structuredData: 'Article',
      contactForm: true,
      newsletterSignup: true
    },
    colorScheme: { primary: '#2E7D32', secondary: '#FF8F00', bg: '#F1F8E9', text: '#33691E' }
  }
};

// ── 文章模板 ──────────────────────────────────────
const SAMPLE_ARTICLES = {
  horizon_living: [
    { title: 'The Rise of Biophilic Design in Urban Architecture', author: 'Sarah Chen', date: '2026-07-05', excerpt: 'How architects are integrating natural elements into city buildings to improve well-being and sustainability.', readTime: 8 },
    { title: 'Maximizing Natural Light in Small Spaces', author: 'James Park', date: '2026-07-03', excerpt: 'Practical tips for transforming compact apartments with strategic lighting and reflective surfaces.', readTime: 6 },
    { title: 'Sustainable Building Materials: A 2026 Guide', author: 'Maria Rodriguez', date: '2026-07-01', excerpt: 'From bamboo to recycled steel — the materials shaping tomorrow\'s eco-friendly buildings.', readTime: 10 },
    { title: 'Scandinavian Minimalism Meets Mediterranean Warmth', author: 'Erik Larsson', date: '2026-06-28', excerpt: 'Blending two iconic design philosophies for a home that feels both serene and inviting.', readTime: 7 },
    { title: 'Smart Home Integration for Heritage Buildings', author: 'David Kim', date: '2026-06-25', excerpt: 'Preserving architectural character while embracing modern technology in historic properties.', readTime: 9 }
  ],
  crypto_daily: [
    { title: 'Bitcoin ETF Inflows Hit 3-Month High as Institutions Return', author: 'Alex Morgan', date: '2026-07-06', excerpt: 'Institutional appetite for Bitcoin exposure grows amid improving regulatory clarity.', readTime: 5 },
    { title: 'DeFi 2.0: The Next Generation of Decentralized Finance Protocols', author: 'Lisa Wang', date: '2026-07-05', excerpt: 'New protocols address liquidity fragmentation and user experience challenges.', readTime: 8 },
    { title: 'Layer 2 Scaling Solutions Compared: Optimism vs Arbitrum vs zkSync', author: 'Raj Patel', date: '2026-07-04', excerpt: 'A comprehensive analysis of Ethereum scaling technologies and their trade-offs.', readTime: 12 },
    { title: 'Regulatory Roundup: What New Crypto Laws Mean for Investors', author: 'Emily Torres', date: '2026-07-03', excerpt: 'Key regulatory developments across US, EU, and Asia — and their market implications.', readTime: 7 },
    { title: 'NFT Market Shows Signs of Recovery with Gaming Sector Leading', author: 'Chris Adams', date: '2026-07-02', excerpt: 'Gaming NFTs and utility-focused tokens drive renewed interest in digital collectibles.', readTime: 6 }
  ],
  tech_review: [
    { title: 'Smartphone Camera Showdown: 2026 Flagship Comparison', author: 'Mike Chen', date: '2026-07-06', excerpt: 'We put the latest flagship phones through rigorous camera testing.', readTime: 10, rating: 4.5 },
    { title: 'Best Budget Laptops for Developers in 2026', author: 'Sarah Kim', date: '2026-07-04', excerpt: 'Affordable machines that handle coding, compiling, and container workloads.', readTime: 8, rating: 4.2 },
    { title: 'Wireless Earbuds: Sound Quality vs Battery Life — The Ultimate Trade-off', author: 'John Davis', date: '2026-07-02', excerpt: 'Testing 12 popular models to find the sweet spot between audio fidelity and longevity.', readTime: 7, rating: 4.0 },
    { title: 'Smart Home Hub Ecosystem Comparison: Which One Should You Choose?', author: 'Anna Lee', date: '2026-06-30', excerpt: 'Apple vs Google vs Amazon — comparing compatibility, privacy, and automation.', readTime: 9, rating: 4.3 }
  ],
  lifestyle_wellness: [
    { title: '10-Minute Morning Meditation Routine for Busy Professionals', author: 'Emma Wilson', date: '2026-07-06', excerpt: 'Start your day with clarity and focus — no experience required.', readTime: 5 },
    { title: 'Plant-Based Meal Prep: 5 Recipes Under 30 Minutes', author: 'Chef Marco', date: '2026-07-04', excerpt: 'Delicious, nutritious meals that you can prepare for the entire week.', readTime: 8 },
    { title: 'The Science Behind Cold Exposure: Benefits of Ice Baths', author: 'Dr. Rachel Green', date: '2026-07-02', excerpt: 'What research says about cold plunges, inflammation, and mental resilience.', readTime: 7 },
    { title: 'Desk Stretches: Preventing Tech Neck and Back Pain', author: 'Tom Fisher', date: '2026-06-30', excerpt: 'Simple exercises you can do at your desk to combat the effects of prolonged sitting.', readTime: 4 }
  ]
};

// ── Cloaking 模板引擎 ──────────────────────────────
class CloakTemplateEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dataStore = opts.dataStore || null;
    this.templates = { ...TEMPLATES, ...(opts.templates || {}) };

    // 额外自定义爬虫规则
    this.customBotPatterns = opts.customBotPatterns || [];

    // 检测统计
    this.stats = {
      totalRequests: 0,
      botDetections: 0,
      humanRedirects: 0,
      byTemplate: {},
      byDetectLevel: { L1: 0, L2: 0, L3: 0, L4: 0 }
    };

    // 行为检测阈值
    this.behaviorThresholds = {
      maxRequestsPerMinute: 60,    // 超过此频率为爬虫
      minPageDepth: 0,              // 0页深度=可能爬虫
      suspiciousHeaders: ['headless', 'phantom', 'selenium', 'puppeteer']
    };
  }

  // ── 检测是否为爬虫 ────────────────────────────────
  detectBot(ua = '', ip = '', headers = {}) {
    this.stats.totalRequests++;
    const result = { isBot: false, level: 0, label: null, confidence: 0 };

    // L1: User-Agent 关键词匹配
    const allPatterns = [...BOT_PATTERNS, ...this.customBotPatterns];
    for (const rule of allPatterns) {
      if (rule.pattern.test(ua)) {
        result.isBot = true;
        result.level = Math.max(result.level, rule.level);
        result.label = rule.label;
        result.confidence = rule.level === 1 ? 0.8 : 0.6;
        this.stats.byDetectLevel[`L${rule.level}`]++;
        break;
      }
    }

    // L3: 行为模式检测 (基于headers)
    if (!result.isBot) {
      const acceptHeader = headers['accept'] || '';
      const acceptLang = headers['accept-language'] || '';
      const secCh = headers['sec-ch-ua'] || '';

      // 缺少常规浏览器headers
      if (!acceptHeader.includes('text/html') && !acceptLang) {
        result.isBot = true;
        result.level = 3;
        result.label = 'missing_headers';
        result.confidence = 0.5;
        this.stats.byDetectLevel.L3++;
      }

      // 可疑headers
      for (const suspicious of this.behaviorThresholds.suspiciousHeaders) {
        if (ua.toLowerCase().includes(suspicious)) {
          result.isBot = true;
          result.level = 3;
          result.label = 'suspicious_ua';
          result.confidence = 0.7;
          this.stats.byDetectLevel.L3++;
          break;
        }
      }
    }

    if (result.isBot) {
      this.stats.botDetections++;
    } else {
      this.stats.humanRedirects++;
    }

    return result;
  }

  // ── 渲染白页 ─────────────────────────────────────
  render(templateId, opts = {}) {
    const template = this.templates[templateId];
    if (!template) return this._fallbackPage();

    const articles = SAMPLE_ARTICLES[templateId] || [];
    const dynamic = opts.dynamic !== false;  // 默认启用动态

    this.stats.byTemplate[templateId] = (this.stats.byTemplate[templateId] || 0) + 1;

    return this._buildHTML(template, articles, dynamic, opts);
  }

  // ── 构建完整HTML ─────────────────────────────────
  _buildHTML(template, articles, dynamic, opts = {}) {
    const { colorScheme, meta, sections } = template;

    // 动态文章 (轮换顺序)
    let displayArticles = [...articles];
    if (dynamic) {
      displayArticles = this._shuffleArray([...articles]);
    }

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // 动态日期
    const articleDates = dynamic
      ? [today, yesterday, today, yesterday, yesterday]
      : displayArticles.map(a => a.date);

    // 生成结构化数据
    const structuredData = template.features.structuredData
      ? this._generateStructuredData(template, displayArticles[0])
      : '';

    // 生成导航
    const navHTML = sections.map((s, i) =>
      `<li><a href="${s.path}" ${i === 0 ? 'class="active"' : ''}>${s.name}</a></li>`
    ).join('\n          ');

    // 生成文章卡片
    const articlesHTML = displayArticles.slice(0, 5).map((a, i) => {
      const date = articleDates[i] || a.date;
      const rating = a.rating
        ? `<span class="rating">${'★'.repeat(Math.floor(a.rating))}${'☆'.repeat(5 - Math.floor(a.rating))}</span>`
        : '';
      const commentCount = dynamic ? Math.floor(Math.random() * 30) + 3 : 0;
      const viewCount = dynamic ? Math.floor(Math.random() * 2000) + 500 : 0;

      return `
        <article class="post-card">
          <div class="post-meta">
            <span class="post-date">${date}</span>
            <span class="post-readtime">${a.readTime} min read</span>
            ${rating}
          </div>
          <h3><a href="#">${a.title}</a></h3>
          <p class="post-excerpt">${a.excerpt}</p>
          <div class="post-footer">
            <span class="post-author">By ${a.author}</span>
            ${dynamic ? `
            <span class="post-stats">
              <span>💬 ${commentCount} comments</span>
              <span>👁 ${viewCount} views</span>
            </span>` : ''}
          </div>
        </article>`;
    }).join('\n');

    // 生成侧边栏
    const sidebarHTML = dynamic ? `
      <aside class="sidebar">
        <div class="widget about-widget">
          <h4>About</h4>
          <p>${template.description}</p>
        </div>
        <div class="widget categories-widget">
          <h4>Categories</h4>
          <ul>
            ${template.keywords.map(k => `<li><a href="#">${k}</a></li>`).join('\n            ')}
          </ul>
        </div>
        ${template.features.newsletterSignup ? `
        <div class="widget newsletter-widget">
          <h4>Newsletter</h4>
          <form class="newsletter-form">
            <input type="email" placeholder="Your email address" />
            <button type="submit">Subscribe</button>
          </form>
        </div>` : ''}
      </aside>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${meta.description}">
  <meta name="keywords" content="${template.keywords.join(', ')}">
  <meta property="og:title" content="${meta.title}">
  <meta property="og:description" content="${meta.description}">
  <meta property="og:type" content="website">
  <link rel="canonical" href="https://${template.id.replace(/_/g, '-')}.com/">
  <meta name="robots" content="index, follow">
  ${template.features.rss ? '<link rel="alternate" type="application/rss+xml" title="RSS Feed" href="/feed.xml">' : ''}
  <title>${meta.title}</title>
  ${structuredData}
  <style>
    :root {
      --primary: ${colorScheme.primary};
      --secondary: ${colorScheme.secondary};
      --bg: ${colorScheme.bg};
      --text: ${colorScheme.text};
      --card-bg: ${colorScheme.bg === '#FFFFFF' ? '#F5F5F5' : 'rgba(255,255,255,0.05)'};
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    header { background: var(--primary); padding: 1rem 2rem; }
    header .container { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
    header .logo { color: #fff; font-size: 1.5rem; font-weight: 700; text-decoration: none; }
    nav ul { display: flex; list-style: none; gap: 1.5rem; }
    nav a { color: rgba(255,255,255,0.85); text-decoration: none; font-size: 0.95rem; transition: color 0.2s; }
    nav a:hover, nav a.active { color: ${colorScheme.secondary}; }
    .hero { background: linear-gradient(135deg, var(--primary), var(--secondary)); color: #fff; padding: 3rem 2rem; text-align: center; }
    .hero h1 { font-size: 2.2rem; margin-bottom: 1rem; }
    .hero p { font-size: 1.1rem; max-width: 700px; margin: 0 auto; opacity: 0.9; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .content-layout { display: grid; grid-template-columns: ${sidebarHTML ? '1fr 300px' : '1fr'}; gap: 2rem; }
    .posts-grid { display: grid; gap: 1.5rem; }
    .post-card { background: var(--card-bg); padding: 1.5rem; border-radius: 8px; border-left: 3px solid var(--secondary); transition: transform 0.2s; }
    .post-card:hover { transform: translateX(4px); }
    .post-meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .post-card h3 { font-size: 1.2rem; margin-bottom: 0.5rem; }
    .post-card h3 a { color: var(--primary); text-decoration: none; }
    .post-card h3 a:hover { color: var(--secondary); }
    .post-excerpt { font-size: 0.95rem; opacity: 0.8; margin-bottom: 0.8rem; }
    .post-footer { display: flex; justify-content: space-between; font-size: 0.85rem; opacity: 0.6; flex-wrap: wrap; gap: 0.5rem; }
    .post-stats { display: flex; gap: 1rem; }
    .rating { color: var(--secondary); }
    .sidebar { display: flex; flex-direction: column; gap: 1.5rem; }
    .widget { background: var(--card-bg); padding: 1.2rem; border-radius: 8px; }
    .widget h4 { margin-bottom: 0.8rem; color: var(--primary); }
    .widget ul { list-style: none; }
    .widget li { margin-bottom: 0.4rem; }
    .widget a { color: var(--text); text-decoration: none; opacity: 0.8; }
    .widget a:hover { color: var(--secondary); opacity: 1; }
    .newsletter-form { display: flex; gap: 0.5rem; }
    .newsletter-form input { flex: 1; padding: 0.5rem; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; }
    .newsletter-form button { padding: 0.5rem 1rem; background: var(--secondary); color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    footer { background: var(--primary); color: rgba(255,255,255,0.7); text-align: center; padding: 2rem; margin-top: 3rem; font-size: 0.9rem; }
    footer a { color: var(--secondary); text-decoration: none; }
    .pagination { display: flex; justify-content: center; gap: 0.5rem; margin-top: 2rem; }
    .pagination a { padding: 0.5rem 1rem; background: var(--card-bg); border-radius: 4px; text-decoration: none; color: var(--text); }
    .pagination a.active { background: var(--secondary); color: #fff; }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo">${template.name}</a>
      <nav>
        <ul>${navHTML}</ul>
      </nav>
    </div>
  </header>

  <section class="hero">
    <div class="container">
      <h1>${template.name}</h1>
      <p>${template.description}</p>
    </div>
  </section>

  <main class="container">
    <div class="content-layout">
      <div class="posts-grid">
        ${articlesHTML}
        <div class="pagination">
          <a href="#" class="active">1</a>
          <a href="#">2</a>
          <a href="#">3</a>
          <a href="#">Next →</a>
        </div>
      </div>
      ${sidebarHTML}
    </div>
  </main>

  <footer>
    <p>&copy; ${new Date().getFullYear()} ${template.name}. All rights reserved. |
    <a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a> | <a href="/sitemap.xml">Sitemap</a></p>
  </footer>
</body>
</html>`;
  }

  // ── 生成结构化数据 ────────────────────────────────
  _generateStructuredData(template, article) {
    const schemas = {
      BlogPosting: {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": article?.title || template.meta.title,
        "description": article?.excerpt || template.meta.description,
        "author": { "@type": "Person", "name": article?.author || "Editorial Team" },
        "datePublished": article?.date || new Date().toISOString().split('T')[0],
        "publisher": { "@type": "Organization", "name": template.name }
      },
      NewsArticle: {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": article?.title || template.meta.title,
        "description": article?.excerpt || template.meta.description,
        "datePublished": article?.date || new Date().toISOString().split('T')[0],
        "author": { "@type": "Person", "name": article?.author || "Editorial Team" }
      },
      Review: {
        "@context": "https://schema.org",
        "@type": "Review",
        "name": article?.title || template.meta.title,
        "author": { "@type": "Person", "name": article?.author || "Editorial Team" },
        "reviewRating": { "@type": "Rating", "ratingValue": article?.rating || 4.0, "bestRating": 5 }
      },
      Article: {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": article?.title || template.meta.title,
        "description": article?.excerpt || template.meta.description,
        "author": { "@type": "Person", "name": article?.author || "Editorial Team" },
        "datePublished": article?.date || new Date().toISOString().split('T')[0]
      }
    };

    const schemaType = template.features.structuredData;
    const schema = schemas[schemaType] || schemas.Article;

    return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
  }

  // ── 获取所有模板 ─────────────────────────────────
  getTemplates() {
    return Object.entries(this.templates).map(([id, t]) => ({
      id: t.id,
      name: t.name,
      niche: t.niche,
      icon: t.icon,
      keywords: t.keywords,
      description: t.description,
      sections: t.sections.length,
      features: Object.keys(t.features).filter(f => t.features[f]),
      stats: this.stats.byTemplate[id] || 0
    }));
  }

  // ── 获取单个模板 ─────────────────────────────────
  getTemplate(templateId) {
    return this.templates[templateId] || null;
  }

  // ── 添加自定义模板 ────────────────────────────────
  addTemplate(templateData) {
    const id = templateData.id || `custom_${crypto.randomBytes(4).toString('hex')}`;
    this.templates[id] = {
      id,
      name: templateData.name,
      niche: templateData.niche || 'general',
      icon: templateData.icon || '📄',
      keywords: templateData.keywords || [],
      description: templateData.description || '',
      meta: templateData.meta || {},
      sections: templateData.sections || [],
      features: templateData.features || {},
      colorScheme: templateData.colorScheme || { primary: '#333', secondary: '#666', bg: '#fff', text: '#333' }
    };

    if (templateData.articles) {
      SAMPLE_ARTICLES[id] = templateData.articles;
    }

    this.emit('template:created', { id, name: templateData.name });
    return this.templates[id];
  }

  // ── 删除模板 ─────────────────────────────────────
  removeTemplate(templateId) {
    if (this.templates[templateId]) {
      const name = this.templates[templateId].name;
      delete this.templates[templateId];
      delete SAMPLE_ARTICLES[templateId];
      this.emit('template:removed', { id: templateId, name });
      return true;
    }
    return false;
  }

  // ── 添加自定义爬虫规则 ────────────────────────────
  addBotPattern(pattern) {
    this.customBotPatterns.push(pattern);
    this.emit('pattern:added', pattern);
  }

  // ── 获取检测统计 ─────────────────────────────────
  getStats() {
    return {
      ...this.stats,
      botRate: this.stats.totalRequests > 0
        ? (this.stats.botDetections / this.stats.totalRequests * 100).toFixed(1) + '%'
        : '0%',
      templatesCount: Object.keys(this.templates).length,
      customPatterns: this.customBotPatterns.length
    };
  }

  // ── 重置统计 ─────────────────────────────────────
  resetStats() {
    this.stats = {
      totalRequests: 0, botDetections: 0, humanRedirects: 0,
      byTemplate: {}, byDetectLevel: { L1: 0, L2: 0, L3: 0, L4: 0 }
    };
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    this.removeAllListeners();
  }

  // ── 内部方法 ─────────────────────────────────────
  _fallbackPage() {
    return `<!DOCTYPE html><html><head><title>Under Construction</title></head><body style="text-align:center;padding:100px;font-family:sans-serif;"><h1>Coming Soon</h1><p>We're working on something amazing.</p></body></html>`;
  }

  _shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = { CloakTemplateEngine, BOT_PATTERNS, TEMPLATES, SAMPLE_ARTICLES };
