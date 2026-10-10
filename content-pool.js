/**
 * content-pool.js — MSCMS v14 内容池管理器
 *
 * 由 WorkBuddy AI 生成的高质量多平台内容池。
 * 当 LLM API 不可用时，内容生成器从此池读取真实内容。
 *
 * 池结构：
 *   - reddit: 文字讨论帖 (text)
 *   - instagram: 图文配文 (text_image)
 *   - tiktok: 短视频脚本 (text_video)
 *   - x: 推文 (text)
 *   - discord: 社区讨论 (text)
 *   - facebook: 社交动态 (text_image)
 *
 * 自动化补充：WorkBuddy 定时生成新内容追加到池中
 */

const fs = require('fs');
const path = require('path');

// ── Reddit 内容池 ──────────────────────────────────
const REDDIT_POOL = [
  {
    title: "After 3 years of self-hosting everything, here's what I learned about scaling",
    body: "I started with a single Raspberry Pi running Nextcloud. Three years later, I'm running 12 services across 3 nodes. The biggest lesson? Automate your backups BEFORE you need them. I lost 2 months of photos because I thought 'I'll set up backups tomorrow.' Also, Docker Compose is your best friend - every service in its own container, every config in git. What's your self-hosting story?",
    topic: "self-hosting",
    tone: "reflective",
    hashtags: ["selfhosted", "homelab", "docker"]
  },
  {
    title: "Why I switched from VS Code to Neovim (and why you shouldn't)",
    body: "After 6 months of using Neovim full-time, here's my honest take: the productivity gains are real but overstated. The real benefit isn't speed - it's that configuring your editor teaches you how you actually work. I learned more about my own workflow in 2 weeks of Lua config than in 5 years of VS Code. BUT - if you're happy with VS Code, stay there. The switch cost me 2 weeks of productivity and I'm not sure I've earned it back yet.",
    topic: "developer-tools",
    tone: "honest",
    hashtags: ["neovim", "vscode", "programming"]
  },
  {
    title: "The hidden cost of microservices that nobody talks about",
    body: "Everyone discusses the technical challenges of microservices - network latency, distributed transactions, service discovery. But the real cost is cognitive: you can never hold the entire system in your head anymore. On a monolith, you can grep for a function and trace the call path in 30 seconds. With 20 microservices, that same trace takes 20 minutes and 4 different tools. Before you split your monolith, ask: is your team large enough that the coordination cost of a monolith exceeds the cognitive cost of distributed tracing?",
    topic: "architecture",
    tone: "provocative",
    hashtags: ["microservices", "architecture", "devops"]
  },
  {
    title: "I tracked every minute of my time for 90 days. Here's what surprised me.",
    body: "I used Toggl for 90 days straight, tracking every work minute. Results: I thought I worked 8 hours/day. Actual focused work: 3.5 hours. The rest was context switching, 'quick chats', and Slack. The biggest time sink? Email - 1.2 hours/day on average. After seeing the data, I batched email to twice daily and reclaimed 45 minutes. I also discovered my peak focus window is 9-11am, not the 2-4pm slot I was 'saving for important work.' Data changes behavior in ways intention can't.",
    topic: "productivity",
    tone: "data-driven",
    hashtags: ["productivity", "timetracking", "deepwork"]
  },
  {
    title: "Stop using state management libraries for everything",
    body: "Not every app needs Redux. Not every app needs Zustand. Not every app needs MobX. If your state is local to a component, use useState. If it's shared between siblings, lift it up. If it's global but simple, use Context. You only need a state management library when: 1) you have complex derived state, 2) multiple independent components need to update shared state frequently, or 3) you need time-travel debugging. For 80% of apps, React's built-in state is more than enough.",
    topic: "react",
    tone: "opinionated",
    hashtags: ["react", "redux", "frontend"]
  },
  {
    title: "I built a SaaS in a weekend. It failed. Here's the postmortem.",
    body: "Friday night: idea. Saturday: MVP. Sunday: deployed. Monday: launched on Product Hunt. Tuesday: 3 signups. Friday: 0 retained. What went wrong? I built what I wanted, not what anyone asked for. I skipped the hardest part - talking to users BEFORE writing code. The tech was clean, the deployment was smooth, the landing page was beautiful. None of that matters if nobody wants what you built. Lesson: spend more time on customer interviews than on code.",
    topic: "startups",
    tone: "vulnerable",
    hashtags: ["saas", "startup", "postmortem"]
  },
  {
    title: "The best programming advice I ever received: read the error message",
    body: "It sounds obvious, but how many times have you copy-pasted an error into Google without actually reading it? I spent 2 hours debugging a 'Cannot read property of undefined' error last week. The error message literally said which property and which line. I just didn't read past 'TypeError.' Since I started forcing myself to read the full error message before Googling, my debugging time has dropped by 60%. The compiler is trying to help you. Let it.",
    topic: "debugging",
    tone: "practical",
    hashtags: ["debugging", "programming", "tips"]
  },
  {
    title: "Why your CI/CD pipeline is slow (and how to fix it)",
    body: "Our CI went from 2 minutes to 23 minutes over 6 months. Here's what we fixed: 1) Caching node_modules (saved 3 min), 2) Parallelizing test suites (saved 5 min), 3) Removing redundant lint steps (saved 2 min), 4) Using incremental builds instead of clean builds (saved 4 min), 5) Splitting Docker images into layers (saved 3 min). The biggest win wasn't any single optimization - it was adding a CI duration metric to our dashboard so the whole team could see when it regressed.",
    topic: "devops",
    tone: "technical",
    hashtags: ["cicd", "devops", "performance"]
  },
  {
    title: "I read 50 books on habits. 90% of them say the same 3 things.",
    body: "After reading Atomic Habits, Power of Habit, Tiny Habits, and 47 others, here's the synthesis: 1) Make it obvious - environment design > willpower. 2) Make it small - 2-minute rule beats ambitious plans. 3) Make it satisfying - track visually, celebrate immediately. That's it. Every book adds examples and frameworks, but the core mechanism is identical. Save yourself the reading time and just implement those three principles.",
    topic: "self-improvement",
    tone: "synthesizing",
    hashtags: ["habits", "books", "productivity"]
  },
  {
    title: "The myth of the 10x developer",
    body: "I've worked with developers who seemed 10x faster. Here's what they actually did: they said 'no' to meetings, they reused existing solutions instead of building from scratch, they wrote tests so they could refactor fearlessly, and they understood the business well enough to solve the right problem. It wasn't about typing speed or IQ. It was about focus, leverage, and context. The real 10x multiplier is eliminating the 9x of waste that surrounds most developers.",
    topic: "culture",
    tone: "insightful",
    hashtags: ["engineering", "culture", "productivity"]
  },
  {
    title: "Dark mode isn't just aesthetic - it saved my eyes (and maybe my career)",
    body: "I was getting daily headaches after 6 hours of coding. Tried everything - blue light glasses, screen breaks, eye drops. Then I switched everything to dark mode: editor, terminal, browser, OS. Headaches dropped 80% in the first week. I'm not saying dark mode is medically superior, but for me, the reduced light intensity made a measurable difference. If you're getting screen fatigue, it's worth a week-long experiment.",
    topic: "health",
    tone: "personal",
    hashtags: ["darkmode", "health", "developers"]
  },
  {
    title: "Database indexes explained with a library analogy",
    body: "Imagine a library with 10 million books, sorted alphabetically. Finding a book by author: 2 seconds (that's a B-tree index). Finding a book by publication date: 10 minutes of scanning (no index). Adding an index on publication date: now 2 seconds. But here's the catch - every new book requires updating both sorted lists. More indexes = slower writes. The art of indexing is finding the minimum set of indexes that covers your query patterns without killing write performance.",
    topic: "databases",
    tone: "educational",
    hashtags: ["database", "indexing", "explainer"]
  },
  {
    title: "I automated my entire morning routine with a $15 smart plug",
    body: "6:30 AM: smart plug turns on my lamp (gradually via a dimmer schedule). 6:35: coffee maker turns on (I prep it the night before). 6:45: speaker starts playing a podcast. Total cost: $15 for the smart plug + free IFTTT account. The key insight: I was spending 20 minutes every morning in a fog doing repetitive tasks. Now I wake up to light, coffee, and audio. The automation handles the 'doing' while my brain boots up. Small automation, big quality-of-life improvement.",
    topic: "automation",
    tone: "practical",
    hashtags: ["smarthome", "automation", "lifehacks"]
  },
  {
    title: "TypeScript saved my team 40 hours of debugging last quarter. Here's how.",
    body: "We measured it. Before TS: ~12 hours/week on type-related bugs (undefined is not a function, cannot read property of undefined, wrong argument types). After TS: ~2 hours/week. The migration took 3 weeks. ROI: 10 hours saved per week, paying back in 2 weeks. The unexpected benefit: refactoring became fearless. With types, the compiler tells you exactly what breaks when you change an interface. Without types, you're guessing and praying.",
    topic: "typescript",
    tone: "analytical",
    hashtags: ["typescript", "javascript", "migration"]
  },
  {
    title: "Stop building features nobody asked for",
    body: "We shipped 23 features last quarter. Users regularly used 4 of them. The other 19? Either unused or actively confusing. The pattern: we built what we thought was cool, not what users needed. This quarter, we switched to a 'one in, one out' rule: for every new feature, we identify one to remove or simplify. Result: simpler product, happier users, faster shipping. The hardest part of product is saying 'not yet' to good ideas.",
    topic: "product",
    tone: "reflective",
    hashtags: ["productmanagement", "features", "simplicity"]
  },
  {
    title: "How I went from Junior to Senior in 2 years (not by grinding LeetCode)",
    body: "1) I volunteered for the worst bugs. The ones nobody wanted. Each one taught me a part of the codebase nobody else understood. 2) I wrote documentation for everything I learned. My team lead noticed. 3) I started asking 'why' before 'how.' Understanding the business made my technical decisions better. 4) I mentored interns. Teaching forced me to fill my own knowledge gaps. 5) I spoke up in architecture meetings, even when I was wrong. Being wrong in public taught me faster than being right in private.",
    topic: "career",
    tone: "mentoring",
    hashtags: ["career", "senior", "growth"]
  },
  {
    title: "The real reason your tests are flaky (it's not the framework)",
    body: "Flaky tests are almost never a testing framework problem. They're a design problem. Common causes: 1) Shared state between tests (test A modifies data that test B reads). 2) Time-dependent logic (mock your clock). 3) External API calls (mock them). 4) Database ordering assumptions (use explicit ordering, not 'first'). 5) Async race conditions (use proper await). Fix the design, not the test. A flaky test is your codebase telling you it has hidden coupling.",
    topic: "testing",
    tone: "diagnostic",
    hashtags: ["testing", "flaky", "quality"]
  },
  {
    title: "I tracked my GitHub contributions for a year. The data surprised me.",
    body: "365 days, 847 commits. Breakdown: 62% were bug fixes, 18% were features, 12% were refactoring, 8% were docs/config. The interesting part: my 'productive' months (most features shipped) had FEWER commits than my 'maintenance' months. More commits != more output. The months where I shipped big features had long stretches of thinking, designing, and writing 3-4 carefully crafted commits. Quantity metrics are easy to measure but misleading.",
    topic: "data",
    tone: "analytical",
    hashtags: ["github", "metrics", "productivity"]
  },
  {
    title: "Your resume is not a biography. It's a sales document.",
    body: "I've reviewed 500+ engineering resumes. The best ones follow one rule: every line answers 'so what?' Bad: 'Worked on the backend using Node.js.' Good: 'Reduced API response time by 60% by implementing Redis caching, serving 2M+ daily requests.' The difference: impact > activity. Hiring managers don't care what you did. They care what changed because you did it. Quantify everything. If you can't quantify it, it probably didn't matter enough to include.",
    topic: "career",
    tone: "direct",
    hashtags: ["resume", "jobs", "advice"]
  },
  {
    title: "Why I stopped using environment variables for configuration",
    body: "Environment variables are great for 5 settings. They're terrible for 50. Problems: no type safety, no validation, no nesting, no comments, no defaults visible in code. Solution: we moved to a typed config file (JSON5 with comments) validated by Zod. Each environment gets its own file. Secrets still use env vars (via dotenv), but everything else is in version-controlled config. The result: new developers can see ALL configuration in one place, with types and documentation.",
    topic: "architecture",
    tone: "pragmatic",
    hashtags: ["config", "architecture", "bestpractices"]
  },
  {
    title: "The best investment I made as a developer wasn't a course or a book",
    body: "It was a $400 ergonomic chair. I was using a dining chair for 3 years. My back hurt, my posture was terrible, and I couldn't focus for more than 2 hours. I bought a used Herman Miller Aeron. Within a week: back pain gone. Within a month: I could do 4-hour deep work sessions again. I've spent more on courses I never finished. The chair paid for itself in productivity within a month. Invest in your physical setup before your course library.",
    topic: "health",
    tone: "personal",
    hashtags: ["ergonomics", "health", "setup"]
  },
  {
    title: "GraphQL vs REST: the answer is 'it depends' (but here's a framework)",
    body: "Use REST when: your API is simple, you have few clients, caching matters, and your team is small. Use GraphQL when: you have many different clients with different data needs, you're experiencing over/under-fetching problems, and your team can handle the complexity. The hidden cost of GraphQL: you now have a query language to secure, optimize, and debug. It's not 'better REST' - it's a different trade-off. Most teams that switch to GraphQL don't need it. They need better REST.",
    topic: "api",
    tone: "balanced",
    hashtags: ["graphql", "rest", "api"]
  },
  {
    title: "I tried pair programming for 30 days. Here's the honest truth.",
    body: "Days 1-5: painful. I felt slow, watched, and frustrated. Days 6-10: started finding rhythm, caught each other's mistakes. Days 11-20: shipping faster than solo, fewer bugs, better design decisions. Days 21-30: natural, wouldn't go back. Key learnings: 1) Pair on hard problems, not routine work. 2) Take breaks every 90 minutes. 3) The driver types, the navigator thinks. 4) It's exhausting - 4 hours of pairing = 8 hours of solo work. 5) Knowledge transfer is the hidden ROI.",
    topic: "practices",
    tone: "experimental",
    hashtags: ["pairprogramming", "agile", "teamwork"]
  },
  {
    title: "The undocumented feature of Git that saved my career: reflog",
    body: "I accidentally force-pushed to main, overwriting 2 days of work from a teammate. Panic. Then I remembered: git reflog. It shows EVERY action you've taken, even 'lost' commits. Found the commit hash, cherry-picked it, force-pushed again. Crisis averted in 3 minutes. If you don't know reflog, learn it now. It's Git's safety net. Other career-savers: git stash, git cherry-pick, and the nuclear option: git fsck --lost-found. Git almost never truly deletes anything.",
    topic: "git",
    tone: "urgent",
    hashtags: ["git", "tips", "recovery"]
  },
  {
    title: "Why I write tests first (and why it has nothing to do with code quality)",
    body: "TDD isn't about test coverage. It's about design. When I write the test first, I'm forced to think about the interface before the implementation. I discover edge cases before they're expensive to fix. I design for testability, which means I design for simplicity. The test is a specification. The code is an implementation of that spec. When I write code first, I rationalize the design. When I write tests first, the design emerges from requirements. It's harder to start, easier to finish.",
    topic: "testing",
    tone: "philosophical",
    hashtags: ["tdd", "testing", "design"]
  },
  {
    title: "I replaced 3 SaaS subscriptions with 1 self-hosted server",
    body: "Was paying: $20/mo Google Workspace (storage), $15/mo Notion (notes), $10/mo Bitwarden (passwords). Replaced with: Nextcloud (files), Joplin (notes), Vaultwarden (passwords) on a $6/mo VPS. Total savings: $39/mo → $6/mo. BUT: I spend ~2 hours/month on maintenance, updates, and occasional troubleshooting. At my hourly rate, that's $100 of my time to save $33. The math doesn't work unless you enjoy the tinkering. I do, so it's worth it. Know your trade-offs.",
    topic: "self-hosting",
    tone: "analytical",
    hashtags: ["selfhosted", "saas", "savings"]
  },
  {
    title: "The simplest performance optimization: just use a cache",
    body: "Our API was slow. We tried: query optimization (15% faster), connection pooling (10% faster), async processing (5% faster). Then we added Redis caching for the 5 most-called endpoints. 70% faster. One day of work. The lesson: before optimizing the implementation, check if you can skip the work entirely. A cache is the ultimate optimization - you don't make the code faster, you make it unnecessary. Just remember: cache invalidation is one of the two hard problems in CS.",
    topic: "performance",
    tone: "pragmatic",
    hashtags: ["performance", "caching", "redis"]
  },
  {
    title: "Stop writing comments that explain WHAT. Write comments that explain WHY.",
    body: "// increment counter by 1 → useless. The code says this.\n// counter must be incremented before validation to prevent race condition with concurrent updates → useful. The code can't say this.\n\nGood comments capture context that isn't in the code: business rules, historical decisions, workaround explanations, and 'gotcha' warnings. If your comment can be derived from reading the code, delete it. If your comment prevents a future developer from making a mistake, keep it.",
    topic: "clean-code",
    tone: "instructional",
    hashtags: ["codequality", "comments", "bestpractices"]
  },
  {
    title: "I ran a 24-hour hackathon by myself. Here's what I built and what I learned.",
    body: "Built: a real-time markdown editor with collaborative editing (CRDT-based), deployed in 2 hours, then spent 22 hours polishing. Learned: 1) The first version should be embarrassingly simple. Mine was 3 functions and a textarea. 2) Deploy before it's ready. Seeing it live changes your priorities. 3) Sleep at hour 16. I coded for 20 hours straight and the last 4 hours were garbage code I deleted the next day. 4) Scope kills hackathons. I cut 3 features to ship 1 well.",
    topic: "hackathon",
    tone: "energetic",
    hashtags: ["hackathon", "building", "sideproject"]
  }
];

// ── Instagram 内容池 ──────────────────────────────
const INSTAGRAM_POOL = [
  {
    title: "Golden hour at the mountain lake",
    body: "Spent the weekend chasing light and found this absolute gem at 6,200ft elevation. The water was so still it felt like walking on the sky. Sometimes the best camera is the one in your pocket and the best plan is no plan at all. Just follow the trail and see where it leads. Where's your favorite escape from the city? 🏔️✨",
    topic: "travel",
    tone: "inspirational",
    hashtags: ["goldenhour", "mountainlife", "wanderlust", "naturephotography", "optoutside"]
  },
  {
    title: "Homemade ramen after 3 years of practice",
    body: "First attempt: salty soup, mushy noodles. Latest attempt: tonkotsu broth simmered for 18 hours, chashu that melts in your mouth, and a soft-boiled egg marinated for exactly 12 hours. Cooking taught me patience more than meditation ever did. Some things just can't be rushed. What's a dish you've been working on perfecting? 🍜",
    topic: "food",
    tone: "personal",
    hashtags: ["ramen", "homecooking", "foodie", "japanesefood", "slurp"]
  },
  {
    title: "The desk setup that changed my productivity",
    body: "Minimal but functional. One monitor (not three), mechanical keyboard (finally found my endgame), a plant that's somehow still alive after 6 months, and natural light from a window I positioned my desk to face. Sometimes less is more. The biggest upgrade wasn't gear - it was removing distractions. What's on your desk right now? 🖥️🌱",
    topic: "productivity",
    tone: "minimal",
    hashtags: ["desksetup", "minimalism", "productivity", "workspiration", "mechanicalkeyboard"]
  },
  {
    title: "90 days of consistency > 90 days of motivation",
    body: "Left: Day 1. Right: Day 90. Same workout, same time, same place. The difference isn't motivation - motivation fades by week 2. The difference is showing up when you don't feel like it. I missed 7 days out of 90. Not perfect, but consistent enough to see change. The goal was never perfection. It was persistence. Who else is on a journey? 💪",
    topic: "fitness",
    tone: "motivational",
    hashtags: ["fitnessjourney", "consistency", "transformation", "gymlife", "discipline"]
  },
  {
    title: "Bookstore in Lisbon that hasn't changed in 100 years",
    body: "Stepped inside and time stopped. Wooden shelves floor to ceiling, the smell of old paper, and a cat sleeping on a stack of poetry books. The owner said they've never had WiFi and never will. In a world of infinite scrolling, there's something sacred about a place that asks you to slow down. What's the most beautiful bookstore you've visited? 📚🐱",
    topic: "travel",
    tone: "nostalgic",
    hashtags: ["bookstore", "lisbon", "travelgram", "booklover", "slowtravel"]
  },
  {
    title: "Sunday morning pancake stack",
    body: "Fluffy buttermilk pancakes, maple syrup from a farm in Vermont, fresh blueberries, and a pat of butter that's melting in real-time. The recipe took 47 attempts to perfect. The secret? Let the batter rest for 10 minutes. Don't overmix. And always cook on medium-low. Patience makes better pancakes than skill. What does your Sunday breakfast look like? 🥞",
    topic: "food",
    tone: "warm",
    hashtags: ["pancakes", "sundaymorning", "breakfast", "foodphotography", "brunch"]
  },
  {
    title: "Caught the last train home",
    body: "Empty carriage, city lights blurring past the window, lo-fi in my headphones. Sometimes the best moments aren't the big ones - they're the quiet in-between spaces. The 11pm train when the world has gone to sleep and you're just... present. No notifications, no urgency. Just the rhythm of the tracks and your own thoughts. Where do you find your quiet? 🌃",
    topic: "lifestyle",
    tone: "reflective",
    hashtags: ["latenight", "citylights", "quietmoments", "lofi", "midnight"]
  },
  {
    title: "My garden's first harvest",
    body: "3 cherry tomatoes, 1 misshapen cucumber, and some basil that somehow survived my neglect. It's not much, but I grew it from seeds. There's something primal about eating food you grew yourself. Next season: bigger garden, more varieties, better soil. Any gardening tips for a beginner? This cucumber is embarrassingly crooked but tastes incredible. 🍅🌿",
    topic: "lifestyle",
    tone: "genuine",
    hashtags: ["gardening", "homegrown", "urbangarden", "harvest", "beginnergardener"]
  },
  {
    title: "The coffee shop where I wrote my first 10,000 lines of code",
    body: "Same corner, same oat milk latte, same slightly wobbly table. This cafe saw me go from 'what is a variable' to 'I just deployed my first app.' Never underestimate the power of a consistent environment. Your brain associates this corner with focus, this drink with energy, this view with possibility. Where's your 'spot'? ☕💻",
    topic: "developer-life",
    tone: "nostalgic",
    hashtags: ["coffeeshop", "codinglife", "developer", "workspace", "consistency"]
  },
  {
    title: "Street art in Berlin that stopped me in my tracks",
    body: "Walked past this on the way to somewhere 'important' and had to stop. A massive mural of a child releasing a paper crane, painted on the side of a building that's been bombed and rebuilt twice. Art doesn't need a gallery. Sometimes the most powerful pieces are the ones you stumble upon when you're not looking. What's the most unexpected art you've encountered? 🎨",
    topic: "art",
    tone: "moved",
    hashtags: ["streetart", "berlin", "mural", "urbanart", "travelgram"]
  },
  {
    title: "5AM runs taught me more about discipline than any book",
    body: "Nobody is watching at 5AM. Nobody is impressed. There's no audience, no applause, no Instagram-worthy moment. Just you, the dark, and the sound of your breathing. That's where discipline is forged - in the invisible moments when motivation is nowhere to found and you show up anyway. 147 days. Still not a morning person. Still showing up. 🏃",
    topic: "fitness",
    tone: "raw",
    hashtags: ["5amclub", "running", "discipline", "morningroutine", "consistency"]
  },
  {
    title: "Ramen shop in Tokyo with 6 seats and a 2-hour wait",
    body: "Worth every minute. The chef has been making the same tonkotsu ramen for 40 years. No menu, no customization, no music. Just 6 stools, a counter, and the most perfect bowl of noodles I've ever had. Mastery isn't about doing many things. It's about doing one thing so well that people will wait 2 hours in the rain. What's the longest you've waited for food? 🍜⛩️",
    topic: "food",
    tone: "reverent",
    hashtags: ["ramen", "tokyo", "foodie", "japanesefood", "mastery"]
  },
  {
    title: "Built my first PC and I'm never going back",
    body: "Spent 3 months researching, 6 hours building, and exactly 0.3 seconds feeling worried when I pressed the power button. It works! RGB is objectively unnecessary and subjectively essential. The best part wasn't saving money or getting better specs - it was the pride of building something with my own hands. What was your first build experience? 🖥️✨",
    topic: "tech",
    tone: "excited",
    hashtags: ["pcbuild", "pcmasterrace", "firstbuild", "tech", "diy"]
  },
  {
    title: "The view from 14,000 feet changes your perspective on everything",
    body: "Hiked for 6 hours. Legs were burning by hour 3, wanted to quit by hour 4, kept going because the person ahead of me kept going. At the summit: silence, wind, and a 360-degree view that made every problem I've ever worried about feel very small. Mountains don't care about your deadlines. That's why you need them. What's the highest you've climbed? 🏔️",
    topic: "adventure",
    tone: "humbled",
    hashtags: ["hiking", "mountains", "adventure", "summit", "optoutside"]
  },
  {
    title: "My grandmother's handwritten recipe book",
    body: "Found this in a box from 1962. Every page is stained, some recipes are in shorthand I can't decipher, and the measurement 'a handful' appears 14 times. I made her apple cake using this book. It tasted like Sunday mornings at her house. Some things can't be Googled. They have to be inherited. What's a family recipe you cherish? 👵📖",
    topic: "family",
    tone: "tender",
    hashtags: ["familyrecipe", "grandma", "heritage", "baking", "nostalgia"]
  },
  {
    title: "Minimalist wardrobe: 30 pieces, 100+ outfits",
    body: "Spent 3 months curating a capsule wardrobe. Everything is neutral, everything goes with everything, and getting dressed takes 30 seconds. I own fewer clothes but wear them more. The irony: I spent more time thinking about what NOT to buy than I ever spent shopping. Simplicity isn't lazy - it's intentional. Have you tried minimalism? 👔",
    topic: "lifestyle",
    tone: "minimal",
    hashtags: ["minimalism", "capsulewardrobe", "sustainablefashion", "simplicity", "intentionalliving"]
  },
  {
    title: "The library at 2AM hits different",
    body: "Empty halls, fluorescent hum, and the quiet focus of a few strangers all chasing deadlines. There's a special bond among night-shift studiers. No talking, just nods of mutual suffering. I've done my best work between midnight and 3AM for 4 years. Not because I'm a night owl, but because the world finally stops demanding my attention. Who else works best when the world sleeps? 📚🌙",
    topic: "student-life",
    tone: "communal",
    hashtags: ["studygram", "latenight", "library", "focus", "grind"]
  },
  {
    title: "Adopted this senior dog last week. He's already changed my life.",
    body: "Nobody wanted him because he's 11 years old. The shelter said he'd been there for 6 months. First night: he slept on my feet. Second night: he brought me his toy. Third night: he rested his head on my lap while I worked. Senior dogs don't need training. They need a second chance. Adopt don't shop. Who else has a senior pet? 🐾",
    topic: "pets",
    tone: "heartwarming",
    hashtags: ["adoptdontshop", "seniordog", "rescue", "dogsofinstagram", "secondchance"]
  },
  {
    title: "Sunrise yoga on the rooftop",
    body: "6AM, 47th floor, city waking up below. 20 minutes of stretching, 10 minutes of breathing, 0 minutes of scrolling. I've done this 3 times a week for 6 months. I'm not more flexible. I'm not calmer. But I've learned to be alone with myself without reaching for my phone. That's the real benefit. Not the poses - the presence. Do you have a morning practice? 🧘",
    topic: "wellness",
    tone: "honest",
    hashtags: ["yoga", "morningroutine", "mindfulness", "sunrise", "wellness"]
  },
  {
    title: "Found a vintage camera at a flea market",
    body: "$15 for a 1978 Olympus OM-1. The light meter doesn't work, the leather is peeling, and the viewfinder has a tiny crack. Shot my first roll of film in 15 years. 24 photos, 9 usable, 3 that I love. Film teaches you to slow down: 24 shots, no preview, no delete. Every press of the shutter is a decision. What's the best $15 you've ever spent? 📷",
    topic: "photography",
    tone: "discovery",
    hashtags: ["filmphotography", "vintage", "olympus", "analog", "fleamarket"]
  },
  {
    title: "Office plant survival guide from someone who killed 7 succulents",
    body: "Lesson 1: succulents are NOT low-maintenance, they're low-water. They still need light. Lesson 2: 'indirect sunlight' means you can still see your hand in shadow, not 'next to a window that faces north.' Lesson 3: overwatering kills more plants than underwatering. Lesson 4: pothos. Just get a pothos. It's the only plant I haven't killed. What's your plant survival rate? 🌱",
    topic: "lifestyle",
    tone: "humorous",
    hashtags: ["plants", "officeplant", "plantparent", "greenthumb", "survival"]
  },
  {
    title: "Street food in Bangkok for $1.50 that beats any restaurant",
    body: "Pad kra pao from a cart on Soi 11. The lady has been cooking on the same corner for 22 years. No English menu, no seating, no napkins. Just a plastic bag, a wooden spoon, and the best Thai food I've ever had. The fried egg on top was crispy on the edges, runny in the center. I've been thinking about it for 3 weeks. What's your best street food find? 🇹🇭🌶️",
    topic: "food",
    tone: "passionate",
    hashtags: ["streetfood", "bangkok", "thaifood", "travelgram", "foodie"]
  },
  {
    title: "My coding playlist has 847 songs and they're all lo-fi",
    body: "No lyrics. No drops. No surprises. Just steady, predictable, brain-soothing beats. I've tried classical (too dramatic), ambient (too sleepy), white noise (too boring). Lo-fi is the Goldilocks zone - engaging enough to drown out distractions, boring enough to not steal attention. 847 songs and I couldn't name a single one. That's the point. What do you listen to while coding? 🎧",
    topic: "developer-life",
    tone: "relatable",
    hashtags: ["lofi", "codingplaylist", "developerlife", "focusmusic", "programming"]
  },
  {
    title: "The art of doing nothing",
    body: "Saturday. No plans. No notifications (phone is in a drawer). No guilt about productivity. Just a hammock, a breeze, and a book I've been meaning to read for 8 months. We've forgotten how to rest. Real rest - not 'resting while scrolling.' I challenge you: 1 hour this weekend with no screen, no plan, no goal. Just exist. It's harder than it sounds. When did you last do nothing? 📖🌿",
    topic: "wellness",
    tone: "challenging",
    hashtags: ["mindfulness", "rest", "digitaldetox", "slowliving", "presence"]
  },
  {
    title: "Built a treehouse for my kids this summer",
    body: "3 weekends, 47 splinters, 2 trips to the hardware store, and exactly 0 regrets. They've spent more time in it this month than in their playroom. The best toys aren't bought - they're built. And the best projects aren't perfect - they're made with love (and slightly crooked nails). What's something you built for someone you love? 🌳🏠",
    topic: "family",
    tone: "proud",
    hashtags: ["diy", "treehouse", "dadlife", "weekendproject", "familytime"]
  },
  {
    title: "The coffee ritual that replaced my $6/day latte habit",
    body: "V60 dripper, fresh beans from a local roaster, water at exactly 92C, and 3 minutes of pouring. Costs $0.80 per cup. Saves $1,460/year. But the real value isn't money - it's the 3 minutes every morning where I do one thing, slowly, with full attention. No phone, no podcast, no multitasking. Just water, coffee, and my hands. Rituals > habits. What's your morning ritual? ☕",
    topic: "lifestyle",
    tone: "mindful",
    hashtags: ["coffee", "v60", "pourover", "morningritual", "mindfulness"]
  },
  {
    title: "Northern lights in Iceland - no filter needed",
    body: "Stood in -8C for 4 hours waiting. Almost gave up at hour 3. Then the sky exploded. Green, purple, dancing. My hands were too cold to hold the camera steady but it didn't matter - some moments aren't for capturing, they're for witnessing. Iceland gave me the aurora and frostbite in the same night. 10/10 would freeze again. Have you seen the northern lights? 🌌",
    topic: "travel",
    tone: "awed",
    hashtags: ["northernlights", "iceland", "aurora", "travelgram", "natgeotravel"]
  },
  {
    title: "Reorganized my entire life in Notion",
    body: "One workspace: personal tasks, work projects, reading list, recipe collection, workout log, travel planning, and a journal. It took 2 weeks to set up and 2 months to refine. The result: I stopped forgetting things. Not because Notion is magic, but because having ONE place for everything means nothing falls through the cracks. What's your organization system? 📋",
    topic: "productivity",
    tone: "practical",
    hashtags: ["notion", "productivity", "organization", "digitallife", "systems"]
  },
  {
    title: "Painted my first canvas in 10 years",
    body: "It's bad. Like, really bad. The proportions are wrong, the colors are muddy, and I used too much paint on everything. But I finished it. And for the first time in a decade, I made something that exists in the physical world - not code, not a spreadsheet, not a document. Just paint on canvas, made by my hands. Perfection is the enemy of starting. What have you been putting off? 🎨",
    topic: "creativity",
    tone: "vulnerable",
    hashtags: ["painting", "creativity", "beginner", "art", "juststart"]
  }
];

// ── TikTok 内容池 ──────────────────────────────────
const TIKTOK_POOL = [
  {
    title: "3 keyboard shortcuts that saved me 40 hours this year",
    body: "Quick tutorial! 1) Ctrl+Shift+T reopens the last closed tab (life-saver when you accidentally close your research). 2) Ctrl+D bookmarks instantly. 3) Windows+V opens clipboard history - you can paste something you copied 10 copies ago. Mind = blown. Which one didn't you know? Comment below! #techhacks #productivity #keyboardshortcuts",
    topic: "tech-tips",
    tone: "energetic",
    hashtags: ["techhacks", "productivity", "keyboardshortcuts", "pctips", "learnontiktok"]
  },
  {
    title: "I tried the 2-minute rule for 30 days",
    body: "The rule: if it takes less than 2 minutes, do it now. Dirty dish? Wash it now. Email reply? Send it now. Small task? Done now. Day 1: did 14 things. Day 30: my space was cleaner, my inbox was empty, and I felt lighter. The compound effect of tiny actions is real. Try it for 1 week and tell me what changes. #habits #productivity #2minuterule",
    topic: "self-improvement",
    tone: "enthusiastic",
    hashtags: ["habits", "productivity", "2minuterule", "selfimprovement", "lifehack"]
  },
  {
    title: "How to make $0 ramen taste like a $20 bowl",
    body: "Step 1: Boil noodles for 30 seconds less than package says. Step 2: Drain HALF the water. Step 3: Add a dollop of miso paste + soy sauce + a dash of sesame oil. Step 4: Top with a soft-boiled egg and green onions. Step 5: Feel like a chef. Total cost: $0.80. Restaurant vibes: priceless. #ramenhacks #cooking #collegelife #foodhacks",
    topic: "cooking",
    tone: "fun",
    hashtags: ["ramenhacks", "cooking", "collegelife", "foodhacks", "easyrecipes"]
  },
  {
    title: "The AI tool nobody is talking about but should be",
    body: "Everyone knows ChatGPT. But have you tried using it to summarize 3-hour YouTube videos into 5 bullet points? Paste the transcript, ask for key takeaways, and save 2 hours 55 minutes of your life. I've been doing this for all my online courses. Game changer. What AI tool changed your life? #aitools #productivity #chatgpt #tech",
    topic: "ai",
    tone: "discovery",
    hashtags: ["aitools", "productivity", "chatgpt", "tech", "learnontiktok"]
  },
  {
    title: "Day in the life of a self-taught developer",
    body: "7AM: coffee + code review. 9AM: standup (camera off, still in pajamas). 10AM-12PM: deep work, no meetings. 12PM: lunch + walk. 1PM-3PM: pair programming. 3PM-5PM: debugging + documentation. 5PM: shut laptop. 6PM: side project. No CS degree. No bootcamp. Just curiosity and consistency. 4 years to get here. #developerlife #coding #selftaught",
    topic: "career",
    tone: "authentic",
    hashtags: ["developerlife", "coding", "selftaught", "programmer", "dayinthelife"]
  },
  {
    title: "I tracked every dollar for 90 days. Here's the shocking truth.",
    body: "Thought I spent $200/month on food. Actual: $680. Thought I spent $50/month on subscriptions. Actual: $147 (had 3 I forgot about). Thought I was saving 15% of income. Actual: 4%. Tracking doesn't change behavior - seeing the numbers does. I cancelled 3 subscriptions, started meal prepping, and now save 22%. #budgeting #personalfinance #moneytips",
    topic: "finance",
    tone: "revealing",
    hashtags: ["budgeting", "personalfinance", "moneytips", "financialeducation", "moneymindset"]
  },
  {
    title: "POV: You just learned what a monorepo is",
    body: "Me 6 months ago: 15 git repos for one project, dependency hell, duplicate code everywhere. Me now: 1 monorepo, shared packages, atomic commits across frontend and backend. Turborepo made it 10x faster. I'm never going back to polyrepo. If your project has more than 3 repos that always change together, it's time. #programming #monorepo #devops #tech",
    topic: "programming",
    tone: "relatable",
    hashtags: ["programming", "monorepo", "devops", "softwareengineering", "coding"]
  },
  {
    title: "The 5-second rule that fixed my procrastination",
    body: "When you feel the urge to do something you should do (workout, study, call mom): count 5-4-3-2-1 and MOVE. Before your brain invents an excuse. It sounds stupid. It works. I've done 47 workouts in 50 days using this. Not because I'm motivated. Because I count to 5 and my body moves before my brain can stop it. #procrastination #motivation #5secondrule",
    topic: "self-improvement",
    tone: "intense",
    hashtags: ["procrastination", "motivation", "5secondrule", "selfimprovement", "discipline"]
  },
  {
    title: "Building a PC for the first time - reaction compilation",
    body: "Step 1: Open box, feel powerful. Step 2: Read instructions, feel confused. Step 3: Drop CPU pin, panic for 3 minutes. Step 4: Find pin, relief. Step 5: Thermal paste everywhere. Step 6: It won't fit. Step 7: Realize it's backwards. Step 8: IT FITS. Step 9: Press power button. Step 10: IT WORKS. Emotional rollercoaster. 10/10. #pcbuild #tech #diy",
    topic: "tech",
    tone: "comedic",
    hashtags: ["pcbuild", "tech", "diy", "firstbuild", "pcmasterrace"]
  },
  {
    title: "Why your iPhone battery dies by 3PM (and how to fix it)",
    body: "Top 3 battery killers: 1) Background App Refresh - turn it OFF for apps you don't need. 2) Location Services - set to 'While Using' not 'Always'. 3) Push email - change to Fetch every 15 min. I went from 4 hours to 8 hours of screen time. Your battery isn't broken, your settings are. #iphonetips #battery #techhacks #apple",
    topic: "tech-tips",
    tone: "helpful",
    hashtags: ["iphonetips", "battery", "techhacks", "apple", "lifehack"]
  },
  {
    title: "I lived in a van for 30 days. Here's what nobody tells you.",
    body: "Expected: freedom, adventure, sunsets. Reality: cold nights, finding bathrooms, WiFi hunting, cooking on a camp stove in the rain. BUT also: zero rent, waking up at a different lake every morning, and the most peaceful sleep I've ever had. Would I do it again? Yes. Would I recommend it? Only if you enjoy being uncomfortable. #vanlife #minimalism #adventure",
    topic: "lifestyle",
    tone: "honest",
    hashtags: ["vanlife", "minimalism", "adventure", "alternativeliving", "travel"]
  },
  {
    title: "How to negotiate your salary (from someone who left $15K on the table)",
    body: "Mistake 1: I accepted the first offer. Mistake 2: I named a number first. Mistake 3: I didn't practice. Fix: 1) Always ask for 48 hours to 'think about it.' 2) Let them name the number first. 3) Research Glassdoor + Levels.fyi. 4) Practice with a friend until it feels natural. I got a 22% increase on my next job using these. #career #salary #negotiation",
    topic: "career",
    tone: "instructional",
    hashtags: ["career", "salary", "negotiation", "jobs", "careertips"]
  },
  {
    title: "The study method that got me from C's to A's",
    body: "Forget highlighting. Forget rereading. Active recall + spaced repetition. 1) Read a section. 2) Close the book. 3) Write down everything you remember. 4) Check what you missed. 5) Review after 1 day, 3 days, 7 days. I went from 65% average to 89% in one semester. Your brain learns by retrieving, not by rereading. #studyhacks #student #productivity",
    topic: "education",
    tone: "methodical",
    hashtags: ["studyhacks", "student", "productivity", "studytips", "learning"]
  },
  {
    title: "3 things I learned from failing my startup",
    body: "1) Nobody cares about your idea. They care about their problem. If you can't name the problem in one sentence, you don't have a product. 2) Your first 10 users matter more than your next 10,000. Talk to them daily. 3) Burn rate isn't just money - it's your mental health. I burned out before the money ran out. Take care of yourself first. #startup #entrepreneur #failure",
    topic: "business",
    tone: "reflective",
    hashtags: ["startup", "entrepreneur", "failure", "businesstips", "founderlife"]
  },
  {
    title: "I tried every productivity app so you don't have to",
    body: "Notion: best for everything but slow. Todoist: best for quick tasks. Things: beautiful but Apple only. Obsidian: best for notes, worst for tasks. Linear: best for dev teams. The winner? A $2 notebook and a pen. Apps help but they don't create discipline. Start with paper, upgrade to digital only when paper fails you. #productivity #apps #review",
    topic: "productivity",
    tone: "definitive",
    hashtags: ["productivity", "apps", "review", "notion", "productivitytools"]
  },
  {
    title: "Street food challenge: $5 budget in 5 cities",
    body: "Bangkok: pad kra pao + mango sticky rice ($4.50). Mexico City: tacos al pastor + horchata ($4). Istanbul: simit + Turkish tea ($1.50). Marrakech: tagine + mint tea ($5). Hanoi: banh mi + iced coffee ($2.50). Winner: Hanoi. Best $2.50 I've ever spent. Street food > restaurants, every time. #streetfood #budgettravel #foodie",
    topic: "travel",
    tone: "competitive",
    hashtags: ["streetfood", "budgettravel", "foodie", "foodchallenge", "travel"]
  },
  {
    title: "The morning routine that actually works (not the 4AM CEO one)",
    body: "7:00: Wake up naturally (no alarm if possible). 7:05: Phone stays on the charger for 30 min. 7:10: Glass of water + 5 min stretch. 7:20: Coffee + journal 3 lines. 7:40: Start work. No ice baths, no meditation apps, no 5-mile runs. Just: don't look at your phone, drink water, and start. Simple beats complicated. #morningroutine #wellness",
    topic: "wellness",
    tone: "realistic",
    hashtags: ["morningroutine", "wellness", "productivity", "realistic", "selfcare"]
  },
  {
    title: "Code review tips that won't make your coworkers hate you",
    body: "1) Start with something positive. 2) Ask questions, don't give orders ('Have you considered X?' > 'Change this to X'). 3) Distinguish between 'must fix' and 'nitpick.' 4) Review the code, not the person. 5) If you'd merge it yourself, approve it. Don't block merges for style preferences. Good reviews build trust, bad reviews build resentment. #programming #codereview #dev",
    topic: "programming",
    tone: "diplomatic",
    hashtags: ["programming", "codereview", "developer", "bestpractices", "teamwork"]
  },
  {
    title: "My minimalist apartment tour: 280 sq ft, everything I need",
    body: "Bed that folds into a desk. 7 shirts, 2 pants, 1 jacket. Kitchen with 1 pan, 1 pot, 1 knife. No TV (projector instead). No couch (floor cushions). Books on Kindle. Rent: $650/month in a city where average is $1,800. Minimalism isn't about owning nothing - it's about owning only what you use. #minimalism #apartment #tinyhome",
    topic: "lifestyle",
    tone: "proud",
    hashtags: ["minimalism", "apartment", "tinyhome", "minimalistliving", "simpleliving"]
  },
  {
    title: "How to learn any programming language in 1 week",
    body: "Day 1: Syntax basics (variables, loops, functions). Day 2: Data structures (arrays, dicts, objects). Day 3: Build a CLI tool. Day 4: Build an API endpoint. Day 5: Connect to a database. Day 6: Add tests. Day 7: Deploy it. You won't be an expert, but you'll be dangerous. The secret: build, don't tutorial. Tutorials teach syntax. Building teaches understanding. #programming #learning #developer",
    topic: "programming",
    tone: "actionable",
    hashtags: ["programming", "learning", "developer", "coding", "learnontiktok"]
  },
  {
    title: "The side project that made me $3,200 in 4 months",
    body: "Built a simple tool: PDF merger with drag-and-drop. No login, no ads, no tracking. Just a clean tool that works. Monetization: 'Buy me a coffee' button + optional $2/month for batch processing. 1,600 users. 89 paid. $3,200 total. Not life-changing money, but it proved: solve one small problem really well, and people will pay. #sideproject #indiedev #passiveincome",
    topic: "business",
    tone: "transparent",
    hashtags: ["sideproject", "indiedev", "passiveincome", "sidehustle", "maker"]
  },
  {
    title: "I went phone-free for 7 days. Here's what happened.",
    body: "Day 1: phantom vibrations, reached for pocket 30 times. Day 2: actual boredom, remembered what thinking feels like. Day 3: read a whole book. Day 4: had a 2-hour conversation without checking anything. Day 5: slept better. Day 6: didn't want it back. Day 7: turned it on, deleted 6 apps, kept 8. The phone isn't the problem. The apps are. #digitaldetox #mindfulness",
    topic: "wellness",
    tone: "transformative",
    hashtags: ["digitaldetox", "mindfulness", "phonefree", "mentalhealth", "wellness"]
  },
  {
    title: "Explaining Docker to a 5-year-old",
    body: "Imagine you're baking cookies. You need: recipe, ingredients, oven, and a kitchen. Docker is like a shipping container that has the recipe, ingredients, AND a mini-oven pre-installed. You ship the container to your friend, and they get the exact same cookies - no matter what kitchen they have. That's it. Docker = portable kitchen for code. #docker #explained #devops",
    topic: "tech",
    tone: "educational",
    hashtags: ["docker", "explained", "devops", "learnontiktok", "programming"]
  },
  {
    title: "The gym routine for people who hate the gym",
    body: "20 minutes. Home. No equipment. 1) 60 jumping jacks. 2) 15 push-ups. 3) 20 squats. 4) 30-second plank. 5) Repeat 3x. Takes 20 min, burns 200 calories, and you can do it in pajamas. Consistency > intensity. I've done this 4x/week for 6 months. Not jacked, but I feel 10x better than when I had a gym membership I never used. #fitness #homegym #noexcuses",
    topic: "fitness",
    tone: "encouraging",
    hashtags: ["fitness", "homegym", "noexcuses", "workout", "bodyweight"]
  },
  {
    title: "Why I quit my 6-figure job to teach coding",
    body: "Not because I hated the job. I liked it. But I realized: the most fulfilling moments of my career were when I helped someone understand a concept. The 'aha' moment in someone's eyes is worth more than any bonus. Now I teach 30 students online. Less money. More meaning. Not advice - just my story. Your path is yours. #careerchange #teaching #coding",
    topic: "career",
    tone: "inspiring",
    hashtags: ["careerchange", "teaching", "coding", "purpose", "career"]
  },
  {
    title: "Apartment hunting red flags I wish I knew sooner",
    body: "1) Water pressure - test every faucet. Low pressure = bad pipes. 2) Phone signal - stand in every room and check bars. 3) Noise - visit during rush hour, not midday. 4) Talk to a current tenant if possible. 5) Check for mold in bathroom corners and under sinks. 6) If the landlord is pushy during the viewing, they'll be pushy as a landlord. #apartmenthunting #renting #tips",
    topic: "lifestyle",
    tone: "cautionary",
    hashtags: ["apartmenthunting", "renting", "tips", "adulting", "lifehacks"]
  },
  {
    title: "I tried the 'one in, one out' rule for my closet for 1 year",
    body: "Rule: for every new clothing item, remove one. Results: closet went from 127 items to 43. I wear everything I own. No more 'nothing to wear' mornings. No more impulse buying - because buying means giving something up. Saved $2,400 this year. The constraint created freedom. Counterintuitive but true. #minimalism #fashion #declutter",
    topic: "lifestyle",
    tone: "transformative",
    hashtags: ["minimalism", "fashion", "declutter", "sustainablefashion", "oneinoneout"]
  },
  {
    title: "The terminal commands that make you look like a hacker",
    body: "1) neofetch - shows system info with a cool ASCII logo. 2) cmatrix - green falling code like The Matrix. 3) htop - colorful process monitor. 4) figlet - turns text into ASCII art. 5) pipes.sh - animated pipes on your screen. None of these are useful. All of them are essential. #linux #terminal #hacker #commandline #fun",
    topic: "tech",
    tone: "playful",
    hashtags: ["linux", "terminal", "hacker", "commandline", "fun"]
  }
];

// ── X (Twitter) 内容池 ──────────────────────────────
const X_POOL = [
  {
    title: null,
    body: "The best code review comment I ever received: 'This works, but what happens when someone else maintains it in 2 years?' Changed how I write code forever.",
    topic: "programming",
    tone: "reflective",
    hashtags: ["#coding", "#dev"]
  },
  {
    title: null,
    body: "Hot take: most 'legacy code' problems are actually 'no tests' problems. If you're afraid to change code, it's because you can't verify you didn't break it.",
    topic: "programming",
    tone: "provocative",
    hashtags: ["#legacycode", "#testing"]
  },
  {
    title: null,
    body: "Shipped a feature today that took 3 hours to build and 3 days to write tests for. The tests have already caught 2 regressions this week. Worth it.",
    topic: "programming",
    tone: "satisfied",
    hashtags: ["#testing", "#dev"]
  },
  {
    title: null,
    body: "Your startup doesn't need Kubernetes. It needs customers. I've seen more startups die from over-engineering than from scaling problems.",
    topic: "startups",
    tone: "direct",
    hashtags: ["#startups", "#devops"]
  },
  {
    title: null,
    body: "The difference between a junior and senior dev isn't how fast they code. It's how fast they know when to stop coding and start asking questions.",
    topic: "career",
    tone: "insightful",
    hashtags: ["#developer", "#career"]
  },
  {
    title: null,
    body: "Documented my API today. Realized half the endpoints were unnecessary. Writing docs is the best code review. If you can't explain it simply, it's too complex.",
    topic: "programming",
    tone: "practical",
    hashtags: ["#api", "#docs"]
  },
  {
    title: null,
    body: "Pro tip: if your CI takes longer than 5 minutes, you have a design problem, not a tooling problem. Fix the architecture, not the pipeline.",
    topic: "devops",
    tone: "opinionated",
    hashtags: ["#cicd", "#devops"]
  },
  {
    title: null,
    body: "I've been programming for 10 years. I still Google 'how to center a div' sometimes. Being experienced doesn't mean memorizing everything. It means knowing what to search for.",
    topic: "programming",
    tone: "humble",
    hashtags: ["#programming", "#webdev"]
  },
  {
    title: null,
    body: "The most underrated developer skill: writing good error messages. Your future self and your teammates will thank you. 'Error: something went wrong' is not an error message.",
    topic: "programming",
    tone: "practical",
    hashtags: ["#coding", "#bestpractices"]
  },
  {
    title: null,
    body: "Stopped estimating tasks in hours. Started estimating in 'complexity points.' 1 = trivial, 3 = needs thought, 5 = needs design, 8 = needs alignment, 13 = needs to be broken down. Accuracy went up 3x.",
    topic: "agile",
    tone: "practical",
    hashtags: ["#agile", "#estimation"]
  }
];

// ── Discord 内容池 ──────────────────────────────────
const DISCORD_POOL = [
  {
    title: "Weekly dev discussion: What's your approach to technical debt?",
    body: "Every team handles it differently. Some allocate 20% of every sprint. Some do dedicated 'tech debt weeks' quarterly. Some ignore it until something breaks. What's your strategy? We're trying to find a balance between shipping features and keeping the codebase healthy. Share your approach!",
    topic: "engineering",
    tone: "collaborative",
    hashtags: ["#engineering", "#techdebt"]
  },
  {
    title: "Looking for beta testers for a new open-source monitoring tool",
    body: "Built a lightweight uptime monitor that's self-hosted, uses <50MB RAM, and sends alerts to Discord/Slack/Email. Looking for 10 people to try it and give feedback. No signup required - just Docker and 2 minutes. DM me if interested. Open source, MIT license, no telemetry.",
    topic: "open-source",
    tone: "community",
    hashtags: ["#opensource", "#monitoring"]
  },
  {
    title: "How do you handle on-call rotations without burning out?",
    body: "Our team of 5 does weekly rotations. After 3 months, everyone is exhausted. Looking for alternatives: 2-week rotations? Split primary/secondary? Dedicated SRE hire? What's worked for your team? The goal is sustainable on-call, not hero culture.",
    topic: "devops",
    tone: "seeking",
    hashtags: ["#oncall", "#devops"]
  },
  {
    title: "Monthly book club: 'Designing Data-Intensive Applications'",
    body: "Starting a monthly book club for backend engineers. First book: DDIA by Martin Kleppmann. We'll read 2 chapters/week and discuss here every Sunday. If you've been meaning to read it but never got around to it, this is your sign. 47 people already joined. All welcome!",
    topic: "learning",
    tone: "inviting",
    hashtags: ["#bookclub", "#learning"]
  },
  {
    title: "Show and tell: What did you build this weekend?",
    body: "Weekly thread! Share what you built, no matter how small. Last week someone built a CLI tool that generates dad jokes from an API. Another person deployed their first app. Another wrote their first unit test. All wins count. What did you ship?",
    topic: "community",
    tone: "encouraging",
    hashtags: ["#showandtell", "#weekend"]
  }
];

// ── Facebook 内容池 ─────────────────────────────────
const FACEBOOK_POOL = [
  {
    title: "10 years ago today, I wrote my first line of code",
    body: "It was JavaScript. console.log('Hello World'). I had no idea it would become my career. 10 years later: 4 jobs, 2 startups, 1 failed side project, and a lifetime of learning. If you're just starting: keep going. The first year is the hardest. It gets better. The community is here for you. What was your first programming language?",
    topic: "milestone",
    tone: "reflective",
    hashtags: ["#coding", "#developer", "#milestone"]
  },
  {
    title: "Local meetup: Build & Deploy workshop this Saturday",
    body: "Hosting a free workshop at the community center this Saturday 2-5PM. We'll build a full-stack app from scratch and deploy it live. Beginners welcome - you'll leave with a working app you can show employers. Free pizza and coffee. 23 spots left. Bring your laptop. No experience needed, just curiosity!",
    topic: "community",
    tone: "welcoming",
    hashtags: ["#meetup", "#workshop", "#coding"]
  },
  {
    title: "My top 5 free resources for learning to code in 2024",
    body: "1) freeCodeCamp - best for absolute beginners, structured curriculum. 2) The Odin Project - best for full-stack, project-based. 3) CS50 on YouTube - best for fundamentals. 4) MDN Web Docs - best reference. 5) Exercism - best for practice with mentorship. All free. All excellent. Save this post. What would you add?",
    topic: "learning",
    tone: "generous",
    hashtags: ["#learnToCode", "#resources", "#free"]
  },
  {
    title: "Just hit 1000 GitHub stars on my open-source project!",
    body: "Started as a side project 8 months ago. A simple tool to convert API specs to interactive documentation. Today: 1,012 stars, 34 contributors, 12 languages. The internet is amazing. Strangers helping strangers build useful things. To everyone who starred, contributed, or shared: thank you. This community is why I love open source.",
    topic: "milestone",
    tone: "grateful",
    hashtags: ["#opensource", "#github", "#milestone"]
  },
  {
    title: "Unpopular opinion: Not everything needs to be an app",
    body: "We're so quick to reach for React Native or Flutter that we forget: sometimes a well-designed web page is enough. PWA + responsive design covers 90% of use cases. Save the native app for when you actually need hardware access, push notifications that work reliably, or offline-first architecture. Ship simpler.",
    topic: "tech",
    tone: "opinionated",
    hashtags: ["#development", "#apps", "#web"]
  }
];

// ── Tumblr 内容池 ──────────────────────────────────
const TUMBLR_POOL = [
  {
    content_type: 'text',
    title: "Digital art process: from blank canvas to finished piece in 6 hours",
    body: "I've been experimenting with Procreate for the past year. Here's what my 6-hour art process looks like:\n\nHour 1-2: Thumbnail sketches — I make 5-10 rough compositions until one clicks\nHour 2-3: Linework — tight pencil layer, zoomed in to 300%\nHour 3-4: Base colors — flat fills, testing palettes on a separate layer\nHour 4-5: Shading & lighting — multiply layers, soft brush, rim lights\nHour 5-6: Details & polish — texture brushes, chromatic aberration, final crop\n\nThe biggest thing I've learned: your first 20 minutes of any art piece will look terrible. Push through it. The magic happens in hours 3-6 when you start seeing the piece come together.\n\nWhat does your creative process look like?",
    topic: "digital art",
    tone: "tutorial",
    tags: ["digital art", "procreate", "art process", "creative process", "tutorial", "illustration"],
    target_audience: "artists"
  },
  {
    content_type: 'photo',
    title: "My 3-month film photography experiment — 12 rolls, 8 keepers",
    body: "I shot exclusively on film for 3 months. No digital backup, no chimping, no 'I'll fix it in post.' Here's what happened:\n\n- Shot 12 rolls (432 frames)\n- Got 8 images I genuinely love\n- That's a 1.8% hit rate vs my digital 5% hit rate\n\nBut here's the thing: those 8 images are BETTER than anything I shot digitally in the past year. Film forces you to slow down. $0.50 per click changes your behavior. You compose more carefully. You wait for the right moment instead of spraying and praying.\n\nGear used: Canon AE-1, Portra 400, 50mm f/1.4\n\nWould I switch permanently? No. Would I recommend trying it for 3 months? Absolutely.\n\nAny other film shooters here?",
    topic: "photography",
    tone: "reflective",
    tags: ["film photography", "analog", "canon ae1", "portra 400", "photography", "creative"],
    target_audience: "photographers"
  },
  {
    content_type: 'quote',
    title: "On creative courage",
    body: '"The scariest moment is always just before you start. After that, things can only get better."\n\n— Stephen King, On Writing\n\nThis quote has been taped to my monitor for 4 years. Every time I stare at a blank page, I read it. The fear doesn\'t go away. But knowing that the fear is part of the process — not a sign that you shouldn\'t be doing it — changes everything.\n\nWhat quote keeps you going?',
    topic: "creativity",
    tone: "inspirational",
    tags: ["stephen king", "writing advice", "creative courage", "inspiration", "quotes"],
    target_audience: "creatives"
  },
  {
    content_type: 'chat',
    title: "Anonymous ask: How do you deal with creative burnout?",
    body: "anon asked: how do you deal with creative burnout? i haven't made anything in 3 weeks and i feel like i'm losing it\n\nI've been there. Here's my actual recovery protocol:\n\n1. Stop forcing it. The more you try to 'push through' burnout, the longer it lasts.\n2. Switch mediums. I'm a digital artist but when I burn out, I switch to watercolor or clay. Using a different part of your brain helps.\n3. Consume, don't create. Watch films, visit galleries, read poetry. Fill the tank.\n4. Set a 'minimum viable creativity' — mine is 'draw one smiley face on a post-it.' That counts.\n5. It took me 6 weeks to recover from my worst burnout. Give yourself permission to take the time.\n\nBurnout isn't a failure. It's your brain's way of saying the current approach isn't sustainable. Listen to it.\n\nWhat helps you recover?",
    topic: "mental health",
    tone: "supportive",
    tags: ["creative burnout", "mental health", "advice", "artist life", "self care"],
    target_audience: "creatives"
  },
  {
    content_type: 'text',
    title: "Why I deleted all my social media (except Tumblr)",
    body: "Instagram felt like a competition. Twitter felt like a battlefield. TikTok felt like a casino designed to steal my attention span. But Tumblr? Tumblr feels like a living room.\n\nHere's why I stayed:\n\n- No algorithm forcing content down my throat — I see what I CHOOSE to follow\n- Long-form text still works here — people actually READ on Tumblr\n- Anonymity is respected — you don't need to be a 'brand'\n- Communities form around INTERESTS, not followers\n- The dash is chronological. Revolutionary concept, I know.\n\nI've been here since 2012. Left in 2018. Came back in 2023. Tumblr is the only platform that feels like it was built for humans, not advertisers.\n\nIs anyone else on a social media detox journey?",
    topic: "social media",
    tone: "personal",
    tags: ["social media detox", "tumblr", "digital wellness", "social media", "internet culture"],
    target_audience: "general"
  },
  {
    content_type: 'photo',
    title: "Urban sketching: 30 days, 30 coffee shops, 30 sketches",
    body: "I challenged myself to sketch in a different coffee shop every day for a month. Here's what I learned:\n\nDay 1-5: Felt self-conscious. People watch you sketch. You get used to it.\nDay 6-15: Started noticing details I'd normally walk past — fire escapes, window reflections, the way light hits a barista's hands\nDay 16-25: Developed my own shorthand. A coffee cup becomes 3 lines. A person becomes a gesture.\nDay 26-30: The sketchbook feels like home now. I can draw anywhere.\n\nBest shops (for sketching): ones with window seats and natural light.\nWorst shops: ones with loud music and tiny tables.\n\nMy favorite sketch from the series is attached. It's from Day 17 — a rainy afternoon at a tiny place called 'Chapter & Verse.' The barista asked to see my sketchbook and gave me a free cookie.\n\nUrban sketching isn't about drawing perfectly. It's about paying attention.",
    topic: "art",
    tone: "journal",
    tags: ["urban sketching", "art challenge", "coffee shop", "sketchbook", "drawing", "illustration"],
    target_audience: "artists"
  },
  {
    content_type: 'text',
    title: "A love letter to secondhand bookstores",
    body: "There's a secondhand bookstore near my apartment. It's been there for 40 years. The owner, Mr. Chen, knows every book in the store by heart. He doesn't use a computer. He has a handwritten ledger.\n\nLast week I found a 1963 copy of Dune with notes in the margins from the previous owner. The notes are in pencil. They disagree with Frank Herbert about the politics of Arrakis. I bought it for $3.\n\nSecondhand bookstores are time machines. Every book carries the fingerprints of everyone who read it before you. The coffee stain on page 47? That was someone's morning. The dog-eared page 112? That was someone's favorite passage.\n\nNew books are products. Secondhand books are artifacts.\n\nWhat's the best secondhand find you've ever made?",
    topic: "books",
    tone: "nostalgic",
    tags: ["secondhand books", "bookstore", "reading", "book lover", "dune", "literature"],
    target_audience: "readers"
  },
  {
    content_type: 'link',
    title: "The best free resources for learning 3D art in 2025",
    body: "I've been learning Blender for 8 months. Here are the resources that actually helped me improve (all free):\n\n1. Blender Guru's Donut Tutorial — yes, it's a meme, but it teaches you 80% of what you'll use daily in 3 hours\n2. Grant Abbitt's 'Get Good at Blender' playlist — great for intermediate techniques\n3. Poly Haven — CC0 textures, models, and HDRIs. No copyright worries.\n4. Ian Hubert's 'Lazy Tutorials' — 1 minute videos that teach more than 30 minute ones\n5. The Blender subreddit's monthly contest — working to a deadline with constraints is the fastest way to improve\n6. FlippedNormals on YouTube — industry-level topology and sculpting advice\n\nTotal cost: $0. Total time to get 'pretty good': about 200 hours of deliberate practice.\n\nLink to my progress thread in the notes. What resources helped you learn 3D?",
    topic: "tutorial",
    tone: "helpful",
    tags: ["blender", "3D art", "free resources", "tutorial", "learning", "CGI"],
    target_audience: "beginners"
  },
  {
    content_type: 'quote',
    title: "Rebecca Solnit on hope",
    body: '"Hope is not a lottery ticket you can sit on the sofa and clutch, feeling lucky. It is an axe you break down doors with in an emergency."\n\n— Rebecca Solnit, Hope in the Dark\n\nI read this in 2020 and it permanently changed how I think about optimism. Hope is not passive wishful thinking. It\'s a tool. It\'s something you DO, not something you have.\n\nIn a world that feels increasingly uncertain, this distinction matters more than ever. You don\'t wait for hope to arrive. You build it.\n\nReblog if you needed to hear this today.',
    topic: "philosophy",
    tone: "inspirational",
    tags: ["rebecca solnit", "hope", "philosophy", "activism", "inspiration", "books"],
    target_audience: "philosophical"
  },
  {
    content_type: 'audio',
    title: "My 'Focus & Create' playlist — 3 hours of instrumental music for deep work",
    body: "I've been curating this playlist for 2 years. Here's the formula I discovered:\n\n- No lyrics (words hijack your inner monologue)\n- 60-80 BPM (matches resting heart rate — keeps you calm but alert)\n- Minimal dynamic range (no sudden loud sections that break focus)\n- Consistent mood throughout (no genre-hopping)\n\nWhat's on it:\n- Nils Frahm — Solo (the entire album)\n- Max Richter — Sleep (selected tracks)\n- Ólafur Arnalds — some kind of peace\n- Hania Rani — Esja\n- Aphex Twin — Selected Ambient Works 85-92 (the calm tracks)\n- Hiroshi Yoshimura — Music for Nine Post Cards\n\nI use this playlist for writing, coding, and illustration work. Something about minimal piano and ambient textures creates a 'flow bubble' that keeps me locked in for 3+ hours.\n\nLink in the notes. What's on your focus playlist?",
    topic: "music",
    tone: "curatorial",
    tags: ["focus music", "playlist", "deep work", "ambient", "productivity", "instrumental"],
    target_audience: "creatives"
  },
  {
    content_type: 'text',
    title: "What 100 days of daily journaling taught me about myself",
    body: "I committed to writing 500 words every morning for 100 days. No skipping. Here's the data:\n\n- Days I wanted to quit: 34\n- Days I wrote something surprising I didn't know I felt: 71\n- Days the journaling led to a decision: 23\n- Average time per entry: 22 minutes\n\nPatterns I noticed in my entries:\n- I complain about the same 3 things persistently (which means I should fix them)\n- My best ideas come on consecutive writing days (momentum is real)\n- Morning journaling drastically reduces my anxiety for the rest of the day\n- Handwriting > typing for emotional processing (studies back this up)\n\nMost importantly: on Day 87, I wrote about wanting to quit my job. On Day 100, I had a resignation letter drafted. By Day 120, I was working at a company I actually like.\n\nJournaling didn't solve my problems. It made them impossible to ignore.\n\nDo you journal? What format works for you?",
    topic: "self-improvement",
    tone: "reflective",
    tags: ["journaling", "self improvement", "writing", "mental health", "habits", "100 day challenge"],
    target_audience: "general"
  },
  {
    content_type: 'photo',
    title: "My tiny apartment garden — proof you don't need a yard",
    body: "I live in a 400 sq ft apartment with exactly ONE window that gets good light. Here's what I'm growing:\n\n- 3 herb pots (basil, mint, rosemary) on the windowsill\n- 2 cherry tomato plants in 5-gallon buckets on the fire escape\n- 1 strawberry plant hanging from a shower rod (repurposed, don't judge)\n- Microgreens in a shallow tray on my bookshelf\n\nTotal investment: $47. Total harvest (so far): 2 dozen tomatoes, infinite herbs, and a surprising amount of joy.\n\nThe tomatoes taste different when you grew them yourself. They taste like patience. It took 72 days from seed to first ripe fruit. Every morning I check the plants before I check my phone. I can't explain it, but this tiny garden has become the most grounding thing in my life.\n\nPics of the setup attached. Anyone else doing small-space gardening?",
    topic: "gardening",
    tone: "proud",
    tags: ["apartment gardening", "urban gardening", "small space", "plants", "tomatoes", "herbs", "microgreens"],
    target_audience: "nature lovers"
  },
  {
    content_type: 'text',
    title: "The quiet art of being 'mid' — in defense of being average",
    body: "The internet is obsessed with extremes. You're either a genius or a failure. A prodigy or a waste of potential. But most of us? We're mid. We're B+. We're 'pretty good at a few things and okay at most things.'\n\nAnd that's actually... great?\n\nHere's why being mid is underrated:\n- Mid people don't burn out chasing perfection\n- Mid hobbies bring more joy than competitive hobbies\n- Mid skills can still pay the bills\n- Mid artists still make art that connects with people\n- Mid doesn't mean stagnant — it means you're on the journey, not at the destination\n\nI'm a mid photographer, a mid guitarist, a mid cook, and a mid writer. Together, these mid skills make my life rich and interesting. I don't need to be a master of anything.\n\nAnyway, this post is mid and I'm fine with that.\n\nAnyone else embracing their B+ energy?",
    topic: "culture",
    tone: "defiant",
    tags: ["being average", "self acceptance", "perfectionism", "hobbies", "internet culture", "mental health"],
    target_audience: "general"
  },
  {
    content_type: 'chat',
    title: "Advice needed: transitioning from traditional to digital art",
    body: "heyartfriend asked:\n\nI've been doing traditional art (watercolor, acrylic) for 10 years. Just got my first tablet (Wacom Intuos). I feel like I'm learning to draw all over again. The hand-eye coordination is SO different. Any advice for making the transition?\n\n---\n\nFirst — what you're feeling is 100% normal. Every traditional artist goes through this. Here's what worked for me:\n\n1. DON'T try to replicate your traditional style. Treat digital as a new medium.\n2. Start with linework drills — trace simple shapes until the hand-eye gap closes. Took me about 2 weeks.\n3. Use a paper-texture overlay (or a matte screen protector) to reduce the 'drawing on glass' feeling.\n4. Photoshop/GIMP: set brush smoothing to 20-30%. It compensates for the slight lag your brain needs to adjust to.\n5. Your traditional color sense will start to shine after about 3 months. The fundamentals transfer — it's just the tool that's different.\n\nStick with it. By month 6, you'll wonder why you waited so long.\n\nWhat tablet did you get?",
    topic: "art advice",
    tone: "mentoring",
    tags: ["digital art", "traditional to digital", "wacom", "art advice", "learning"],
    target_audience: "artists"
  },
  {
    content_type: 'photo',
    title: "The abandoned greenhouse I found while hiking — and what I photographed there",
    body: "5 miles into a trail I've done a dozen times, I decided to take a different fork. That's when I found it — a Victorian-era greenhouse, completely abandoned, consumed by the forest.\n\nThe glass was mostly intact but covered in decades of moss. Inside: ferns growing through the tile floor, a rusty watering can suspended from a rotted beam, and this incredible shaft of light cutting through a broken panel in the ceiling.\n\nI spent 4 hours there with my camera. Didn't see another human. Just me, the light, and a place that the forest was slowly reclaiming.\n\nThese photos are from that afternoon. The last one — the watering can with the moss — might be my favorite photo I've ever taken.\n\nSometimes the best adventures aren't the ones you plan. They're the ones you stumble into when you take a different path.\n\nWho else has discovered something unexpected while exploring?",
    topic: "photography",
    tone: "adventurous",
    tags: ["urban exploration", "abandoned places", "photography", "hiking", "nature", "greenhouse", "adventure"],
    target_audience: "explorers"
  }
];

// ── 内容池管理器 ──────────────────────────────────
class ContentPool {
  constructor(poolDir = 'D:/MSCMS-Content/pool') {
    this.poolDir = poolDir;
    this.pools = {
      reddit: REDDIT_POOL,
      instagram: INSTAGRAM_POOL,
      tiktok: TIKTOK_POOL,
      x: X_POOL,
      discord: DISCORD_POOL,
      facebook: FACEBOOK_POOL,
      tumblr: TUMBLR_POOL,
    };
    this.usedIndices = {};
    for (const platform of Object.keys(this.pools)) {
      this.usedIndices[platform] = new Set();
    }
    this._loadExternalPool();
  }

  /**
   * 从外部目录加载额外内容
   * WorkBuddy 自动化生成的内容会被保存到这里
   */
  _loadExternalPool() {
    try {
      if (!fs.existsSync(this.poolDir)) {
        fs.mkdirSync(this.poolDir, { recursive: true });
        return;
      }
      const platforms = fs.readdirSync(this.poolDir);
      for (const platform of platforms) {
        const platformDir = path.join(this.poolDir, platform);
        if (!fs.statSync(platformDir).isDirectory()) continue;
        const files = fs.readdirSync(platformDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(platformDir, file), 'utf-8'));
            if (!this.pools[platform]) this.pools[platform] = [];
            this.pools[platform].push(content);
          } catch (e) {
            // Skip invalid files
          }
        }
      }
      console.log(`[content-pool] Loaded external pool: ${this._getPoolStats()}`);
    } catch (e) {
      console.warn(`[content-pool] Failed to load external pool: ${e.message}`);
    }
  }

  _getPoolStats() {
    return Object.entries(this.pools)
      .map(([k, v]) => `${k}:${v.length}`)
      .join(', ');
  }

  /**
   * 获取一条内容（轮询，不重复直到池耗尽）
   */
  getContent(platform) {
    const pool = this.pools[platform];
    if (!pool || pool.length === 0) return null;

    const used = this.usedIndices[platform];
    // 找未使用的
    let idx = -1;
    for (let i = 0; i < pool.length; i++) {
      if (!used.has(i)) {
        idx = i;
        break;
      }
    }

    // 全部用完，重置
    if (idx === -1) {
      this.usedIndices[platform].clear();
      idx = 0;
    }

    this.usedIndices[platform].add(idx);
    const item = pool[idx];

    return {
      title: item.title || null,
      body: item.body,
      text: item.body,
      topic: item.topic || 'general',
      tone: item.tone || 'neutral',
      hashtags: item.hashtags || [],
      platform,
      source: 'workbuddy-pool',
      pool_index: idx,
    };
  }

  /**
   * 获取池统计
   */
  getStats() {
    const stats = {};
    for (const [platform, pool] of Object.entries(this.pools)) {
      const used = this.usedIndices[platform];
      stats[platform] = {
        total: pool.length,
        used: used.size,
        remaining: pool.length - used.size,
      };
    }
    return stats;
  }

  /**
   * 向池中添加新内容（供自动化调用）
   */
  addContent(platform, content) {
    if (!this.pools[platform]) this.pools[platform] = [];
    this.pools[platform].push(content);

    // 同时持久化到外部目录
    try {
      const platformDir = path.join(this.poolDir, platform);
      if (!fs.existsSync(platformDir)) {
        fs.mkdirSync(platformDir, { recursive: true });
      }
      const fileName = `${Date.now()}_${this.pools[platform].length}.json`;
      fs.writeFileSync(
        path.join(platformDir, fileName),
        JSON.stringify(content, null, 2),
        'utf-8'
      );
    } catch (e) {
      console.warn(`[content-pool] Failed to persist: ${e.message}`);
    }
  }

  /**
   * 获取所有可用平台
   */
  getPlatforms() {
    return Object.keys(this.pools);
  }
}

module.exports = { ContentPool, REDDIT_POOL, INSTAGRAM_POOL, TIKTOK_POOL, X_POOL, DISCORD_POOL, FACEBOOK_POOL };
