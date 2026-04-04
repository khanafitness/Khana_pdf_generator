import express from "express";
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ✅ FINAL: find chrome inside Render absolute path
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
//Wake up render
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" })
})

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
      return res.status(400).json({ error: "Invalid plan_type" });
    }

    let html = fs.readFileSync(templatePath, "utf8");

    // ✅ Safe placeholder replace
    Object.keys(data).forEach((key) => {
      html = html.replaceAll(`{{${key}}}`, data[key] ?? "");
    });

    const executablePath = findChromeExecutable();

    if (!executablePath) {
      throw new Error("Chrome executable not found in /opt/render/project/.chrome");
    }

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0"
    });

    const pdf = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true
    });

    if (!pdf || pdf.length < 1000) {
      throw new Error("PDF generation failed");
    }

    res.set({
      "Content-Type": "application/pdf"
    });

    res.send(pdf);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("PDF server running on port", PORT);
});
