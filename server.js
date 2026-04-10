import express from "express";
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// JSZip for bundling multiple PDFs into a zip
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ─── Find Chrome ──────────────────────────────────────────────
function findChromeExecutable() {
  const base = "/opt/render/project/.chrome";

  function walk(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      }
      if (entry.isFile() && entry.name === "chrome") {
        return full;
      }
    }
    return null;
  }

  return walk(base);
}

// ─── Launch browser ───────────────────────────────────────────
async function launchBrowser() {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error("Chrome executable not found in /opt/render/project/.chrome");
  }
  return await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
}

// ─── Generate one PDF from a template ────────────────────────
async function renderTemplateToPdf(browser, templatePath, data) {
  let html = fs.readFileSync(templatePath, "utf8");

  // Replace all {{key}} placeholders with data values
  // Also handle nested meal data like {{breakfast_calories}} etc.
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (typeof value === "object" && value !== null) {
      // Flatten nested objects — e.g. meals array
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item.meal) {
            Object.keys(item).forEach((subKey) => {
              html = html.replaceAll(`{{${item.meal}_${subKey}}}`, item[subKey] ?? "");
            });
          }
        });
      } else {
        Object.keys(value).forEach((subKey) => {
          html = html.replaceAll(`{{${key}_${subKey}}}`, value[subKey] ?? "");
        });
      }
    } else {
      html = html.replaceAll(`{{${key}}}`, value ?? "");
    }
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true
  });
  await page.close();

  if (!pdf || pdf.length < 1000) {
    throw new Error(`PDF generation failed for template: ${templatePath}`);
  }

  return pdf;
}

// ─── Health check ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ─── Generate single PDF ──────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  let browser;
  try {
    const data = req.body;

    const templateMap = {
      pcos_veg: "templates/pcos_veg_template.html",
      pcos_nonveg: "templates/pcos_nonveg_template.html",
      basic_veg: "templates/basic_veg_template.html",
      basic_nonveg: "templates/basic_nonveg_template.html"
    };

    const templatePath = templateMap[data.plan_type];
    if (!templatePath) {
      return res.status(400).json({ error: `Invalid plan_type: ${data.plan_type}` });
    }

    browser = await launchBrowser();
    const pdf = await renderTemplateToPdf(browser, templatePath, data);

    res.set({ "Content-Type": "application/pdf" });
    res.send(pdf);

  } catch (err) {
    console.error("generate-pdf error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Generate bundle (Pro+ plan) ─────────────────────────────
// Returns a ZIP file containing:
//   - Diet plan PDF (pcos_veg or pcos_nonveg template)
//   - All 9 document PDFs (document_00 through document_08)
app.post("/generate-bundle", async (req, res) => {
  let browser;
  try {
    const data = req.body;

    const dietTemplateMap = {
      pcos_veg: "templates/pcos_veg_template.html",
      pcos_nonveg: "templates/pcos_nonveg_template.html",
    };

    const dietTemplatePath = dietTemplateMap[data.plan_type];
    if (!dietTemplatePath) {
      return res.status(400).json({ error: `Invalid plan_type for bundle: ${data.plan_type}` });
    }

    // Document templates — static, no placeholder replacement needed
    const documentTemplates = [
      { file: "templates/doc_00_letter_from_asha.html",     name: "Doc-00-A-Letter-From-Asha.pdf" },
      { file: "templates/doc_01_pcos_playbook.html",         name: "Doc-01-The-PCOS-Playbook.pdf" },
      { file: "templates/doc_02_thyroid_decoded.html",       name: "Doc-02-The-Thyroid-Decoded.pdf" },
      { file: "templates/doc_03_insulin_reset.html",         name: "Doc-03-The-Insulin-Reset.pdf" },
      { file: "templates/doc_04_cortisol_code.html",         name: "Doc-04-The-Cortisol-Code.pdf" },
      { file: "templates/doc_05_gut_liver_reset.html",       name: "Doc-05-The-Gut-Liver-Reset.pdf" },
      { file: "templates/doc_06_khanaplan_complete.html",    name: "Doc-06-KhanaPlan-Complete-Guide.pdf" },
      { file: "templates/doc_07_hormone_tracker.html",         name: "Doc-07-Your-Hormone-Tracker.pdf" },
      { file: "templates/doc_08_progress_tracker.html",      name: "Doc-08-My-Body-My-Progress-Tracker.pdf" },
    ];

    browser = await launchBrowser();
    const zip = new JSZip();

    // ── Generate diet plan PDF ────────────────────────────────
    console.log("Generating diet plan PDF...");
    const dietPdf = await renderTemplateToPdf(browser, dietTemplatePath, data);
    zip.file("Document-09-Your-Personalised-PCOS-Diet-Plan.pdf", dietPdf);
    console.log("Diet plan PDF done.");

    // ── Generate each document PDF ────────────────────────────
    for (const doc of documentTemplates) {
      if (!fs.existsSync(doc.file)) {
        console.warn(`Template not found, skipping: ${doc.file}`);
        continue;
      }
      console.log(`Generating: ${doc.name}`);
      // Documents are static — pass minimal data for any {{customer_name}} placeholders
      const docPdf = await renderTemplateToPdf(browser, doc.file, {
        customer_name: data.customer_name,
        email: data.email,
      });
      zip.file(doc.name, docPdf);
      console.log(`Done: ${doc.name}`);
    }

    // ── Create zip buffer ─────────────────────────────────────
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    console.log("Bundle ZIP created:", zipBuffer.length, "bytes");

    res.set({ "Content-Type": "application/zip" });
    res.send(zipBuffer);

  } catch (err) {
    console.error("generate-bundle error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("KhanaPlan PDF server running on port", PORT);
});
