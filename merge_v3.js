// Merge script: reads v2 chapters and renumbers them for v3 integration
const fs = require("fs");

// Read the new v3 script (has Chapter 1 only)
let v3 = fs.readFileSync("v14_comprehensive_v3.js", "utf8");

// Read the old v2 script
let v2 = fs.readFileSync("v14_ai_content_plan.js", "utf8");

// Extract the chapter content from v2 (everything after "CHAPTER 1" heading)
// Find the first chapter content start (the actual chapter 1 heading push)
const chapStartMarker = "// CHAPTER 1: Content Intelligence Engine";
const chapStartIdx = v2.indexOf(chapStartMarker);
if (chapStartIdx === -1) {
  console.error("Could not find chapter start marker in v2 script");
  process.exit(1);
}

// Find where the document build/packer happens at the end
const packerIdx = v2.lastIndexOf("const doc = new Document(");
if (packerIdx === -1) {
  console.error("Could not find document creation in v2 script");
  process.exit(1);
}

// Extract the chapter push statements
let chapContent = v2.substring(chapStartIdx, packerIdx);

// Renumber chapters: old Ch1→Ch2, Ch2→Ch3, ..., Ch8→Ch9
// Chapter headings
chapContent = chapContent.replace(/第(.)章/g, (match, num) => {
  const map = { "一": "二", "二": "三", "三": "四", "四": "五", "五": "六", "六": "七", "七": "八", "八": "九" };
  return "第" + (map[num] || num) + "章";
});

// Section numbering: need to increment section major numbers
// Pattern: "n.n" where n is the chapter number 1-8 → 2-9
chapContent = chapContent.replace(/h2\("(\d)\.(\d)/g, (match, ch, sec) => {
  const newCh = parseInt(ch) + 1;
  return 'h2("' + newCh + '.' + sec;
});
chapContent = chapContent.replace(/h3\("(\d)\.(\d)/g, (match, ch, sec) => {
  const newCh = parseInt(ch) + 1;
  return 'h3("' + newCh + '.' + sec;
});
// Also handle h3 with triple-digit like "1.1.1"
chapContent = chapContent.replace(/h3\("(\d)\.(\d)\.(\d)/g, (match, ch, s1, s2) => {
  const newCh = parseInt(ch) + 1;
  return 'h3("' + newCh + '.' + s1 + '.' + s2;
});

// Replace text references like "第X章" in paragraphs
chapContent = chapContent.replace(/第(.)章\s/g, (match, num) => {
  const map = { "一": "二", "二": "三", "三": "四", "四": "五", "五": "六", "六": "七", "七": "八", "八": "九" };
  return "第" + (map[num] || num) + "章 ";
});

// Replace "CHAPTER X:" comments
chapContent = chapContent.replace(/CHAPTER (\d):/g, (match, num) => {
  return "CHAPTER " + (parseInt(num) + 1) + ":";
});

// Reference numbers in text like "2.1" etc - only standalone patterns
chapContent = chapContent.replace(/(\d)\.(\d)\.(\d)\s/g, (match, ch, s1, s2) => {
  const newCh = parseInt(ch) + 1;
  if (newCh <= 9) return newCh + '.' + s1 + '.' + s2 + ' ';
  return match;
});

// Now insert the chapter content into v3
// Find where to insert (before the closing console.log and document creation)
const insertMarker = "// Build and save";
const insertIdx = v3.lastIndexOf(insertMarker);
if (insertIdx === -1) {
  console.error("Could not find insertion point in v3 script");
  process.exit(1);
}

// Insert the chapter content + a blank line before the build section
v3 = v3.substring(0, insertIdx) + 
  "\n// ============================================================\n" +
  "// INTEGRATED CHAPTERS 2-9 (from v2 with renumbering)\n" +
  "// ============================================================\n" +
  chapContent + "\n\n" +
  v3.substring(insertIdx);

// Update the document title and filename
v3 = v3.replace(
  "MSCMS_v14_智能养号_AI内容_自主进化引流系统_综合精细化方案_v3.docx",
  "MSCMS_v14_智能养号_AI内容_自主进化引流系统_综合精细化方案_v3.docx"
);

// Write the merged script
fs.writeFileSync("v14_comprehensive_v3.js", v3);
console.log("Merge complete! Merged script written to v14_comprehensive_v3.js");
