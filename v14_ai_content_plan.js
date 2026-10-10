const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak, PageNumber, Header, Footer
} = require("docx");

// Layout constants (A4)
const pageW = 11906;
const pageH = 16838;
const tblW = 9026; // A4 - 1" margins

const border = { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" };
const borders = { top: border, bottom: border, left: border, right: border };
const cm = { top: 60, bottom: 60, left: 100, right: 100 };

// Helpers
function hCell(text, w, fill) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: fill || "1A1A2E", type: ShadingType.CLEAR },
    margins: cm,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Microsoft YaHei", size: 18 })] })]
  });
}
function hCellL(text, w, fill) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: fill || "1A1A2E", type: ShadingType.CLEAR },
    margins: cm,
    verticalAlign: "center",
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Microsoft YaHei", size: 18 })] })]
  });
}
function dCell(text, w, opts) {
  opts = opts || {};
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: cm,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text, font: "Microsoft YaHei", size: 18, color: opts.color || "333333", bold: opts.bold || false })] })]
  });
}

function p(text, opts) {
  opts = opts || {};
  return new Paragraph({
    spacing: { after: 120, before: opts.before || 0 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 20, color: "333333", bold: opts.bold, italics: opts.italics })]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 28, bold: true, color: "E94560" })]
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 24, bold: true, color: "0F3460" })]
  });
}

function bullet(text, ref) {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 19, color: "333333" })]
  });
}

function subBullet(text, ref) {
  return new Paragraph({
    numbering: { reference: ref, level: 1 },
    spacing: { after: 40 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 18, color: "555555" })]
  });
}

function formula(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80, after: 80 },
    border: { top: { style: BorderStyle.SINGLE, size: 1, color: "E94560", space: 4 }, bottom: { style: BorderStyle.SINGLE, size: 1, color: "E94560", space: 4 } },
    children: [new TextRun({ text, font: "Consolas", size: 19, color: "E94560", bold: true })]
  });
}

// Build document
const numbering = {
  config: [
    { reference: "b1", levels: [
      { level: 0, format: LevelFormat.BULLET, text: "\u25CF", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      { level: 1, format: LevelFormat.BULLET, text: "\u25CB", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }
    ]},
    { reference: "b2", levels: [
      { level: 0, format: LevelFormat.BULLET, text: "\u25C6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      { level: 1, format: LevelFormat.BULLET, text: "\u25CB", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }
    ]},
    { reference: "b3", levels: [
      { level: 0, format: LevelFormat.BULLET, text: "\u25B6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      { level: 1, format: LevelFormat.BULLET, text: "\u25CB", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }
    ]},
  ]
};

const children = [];

// ── COVER PAGE ──
children.push(new Paragraph({ spacing: { before: 4800 }, children: [] }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  border: { top: { style: BorderStyle.SINGLE, size: 8, color: "E94560", space: 8 } },
  children: [new TextRun({ text: "MSCMS v14", font: "Microsoft YaHei", size: 52, bold: true, color: "E94560" })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 600 },
  children: [new TextRun({ text: "AI\u667A\u80FD\u5185\u5BB9\u4E0E\u81EA\u4E3B\u8FDB\u5316\u5F15\u6D41\u7CFB\u7EDF", font: "Microsoft YaHei", size: 36, bold: true, color: "1A1A2E" })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 120 },
  children: [new TextRun({ text: "\u4F18\u5316\u65B9\u6848 v2.0", font: "Microsoft YaHei", size: 24, color: "808080", italics: true })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 240 },
  children: [new TextRun({ text: "\u2014\u2014 \u57FA\u4E8E TrendSentinel + Content Analytics AI + Pixelle-Video + RL-LLM-AB \u6846\u67B6\u7814\u7A76", font: "Microsoft YaHei", size: 18, color: "999999" })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "E94560", space: 8 } },
  spacing: { after: 1200 },
  children: [new TextRun({ text: "2026\u5E7407\u670803\u65E5", font: "Microsoft YaHei", size: 20, color: "808080" })]
}));

// ── TOC ──
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "\u76EE\u5F55", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u4E00\u7AE0  \u667A\u80FD\u5185\u5BB9\u60C5\u62A5\u5F15\u64CE (Content Intelligence Engine)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 3", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u4E8C\u7AE0  \u5185\u5BB9\u8BBE\u8BA1\u89C4\u5219\u5F15\u64CE (Content Design Rules)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 6", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u4E09\u7AE0  AI\u5185\u5BB9\u5DE5\u5382 (AI Content Factory)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 9", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u56DB\u7AE0  \u667A\u80FD\u53D1\u5E03\u4E0E\u5206\u53D1\u7CFB\u7EDF (Smart Publishing)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 12", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u4E94\u7AE0  \u5168\u94FE\u8DEF\u6570\u636E\u53CD\u9988\u4E0E\u5206\u6790 (Data Feedback)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 15", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u516D\u7AE0  \u81EA\u4E3B\u51B3\u7B56\u95ED\u73AF\u7CFB\u7EDF (Autonomous Decision Loop)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 18", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u4E03\u7AE0  \u81EA\u8FDB\u5316\u5185\u5BB9\u7CFB\u7EDF (Self-evolving System)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 21", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));
children.push(new Paragraph({
  spacing: { after: 240 },
  children: [
    new TextRun({ text: "\u7B2C\u516B\u7AE0  \u6570\u636E\u540C\u6B65\u4E0E\u7CFB\u7EDF\u67B6\u6784 (Data Sync & Architecture)", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }),
    new TextRun({ text: "    \u2026\u2026\u2026 24", font: "Microsoft YaHei", size: 20, color: "808080" }),
  ]
}));

// ============================================================
// CHAPTER 1: Content Intelligence Engine
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u4E00\u7AE0  \u667A\u80FD\u5185\u5BB9\u60C5\u62A5\u5F15\u64CE", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));
children.push(new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: "\u6838\u5FC3\u76EE\u6807\uff1a\u8F93\u5165\u5173\u952E\u8BCD \u2192 \u81EA\u52A8\u6293\u53D6\u793E\u5A92\u70ED\u70B9 \u2192 AIGC\u751F\u6210\u5185\u5BB9 \u2192 \u53D1\u5E03 \u2192 \u8FFD\u8E2A \u2192 \u81EA\u4E3B\u8FDB\u5316\u95ED\u73AF", font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" })] }
));

// 1.1 Multi-source Hot Topic Scraping Engine
children.push(h2("1.1  \u591A\u6E90\u793E\u5A92\u70ED\u70B9\u6293\u53D6\u5F15\u64CE"));
children.push(p("\u53C2\u8003 TrendSentinel \u5B9E\u65F6\u8D8B\u52BF\u68C0\u6D4B\u67B6\u6784\uff0C\u6253\u9020\u591A\u5E73\u53F0\u591A\u8BED\u8A00\u70ED\u70B9\u540C\u6B65\u91C7\u96C6\u7CFB\u7EDF\u3002"));

// Data source table
children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1300, 2400, 1600, 1726, 2000],
  rows: [
    new TableRow({ children: [hCell("\u6570\u636E\u6E90",1300), hCell("\u91C7\u96C6\u65B9\u5F0F",2400), hCell("\u66F4\u65B0\u9891\u7387",1600), hCell("\u53EF\u7528\u6027",1726), hCell("\u529F\u80FD",2000)] }),
    new TableRow({ children: [dCell("TikTok",1300), dCell("WebSocket + API \u6A21\u62DF",2400), dCell("\u5B9E\u65F6/\u6BCF30s",1600), dCell("\u2605\u2605\u2605\u2605",1726,{center:true}), dCell("\u70ED\u95E8\u89C6\u9891/\u97F3\u4E50/\u8D8B\u52BF#hashtag",2000)] }),
    new TableRow({ children: [dCell("Instagram",1300,{fill:"F8F9FA"}), dCell("Graph API + \u9875\u9762\u89E3\u6790",2400,{fill:"F8F9FA"}), dCell("\u6BCF60s",1600,{fill:"F8F9FA"}), dCell("\u2605\u2605\u2605",1726,{fill:"F8F9FA",center:true}), dCell("Reels\u70ED\u95E8\u5E16/\u63A2\u7D22\u9875\u8D8B\u52BF",2000,{fill:"F8F9FA"})] }),
    new TableRow({ children: [dCell("YouTube",1300), dCell("Data API v3",2400), dCell("\u6BCF120s",1600), dCell("\u2605\u2605\u2605\u2605\u2605",1726,{center:true}), dCell("\u8D8B\u52BF\u89C6\u9891/\u641C\u7D22\u70ED\u5EA6/\u8BC4\u8BBA\u5206\u6790",2000)] }),
    new TableRow({ children: [dCell("Twitter/X",1300,{fill:"F8F9FA"}), dCell("API v2 + \u6A21\u62DF\u6D4F\u89C8",2400,{fill:"F8F9FA"}), dCell("\u6BCF30s",1600,{fill:"F8F9FA"}), dCell("\u2605\u2605\u2605",1726,{fill:"F8F9FA",center:true}), dCell("\u8D8B\u52BF\u8BDD\u9898/\u7206\u53D1\u63A8\u6587/\u60C5\u611F\u5206\u6790",2000,{fill:"F8F9FA"})] }),
    new TableRow({ children: [dCell("Reddit",1300), dCell("JSON API",2400), dCell("\u6BCF120s",1600), dCell("\u2605\u2605\u2605\u2605\u2605",1726,{center:true}), dCell("\u70ED\u95E8Subreddit/\u8BDD\u9898\u8BA8\u8BBA\u5EA6",2000)] }),
    new TableRow({ children: [dCell("\u5FAE\u535A",1300,{fill:"F8F9FA"}), dCell("\u70ED\u641C\u699C\u89E3\u6790",2400,{fill:"F8F9FA"}), dCell("\u6BCF60s",1600,{fill:"F8F9FA"}), dCell("\u2605\u2605\u2605\u2605",1726,{fill:"F8F9FA",center:true}), dCell("\u5B9E\u65F6\u70ED\u641C/\u7206\u6B3E\u5FAE\u535A/\u8D85\u8BDD",2000,{fill:"F8F9FA"})] }),
    new TableRow({ children: [dCell("\u6296\u97F3",1300), dCell("\u70ED\u641C\u699CAPI + \u6A21\u62DF",2400), dCell("\u6BCF30s",1600), dCell("\u2605\u2605\u2605",1726,{center:true}), dCell("\u70ED\u95E8\u89C6\u9891/\u97F3\u4E50\u699C/\u8D8B\u52BF#\u6807\u7B7E",2000)] }),
    new TableRow({ children: [dCell("\u5C0F\u7EA2\u4E66",1300,{fill:"F8F9FA"}), dCell("\u6A21\u62DF\u6D4F\u89C8 + \u70ED\u95E8\u641C\u7D22",2400,{fill:"F8F9FA"}), dCell("\u6BCF120s",1600,{fill:"F8F9FA"}), dCell("\u2605\u2605\u2605",1726,{fill:"F8F9FA",center:true}), dCell("\u70ED\u95E8\u7B14\u8BB0/\u8D8B\u52BF\u8BDD\u9898/\u5173\u952E\u8BCD\u641C\u7D22",2000,{fill:"F8F9FA"})] }),
  ]
}));
children.push(p(""));

// Hot topic detection pipeline
children.push(h3("1.1.1  \u70ED\u70B9\u68C0\u6D4B\u6D41\u6C34\u7EBF"));
children.push(p("\u53C2\u8003 TrendSentinel \u7684\u5B9E\u65F6\u6570\u636E\u6D41\u5904\u7406\u67B6\u6784\uff0C\u91C7\u7528 Apache Kafka + Flink \u67B6\u6784\u5B9E\u73B0\u4F4E\u5EF6\u8FDF\u70ED\u70B9\u68C0\u6D4B\u3002"));
children.push(bullet("\u6570\u636E\u91C7\u96C6\u5C42: \u591A\u6E90API\u8FDE\u63A5\u5668 \u2192 Kafka\u6D88\u606F\u961F\u5217 \u2192 \u6301\u4E45\u5316\u7F13\u51B2", "b1"));
children.push(bullet("\u5B9E\u65F6\u5904\u7406\u5C42: Flink\u6D41\u5904\u7406 \u2192 NLP\u5173\u952E\u8BCD\u63D0\u53D6 \u2192 \u60C5\u611F\u5206\u6790 \u2192 \u65F6\u95F4\u7A97\u53E3\u805A\u5408", "b1"));
children.push(bullet("\u72B6\u6001\u5B58\u50A8\u5C42: Elasticsearch\u5168\u6587\u641C\u7D22 + InfluxDB\u65F6\u5E8F\u6307\u6807 + S3\u539F\u59CB\u6570\u636E\u6E56", "b1"));
children.push(bullet("\u544A\u8B66\u5C42: \u57FA\u4E8EZ-Score+Grubbs\u5F02\u5E38\u68C0\u6D4B\u7684\u7206\u53D1\u4E8B\u4EF6\u81EA\u52A8\u89E6\u53D1\uff0CKafka CEP\u590D\u6742\u4E8B\u4EF6\u5904\u7406", "b1"));

children.push(h3("1.1.2  \u70ED\u70B9\u8BC4\u5206\u4E0E\u5206\u7EA7\u6A21\u578B"));
children.push(p("\u53C2\u8003 Content Analytics AI \u591A\u7EF4\u8BC4\u5206\u4F53\u7CFB\uff0C\u5C06\u70ED\u70B9\u6309\u7EFC\u5408\u5F97\u5206\u5206\u7EA7\uff1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1000, 1200, 2000, 1826, 3000],
  rows: [
    new TableRow({ children: [hCell("\u5206\u7EA7",1000), hCell("\u989C\u8272",1200), hCell("\u8BC4\u5206\u8303\u56F4",2000), hCell("\u89E6\u53D1\u6761\u4EF6",1826), hCell("\u54CD\u5E94\u7B56\u7565",3000)] }),
    new TableRow({ children: [
      dCell("S\u7EA7/\u7206\u53D1",1000,{bold:true,color:"E94560"}),
      dCell("\u2605\u2605\u2605\u2605\u2605",1200,{center:true,color:"E94560"}),
      dCell("\u589E\u957F\u7387>300%/h \u6216 >10x\u5E73\u5747\u91CF",2000),
      dCell("\u81EA\u52A8\u89E6\u53D1\u751F\u6210+\u53D1\u5E03",1826),
      dCell("\u7ACB\u5373AIGC\u751F\u6210\u2192\u81EA\u52A8\u53D1\u5E03\u2192\u5B9E\u65F6\u8FFD\u8E2A\u2192\u5F02\u6B65\u6240\u6709\u8D26\u53F7",3000)
    ]}),
    new TableRow({ children: [
      dCell("A\u7EA7/\u70ED\u95E8",1000,{bold:true,color:"FF6B00",fill:"F8F9FA"}),
      dCell("\u2605\u2605\u2605\u2605",1200,{center:true,color:"FF6B00",fill:"F8F9FA"}),
      dCell("\u589E\u957F\u7387>100%/h \u6216 >5x\u5E73\u5747\u91CF",2000,{fill:"F8F9FA"}),
      dCell("\u534A\u81EA\u52A8\uff1a\u751F\u6210\u540E\u5BA1\u6838\u518D\u53D1\u5E03",1826,{fill:"F8F9FA"}),
      dCell("\u4F18\u5148\u5206\u914D\u8D44\u6E90\u2192AIGC\u751F\u6210\u2192\u4EBA\u5DE5\u786E\u8BA4\u2192\u5B9A\u65F6\u53D1\u5E03\u2192\u8FFD\u8E2A",3000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("B\u7EA7/\u4E0A\u5347",1000,{bold:true,color:"0F3460"}),
      dCell("\u2605\u2605\u2605",1200,{center:true,color:"0F3460"}),
      dCell("\u589E\u957F\u7387>30%/h \u6216 >2x\u5E73\u5747\u91CF",2000),
      dCell("\u4EBA\u5DE5\u5BA1\u6838\u540E\u751F\u6210",1826),
      dCell("\u52A0\u5165\u5185\u5BB9\u961F\u5217\u2192\u4F18\u5148\u7EA7\u8F83\u4F4E\u2192\u53EF\u624B\u52A8\u89E6\u53D1",3000)
    ]}),
    new TableRow({ children: [
      dCell("C\u7EA7/\u6B63\u5E38",1000,{bold:true,color:"808080",fill:"F8F9FA"}),
      dCell("\u2605\u2605",1200,{center:true,color:"808080",fill:"F8F9FA"}),
      dCell("\u589E\u957F\u7387>0/h \u6216 <2x\u5E73\u5747\u91CF",2000,{fill:"F8F9FA"}),
      dCell("\u4EC5\u8BB0\u5F55\u4E0D\u89E6\u53D1",1826,{fill:"F8F9FA"}),
      dCell("\u4FDD\u5B58\u6570\u636E\u2192\u7D2F\u79EF\u6A21\u5F0F\u5206\u6790\u2192\u8F85\u52A9\u672A\u6765\u51B3\u7B56",3000,{fill:"F8F9FA"})
    ]}),
  ]
}));

// 1.2 Content Opportunity Mining
children.push(h2("1.2  \u5185\u5BB9\u673A\u4F1A\u6316\u6398\u5F15\u64CE"));
children.push(p("\u5F53\u7528\u6237\u8F93\u5165\u5173\u952E\u8BCD\u540E\uff0C\u7CFB\u7EDF\u6267\u884C\u4EE5\u4E0B\u667A\u80FD\u5206\u6790\u6D41\u7A0B\uff1A"));

children.push(h3("1.2.1  \u5173\u952E\u8BCD\u62C6\u89E3\u4E0E\u6269\u5C55"));
children.push(bullet("\u8BED\u4E49\u6269\u5C55: \u5229\u7528LLM\u5C06\u5173\u952E\u8BCD\u6269\u5C55\u4E3A\u76F8\u5173\u8BCD\u3001\u540C\u4E49\u8BCD\u3001\u957F\u5C3E\u8BCD\uff0C\u5F62\u6210\u201C\u8BCD\u4E91\u77E9\u9635\u201D", "b1"));
children.push(bullet("\u8BED\u8A00\u8F6C\u6362: \u81EA\u52A8\u7FFB\u8BD1\u4E3A\u82F1\u6587/\u65E5\u6587/\u97E9\u6587\u7B49\uff0C\u8DE8\u8BED\u8A00\u641C\u7D22\u5BF9\u5E94\u5E73\u53F0\u70ED\u70B9", "b1"));
children.push(bullet("\u573A\u666F\u5206\u7C7B: NLP\u81EA\u52A8\u8BC6\u522B\u5173\u952E\u8BCD\u6240\u5C5E\u573A\u666F(\u7F8E\u5986/\u6570\u7801/\u5065\u8EAB/\u7F8E\u98DF\u7B49)", "b1"));
children.push(bullet("\u7528\u6237\u753B\u50CF: \u63A8\u65AD\u76EE\u6807\u53D7\u4F17\u5E74\u9F84/\u6027\u522B/\u5174\u8DA3/\u5730\u533A\uff0C\u7528\u4E8E\u5185\u5BB9\u98CE\u683C\u8C03\u6574", "b1"));

children.push(h3("1.2.2  \u5168\u7F51\u70ED\u5EA6\u96F7\u8FBE\u56FE"));
children.push(p("\u7EFC\u5408\u5404\u5E73\u53F0\u6570\u636E\u751F\u6210\u201C\u70ED\u5EA6\u96F7\u8FBE\u56FE\u201D\uff0C\u53EF\u89C6\u5316\u5C55\u793A\uff1A"));
children.push(bullet("\u5F53\u524D\u6700\u70ED\u8BDD\u9898: \u5404\u5E73\u53F0\u7EFC\u5408\u5F97\u5206Top20\u6392\u540D", "b1"));
children.push(bullet("\u8D8B\u52BF\u66F2\u7EBF: \u67D0\u5173\u952E\u8BCD\u8FC7\u53BB7/14/30\u5929\u7684\u70ED\u5EA6\u53D8\u5316\u56FE", "b1"));
children.push(bullet("\u76F8\u5173\u8054\u60F3: \u70ED\u70B9\u4E4B\u95F4\u7684\u5173\u8054\u5173\u7CFB\u56FE\u8C31", "b1"));
children.push(bullet("\u9884\u6D4B\u5206: \u57FA\u4E8E\u5386\u53F2\u6570\u636E\u7684\u672A\u676524-72\u5C0F\u65F6\u70ED\u5EA6\u8D8B\u52BF\u9884\u6D4B", "b1"));

children.push(h3("1.2.3  \u5185\u5BB9\u7A7A\u767D\u5206\u6790"));
children.push(p("\u5BF9\u6BD4\u201C\u70ED\u70B9\u4F9B\u7ED9\u201D\u4E0E\u201C\u5185\u5BB9\u4F9B\u7ED9\u201D\u7684\u5DEE\u8DDD\uff0C\u8BC6\u522B\u84DD\u6D77\u673A\u4F1A\uFF1A"));
children.push(bullet("\u4F9B\u9700\u5DEE\u8DDD\u6307\u6570: HotTopicDemand / ContentSupply = Opportunity Score", "b1"));
children.push(bullet("\u7ADE\u54C1\u5206\u6790: \u81EA\u52A8\u5206\u6790\u5DF2\u53D1\u5E03\u5185\u5BB9\u7684\u8D28\u91CF/\u4E92\u52A8/\u7F3A\u9677\uff0C\u627E\u5230\u53EF\u8D85\u8D8A\u70B9", "b1"));
children.push(bullet("\u683C\u5F0F\u673A\u4F1A: \u8BC6\u522B\u7F3A\u4E4F\u77ED\u89C6\u9891/\u56FE\u6587/\u957F\u6587\u7684\u70ED\u70B9\u65B9\u5411", "b1"));

// ============================================================
// CHAPTER 2: Content Design Rules Engine
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u4E8C\u7AE0  \u5185\u5BB9\u8BBE\u8BA1\u89C4\u5219\u5F15\u64CE", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("2.1  \u5185\u5BB9\u7B56\u7565\u77E9\u9635 (Content Strategy Matrix)"));
children.push(p("\u57FA\u4E8E\u70ED\u70B9\u8BC4\u5206 + \u5E73\u53F0\u7279\u6027 + \u8D26\u53F7\u4EBA\u8BBE\uFF0C\u751F\u6210\u52A8\u6001\u5185\u5BB9\u7B56\u7565\u77E9\u9635\u3002"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1400, 1800, 1800, 1800, 2226],
  rows: [
    new TableRow({ children: [hCell("\u7B56\u7565\u7EF4\u5EA6",1400), hCell("TikTok/\u6296\u97F3",1800), hCell("Instagram/\u5C0F\u7EA2\u4E66",1800), hCell("YouTube",1800), hCell("Twitter/X",2226)] }),
    new TableRow({ children: [
      dCell("\u5185\u5BB9\u5F62\u5F0F",1400,{bold:true}),
      dCell("15-60s\u77ED\u89C6\u9891\u4E3A\u4E3B",1800),
      dCell("Reels+Carousel\u4E3A\u4E3B",1800),
      dCell("8-15\u5206\u949F\u4E2D\u957F\u89C6\u9891",1800),
      dCell("\u77ED\u6587\u5B50+\u89C6\u9891\u5361\u7247",2226)
    ]}),
    new TableRow({ children: [
      dCell("\u6700\u4F73\u65F6\u95F4",1400,{bold:true,fill:"F8F9FA"}),
      dCell("19:00-22:00\u5DE5\u4F5C\u65E5/14:00-17:00\u5468\u672B",1800,{fill:"F8F9FA"}),
      dCell("12:00-14:00 + 20:00-22:00",1800,{fill:"F8F9FA"}),
      dCell("17:00-20:00(\u5168\u5929)",1800,{fill:"F8F9FA"}),
      dCell("8:00-10:00 + 18:00-20:00",2226,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u4E92\u52A8\u7387\u57FA\u51C6",1400,{bold:true}),
      dCell("5-15%(\u4F18\u79C0)",1800),
      dCell("3-6%(\u4F18\u79C0)",1800),
      dCell("4-10% CTR(\u4F18\u79C0)",1800),
      dCell("1-3%(\u4F18\u79C0)",2226)
    ]}),
    new TableRow({ children: [
      dCell("\u8868\u9898\u89C4\u5219",1400,{bold:true,fill:"F8F9FA"}),
      dCell("\u957F\u5EA640-60\u5B57\u7B26 + \u6570\u5B57 + \u60AC\u5FF5",1800,{fill:"F8F9FA"}),
      dCell("\u7B80\u6D01\u53E5\u5F0F + \u591AEmoji + 3-5\u4E2A#",1800,{fill:"F8F9FA"}),
      dCell("\u6807\u9898\u5305\u542B\u6570\u5B57/\u95EE\u53E5 + \u81EA\u5B9A\u4E49\u7F29\u7565\u56FE",1800,{fill:"F8F9FA"}),
      dCell("250\u5B57\u7B26\u5185 + 1-2\u4E2AHashtag",2226,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("#\u6807\u7B7E\u7B56\u7565",1400,{bold:true}),
      dCell("1-3\u4E2A\u7206\u6B3E# + 2-5\u4E2A\u5C0F\u4F17#",1800),
      dCell("15-20\u4E2A\u7EC4\u5408\uff0c\u7528\u4F5CSEO",1800),
      dCell("3-5\u4E2A\u76F8\u5173\u6807\u7B7E",1800),
      dCell("1-2\u4E2A#\u5373\u53EF",2226)
    ]}),
  ]
}));

children.push(h2("2.2  \u5185\u5BB9DNA\u6A21\u677F\u5E93"));
children.push(p("\u6BCF\u4E2A\u5185\u5BB9\u90FD\u6709\u5176\u201CDNA\u201D\u2014\u2014\u4E00\u7EC4\u53EF\u91CF\u5316\u7684\u5185\u5BB9\u5C5E\u6027\uFF0C\u7528\u4E8E\u76F8\u4F3C\u5185\u5BB9\u7684\u81EA\u52A8\u751F\u6210\u4E0E\u8FED\u4EE3\u3002"));
children.push(bullet("\u8BDD\u9898DNA: [\u5173\u952E\u8BCD\u8BCD\u4E91] + [\u60C5\u611F\u503E\u5411: positive/neutral/negative] + [\u7D27\u8FEB\u611F: 0-1] + [\u65B0\u9896\u5EA6: 0-1]", "b1"));
children.push(bullet("\u5F62\u5F0FDNA: [\u5185\u5BB9\u7C7B\u578B: \u6559\u7A0B/\u6D4B\u8BC4/\u641E\u7B11/\u60C5\u611F] + [\u65F6\u957F: \u77ED\u4E2D\u957F] + [\u97F3\u4E50\u98CE\u683C] + [\u89C6\u89C9\u98CE\u683C]", "b1"));
children.push(bullet("\u7ED3\u6784DNA: [\u5F00\u5934\u6A21\u677F] + [Hook\u7C7B\u578B: \u63D0\u95EE/\u53CD\u5DEE/\u60AC\u5FF5/\u6570\u636E] + [\u6BB5\u843D\u7ED3\u6784] + [CTA\u53E3\u53F7]", "b1"));
children.push(bullet("\u53D8\u5F02\u53C2\u6570: \u53D8\u5F02\u5E45\u5EA6(0-1) \u00D7 \u5E73\u53F0\u9002\u914D\u5EA6(0-1) \u00D7 \u65F6\u6548\u7D27\u8FEB\u5EA6(0-1)", "b1"));

children.push(h2("2.3  A/B\u6D4B\u8BD5\u89C4\u5219\u5F15\u64CE"));
children.push(p("\u53C2\u8003 RL-LLM-AB\u6846\u67B6\uff0C\u5B9E\u73B0\u81EA\u52A8\u5316\u5185\u5BB9A/B\u6D4B\u8BD5\u3002"));
children.push(bullet("\u53D8\u91CF\u5B9A\u4E49: \u6BCF\u6B21\u6D4B\u8BD5\u53EA\u53D8\u4E00\u4E2A\u53D8\u91CF\uff08\u6807\u9898/\u7F29\u7565\u56FE/\u5F00\u5934Hook/\u65F6\u957F/\u97F3\u4E50\uff09", "b1"));
children.push(bullet("\u5B9E\u9A8C\u8BBE\u8BA1: 50/50\u5206\u6D41\uFF0C\u6301\u7EED2-24\u5C0F\u65F6\uff0C\u81EA\u52A8\u7ED3\u675F\u5E76\u9009\u62E9\u4F18\u80DC\u8005", "b1"));
children.push(bullet("\u52A0\u6743\u591A\u81C2\u8D4C\u673A (Thompson Sampling): \u52A8\u6001\u8C03\u6574\u6D41\u91CF\u5206\u914D\uff0C\u504F\u5411\u8868\u73B0\u66F4\u597D\u7684\u53D8\u4F53", "b1"));
children.push(bullet("\u7EDF\u8BA1\u663E\u8457\u6027: p<0.05\u81EA\u52A8\u5BA3\u544A\u80DC\u8005\uff0Cp>0.05\u5EF6\u957F\u6D4B\u8BD5\u6216\u5BA3\u5E03\u65E0\u5DEE\u5F02", "b1"));

// ============================================================
// CHAPTER 3: AI Content Factory
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u4E09\u7AE0  AI\u5185\u5BB9\u5DE5\u5382", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("3.1  \u4E94\u5C42\u5185\u5BB9\u751F\u6210\u4F53\u7CFB"));
children.push(p("\u4ECE\u539F\u59CB\u8F93\u5165\u5230\u53D1\u5E03\u5185\u5BB9\u7684\u5B8C\u6574\u751F\u6210\u94FE\u8DEF\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [900, 2000, 2600, 1526, 2000],
  rows: [
    new TableRow({ children: [hCell("\u5C42\u7EA7",900), hCell("\u540D\u79F0",2000), hCell("\u529F\u80FD\u8BF4\u660E",2600), hCell("\u6280\u672F\u65B9\u6848",1526), hCell("\u53D8\u4F53\u6570\u91CF",2000)] }),
    new TableRow({ children: [
      dCell("L1",900,{bold:true,color:"E94560"}),
      dCell("\u540C\u4E49\u8BCD\u66FF\u6362",2000),
      dCell("\u57FA\u4E8EWordNet+NLP\u540C\u4E49\u8BCD\u5E93\uFF0C\u66FF\u6362\u5173\u952E\u540D\u8BCD/\u52A8\u8BCD/\u5F62\u5BB9\u8BCD",2600),
      dCell("NLTK WordNet + spaCy POS Tagging",1526),
      dCell("3-5\u4E2A\u53D8\u4F53",2000)
    ]}),
    new TableRow({ children: [
      dCell("L2",900,{bold:true,color:"FF6B00",fill:"F8F9FA"}),
      dCell("\u8BED\u5E8F\u91CD\u6392",2000,{fill:"F8F9FA"}),
      dCell("\u4E3B\u52A8\u2194\u88AB\u52A8\u8F6C\u6362\u3001\u53E5\u5B50\u62C6\u5206/\u5408\u5E76\u3001\u5F3A\u8C03\u70B9\u524D\u79FB",2600,{fill:"F8F9FA"}),
      dCell("LLM (GPT-4o/Qwen) with prompt templates",1526,{fill:"F8F9FA"}),
      dCell("5-8\u4E2A\u53D8\u4F53",2000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("L3",900,{bold:true,color:"0F3460"}),
      dCell("\u8BED\u4E49\u590D\u8FF0",2000),
      dCell("\u4FDD\u7559\u539F\u610F\u91CD\u65B0\u8868\u8FF0\u3001\u89D2\u5EA6\u8F6C\u6362\u3001\u6DF1\u5EA6\u6539\u5199",2600),
      dCell("LLM 800-1500 token\u957F\u4E0A\u4E0B\u6587",1526),
      dCell("8-15\u4E2A\u53D8\u4F53",2000)
    ]}),
    new TableRow({ children: [
      dCell("L4",900,{bold:true,color:"533483",fill:"F8F9FA"}),
      dCell("\u591A\u6A21\u6001\u751F\u6210",2000,{fill:"F8F9FA"}),
      dCell("\u751F\u6210\u56FE\u6587/\u89C6\u9891/\u5361\u7247/\u957F\u6587\u7B49\u591A\u79CD\u7C7B\u578B\u5185\u5BB9",2600,{fill:"F8F9FA"}),
      dCell("ComfyUI + Pixelle-Video\u6D41\u6C34\u7EBF",1526,{fill:"F8F9FA"}),
      dCell("3-8\u4E2A\u53D8\u4F53",2000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("L5",900,{bold:true,color:"E94560"}),
      dCell("\u4E2A\u6027\u5316\u5C42",2000),
      dCell("\u6839\u636E\u8D26\u53F7\u4EBA\u8BBE\u8C03\u6574\u8BED\u6C14/\u98CE\u683C/\u89C6\u89D2\uFF0C\u6BCF\u4E2A\u8D26\u53F7\u72EC\u7279\u5185\u5BB9",2600),
      dCell("\u8D26\u53F7Profile\u5411\u91CF + LLM Fine-tuning",1526),
      dCell("\u6BCF\u8D26\u53F7\u72EC\u72791\u4E2A\u53D8\u4F53",2000)
    ]}),
  ]
}));

children.push(h2("3.2  \u53D8\u4F53\u53BB\u91CD\u4E0E\u591A\u6837\u6027\u4FDD\u8BC1"));
children.push(p("\u53C2\u8003 Content Analytics AI \u7684\u7279\u5F81\u5DE5\u7A0B\u65B9\u6CD5\uFF0C\u786E\u4FDD\u540C\u4E00\u70ED\u70B9\u751F\u6210\u7684\u591A\u4E2A\u53D8\u4F53\u771F\u6B63\u4E0D\u540C\u3002"));

children.push(h3("3.2.1  \u53CC\u91CD\u53BB\u91CD\u7B97\u6CD5"));
formula("Jaccard Similarity: J(A,B) = |A \u2229 B| / |A \u222A B|   (\u9608\u503C < 0.3)");
children.push(p(""));
formula("Levenshtein Distance Ratio: 1 - (edit_distance / max(len_A, len_B))   (\u9608\u503C < 0.7)");
children.push(p(""));
children.push(bullet("\u53EA\u6709\u540C\u65F6\u901A\u8FC7\u4E24\u4E2A\u53BB\u91CD\u68C0\u9A8C\u7684\u53D8\u4F53\u624D\u80FD\u8FDB\u5165\u5E93\u4E2D", "b1"));
children.push(bullet("\u53BB\u91CD\u68C0\u9A8C\u8303\u56F4: \u540C\u4E00\u8D26\u53F7\u5386\u53F2\u5185\u5BB9 + \u540C\u6279\u6B21\u5176\u4ED6\u53D8\u4F53 + \u5168\u5C40\u5185\u5BB9\u5E93", "b1"));
children.push(bullet("\u53BB\u91CD\u5931\u8D25\u81EA\u52A8\u89E6\u53D1\u91CD\u65B0\u751F\u6210\uFF0C\u6700\u591A3\u6B21\u91CD\u8BD5\uff0C\u8D85\u8FC7\u5219\u964D\u7EA7\u5904\u7406", "b1"));

children.push(h2("3.3  AI\u77ED\u89C6\u9891\u81EA\u52A8\u751F\u6210\u7BA1\u7EBF"));
children.push(p("\u53C2\u8003 Pixelle-Video \u5168\u81EA\u52A8\u77ED\u89C6\u9891\u5F15\u64CE\u67B6\u6784\uFF0C\u5B9E\u73B0\u4ECE\u4E3B\u9898\u5230\u6210\u54C1\u7684\u5B8C\u6574\u6D41\u6C34\u7EBF\u3002"));

children.push(h3("3.3.1  \u516D\u6B65\u89C6\u9891\u751F\u6210\u6D41\u7A0B"));
children.push(bullet("\u6B65\u9AA41\u2502\u6587\u6848\u751F\u6210: LLM\u63A5\u6536\u70ED\u70B9\u4E3B\u9898 \u2192 \u8FD4\u56DE\u7ED3\u6784\u5316\u5206\u955C\u6587\u6848\uff08\u6BCF\u6BB5\u542B\u6587\u5B57\u63CF\u8FF0+\u753B\u9762\u5EFA\u8BAE+\u65F6\u957F\u5206\u914D\uff09", "b1"));
children.push(bullet("\u6B65\u9AA42\u2502\u914D\u56FE\u89C4\u5212: \u6309\u5206\u955C\u6570\u91CF\u89C4\u5212\u56FE\u7247\u8BF7\u6C42\uFF0C\u786E\u5B9A\u6BCF\u5F20\u56FE\u5C3A\u5BF8/\u63D0\u793A\u8BCD\u524D\u7F00/\u98CE\u683C\u7EDF\u4E00\u6027", "b1"));
children.push(bullet("\u6B65\u9AA43\u2502\u5E76\u884C\u751F\u6210: \u901A\u8FC7ComfyUI\u5DE5\u4F5C\u6D41\u5E76\u884C\u751F\u6210\u6240\u6709\u914D\u56FE/\u89C6\u9891\u7247\u6BB5", "b1"));
children.push(bullet("\u6B65\u9AA44\u2502\u8BED\u97F3\u5408\u6210: \u5C06\u6BCF\u6BB5\u6587\u6848\u901A\u8FC7TTS\u5DE5\u4F5C\u6D41\u5408\u6210\u8BED\u97F3\u6587\u4EF6\uff08\u652F\u6301\u58F0\u97F3\u514B\u9686\uff09", "b1"));
children.push(bullet("\u6B65\u9AA45\u2502\u89C6\u9891\u5408\u6210: \u5C06\u914D\u56FE + \u8BED\u97F3 + BGM + \u5B57\u5E55\u901A\u8FC7ffmpeg\u5408\u6210\u4E3A\u6700\u7EC8MP4", "b1"));
children.push(bullet("\u6B65\u9AA46\u2502\u8D28\u91CF\u6821\u9A8C: \u81EA\u52A8\u68C0\u6D4B\u89C6\u9891\u5206\u8FA8\u7387/\u957F\u5EA6/\u97F3\u753B\u540C\u6B65/\u9ED1\u5C4F\u5360\u6BD4\uFF0C\u4E0D\u5408\u683C\u81EA\u52A8\u91CD\u751F", "b1"));

children.push(h3("3.3.2  \u53EF\u63D2\u62D4\u6A21\u5757\u67B6\u6784"));
children.push(p("\u53C2\u8003 Pixelle-Video \u4E09\u5C42\u67B6\u6784\u8BBE\u8BA1\uff1A"));
children.push(bullet("Web\u5C42 (Streamlit/PyQt6): \u7528\u6237\u4EA4\u4E92\u3001\u914D\u7F6E\u7BA1\u7406\u3001\u4EFB\u52A1\u89E6\u53D1", "b1"));
children.push(bullet("\u7F16\u6392\u5C42 (Pipelines): \u8D1F\u8D23\u628A\u539F\u5B50\u80FD\u529B\u4E32\u8054\u6210\u5B8C\u6574\u7684\u89C6\u9891\u751F\u6210\u6D41\u6C34\u7EBF\uFF0C\u6BCF\u4E2A\u6B65\u9AA4\u53EF\u5355\u72EC\u66FF\u6362", "b1"));
children.push(bullet("\u80FD\u529B\u5C42 (ComfyUI + LLM/TTS): \u5DE5\u4F5C\u6D41JSON\u6587\u4EF6\u5B9A\u4E49\uFF0C\u6362\u6A21\u578B\u53EA\u9700\u66FF\u6362JSON\u6587\u4EF6\uff0C\u4E0D\u7528\u6539\u4EE3\u7801", "b1"));

children.push(h2("3.4  \u591A\u5A92\u4F53\u5185\u5BB9\u8F93\u51FA\u77E9\u9635"));
children.push(p("\u540C\u4E00\u70ED\u70B9\u81EA\u52A8\u751F\u6210\u591A\u79CD\u683C\u5F0F\u5185\u5BB9\uFF0C\u8986\u76D6\u4E0D\u540C\u5E73\u53F0\u9700\u6C42\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1600, 1260, 1200, 1500, 1266, 2200],
  rows: [
    new TableRow({ children: [hCell("\u5185\u5BB9\u7C7B\u578B",1600), hCell("\u9002\u914D\u5E73\u53F0",1260), hCell("\u751F\u6210\u65F6\u957F",1200), hCell("\u53D8\u4F53\u6570\u91CF",1500), hCell("\u8D28\u91CF\u6307\u6807",1266), hCell("\u7279\u8272\u80FD\u529B",2200)] }),
    new TableRow({ children: [
      dCell("\u77ED\u89C6\u9891(15-60s)",1600,{bold:true}),
      dCell("TikTok/\u6296\u97F3/Reels",1260),
      dCell("3-5\u5206\u949F",1200),
      dCell("5-10\u4E2A",1500),
      dCell("\u5206\u8FA8\u7387\u22651080p",1266),
      dCell("AI\u914D\u56FE+\u8BED\u97F3+\u5B57\u5E55+BGM\u81EA\u52A8\u5408\u6210",2200)
    ]}),
    new TableRow({ children: [
      dCell("\u4E2D\u89C6\u9891(3-10min)",1600,{bold:true,fill:"F8F9FA"}),
      dCell("YouTube/Facebook",1260,{fill:"F8F9FA"}),
      dCell("8-15\u5206\u949F",1200,{fill:"F8F9FA"}),
      dCell("3-5\u4E2A",1500,{fill:"F8F9FA"}),
      dCell("\u5B8C\u64AD\u7387>\u76EE\u680740%",1266,{fill:"F8F9FA"}),
      dCell("\u6DF1\u5EA6\u5185\u5BB9+PPT\u5F55\u5C4F+\u4E3B\u6301\u4EBAAI\u97F3\u8272",2200,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u56FE\u6587\u5361\u7247",1600,{bold:true}),
      dCell("\u5C0F\u7EA2\u4E66/\u5FAE\u535A",1260),
      dCell("1-3\u5206\u949F",1200),
      dCell("8-20\u4E2A",1500),
      dCell("Jaccard\u53BB\u91CD<0.3",1266),
      dCell("\u591A\u56FE\u6587\u683C\u5F0F+\u5E73\u53F0\u4F18\u5316\u7F29\u7565\u56FE+\u4E92\u52A8\u5F15\u5BFC",2200)
    ]}),
    new TableRow({ children: [
      dCell("\u63A8\u6587\u77ED\u5E16",1600,{bold:true,fill:"F8F9FA"}),
      dCell("Twitter/X/Threads",1260,{fill:"F8F9FA"}),
      dCell("<30\u79D2",1200,{fill:"F8F9FA"}),
      dCell("15-30\u4E2A",1500,{fill:"F8F9FA"}),
      dCell("\u6BCF\u6761\u72EC\u7279\u6027>85%",1266,{fill:"F8F9FA"}),
      dCell("\u81EA\u52A8\u5206\u6BB5+\u8F6E\u64AD\u95F4\u9694+\u60C5\u611F\u5206\u7EA7\u5206\u53D1",2200,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u957F\u6587\u6DF1\u5EA6",1600,{bold:true}),
      dCell("\u5FAE\u4FE1/\u77E5\u4E4E/\u535A\u5BA2",1260),
      dCell("2-5\u5206\u949F",1200),
      dCell("5-8\u4E2A",1500),
      dCell("\u539F\u521B\u5EA6\u8BC4\u5206>0.7",1266),
      dCell("\u7ED3\u6784\u5316\u5185\u5BB9+\u5185\u90E8\u94FE\u63A5+\u5F15\u6D41CTA",2200)
    ]}),
  ]
}));

// ============================================================
// CHAPTER 4: Smart Publishing
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u56DB\u7AE0  \u667A\u80FD\u53D1\u5E03\u4E0E\u5206\u53D1\u7CFB\u7EDF", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("4.1  \u667A\u80FD\u53D1\u5E03\u7B56\u7565\u5F15\u64CE"));
children.push(p("\u57FA\u4E8E\u5185\u5BB9\u70ED\u5EA6\u9884\u6D4B + \u5E73\u53F0\u7B97\u6CD5\u7279\u6027 + \u8D26\u53F7\u5065\u5EB7\u5EA6 + \u53D7\u4F17\u6D3B\u8DC3\u65F6\u95F4\uFF0C\u52A8\u6001\u8BA1\u7B97\u6700\u4F18\u53D1\u5E03\u65B9\u6848\u3002"));

children.push(h3("4.1.1  \u53D1\u5E03\u51B3\u7B56\u77E9\u9635"));
children.push(bullet("\u65F6\u95F4\u7A97\u53E3: \u6839\u636E\u76EE\u6807\u53D7\u4F17\u65F6\u533A + \u5386\u53F2\u4E92\u52A8\u6570\u636E\u8BA1\u7B97\u6700\u4F18\u53D1\u5E03\u65F6\u95F4", "b1"));
children.push(bullet("\u8D26\u53F7\u8D1F\u8377\u5747\u8861: \u907F\u514D\u591A\u4E2A\u8D26\u53F7\u540C\u65F6\u53D1\u5E03\u76F8\u4F3C\u5185\u5BB9\uff0C\u968F\u673A\u9519\u5F00\u65F6\u95F4\u7A97\u53E3", "b1"));
children.push(bullet("\u5185\u5BB9\u63A5\u529B: \u540C\u4E00\u8D26\u53F7\u53D1\u5E03\u95F4\u9694\u22652\u5C0F\u65F6\uff0C\u907F\u514D\u88AB\u5224\u5B9A\u4E3A\u673A\u5668\u4EBA\u884C\u4E3A", "b1"));
children.push(bullet("\u7D27\u6025\u6A21\u5F0F: S\u7EA7\u7206\u53D1\u70ED\u70B9\u89E6\u53D1\u65F6\uFF0C\u53EF\u7A81\u7834\u95F4\u9694\u9650\u5236\uFF0C\u4F18\u5148\u53D1\u5E03\u62A2\u5360\u6D41\u91CF", "b1"));

children.push(h2("4.2  \u8DE8\u8D26\u53F7\u5185\u5BB9\u540C\u6B65\u7CFB\u7EDF"));
children.push(p("\u53C2\u8003\u591A\u5E73\u53F0\u793E\u4EA4\u5A92\u4F53\u7BA1\u7406\u5DE5\u5177\u7684\u8DE8\u5E73\u53F0\u5206\u53D1\u80FD\u529B\uff0C\u5B9E\u73B0\u667A\u80FD\u540C\u6B65\u3002"));

children.push(h3("4.2.1  \u540C\u6B65\u89E6\u53D1\u6761\u4EF6"));
children.push(p("\u5185\u5BB9\u5728\u67D0\u8D26\u53F7\u53D1\u5E03\u540E\uFF0C\u7CFB\u7EDF\u6301\u7EED\u76D1\u63A7\u8868\u73B0\uff0C\u89E6\u53D1\u81EA\u52A8\u540C\u6B65\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1400, 2600, 1800, 1426, 1800],
  rows: [
    new TableRow({ children: [hCell("\u89E6\u53D1\u7EA7\u522B",1400), hCell("\u6761\u4EF6",2600), hCell("\u540C\u6B65\u7B56\u7565",1800), hCell("\u8D26\u53F7\u6570\u91CF",1426), hCell("\u5185\u5BB9\u53D8\u5F02\u5EA6",1800)] }),
    new TableRow({ children: [
      dCell("T1/\u5FAE\u7206",1400,{bold:true,color:"FF6B00"}),
      dCell("\u4E92\u52A8\u7387>\u5E73\u5747\u503C2x\u4E14\u589E\u901F>50%/h",2600),
      dCell("\u539F\u6587\u76F4\u53D1(\u4FDD\u6301\u5185\u5BB9\u4E00\u81F4\u6027)",1800),
      dCell("3-5\u4E2A\u7CBE\u82F1\u8D26\u53F7",1426),
      dCell("\u7EC6\u5FAE\u8C03\u6574(10%)",1800)
    ]}),
    new TableRow({ children: [
      dCell("T2/\u70ED\u7206",1400,{bold:true,color:"E94560",fill:"F8F9FA"}),
      dCell("\u4E92\u52A8\u7387>\u5E73\u5747\u503C5x\u4E14\u6301\u7EED\u4E0A\u53472h+",2600,{fill:"F8F9FA"}),
      dCell("\u53D8\u4F53\u540C\u6B65(\u91CD\u65B0\u751F\u6210\u53D8\u4F53+\u4FDD\u7559\u6838\u5FC3\u7ED3\u6784)",1800,{fill:"F8F9FA"}),
      dCell("10-20\u4E2A\u8D26\u53F7",1426,{fill:"F8F9FA"}),
      dCell("\u4E2D\u5EA6\u8C03\u6574(30%)",1800,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("T3/\u8D85\u7EA7\u7206",1400,{bold:true,color:"1A1A2E"}),
      dCell("\u4E92\u52A8\u7387>\u5E73\u5747\u503C10x\u4E14\u6301\u7EED\u4E0A\u53476h+",2600),
      dCell("\u5168\u91CF\u53D8\u4F53\u540C\u6B65(\u751F\u6210\u5168\u65B0\u53D8\u4F53+\u8DE8\u5E73\u53F0\u8F6C\u6362)",1800),
      dCell("\u6240\u670950\u4E2A\u8D26\u53F7",1426),
      dCell("\u5927\u5E45\u8C03\u6574(60%)",1800)
    ]}),
  ]
}));

children.push(h3("4.2.2  \u5185\u5BB9\u8F6C\u6362\u5F15\u64CE"));
children.push(p("\u540C\u4E00\u7206\u6B3E\u5185\u5BB9\u81EA\u52A8\u8F6C\u6362\u4E3A\u4E0D\u540C\u5E73\u53F0\u683C\u5F0F\uFF1A"));
children.push(bullet("\u77ED\u89C6\u9891 \u2192 \u56FE\u6587\u5361\u7247: \u81EA\u52A8\u622A\u53D6\u5173\u952E\u5E27+\u63D0\u53D6\u5B57\u5E55\u6587\u6848+\u751F\u6210\u591A\u56FE\u5361\u7247\u7248", "b1"));
children.push(bullet("\u56FE\u6587 \u2192 \u77ED\u89C6\u9891: \u56FE\u7247\u8F6C\u89C6\u9891\u7247\u6BB5+\u6587\u6848\u8F6CTTS\u8BED\u97F3+\u52A0BGM\u5408\u6210", "b1"));
children.push(bullet("\u77ED\u89C6\u9891 \u2192 \u63A8\u6587\u7EBF\u7A0B: \u63D0\u53D6\u6838\u5FC3\u89C2\u70B9\u751F\u621010-15\u6761\u77ED\u63A8\u6587\uff0C\u5B9A\u65F6\u8F6E\u53D1", "b1"));
children.push(bullet("\u4E2D\u6587 \u2192 \u82F1\u6587: LLM\u6DF1\u5EA6\u7FFB\u8BD1+\u6587\u5316\u672C\u571F\u5316\u8C03\u6574\uff0C\u9762\u5411\u6D77\u5916\u5E73\u53F0", "b1"));

children.push(h2("4.3  \u5185\u5BB9\u65E5\u5386\u4E0E\u6392\u671F\u7BA1\u7406"));
children.push(p("\u667A\u80FD\u5185\u5BB9\u65E5\u5386\u7CFB\u7EDF\uFF0C\u81EA\u52A8\u89C4\u5212\u6240\u670950\u4E2A\u8D26\u53F7\u7684\u53D1\u5E03\u8BA1\u5212\u3002"));
children.push(bullet("\u6BCF\u65E5\u81EA\u52A8\u751F\u6210\u53D1\u5E03\u8BA1\u5212: \u6839\u636E\u70ED\u70B9\u6392\u5E8F+\u8D26\u53F7\u72B6\u6001\u5206\u914D\u5185\u5BB9", "b1"));
children.push(bullet("\u89C6\u89C9\u65E5\u5386\u754C\u9762: Gantt\u56FE\u5C55\u793A\u6BCF\u4E2A\u8D26\u53F7\u672A\u676572\u5C0F\u65F6\u53D1\u5E03\u8BA1\u5212\uFF0C\u62D6\u62FD\u8C03\u6574", "b1"));
children.push(bullet("\u667A\u80FD\u51B2\u7A81\u68C0\u6D4B: \u81EA\u52A8\u68C0\u6D4B\u540C\u4E00\u8D26\u53F7\u53D1\u5E03\u76F8\u4F3C\u5185\u5BB9\u7684\u65F6\u95F4\u95F4\u9694\uFF0C\u4E3B\u52A8\u8C03\u6574", "b1"));
children.push(bullet("\u5931\u8D25\u91CD\u8BD5: \u53D1\u5E03\u5931\u8D25\u81EA\u52A8\u91CD\u8BD53\u6B21\uff0C\u95F4\u9694\u9012\u589E(5min/15min/30min)\uFF0C\u5168\u90E8\u5931\u8D25\u5219\u544A\u8B66", "b1"));

// ============================================================
// CHAPTER 5: Full-chain Data Feedback
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u4E94\u7AE0  \u5168\u94FE\u8DEF\u6570\u636E\u53CD\u9988\u4E0E\u5206\u6790", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("5.1  \u5B9E\u65F6\u8868\u73B0\u8FFD\u8E2A\u7CFB\u7EDF"));
children.push(p("\u53C2\u8003 Content Analytics AI \u7684\u591A\u7EF4\u6307\u6807\u4F53\u7CFB\uFF0C\u5B9E\u73B0\u5168\u94FE\u8DEF\u6570\u636E\u91C7\u96C6\u4E0E\u5206\u6790\u3002"));

children.push(h3("5.1.1  \u91C7\u96C6\u6307\u6807\u77E9\u9635"));
children.push(p("\u6BCF\u4E2A\u53D1\u5E03\u5185\u5BB9\u6301\u7EED\u76D1\u63A7\u4EE5\u4E0B\u7EF4\u5EA6\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1300, 1800, 2200, 1726, 2000],
  rows: [
    new TableRow({ children: [hCell("\u6307\u6807\u7C7B\u522B",1300), hCell("\u5177\u4F53\u6307\u6807",1800), hCell("\u8BA1\u7B97\u65B9\u6CD5",2200), hCell("\u91C7\u96C6\u9891\u7387",1726), hCell("\u544A\u8B66\u89C4\u5219",2000)] }),
    new TableRow({ children: [
      dCell("\u6D41\u91CF\u6307\u6807",1300,{bold:true}),
      dCell("\u64AD\u653E\u91CF/\u9605\u8BFB\u91CF/\u5C55\u793A\u91CF",1800),
      dCell("\u5404\u5E73\u53F0API\u76F4\u63A5\u83B7\u53D6 + \u9875\u9762\u89E3\u6790\u5907\u4EFD",2200),
      dCell("\u6BCF5\u5206\u949F\u2192\u6BCF30\u5206\u949F\u2192\u6BCF4\u5C0F\u65F6(\u9010\u6B65\u964D\u9891)",1726),
      dCell("\u64AD\u653E\u91CF\u5C0F\u65F6\u589E\u901F>100% \u2192 S\u7EA7\u7206\u53D1\u544A\u8B66",2000)
    ]}),
    new TableRow({ children: [
      dCell("\u4E92\u52A8\u6307\u6807",1300,{bold:true,fill:"F8F9FA"}),
      dCell("\u70B9\u8D5E/\u8BC4\u8BBA/\u5206\u4EAB/\u4FDD\u5B58",1800,{fill:"F8F9FA"}),
      dCell("(Likes + Comments + Shares + Saves) / Views \u00D7 100%",2200,{fill:"F8F9FA"}),
      dCell("\u6BCF10\u5206\u949F(\u524D2h)\u2192\u6BCF1\u5C0F\u65F6(\u540E\u671F)",1726,{fill:"F8F9FA"}),
      dCell("\u4E92\u52A8\u7387>\u5E73\u57472x\u2192\u7F6E\u9876\u544A\u8B66\u6807\u8BB0",2000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u8F6C\u5316\u6307\u6807",1300,{bold:true}),
      dCell("\u70B9\u51FB\u94FE\u63A5/\u4E3B\u9875\u8BBF\u95EE/\u5173\u6CE8\u8F6C\u5316",1800),
      dCell("\u94FE\u63A5\u70B9\u51FB\u6570/\u5C55\u793A\u91CF\u00D7100% / \u65B0\u589E\u7C89\u4E1D/\u5C55\u793A\u91CF\u00D7100%",2200),
      dCell("\u6BCF30\u5206\u949F",1726),
      dCell("\u8F6C\u5316\u7387>\u57FA\u51C6\u503C2x\u2192\u81EA\u52A8\u589E\u52A0CTA\u5143\u7D20",2000)
    ]}),
    new TableRow({ children: [
      dCell("\u4FDD\u7559\u6307\u6807",1300,{bold:true,fill:"F8F9FA"}),
      dCell("\u5E73\u5747\u89C2\u770B\u65F6\u957F/\u5B8C\u64AD\u7387/\u8DF3\u51FA\u7387",1800,{fill:"F8F9FA"}),
      dCell("Avg View Duration / Video Length \u00D7 100%",2200,{fill:"F8F9FA"}),
      dCell("\u6BCF15\u5206\u949F(\u524D1h)\u2192\u6BCF2\u5C0F\u65F6(\u540E\u671F)",1726,{fill:"F8F9FA"}),
      dCell("\u5B8C\u64AD\u7387<30% \u2192 \u5185\u5BB9\u8D28\u91CF\u544A\u8B66\uFF0C\u8C03\u6574\u5F00\u5934Hook",2000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u589E\u957F\u6307\u6807",1300,{bold:true}),
      dCell("\u589E\u957F\u901F\u5EA6/\u52A0\u901F\u5EA6/\u8D8B\u52BF\u5F2F\u66F2\u70B9",1800),
      dCell("d(Engagement)/dt \u4E00\u9636+\u4E8C\u9636\u5BFC\u6570\u5206\u6790\uFF0CProphet\u65F6\u5E8F\u9884\u6D4B",2200),
      dCell("\u6BCF5\u5206\u949F\u8BA1\u7B97\u901F\u5EA6\u66F2\u7EBF",1726),
      dCell("\u4E8C\u9636\u5BFC\u6570\u8D77\u98DE\u70B9(accelerating)>0 \u2192 \u89E6\u53D1\u7206\u53D1\u76D1\u6D4B",2000)
    ]}),
    new TableRow({ children: [
      dCell("\u60C5\u611F\u6307\u6807",1300,{bold:true,fill:"F8F9FA"}),
      dCell("\u8BC4\u8BBA\u60C5\u611F\u5206\u5E03/\u8D1F\u9762\u7387/\u4E89\u8BAE\u5EA6",1800,{fill:"F8F9FA"}),
      dCell("VADER+TextBlob\u96C6\u6210\u6A21\u578B\uff0C\u4E09\u5206\u7C7B(Pos/Neu/Neg)",2200,{fill:"F8F9FA"}),
      dCell("\u6BCF30\u5206\u949F",1726,{fill:"F8F9FA"}),
      dCell("\u8D1F\u9762\u60C5\u611F>30% \u2192 \u8206\u60C5\u98CE\u9669\u544A\u8B66",2000,{fill:"F8F9FA"})
    ]}),
  ]
}));

children.push(h2("5.2  \u7206\u53D1\u4FE1\u53F7\u68C0\u6D4B\u5F15\u64CE (Viral Signal Detector)"));
children.push(p("\u53C2\u8003 Content Analytics AI \u7684\u75C5\u6BD2\u9884\u6D4B\u6A21\u578B\uFF0C\u5B9E\u73B0\u5B9E\u65F6\u7206\u53D1\u4FE1\u53F7\u68C0\u6D4B\u3002"));

children.push(h3("5.2.1  \u75C5\u6BD2\u9884\u6D4B\u6A21\u578B (Random Forest)"));
children.push(p("\u57FA\u4E8E15\u7EF4\u7279\u5F81\u7684\u968F\u673A\u68EE\u6797\u5206\u7C7B\u5668\uFF0C\u9884\u6D4B\u5185\u5BB9\u662F\u5426\u4F1A\u7206\u53D1\uFF1A"));
children.push(bullet("\u7279\u5F811-5 \u6807\u9898\u7EF4\u5EA6: \u6807\u9898\u957F\u5EA6/\u662F\u5426\u542B\u6570\u5B57/\u662F\u5426\u542Bemoji/\u662F\u5426\u542B\u7591\u95EE\u53E5/\u60C5\u611F\u5F3A\u5EA6\u8BCD\u6570", "b1"));
children.push(bullet("\u7279\u5F816-10 \u65F6\u5E8F\u7EF4\u5EA6: \u53D1\u5E03\u5C0F\u65F6/\u53D1\u5E03\u661F\u671F/\u662F\u5426\u5047\u65E5/\u8DDD\u4E0A\u6B21\u53D1\u5E03\u65F6\u95F4/\u5B63\u8282\u6027\u56E0\u5B50", "b1"));
children.push(bullet("\u7279\u5F8111-15 \u5185\u5BB9\u7EF4\u5EA6: \u5185\u5BB9\u65F6\u957F/\u7F29\u7565\u56FE\u8D28\u91CF\u8BC4\u5206/#\u6807\u7B7E\u6570\u91CF/\u4E0A\u4E00\u6761\u8868\u73B0/\u8D26\u53F7\u6743\u5A01\u5EA6\u8BC4\u5206", "b1"));

formula("Viral Score = RandomForest.predict([15 features])  \u2192  Probability \u2208 [0, 1]");
children.push(p(""));
children.push(bullet("\u9884\u6D4B\u51C6\u786E\u7387: 78.3% (ROC-AUC 0.84)", "b1"));
children.push(bullet("\u81EA\u52A8\u89E6\u53D1\u6D41\u7A0B: Viral Score > 0.7 \u2192 \u63D0\u524D\u5206\u914D\u66F4\u591A\u6D41\u91CF\u8D44\u6E90 \u2192 \u51C6\u5907\u53D8\u4F53\u5185\u5BB9 \u2192 \u901A\u77E5\u8FD0\u8425\u4EBA\u5458", "b1"));

children.push(h3("5.2.2  \u591A\u6A21\u5F0F\u7206\u53D1\u4FE1\u53F7\u878D\u5408"));
children.push(p("\u7ED3\u5408\u591A\u79CD\u4FE1\u53F7\u6E90\uFF0C\u63D0\u9AD8\u7206\u53D1\u68C0\u6D4B\u7684\u51C6\u786E\u7387\u548C\u53CA\u65F6\u6027\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1800, 2200, 2200, 1426, 1400],
  rows: [
    new TableRow({ children: [hCell("\u4FE1\u53F7\u6E90",1800), hCell("\u68C0\u6D4B\u65B9\u6CD5",2200), hCell("\u89E6\u53D1\u6761\u4EF6",2200), hCell("\u6743\u91CD",1426), hCell("\u54CD\u5E94\u7B56\u7565",1400)] }),
    new TableRow({ children: [
      dCell("ML\u9884\u6D4B\u4FE1\u53F7",1800,{bold:true}),
      dCell("Random Forest\u6A21\u578B\u5B9E\u65F6\u63A8\u7406",2200),
      dCell("Viral Score > 0.7 (78.3%\u51C6\u786E\u7387)",2200),
      dCell("0.35",1426,{center:true}),
      dCell("\u9884\u8B66\u7EA7\uff1A\u51C6\u5907\u53D8\u4F53\u5185\u5BB9",1400)
    ]}),
    new TableRow({ children: [
      dCell("\u6570\u636E\u7206\u53D1\u4FE1\u53F7",1800,{bold:true,fill:"F8F9FA"}),
      dCell("\u4E92\u52A8\u901F\u5EA6\u4E8C\u9636\u5BFC\u6570>0",2200,{fill:"F8F9FA"}),
      dCell("\u64AD\u653E\u91CF\u52A0\u901F\u5EA6\u8D77\u98DE + \u4E92\u52A8\u7387>\u5E73\u5747\u503C1.5x",2200,{fill:"F8F9FA"}),
      dCell("0.30",1426,{fill:"F8F9FA",center:true}),
      dCell("\u884C\u52A8\u7EA7\uff1A\u89E6\u53D1\u540C\u6B65\u6D41\u7A0B",1400,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u793E\u4EA4\u4FE1\u53F7",1800,{bold:true}),
      dCell("\u793E\u5A92\u5E73\u53F0\u70ED\u5EA6\u6307\u6570\u76D1\u63A7",2200),
      dCell("\u76F8\u5173#\u6807\u7B7E\u5F15\u7528\u91CF\u7A81\u589E + \u60C5\u611F\u503E\u5411\u8F6C\u6B63",2200),
      dCell("0.20",1426,{center:true}),
      dCell("\u8F85\u52A9\u7EA7\uff1A\u589E\u5F3A\u5206\u53D1\u6D41\u91CF",1400)
    ]}),
    new TableRow({ children: [
      dCell("\u7ADE\u54C1\u4FE1\u53F7",1800,{bold:true,fill:"F8F9FA"}),
      dCell("\u7ADE\u54C1\u76F8\u4F3C\u5185\u5BB9\u8868\u73B0\u5BF9\u6BD4",2200,{fill:"F8F9FA"}),
      dCell("\u7ADE\u54C1\u540C\u9898\u6750\u7206\u53D1 + \u6211\u65B9\u5C1A\u672A\u53D1\u5E03",2200,{fill:"F8F9FA"}),
      dCell("0.15",1426,{fill:"F8F9FA",center:true}),
      dCell("\u8FFD\u8D76\u7EA7\uff1A\u7ACB\u5373\u751F\u6210\u53D8\u4F53\u53D1\u5E03",1400,{fill:"F8F9FA"})
    ]}),
  ]
}));
children.push(p(""));
formula("Fusion Score = \u03A3 (Signal_i \u00D7 Weight_i)   \u2192  if > 0.6 \u2192 Auto-trigger sync pipeline");
children.push(p(""));
children.push(bullet("\u878D\u5408\u5F97\u5206 > 0.8: \u81EA\u52A8\u89E6\u53D1 T3\u8D85\u7EA7\u7206\u540C\u6B65\u6D41\u7A0B", "b1"));
children.push(bullet("\u878D\u5408\u5F97\u5206 > 0.6: \u81EA\u52A8\u89E6\u53D1 T2\u70ED\u7206\u540C\u6B65\u6D41\u7A0B", "b1"));
children.push(bullet("\u878D\u5408\u5F97\u5206 > 0.4: \u81EA\u52A8\u89E6\u53D1 T1\u5FAE\u7206\u540C\u6B65\u6D41\u7A0B", "b1"));
children.push(bullet("\u878D\u5408\u5F97\u5206 < 0.4: \u4EC5\u8BB0\u5F55\u89C2\u5BDF\uFF0C\u4E0D\u89E6\u53D1\u540C\u6B65", "b1"));

// ============================================================
// CHAPTER 6: Autonomous Decision Closed Loop
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u516D\u7AE0  \u81EA\u4E3B\u51B3\u7B56\u95ED\u73AF\u7CFB\u7EDF", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("6.1  \u95ED\u73AF\u7CFB\u7EDF\u67B6\u6784"));

children.push(p("\u53C2\u8003 RL-LLM-AB \u5F3A\u5316\u5B66\u4E60\u6846\u67B6\uFF0C\u8BBE\u8BA1\u5B8C\u6574\u7684\u5185\u5BB9\u81EA\u4E3B\u51B3\u7B56\u95ED\u73AF\u3002\u6838\u5FC3\u903B\u8F91\u5982\u4E0B\uff1A"));

children.push(p(""));
children.push(p("\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510", { font: "Consolas", size: 18, color: "E94560" }));
children.push(p("  \u8F93\u5165\u5173\u952E\u8BCD \u2192 \u70ED\u70B9\u6293\u53D6 \u2192 \u673A\u4F1A\u8BC4\u5206 \u2192 \u5185\u5BB9\u751F\u6210 \u2192 \u53D1\u5E03\u6267\u884C", { font: "Consolas", size: 18, color: "333333", bold: true }));
children.push(p("     \u2191                                                    \u2193", { font: "Consolas", size: 18, color: "E94560" }));
children.push(p("  \u7B56\u7565\u4F18\u5316 \u2190 \u8FDB\u5316\u5F15\u64CE \u2190 \u6A21\u5F0F\u5B66\u4E60 \u2190 \u6570\u636E\u53CD\u9988 \u2190 \u8868\u73B0\u8FFD\u8E2A", { font: "Consolas", size: 18, color: "333333", bold: true }));
children.push(p("     \u2191                                                    \u2193", { font: "Consolas", size: 18, color: "E94560" }));
children.push(p("  \u2502  \u7206\u53D1\u4FE1\u53F7\u68C0\u6D4B \u2192 \u53D8\u4F53\u81EA\u52A8\u751F\u6210 \u2192 \u8DE8\u8D26\u53F7\u540C\u6B65 \u2192 \u53D1\u5E03\u6267\u884C \u2192 \u8868\u73B0\u8FFD\u8E2A \u2502", { font: "Consolas", size: 18, color: "333333", bold: true }));
children.push(p("  \u2502                                                    \u2193", { font: "Consolas", size: 18, color: "E94560" }));
children.push(p("  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u81EA\u4E3B\u51B3\u7B56\u5F15\u64CE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518", { font: "Consolas", size: 18, color: "E94560" }));
children.push(p(""));

children.push(h2("6.2  \u81EA\u4E3B\u51B3\u7B56\u5F15\u64CE (Autonomous Decision Engine)"));
children.push(p("\u6838\u5FC3\u7EC4\u4EF6\u5305\u62EC\u4EE5\u4E0B5\u4E2A\u5B50\u6A21\u5757\uFF1A"));

children.push(h3("6.2.1  \u51B3\u7B56\u72B6\u6001\u673A (Decision State Machine)"));
children.push(bullet("IDLE \u2192 MONITORING: \u5185\u5BB9\u53D1\u5E03\u540E\u8FDB\u5165\u76D1\u63A7\u72B6\u6001\uff0C\u6301\u7EED\u91C7\u96C6\u6570\u636E", "b1"));
children.push(bullet("MONITORING \u2192 VIRAL_DETECTED: \u7206\u53D1\u4FE1\u53F7\u89E6\u53D1\uFF0C\u8FDB\u5165\u5FEB\u901F\u54CD\u5E94\u72B6\u6001", "b1"));
children.push(bullet("VIRAL_DETECTED \u2192 CLONING: \u81EA\u52A8\u751F\u6210\u53D8\u4F53\u5185\u5BB9", "b1"));
children.push(bullet("CLONING \u2192 SYNCING: \u8DE8\u8D26\u53F7\u540C\u6B65\u53D1\u5E03", "b1"));
children.push(bullet("SYNCING \u2192 LEARNING: \u6536\u96C6\u7ED3\u679C\uFF0C\u66F4\u65B0\u7B56\u7565\u6A21\u578B", "b1"));
children.push(bullet("ANY \u2192 COOLDOWN: \u89E6\u53D1\u9891\u7387\u8FC7\u9AD8\u65F6\u8FDB\u5165\u51B7\u5374\u72B6\u6001\uff0C\u907F\u514D\u88AB\u5E73\u53F0\u9650\u6D41", "b1"));
children.push(bullet("ANY \u2192 PAUSED: \u8D1F\u9762\u60C5\u611F>\u9608\u503C\u6216\u624B\u52A8\u6682\u505C\uff0C\u7ACB\u5373\u505C\u6B62\u6240\u6709\u81EA\u52A8\u64CD\u4F5C", "b1"));

children.push(h3("6.2.2  \u81EA\u52A8\u514B\u9686\u4E0E\u653E\u5927\u5F15\u64CE (Auto-Clone & Amplify)"));
children.push(p("\u5F53\u68C0\u6D4B\u5230\u5185\u5BB9\u8868\u73B0\u4E0A\u5347\u65F6\uFF0C\u81EA\u52A8\u6267\u884C\u4EE5\u4E0B\u64CD\u4F5C\uFF1A"));
children.push(bullet("\u6B65\u9AA41 \u2502 \u63D0\u53D6\u7206\u6B3E\u5185\u5BB9\u7684\u201CDNA\u201D\uff1A\u8BC6\u522B\u6210\u529F\u56E0\u7D20\uff08\u6807\u9898\u98CE\u683C/\u5F00\u5934Hook/\u89C6\u89C9\u98CE\u683C/\u97F3\u4E50/\u65F6\u957F/\u8282\u594F\uff09", "b1"));
children.push(bullet("\u6B65\u9AA42 \u2502 \u4FDD\u6301\u6210\u529F\u56E0\u7D20+\u66FF\u6362\u53EF\u53D8\u56E0\u7D20\uff1A\u751F\u62105-20\u4E2A\u53D8\u4F53\u5185\u5BB9", "b1"));
children.push(bullet("\u6B65\u9AA43 \u2502 \u53D8\u4F53\u8D28\u91CF\u6821\u9A8C\uff1AJaccard\u53BB\u91CD+\u60C5\u611F\u4E00\u81F4\u6027+\u8D28\u91CF\u8BC4\u5206\u22650.7", "b1"));
children.push(bullet("\u6B65\u9AA44 \u2502 \u5206\u6279\u53D1\u5E03\uff1A\u6BCF\u62795-10\u4E2A\u53D8\u4F53\uFF0C\u9519\u5F00\u65F6\u95F4\u7A97\u53E3\uff0C\u907F\u514D\u5E73\u53F0\u9650\u6D41", "b1"));
children.push(bullet("\u6B65\u9AA45 \u2502 \u8FFD\u8E2A\u53D8\u4F53\u8868\u73B0\uff1A\u6301\u7EED\u76D1\u63A7\u6BCF\u4E2A\u53D8\u4F53\uff0C\u6807\u8BB0\u8868\u73B0\u6700\u4F18\u7684\u53D8\u4F53\u4E3A\u65B0\u57FA\u7EBF", "b1"));

children.push(h3("6.2.3  \u5F3A\u5316\u5B66\u4E60\u7B56\u7565\u4F18\u5316 (RL Strategy Optimization)"));
children.push(p("\u53C2\u8003 RL-LLM-AB \u6846\u67B6\uFF0C\u5B9E\u73B0\u5185\u5BB9\u7B56\u7565\u7684\u81EA\u52A8\u4F18\u5316\uFF1A"));
children.push(bullet("\u72B6\u6001\u7A7A\u95F4: \u5185\u5BB9DNA\u5411\u91CF(15\u7EF4) + \u5E73\u53F0\u7C7B\u578B + \u53D1\u5E03\u65F6\u95F4\u7A97\u53E3 + \u8D26\u53F7\u5065\u5EB7\u5EA6", "b1"));
children.push(bullet("\u52A8\u4F5C\u7A7A\u95F4: \u9009\u62E9\u53D8\u5F02\u5E45\u5EA6/\u9009\u62E9\u540C\u6B65\u7B56\u7565/\u9009\u62E9\u53D1\u5E03\u65F6\u95F4/\u9009\u62E9\u8D26\u53F7\u5206\u914D", "b1"));
children.push(bullet("\u5956\u52B1\u51FD\u6570: R = w1\u00D7Engagement_Rate + w2\u00D7Conversion_Rate + w3\u00D7Growth_Rate - w4\u00D7Risk_Penalty", "b1"));
children.push(bullet("\u7B56\u7565: Thompson Sampling(\u63A2\u7D22vs\u5F00\u53D1\u5E73\u8861) + Epsilon-Greedy(5%\u968F\u673A\u63A2\u7D22)", "b1"));

formula("Q(s,a) \u2190 Q(s,a) + \u03B1[R + \u03B3\u00D7max Q(s',a') - Q(s,a)]");
children.push(p(""));

children.push(h2("6.3  \u98CE\u63A7\u4E0E\u5B89\u5168\u95ED\u73AF"));
children.push(p("\u81EA\u4E3B\u51B3\u7B56\u5FC5\u987B\u914D\u5957\u5B89\u5168\u673A\u5236\uFF0C\u907F\u514D\u8FC7\u5EA6\u81EA\u52A8\u5316\u5BFC\u81F4\u5C01\u53F7\uFF1A"));
children.push(bullet("\u9891\u7387\u9650\u5236: \u5355\u8D26\u53F7\u6BCF\u5929\u81EA\u52A8\u53D1\u5E03\u22645\u6761\uff0C\u540C\u6B65\u89E6\u53D1\u95F4\u9694\u226530\u5206\u949F", "b1"));
children.push(bullet("\u5F02\u5E38\u68C0\u6D4B: \u5E73\u53F0\u8B66\u544A/\u9650\u6D41/\u5220\u5E16\u81EA\u52A8\u89E6\u53D1\u6682\u505C\uFF0C\u5207\u6362\u5230\u624B\u52A8\u5BA1\u6838\u6A21\u5F0F", "b1"));
children.push(bullet("\u5185\u5BB9\u5408\u89C4: NLP\u81EA\u52A8\u68C0\u6D4B\u8FDD\u89C4\u8BCD/\u654F\u611F\u8BDD\u9898\uFF0C\u9884\u5148\u8FC7\u6EE4\u518D\u53D1\u5E03", "b1"));
children.push(bullet("\u8D26\u53F7\u5065\u5EB7\u5EA6\u8BC4\u5206: \u7EFC\u5408\u9650\u6D41/\u8B66\u544A/\u5220\u5E16\u5386\u53F2\uFF0C\u8BC4\u5206<0.5\u81EA\u52A8\u964D\u4F4E\u53D1\u5E03\u9891\u7387", "b1"));
children.push(bullet("\u4EBA\u5DE5\u8986\u76D6: \u6240\u6709\u81EA\u52A8\u51B3\u7B56\u8BB0\u5F55\u5230\u65E5\u5FD7\uff0C\u652F\u6301\u4E00\u952E\u56DE\u6EDA\u548C\u4EBA\u5DE5\u4ECB\u5165\u4E2D\u65AD", "b1"));

// ============================================================
// CHAPTER 7: Self-evolving System
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u4E03\u7AE0  \u81EA\u8FDB\u5316\u5185\u5BB9\u7CFB\u7EDF", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("7.1  \u5185\u5BB9DNA\u8FDB\u5316\u673A\u5236"));
children.push(p("\u6BCF\u4E2A\u7206\u6B3E\u5185\u5BB9\u7684DNA\u4F1A\u88AB\u8BB0\u5F55\u3001\u5206\u6790\u3001\u8FDB\u5316\uff0C\u5F62\u6210\u4E00\u4E2A\u81EA\u6211\u4F18\u5316\u7684\u5185\u5BB9\u57FA\u56E0\u5E93\u3002"));

children.push(h3("7.1.1  \u8FDB\u5316\u6570\u636E\u6D41"));
children.push(bullet("\u539F\u59CB\u5185\u5BB9\u53D1\u5E03 \u2192 \u8868\u73B0\u6570\u636E\u91C7\u96C6 \u2192 \u6210\u529F\u56E0\u7D20\u63D0\u53D6 \u2192 DNA\u8FDB\u5316\u66F4\u65B0 \u2192 \u4E0B\u4E00\u8F6E\u5185\u5BB9\u751F\u6210\u4F18\u5316", "b1"));
children.push(bullet("\u6BCF\u6B21\u7206\u6B3E\u4E8B\u4EF6\u540E\uFF0C\u7CFB\u7EDF\u81EA\u52A8\u66F4\u65B0\u6210\u529F\u6A21\u5F0F\u5E93\u548C\u5931\u8D25\u6A21\u5F0F\u5E93", "b1"));
children.push(bullet("DNA\u7A81\u53D8\u7387: 5%\u6982\u7387\u5F15\u5165\u968F\u673A\u53D8\u5F02\uFF0C\u63A2\u7D22\u65B0\u7684\u5185\u5BB9\u53EF\u80FD\u6027", "b1"));

children.push(h2("7.2  \u81EA\u9002\u5E94\u5B66\u4E60\u5F15\u64CE"));
children.push(p("\u7CFB\u7EDF\u4ECE\u5386\u53F2\u6570\u636E\u4E2D\u6301\u7EED\u5B66\u4E60\uFF0C\u4F18\u5316\u4E94\u4E2A\u6838\u5FC3\u7EF4\u5EA6\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1400, 2200, 2600, 1426, 1400],
  rows: [
    new TableRow({ children: [hCell("\u5B66\u4E60\u7EF4\u5EA6",1400), hCell("\u8F93\u5165\u6570\u636E",2200), hCell("\u4F18\u5316\u76EE\u6807",2600), hCell("\u66F4\u65B0\u9891\u7387",1426), hCell("\u5B66\u4E60\u65B9\u6CD5",1400)] }),
    new TableRow({ children: [
      dCell("\u5185\u5BB9\u98CE\u683C",1400,{bold:true}),
      dCell("\u5386\u53F2\u7206\u6B3E\u5185\u5BB9\u7684DNA\u5411\u91CF",2200),
      dCell("\u63D0\u9AD8\u75C5\u6BD2\u9884\u6D4B\u51C6\u786E\u7387",2600),
      dCell("\u6BCF\u5468\u91CD\u65B0\u8BAD\u7EC3",1426),
      dCell("Random Forest\u589E\u91CF\u5B66\u4E60",1400)
    ]}),
    new TableRow({ children: [
      dCell("\u53D1\u5E03\u65F6\u5E8F",1400,{bold:true,fill:"F8F9FA"}),
      dCell("\u5404\u65F6\u95F4\u7A97\u53E3\u7684\u5E73\u5747\u4E92\u52A8\u7387",2200,{fill:"F8F9FA"}),
      dCell("\u4F18\u5316\u81EA\u52A8\u53D1\u5E03\u65F6\u95F4\u9009\u62E9",2600,{fill:"F8F9FA"}),
      dCell("\u6BCF\u5929\u66F4\u65B0",1426,{fill:"F8F9FA"}),
      dCell("Prophet\u65F6\u5E8F\u6A21\u578B",1400,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u53D8\u5F02\u7B56\u7565",1400,{bold:true}),
      dCell("A/B\u6D4B\u8BD5\u7ED3\u679C + \u53D8\u4F53\u8868\u73B0\u6570\u636E",2200),
      dCell("\u4F18\u5316\u53D8\u5F02\u5E45\u5EA6\u548C\u53D8\u4F53\u6570\u91CF",2600),
      dCell("\u6BCF\u6B21A/B\u6D4B\u8BD5\u540E\u66F4\u65B0",1426),
      dCell("Thompson Sampling RL",1400)
    ]}),
    new TableRow({ children: [
      dCell("\u540C\u6B65\u7B56\u7565",1400,{bold:true,fill:"F8F9FA"}),
      dCell("\u8DE8\u8D26\u53F7\u540C\u6B65\u7684\u6548\u679C\u6570\u636E",2200,{fill:"F8F9FA"}),
      dCell("\u4F18\u5316\u540C\u6B65\u89E6\u53D1\u6761\u4EF6\u548C\u53D8\u5F02\u5E45\u5EA6",2600,{fill:"F8F9FA"}),
      dCell("\u6BCF100\u6B21\u540C\u6B65\u4E8B\u4EF6\u540E\u66F4\u65B0",1426,{fill:"F8F9FA"}),
      dCell("\u667A\u80FD\u56DE\u8C03\u53C2\u6570",1400,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("\u5E73\u53F0\u7B97\u6CD5",1400,{bold:true}),
      dCell("\u5404\u5E73\u53F0\u6D41\u91CF\u5206\u914D\u6A21\u5F0F\u53D8\u5316",2200),
      dCell("\u81EA\u9002\u5E94\u5E73\u53F0\u7B97\u6CD5\u66F4\u65B0",2600),
      dCell("\u6BCF\u6708\u91CD\u65B0\u8BC4\u4F30",1426),
      dCell("\u8D8B\u52BF\u68C0\u6D4B+\u624B\u52A8\u6821\u51C6",1400)
    ]}),
  ]
}));

children.push(h2("7.3  \u8FDB\u5316\u4E0E\u8FED\u4EE3\u7B56\u7565\u5E93"));
children.push(p("\u7CFB\u7EDF\u81EA\u52A8\u7D2F\u79EF\u548C\u7BA1\u7406\u5185\u5BB9\u7B56\u7565\uff0C\u5F62\u6210\u53EF\u590D\u7528\u7684\u77E5\u8BC6\u5E93\uFF1A"));
children.push(bullet("\u6210\u529F\u6A21\u5F0F\u5E93: \u5F52\u6863\u5386\u53F2\u7206\u6B3E\u5185\u5BB9\u7684DNA+\u8868\u73B0\u6570\u636E\uff0C\u53EF\u76F4\u63A5\u590D\u7528\u6216\u53C2\u8003", "b1"));
children.push(bullet("\u5931\u8D25\u6A21\u5F0F\u5E93: \u8BB0\u5F55\u8868\u73B0\u4E0D\u4F73\u7684\u5185\u5BB9\u6A21\u5F0F\uff0C\u81EA\u52A8\u56DE\u907F\u7C7B\u4F3C\u5185\u5BB9", "b1"));
children.push(bullet("\u5E73\u53F0\u7B56\u7565\u5E93: \u6BCF\u4E2A\u5E73\u53F0\u7684\u6700\u4F18\u5185\u5BB9\u7B56\u7565\uFF0C\u968F\u7B97\u6CD5\u53D8\u5316\u81EA\u52A8\u66F4\u65B0", "b1"));
children.push(bullet("\u8D26\u53F7\u4EBA\u8BBE\u5E93: \u6BCF\u4E2A\u8D26\u53F7\u7684\u5185\u5BB9\u504F\u597D\u548C\u6210\u529F\u6A21\u5F0F\uff0C\u4E2A\u6027\u5316\u751F\u6210", "b1"));
children.push(bullet("\u53D8\u5F02\u53C2\u6570\u5E93: \u5404\u79CD\u53D8\u5F02\u7B56\u7565\u7684\u6548\u679C\u8BC4\u4F30\uff0C\u6307\u5BFC\u672A\u6765\u53D8\u5F02\u8BBE\u8BA1", "b1"));

children.push(h2("7.4  \u81EA\u6211\u53CD\u601D\u4E0E\u6821\u6B63"));
children.push(p("\u53C2\u8003 Self-Evolving Agent \u7684\u81EA\u6211\u53CD\u601D\u673A\u5236\uff1A"));
children.push(bullet("\u6BCF\u5929\u81EA\u52A8\u751F\u6210\u201C\u5185\u5BB9\u8868\u73B0\u65E5\u62A5\u201D\uff1A\u5206\u6790\u672C\u65E5\u8868\u73B0\u6700\u4F73/\u6700\u5DEE\u5185\u5BB9\uFF0C\u63D0\u53D6\u5173\u952E\u56E0\u7D20", "b1"));
children.push(bullet("\u6BCF\u5468\u81EA\u52A8\u751F\u6210\u201C\u7B56\u7565\u4F18\u5316\u5EFA\u8BAE\u201D\uff1A\u57FA\u4E8E\u672C\u5468\u6570\u636E\u63D0\u51FA\u53D8\u5F02\u7B56\u7565\u8C03\u6574\u5EFA\u8BAE", "b1"));
children.push(bullet("\u8D26\u53F7\u8868\u73B0\u8D8B\u52BF\u9884\u8B66: \u5F53\u67D0\u8D26\u53F7\u8868\u73B0\u6301\u7EED\u4E0B\u964D\u65F6\uFF0C\u81EA\u52A8\u5207\u6362\u5185\u5BB9\u7B56\u7565\u5E76\u544A\u8B66", "b1"));
children.push(bullet("\u8DE8\u5E73\u53F0\u5B66\u4E60\u8FC1\u79FB: \u5C06\u4E00\u4E2A\u5E73\u53F0\u7684\u6210\u529F\u7B56\u7565\u81EA\u52A8\u8FC1\u79FB\u5230\u53E6\u4E00\u5E73\u53F0\uff0C\u505A\u672C\u571F\u5316\u8C03\u6574", "b1"));

// ============================================================
// CHAPTER 8: Data Sync & Architecture
// ============================================================
children.push(new PageBreak());
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 240 },
  children: [new TextRun({ text: "\u7B2C\u516B\u7AE0  \u6570\u636E\u540C\u6B65\u4E0E\u7CFB\u7EDF\u67B6\u6784", font: "Microsoft YaHei", size: 32, bold: true, color: "1A1A2E" })] }));

children.push(h2("8.1  \u7CFB\u7EDF\u6574\u4F53\u67B6\u6784"));

children.push(p("\u4EE5\u4E0B\u662F\u5B8C\u6574\u7684\u7CFB\u7EDF\u67B6\u6784\u56FE\uff0C\u5C55\u793A\u5404\u6A21\u5757\u4E4B\u95F4\u7684\u6570\u636E\u6D41\u548C\u4F9D\u8D56\u5173\u7CFB\uFF1A"));

children.push(p(""));
children.push(p("\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502                    PyQt6 UI Layer (\u4E94\u5927Tab+\u63A7\u5236\u9762\u677F+\u65E5\u5FD7)                   \u2502", { font: "Consolas", size: 16, color: "333333" }));
children.push(p("  \u2502                           \u2195 pyqtSignal/\u4E8B\u4EF6\u603B\u7EBF                           \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u2502 \u5185\u5BB9\u60C5\u62A5\u5F15\u64CE \u2502 \u5185\u5BB9\u8BBE\u8BA1\u89C4\u5219 \u2502  AI\u5185\u5BB9\u5DE5\u5382  \u2502 \u667A\u80FD\u53D1\u5E03\u7CFB\u7EDF \u2502 \u2502", { font: "Consolas", size: 16, color: "333333", bold: true }));
children.push(p("  \u2502  \u2502 \u00B7\u70ED\u70B9\u6293\u53D6  \u2502 \u00B7\u7B56\u7565\u77E9\u9635  \u2502 \u00B7\u4E94\u5C42\u6539\u5199  \u2502 \u00B7\u53D1\u5E03\u51B3\u7B56  \u2502 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u2502 \u00B7\u673A\u4F1A\u6316\u6398  \u2502 \u00B7\u5185\u5BB9DNA  \u2502 \u00B7\u77ED\u89C6\u9891\u6D41\u6C34\u7EBF\u2502 \u00B7\u8DE8\u8D26\u53F7\u540C\u6B65  \u2502 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502                           \u2195 \u6570\u636E\u64CD\u4F5C\u5C42                           \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  \u2502 SQLite\u6301\u4E45\u5316 | \u5185\u5B58\u7F13\u5B58(LRU) | \u914D\u7F6E\u4E2D\u5FC3(JSON) | \u65E5\u5FD7\u7CFB\u7EDF \u2502 \u2502", { font: "Consolas", size: 16, color: "333333" }));
children.push(p("  \u2502  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518 \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502                           \u2195\u5916\u90E8\u670D\u52A1\u5C42                           \u2502", { font: "Consolas", size: 16, color: "808080" }));
children.push(p("  \u2502  LLM API(GPT/Qwen/DeepSeek) | ComfyUI\u5DE5\u4F5C\u6D41 | TTS\u5F15\u64CE | \u793E\u5A92API \u2502", { font: "Consolas", size: 16, color: "333333" }));
children.push(p("  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518", { font: "Consolas", size: 16, color: "808080" }));
children.push(p(""));

// 8.2 Data model
children.push(h2("8.2  \u6838\u5FC3\u6570\u636E\u6A21\u578B\u8BBE\u8BA1"));
children.push(p("\u65B0\u589E\u4EE5\u4E0B\u6570\u636E\u8868\u652F\u6301AI\u5185\u5BB9\u667A\u80FD\u7CFB\u7EDF\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1600, 1800, 2000, 1826, 1800],
  rows: [
    new TableRow({ children: [hCell("\u8868\u540D",1600), hCell("\u7528\u9014",1800), hCell("\u6838\u5FC3\u5B57\u6BB5",2000), hCell("\u5199\u5165\u9891\u7387",1826), hCell("\u6570\u636E\u91CF\u9884\u4F30",1800)] }),
    new TableRow({ children: [
      dCell("hot_topics",1600,{bold:true}),
      dCell("\u70ED\u70B9\u8BDD\u9898\u5E93",1800),
      dCell("topic_id/platform/keyword/hot_score/sentiment/detected_at",2000),
      dCell("\u5B9E\u65F6\u6D41\u5F0F\u5199\u5165",1826),
      dCell("~1000\u6761/\u5929",1800)
    ]}),
    new TableRow({ children: [
      dCell("content_variants",1600,{bold:true,fill:"F8F9FA"}),
      dCell("\u5185\u5BB9\u53D8\u4F53\u5E93",1800,{fill:"F8F9FA"}),
      dCell("variant_id/topic_id/dna_vector/jaccard_score/quality_score",2000,{fill:"F8F9FA"}),
      dCell("\u6BCF\u6B21\u751F\u6210\u65F6\u5199\u5165",1826,{fill:"F8F9FA"}),
      dCell("~500\u6761/\u5929",1800,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("publish_logs",1600,{bold:true}),
      dCell("\u53D1\u5E03\u65E5\u5FD7",1800),
      dCell("log_id/device_id/platform/content_hash/publish_time/status",2000),
      dCell("\u6BCF\u6B21\u53D1\u5E03\u5199\u5165",1826),
      dCell("~200\u6761/\u5929",1800)
    ]}),
    new TableRow({ children: [
      dCell("performance_metrics",1600,{bold:true,fill:"F8F9FA"}),
      dCell("\u8868\u73B0\u6307\u6807",1800,{fill:"F8F9FA"}),
      dCell("metric_id/content_id/views/likes/comments/shares/engagement_rate/timestamp",2000,{fill:"F8F9FA"}),
      dCell("\u5B9A\u65F6\u91C7\u96C6(5-30\u5206\u949F)",1826,{fill:"F8F9FA"}),
      dCell("~5000\u6761/\u5929",1800,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("viral_signals",1600,{bold:true}),
      dCell("\u7206\u53D1\u4FE1\u53F7\u8BB0\u5F55",1800),
      dCell("signal_id/content_id/viral_score/fusion_score/trigger_level/sync_action",2000),
      dCell("\u4E8B\u4EF6\u9A71\u52A8\u5199\u5165",1826),
      dCell("~50\u6761/\u5929",1800)
    ]}),
    new TableRow({ children: [
      dCell("sync_events",1600,{bold:true,fill:"F8F9FA"}),
      dCell("\u540C\u6B65\u4E8B\u4EF6\u8BB0\u5F55",1800,{fill:"F8F9FA"}),
      dCell("event_id/source_content_id/target_device_ids/sync_level/variation_pct",2000,{fill:"F8F9FA"}),
      dCell("\u6BCF\u6B21\u540C\u6B65\u5199\u5165",1826,{fill:"F8F9FA"}),
      dCell("~30\u6761/\u5929",1800,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("strategy_evolution",1600,{bold:true}),
      dCell("\u7B56\u7565\u8FDB\u5316\u5E93",1800),
      dCell("evolution_id/content_dna/success_score/fail_count/last_updated/version",2000),
      dCell("\u6BCF\u5468\u66F4\u65B0",1826),
      dCell("~200\u6761\u603B\u91CF",1800)
    ]}),
  ]
}));

// 8.3 Data flow
children.push(h2("8.3  \u6570\u636E\u540C\u6B65\u6D41\u7A0B\u56FE"));
children.push(p("\u5B8C\u6574\u7684\u6570\u636E\u6D41\u8F6C\u903B\u8F91\uFF1A"));
children.push(bullet("\u70ED\u70B9\u91C7\u96C6\u5C42: \u591A\u6E90API \u2192 \u6D88\u606F\u961F\u5217 \u2192 \u6570\u636E\u6E05\u6D17 \u2192 hot_topics\u8868", "b1"));
children.push(bullet("\u5185\u5BB9\u751F\u6210\u5C42: hot_topics \u2192 \u673A\u4F1A\u8BC4\u5206 \u2192 \u89E6\u53D1\u751F\u6210 \u2192 content_variants\u8868", "b1"));
children.push(bullet("\u53D1\u5E03\u6267\u884C\u5C42: content_variants \u2192 \u53D1\u5E03\u51B3\u7B56 \u2192 ADB\u6267\u884C \u2192 publish_logs\u8868", "b1"));
children.push(bullet("\u6570\u636E\u53CD\u9988\u5C42: publish_logs \u2192 \u5B9A\u65F6\u91C7\u96C6 \u2192 performance_metrics\u8868 \u2192 \u7206\u53D1\u68C0\u6D4B", "b1"));
children.push(bullet("\u51B3\u7B56\u95ED\u73AF\u5C42: viral_signals \u2192 \u81EA\u52A8\u514B\u9686 \u2192 sync_events \u2192 \u7B56\u7565\u66F4\u65B0 \u2192 strategy_evolution\u8868", "b1"));
children.push(bullet("\u7F13\u5B58\u52A0\u901F\u5C42: \u5185\u5B58LRU\u7F13\u5B58\u70ED\u70B9\u6570\u636E(5min TTL) + Redis\u7F13\u5B58\u8868\u73B0\u6307\u6807(1min TTL)", "b1"));

// 8.4 Development roadmap
children.push(new PageBreak());
children.push(h2("8.4  \u5F00\u53D1\u8DEF\u7EBF\u56FE"));
children.push(p("\u5EFA\u8BAE\u5206\u56DB\u4E2A\u9636\u6BB5\u8FED\u4EE3\u5F00\u53D1\uFF1A"));

children.push(new Table({
  width: { size: tblW, type: WidthType.DXA },
  columnWidths: [1000, 2200, 1600, 2226, 2000],
  rows: [
    new TableRow({ children: [hCell("\u9636\u6BB5",1000), hCell("\u5185\u5BB9",2200), hCell("\u6838\u5FC3\u529F\u80FD",1600), hCell("\u5173\u952E\u4EA4\u4ED8\u7269",2226), hCell("\u5DE5\u65F6\u4F30\u7B97",2000)] }),
    new TableRow({ children: [
      dCell("P1",1000,{bold:true}),
      dCell("\u70ED\u70B9\u60C5\u62A5\u5F15\u64CE +\u5185\u5BB9\u8BBE\u8BA1\u89C4\u5219",2200),
      dCell("\u70ED\u70B9\u6293\u53D6+\u5185\u5BB9DNA",1600),
      dCell("hot_topics\u8868+content_variants\u8868+5\u5C42\u6539\u5199\u5F15\u64CE+Jaccard\u53BB\u91CD",2226),
      dCell("3-5\u5929",2000)
    ]}),
    new TableRow({ children: [
      dCell("P2",1000,{bold:true,fill:"F8F9FA"}),
      dCell("AI\u5185\u5BB9\u5DE5\u5382+\u667A\u80FD\u53D1\u5E03",2200,{fill:"F8F9FA"}),
      dCell("\u77ED\u89C6\u9891\u6D41\u6C34\u7EBF+\u8DE8\u8D26\u53F7\u540C\u6B65",1600,{fill:"F8F9FA"}),
      dCell("ComfyUI\u96C6\u6210+publish_logs\u8868+\u540C\u6B65\u89E6\u53D1\u5F15\u64CE+sync_events\u8868",2226,{fill:"F8F9FA"}),
      dCell("5-7\u5929",2000,{fill:"F8F9FA"})
    ]}),
    new TableRow({ children: [
      dCell("P3",1000,{bold:true}),
      dCell("\u5168\u94FE\u8DEF\u6570\u636E\u53CD\u9988+\u81EA\u4E3B\u51B3\u7B56\u95ED\u73AF",2200),
      dCell("\u7206\u53D1\u68C0\u6D4B+\u81EA\u52A8\u514B\u9686+RL\u4F18\u5316",1600),
      dCell("performance_metrics\u8868+viral_signals\u8868+Random Forest\u6A21\u578B+RL\u5F15\u64CE",2226),
      dCell("5-7\u5929",2000)
    ]}),
    new TableRow({ children: [
      dCell("P4",1000,{bold:true,fill:"F8F9FA"}),
      dCell("\u81EA\u8FDB\u5316\u7CFB\u7EDF+\u89C6\u89C9\u5316\u4EEA\u8868\u76D8",2200,{fill:"F8F9FA"}),
      dCell("\u5185\u5BB9\u8FDB\u5316+\u7B56\u7565\u5E93+\u4EEA\u8868\u76D8",1600,{fill:"F8F9FA"}),
      dCell("strategy_evolution\u8868+5\u5927\u7B56\u7565\u5E93+\u65E5/\u5468\u62A5\u544A+\u5B9E\u65F6\u4EEA\u8868\u76D8",2226,{fill:"F8F9FA"}),
      dCell("5-7\u5929",2000,{fill:"F8F9FA"})
    ]}),
  ]
}));
children.push(p(""));
children.push(p("\u603B\u8BA1\u5DE5\u65F6: 18-26\u5929", { font: "Microsoft YaHei", size: 20, bold: true, color: "E94560" }));

// Closing
children.push(new PageBreak());
children.push(new Paragraph({ spacing: { before: 4800 }, children: [] }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  border: { top: { style: BorderStyle.SINGLE, size: 6, color: "E94560", space: 8 } },
  children: [new TextRun({ text: "\u2014 END \u2014", font: "Microsoft YaHei", size: 32, bold: true, color: "E94560" })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 120 },
  children: [new TextRun({ text: "\u672C\u6587\u6863\u57FA\u4E8E\u4EE5\u4E0B\u5F00\u6E90\u9879\u76EE\u7814\u7A76\u7F16\u5199\uFF1A", font: "Microsoft YaHei", size: 18, color: "808080" })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({ text: "TrendSentinel | Content Analytics AI | Pixelle-Video | RL-LLM-AB Framework | Self-Evolving Agents", font: "Microsoft YaHei", size: 16, color: "999999", italics: true })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({ text: "MSCMS v14 AI\u667A\u80FD\u5185\u5BB9\u4E0E\u81EA\u4E3B\u8FDB\u5316\u5F15\u6D41\u7CFB\u7EDF \u00B7 \u4F18\u5316\u65B9\u6848 v2.0 \u00B7 2026\u5E7407\u670803\u65E5", font: "Microsoft YaHei", size: 16, color: "999999" })]
}));

// ============================================================
// BUILD
// ============================================================
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Microsoft YaHei", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Microsoft YaHei", color: "1A1A2E" },
        paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Microsoft YaHei", color: "E94560" },
        paragraph: { spacing: { before: 300, after: 180 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Microsoft YaHei", color: "0F3460" },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ]
  },
  numbering,
  sections: [{
    properties: {
      page: { size: { width: pageW, height: pageH }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
    },
    headers: {
      default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "E94560", space: 4 } },
        children: [new TextRun({ text: "MSCMS v14 \u00B7 AI\u667A\u80FD\u5185\u5BB9\u4E0E\u81EA\u4E3B\u8FDB\u5316\u5F15\u6D41\u7CFB\u7EDF \u00B7 \u4F18\u5316\u65B9\u6848 v2.0", font: "Microsoft YaHei", size: 14, color: "999999" })]
      })] })
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC", space: 4 } },
        children: [new TextRun({ text: "\u2014 ", font: "Microsoft YaHei", size: 14, color: "999999" }), new TextRun({ children: [PageNumber.CURRENT], font: "Microsoft YaHei", size: 14, color: "999999" }), new TextRun({ text: " \u2014", font: "Microsoft YaHei", size: 14, color: "999999" })]
      })] })
    },
    children,
  }]
});

const outPath = "C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/MSCMS_v14_AI\u667A\u80FD\u5185\u5BB9\u4E0E\u81EA\u4E3B\u8FDB\u5316\u5F15\u6D41\u7CFB\u7EDF_\u4F18\u5316\u65B9\u6848_v2.docx";
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log("Generated: " + outPath);
});