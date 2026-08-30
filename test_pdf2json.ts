import fs from "fs";
import PDFParser from "pdf2json";

const pdfFilePath = "C:/Users/Rahul/.gemini/antigravity-ide/brain/4318f4ae-05f0-4901-b246-9352918b664c/.user_uploaded/media_1788098566498.pdf";

const pdfParser = new PDFParser(this, 1);

pdfParser.on("pdfParser_dataError", (errData) => console.error(errData.parserError));
pdfParser.on("pdfParser_dataReady", (pdfData) => {
  const rawText = pdfParser.getRawTextContent();
  console.log("----- RAW TEXT CONTENT -----");
  console.log(rawText);
  console.log("----------------------------");
});

pdfParser.loadPDF(pdfFilePath);
