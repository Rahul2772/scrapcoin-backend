import { createRequire } from "module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");



const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function testPdfParse() {
  try {
    // 1. Get the most recent receipt from DB
    const { data, error } = await supabase
      .from("telegram_ingested_receipts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) {
      console.error("Failed to fetch receipt from DB", error);
      return;
    }

    const receipt = data[0];
    console.log("Found receipt:", receipt.id, "Path:", receipt.pdf_storage_path);

    if (!receipt.pdf_storage_path) {
      console.error("No pdf_storage_path found");
      return;
    }

    // 2. Download the PDF from Supabase storage
    const { data: fileData, error: fileError } = await supabase
      .storage
      .from("invoices")
      .download(receipt.pdf_storage_path);

    if (fileError || !fileData) {
      console.error("Failed to download PDF", fileError);
      return;
    }

    // 3. Parse it
    const buffer = Buffer.from(await fileData.arrayBuffer());
    console.log("Downloaded PDF size:", buffer.length, "bytes");

    try {
      const pdfData = await pdfParse(buffer);
      console.log("----- PDF PARSE OUTPUT -----");
      console.log(pdfData.text);
      console.log("----------------------------");
    } catch (parseErr) {
      console.error("pdf-parse threw an error:", parseErr);
    }
  } catch (e) {
    console.error("Script error:", e);
  }
}

testPdfParse();
