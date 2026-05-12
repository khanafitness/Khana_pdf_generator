import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// JSZip for bundling multiple PDFs into a zip
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ─── Launch browser ───────────────────────────────────────────
async function launchBrowser() {
  return await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });
}


// ─── Generate one PDF from a template ────────────────────────
async function renderTemplateToPdf(browser, templatePath, data, landscape = false) {
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
  //await page.setContent(html, { waitUntil: "networkidle0" });
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const pdf = await page.pdf({
    format: "A4",
    landscape: landscape,
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
    const pdf = await renderTemplateToPdf(browser, templatePath, data, true); // diet charts → landscape

    res.set({ "Content-Type": "application/pdf" });
    res.send(pdf);

  } catch (err) {
    console.error("generate-pdf error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Generate plus bundle (Plus plan) ────────────────────────
// Returns a ZIP file containing:
//   - Diet plan PDF (pcos_veg or pcos_nonveg template)
//   - Doc-01-The-PCOS-Playbook
//   - Doc-08-My-Body-My-Progress-Tracker
app.post("/generate-plus", async (req, res) => {
  let browser;
  try {
    const data = req.body;

    const dietTemplateMap = {
      pcos_veg: "templates/pcos_veg_template.html",
      pcos_nonveg: "templates/pcos_nonveg_template.html",
    };

    const dietTemplatePath = dietTemplateMap[data.plan_type];
    if (!dietTemplatePath) {
      return res.status(400).json({ error: `Invalid plan_type for plus bundle: ${data.plan_type}` });
    }

    const plusDocTemplates = [
      { file: "templates/doc_01_pcos_playbook.html",    name: "Doc-01-The-PCOS-Playbook.pdf" },
      { file: "templates/doc_08_progress_tracker.html", name: "Doc-08-My-Body-My-Progress-Tracker.pdf" },
    ];

    browser = await launchBrowser();
    const zip = new JSZip();

    // ── Generate diet plan PDF (landscape) ───────────────────
    console.log("Generating plus diet plan PDF...");
    const dietPdf = await renderTemplateToPdf(browser, dietTemplatePath, data, true);
    zip.file("Doc-02-Your-Personalised-PCOS-Diet-Plan.pdf", dietPdf);
    console.log("Diet plan PDF done.");

    // ── Generate the 2 document PDFs (portrait) ──────────────
    for (const doc of plusDocTemplates) {
      if (!fs.existsSync(doc.file)) {
        console.warn(`Template not found, skipping: ${doc.file}`);
        continue;
      }
      console.log(`Generating: ${doc.name}`);
      const docPdf = await renderTemplateToPdf(browser, doc.file, {
        customer_name: data.customer_name,
        email: data.email,
        mobile_number: data.mobile_number,
      });
      zip.file(doc.name, docPdf);
      console.log(`Done: ${doc.name}`);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    console.log("Plus bundle ZIP created:", zipBuffer.length, "bytes");

    res.set({ "Content-Type": "application/zip" });
    res.send(zipBuffer);

  } catch (err) {
    console.error("generate-plus error:", err);
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

    // ── Generate diet plan PDF (landscape) ───────────────────
    console.log("Generating diet plan PDF...");
    const dietPdf = await renderTemplateToPdf(browser, dietTemplatePath, data, true); // landscape
    zip.file("Doc-09-Your-Personalised-PCOS-Diet-Plan.pdf", dietPdf);
    console.log("Diet plan PDF done.");

    // ── Generate each document PDF (portrait) ────────────────
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
        mobile_number: data.mobile_number,
      }); // landscape defaults to false → portrait
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
//
// ─── Generate Salary Formula PDF ─────────────────────────────
// Add this route to KhanaPlan's server.js before the app.listen line

app.post("/generate-salary-pdf", async (req, res) => {
  let browser;
  try {
    const data = req.body;

    if (!data.customer_name || !data.email || !data.mobile_number) {
      return res.status(400).json({ error: "Missing required fields: customer_name, email, mobile_number" });
    }

    const templatePath = "templates/salary_formula_template.html";
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ error: "Template not found: salary_formula_template.html" });
    }

    console.log("Generating Salary Formula PDF for:", data.customer_name);
    browser = await launchBrowser();

    let html = fs.readFileSync(templatePath, "utf8");
    html = html
      .replace(/\{\{CUSTOMER_NAME\}\}/g, data.customer_name || "")
      .replace(/\{\{EMAIL\}\}/g,         data.email         || "")
      .replace(/\{\{MOBILE_NO\}\}/g,     data.mobile_number || "");

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" }
    });
    await page.close();

    if (!pdf || pdf.length < 1000) {
      throw new Error("PDF generation failed — output too small");
    }

    console.log("Salary Formula PDF generated:", pdf.length, "bytes");

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="The-Salary-Formula-${data.customer_name.replace(/\s+/g, "-")}.pdf"`
    });
    res.send(pdf);

  } catch (err) {
    console.error("generate-salary-pdf error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});
//

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("KhanaPlan PDF server running on port", PORT);
});
