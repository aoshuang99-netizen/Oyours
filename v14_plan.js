const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak, PageNumber, Header, Footer
} = require("docx");

// ── Layout constants ──
const pageW = 11906; // A4 width
const pageH = 16838;
const tblW = 9026;   // A4 - 1" margins

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

// ── Helpers ──
 headerCell(text, w) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: "1A1A2E", type: ShadingType.CLEAR },
    margins: cellMargins,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Microsoft YaHei", size: 20 })] })]
  });
}

 cell(text, w, opts = {}) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: opts.highlight ? { fill: "1A2A3E", type: ShadingType.CLEAR } : undefined,
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Microsoft YaHei", size: 19, color: opts.highlight ? "E94560" : "CCCCCC", bold: !!opts.bold })] })]
  });
}

 row(cells) { return new TableRow({ children: cells }); }

 h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 34, bold: true, color: "E94560" })]
  });
}

 h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 28, bold: true, color: "2E86C1" })]
  });
}

 h3(text) {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 24, bold: true, color: "27AE60" })]
  });
}

 p(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 20, color: "CCCCCC", bold: !!opts.bold, italics: !!opts.italics })]
  });
}

 bullet(text, level = 0) {
  const indent = 720 + level * 360;
  return new Paragraph({
    numbering: { reference: "bullets", level },
    spacing: { before: 30, after: 30 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 19, color: "B0B8C8" })]
  });
}

 subBullet(text) { return bullet(text, 1); }
 subSubBullet(text) { return bullet(text, 2); }

 numberedItem(text, level = 0) {
  const indent = 720 + level * 360;
  return new Paragraph({
    numbering: { reference: "numbers", level },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, font: "Microsoft YaHei", size: 20, color: "F0C040" })]
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Microsoft YaHei", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 34, bold: true, font: "Microsoft YaHei", color: "E94560" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Microsoft YaHei", color: "2E86C1" },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "\u25B8", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
          { level: 2, format: LevelFormat.BULLET, text: "\u2219", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
        ] },
      { reference: "numbers",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2)", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
        ] },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: pageW, height: pageH },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E94560", space: 4 } },
          spacing: { after: 120 },
          children: [
            new TextRun({ text: "MSCMS v14 \u2014 ", font: "Microsoft YaHei", size: 16, color: "808080", italics: true }),
            new TextRun({ text: "\u5168\u94FE\u8DEF\u81EA\u52A8\u5316\u5F15\u6D41\u5E73\u53F0\u8BE6\u7EC6\u8BBE\u8BA1\u65B9\u6848", font: "Microsoft YaHei", size: 16, color: "808080", italics: true }),
          ]
        })]
      })
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: "333333", space: 4 } },
          children: [
            new TextRun({ text: "\u2014 ", font: "Microsoft YaHei", size: 14, color: "808080" }),
            new TextRun({ children: [PageNumber.CURRENT], font: "Microsoft YaHei", size: 14, color: "808080" }),
            new TextRun({ text: " \u2014", font: "Microsoft YaHei", size: 14, color: "808080" }),
          ]
        })]
      })
    },
    children: [
      // ===== TITLE PAGE =====
      new Paragraph({ spacing: { before: 2400 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: "MSCMS v14", font: "Microsoft YaHei", size: 56, bold: true, color: "E94560" })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: "\u5168\u94FE\u8DEF\u81EA\u52A8\u5316\u5F15\u6D41\u5E73\u53F0", font: "Microsoft YaHei", size: 44, bold: true, color: "FFFFFF" })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [new TextRun({ text: "\u8BE6\u7EC6\u8BBE\u8BA1\u65B9\u6848 v2.0", font: "Microsoft YaHei", size: 28, color: "2E86C1" })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: "\u5BF9\u6807\u5168\u7403\u6700\u4F18\u65B9\u6848 \u00B7 \u7EC8\u6781\u76EE\u6807\uFF1A\u81EA\u52A8\u5316\u5F15\u6D41\u8F6C\u5316", font: "Microsoft YaHei", size: 22, color: "888888", italics: true })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
        children: [new TextRun({ text: "2026-07-03  |  Confidential", font: "Microsoft YaHei", size: 18, color: "666666" })]
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== TABLE OF CONTENTS =====
      h1("\u76EE\u5F55"),
      p("\u7B2C\u4E00\u7AE0  \u5E02\u573A\u5BF9\u6807\u7814\u7A76\u4E0E\u6280\u672F\u57FA\u7EBF", { bold: true }),
      p("\u7B2C\u4E8C\u7AE0  10\u5927\u5168\u94FE\u8DEF\u81EA\u52A8\u5316\u6D41\u7A0B\uFF08\u672B\u68A2\u7EA7\u7EC6\u5316\uFF09", { bold: true }),
      p("\u7B2C\u4E09\u7AE0  \u6570\u636E\u540C\u6B65\u4E0E\u5B58\u50A8\u67B6\u6784", { bold: true }),
      p("\u7B2C\u56DB\u7AE0  UI/UX\u4EA4\u4E92\u8BBE\u8BA1\uFF08\u5BF9\u6807\u6700\u4F18\u5E03\u5C40\uFF09", { bold: true }),
      p("\u7B2C\u4E94\u7AE0  \u53CD\u68C0\u6D4B\u4E0E\u62DF\u4EBA\u5316\u7B56\u7565", { bold: true }),
      p("\u7B2C\u516D\u7AE0  \u5B9E\u65BD\u8DEF\u7EBF\u4E0E\u6280\u672F\u53EF\u884C\u6027", { bold: true }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 1: MARKET BENCHMARK =====
      h1("\u7B2C\u4E00\u7AE0 \u2014 \u5E02\u573A\u5BF9\u6807\u7814\u7A76\u4E0E\u6280\u672F\u57FA\u7EBF"),

      h2("1.1 \u884C\u4E1A\u6807\u6746\u53C2\u8003"),

      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [2200, 2400, 2200, 2226],
        rows: [
          row([headerCell("\u529F\u80FD\u7EF4\u5EA6", 2200), headerCell("\u4E1A\u754C\u6700\u4F73\u5B9E\u8DF5", 2400), headerCell("\u5F53\u524Dv13\u72B6\u6001", 2200), headerCell("v14\u76EE\u6807\u8D85\u8D8A", 2226)]),
          row([cell("\u8BBE\u5907\u7BA1\u7406", 2200, {bold:true}), cell("emulator-android: \u6BCF\u8BBE\u5907\u72EC\u7ACB\u6307\u7EB9+\u53CD\u68C0\u6D4B\u81EA\u52A8\u5E94\u7528+\u7248\u672C\u56DE\u9000", 2400), cell("\u57FA\u7840\u542F\u505C+\u622A\u56FE\u9884\u89C8", 2200), cell("\u5148\u8FDB\u6307\u7EB9\u7248\u672C\u5316+\u53CD\u68C0\u6D4B\u81EA\u52A8\u5E94\u7528+\u591A\u8282\u70B9\u8C03\u5EA6", 2226)]),
          row([cell("\u6307\u7EB9\u5F15\u64CE", 2200, {bold:true}), cell("emulator-android: \u7248\u672C\u5316\u975E\u7834\u574F\u6027\u4FEE\u6539 + Periodic Jitter + \u771F\u5B9E\u8BBE\u5907\u5BFC\u5165 + SAMFW\u56FA\u4EF6\u5408\u5E76", 2400), cell("\u57FA\u7840\u968F\u673A\u751F\u6210+\u6CE8\u5165", 2200), cell("\u7248\u672C\u7BA1\u7406+\u5468\u671F\u6027\u5FAE\u8C03+\u771F\u5B9E\u8BBE\u5907\u5BFC\u5165+\u56FA\u4EF6\u5408\u5E76", 2226)]),
          row([cell("\u62DF\u4EBA\u5316", 2200, {bold:true}), cell("Cloakbrowser/Scrapy: \u9AD8\u65AF\u5EF6\u8FDF+Bezier\u6ED1\u52A8+capcha\u81EA\u52A8\u5904\u7406+\u884C\u4E3A\u6A21\u677F\u5E93", 2400), cell("Random\u5EF6\u8FDF+\u57FA\u7840\u6ED1\u52A8", 2200), cell("\u9AD8\u65AF\u6DF7\u5408\u5EF6\u8FDF+Bezier\u66F2\u7EBF+capcha\u5206\u652F+\u884C\u4E3A\u6A21\u677F\u5E93", 2226)]),
          row([cell("\u5185\u5BB9\u5DE5\u5382", 2200, {bold:true}), cell("Jasper/SpinRewriter: AI\u4E3B\u9898\u7F16\u6392+\u5343\u9762\u6539\u5199+EXIF\u6E05\u6D17+\u53D8\u4F53\u53BB\u91CD\u6821\u9A8C", 2400), cell("\u57FA\u7840\u6587\u672C\u6DF7\u6DC6+EXIF\u6E05\u6D17", 2200), cell("AI\u5343\u9762\u6539\u5199+\u53D8\u4F53\u53BB\u91CD+\u5B9A\u65F6\u53D1\u5E03+\u5185\u5BB9\u65E5\u5386", 2226)]),
          row([cell("\u4EE3\u7406\u7BA1\u7406", 2200, {bold:true}), cell("\u6BCF\u8BBE\u5907\u72EC\u7ACB\u4EE3\u7406+\u81EA\u52A8\u8F6E\u6362+\u83B7\u53D6\u5931\u8D25\u544A\u8B66", 2400), cell("\u7EDF\u4E00\u4EE3\u7406\u6CE8\u5165", 2200), cell("\u6BCF\u8BBE\u5907\u72EC\u7ACB\u4EE3\u7406+\u81EA\u52A8\u8F6E\u6362+\u5065\u5EB7\u68C0\u6D4B", 2226)]),
          row([cell("\u4EFB\u52A1\u7F16\u6392", 2200, {bold:true}), cell("n8n/Temporal: DAG\u4F9D\u8D56\u89E3\u6790+\u72B6\u6001\u673A+\u65AD\u70B9\u7EED\u4F20+\u5E76\u884C\u8C03\u5EA6", 2400), cell("\u57FA\u7840\u624B\u52A8\u89E6\u53D1", 2200), cell("DAG\u4F9D\u8D56+\u72B6\u6001\u673A+\u65AD\u70B9\u7EED\u4F20+\u5E76\u884C\u8C03\u5EA6", 2226)]),
          row([cell("\u5B9E\u65F6\u4EA4\u4E92", 2200, {bold:true}), cell("scrcpy: H.264\u4F4E\u5EF6\u8FDF\u6D41+WebSocket\u53CC\u5411\u63A7\u5236+\u89E6\u63A7\u5750\u6807\u6620\u5C04", 2400), cell("\u622A\u56FE\u56DE\u663E+ADB\u547D\u4EE4", 2200), cell("H.264\u6D41+\u89E6\u63A7\u6620\u5C04+\u591A\u70B9\u89E6\u63A7", 2226)]),
        ]
      }),

      h2("1.2 v14 \u6838\u5FC3\u7ADE\u4E89\u529B\u5B9A\u4F4D"),
      bullet("\u5355\u673A\u6700\u591A50\u53F0\u8BBE\u5907\u5E76\u53D1 \u2192 \u884C\u4E1A\u65E0\u7C7B\u4F3C\u4EA7\u54C1\u7684\u89C4\u6A21\u4F18\u52BF"),
      bullet("\u6307\u7EB9\u7248\u672C\u5316+\u5468\u671F\u6027\u5FAE\u8C03 \u2192 \u5BF9\u6807 emulator-android \u7684\u6307\u7EB9\u8F6E\u8F6C\u673A\u5236"),
      bullet("\u5168\u94FE\u8DEF DAG \u4EFB\u52A1\u7F16\u6392 \u2192 \u5BF9\u6807 n8n/Temporal \u7684\u5DE5\u4F5C\u6D41\u5F15\u64CE"),
      bullet("\u4EBA\u7C7B\u884C\u4E3A\u6A21\u62DF \u2192 \u5BF9\u6807 Cloakbrowser/Scrapy \u7684\u884C\u4E3A\u68C0\u6D4B\u7ED5\u8FC7"),
      bullet("\u9632\u5C01\u7B56\u7565\u5168\u8986\u76D6 \u2192 \u5BF9\u6807\u884C\u4E1A\u6700\u4F18\u7684\u53CD\u68C0\u6D4B\u6846\u67B6"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 2: 10 WORKFLOWS =====
      h1("\u7B2C\u4E8C\u7AE0 \u2014 10\u5927\u5168\u94FE\u8DEF\u81EA\u52A8\u5316\u6D41\u7A0B\uFF08\u672B\u68A2\u7EA7\u7EC6\u5316\uFF09"),

      // ── Workflow 1 ──
      h2("\u6D41\u7A0B1\uFF1A\u8BBE\u5907\u667A\u80FD\u542F\u52A8\u7BA1\u7EBF (Device Startup Pipeline)"),
      h3("1.1 AVD\u5065\u5EB7\u68C0\u6D4B\u5B50\u6D41\u7A0B"),
      bullet("\u626B\u63CF\u6240\u6709AVD\u76EE\u5F55\uFF0C\u68C0\u67E5 config.ini / hardware-qemu.ini / userdata-qemu.img.qcow2 \u5B8C\u6574\u6027"),
      bullet("\u7F3A\u5931\u6216\u635F\u574FAVD \u2192 \u81EA\u52A8\u4ECE avd_01 \u514B\u9686\u4FEE\u590D\uFF08\u590D\u5236userdata + \u7EDF\u4E00\u914D\u7F6E\uFF09"),
      bullet("\u6BCF\u6B21\u542F\u52A8\u524D\u81EA\u52A8\u6E05\u7406 .lock/\u5FEB\u7167\u6B8B\u7559/\u4E34\u65F6\u6587\u4EF6"),
      subBullet("\u68C0\u6D4B\u7C7B\u578B\uFF1Amultiinstance.lock / hardware-qemu.ini.lock / snapshots/default_boot / *.qcow2.tmp"),
      bullet("\u786C\u4EF6\u914D\u7F6E\u4E00\u81F4\u6027\u6821\u9A8C\uFF1A\u6BCF\u53F0\u8BBE\u5907\u786E\u4FDD pixel_6a + Android 34 + 1024MB RAM + swiftshader"),

      h3("1.2 \u6279\u6B21\u8C03\u5EA6\u5B50\u6D41\u7A0B"),
      bullet("\u52A8\u6001\u5185\u5B58\u611F\u77E5\uFF1A\u542F\u52A8\u524D\u8BFB\u53D6\u5F53\u524D\u7CFB\u7EDF\u53EF\u7528RAM\uFF0C\u81EA\u52A8\u8C03\u6574\u6BCF\u6279\u6570\u91CF\uFF083~8\u53F0\uFF09"),
      bullet("\u6279\u6B21\u95F4\u96941\u5206\u949F\u51B7\u5374\u65F6\u95F4\uFF0C\u907F\u514D I/O \u98CE\u66B4"),
      bullet("\u6BCF\u6279\u542F\u52A8\u540E\u7B49\u5F85\u5168\u90E8\u8BBE\u5907 boot_completed\uFF0C\u624D\u8FDB\u5165\u4E0B\u4E00\u6279"),
      subBullet("\u6279\u6B21\u5185\u5E76\u884C\u542F\u52A8\uFF08\u901A\u8FC7 ThreadPoolExecutor max_workers=\u6279\u6B21\u5927\u5C0F\uFF09"),
      bullet("\u5931\u8D25\u91CD\u8BD5\uFF1A\u5355\u53F0\u8BBE\u5907\u5931\u8D25\u81EA\u52A8\u91CD\u8BD5\u6700\u591A3\u6B21\uFF0C\u91CD\u8BD5\u95F4\u969410\u79D2\u9012\u589E"),
      bullet("\u542F\u52A8\u5B8C\u6210\u8BA1\u6570\u5B9E\u65F6\u66F4\u65B0\uFF1A\u5DF2\u542F\u52A8X/\u603B\u8BA1Y\uFF0C\u6210\u529FZ\u53F0\uFF0C\u5931\u8D25W\u53F0"),

      h3("1.3 ADB\u4E09\u9636\u6BB5\u63A5\u5165\u68C0\u6D4B"),
      bullet("\u9636\u6BB51\uFF088\u5206\u949F\uFF09\uFF1A\u7B49\u5F85 ADB devices \u53D1\u73B0 emulator \u5B9E\u4F8B\uFF08include_offline=True\uFF09"),
      bullet("\u9636\u6BB52\uFF086\u5206\u949F\uFF09\uFF1A\u7B49\u5F85\u8BBE\u5907\u4ECE offline \u53D8\u4E3A device"),
      bullet("\u9636\u6BB53\uFF086\u5206\u949F\uFF09\uFF1A\u7B49\u5F85 boot_completed=1"),
      bullet("\u8D85\u65F6\u540E\u81EA\u52A8 adb connect \u91CD\u8BD5\u4E00\u6B21\uFF0C\u4ECD\u5931\u8D25\u5219\u6807\u8BB0\u4E3A \u201C\u542F\u52A8\u5931\u8D25\u201D"),
      subBullet("\u5931\u8D25\u65E5\u5FD7\u5305\u542B\uFF1A\u8D85\u65F6\u9636\u6BB5+\u6700\u540E\u5DF2\u77E5\u72B6\u6001+\u5EFA\u8BAE\u64CD\u4F5C"),

      h3("1.4 \u542F\u52A8\u540E\u81EA\u52A8\u5316\u5B50\u6D41\u7A0B"),
      bullet("boot_completed \u89E6\u53D1\uFF1A\u81EA\u52A8\u6267\u884C\u6307\u7EB9\u6CE8\u5165 + \u53CD\u68C0\u6D4B\u5E94\u7528 + \u4EE3\u7406\u914D\u7F6E"),
      bullet("\u6307\u7EB9\u6CE8\u5165\u540E\u81EA\u52A8\u9A8C\u8BC1\uFF1Agetprop \u56DE\u8BFB\u786E\u8BA4\u6240\u6709\u5C5E\u6027\u751F\u6548"),
      bullet("\u9A8C\u8BC1\u5931\u8D25\u81EA\u52A8\u91CD\u8BD5+\u544A\u8B66\uFF0C\u786E\u4FDD\u8BBE\u5907\u8FBE\u5230\u201C\u5B8C\u5168\u5C31\u7EEA\u201D\u72B6\u6001"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 2 ──
      h2("\u6D41\u7A0B2\uFF1A\u6307\u7EB9\u667A\u80FD\u7BA1\u7406\u6D41\u6C34\u7EBF (Fingerprint Intelligence Pipeline)"),
      h3("2.1 \u6307\u7EB9\u5DE5\u5382\u5B50\u6D41\u7A0B"),
      bullet("\u591A\u7EF4\u5EA6\u968F\u673A\u751F\u6210\uFF1AIMEI(14\u4F4D) / IMEI2 / IMSI(15\u4F4D) / Android ID(16\u4F4D hex) / WiFi MAC / \u84DD\u7259MAC"),
      bullet("\u5730\u57DF\u611F\u77E5\u751F\u6210\uFF1A\u6307\u5B9A\u56FD\u5BB6\u2192\u81EA\u52A8\u5339\u914DMCC/MNC/\u8BED\u8A00/\u65F6\u533A"),
      subBullet("\u7F8E\u56FD: mcc=310, mnc=260, language=en-US, timezone=America/New_York"),
      subBullet("\u82F1\u56FD: mcc=234, mnc=15, language=en-GB, timezone=Europe/London"),
      subBullet("\u65E5\u672C: mcc=440, mnc=10, language=ja-JP, timezone=Asia/Tokyo"),
      bullet("\u8BBE\u5907\u578B\u53F7\u6C60\uFF1A\u63D0\u4F9B50+\u771F\u5B9E\u8BBE\u5907\u578B\u53F7\u6A21\u677F\uFF08Pixel / Samsung / OnePlus / Xiaomi\uFF09"),
      bullet("\u6784\u5EFA\u6307\u7EB9\u5B57\u7B26\u4E32\u81EA\u52A8\u751F\u6210\uFF1Aro.build.fingerprint \u5408\u6210\uFF08\u54C1\u724C/\u578B\u53F7/\u7248\u672C\u53F7\uFF09"),
      bullet("\u6307\u7EB9\u53BB\u91CD\u6821\u9A8C\uFF1A\u786E\u4FDD\u6240\u6709\u8BBE\u5907\u6307\u7EB9\u5168\u5C40\u552F\u4E00\uFF0C\u65E0\u91CD\u590D"),
      subBullet("IMEI \u53BB\u91CD\uFF1A\u7EF4\u62A4\u5168\u5C40\u5DF2\u7528\u96C6\u5408\uFF0C\u65B0\u751F\u6210\u65F6\u81EA\u52A8\u89C4\u907F"),
      subBullet("Android ID \u53BB\u91CD\uFF1A\u540C\u4E0A\uFF0C\u4E14\u6BCF\u6B21\u91CD\u65B0\u6CE8\u5165\u65F6\u53EF\u9009\u62E9\u4FDD\u6301\u6216\u66F4\u65B0"),

      h3("2.2 \u6307\u7EB9\u7248\u672C\u7BA1\u7406\uFF08\u5BF9\u6807 emulator-android\uFF09"),
      bullet("\u6BCF\u6B21\u6CE8\u5165\u524D\u81EA\u52A8\u4FDD\u5B58\u5F53\u524D\u6307\u7EB9\u4E3A\u5386\u53F2\u7248\u672C\uFF08\u6700\u591A\u4FDD\u5B5830\u4E2A\u7248\u672C\uFF09"),
      bullet("\u652F\u6301\u7248\u672C\u56DE\u9000\uFF1A\u4E00\u952E\u6062\u590D\u5230\u4EFB\u610F\u5386\u53F2\u6307\u7EB9\u7248\u672C"),
      bullet("\u7248\u672C\u5BF9\u6BD4\uFF1A\u5B57\u6BB5\u7EA7\u5DEE\u5F02\u5BF9\u6BD4\uFF0C\u663E\u793A\u4E24\u4E2A\u7248\u672C\u95F4\u7684\u53D8\u5316"),
      bullet("\u6CE8\u5165\u65E5\u5FD7\uFF1A\u8BB0\u5F55\u6BCF\u6B21\u6CE8\u5165\u7684\u65F6\u95F4/\u5185\u5BB9/\u9A8C\u8BC1\u7ED3\u679C/\u64CD\u4F5C\u8005"),

      h3("2.3 \u5468\u671F\u6027\u6307\u7EB9\u5FAE\u8C03 (Periodic Jitter)"),
      bullet("\u5B9A\u65F6\u89E6\u53D1\uFF1A\u6BCF\u96941\u5C0F\u65F6/\u6BCF\u5929/\u81EA\u5B9A\u4E49\u95F4\u9694\uFF0C\u81EA\u52A8\u5FAE\u8C03\u4EE5\u4E0B\u5B57\u6BB5\uFF1A"),
      subBullet("GPS\u5750\u6807\uFF1A\u5728\u5F53\u524D\u4F4D\u7F6E\u534A\u5F84100m\u5185\u968F\u673A\u504F\u79FB"),
      subBullet("IP\u5730\u5740\uFF1A\u5728\u540C\u4E00C\u7C7B\u7F51\u6BB5\u5185\u968F\u673A\u53D8\u5316\uFF08\u89C4\u907F 10.0.2.x \u6A21\u62DF\u5668\u7279\u5F81\u5730\u5740\uFF09"),
      subBullet("\u7535\u6C60\u7535\u91CF\uFF1A65%-100%\u968F\u673A\u6CE2\u52A8 + \u5145\u7535\u72B6\u6001\u5207\u6362"),
      subBullet("WiFi\u4FE1\u53F7\u5F3A\u5EA6\uFF1A-30dBm\u5230-80dBm\u968F\u673A\u6CE2\u52A8"),
      bullet("\u5FAE\u8C03\u524D\u540E\u81EA\u52A8\u4FDD\u5B58\u7248\u672C\uFF0C\u53EF\u968F\u65F6\u56DE\u9000"),

      h3("2.4 \u771F\u5B9E\u8BBE\u5907\u6307\u7EB9\u5BFC\u5165\uFF08\u5BF9\u6807 emulator-android\uFF09"),
      bullet("\u652F\u6301\u4ECE\u771F\u5B9EAndroid\u8BBE\u5907\u5BFC\u5165\u6307\u7EB9\uFF1Aadb shell getprop > device.props \u2192 \u81EA\u52A8\u6620\u5C04\u5B57\u6BB5"),
      bullet("\u667A\u80FD\u5B57\u6BB5\u6620\u5C04\uFF1A\u81EA\u52A8\u8BC6\u522B ro.product.* / ro.build.* / persist.* \u7B49\u5173\u952E\u5C5E\u6027"),
      bullet("\u5BFC\u5165\u8B66\u544A\u62A5\u544A\uFF1A\u5BF9\u65E0\u6CD5\u6620\u5C04\u7684\u5C5E\u6027\u7ED9\u51FA\u63D0\u793A"),
      bullet("\u5BFC\u5165\u540E\u81EA\u52A8\u4FDD\u5B58\u4E3A\u65B0\u7248\u672C\uFF0C\u4E0D\u8986\u76D6\u5F53\u524D\u6307\u7EB9"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 3 ──
      h2("\u6D41\u7A0B3\uFF1AGPS\u8F68\u8FF9\u667A\u80FD\u6A21\u62DF\u6D41\u6C34\u7EBF (GPS Trajectory Simulation)"),
      h3("3.1 \u8DEF\u5F84\u89C4\u5212\u5B50\u6D41\u7A0B"),
      bullet("\u591A\u70B9\u8DEF\u5F84\u7F16\u8F91\u5668\uFF1A\u5728\u5730\u56FE\u4E0A\u70B9\u51FB\u6DFB\u52A0\u8DEF\u5F84\u70B9\uFF0C\u53EF\u62D6\u62FD\u8C03\u6574\u987A\u5E8F"),
      bullet("\u8DEF\u5F84\u70B9\u652F\u6301\uFF1A\u7ECF\u7EAC\u5EA6\u5750\u6807 + \u5730\u540D\u641C\u7D22 + \u5730\u5740\u89E3\u6790"),
      bullet("\u9884\u8BBE\u8DEF\u5F84\u6A21\u677F\uFF1A\u57CE\u5E02\u901B\u8857 / \u4E0A\u4E0B\u73ED\u8DEF\u7EBF / \u5546\u573A\u901B\u5E97 / \u516C\u56ED\u6563\u6B65"),
      bullet("\u901F\u5EA6\u6A21\u578B\uFF1Awalking(1.4m/s) / cycling(5.5m/s) / driving(11m/s) / \u81EA\u5B9A\u4E49"),
      bullet("\u8DEF\u5F84\u603B\u8DDD\u79BB\u5B9E\u65F6\u8BA1\u7B97\uFF08Haversine\u516C\u5F0F\uFF09+\u9884\u4F30\u8017\u65F6\u663E\u793A"),

      h3("3.2 \u8F68\u8FF9\u751F\u6210\u5B50\u6D41\u7A0B"),
      bullet("Bezier\u66F2\u7EBF\u63D2\u503C\uFF1A2-3\u4E2A\u63A7\u5236\u70B9\u751F\u6210\u5E73\u6ED1\u8F68\u8FF9\uFF0C\u907F\u514D\u76F4\u7EBF\u673A\u68B0\u611F"),
      bullet("\u6B65\u957F\u63A7\u5236\uFF1A\u6BCF\u79D2\u751F\u62101\u4E2A\u5750\u6807\u70B9\uFF08walking\uFF09/ 5\u4E2A\uFF08driving\uFF09"),
      bullet("\u968F\u673A\u504F\u79FB\uFF1A\u6BCF\u4E2A\u5750\u6807\u70B9\u6DFB\u52A0\u00B12m\u968F\u673A\u566A\u58F0\uFF0C\u6A21\u62DFGPS\u8BEF\u5DEE"),
      bullet("\u505C\u6B62\u6A21\u62DF\uFF1A\u5728\u4EA4\u53C9\u8DEF\u53E3\u968F\u673A\u505C\u75590-3\u79D2\uFF08\u6A21\u62DF\u7B49\u7EA2\u7EFF\u706F\uFF09"),

      h3("3.3 \u591A\u8BBE\u5907\u534F\u540C\u5B50\u6D41\u7A0B"),
      bullet("\u591A\u8BBE\u5907\u53EF\u5171\u4EAB\u540C\u4E00\u8DEF\u5F84\u6A21\u677F\uFF0C\u4F46\u6BCF\u53F0\u8BBE\u5907\u72EC\u7ACB\u968F\u673A\u504F\u79FB"),
      bullet("\u8D77\u59CB\u65F6\u95F4\u9519\u5F00\uFF1A\u6BCF\u53F0\u8BBE\u5907\u968F\u673A\u5EF6\u8FDF 0-30\u79D2\u518D\u5F00\u59CB\uFF0C\u907F\u514D\u540C\u6B65"),
      bullet("\u5B9E\u65F6\u5750\u6807\u56DE\u663E\u5230\u6307\u7EB9\u9762\u677F\uFF08\u6BCF\u79D2\u5237\u65B0\uFF09"),
      bullet("\u8F68\u8FF9\u53EF\u6682\u505C/\u6062\u590D/\u63D0\u524D\u7ED3\u675F"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 4 ──
      h2("\u6D41\u7A0B4\uFF1A\u62DF\u4EBA\u5316\u517B\u53F7\u6D41\u6C34\u7EBF (Humanized Account Warming Pipeline)"),
      h3("4.1 \u884C\u4E3A\u6C60\u6A21\u677F\u7CFB\u7EDF"),
      bullet("\u884C\u4E3A\u7C7B\u578B\u6C60\uFF1A\u6D4F\u89C8Feed / \u70B9\u8D5E / \u8BC4\u8BBA / \u5173\u6CE8 / \u641C\u7D22 / \u5206\u4EAB / \u6536\u85CF / \u53D1\u9001\u6D88\u606F"),
      bullet("\u6BCF\u79CD\u884C\u4E3A\u5305\u542B\u591A\u4E2A\u5B50\u53D8\u4F53\uFF1A"),
      subBullet("\u70B9\u8D5E\uFF1A\u5355\u51FB/\u53CC\u51FB/\u957F\u6309\u518D\u70B9\u8D5E/\u53D6\u6D88\u518D\u70B9\u8D5E"),
      subBullet("\u6D4F\u89C8\uFF1A\u5FEB\u901F\u6ED1\u52A8/\u6162\u901F\u6D4F\u89C8/\u5728\u67D0\u4E2A\u89C6\u9891\u505C\u7559\u89C2\u770B/\u8DF3\u8FC7"),
      subBullet("\u641C\u7D22\uFF1A\u6309\u5173\u952E\u8BCD/\u6309\u8D26\u53F7/\u6309\u8BDD\u9898\u6807\u7B7E/\u6D4F\u89C8\u7ED3\u679C\u9875"),
      bullet("\u884C\u4E3A\u6A21\u677F\u53EF\u4FDD\u5B58+\u5BFC\u5165\uFF0C\u5F62\u6210\u6A21\u677F\u5E93"),

      h3("4.2 \u4EBA\u7C7B\u5EF6\u8FDF\u6A21\u578B\uFF08\u5BF9\u6807 Cloakbrowser\uFF09"),
      bullet("\u9AD8\u65AF\u5206\u5E03\u5EF6\u8FDF + \u6307\u6570\u5206\u5E03\u5EF6\u8FDF\u6DF7\u5408"),
      bullet("\u6309\u884C\u4E3A\u7C7B\u578B\u5DEE\u5F02\u5316\u5EF6\u8FDF\uFF1A"),
      subBullet("\u6D4F\u89C8Feed\uFF1A\u6BCF\u6B21\u6ED1\u52A8\u95F4\u9694 0.5-5\u79D2\uFF08\u9AD8\u65AF\u5747\u503C2.5s\uFF09"),
      subBullet("\u70B9\u8D5E\uFF1A\u505C\u75590.5-3\u79D2\u540E\u518D\u6267\u884C\u70B9\u8D5E"),
      subBullet("\u8BC4\u8BBA\uFF1A\u505C\u75592-8\u79D2\u540E\u518D\u5F00\u59CB\u8F93\u5165"),
      subBullet("\u6BCF\u4E2A\u5B57\u7B26\u8F93\u5165\u95F4\u9694 100-500ms\uFF08\u9AD8\u65AF\u5747\u503C\=300ms\uFF09"),
      bullet("\u8D85\u8FC715\u5206\u949F\u81EA\u52A8\u4F11\u606F 2-10\u5206\u949F\uFF08\u6A21\u62DF\u4EBA\u7C7B\u7596\u52B3\uFF09"),

      h3("4.3 \u89E6\u6478\u4E8B\u4EF6\u751F\u6210\u5B50\u6D41\u7A0B"),
      bullet("Bezier\u66F2\u7EBF\u6ED1\u52A8\u8DEF\u5F84\u751F\u6210\uFF08\u8D77\u70B9\u2192\u63A7\u5236\u70B9\u2192\u7EC8\u70B9\uFF09\uFF0C\u6A21\u62DF\u4EBA\u7C7B\u624B\u6307\u81EA\u7136\u5F27\u7EBF"),
      bullet("\u89E6\u6478\u538B\u529B\u968F\u673A\u53D8\u5316\uFF1A\u6B63\u5E38\u70B9\u51FB\u538B\u529B 0.8-1.2 \u5355\u4F4D"),
      bullet("\u89E6\u6478\u9762\u79EF\u968F\u673A\u53D8\u5316\uFF1A\u6A21\u62DF\u6307\u5C16\u63A5\u89E6\u9762\u79EF 0.5-1.5mm\u00B2"),
      bullet("\u5076\u5C14\u201C\u8BEF\u89E6\u201D\uFF1A2%\u6982\u7387\u70B9\u51FB\u504F\u79FB 10-30px\uFF0C\u7136\u540E\u7EA0\u6B63\uFF08\u6A21\u62DF\u4EBA\u7C7B\u5931\u8BEF\uFF09"),
      bullet("\u89E6\u6478\u65E5\u5FD7\u53EF\u89C6\u5316\uFF1A\u5B9E\u65F6\u663E\u793A\u5F53\u524D\u89E6\u6478\u5750\u6807\u548C\u8F68\u8FF9"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 5 ──
      h2("\u6D41\u7A0B5\uFF1ASession\u667A\u80FD\u7BA1\u7406\u6D41\u6C34\u7EBF (Session Lifecycle Pipeline)"),
      h3("5.1 \u667A\u80FD\u5907\u4EFD\u5B50\u6D41\u7A0B"),
      bullet("\u652F\u6301\u8D26\u53F7\u7EA7\u5907\u4EFD\uFF1A +  \u53CC\u7D22\u5F15\u5B9A\u4F4D"),
      bullet("\u5907\u4EFD\u5305\u542B\uFF1Ashared_prefs/ + databases/ + files/ + cache/ + \u5143\u6570\u636Emeta.json"),
      bullet("tar\u6253\u5305\u4E0E\u538B\u7F29\uFF1A\u51CF\u5C11\u5B58\u50A8\u7A7A\u95F4\uFF0C\u5E76\u751F\u6210SHA256\u54C8\u5E0C\u7528\u4E8E\u5B8C\u6574\u6027\u6821\u9A8C"),
      bullet("\u5B9A\u65F6\u81EA\u52A8\u5907\u4EFD\uFF1A\u6BCF\u5929/\u6BCF\u5468/\u81EA\u5B9A\u4E49\u95F4\u9694\u81EA\u52A8\u5907\u4EFD"),
      bullet("\u5907\u4EFD\u7248\u672C\u63A7\u5236\uFF1A\u6BCF\u4E2A\u8D26\u53F7\u4FDD\u7559\u6700\u8FD15\u4E2A\u5907\u4EFD\uFF0C\u81EA\u52A8\u6E05\u7406\u65E7\u7248\u672C"),

      h3("5.2 \u667A\u80FD\u8FC1\u79FB\u5B50\u6D41\u7A0B"),
      bullet("\u6E90\u8BBE\u5907\u5907\u4EFD \u2192 \u76EE\u6807\u8BBE\u5907\u6062\u590D \u2192 \u6821\u9A8C\u5B8C\u6574\u6027"),
      bullet("\u8FC1\u79FB\u524D\u81EA\u52A8\u68C0\u67E5\u76EE\u6807\u8BBE\u5907\u72B6\u6001\uFF08\u5FC5\u987B\u4E3Aonline\uFF09"),
      bullet("\u8FC1\u79FB\u540E\u81EA\u52A8\u91CD\u542FA\u5E94\u7528\u4EE5\u751F\u6548Session"),
      bullet("\u6279\u91CF\u8FC1\u79FB\uFF1A\u4E00\u6B21\u64CD\u4F5C\u5C06\u591A\u4E2A\u8D26\u53F7\u6279\u91CF\u8FC1\u79FB\u5230\u76EE\u6807\u8BBE\u5907\u6C60"),

      h3("5.3 \u8D26\u53F7\u5065\u5EB7\u76D1\u63A7\u5B50\u6D41\u7A0B"),
      bullet("\u6BCF\u6B21\u767B\u5F55\u81EA\u52A8\u68C0\u6D4B\u8D26\u53F7\u72B6\u6001\uFF1A\u6B63\u5E38/\u9650\u6D41/\u5C01\u7981/\u9A8C\u8BC1\u7801"),
      bullet("\u8D26\u53F7\u72B6\u6001\u5B9E\u65F6\u540C\u6B65\u5230\u8D44\u4EA7\u9762\u677F\uFF0C\u5F02\u5E38\u81EA\u52A8\u544A\u8B66"),
      bullet("\u8D26\u53F7\u5065\u5EB7\u5206\u6570\uFF1A\u7EFC\u5408\u767B\u5F55\u6B21\u6570/\u5F02\u5E38\u6B21\u6570/\u6700\u540E\u6D3B\u52A8\u65F6\u95F4\u8BA1\u7B97"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 6 ──
      h2("\u6D41\u7A0B6\uFF1AAI\u5185\u5BB9\u5DE5\u5382\u6D41\u6C34\u7EBF (AI Content Factory Pipeline)"),
      h3("6.1 \u5343\u9762\u6539\u5199\u5B50\u6D41\u7A0B\uFF08\u5BF9\u6807 SpinRewriter\uFF09"),
      bullet("\u591A\u5C42\u7EA7\u6539\u5199\u7B56\u7565\uFF1A"),
      subBullet("L1-\u540C\u4E49\u8BCD\u66FF\u6362\uFF1A\u4E3B\u8C13\u5BBE\u5B9A\u8BED\u540C\u4E49\u66FF\u6362\uFF0C\u4FDD\u6301\u539F\u610F"),
      subBullet("L2-\u8BED\u5E8F\u91CD\u6392\uFF1A\u53E5\u5B50\u7EA7\u987A\u5E8F\u968F\u673A\u91CD\u7EC4\uFF0C\u6DFB\u52A0\u8FC7\u6E21\u8BCD"),
      subBullet("L3-paraphrase\uFF1A\u5B8C\u6574\u91CD\u5199\uFF0C\u6539\u53D8\u8868\u8FBE\u65B9\u5F0F\u4F46\u4FDD\u6301\u6838\u5FC3\u4FE1\u606F"),
      subBullet("L4-emoji/hashtag\uFF1A\u81EA\u52A8\u63D2\u5165\u76F8\u5173emoji\u548C\u6D41\u884Chashtag"),
      bullet("\u53D8\u4F53\u53BB\u91CD\u6821\u9A8C\uFF1A\u4EFB\u610F\u4E24\u4E2A\u53D8\u4F53\u76F8\u4F3C\u5EA6<30%\uFF08Jaccard/\u7F16\u8F91\u8DDD\u79BB\uFF09"),
      bullet("\u53D8\u4F53\u6570\u91CF\u63A7\u5236\uFF1A\u6BCF\u6761\u539F\u6587\u751F\u6210 10-20\u4E2A\u53D8\u4F53\uFF08\u53EF\u914D\u7F6E\uFF09"),
      bullet("\u5E73\u53F0\u81EA\u9002\u5E94\uFF1A\u81EA\u52A8\u8C03\u6574\u5185\u5BB9\u957F\u5EA6\uFF08TikTok 150\u5B57 / Instagram 2200\u5B57 / Reddit 40K\u5B57\uFF09"),

      h3("6.2 \u5A92\u4F53\u5904\u7406\u5B50\u6D41\u7A0B"),
      bullet("EXIF\u6E05\u6D17\uFF1A\u81EA\u52A8\u5265\u79BBGPS/\u76F8\u673A\u578B\u53F7/\u62CD\u6444\u65F6\u95F4\u7B49\u5143\u6570\u636E"),
      bullet("\u56FE\u7247\u91CD\u65B0\u7F16\u7801\uFF1AJPEG\u91CD\u65B0\u538B\u7F29\uFF0C\u6539\u53D8\u6587\u4EF6\u54C8\u5E0C\u503C\u800C\u4E0D\u5F71\u54CD\u89C6\u89C9\u8D28\u91CF"),
      bullet("\u89C6\u9891\u6C34\u5370\u5904\u7406\uFF1A\u53EF\u9009\u6DFB\u52A0/\u79FB\u9664\u6C34\u5370"),
      bullet("\u6279\u91CF\u5904\u7406\uFF1A\u4E00\u6B21\u6027\u5904\u7406\u6574\u4E2A\u6587\u4EF6\u5939\u7684\u5A92\u4F53\u6587\u4EF6"),

      h3("6.3 \u667A\u80FD\u5206\u53D1\u5B50\u6D41\u7A0B"),
      bullet("\u53D8\u4F53\u81EA\u52A8\u5206\u914D\uFF1A\u6BCF\u53F0\u8BBE\u5907\u5206\u914D\u552F\u4E00\u53D8\u4F53\uFF0C\u786E\u4FDD\u4E0D\u91CD\u590D"),
      bullet("adb push \u4E0B\u53D1\u5230\u8BBE\u5907\u5185\u5B58\uFF1A/sdcard/mscms_content/{type}/{filename}"),
      bullet("\u5206\u53D1\u65E5\u5FD7\uFF1A\u8BB0\u5F55\u6BCF\u53F0\u8BBE\u5907\u6536\u5230\u7684\u5185\u5BB9 + \u65F6\u95F4\u6233"),
      bullet("\u5206\u53D1\u72B6\u6001\u8FFD\u8E2A\uFF1A\u5F85\u5206\u53D1/\u5DF2\u5206\u53D1/\u5206\u53D1\u5931\u8D25 + \u91CD\u8BD5"),

      h3("6.4 \u5185\u5BB9\u65E5\u5386\u4E0E\u5B9A\u65F6\u53D1\u5E03\uFF08\u5BF9\u6807 Buffer/Hootsuite\uFF09"),
      bullet("\u53EF\u89C6\u5316\u65E5\u5386\u89C6\u56FE\uFF1A\u6309\u5929/\u5468/\u6708\u67E5\u770B\u5185\u5BB9\u53D1\u5E03\u8BA1\u5212"),
      bullet("\u5B9A\u65F6\u53D1\u5E03\uFF1A\u5728\u6307\u5B9A\u65F6\u95F4\u70B9\u81EA\u52A8\u53D1\u5E03\u5230\u76EE\u6807\u8BBE\u5907"),
      bullet("\u65F6\u533A\u611F\u77E5\uFF1A\u81EA\u52A8\u6839\u636E\u8BBE\u5907\u65F6\u533A\u8C03\u6574\u53D1\u5E03\u65F6\u95F4"),
      bullet("\u53D1\u5E03\u95F4\u9694\u63A7\u5236\uFF1A\u6BCF\u53F0\u8BBE\u5907\u6BCF\u5929\u53D1\u5E03\u4E0A\u9650\uFF081-5\u6761\uFF0C\u53EF\u914D\u7F6E\uFF09"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 7 ──
      h2("\u6D41\u7A0B7\uFF1ASCRM\u667A\u80FD\u622A\u6D41\u6D41\u6C34\u7EBF (Smart Traffic Intercept Pipeline)"),
      h3("7.1 \u591A\u7EF4\u5EA6\u76EE\u6807\u8BBE\u5B9A\u5B50\u6D41\u7A0B"),
      bullet("\u5E73\u53F0\u9009\u62E9\uFF1ATikTok / Instagram / Reddit / YouTube / Facebook\uFF08\u53EF\u6269\u5C55\uFF09"),
      bullet("\u5173\u952E\u8BCD\u5206\u7EC4\uFF1A\u5546\u4E1A\u610F\u5411 / \u54C1\u724C\u76D1\u63A7 / \u7ADE\u54C1\u622A\u6D41 / \u81EA\u5B9A\u4E49"),
      bullet("\u533A\u57DF\u8FC7\u6EE4\uFF1A\u6309\u56FD\u5BB6/\u8BED\u8A00/\u65F6\u533A\u7B5B\u9009\u76EE\u6807\u7528\u6237"),
      bullet("\u6392\u9664\u8BCD\u5E93\uFF1A\u81EA\u52A8\u8FC7\u6EE4\u611F\u8C22/\u79F0\u8D5E\u7C7B\u65E0\u610F\u4E49\u8BC4\u8BBA"),

      h3("7.2 \u667A\u80FD\u8BC4\u5206\u5F15\u64CE\u5B50\u6D41\u7A0B"),
      bullet("\u591A\u6743\u91CD\u8BC4\u5206\uFF1A"),
      subBullet("\u5546\u4E1A\u610F\u5411\u8BCD\uFF08buy/price/link\uFF09\u6743\u91CD 3.0"),
      subBullet("\u54C1\u724C\u76F8\u5173\u8BCD\uFF08\u4EA7\u54C1\u540D/\u54C1\u724C\u540D\uFF09\u6743\u91CD 2.0"),
      subBullet("\u7591\u95EE\u8BCD\uFF08how/where/what price\uFF09\u6743\u91CD 1.5"),
      subBullet("\u8D1F\u5411\u8BCD\uFF08thanks/nice/cool\uFF09\u6743\u91CD -0.5"),
      bullet("\u8BC4\u5206\u5206\u7EA7\uFF1AHOT(\u22652.0) / WARM(1.0-2.0) / COLD(<1.0)"),
      bullet("\u4EA4\u4E92\u6DF1\u5EA6\u7EFC\u5408\u8BC4\u4F30\uFF1A\u7ED3\u5408\u70B9\u8D5E/\u56DE\u590D\u6570\u8C03\u6574\u6743\u91CD"),
      bullet("\u7528\u6237\u4FE1\u8A89\u5206\uFF1A\u8D26\u53F7\u5E74\u9F84/\u7C89\u4E1D\u6570/\u53D1\u5E16\u9891\u7387\u7EFC\u5408\u8BC4\u4F30"),

      h3("7.3 \u667A\u80FD\u56DE\u590D\u5F15\u64CE\u5B50\u6D41\u7A0B"),
      bullet("\u8BED\u4E49\u7406\u89E3\uFF1A\u81EA\u52A8\u8BC6\u522B\u8BC4\u8BBA\u60C5\u611F\uFF08\u6B63\u9762/\u8D1F\u9762/\u4E2D\u6027/\u7591\u95EE\uFF09"),
      bullet("\u6A21\u677F\u5339\u914D\uFF1A\u9884\u8BBE50+\u56DE\u590D\u6A21\u677F\uFF0C\u6309\u60C5\u611F+\u884C\u4E1A\u5206\u7C7B"),
      bullet("AI\u4E2A\u6027\u5316\u751F\u6210\uFF1A\u57FA\u4E8E\u6A21\u677F+\u8BC4\u8BBA\u4E0A\u4E0B\u6587\u52A8\u6001\u751F\u6210\u552F\u4E00\u56DE\u590D"),
      bullet("\u56DE\u590D\u53BB\u91CD\uFF1A\u540C\u4E00\u5185\u5BB9\u4E0D\u5BF9\u591A\u4E2A\u7528\u6237\u91CD\u590D\u53D1\u9001"),
      bullet("\u624B\u52A8\u786E\u8BA4\u6A21\u5F0F\uFF1A\u56DE\u590D\u524D\u53EF\u9884\u89C8+\u4EBA\u5DE5\u786E\u8BA4\u540E\u53D1\u9001"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 8 ──
      h2("\u6D41\u7A0B8\uFF1A\u4EE3\u7406\u667A\u80FD\u7BA1\u7406\u6D41\u6C34\u7EBF (Proxy Intelligence Pipeline)"),
      h3("8.1 \u591A\u5C42\u7EA7\u4EE3\u7406\u914D\u7F6E\u5B50\u6D41\u7A0B"),
      bullet("\u5168\u5C40\u4EE3\u7406\uFF1Asettings put global http_proxy + \u8BA4\u8BC1\u4FE1\u606F"),
      bullet("\u5E94\u7528\u7EA7\u4EE3\u7406\uFF1A\u901A\u8FC7 iptables/ProxyDroid \u4E3A\u5355\u4E2AApp\u914D\u7F6E\u72EC\u7ACB\u4EE3\u7406"),
      bullet("SOCKS5\u652F\u6301\uFF1A\u9664HTTP\u5916\u652F\u6301SOCKS5\u4EE3\u7406\u534F\u8BAE"),
      bullet("\u591A\u7EBF\u8DEF\u7ED1\u5B9A\uFF1A\u6BCF\u53F0\u8BBE\u5907\u53EF\u914D\u7F6E\u4E3B/\u5907\u4EE3\u7406\uFF0C\u81EA\u52A8\u5207\u6362"),

      h3("8.2 \u667A\u80FD\u9A8C\u8BC1\u5B50\u6D41\u7A0B"),
      bullet("IP\u9A8C\u8BC1\uFF1A\u6CE8\u5165\u540E\u81EA\u52A8 curl ipinfo.io \u9A8C\u8BC1\u4EE3\u7406\u751F\u6548"),
      bullet("\u56DE\u663E\u4FE1\u606F\u5305\u542B\uFF1A\u516C\u7F51IP/\u56FD\u5BB6/\u57CE\u5E02/ISP/\u65F6\u533A"),
      bullet("\u4EE3\u7406\u5065\u5EB7\u68C0\u6D4B\uFF1A\u5B9A\u65F6\u63A2\u6D4B\u4EE3\u7406\u53EF\u7528\u6027\uFF0C\u5931\u6548\u81EA\u52A8\u5207\u6362\u5907\u7528"),
      bullet("\u5EF6\u8FDF\u6D4B\u8BD5\uFF1A\u81EA\u52A8\u6D4B\u8BD5\u4EE3\u7406\u54CD\u5E94\u65F6\u95F4\uFF0C\u8D85\u65F6\u81EA\u52A8\u6807\u8BB0"),

      h3("8.3 \u667A\u80FD\u8F6E\u6362\u5B50\u6D41\u7A0B"),
      bullet("\u5B9A\u65F6\u8F6E\u6362\uFF1A\u6BCF\u9694N\u5206\u949F\u81EA\u52A8\u5207\u6362\u4EE3\u7406"),
      bullet("\u89E6\u53D1\u5F0F\u8F6E\u6362\uFF1A\u68C0\u6D4B\u5230\u9650\u6D41/\u5C01\u7981\u81EA\u52A8\u5207\u6362\u4EE3\u7406"),
      bullet("\u4EE3\u7406\u6C60\u7BA1\u7406\uFF1A\u7EF4\u62A4\u4EE3\u7406\u5217\u8868+\u81EA\u52A8\u52A0\u8F7D/\u6DFB\u52A0/\u5220\u9664"),
      bullet("\u8F6E\u6362\u65E5\u5FD7\uFF1A\u8BB0\u5F55\u6BCF\u6B21\u5207\u6362\u7684\u65F6\u95F4/\u539F\u56E0/\u65B0\u65E7IP"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 9 ──
      h2("\u6D41\u7A0B9\uFF1A\u4F20\u611F\u5668\u7EFC\u5408\u6A21\u62DF\u6D41\u6C34\u7EBF (Sensor Simulation Pipeline)"),
      h3("9.1 \u591A\u4F20\u611F\u5668\u6A21\u62DF\u5B50\u6D41\u7A0B"),
      bullet("\u7535\u6C60\u6A21\u62DF\uFF1A\u7535\u91CF65-100%\u968F\u673A\u6CE2\u52A8 + \u5145\u7535/\u653E\u7535\u72B6\u6001\u5207\u6362"),
      bullet("\u91CD\u529B\u611F\u5E94\uFF1A\u4E09\u8F74\u52A0\u901F\u5EA6\u6A21\u62DF\uFF08\u6A21\u62DF\u624B\u673A\u63E1\u6301\u59FF\u52BF\u53D8\u5316\uFF09"),
      bullet("\u5149\u7EBF\u611F\u5E94\uFF1A10-10000 lux\u968F\u65F6\u95F4\u53D8\u5316\uFF08\u6A21\u62DF\u5BA4\u5185\u5916\u73AF\u5883\u53D8\u5316\uFF09"),
      bullet("\u8DDD\u79BB\u611F\u5E94\uFF1A\u901A\u8BDD/\u975E\u901A\u8BDD\u72B6\u6001\u5207\u6362"),
      bullet("\u6E29\u5EA6\u6A21\u62DF\uFF1ACPU\u6E29\u5EA6 30-45\u00B0C + \u7535\u6C60\u6E29\u5EA6 25-38\u00B0C"),
      bullet("\u538B\u529B\u6A21\u62DF\uFF1A\u6D77\u62D4\u538B\u529B\u968F\u6D77\u62D4\u5339\u914D\u53D8\u5316"),

      h3("9.2 \u4F20\u611F\u5668\u6570\u636E\u53EF\u89C6\u5316"),
      bullet("\u5B9E\u65F6\u4EEA\u8868\u76D8\u663E\u793A\uFF1A\u7C7B\u4F3C\u6C7D\u8F66\u4EEA\u8868\u76D8\u7684\u5B9E\u65F6\u6570\u636E\u53EF\u89C6\u5316"),
      bullet("\u5386\u53F2\u66F2\u7EBF\u56FE\uFF1A\u67E5\u770B\u4F20\u611F\u5668\u6570\u636E\u7684\u65F6\u95F4\u5E8F\u5217\u53D8\u5316"),
      bullet("\u4F20\u611F\u5668\u53D8\u5316\u901F\u7387\u63A7\u5236\uFF1A\u6BCF100ms/500ms/1s\u66F4\u65B0\u4E00\u6B21"),

      new Paragraph({ children: [new PageBreak()] }),

      // ── Workflow 10 ──
      h2("\u6D41\u7A0B10\uFF1ADAG\u4EFB\u52A1\u7F16\u6392\u6D41\u6C34\u7EBF (DAG Task Orchestration Pipeline)"),
      h3("10.1 \u4EFB\u52A1\u5B9A\u4E49\u5B50\u6D41\u7A0B"),
      bullet("JSON/YAML\u4EFB\u52A1\u5B9A\u4E49\u6587\u4EF6\uFF1A"),
      subBullet("\u6BCF\u4E2A\u4EFB\u52A1\u5305\u542B\uFF1Aname / type / params / depends_on / timeout / retry / on_failure"),
      subBullet("\u652F\u6301\u6761\u4EF6\u5206\u652F\uFF1Aif captcha_detected \u2192 captcha_handler, else \u2192 continue"),
      subBullet("\u652F\u6301\u5FAA\u73AF\uFF1Aloop N times or while condition"),
      bullet("\u53EF\u89C6\u5316\u4EFB\u52A1\u7F16\u8F91\u5668\uFF1A\u62D6\u62FD\u8FDE\u63A5\u4EFB\u52A1\u8282\u70B9\uFF0C\u914D\u7F6E\u8282\u70B9\u5C5E\u6027"),
      bullet("\u9884\u8BBE\u4EFB\u52A1\u6A21\u677F\uFF1A"),
      subBullet("\u201C\u65B0\u8D26\u53F7\u5F15\u6D41\u201D\u6A21\u677F\uFF1A\u542F\u52A8\u2192\u6307\u7EB9\u2192\u4EE3\u7406\u2192\u517B\u53F7\u2192\u5185\u5BB9\u53D1\u5E03\u2192\u622A\u6D41\u76D1\u63A7"),
      subBullet("\u201C\u8001\u8D26\u53F7\u590D\u6D3B\u201D\u6A21\u677F\uFF1A\u542F\u52A8\u2192Session\u6062\u590D\u2192\u4EE3\u7406\u2192\u6D4F\u89C8\u517B\u53F7\u2192\u5185\u5BB9\u53D1\u5E03"),
      subBullet("\u201C\u8D26\u53F7\u8FC1\u79FB\u201D\u6A21\u677F\uFF1A\u5907\u4EFD\u2192\u505C\u6B62\u6E90\u8BBE\u5907\u2192\u542F\u52A8\u76EE\u6807\u2192\u6062\u590D\u2192\u9A8C\u8BC1"),

      h3("10.2 DAG\u6267\u884C\u5F15\u64CE\u5B50\u6D41\u7A0B"),
      bullet("\u4F9D\u8D56\u89E3\u6790\uFF1A\u81EA\u52A8\u6784\u5EFA\u6709\u5411\u65E0\u73AF\u56FE\uFF0C\u68C0\u6D4B\u5FAA\u73AF\u4F9D\u8D56"),
      bullet("\u5E76\u884C\u8C03\u5EA6\uFF1A\u65E0\u4F9D\u8D56\u5173\u7CFB\u7684\u4EFB\u52A1\u5E76\u884C\u6267\u884C"),
      bullet("\u72B6\u6001\u673A\uFF1A\u6BCF\u4E2A\u4EFB\u52A1\u72B6\u6001\uFF1APENDING \u2192 RUNNING \u2192 SUCCESS / FAILED / SKIPPED"),
      bullet("\u65AD\u70B9\u7EED\u4F20\uFF1A\u4EFB\u52A1\u5931\u8D25\u540E\u53EF\u4ECE\u5931\u8D25\u8282\u70B9\u7EE7\u7EED\uFF0C\u800C\u975E\u91CD\u5934\u5F00\u59CB"),
      bullet("\u5168\u5C40\u8FDB\u5EA6\uFF1A\u5B9E\u65F6\u66F4\u65B0\u6574\u4F53\u4EFB\u52A1\u94FE\u7684\u5B8C\u6210\u767E\u5206\u6BD4"),
      bullet("\u5B50\u4EFB\u52A1\u8FDB\u5EA6\uFF1A\u6BCF\u53F0\u8BBE\u5907\u7684\u72EC\u7ACB\u4EFB\u52A1\u8FDB\u5EA6\u6761"),

      h3("10.3 \u7ED3\u679C\u6C47\u603B\u5B50\u6D41\u7A0B"),
      bullet("\u6210\u529F\u7387\u7EDF\u8BA1\uFF1A\u6BCF\u4E2A\u4EFB\u52A1\u6B65\u9AA4\u7684\u6210\u529F\u8BA1\u6570/\u5931\u8D25\u8BA1\u6570"),
      bullet("\u5931\u8D25\u539F\u56E0\u5206\u6790\uFF1A\u81EA\u52A8\u5206\u7C7B\u5931\u8D25\u539F\u56E0\uFF08\u7F51\u7EDC/\u8D26\u53F7/\u8BBE\u5907/\u8D85\u65F6\uFF09"),
      bullet("\u6267\u884C\u65E5\u5FD7\u5BFC\u51FA\uFF1AJSON/\u8868\u683C\u683C\u5F0F\u5BFC\u51FA\u5B8C\u6574\u6267\u884C\u8BB0\u5F55"),
      bullet("\u544A\u8B66\u89E6\u53D1\uFF1A\u5931\u8D25\u7387\u8D85\u8FC7\u9608\u503C\u65F6\u81EA\u52A8\u5F39\u7A97\u544A\u8B66"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 3: Data Sync =====
      h1("\u7B2C\u4E09\u7AE0 \u2014 \u6570\u636E\u540C\u6B65\u4E0E\u5B58\u50A8\u67B6\u6784"),

      h2("3.1 \u5B8C\u6574\u6570\u636E\u6A21\u578B (8\u5F20\u6838\u5FC3\u8868)"),

      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [1800, 1200, 3026, 3000],
        rows: [
          row([headerCell("\u8868\u540D", 1800), headerCell("\u8BB0\u5F55\u6570", 1200), headerCell("\u5173\u952E\u5B57\u6BB5", 3026), headerCell("\u540C\u6B65\u7B56\u7565", 3000)]),
          row([cell("devices", 1800, {bold:true}), cell("50\u6761", 1200), cell("idx, avd_name, adb_serial, status, proxy, fingerprinted, last_online, sensor_data(JSON)", 3026), cell("\u5B9E\u65F6\u5199\u5165 + \u5185\u5B58\u7F13\u5B58\u53CC\u5199", 3000)]),
          row([cell("fingerprints", 1800, {bold:true}), cell("50\u00D7N\u7248\u672C", 1200), cell("device_id, imei1/2, android_id, wifi_mac, bt_mac, imsi, version, injected_at, verified", 3026), cell("\u5199\u540E\u8BFB + 30\u7248\u672C\u4E0A\u9650\u81EA\u52A8\u6E05\u7406", 3000)]),
          row([cell("fingerprint_revs", 1800, {bold:true}), cell("\u6BCF\u8BBE\u5907\u00D730", 1200), cell("device_id, rev_id, snapshot(JSON), , label", 3026), cell("\u53EA\u8FFD\u52A0 + \u8D85\u9650\u81EA\u52A8\u5220\u6700\u65E7\u7248\u672C", 3000)]),
          row([cell("social_", 1800, {bold:true}), cell("N\u6761", 1200), cell(", , , email, device_id, status, , last_login", 3026), cell("\u5B9E\u65F6\u5199\u5165 + \u767B\u5F55\u72B6\u6001\u81EA\u52A8\u66F4\u65B0", 3000)]),
          row([cell("sessions", 1800, {bold:true}), cell("\u6BCF\u8D26\u53F7\u00D75", 1200), cell(", account_name, device_id, backup_path, version, hash_sha256, ", 3026), cell("\u5907\u4EFD\u65F6\u5199\u5165 + \u65E7\u7248\u672C\u81EA\u52A8\u6E05\u7406", 3000)]),
          row([cell("content_logs", 1800, {bold:true}), cell("N\u6761", 1200), cell("device_id, , content_type, original_text, variant_text, deployed_at, exif_stripped", 3026), cell("\u6279\u91CF\u5199\u5165 + \u5B9A\u671F\u5F52\u6863\u538B\u7F29", 3000)]),
          row([cell("task_runs", 1800, {bold:true}), cell("N\u6761", 1200), cell("task_name, device_id, status, progress_pct, started_at, completed_at, error_log, dag_state(JSON)", 3026), cell("\u5B9E\u65F6\u5199\u5165 + \u5B8C\u6210\u540E\u6807\u8BB0", 3000)]),
          row([cell("proxy_pool", 1800, {bold:true}), cell("N\u6761", 1200), cell("host, port, type, country, city, latency_ms, health, last_check, assigned_device", 3026), cell("\u5B9A\u65F6\u5065\u5EB7\u68C0\u6D4B + \u72B6\u6001\u66F4\u65B0", 3000)]),
        ]
      }),

      h2("3.2 \u591A\u5C42\u7EA7\u7F13\u5B58\u67B6\u6784"),
      bullet("L0-\u5185\u5B58\u7F13\u5B58\uFF1APython dict\uFF0C\u5B58\u50A8\u5F53\u524D\u8BBE\u5907\u72B6\u6001/\u4EFB\u52A1\u72B6\u6001/\u914D\u7F6E"),
      subBullet("\u8BFB\u53D6\u4F18\u5148\u7EA7\uFF1A\u5185\u5B58 \u2192 SQLite \u2192 \u6587\u4EF6"),
      subBullet("\u5199\u5165\u7B56\u7565\uFF1A\u5185\u5B58+\u6570\u636E\u5E93\u53CC\u5199\uFF08Write-Through\uFF09"),
      bullet("L1-SQLite\u6301\u4E45\u5316\uFF1A\u6240\u6709\u72B6\u6001\u6700\u7EC8\u843D\u76D8"),
      subBullet("\u542F\u52A8\u65F6\u4ECE SQLite \u52A0\u8F7D\u5230\u5185\u5B58\u7F13\u5B58"),
      subBullet("\u6BCF\u6B21\u72B6\u6001\u53D8\u66F4\u540C\u6B65\u5199\u5165\u6570\u636E\u5E93"),
      bullet("L2-\u6587\u4EF6\u5B58\u50A8\uFF1ASession\u5907\u4EFD/\u622A\u56FE/\u65E5\u5FD7/\u914D\u7F6E\u6587\u4EF6\uFF08\u4F7F\u7528\u539F\u59CB\u6587\u4EF6\u7CFB\u7EDF\uFF09"),

      h2("3.3 \u4E8B\u4EF6\u9A71\u52A8\u540C\u6B65 (Event-Driven Sync)"),
      bullet("\u6240\u6709\u72B6\u6001\u53D8\u66F4\u901A\u8FC7 pyqtSignal \u89E6\u53D1"),
      bullet("\u5185\u5B58\u72B6\u6001\u66F4\u65B0\u2192 emit signal \u2192 UI\u5237\u65B0 + \u6570\u636E\u5E93\u540C\u6B65\u5199\u5165"),
      bullet("\u4E8B\u4EF6\u7C7B\u578B\uFF1A"),
      subBullet("DEVICE_STATUS_CHANGE: idx + old_status + new_status"),
      subBullet("FINGERPRINT_INJECTED: idx + fingerprint_version + verification_result"),
      subBullet("TASK_PROGRESS: task_id + progress_pct + current_step"),
      subBullet("ACCOUNT_HEALTH_CHANGE: account_id + old_health + new_health"),
      subBullet("PROXY_FAILURE: device_id + proxy_host + failure_reason"),
      subBullet("CONTENT_DEPLOYED: device_id + content_id + "),
      subBullet("SCRM_LEAD_DETECTED: device_id +  + lead_score + keywords"),

      h2("3.4 \u6570\u636E\u4E00\u81F4\u6027\u4FDD\u8BC1"),
      bullet("\u542F\u52A8\u65F6\u5168\u91CF\u6821\u9A8C\uFF1A\u6BD4\u5BF9\u5185\u5B58\u72B6\u6001\u548C\u6570\u636E\u5E93\u72B6\u6001\uFF0C\u4FEE\u590D\u4E0D\u4E00\u81F4"),
      bullet("\u5B9A\u671F\u5168\u91CF\u540C\u6B65\uFF1A\u6BCF10\u5206\u949F\u5F3A\u5236\u5C06\u5185\u5B58\u72B6\u6001flush\u5230\u6570\u636E\u5E93"),
      bullet("\u5D29\u6E83\u6062\u590D\uFF1A\u7A0B\u5E8F\u5D29\u6E83\u91CD\u542F\u540E\u4ECE\u6570\u636E\u5E93\u6062\u590D\u4E0A\u6B21\u72B6\u6001"),
      bullet("\u4E8B\u52A1\u4FDD\u8BC1\uFF1A\u6307\u7EB9\u6CE8\u5165+\u9A8C\u8BC1\u4F5C\u4E3A\u4E00\u4E2A\u539F\u5B50\u4E8B\u52A1\uFF0C\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 4: UI/UX =====
      h1("\u7B2C\u56DB\u7AE0 \u2014 UI/UX\u4EA4\u4E92\u8BBE\u8BA1\uFF08\u5BF9\u6807\u6700\u4F18\u5E03\u5C40\uFF09"),

      h2("4.1 \u5E03\u5C40\u53C2\u8003\uFF1A\u8BBE\u5907\u519C\u573A\u4EEA\u8868\u76D8 (Dashboard)"),
      bullet("\u53C2\u8003 emulator-android + scrcpy-gui \u7684\u8BBE\u5907\u5361\u7247\u8BBE\u8BA1\uFF1A"),
      subBullet("\u6BCF\u5F20\u5361\u7247200\u00D7150px\uFF0C\u663E\u793A\u5B9E\u65F6\u622A\u56FE + \u72B6\u6001\u706F + \u5173\u952E\u4FE1\u606F"),
      subBullet("\u5361\u7247\u70B9\u51FB\u5C55\u5F00\u5230\u8BE6\u60C5\u9762\u677F\uFF08\u5927\u5C4F\u622A\u56FE + \u5168\u90E8\u5C5E\u6027\uFF09"),
      bullet("\u53C2\u8003 n8n/Temporal \u7684\u4EFB\u52A1\u7F16\u6392\u5668\u8BBE\u8BA1\uFF1A"),
      subBullet("\u53EF\u89C6\u5316\u6D41\u7A0B\u56FE\uFF1A\u8282\u70B9+\u8FDE\u7EBF+\u72B6\u6001\u989C\u8272"),
      subBullet("\u62D6\u62FD\u8FDE\u63A5\u6DFB\u52A0\u4EFB\u52A1\u8282\u70B9\uFF0C\u53F3\u952E\u914D\u7F6E\u5C5E\u6027"),
      bullet("\u53C2\u8003 Grafana \u7684\u76D1\u63A7\u4EEA\u8868\u76D8\u8BBE\u8BA1\uFF1A"),
      subBullet("\u5B9E\u65F6\u6570\u636E\u66F2\u7EBF\u56FE + \u4EEA\u8868\u76D8 + \u72B6\u6001\u706F + \u8D8B\u52BF\u7BAD\u5934"),

      h2("4.2 Tab1 \u4E91\u624B\u673A\u7BA1\u7406 \u4EA4\u4E92\u5347\u7EA7"),
      bullet("\u5361\u7247\u53E0\u52A0\u4FE1\u606F\uFF1A\u6307\u7EB9\u6807\u8BB0/\u4EE3\u7406\u56FD\u65D7/\u4F20\u611F\u5668\u72B6\u6001/\u4EFB\u52A1\u8FDB\u5EA6"),
      bullet("\u53CC\u51FB\u5361\u7247\u5C55\u5F00/\u6536\u8D77\u8BE6\u60C5\u9762\u677F\uFF08\u5927\u5C4F\u5B9E\u65F6\u622A\u56FE+\u5168\u90E8\u63A7\u5236\uFF09"),
      bullet("\u53F3\u952E\u4E0A\u4E0B\u6587\u83DC\u5355\uFF1A\u542F\u52A8/\u505C\u6B62/\u6307\u7EB9/\u4EE3\u7406/\u5907\u4EFD/\u8FC1\u79FB/\u5C4F\u5E55\u5F55\u5236"),
      bullet("\u8BBE\u5907\u5206\u7EC4\u529F\u80FD\uFF1A\u6309\u72B6\u6001/\u5730\u57DF/\u4EFB\u52A1/\u81EA\u5B9A\u4E49\u6807\u7B7E\u5206\u7EC4"),
      bullet("\u5168\u5C40\u641C\u7D22\u8FC7\u6EE4\uFF1A\u6309\u7F16\u53F7/\u72B6\u6001/IP\u5730\u5740/\u6807\u7B7E\u5FEB\u901F\u5B9A\u4F4D\u8BBE\u5907"),

      h2("4.3 Tab2 \u6307\u7EB9\u5F15\u64CE \u4EA4\u4E92\u5347\u7EA7"),
      bullet("GPS\u5730\u56FE\u53EF\u89C6\u5316\uFF1A\u5D4C\u5165 Leaflet\u5730\u56FE\u7EC4\u4EF6\uFF0C\u5B9E\u65F6\u663E\u793A\u8BBE\u5907\u4F4D\u7F6E"),
      bullet("\u6307\u7EB9\u7248\u672C\u65F6\u95F4\u7EBF\uFF1A\u7C7B\u4F3CGit commit\u65E5\u5FD7\u53EF\u89C6\u5316\uFF0C\u67E5\u770B\u5386\u53F2\u53D8\u5316"),
      bullet("\u4F20\u611F\u5668\u4EEA\u8868\u76D8\uFF1A\u5B9E\u65F6Gauge\u56FE\u663E\u793A\u7535\u6C60/\u6E29\u5EA6/\u5149\u7EBF/\u538B\u529B"),
      bullet("\u6307\u7EB9\u5BFC\u5165\u5411\u5BFC\uFF1A\u6B65\u9AA4\u5316\u5411\u5BFC\u771F\u5B9E\u8BBE\u5907\u6307\u7EB9\u5BFC\u5165\u6D41\u7A0B"),

      h2("4.4 Tab3 \u62DF\u4EBA\u5316\u5F15\u64CE \u4EA4\u4E92\u5347\u7EA7"),
      bullet("\u89E6\u6478\u8F68\u8FF9\u53EF\u89C6\u5316\uFF1A\u5B9E\u65F6\u663E\u793A\u624B\u6307\u6ED1\u52A8\u8F68\u8FF9Bezier\u66F2\u7EBF"),
      bullet("\u884C\u4E3A\u6A21\u677F\u5E93\u6D4F\u89C8\u5668\uFF1A\u5361\u7247\u5C55\u793A\u9884\u8BBE\u6A21\u677F\uFF0C\u4E00\u952E\u5E94\u7528"),
      bullet("\u5B9E\u65F6\u72B6\u6001\u8FDB\u5EA6\uFF1A\u6BCF\u53F0\u8BBE\u5907\u72EC\u7ACB\u8FDB\u5EA6\u6761+\u9884\u4F30\u5269\u4F59\u65F6\u95F4"),
      bullet("\u5931\u8D25\u6B65\u9AA4\u9AD8\u4EAE+\u4E00\u952E\u91CD\u8BD5"),

      h2("4.5 Tab4 \u8D44\u4EA7\u5185\u5BB9 \u4EA4\u4E92\u5347\u7EA7"),
      bullet("\u5185\u5BB9\u53D8\u4F53\u9884\u89C8\u5361\u7247\uFF1A\u5DE6\u4FA7\u539F\u6587/\u53F3\u4FA7\u53D8\u4F53\u5BF9\u6BD4\u9884\u89C8"),
      bullet("\u53EF\u89C6\u5316\u5185\u5BB9\u65E5\u5386\uFF1A\u6708\u89C6\u56FE\u663E\u793A\u6BCF\u5929\u53D1\u5E03\u8BA1\u5212"),
      bullet("\u8D26\u53F7\u5065\u5EB7\u5206\u6570\u5361\u7247\uFF1A\u7EFF/\u9EC4/\u7EA2\u72B6\u6001\u706F + 0-100\u5206"),
      bullet("\u4E00\u952E\u5206\u53D1\u5230\u6240\u6709\u5728\u7EBF\u8BBE\u5907"),

      h2("4.6 Tab5 SCRM\u4E2D\u53F0 \u4EA4\u4E92\u5347\u7EA7"),
      bullet("\u5B9E\u65F6\u7EBF\u7D22\u8868\uFF1A\u65B0\u7EBF\u7D22\u81EA\u52A8\u5237\u65B0\u641C\u7D22\u63A8\u8350\u3001\u667A\u80FD\u56DE\u590D\u9884\u89C8\u3001\u53D1\u9001\u524D\u786E\u8BA4\u3001\u6548\u679C\u7EDF\u8BA1"),
      bullet("\u6548\u679C\u7EDF\u8BA1\u4EEA\u8868\u76D8\uFF1A\u603B\u622A\u6D41\u6570/\u56DE\u590D\u7387/\u8F6C\u5316\u7387/\u5E73\u5747\u54CD\u5E94\u65F6\u95F4"),
      bullet("\u5173\u952E\u8BCD\u70ED\u529B\u56FE\uFF1A\u8BCD\u4E91\u53EF\u89C6\u5316\u663E\u793A\u5F53\u524D\u70ED\u95E8\u622A\u6D41\u8BCD"),
      bullet("\u8D8B\u52BF\u66F2\u7EBF\u56FE\uFF1A\u6BCF\u5C0F\u65F6/\u6BCF\u5929\u7684\u7EBF\u7D22\u6570\u91CF\u53D8\u5316\u66F2\u7EBF"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 5: ANTI-DETECTION =====
      h1("\u7B2C\u4E94\u7AE0 \u2014 \u53CD\u68C0\u6D4B\u4E0E\u62DF\u4EBA\u5316\u7B56\u7565"),

      h2("5.1 \u591A\u5C42\u7EA7\u53CD\u68C0\u6D4B\u4F53\u7CFB"),
      bullet("L1-\u5C5E\u6027\u5C42\uFF1A\u6E05\u9664ro.boot.qemu\u3001\u79FB\u9664\u865A\u62DF\u8BBE\u5907\u6807\u5FD7\u3001\u89C4\u907F 10.0.2.x"),
      bullet("L2-\u786C\u4EF6\u5C42\uFF1ASamsung\u6307\u7EB9\u7279\u6B8A\u5904\u7406\u3001CPU ABI\u4F2A\u88C5\u3001\u4F20\u611F\u5668\u771F\u5B9E\u5316"),
      bullet("L3-\u884C\u4E3A\u5C42\uFF1A\u4EBA\u7C7B\u5EF6\u8FDF\u6A21\u578B\u3001Bezier\u89E6\u6478\u3001\u968F\u673A\u8BEF\u89E6\u3001\u7596\u52B3\u4F11\u606F"),
      bullet("L4-\u7F51\u7EDC\u5C42\uFF1A\u72EC\u7ACB\u4EE3\u7406**IP**\u3001DNS\u65E0\u6CC4\u6F0F\u3001WebRTC\u7981\u7528"),
      bullet("L5-\u5185\u5BB9\u5C42\uFF1A\u5343\u9762\u6539\u5199\u53BB\u91CD\u3001EXIF\u6E05\u6D17\u3001\u53D1\u5E03\u95F4\u9694\u968F\u673A\u5316"),

      h2("5.2 \u884C\u4E3A\u6A21\u62DF\u53C2\u6570\u8868"),

      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [1800, 1800, 1800, 3626],
        rows: [
          row([headerCell("\u884C\u4E3A\u7C7B\u578B", 1800), headerCell("\u5EF6\u8FDF\u8303\u56F4", 1800), headerCell("\u5206\u5E03\u7C7B\u578B", 1800), headerCell("\u989D\u5916\u968F\u673A\u5316", 3626)]),
          row([cell("\u6D4F\u89C8Feed", 1800), cell("0.5-5s/action", 1800), cell("\u9AD8\u65AF(\u03BC=2.5s)", 1800), cell("\u6BCF5-15\u6B21\u6ED1\u52A8\u505C\u75593-8s\u89C2\u770B \u00B7 \u5076\u5C14\u5FEB\u901F\u8DF3\u8FC7 \u00B7 \u968F\u673A\u56DE\u6EDA", 3626)]),
          row([cell("\u70B9\u8D5E", 1800), cell("0.5-3s\u505C\u7559\u540E", 1800), cell("\u6307\u6570(\u03BB=1s)", 1800), cell("2%\u53CC\u51FB \u00B7 1%\u53D6\u6D88\u518D\u70B9 \u00B7 \u957F\u6309\u540E\u70B9\u8D5E", 3626)]),
          row([cell("\u8BC4\u8BBA", 1800), cell("2-8s\u505C\u7559\u540E", 1800), cell("\u9AD8\u65AF(\u03BC=4s)", 1800), cell("\u5B57\u7B26\u95F4\u9694100-500ms \u00B7 \u968F\u673A\u5220\u9664\u91CD\u6253 \u00B7 emoji\u968F\u673A\u63D2\u5165", 3626)]),
          row([cell("\u5173\u6CE8", 1800), cell("1-5s\u505C\u7559\u540E", 1800), cell("\u9AD8\u65AF(\u03BC=2s)", 1800), cell("3%\u5173\u6CE8\u540E\u53D6\u6D88 \u00B7 \u67E5\u770B\u4E3B\u9875\u540E\u518D\u5173\u6CE8", 3626)]),
          row([cell("\u641C\u7D22", 1800), cell("\u6BCF\u5B57\u7B26100-500ms", 1800), cell("\u6307\u6570(\u03BB=200ms)", 1800), cell("\u968F\u673A\u505C\u987F\u601D\u8003 \u00B7 \u6253\u5B57\u540E\u505C\u7559\u518D\u641C\u7D22", 3626)]),
          row([cell("\u4F11\u606F", 1800), cell("2-10\u5206\u949F", 1800), cell("\u9AD8\u65AF(\u03BC=5min)", 1800), cell("\u6BCF15-30\u5206\u949F\u4F11\u606F\u4E00\u6B21 \u00B7 \u4F11\u606F\u65F6\u95F4\u968F\u6D3B\u52A8\u65F6\u957F\u9012\u589E", 3626)]),
        ]
      }),

      h2("5.3 \u53EF\u4F2A\u88C5 vs \u4E0D\u53EF\u4F2A\u88C5\u6E05\u5355"),
      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [4513, 4513],
        rows: [
          row([headerCell("\u2705 \u53EF\u4F2A\u88C5", 4513), headerCell("\u274C \u4E0D\u53EF\u4F2A\u88C5 / \u9700\u8981\u6CE8\u610F", 4513)]),
          row([cell("ro.product.* \u5C5E\u6027\u3001Build Fingerprint\u3001IMEI / Android ID\u3001GPS\u5750\u6807\u3001\u7535\u6C60/\u4F20\u611F\u5668\u6570\u636E\u3001MAC\u5730\u5740(Android 10+)\u3001\u7F51\u7EDC\u7C7B\u578B\u6807\u7B7E", 4513), cell("Samsung One UI\u884C\u4E3A / Knox API\u3001ro.boot.verifiedbootstate\u3001\u57FA\u5E26/\u8C03\u5236\u89E3\u8C03\u5668\u3001\u771F\u5B9E\u57FA\u7AD9/WiFi\u5B9A\u4F4D\u3001\u7269\u7406\u4F20\u611F\u5668\u77B5\u3001\u5185\u6838\u7EA7\u786C\u4EF6 MAC\u3001\u771F\u5B9E\u8FD0\u8425\u5546\u6CE8\u518C", 4513)]),
        ]
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== CHAPTER 6: Roadmap =====
      h1("\u7B2C\u516D\u7AE0 \u2014 \u5B9E\u65BD\u8DEF\u7EBF\u4E0E\u6280\u672F\u53EF\u884C\u6027"),

      h2("6.1 \u5206\u9636\u6BB5\u4EA4\u4ED8\u8BA1\u5212"),
      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [1400, 3000, 2000, 2626],
        rows: [
          row([headerCell("\u9636\u6BB5", 1400), headerCell("\u5185\u5BB9", 3000), headerCell("\u65B0\u589E\u4EE3\u7801\u91CF", 2000), headerCell("\u4EA4\u4ED8\u7269", 2626)]),
          row([cell("Phase 1", 1400, {bold:true}), cell("\u4E8B\u4EF6\u603B\u7EBF+ \u72B6\u6001\u673A+ \u914D\u7F6E\u4E2D\u5FC3+ \u591A\u5C42\u7EA7\u7F13\u5B58", 3000), cell("~800\u884C", 2000), cell("\u57FA\u7840\u67B6\u6784\u53EF\u7528", 2626)]),
          row([cell("Phase 2", 1400, {bold:true}), cell("DAG\u5DE5\u4F5C\u6D41\u5F15\u64CE+ \u5B9A\u65F6\u8C03\u5EA6\u5668+ \u65AD\u70B9\u7EED\u4F20", 3000), cell("~600\u884C", 2000), cell("\u4EFB\u52A1\u7F16\u6392\u53EF\u7528", 2626)]),
          row([cell("Phase 3", 1400, {bold:true}), cell("10\u4E2A\u6D41\u7A0B\u5168\u94FE\u8DEF\u96C6\u6210\uFF08\u542F\u52A8\u2192\u6307\u7EB9\u2192GPS\u2192\u517B\u53F7\u2192Session\u2192\u5185\u5BB9\u2192SCRM\u2192\u4EE3\u7406\u2192\u4F20\u611F\u5668\u2192\u7F16\u6392\uFF09", 3000), cell("~1500\u884C", 2000), cell("\u5168\u6D41\u7A0B\u53EF\u7528", 2626)]),
          row([cell("Phase 4", 1400, {bold:true}), cell("UI\u4EA4\u4E92\u5347\u7EA7\uFF08\u4EEA\u8868\u76D8/\u5730\u56FE/\u8F68\u8FF9/\u65E5\u5386/\u7EDF\u8BA1\u56FE\u8868\uFF09", 3000), cell("~800\u884C", 2000), cell("\u5B8C\u6574UI\u4EA4\u4ED8", 2626)]),
          row([cell("Phase 5", 1400, {bold:true}), cell("\u6D4B\u8BD5+ \u6253\u5305+ \u90E8\u7F72\u9A8C\u8BC1", 3000), cell("~300\u884C", 2000), cell("v14.exe\u53EF\u7528", 2626)]),
        ]
      }),

      h2("6.2 \u6280\u672F\u53EF\u884C\u6027\u786E\u8BA4"),
      new Table({
        width: { size: tblW, type: WidthType.DXA },
        columnWidths: [3000, 2000, 4026],
        rows: [
          row([headerCell("\u6280\u672F\u70B9", 3000), headerCell("\u53EF\u884C\u6027", 2000), headerCell("\u5173\u952E\u4F9D\u8D56", 4026)]),
          row([cell("DAG\u4EFB\u52A1\u7F16\u6392", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("Python dict + \u81EA\u5B9E\u73B0\u62D3\u6251\u6392\u5E8F\uFF0C\u65E0\u9700\u5916\u90E8\u4F9D\u8D56", 4026)]),
          row([cell("\u6307\u7EB9\u7248\u672C\u7BA1\u7406", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("SQLite\u8868 + JSON snapshot\uFF0C\u5DF2\u9A8C\u8BC1\u53EF\u884C", 4026)]),
          row([cell("\u5468\u671F\u6027\u6307\u7EB9\u5FAE\u8C03", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("QTimer + \u968F\u673A\u7B97\u6CD5\uFF0C\u53C2\u8003 emulator-android Jitter \u5B9E\u73B0", 4026)]),
          row([cell("GPS\u8F68\u8FF9+\u5730\u56FE\u53EF\u89C6\u5316", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("\u5D4C\u5165 Leaflet\u7F51\u9875 + QWebEngineView\uFF0CHaversine + Bezier\u8BA1\u7B97", 4026)]),
          row([cell("\u4EBA\u7C7B\u5EF6\u8FDF\u6A21\u578B", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("numpy random\u5206\u5E03\uFF0C\u5DF2\u9A8C\u8BC1Gaussian+Exponential\u6DF7\u5408", 4026)]),
          row([cell("AI\u5185\u5BB9\u5343\u9762\u6539\u5199", 3000), cell("\u26A0 \u53D7\u9650", 2000), cell("\u9700\u8981\u5916\u90E8AI API\u6216\u672C\u5730\u6A21\u578B\uFF0C\u5F53\u524D\u7528\u89C4\u5219\u66FF\u4EE3\u53EF\u884C", 4026)]),
          row([cell("\u53CD\u68C0\u6D4B\u5C5E\u6027\u6CE8\u5165", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("ADB service call / settings put\uFF0C\u5DF2\u5728\u4F7F\u7528\u4E2D", 4026)]),
          row([cell("\u591A\u8BBE\u5907\u5E76\u53D1\u63A7\u5236", 3000), cell("\u2705 \u53EF\u884C", 2000), cell("QThread + ThreadPoolExecutor\uFF0C\u5DF2\u9A8C\u8BC1\u53EF\u884C", 4026)]),
        ]
      }),

      h2("6.3 \u98CE\u9669\u4E0E\u7F13\u89E3\u63AA\u65BD"),
      bullet("\u98CE\u96691\uFF1AAI\u5185\u5BB9\u6539\u5199\u8D28\u91CF\u4F9D\u8D56\u5916\u90E8API"),
      subBullet("\u7F13\u89E3\uFF1A\u989D\u5916\u5B9E\u73B0\u89C4\u5219\u5F15\u64CE\u964D\u7EA7\u65B9\u6848\uFF0C\u786E\u4FDD\u79BB\u7EBF\u53EF\u7528"),
      bullet("\u98CE\u96692\uFF1A50\u53F0\u8BBE\u5907\u540C\u65F6\u5728\u7EBF\u5185\u5B58\u538B\u529B"),
      subBullet("\u7F13\u89E3\uFF1A\u52A8\u6001\u5185\u5B58\u611F\u77E5+\u81EA\u52A8\u8C03\u6574\u6279\u6B21\u5927\u5C0F\uFF0C\u786E\u4FDD\u4E0D\u8D85\u8FC780%\u5185\u5B58\u4F7F\u7528\u7387"),
      bullet("\u98CE\u96693\uFF1A\u5E73\u53F0\u53CD\u68C0\u6D4B\u7B56\u7565\u6301\u7EED\u5347\u7EA7"),
      subBullet("\u7F13\u89E3\uFF1A\u53EF\u914D\u7F6E\u5316\u53CD\u68C0\u6D4B\u89C4\u5219\u5F15\u64CE\uFF0C\u652F\u6301hot-reload\u89C4\u5219\u6587\u4EF6"),
      bullet("\u98CE\u96694\uFF1A\u53D8\u4F53\u53BB\u91CD\u7B97\u6CD5\u7CBE\u5EA6\u4E0D\u8DB3"),
      subBullet("\u7F13\u89E3\uFF1AJaccard+Levenshtein\u4E24\u91CD\u6821\u9A8C\uFF0C\u989D\u5916\u53EF\u914D\u7F6E\u76F8\u4F3C\u5EA6\u9608\u503C"),

      new Paragraph({ spacing: { before: 600 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: "E94560", space: 8 } },
        spacing: { before: 200 },
        children: [
          new TextRun({ text: "\u2014 \u65B9\u6848\u7ED3\u675F \u2014", font: "Microsoft YaHei", size: 16, color: "808080" }),
          new TextRun({ text: "\n\n\u8BF7\u786E\u8BA4\u540E\u7ACB\u5373\u6267\u884C\u5F00\u53D1", font: "Microsoft YaHei", size: 18, color: "E94560", bold: true }),
        ]
      }),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/MSCMS_v14_全链路自动化详细规划方案.docx", buffer);
  console.log("Document generated successfully!");
});
