import { jsPDF } from "jspdf";
import {
  Chart,
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import { addGeistFont } from "./geist-font-loader";

// Register Chart.js components
Chart.register(
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
);

// Register font for node-canvas (server-side only)
let fontRegistered = false;
let registeredFontFamily = "sans-serif"; // fallback

function ensureFontRegistered(): string {
  if (typeof document !== "undefined") {
    // Browser environment - fonts work normally
    return "Arial, Helvetica, sans-serif";
  }

  if (fontRegistered) {
    return registeredFontFamily;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFont } = require("canvas");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");

    // First try local Geist fonts (bundled with the app)
    // __dirname points to the compiled output directory, but we need to handle both dev and prod
    const possibleBasePaths = [
      path.join(__dirname, "Geist", "static"), // When running from dist
      path.join(__dirname, "..", "src", "pdv-report", "Geist", "static"), // From project root dist
      path.join(process.cwd(), "src", "pdv-report", "Geist", "static"), // From cwd
      path.join(process.cwd(), "dist", "pdv-report", "Geist", "static"), // From cwd dist
    ];

    // Local Geist fonts (preferred)
    const localFontFiles = [
      { file: "Geist-Regular.ttf", family: "Geist", weight: "normal" },
      { file: "Geist-Medium.ttf", family: "Geist", weight: "500" },
      { file: "Geist-Bold.ttf", family: "Geist", weight: "bold" },
    ];

    // Try to find and register local Geist fonts
    for (const basePath of possibleBasePaths) {
      console.log(`🔍 [PDF-Generator] Checking font path: ${basePath}`);
      if (fs.existsSync(basePath)) {
        let fontsRegistered = 0;
        for (const { file, family, weight } of localFontFiles) {
          const fontPath = path.join(basePath, file);
          try {
            if (fs.existsSync(fontPath)) {
              registerFont(fontPath, { family: "ChartFont", weight });
              console.log(`✅ [PDF-Generator] Registered local font "${family} ${weight}" from: ${fontPath}`);
              fontsRegistered++;
            }
          } catch (err) {
            console.log(`⚠️ [PDF-Generator] Failed to register font from ${fontPath}:`, err);
          }
        }
        if (fontsRegistered > 0) {
          fontRegistered = true;
          registeredFontFamily = "ChartFont";
          console.log(`✅ [PDF-Generator] Successfully registered ${fontsRegistered} Geist font variants`);
          return registeredFontFamily;
        }
      }
    }

    console.warn("⚠️ [PDF-Generator] Local Geist fonts not found, trying system fonts...");

    // Fallback to system fonts
    const systemFontPaths = [
      // Linux (Debian/Ubuntu)
      { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "DejaVu Sans" },
      { path: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", family: "Liberation Sans" },
      { path: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", family: "FreeSans" },
      // Linux (Fedora/RHEL)
      { path: "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", family: "DejaVu Sans" },
      // macOS
      { path: "/System/Library/Fonts/Helvetica.ttc", family: "Helvetica" },
      { path: "/Library/Fonts/Arial.ttf", family: "Arial" },
      // Windows
      { path: "C:\\Windows\\Fonts\\arial.ttf", family: "Arial" },
      { path: "C:\\Windows\\Fonts\\calibri.ttf", family: "Calibri" },
    ];

    for (const { path: fontPath, family } of systemFontPaths) {
      try {
        if (fs.existsSync(fontPath)) {
          registerFont(fontPath, { family: "ChartFont" });
          console.log(`✅ [PDF-Generator] Registered system font "${family}" from: ${fontPath}`);
          fontRegistered = true;
          registeredFontFamily = "ChartFont";
          return registeredFontFamily;
        }
      } catch (err) {
        console.log(`⚠️ [PDF-Generator] Failed to register font from ${fontPath}:`, err);
        continue;
      }
    }

    console.warn("⚠️ [PDF-Generator] No suitable font found. Chart text may not render correctly.");
  } catch (err) {
    console.error("❌ [PDF-Generator] Error during font registration:", err);
  }

  fontRegistered = true; // Mark as attempted to avoid repeated tries
  return "sans-serif";
}

// Get the font family to use for charts
const chartFontFamily = ensureFontRegistered();
console.log(`📝 [PDF-Generator] Using chart font family: ${chartFontFamily}`);

// Set global default font for Chart.js
Chart.defaults.font.family = chartFontFamily;
Chart.defaults.font.size = 12;

// Pixel conversion constants (1mm ≈ 3.78px at 96 DPI)
const PX_PER_MM = 3.78;
const PAGE_WIDTH_PX = 210 * PX_PER_MM; // 793.7px
const MARGIN_PX = 20 * PX_PER_MM; // 75.6px
const CENTER_X_PX = PAGE_WIDTH_PX / 2; // 396.85px

// Helper function to create canvas - works in both browser and Node.js
function createCanvas(width: number, height: number): HTMLCanvasElement {
  // Check if we're in a browser environment
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  } else {
    // Server-side: use node-canvas
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCanvas } = require("canvas");
    return createCanvas(width, height) as HTMLCanvasElement;
  }
}

interface PreADVData {
  overview: string;
  dataReliance: string;
  dataAttribute: string;
  dataUniqueness: string;
  dataScarcity: string;
  dataOwnership: string;
  sectorReliance: string;
  dataCollection: string;
  summary: {
    summary: string;
    competitiveAdvantages: string[];
    dataProfileTable: Array<{
      dataMetric: string;
      estimate: string;
      strategicSignificance: string;
    }>;
  };
}

interface SupplementaryData {
  sectorName: string;
  geographyName: string;
  comparisonTable: Array<{
    dataMetric: string;
    organizationValue: string;
    sectorValue: string;
    geographyValue: string;
  }>;
  qualitativeComparison: string;
  radarChartData: {
    categories?: string[];
    "data metrics"?: string[]; // Alternative field name from ChatGPT
    dataMetrics?: string[]; // Field name from Claude
    organizationValues: number[];
    sectorValues: number[];
  };
}

export async function generatePreADVPDFClient(
  orgName: string,
  data: PreADVData,
): Promise<Blob> {
  const doc = new jsPDF({
    unit: "px",
    hotfixes: ["px_scaling"],
  });

  // Add Geist font
  addGeistFont(doc);

  let yPos = MARGIN_PX;

  // Title Page
  doc.setFontSize(24);
  doc.setFont("Geist", "bold");
  doc.text("Pre-PDV Report", CENTER_X_PX, yPos, { align: "center" });

  yPos += 56.7; // 15mm
  doc.setFontSize(18);
  doc.text(orgName, CENTER_X_PX, yPos, { align: "center" });

  yPos += 75.6; // 20mm
  doc.setFontSize(12);
  doc.setFont("Geist", "normal");
  doc.text(new Date().toLocaleDateString(), CENTER_X_PX, yPos, {
    align: "center",
  });

  // Add new page
  doc.addPage();
  yPos = MARGIN_PX;

  // Helper function to add section
  const addSection = (title: string, content: string) => {
    if (yPos > 945) {
      // 250mm in px
      doc.addPage();
      yPos = MARGIN_PX;
    }

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(title, MARGIN_PX, yPos);

    yPos += 37.8; // 10mm
    doc.setFontSize(11);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    const lines = doc.splitTextToSize(content, 642.6); // 170mm in px

    // Add lines with page break handling
    for (let i = 0; i < lines.length; i++) {
      if (yPos > 1058.4) {
        // 280mm in px
        doc.addPage();
        yPos = MARGIN_PX;
      }
      doc.text(lines[i]!, MARGIN_PX, yPos);
      yPos += 26.5; // 7mm
    }

    yPos += 37.8; // 10mm
  };

  // 1. Summary
  addSection("1. Summary", data.summary.summary);

  // 2. Overview
  addSection("2. Company Overview", data.overview);

  // 3-9. Other sections
  addSection("3. Data Reliance (Sector)", data.sectorReliance);
  addSection("4. Data Reliance (Company)", data.dataReliance);
  addSection("5. Data Driven", data.dataAttribute);
  addSection("6. Data Ownership", data.dataOwnership);
  addSection("7. Data Uniqueness", data.dataUniqueness);
  addSection("8. Data Scarcity", data.dataScarcity);
  addSection("9. Data Collection", data.dataCollection);

  // Add new page for competitive advantages
  doc.addPage();
  yPos = MARGIN_PX;

  doc.setFontSize(16);
  doc.setFont("Geist", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Competitive Advantages", MARGIN_PX, yPos);

  yPos += 37.8; // 10mm
  doc.setFontSize(11);
  doc.setFont("Geist", "normal");
  doc.setTextColor(0, 0, 0);

  data.summary.competitiveAdvantages.forEach((advantage, index) => {
    const text = `${index + 1}. ${advantage}`;
    const lines = doc.splitTextToSize(text, 642.6); // 170mm
    doc.text(lines, 94.5, yPos); // 25mm margin
    yPos += lines.length * 26.5 + 11.3; // 7mm line height + 3mm gap
  });

  yPos += 37.8; // 10mm

  // Data Profile Table
  doc.setFontSize(16);
  doc.setFont("Geist", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Data Profile & Competitive Moat", MARGIN_PX, yPos);

  yPos += 37.8; // 10mm

  // Table header
  doc.setFillColor(37, 99, 235);
  doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

  doc.setFontSize(10);
  doc.setFont("Geist", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("Data Metric", 94.5, yPos + 26.5); // 25mm, 7mm
  doc.text("Estimate", 302.4, yPos + 26.5); // 80mm, 7mm
  doc.text("Strategic Significance", 453.6, yPos + 26.5); // 120mm, 7mm

  yPos += 37.8; // 10mm

  // Table rows
  doc.setFont("Geist", "normal");
  doc.setTextColor(0, 0, 0);

  data.summary.dataProfileTable.forEach((row, index) => {
    if (yPos > 1020.6) {
      // 270mm
      doc.addPage();
      yPos = MARGIN_PX;
    }

    const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
    doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

    doc.setFontSize(9);
    doc.text(
      doc.splitTextToSize(row.dataMetric, 189)[0] ?? "",
      94.5,
      yPos + 26.5,
    ); // 50mm
    doc.text(
      doc.splitTextToSize(row.estimate, 132.3)[0] ?? "",
      302.4,
      yPos + 26.5,
    ); // 35mm
    doc.text(
      doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? "",
      453.6,
      yPos + 26.5,
    ); // 50mm

    yPos += 37.8; // 10mm
  });

  // Border around table
  doc.setDrawColor(203, 213, 225);
  doc.rect(
    MARGIN_PX,
    yPos - data.summary.dataProfileTable.length * 37.8,
    642.6,
    data.summary.dataProfileTable.length * 37.8,
  );

  return doc.output("blob");
}

export async function generateSupplementaryPDFClient(
  orgName: string,
  data: SupplementaryData,
): Promise<Blob> {
  const doc = new jsPDF({
    unit: "px",
    hotfixes: ["px_scaling"],
  });

  // Add Geist font
  addGeistFont(doc);

  let yPos = MARGIN_PX;

  // Title Page
  doc.setFontSize(20);
  doc.setFont("Geist", "bold");
  doc.text("Data Profile & Competitive Moat Comparison", CENTER_X_PX, yPos, {
    align: "center",
    maxWidth: 642.6, // 170mm
  });

  yPos += 75.6; // 20mm
  doc.setFontSize(16);
  doc.text(`${orgName} vs. ${data.sectorName}`, CENTER_X_PX, yPos, {
    align: "center",
  });

  yPos += 75.6; // 20mm
  doc.setFontSize(12);
  doc.setFont("Geist", "normal");
  doc.text(new Date().toLocaleDateString(), CENTER_X_PX, yPos, {
    align: "center",
  });

  // Add new page for comparison table
  doc.addPage();
  yPos = MARGIN_PX;

  doc.setFontSize(16);
  doc.setFont("Geist", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Data Metric Comparison", MARGIN_PX, yPos);

  yPos += 37.8; // 10mm

  // Table header
  doc.setFillColor(37, 99, 235);
  doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

  doc.setFontSize(9);
  doc.setFont("Geist", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("Data Metric", 83.2, yPos + 26.5); // 22mm, 7mm
  doc.text(orgName.substring(0, 12), 226.8, yPos + 26.5); // 60mm
  doc.text(data.sectorName.substring(0, 12), 378, yPos + 26.5); // 100mm
  doc.text(data.geographyName.substring(0, 12), 529.2, yPos + 26.5); // 140mm

  yPos += 37.8; // 10mm

  // Table rows
  doc.setFont("Geist", "normal");
  doc.setTextColor(0, 0, 0);

  data.comparisonTable.forEach((row, index) => {
    if (yPos > 1020.6) {
      // 270mm
      doc.addPage();
      yPos = MARGIN_PX;
    }

    const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
    doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

    doc.setFontSize(8);
    doc.text(
      doc.splitTextToSize(row.dataMetric, 132.3)[0] ?? "",
      83.2,
      yPos + 26.5,
    ); // 35mm
    doc.text(
      doc.splitTextToSize(row.organizationValue, 132.3)[0] ?? "",
      226.8,
      yPos + 26.5,
    ); // 35mm
    doc.text(
      doc.splitTextToSize(row.sectorValue, 132.3)[0] ?? "",
      378,
      yPos + 26.5,
    ); // 35mm
    doc.text(
      doc.splitTextToSize(row.geographyValue, 132.3)[0] ?? "",
      529.2,
      yPos + 26.5,
    ); // 35mm

    yPos += 37.8; // 10mm
  });

  // Border around table
  doc.setDrawColor(203, 213, 225);
  doc.rect(
    MARGIN_PX,
    yPos - data.comparisonTable.length * 37.8,
    642.6,
    data.comparisonTable.length * 37.8,
  );

  // Generate Radar Chart
  try {
    console.log("📊 [PDF-Generator] Starting radar chart generation...");
    console.log("📊 [PDF-Generator] Using font family:", chartFontFamily);

    const canvas = createCanvas(600, 600);

    // Get categories from any of the possible field names
    const categories =
      data.radarChartData.categories ??
      data.radarChartData.dataMetrics ??
      data.radarChartData["data metrics"] ??
      ["Data Reliance", "Data Attribution", "Data Uniqueness", "Data Scarcity", "Data Ownership"];

    console.log("📊 [PDF-Generator] Chart categories:", categories);

    // Validate and sanitize chart data values - ensure they're valid numbers
    const sanitizeValues = (values: number[] | undefined, expectedLength: number): number[] => {
      if (!values || !Array.isArray(values) || values.length === 0) {
        console.warn("⚠️ [PDF-Generator] Missing chart values, using defaults");
        return Array(expectedLength).fill(50);
      }
      return values.map((v) => {
        if (typeof v !== "number" || isNaN(v)) return 50;
        if (v < 0) return 0;
        if (v > 100) return 100;
        return v;
      });
    };

    const orgValues = sanitizeValues(data.radarChartData.organizationValues, categories.length);
    const sectorValues = sanitizeValues(data.radarChartData.sectorValues, categories.length);

    console.log("📊 [PDF-Generator] Organization values:", orgValues);
    console.log("📊 [PDF-Generator] Sector values:", sectorValues);

    // Create chart with animation disabled and explicit font settings for node-canvas
    const chart = new Chart(canvas, {
      type: "radar",
      data: {
        labels: categories,
        datasets: [
          {
            label: orgName,
            data: orgValues,
            borderColor: "rgb(37, 99, 235)",
            backgroundColor: "rgba(37, 99, 235, 0.2)",
            pointBackgroundColor: "rgb(37, 99, 235)",
            pointBorderColor: "#fff",
          },
          {
            label: data.sectorName ?? "Sector Average",
            data: sectorValues,
            borderColor: "rgb(34, 197, 94)",
            backgroundColor: "rgba(34, 197, 94, 0.2)",
            pointBackgroundColor: "rgb(34, 197, 94)",
            pointBorderColor: "#fff",
          },
        ],
      },
      options: {
        responsive: false,
        animation: false, // Completely disable all animations
        plugins: {
          title: {
            display: true,
            text: "Competitive Position Comparison",
            font: { size: 16, family: chartFontFamily },
          },
          legend: {
            position: "bottom",
            labels: {
              font: { size: 12, family: chartFontFamily },
            },
          },
        },
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            min: 0,
            ticks: {
              stepSize: 20,
              font: { size: 10, family: chartFontFamily },
            },
            pointLabels: {
              font: {
                size: 12,
                family: chartFontFamily,
              },
            },
          },
        },
      },
    });

    // Force a complete render
    chart.draw();
    chart.update("none");

    console.log("📊 [PDF-Generator] Chart rendered, waiting for completion...");

    // Shorter timeout - chart.js with animation disabled should render immediately
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get image data from canvas with maximum quality
    const chartImage = canvas.toDataURL("image/png", 1.0);

    console.log(`📊 [PDF-Generator] Chart image generated, length: ${chartImage.length} bytes`);
    console.log(`📊 [PDF-Generator] Chart image prefix: ${chartImage.substring(0, 50)}...`);

    // Verify the image was generated correctly
    if (!chartImage || chartImage === "data:," || chartImage.length < 1000) {
      throw new Error("Failed to generate chart image - canvas may be empty");
    }

    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Radar Chart Analysis", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Add image with proper error handling
    try {
      doc.addImage(chartImage, "PNG", 113.4, yPos, 567, 567); // 30mm, 150mm x 150mm
      console.log("✅ [PDF-Generator] Chart image added to PDF successfully");
    } catch (imgError) {
      console.error("❌ [PDF-Generator] Error adding image to PDF:", imgError);
      // Add text instead if image fails
      doc.setFontSize(11);
      doc.setFont("Geist", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(
        "Chart generation failed. Please view data in the comparison table above.",
        113.4,
        yPos,
      );
    }

    // Cleanup
    chart.destroy();
    // canvas.remove() is not available in Node.js (node-canvas)
  } catch (error) {
    console.error("❌ [PDF-Generator] Error generating radar chart:", error);
    // Continue with PDF generation even if chart fails
  }

  // Add qualitative analysis
  doc.addPage();
  yPos = MARGIN_PX;

  doc.setFontSize(16);
  doc.setFont("Geist", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Qualitative Analysis of Primary Competitive Moat", MARGIN_PX, yPos);

  yPos += 37.8; // 10mm
  doc.setFontSize(11);
  doc.setFont("Geist", "normal");
  doc.setTextColor(0, 0, 0);

  const lines = doc.splitTextToSize(data.qualitativeComparison, 642.6); // 170mm
  doc.text(lines, MARGIN_PX, yPos);

  return doc.output("blob");
}

// PDV Data interface
interface ADVData {
  lowerADV: number;
  upperADV: number;
  chartData: {
    labels: string[];
    values: number[];
    percentages: {
      lower: string;
      upper: string;
    };
  };
  calculationDetails: {
    totalValuation: number;
    dataRelianceValuation: number;
    dataDecayPercent: number;
    lowerBoundDiscountPercent: number;
    yearsCollectingData: number;
    dataReliancePercent: number;
    dataAttributablePercent: number;
    currentCompanyValue: number;
  };
  qaTable: Array<{
    question: string;
    answer: string;
  }>;
}

// Unified PDV Report Generator
export async function generateUnifiedADVPDFClient(
  orgName: string,
  preADVData: PreADVData | null,
  supplementaryData: SupplementaryData | null,
  advData: ADVData | null,
): Promise<Blob> {
  const doc = new jsPDF({
    unit: "px",
    hotfixes: ["px_scaling"],
  });

  // Add Geist font
  addGeistFont(doc);

  let yPos = MARGIN_PX;

  // Title Page
  doc.setFontSize(24);
  doc.setFont("Geist", "bold");
  doc.text("PDV Report", CENTER_X_PX, yPos, { align: "center" });

  yPos += 56.7; // 15mm
  doc.setFontSize(18);
  doc.text(orgName, CENTER_X_PX, yPos, { align: "center" });

  yPos += 75.6; // 20mm
  doc.setFontSize(12);
  doc.setFont("Geist", "normal");
  doc.text(new Date().toLocaleDateString(), CENTER_X_PX, yPos, {
    align: "center",
  });

  // Helper function to parse inline markdown formatting
  interface TextSegment {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  }

  const parseInlineFormatting = (text: string): TextSegment[] => {
    const segments: TextSegment[] = [];
    let remainingText = text;

    // Process in order: bold (**), bold (__), italic (*), italic (_), code (`)
    // Must process ** before * to avoid matching single * inside **
    while (remainingText.length > 0) {
      let matched = false;

      // Match **bold** (must come before single *)
      const boldStarMatch = remainingText.match(/^(.*?)\*\*(.+?)\*\*/);
      if (boldStarMatch) {
        if (boldStarMatch[1]) {
          segments.push({ text: boldStarMatch[1] });
        }
        segments.push({ text: boldStarMatch[2]!, bold: true });
        remainingText = remainingText.substring(boldStarMatch[0].length);
        matched = true;
        continue;
      }

      // Match __bold__
      const boldUnderMatch = remainingText.match(/^(.*?)__(.+?)__/);
      if (boldUnderMatch) {
        if (boldUnderMatch[1]) {
          segments.push({ text: boldUnderMatch[1] });
        }
        segments.push({ text: boldUnderMatch[2]!, bold: true });
        remainingText = remainingText.substring(boldUnderMatch[0].length);
        matched = true;
        continue;
      }

      // Match *italic* (single asterisk, not part of **)
      const italicStarMatch = remainingText.match(/^(.*?)\*(.+?)\*/);
      if (italicStarMatch) {
        if (italicStarMatch[1]) {
          segments.push({ text: italicStarMatch[1] });
        }
        segments.push({ text: italicStarMatch[2]!, italic: true });
        remainingText = remainingText.substring(italicStarMatch[0].length);
        matched = true;
        continue;
      }

      // Match _italic_ (single underscore, not part of __)
      const italicUnderMatch = remainingText.match(/^(.*?)_(.+?)_/);
      if (italicUnderMatch) {
        if (italicUnderMatch[1]) {
          segments.push({ text: italicUnderMatch[1] });
        }
        segments.push({ text: italicUnderMatch[2]!, italic: true });
        remainingText = remainingText.substring(italicUnderMatch[0].length);
        matched = true;
        continue;
      }

      // Match `code`
      const codeMatch = remainingText.match(/^(.*?)`(.+?)`/);
      if (codeMatch) {
        if (codeMatch[1]) {
          segments.push({ text: codeMatch[1] });
        }
        segments.push({ text: codeMatch[2]!, code: true });
        remainingText = remainingText.substring(codeMatch[0].length);
        matched = true;
        continue;
      }

      // No match found, add remaining text and break
      if (!matched) {
        segments.push({ text: remainingText });
        break;
      }
    }

    return segments.length > 0 ? segments : [{ text }];
  };

  const wrapTextWithFormatting = (
    doc: jsPDF,
    segments: TextSegment[],
    maxWidth: number,
  ): TextSegment[][] => {
    const lines: TextSegment[][] = [];
    let currentLine: TextSegment[] = [];
    let currentWidth = 0;

    segments.forEach((segment) => {
      // Set font to calculate width correctly
      if (segment.bold) {
        doc.setFont("Geist", "bold");
      } else if (segment.italic) {
        doc.setFont("Geist", "italic");
      } else {
        doc.setFont("Geist", "normal");
      }

      // Split segment text by spaces for word wrapping
      const words = segment.text.split(" ");

      words.forEach((word, wordIndex) => {
        const wordWithSpace = wordIndex < words.length - 1 ? word + " " : word;
        const wordWidth = doc.getTextWidth(wordWithSpace);

        if (currentWidth + wordWidth > maxWidth && currentLine.length > 0) {
          // Start a new line
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
        }

        // Add word to current line
        currentLine.push({
          text: wordWithSpace,
          bold: segment.bold,
          italic: segment.italic,
          code: segment.code,
        });
        currentWidth += wordWidth;
      });
    });

    // Add the last line
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [[{ text: "" }]];
  };

  // Helper function to add section
  const addSection = (title: string, content: string) => {
    if (yPos > 945) {
      // 250mm
      doc.addPage();
      yPos = MARGIN_PX;
    }

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(title, MARGIN_PX, yPos);

    yPos += 37.8; // 10mm
    doc.setFontSize(11);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    const lines = doc.splitTextToSize(content, 642.6); // 170mm
    lines.forEach((line: string) => {
      if (yPos > 1058.4) {
        // 280mm
        doc.addPage();
        yPos = MARGIN_PX;
      }
      doc.text(line, MARGIN_PX, yPos);
      yPos += 22.7; // 6mm
    });

    yPos += 37.8; // 10mm
  };

  // Helper function to add markdown section with proper parsing
  const addMdSection = (title: string, content: string) => {
    if (yPos > 945) {
      // 250mm
      doc.addPage();
      yPos = MARGIN_PX;
    }

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(title, MARGIN_PX, yPos);

    yPos += 37.8; // 10mm
    doc.setTextColor(0, 0, 0);

    // Parse markdown content line by line
    const lines = content.split("\n");

    for (const line of lines) {
      // Check for page break
      if (yPos > 1058.4) {
        // 280mm
        doc.addPage();
        yPos = MARGIN_PX;
      }

      // Skip empty lines but add spacing
      if (line.trim() === "") {
        yPos += 15; // Small gap for empty lines
        continue;
      }

      // Handle headings (## Heading) with inline formatting support
      if (line.startsWith("###")) {
        doc.setFontSize(12);
        const text = line.replace(/^###\s*/, "");

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont("Geist", "bolditalic");
          } else if (segment.italic) {
            doc.setFont("Geist", "italic");
          } else {
            doc.setFont("Geist", "bold");
          }
          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 30;
        continue;
      }

      if (line.startsWith("##")) {
        doc.setFontSize(14);
        const text = line.replace(/^##\s*/, "");

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont("Geist", "bolditalic");
          } else if (segment.italic) {
            doc.setFont("Geist", "italic");
          } else {
            doc.setFont("Geist", "bold");
          }
          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 35;
        continue;
      }

      if (line.startsWith("#")) {
        doc.setFontSize(16);
        const text = line.replace(/^#\s*/, "");

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont("Geist", "bolditalic");
          } else if (segment.italic) {
            doc.setFont("Geist", "italic");
          } else {
            doc.setFont("Geist", "bold");
          }
          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 37.8;
        continue;
      }

      // Handle bullet points (- item or * item) with inline formatting
      if (line.match(/^[\s]*[-*]\s/)) {
        doc.setFontSize(11);
        const text = line.replace(/^[\s]*[-*]\s*/, "");

        // Add bullet point manually, then parse the rest for formatting
        const bulletSegment: TextSegment = { text: "• " };
        const contentSegments = parseInlineFormatting(text);
        const allSegments = [bulletSegment, ...contentSegments];

        const wrappedLines = wrapTextWithFormatting(doc, allSegments, 605); // 642.6 - indent

        wrappedLines.forEach((lineSegments, lineIndex) => {
          if (yPos > 1058.4) {
            doc.addPage();
            yPos = MARGIN_PX;
          }

          let xPos = lineIndex === 0 ? 94.5 : 113.4; // 25mm or 30mm indent
          lineSegments.forEach((segment) => {
            if (segment.bold) {
              doc.setFont("Geist", "bold");
            } else if (segment.italic) {
              doc.setFont("Geist", "italic");
            } else {
              doc.setFont("Geist", "normal");
            }

            doc.text(segment.text, xPos, yPos);
            xPos += doc.getTextWidth(segment.text);
          });

          yPos += 22.7; // 6mm
        });
        continue;
      }

      // Handle numbered lists (1. item) with inline formatting
      if (line.match(/^[\s]*\d+\.\s/)) {
        doc.setFontSize(11);

        // Extract the number and the text separately
        const match = line.match(/^[\s]*(\d+\.\s)(.*)$/);
        if (match) {
          const numberPart = match[1]!;
          const textPart = match[2]!;

          // Parse the text part for inline formatting
          const numberSegment: TextSegment = { text: numberPart };
          const contentSegments = parseInlineFormatting(textPart);
          const allSegments = [numberSegment, ...contentSegments];

          const wrappedLines = wrapTextWithFormatting(doc, allSegments, 605);

          wrappedLines.forEach((lineSegments, lineIndex) => {
            if (yPos > 1058.4) {
              doc.addPage();
              yPos = MARGIN_PX;
            }

            let xPos = lineIndex === 0 ? 94.5 : 113.4; // 25mm or 30mm indent
            lineSegments.forEach((segment) => {
              if (segment.bold) {
                doc.setFont("Geist", "bold");
              } else if (segment.italic) {
                doc.setFont("Geist", "italic");
              } else {
                doc.setFont("Geist", "normal");
              }

              doc.text(segment.text, xPos, yPos);
              xPos += doc.getTextWidth(segment.text);
            });

            yPos += 22.7;
          });
        }
        continue;
      }

      // Parse and render text with inline formatting (bold, italic, code)
      doc.setFontSize(11);

      // Split line into segments with different formatting
      const segments = parseInlineFormatting(line);
      const wrappedLines = wrapTextWithFormatting(doc, segments, 642.6);

      wrappedLines.forEach((lineSegments) => {
        if (yPos > 1058.4) {
          doc.addPage();
          yPos = MARGIN_PX;
        }

        let xPos = MARGIN_PX;
        lineSegments.forEach((segment) => {
          if (segment.bold) {
            doc.setFont("Geist", "bold");
          } else if (segment.italic) {
            doc.setFont("Geist", "italic");
          } else {
            doc.setFont("Geist", "normal");
          }

          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 22.7; // 6mm
      });

      // Add small gap after paragraph
      yPos += 7.6; // 2mm
    }

    yPos += 37.8; // 10mm final spacing
  };

  // Section 1: Main Content (PDV or Pre-PDV)
  if (advData) {
    // PDV Main Body
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(20);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Asset Data Valuation (PDV) Report", CENTER_X_PX, yPos, {
      align: "center",
    });

    yPos += 75.6; // 20mm

    // Introduction
    addSection(
      "Introduction",
      "This report presents the Asset Data Valuation (PDV) for " +
        orgName +
        ". The PDV methodology provides a comprehensive assessment of the economic value created by your organization's data assets.",
    );

    // Purpose
    addSection(
      "Purpose of this Report",
      "The purpose of this report is to quantify the value of data assets accumulated by " +
        orgName +
        " over time. This valuation helps stakeholders understand the strategic importance of data in driving business outcomes and competitive advantage.",
    );

    // What is PDV
    addSection(
      "What is Asset Data Valuation?",
      "Asset Data Valuation (PDV) is a methodology designed to estimate the economic value of data assets. It considers factors such as data collection timeframe, data reliance in business operations, data decay rates, and market conditions to provide a range-based valuation.",
    );

    // Preliminary Data Valuation Q&A
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(
      "Preliminary Data Valuation - Questions & Answers",
      MARGIN_PX,
      yPos,
    );

    yPos += 56.7; // 15mm

    advData.qaTable.forEach((qa) => {
      if (yPos > 945) {
        // 250mm
        doc.addPage();
        yPos = MARGIN_PX;
      }

      doc.setFontSize(11);
      doc.setFont("Geist", "bold");
      doc.setTextColor(0, 0, 0);
      const questionLines = doc.splitTextToSize(qa.question, 642.6); // 170mm
      doc.text(questionLines, MARGIN_PX, yPos);
      yPos += questionLines.length * 22.7 + 7.6; // 6mm line height + 2mm gap

      doc.setFont("Geist", "normal");
      doc.setTextColor(60, 60, 60);
      const answerLines = doc.splitTextToSize(qa.answer, 642.6); // 170mm
      doc.text(answerLines, MARGIN_PX, yPos);
      yPos += answerLines.length * 22.7 + 37.8; // 6mm line height + 10mm gap
    });

    // PDV Results with Chart
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(18);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("PDV Valuation Results", CENTER_X_PX, yPos, { align: "center" });

    yPos += 75.6; // 20mm

    // Display PDV range
    doc.setFontSize(14);
    doc.setFont("Geist", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("Estimated PDV Range:", MARGIN_PX, yPos);

    yPos += 56.7; // 15mm

    doc.setFontSize(24);
    doc.setTextColor(34, 197, 94); // Green
    doc.text(`$${advData.lowerADV.toLocaleString()}`, CENTER_X_PX, yPos, {
      align: "center",
    });

    yPos += 37.8; // 10mm
    doc.setFontSize(12);
    doc.setTextColor(100, 100, 100);
    doc.text("to", CENTER_X_PX, yPos, { align: "center" });

    yPos += 37.8; // 10mm
    doc.setFontSize(24);
    doc.setTextColor(59, 130, 246); // Blue
    doc.text(`$${advData.upperADV.toLocaleString()}`, CENTER_X_PX, yPos, {
      align: "center",
    });

    yPos += 75.6; // 20mm

    // Generate bar chart with Chart.js
    const canvas = createCanvas(600, 400);

    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Register bar chart components
      const { BarController, BarElement, CategoryScale, LinearScale } =
        await import("chart.js");
      Chart.register(BarController, BarElement, CategoryScale, LinearScale);

      const barChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: advData.chartData.labels,
          datasets: [
            {
              label: "PDV Range ($)",
              data: advData.chartData.values,
              backgroundColor: [
                "rgba(34, 197, 94, 0.7)",
                "rgba(59, 130, 246, 0.7)",
              ],
              borderColor: ["rgba(34, 197, 94, 1)", "rgba(59, 130, 246, 1)"],
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          animation: { duration: 0 },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function (value) {
                  return "$" + value.toLocaleString();
                },
              },
            },
          },
        },
      });

      barChart.update("none");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const chartImage = canvas.toDataURL("image/png", 1.0);
      doc.addImage(chartImage, "PNG", 113.4, yPos, 567, 378); // 30mm, 150mm x 100mm

      barChart.destroy();
    }

    yPos += 415.8; // 110mm

    // Calculation Details
    if (yPos > 756) {
      // 200mm
      doc.addPage();
      yPos = MARGIN_PX;
    }

    doc.setFontSize(14);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Calculation Details", MARGIN_PX, yPos);

    yPos += 45.4; // 12mm
    doc.setFontSize(10);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    const details = [
      `Years Collecting Data: ${advData.calculationDetails.yearsCollectingData} years`,
      `Current Company Value: $${advData.calculationDetails.currentCompanyValue.toLocaleString()}`,
      `Data Reliance: ${advData.calculationDetails.dataReliancePercent}%`,
      `Data Attributable: ${advData.calculationDetails.dataAttributablePercent}%`,
      `Data Decay Rate: ${advData.calculationDetails.dataDecayPercent}%`,
      `Lower Bound Discount: ${advData.calculationDetails.lowerBoundDiscountPercent}%`,
      `Total Valuation (Sum): $${advData.calculationDetails.totalValuation.toLocaleString()}`,
      `Data Reliance Valuation: $${advData.calculationDetails.dataRelianceValuation.toLocaleString()}`,
    ];

    details.forEach((detail) => {
      doc.text(detail, MARGIN_PX, yPos);
      yPos += 26.5; // 7mm
    });
  } else if (preADVData) {
    // Pre-PDV Main Body (if no PDV data)
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(18);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Pre-PDV Assessment", CENTER_X_PX, yPos, { align: "center" });

    yPos += 56.7; // 15mm

    // Add Pre-PDV sections
    addMdSection("Company Overview", preADVData.overview);
    addMdSection("Data Reliance Analysis", preADVData.dataReliance);
    addMdSection("Data Attribution", preADVData.dataAttribute);
    addMdSection("Data Uniqueness", preADVData.dataUniqueness);
    addMdSection("Data Scarcity", preADVData.dataScarcity);
    addMdSection("Data Ownership", preADVData.dataOwnership);
    addMdSection("Sector Data Reliance", preADVData.sectorReliance);
    addMdSection("Data Collection Methods", preADVData.dataCollection);

    // Pre-PDV Summary and table
    addSection("Summary", preADVData.summary.summary);

    // Add new page for competitive advantages
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Competitive Advantages", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm
    doc.setFontSize(11);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    preADVData.summary.competitiveAdvantages.forEach((advantage, index) => {
      const text = `${index + 1}. ${advantage}`;
      const lines = doc.splitTextToSize(text, 642.6); // 170mm
      doc.text(lines, 94.5, yPos); // 25mm
      yPos += lines.length * 26.5 + 11.3; // 7mm + 3mm
    });

    yPos += 37.8; // 10mm

    // Data Profile Table
    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Data Profile & Competitive Moat", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Table header
    doc.setFillColor(37, 99, 235);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

    doc.setFontSize(10);
    doc.setFont("Geist", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("Data Metric", 94.5, yPos + 26.5); // 25mm, 7mm
    doc.text("Estimate", 302.4, yPos + 26.5); // 80mm, 7mm
    doc.text("Strategic Significance", 453.6, yPos + 26.5); // 120mm, 7mm

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    preADVData.summary.dataProfileTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        yPos = MARGIN_PX;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

      doc.setFontSize(9);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 189)[0] ?? "",
        94.5,
        yPos + 26.5,
      ); // 50mm
      doc.text(
        doc.splitTextToSize(row.estimate, 132.3)[0] ?? "",
        302.4,
        yPos + 26.5,
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? "",
        453.6,
        yPos + 26.5,
      ); // 50mm

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - preADVData.summary.dataProfileTable.length * 37.8,
      642.6,
      preADVData.summary.dataProfileTable.length * 37.8,
    );
  }

  // Section 2: Supplementary Materials (if enabled)
  if (supplementaryData) {
    doc.addPage();
    yPos = MARGIN_PX;
    doc.setFontSize(20);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Data Profile & Competitive Moat Comparison", CENTER_X_PX, yPos, {
      align: "center",
    });

    yPos += 75.6; // 20mm
    doc.setFontSize(16);
    doc.text(
      `${orgName} vs. ${supplementaryData.sectorName}`,
      CENTER_X_PX,
      yPos,
      {
        align: "center",
      },
    );

    yPos += 75.6; // 20mm
    doc.setFontSize(12);
    doc.setFont("Geist", "normal");
    doc.text(new Date().toLocaleDateString(), CENTER_X_PX, yPos, {
      align: "center",
    });

    // Add new page for comparison table
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Data Metric Comparison", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Table header
    doc.setFillColor(37, 99, 235);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

    doc.setFontSize(9);
    doc.setFont("Geist", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("Data Metric", 83.2, yPos + 26.5); // 22mm, 7mm
    doc.text(orgName.substring(0, 12), 226.8, yPos + 26.5); // 60mm
    doc.text(supplementaryData.sectorName.substring(0, 12), 378, yPos + 26.5); // 100mm
    doc.text(
      supplementaryData.geographyName.substring(0, 12),
      529.2,
      yPos + 26.5,
    ); // 140mm

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    supplementaryData.comparisonTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        yPos = MARGIN_PX;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

      doc.setFontSize(8);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 132.3)[0] ?? "",
        83.2,
        yPos + 26.5,
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.organizationValue, 132.3)[0] ?? "",
        226.8,
        yPos + 26.5,
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.sectorValue, 132.3)[0] ?? "",
        378,
        yPos + 26.5,
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.geographyValue, 132.3)[0] ?? "",
        529.2,
        yPos + 26.5,
      ); // 35mm

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - supplementaryData.comparisonTable.length * 37.8,
      642.6,
      supplementaryData.comparisonTable.length * 37.8,
    );

    // Generate Radar Chart
    try {
      console.log("📊 [PDF-Generator] Starting unified PDF radar chart generation...");
      console.log("📊 [PDF-Generator] Using font family:", chartFontFamily);

      const canvas = createCanvas(600, 600);

      // Get categories from any of the possible field names
      const categories =
        supplementaryData.radarChartData.categories ??
        supplementaryData.radarChartData.dataMetrics ??
        supplementaryData.radarChartData["data metrics"] ??
        ["Data Reliance", "Data Attribution", "Data Uniqueness", "Data Scarcity", "Data Ownership"];

      console.log("📊 [PDF-Generator] Chart categories:", categories);

      // Validate and sanitize chart data values - ensure they're valid numbers
      const sanitizeChartValues = (values: number[] | undefined, expectedLength: number): number[] => {
        if (!values || !Array.isArray(values) || values.length === 0) {
          console.warn("⚠️ [PDF-Generator] Missing chart values, using defaults");
          return Array(expectedLength).fill(50);
        }
        return values.map((v) => {
          if (typeof v !== "number" || isNaN(v)) return 50;
          if (v < 0) return 0;
          if (v > 100) return 100;
          return v;
        });
      };

      const orgChartValues = sanitizeChartValues(supplementaryData.radarChartData.organizationValues, categories.length);
      const sectorChartValues = sanitizeChartValues(supplementaryData.radarChartData.sectorValues, categories.length);

      console.log("📊 [PDF-Generator] Organization values:", orgChartValues);
      console.log("📊 [PDF-Generator] Sector values:", sectorChartValues);

      // Create chart with animation disabled and explicit font settings for node-canvas
      const chart = new Chart(canvas, {
        type: "radar",
        data: {
          labels: categories,
          datasets: [
            {
              label: orgName,
              data: orgChartValues,
              borderColor: "rgb(37, 99, 235)",
              backgroundColor: "rgba(37, 99, 235, 0.2)",
              pointBackgroundColor: "rgb(37, 99, 235)",
              pointBorderColor: "#fff",
            },
            {
              label: supplementaryData.sectorName ?? "Sector Average",
              data: sectorChartValues,
              borderColor: "rgb(34, 197, 94)",
              backgroundColor: "rgba(34, 197, 94, 0.2)",
              pointBackgroundColor: "rgb(34, 197, 94)",
              pointBorderColor: "#fff",
            },
          ],
        },
        options: {
          responsive: false,
          animation: false, // Completely disable all animations
          plugins: {
            title: {
              display: true,
              text: "Competitive Position Comparison",
              font: { size: 16, family: chartFontFamily },
            },
            legend: {
              position: "bottom",
              labels: {
                font: { size: 12, family: chartFontFamily },
              },
            },
          },
          scales: {
            r: {
              beginAtZero: true,
              max: 100,
              min: 0,
              ticks: {
                stepSize: 20,
                font: { size: 10, family: chartFontFamily },
              },
              pointLabels: {
                font: {
                  size: 12,
                  family: chartFontFamily,
                },
              },
            },
          },
        },
      });

      // Force a complete render
      chart.draw();
      chart.update("none");

      console.log("📊 [PDF-Generator] Unified chart rendered, waiting for completion...");

      // Shorter timeout - chart.js with animation disabled should render immediately
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get image data from canvas with maximum quality
      const chartImage = canvas.toDataURL("image/png", 1.0);

      console.log(`📊 [PDF-Generator] Unified chart image generated, length: ${chartImage.length} bytes`);
      console.log(`📊 [PDF-Generator] Unified chart image prefix: ${chartImage.substring(0, 50)}...`);

      // Verify the image was generated correctly
      if (!chartImage || chartImage === "data:," || chartImage.length < 1000) {
        throw new Error("Failed to generate chart image - canvas may be empty");
      }

      doc.addPage();
      yPos = MARGIN_PX;

      doc.setFontSize(16);
      doc.setFont("Geist", "bold");
      doc.setTextColor(37, 99, 235);
      doc.text("Radar Chart Analysis", MARGIN_PX, yPos);

      yPos += 37.8; // 10mm

      // Add image with proper error handling
      try {
        doc.addImage(chartImage, "PNG", 113.4, yPos, 567, 567); // 30mm, 150mm x 150mm
        console.log("✅ [PDF-Generator] Unified chart image added to PDF successfully");
      } catch (imgError) {
        console.error("❌ [PDF-Generator] Error adding image to PDF:", imgError);
        // Add text instead if image fails
        doc.setFontSize(11);
        doc.setFont("Geist", "normal");
        doc.setTextColor(100, 100, 100);
        doc.text(
          "Chart generation failed. Please view data in the comparison table above.",
          113.4,
          yPos,
        );
      }

      // Cleanup
      chart.destroy();
      // canvas.remove();
    } catch (error) {
      console.error("❌ [PDF-Generator] Error generating unified radar chart:", error);
      // Continue with PDF generation even if chart fails
    }

    // Add qualitative analysis
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(
      "Qualitative Analysis of Primary Competitive Moat",
      MARGIN_PX,
      yPos,
    );

    yPos += 37.8; // 10mm
    doc.setFontSize(11);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    const lines = doc.splitTextToSize(
      supplementaryData.qualitativeComparison,
      642.6, // 170mm
    );
    doc.text(lines, MARGIN_PX, yPos);
  }

  // Section 3: Appendix with Pre-PDV (if PDV was main)
  if (advData && preADVData) {
    doc.addPage();
    yPos = MARGIN_PX;
    doc.setFontSize(20);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Appendix: Pre-PDV Assessment", CENTER_X_PX, yPos, {
      align: "center",
    });

    yPos += 56.7; // 15mm

    // Add Pre-PDV sections
    addSection("Company Overview", preADVData.overview);
    addMdSection("Data Reliance Analysis", preADVData.dataReliance);
    addMdSection("Data Attribution", preADVData.dataAttribute);
    addMdSection("Data Uniqueness", preADVData.dataUniqueness);
    addMdSection("Data Scarcity", preADVData.dataScarcity);
    addMdSection("Data Ownership", preADVData.dataOwnership);
    addMdSection("Sector Data Reliance", preADVData.sectorReliance);
    addMdSection("Data Collection Methods", preADVData.dataCollection);

    // Add new page for competitive advantages
    doc.addPage();
    yPos = MARGIN_PX;

    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Competitive Advantages", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm
    doc.setFontSize(11);
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    preADVData.summary.competitiveAdvantages.forEach((advantage, index) => {
      const text = `${index + 1}. ${advantage}`;
      const lines = doc.splitTextToSize(text, 642.6); // 170mm
      doc.text(lines, 94.5, yPos); // 25mm
      yPos += lines.length * 26.5 + 11.3; // 7mm + 3mm
    });

    yPos += 37.8; // 10mm

    // Data Profile Table
    doc.setFontSize(16);
    doc.setFont("Geist", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("Data Profile & Competitive Moat", MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Table header
    doc.setFillColor(37, 99, 235);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

    doc.setFontSize(10);
    doc.setFont("Geist", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("Data Metric", 94.5, yPos + 26.5); // 25mm, 7mm
    doc.text("Estimate", 302.4, yPos + 26.5); // 80mm, 7mm
    doc.text("Strategic Significance", 453.6, yPos + 26.5); // 120mm, 7mm

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont("Geist", "normal");
    doc.setTextColor(0, 0, 0);

    preADVData.summary.dataProfileTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        yPos = MARGIN_PX;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, "F"); // 170mm x 10mm

      doc.setFontSize(9);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 189)[0] ?? "",
        94.5,
        yPos + 26.5,
      ); // 50mm
      doc.text(
        doc.splitTextToSize(row.estimate, 132.3)[0] ?? "",
        302.4,
        yPos + 26.5,
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? "",
        453.6,
        yPos + 26.5,
      ); // 50mm

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - preADVData.summary.dataProfileTable.length * 37.8,
      642.6,
      preADVData.summary.dataProfileTable.length * 37.8,
    );

    yPos += 37.8; // 10mm
    // Pre-PDV Summary and table
    addSection("Summary", preADVData.summary.summary);
  }

  return doc.output("blob");
}
