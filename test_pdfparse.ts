import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParseMod = require("pdf-parse");

function render_page(pageData: any) {
    let render_options = { normalizeWhitespace: false, disableCombineTextItems: false };
    return pageData.getTextContent(render_options).then(function(textContent: any) {
        let lastY = -1;
        let lastX = -1;
        let lastW = 0;
        let text = '';
        for (let item of textContent.items) {
            let currentX = item.transform[4];
            let currentY = item.transform[5];
            let width = item.width;
            
            if (lastY == currentY || !lastY) {
                // If on same line, only add space if gap is larger than width of space
                if (lastX !== -1 && (currentX - (lastX + lastW)) > 5) {
                    text += ' ' + item.str;
                } else {
                    text += item.str;
                }
            } else {
                text += '\n' + item.str;
            }
            lastY = currentY;
            lastX = currentX;
            lastW = width;
        }
        return text;
    });
}
const pdfFilePath = "C:/Users/Rahul/.gemini/antigravity-ide/brain/4318f4ae-05f0-4901-b246-9352918b664c/.user_uploaded/media_1788098566498.pdf";
const buffer = fs.readFileSync(pdfFilePath);

pdfParseMod(buffer, { pagerender: render_page })
  .then((data: any) => {
    console.log("----- PDF-PARSE OUTPUT -----");
    console.log(data.text);
    console.log("----------------------------");
  })
  .catch((err: any) => {
    console.error("PDF-PARSE ERROR:", err);
  });

