// Simulate the exact current parseReceiptText logic on the actual PDF
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

function render_page(pageData: any) {
  let render_options = { normalizeWhitespace: false, disableCombineTextItems: false };
  return pageData.getTextContent(render_options).then(function(textContent: any) {
    let lastY = -1, lastX = -1, lastW = 0, text = '';
    for (let item of textContent.items) {
      let currentX = item.transform[4], currentY = item.transform[5], width = item.width;
      if (lastY == currentY || !lastY) {
        if (lastX !== -1 && (currentX - (lastX + lastW)) > 5) text += ' ' + item.str;
        else text += item.str;
      } else { text += '\n' + item.str; }
      lastY = currentY; lastX = currentX; lastW = width;
    }
    return text;
  });
}

const pdfFilePath = "C:/Users/Rahul/.gemini/antigravity-ide/brain/4318f4ae-05f0-4901-b246-9352918b664c/.user_uploaded/media_1788098566498.pdf";
const buffer = fs.readFileSync(pdfFilePath);

pdfParse(buffer, { pagerender: render_page }).then((data: any) => {
  const text = data.text ?? "";
  const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);

  console.log("=== LINES ARRAY ===");
  lines.forEach((l: string, i: number) => console.log(`${i}: "${l}"`));

  const billFromIdx = lines.findIndex((l: string) => /bill\s+(from|to)/i.test(l));
  console.log(`\nbillFromIdx = ${billFromIdx}  => "${lines[billFromIdx]}"`);

  let customer_name = null, customer_mobile = null;
  if (billFromIdx !== -1) {
    const nameLine = lines[billFromIdx + 1];
    if (nameLine && !/mobile|phone|address|₹/i.test(nameLine)) customer_name = nameLine;
    
    for (let i = billFromIdx + 1; i <= Math.min(billFromIdx + 5, lines.length - 1); i++) {
      const rawLine = lines[i];
      const cleanLine = rawLine.replace(/^(mobile|phone)\s*[:\-]?\s*/i, '');
      const mobileMatch = cleanLine.match(/(\d{10})/);
      console.log(`  Checking line ${i}: "${rawLine}" → clean: "${cleanLine}" → match: ${mobileMatch?.[1] ?? 'none'}`);
      if (mobileMatch) { customer_mobile = mobileMatch[1]; break; }
    }
  }

  console.log(`\nResult: name="${customer_name}", mobile="${customer_mobile}"`);
});
