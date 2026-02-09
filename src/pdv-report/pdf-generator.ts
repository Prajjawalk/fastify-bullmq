import { jsPDF } from 'jspdf';
import {
  Chart,
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import { addGeistFont } from './geist-font-loader';
import { ONE2B_LOGO_BASE64 } from './logo-base64';

// Register Chart.js components
Chart.register(
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

// Register font for node-canvas (server-side only)
let fontRegistered = false;
let registeredFontFamily = 'sans-serif'; // fallback

function ensureFontRegistered(): string {
  if (typeof document !== 'undefined') {
    // Browser environment - fonts work normally
    return 'Arial, Helvetica, sans-serif';
  }

  if (fontRegistered) {
    return registeredFontFamily;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFont } = require('canvas');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    // First try local Geist fonts (bundled with the app)
    // __dirname points to the compiled output directory, but we need to handle both dev and prod
    const possibleBasePaths = [
      path.join(__dirname, 'Geist', 'static'), // When running from dist
      path.join(__dirname, '..', 'src', 'pdv-report', 'Geist', 'static'), // From project root dist
      path.join(process.cwd(), 'src', 'pdv-report', 'Geist', 'static'), // From cwd
      path.join(process.cwd(), 'dist', 'pdv-report', 'Geist', 'static'), // From cwd dist
    ];

    // Local Geist fonts (preferred)
    const localFontFiles = [
      { file: 'Geist-Regular.ttf', family: 'Geist', weight: 'normal' },
      { file: 'Geist-Medium.ttf', family: 'Geist', weight: '500' },
      { file: 'Geist-Bold.ttf', family: 'Geist', weight: 'bold' },
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
              registerFont(fontPath, { family: 'ChartFont', weight });
              console.log(
                `✅ [PDF-Generator] Registered local font "${family} ${weight}" from: ${fontPath}`
              );
              fontsRegistered++;
            }
          } catch (err) {
            console.log(
              `⚠️ [PDF-Generator] Failed to register font from ${fontPath}:`,
              err
            );
          }
        }
        if (fontsRegistered > 0) {
          fontRegistered = true;
          registeredFontFamily = 'ChartFont';
          console.log(
            `✅ [PDF-Generator] Successfully registered ${fontsRegistered} Geist font variants`
          );
          return registeredFontFamily;
        }
      }
    }

    console.warn(
      '⚠️ [PDF-Generator] Local Geist fonts not found, trying system fonts...'
    );

    // Fallback to system fonts
    const systemFontPaths = [
      // Linux (Debian/Ubuntu)
      {
        path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        family: 'DejaVu Sans',
      },
      {
        path: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        family: 'Liberation Sans',
      },
      {
        path: '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
        family: 'FreeSans',
      },
      // Linux (Fedora/RHEL)
      {
        path: '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
        family: 'DejaVu Sans',
      },
      // macOS
      { path: '/System/Library/Fonts/Helvetica.ttc', family: 'Helvetica' },
      { path: '/Library/Fonts/Arial.ttf', family: 'Arial' },
      // Windows
      { path: 'C:\\Windows\\Fonts\\arial.ttf', family: 'Arial' },
      { path: 'C:\\Windows\\Fonts\\calibri.ttf', family: 'Calibri' },
    ];

    for (const { path: fontPath, family } of systemFontPaths) {
      try {
        if (fs.existsSync(fontPath)) {
          registerFont(fontPath, { family: 'ChartFont' });
          console.log(
            `✅ [PDF-Generator] Registered system font "${family}" from: ${fontPath}`
          );
          fontRegistered = true;
          registeredFontFamily = 'ChartFont';
          return registeredFontFamily;
        }
      } catch (err) {
        console.log(
          `⚠️ [PDF-Generator] Failed to register font from ${fontPath}:`,
          err
        );
        continue;
      }
    }

    console.warn(
      '⚠️ [PDF-Generator] No suitable font found. Chart text may not render correctly.'
    );
  } catch (err) {
    console.error('❌ [PDF-Generator] Error during font registration:', err);
  }

  fontRegistered = true; // Mark as attempted to avoid repeated tries
  return 'sans-serif';
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
const PAGE_HEIGHT_PX = 297 * PX_PER_MM; // 1122.66px
const MARGIN_PX = 20 * PX_PER_MM; // 75.6px
const CENTER_X_PX = PAGE_WIDTH_PX / 2; // 396.85px
const CONTENT_WIDTH_PX = 170 * PX_PER_MM; // 642.6px

// Brand colors matching the glass UI theme (pastel cloud palette)
const BRAND_BLUE = [30, 67, 100] as const;
const ACCENT_BLUE = [72, 119, 149] as const;
const MUTED_BLUE = [104, 145, 173] as const;
const SKY_TINT = [168, 197, 221] as const;
const BLUSH_TINT = [245, 216, 200] as const;
const LAVENDER_TINT = [216, 202, 221] as const;
const WHITE = [255, 255, 255] as const;
const TEXT_GRAY = [104, 145, 173] as const;

// Helper function to create canvas - works in both browser and Node.js
function createCanvas(width: number, height: number): HTMLCanvasElement {
  // Check if we're in a browser environment
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  } else {
    // Server-side: use node-canvas
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCanvas } = require('canvas');
    return createCanvas(width, height) as HTMLCanvasElement;
  }
}

// ============ SHARED PDF HELPER FUNCTIONS ============

/** Draw a 3-stop gradient background (sky → lavender → blush) for cover pages */
function drawCoverGradient(doc: jsPDF): void {
  for (let i = 0; i < PAGE_HEIGHT_PX; i += 4) {
    const ratio = i / PAGE_HEIGHT_PX;
    let r: number, g: number, b: number;
    if (ratio < 0.5) {
      const t = ratio * 2;
      r = Math.round(SKY_TINT[0] + t * (LAVENDER_TINT[0] - SKY_TINT[0]));
      g = Math.round(SKY_TINT[1] + t * (LAVENDER_TINT[1] - SKY_TINT[1]));
      b = Math.round(SKY_TINT[2] + t * (LAVENDER_TINT[2] - SKY_TINT[2]));
    } else {
      const t = (ratio - 0.5) * 2;
      r = Math.round(LAVENDER_TINT[0] + t * (BLUSH_TINT[0] - LAVENDER_TINT[0]));
      g = Math.round(LAVENDER_TINT[1] + t * (BLUSH_TINT[1] - LAVENDER_TINT[1]));
      b = Math.round(LAVENDER_TINT[2] + t * (BLUSH_TINT[2] - LAVENDER_TINT[2]));
    }
    doc.setFillColor(r, g, b);
    doc.rect(0, i, PAGE_WIDTH_PX, 4, 'F');
  }
}

/** Draw a styled cover page with gradient, logo, title, org name, and sector ribbon */
function drawCoverPage(
  doc: jsPDF,
  title: string,
  orgName: string,
  sectorName?: string
): void {
  drawCoverGradient(doc);

  // Logo in white rounded rect (top right)
  try {
    doc.setFillColor(...WHITE);
    doc.roundedRect(PAGE_WIDTH_PX - 240, 40, 200, 80, 8, 8, 'F');
    doc.addImage(ONE2B_LOGO_BASE64, 'PNG', PAGE_WIDTH_PX - 235, 45, 180, 70);
  } catch {
    doc.setFontSize(24);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text('One2B', PAGE_WIDTH_PX - 140, 85, { align: 'center' });
  }

  // Main title
  doc.setFontSize(42);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...BRAND_BLUE);
  doc.text(title.toUpperCase(), MARGIN_PX + 40, PAGE_HEIGHT_PX / 2 - 80);

  // Organization name
  doc.setFontSize(20);
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...ACCENT_BLUE);
  doc.text(orgName, MARGIN_PX + 40, PAGE_HEIGHT_PX / 2 - 30);

  // Date
  doc.setFontSize(12);
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...MUTED_BLUE);
  doc.text(
    new Date().toLocaleDateString(),
    MARGIN_PX + 40,
    PAGE_HEIGHT_PX / 2 + 10
  );

  // Bottom accent ribbon
  doc.setFillColor(...ACCENT_BLUE);
  doc.rect(0, PAGE_HEIGHT_PX - 70, PAGE_WIDTH_PX, 70, 'F');

  if (sectorName) {
    doc.setFontSize(16);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...WHITE);
    doc.text(sectorName.toUpperCase(), MARGIN_PX + 10, PAGE_HEIGHT_PX - 30);
  }
}

/** Add page header text on content pages */
function addPdvPageHeader(doc: jsPDF, orgName: string): void {
  // Save current state
  const prevFontSize = doc.getFontSize();
  const prevFont = doc.getFont();

  doc.setFontSize(9);
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...TEXT_GRAY);
  doc.text(`PDV REPORT  ${orgName.toUpperCase()}`, MARGIN_PX, MARGIN_PX - 10);

  // Restore previous state so callers don't get unexpected color/font changes
  doc.setFontSize(prevFontSize);
  doc.setFont(prevFont.fontName, prevFont.fontStyle);
  doc.setTextColor(...BRAND_BLUE);
}

/** Add footers (line + page number) to all pages except cover and end */
function addPdvFooters(doc: jsPDF): void {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    if (i === 1 || i === pageCount) continue; // skip cover and blue end page

    doc.setDrawColor(...TEXT_GRAY);
    doc.setLineWidth(1);
    doc.line(
      MARGIN_PX,
      PAGE_HEIGHT_PX - 30,
      PAGE_WIDTH_PX - MARGIN_PX,
      PAGE_HEIGHT_PX - 30
    );

    doc.setFontSize(9);
    doc.setTextColor(...TEXT_GRAY);
    doc.setFont('Geist', 'normal');
    doc.text(`Page ${i} of ${pageCount}`, CENTER_X_PX, PAGE_HEIGHT_PX - 15, {
      align: 'center',
    });
  }
}

/** Draw a numbered section badge with title (e.g. blue "1" box + "Brief" title) */
function drawSectionBadge(
  doc: jsPDF,
  sectionNumber: string,
  sectionTitle: string,
  yPos: number
): number {
  const badgeSize = 50;
  const badgeX = MARGIN_PX;

  doc.setFillColor(...ACCENT_BLUE);
  doc.roundedRect(badgeX, yPos, badgeSize, badgeSize, 8, 8, 'F');

  doc.setFontSize(24);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...WHITE);
  doc.text(sectionNumber, badgeX + badgeSize / 2, yPos + badgeSize / 2 + 9, {
    align: 'center',
  });

  // Title text next to badge, vertically centered
  const titleX = badgeX + badgeSize + 15;
  const maxTitleWidth = PAGE_WIDTH_PX - titleX - MARGIN_PX;
  doc.setFontSize(18);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...BRAND_BLUE);
  // Truncate if too long
  const truncatedTitle = (doc.splitTextToSize(sectionTitle, maxTitleWidth) as string[])[0] ?? sectionTitle;
  doc.text(truncatedTitle, titleX, yPos + badgeSize / 2 + 7);

  return yPos + badgeSize + 40;
}

/** Draw a sky-tint header bar across the page */
function drawHeaderBar(doc: jsPDF, yPos: number, height: number): void {
  doc.setFillColor(...SKY_TINT);
  doc.rect(0, yPos, PAGE_WIDTH_PX, height, 'F');
}

/** Draw TOC entries with dotted lines */
function drawTocEntries(
  doc: jsPDF,
  orgName: string,
  entries: Array<{ title: string; page: number }>
): void {
  addPdvPageHeader(doc, orgName);
  let yPos = MARGIN_PX + 80;

  doc.setFontSize(28);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...ACCENT_BLUE);
  doc.text('Contents', MARGIN_PX, yPos);

  yPos += 50;

  doc.setFontSize(11);
  doc.setFont('Geist', 'normal');

  entries.forEach((item) => {
    doc.setTextColor(...ACCENT_BLUE);
    doc.text(item.title, MARGIN_PX, yPos);

    doc.setTextColor(...BRAND_BLUE);
    const pageNumStr = item.page.toString();
    const pageNumWidth = doc.getTextWidth(pageNumStr);
    doc.text(pageNumStr, PAGE_WIDTH_PX - MARGIN_PX - pageNumWidth, yPos);

    // Dotted line between title and page number
    const titleWidth = doc.getTextWidth(item.title);
    const lineY = yPos - 3;
    doc.setDrawColor(...TEXT_GRAY);
    (doc as any).setLineDash([2, 3]);
    doc.line(
      MARGIN_PX + titleWidth + 10,
      lineY,
      PAGE_WIDTH_PX - MARGIN_PX - pageNumWidth - 10,
      lineY
    );
    (doc as any).setLineDash([]);

    yPos += 22;
  });
}

/** Add a blue end page */
function addBlueEndPage(doc: jsPDF): void {
  doc.addPage();
  doc.setFillColor(...BRAND_BLUE);
  doc.rect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX, 'F');
}

interface PreADVData {
  overview: string;
  dataReliance: string;
  dataAttribute: string;
  dataUniqueness: string;
  dataScarcity: string;
  dataOwnership: string;
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
  geographyName?: string;
  competitors?: string[];
  comparisonTable: Array<{
    dataMetric: string;
    organizationValue: string;
    sectorValue?: string;
    geographyValue?: string;
    competitor1Value?: string;
    competitor2Value?: string;
    competitor3Value?: string;
    competitor4Value?: string;
    competitor5Value?: string;
  }>;
  qualitativeComparison: string;
  radarChartData: {
    categories?: string[];
    'data metrics'?: string[];
    dataMetrics?: string[];
    organizationValues: number[];
    sectorValues?: number[];
    competitor1Values?: number[];
    competitor2Values?: number[];
    competitor3Values?: number[];
    competitor4Values?: number[];
    competitor5Values?: number[];
  };
}

const COMPETITOR_COLORS = [
  { border: 'rgb(239, 68, 68)', bg: 'rgba(239, 68, 68, 0.1)' },
  { border: 'rgb(249, 115, 22)', bg: 'rgba(249, 115, 22, 0.1)' },
  { border: 'rgb(34, 197, 94)', bg: 'rgba(34, 197, 94, 0.1)' },
  { border: 'rgb(168, 85, 247)', bg: 'rgba(168, 85, 247, 0.1)' },
  { border: 'rgb(236, 72, 153)', bg: 'rgba(236, 72, 153, 0.1)' },
];

export async function generatePreADVPDFClient(
  orgName: string,
  data: PreADVData
): Promise<Blob> {
  const doc = new jsPDF({
    unit: 'px',
    hotfixes: ['px_scaling'],
  });

  // Add Geist font
  addGeistFont(doc);

  // Page number tracking for TOC
  const sectionPages: Array<{ title: string; page: number }> = [];

  // ============ PAGE 1: COVER PAGE ============
  drawCoverPage(doc, 'Pre-PDV Report', orgName);

  // ============ PAGE 2: TOC (placeholder, filled at end) ============
  doc.addPage();

  // ============ CONTENT PAGES ============
  doc.addPage();
  addPdvPageHeader(doc, orgName);
  let yPos = MARGIN_PX + 20;

  // Section definitions
  const sections = [
    { num: '1', title: 'Summary', content: data.summary.summary },
    { num: '2', title: 'Company Overview', content: data.overview },
    { num: '3', title: 'Data Reliance (Company)', content: data.dataReliance },
    { num: '4', title: 'Data Driven', content: data.dataAttribute },
    { num: '5', title: 'Data Ownership', content: data.dataOwnership },
    { num: '6', title: 'Data Uniqueness', content: data.dataUniqueness },
    { num: '7', title: 'Data Scarcity', content: data.dataScarcity },
    { num: '8', title: 'Data Collection', content: data.dataCollection },
  ];

  let isFirstSection = true;
  sections.forEach((section) => {
    if (!isFirstSection) {
      // Start each major section on a new page
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 20;
    }
    isFirstSection = false;

    sectionPages.push({
      title: `${section.num}. ${section.title}`,
      page: doc.getCurrentPageInfo().pageNumber,
    });

    yPos = drawSectionBadge(doc, section.num, section.title, yPos);
    yPos += 10;

    doc.setFontSize(11);
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    const sectionLines = doc.splitTextToSize(section.content, CONTENT_WIDTH_PX);

    for (let i = 0; i < sectionLines.length; i++) {
      if (yPos > PAGE_HEIGHT_PX - MARGIN_PX - 60) {
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 40;
      }
      doc.text(sectionLines[i]!, MARGIN_PX, yPos);
      yPos += 22; // 6mm line height
    }
  });

  // Competitive Advantages
  doc.addPage();
  addPdvPageHeader(doc, orgName);
  yPos = MARGIN_PX + 20;

  sectionPages.push({
    title: 'Competitive Advantages',
    page: doc.getCurrentPageInfo().pageNumber,
  });

  yPos = drawSectionBadge(doc, '10', 'Competitive Advantages', yPos);
  yPos += 10;

  doc.setFontSize(11);
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...BRAND_BLUE);

  data.summary.competitiveAdvantages.forEach((advantage, index) => {
    const text = `${index + 1}. ${advantage}`;
    const advLines = doc.splitTextToSize(text, CONTENT_WIDTH_PX);
    doc.text(advLines, 94.5, yPos);
    yPos += advLines.length * 22 + 11.3;
  });

  yPos += 37.8;

  // Data Profile Table
  if (yPos > PAGE_HEIGHT_PX - 300) {
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    yPos = MARGIN_PX + 40;
  }

  sectionPages.push({
    title: 'Data Profile & Competitive Moat',
    page: doc.getCurrentPageInfo().pageNumber,
  });

  doc.setFontSize(16);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...ACCENT_BLUE);
  doc.text('Data Profile & Competitive Moat', MARGIN_PX, yPos);

  yPos += 37.8;

  // Table header
  doc.setFillColor(...ACCENT_BLUE);
  doc.rect(MARGIN_PX, yPos, CONTENT_WIDTH_PX, 37.8, 'F');

  doc.setFontSize(10);
  doc.setFont('Geist', 'bold');
  doc.setTextColor(...WHITE);
  doc.text('Data Metric', 94.5, yPos + 26.5);
  doc.text('Estimate', 302.4, yPos + 26.5);
  doc.text('Strategic Significance', 453.6, yPos + 26.5);

  yPos += 37.8;

  // Table rows
  doc.setFont('Geist', 'normal');

  data.summary.dataProfileTable.forEach((row, index) => {
    if (yPos > PAGE_HEIGHT_PX - MARGIN_PX - 60) {
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 40;
    }

    const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
    doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
    doc.rect(MARGIN_PX, yPos, CONTENT_WIDTH_PX, 37.8, 'F');

    doc.setFontSize(9);
    doc.setTextColor(...BRAND_BLUE);
    doc.text(
      doc.splitTextToSize(row.dataMetric, 189)[0] ?? '',
      94.5,
      yPos + 26.5
    );
    doc.text(
      doc.splitTextToSize(row.estimate, 132.3)[0] ?? '',
      302.4,
      yPos + 26.5
    );
    doc.text(
      doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? '',
      453.6,
      yPos + 26.5
    );

    yPos += 37.8;
  });

  // Border around table
  doc.setDrawColor(...SKY_TINT);
  doc.rect(
    MARGIN_PX,
    yPos - data.summary.dataProfileTable.length * 37.8,
    CONTENT_WIDTH_PX,
    data.summary.dataProfileTable.length * 37.8
  );

  // ============ BLUE END PAGE ============
  addBlueEndPage(doc);

  // ============ FILL IN TOC ON PAGE 2 ============
  doc.setPage(2);
  drawTocEntries(doc, orgName, sectionPages);

  // ============ ADD FOOTERS ============
  addPdvFooters(doc);

  return doc.output('blob');
}

export async function generateSupplementaryPDFClient(
  orgName: string,
  data: SupplementaryData
): Promise<Blob> {
  const doc = new jsPDF({
    unit: 'px',
    hotfixes: ['px_scaling'],
  });

  // Add Geist font
  addGeistFont(doc);

  // Page number tracking for TOC
  const pageNumbers = {
    dataMetricComparison: 0,
    radarChart: 0,
    qualitativeAnalysis: 0,
  };

  // ============ PAGE 1: COVER PAGE ============
  drawCoverPage(
    doc,
    'Data Profile &\nCompetitive Moat',
    orgName,
    data.sectorName
  );

  // ============ PAGE 2: TOC (placeholder, filled at end) ============
  doc.addPage();

  // ============ PAGE 3+: DATA METRIC COMPARISON ============
  doc.addPage();
  pageNumbers.dataMetricComparison = doc.getCurrentPageInfo().pageNumber;
  addPdvPageHeader(doc, orgName);

  let yPos = MARGIN_PX + 20;
  yPos = drawSectionBadge(doc, '1', 'Data Metric Comparison', yPos);

  yPos += 10;

  // Table header
  doc.setFillColor(...BRAND_BLUE);
  doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

  doc.setFont('Geist', 'bold');
  doc.setTextColor(...WHITE);

  if (data.competitors?.length) {
    // New 7-column layout: Data Metric + Org + 5 Competitors
    const compColWidth = (642.6 - 120) / 6;
    doc.setFontSize(7);
    doc.text('Data Metric', MARGIN_PX + 5, yPos + 26.5);
    doc.text(orgName.substring(0, 10), MARGIN_PX + 125, yPos + 26.5);
    data.competitors.slice(0, 5).forEach((name, i) => {
      doc.text(
        name.substring(0, 10),
        MARGIN_PX + 120 + compColWidth * (i + 1) + 5,
        yPos + 26.5
      );
    });
  } else {
    // Legacy 4-column layout: Data Metric + Org + Sector + Geography
    doc.setFontSize(9);
    doc.text('Data Metric', 83.2, yPos + 26.5);
    doc.text(orgName.substring(0, 12), 226.8, yPos + 26.5);
    doc.text(data.sectorName.substring(0, 12), 378, yPos + 26.5);
    doc.text((data.geographyName ?? '').substring(0, 12), 529.2, yPos + 26.5);
  }

  yPos += 37.8; // 10mm

  // Table rows
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...BRAND_BLUE);

  data.comparisonTable.forEach((row, index) => {
    if (yPos > 1020.6) {
      // 270mm
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }

    const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
    doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

    if (data.competitors?.length) {
      const compColWidth = (642.6 - 120) / 6;
      doc.setFontSize(6.5);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 110)[0] ?? '',
        MARGIN_PX + 5,
        yPos + 26.5
      );
      doc.text(
        doc.splitTextToSize(row.organizationValue, 77)[0] ?? '',
        MARGIN_PX + 125,
        yPos + 26.5
      );
      const compValues = [
        row.competitor1Value,
        row.competitor2Value,
        row.competitor3Value,
        row.competitor4Value,
        row.competitor5Value,
      ];
      compValues.forEach((val, i) => {
        doc.text(
          doc.splitTextToSize(val ?? '', 77)[0] ?? '',
          MARGIN_PX + 120 + compColWidth * (i + 1) + 5,
          yPos + 26.5
        );
      });
    } else {
      doc.setFontSize(8);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 132.3)[0] ?? '',
        83.2,
        yPos + 26.5
      );
      doc.text(
        doc.splitTextToSize(row.organizationValue, 132.3)[0] ?? '',
        226.8,
        yPos + 26.5
      );
      doc.text(
        doc.splitTextToSize(row.sectorValue ?? '', 132.3)[0] ?? '',
        378,
        yPos + 26.5
      );
      doc.text(
        doc.splitTextToSize(row.geographyValue ?? '', 132.3)[0] ?? '',
        529.2,
        yPos + 26.5
      );
    }

    yPos += 37.8; // 10mm
  });

  // Border around table
  doc.setDrawColor(203, 213, 225);
  doc.rect(
    MARGIN_PX,
    yPos - data.comparisonTable.length * 37.8,
    642.6,
    data.comparisonTable.length * 37.8
  );

  // Generate Radar Chart
  try {
    console.log('📊 [PDF-Generator] Starting radar chart generation...');
    console.log('📊 [PDF-Generator] Using font family:', chartFontFamily);

    const canvas = createCanvas(600, 600);

    // Get categories from any of the possible field names
    const categories = data.radarChartData.categories ??
      data.radarChartData.dataMetrics ??
      data.radarChartData['data metrics'] ?? [
        'Data Reliance',
        'Data Driven',
        'Data Uniqueness',
        'Data Scarcity',
        'Data Ownership',
      ];

    console.log('📊 [PDF-Generator] Chart categories:', categories);

    // Validate and sanitize chart data values - ensure they're valid numbers
    const sanitizeValues = (
      values: number[] | undefined,
      expectedLength: number
    ): number[] => {
      if (!values || !Array.isArray(values) || values.length === 0) {
        console.warn('⚠️ [PDF-Generator] Missing chart values, using defaults');
        return Array(expectedLength).fill(50);
      }
      return values.map((v) => {
        if (typeof v !== 'number' || isNaN(v)) return 50;
        if (v < 0) return 0;
        if (v > 100) return 100;
        return v;
      });
    };

    const orgValues = sanitizeValues(
      data.radarChartData.organizationValues,
      categories.length
    );

    console.log('📊 [PDF-Generator] Organization values:', orgValues);

    // Build datasets dynamically based on data format
    const datasets: Array<{
      label: string;
      data: number[];
      borderColor: string;
      backgroundColor: string;
      pointBackgroundColor: string;
      pointBorderColor: string;
    }> = [
      {
        label: orgName,
        data: orgValues,
        borderColor: 'rgb(37, 99, 235)',
        backgroundColor: 'rgba(37, 99, 235, 0.2)',
        pointBackgroundColor: 'rgb(37, 99, 235)',
        pointBorderColor: '#fff',
      },
    ];

    if (data.competitors?.length) {
      // New format: 5 named competitors
      const competitorKeys = [
        'competitor1Values',
        'competitor2Values',
        'competitor3Values',
        'competitor4Values',
        'competitor5Values',
      ] as const;
      data.competitors.forEach((name, i) => {
        const vals = sanitizeValues(
          data.radarChartData[competitorKeys[i]!],
          categories.length
        );
        const color = COMPETITOR_COLORS[i]!;
        datasets.push({
          label: name,
          data: vals,
          borderColor: color.border,
          backgroundColor: color.bg,
          pointBackgroundColor: color.border,
          pointBorderColor: '#fff',
        });
      });
      console.log('📊 [PDF-Generator] Competitor datasets:', data.competitors);
    } else {
      // Legacy format: sector average
      const sectorValues = sanitizeValues(
        data.radarChartData.sectorValues,
        categories.length
      );
      console.log('📊 [PDF-Generator] Sector values:', sectorValues);
      datasets.push({
        label: data.sectorName ?? 'Sector Average',
        data: sectorValues,
        borderColor: 'rgb(34, 197, 94)',
        backgroundColor: 'rgba(34, 197, 94, 0.2)',
        pointBackgroundColor: 'rgb(34, 197, 94)',
        pointBorderColor: '#fff',
      });
    }

    // Create chart with animation disabled and explicit font settings for node-canvas
    const chart = new Chart(canvas, {
      type: 'radar',
      data: {
        labels: categories,
        datasets,
      },
      options: {
        responsive: false,
        animation: false, // Completely disable all animations
        plugins: {
          title: {
            display: true,
            text: 'Competitive Position Comparison',
            font: { size: 16, family: chartFontFamily },
          },
          legend: {
            position: 'bottom',
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
    chart.update('none');

    console.log('📊 [PDF-Generator] Chart rendered, waiting for completion...');

    // Shorter timeout - chart.js with animation disabled should render immediately
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get image data from canvas with maximum quality
    const chartImage = canvas.toDataURL('image/png', 1.0);

    console.log(
      `📊 [PDF-Generator] Chart image generated, length: ${chartImage.length} bytes`
    );
    console.log(
      `📊 [PDF-Generator] Chart image prefix: ${chartImage.substring(0, 50)}...`
    );

    // Verify the image was generated correctly
    if (!chartImage || chartImage === 'data:,' || chartImage.length < 1000) {
      throw new Error('Failed to generate chart image - canvas may be empty');
    }

    doc.addPage();
    pageNumbers.radarChart = doc.getCurrentPageInfo().pageNumber;
    addPdvPageHeader(doc, orgName);
    yPos = MARGIN_PX + 20;
    yPos = drawSectionBadge(doc, '2', 'Radar Chart Analysis', yPos);

    yPos += 10;

    // Add image with proper error handling
    try {
      doc.addImage(chartImage, 'PNG', 113.4, yPos, 567, 567); // 30mm, 150mm x 150mm
      console.log('✅ [PDF-Generator] Chart image added to PDF successfully');
    } catch (imgError) {
      console.error('❌ [PDF-Generator] Error adding image to PDF:', imgError);
      doc.setFontSize(11);
      doc.setFont('Geist', 'normal');
      doc.setTextColor(...MUTED_BLUE);
      doc.text(
        'Chart generation failed. Please view data in the comparison table above.',
        113.4,
        yPos
      );
    }

    // Cleanup
    chart.destroy();
    // canvas.remove() is not available in Node.js (node-canvas)
  } catch (error) {
    console.error('❌ [PDF-Generator] Error generating radar chart:', error);
    // Continue with PDF generation even if chart fails
  }

  // Add qualitative analysis
  doc.addPage();
  pageNumbers.qualitativeAnalysis = doc.getCurrentPageInfo().pageNumber;
  addPdvPageHeader(doc, orgName);
  yPos = MARGIN_PX + 20;
  yPos = drawSectionBadge(doc, '3', 'Qualitative Analysis', yPos);

  yPos += 10;
  doc.setFontSize(11);
  doc.setFont('Geist', 'normal');
  doc.setTextColor(...BRAND_BLUE);

  // Split long text into paragraphs and render as bullet points
  const qualParagraphs = data.qualitativeComparison
    .split(/\n+/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 0);
  qualParagraphs.forEach((para: string) => {
    if (yPos > 1020) {
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }
    // Add bullet
    doc.setFont('Geist', 'bold');
    doc.text('•', MARGIN_PX, yPos);
    doc.setFont('Geist', 'normal');
    const bulletLines = doc.splitTextToSize(para, CONTENT_WIDTH_PX - 20) as string[];
    bulletLines.forEach((bl: string) => {
      if (yPos > 1058) {
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }
      doc.text(bl, MARGIN_PX + 15, yPos);
      yPos += 18;
    });
    yPos += 8; // gap between bullets
  });

  // ============ BLUE END PAGE ============
  addBlueEndPage(doc);

  // ============ FILL IN TOC ON PAGE 2 ============
  doc.setPage(2);
  drawTocEntries(doc, orgName, [
    { title: 'Data Metric Comparison', page: pageNumbers.dataMetricComparison },
    { title: 'Radar Chart Analysis', page: pageNumbers.radarChart },
    { title: 'Qualitative Analysis', page: pageNumbers.qualitativeAnalysis },
  ]);

  // ============ ADD FOOTERS ============
  addPdvFooters(doc);

  return doc.output('blob');
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
  advData: ADVData | null
): Promise<Blob> {
  const doc = new jsPDF({
    unit: 'px',
    hotfixes: ['px_scaling'],
  });

  // Add Geist font
  addGeistFont(doc);

  let yPos = MARGIN_PX;

  // Page number tracking for TOC
  const unifiedTocEntries: Array<{ title: string; page: number }> = [];

  // ============ PAGE 1: COVER PAGE ============
  drawCoverPage(doc, 'PDV Report', orgName);

  // ============ PAGE 2: TOC (placeholder, filled at end) ============
  doc.addPage();

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
    maxWidth: number
  ): TextSegment[][] => {
    const lines: TextSegment[][] = [];
    let currentLine: TextSegment[] = [];
    let currentWidth = 0;

    segments.forEach((segment) => {
      // Set font to calculate width correctly
      if (segment.bold) {
        doc.setFont('Geist', 'bold');
      } else if (segment.italic) {
        doc.setFont('Geist', 'italic');
      } else {
        doc.setFont('Geist', 'normal');
      }

      // Split segment text by spaces for word wrapping
      const words = segment.text.split(' ');

      words.forEach((word, wordIndex) => {
        const wordWithSpace = wordIndex < words.length - 1 ? word + ' ' : word;
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

    return lines.length > 0 ? lines : [[{ text: '' }]];
  };

  // Helper function to add section
  const addSection = (title: string, content: string) => {
    if (yPos > 945) {
      // 250mm
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }

    doc.setFontSize(16);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text(title, MARGIN_PX, yPos);

    yPos += 48; // ~12.7mm gap between heading and content
    doc.setFontSize(11);
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    const lines = doc.splitTextToSize(content, 642.6); // 170mm
    lines.forEach((line: string) => {
      if (yPos > 1058.4) {
        // 280mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
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
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }

    doc.setFontSize(16);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text(title, MARGIN_PX, yPos);

    yPos += 48; // ~12.7mm gap between heading and content
    doc.setTextColor(...BRAND_BLUE);

    // Parse markdown content line by line
    const lines = content.split('\n');

    for (const line of lines) {
      // Check for page break
      if (yPos > 1058.4) {
        // 280mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }

      // Skip empty lines but add spacing
      if (line.trim() === '') {
        yPos += 15; // Small gap for empty lines
        continue;
      }

      // Handle headings (## Heading) with inline formatting support
      if (line.startsWith('###')) {
        doc.setFontSize(12);
        const text = line.replace(/^###\s*/, '');

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont('Geist', 'bolditalic');
          } else if (segment.italic) {
            doc.setFont('Geist', 'italic');
          } else {
            doc.setFont('Geist', 'bold');
          }
          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 30;
        continue;
      }

      if (line.startsWith('##')) {
        doc.setFontSize(14);
        const text = line.replace(/^##\s*/, '');

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont('Geist', 'bolditalic');
          } else if (segment.italic) {
            doc.setFont('Geist', 'italic');
          } else {
            doc.setFont('Geist', 'bold');
          }
          doc.text(segment.text, xPos, yPos);
          xPos += doc.getTextWidth(segment.text);
        });

        yPos += 35;
        continue;
      }

      if (line.startsWith('#')) {
        doc.setFontSize(16);
        const text = line.replace(/^#\s*/, '');

        // Parse inline formatting
        const segments = parseInlineFormatting(text);

        // Render each segment (headings are bold by default)
        let xPos = MARGIN_PX;
        segments.forEach((segment) => {
          if (segment.bold && segment.italic) {
            doc.setFont('Geist', 'bolditalic');
          } else if (segment.italic) {
            doc.setFont('Geist', 'italic');
          } else {
            doc.setFont('Geist', 'bold');
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
        const text = line.replace(/^[\s]*[-*]\s*/, '');

        // Add bullet point manually, then parse the rest for formatting
        const bulletSegment: TextSegment = { text: '• ' };
        const contentSegments = parseInlineFormatting(text);
        const allSegments = [bulletSegment, ...contentSegments];

        const wrappedLines = wrapTextWithFormatting(doc, allSegments, 605); // 642.6 - indent

        wrappedLines.forEach((lineSegments, lineIndex) => {
          if (yPos > 1058.4) {
            doc.addPage();
            addPdvPageHeader(doc, orgName);
            yPos = MARGIN_PX + 30;
          }

          let xPos = lineIndex === 0 ? 94.5 : 113.4; // 25mm or 30mm indent
          lineSegments.forEach((segment) => {
            if (segment.bold) {
              doc.setFont('Geist', 'bold');
            } else if (segment.italic) {
              doc.setFont('Geist', 'italic');
            } else {
              doc.setFont('Geist', 'normal');
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
              addPdvPageHeader(doc, orgName);
              yPos = MARGIN_PX + 30;
            }

            let xPos = lineIndex === 0 ? 94.5 : 113.4; // 25mm or 30mm indent
            lineSegments.forEach((segment) => {
              if (segment.bold) {
                doc.setFont('Geist', 'bold');
              } else if (segment.italic) {
                doc.setFont('Geist', 'italic');
              } else {
                doc.setFont('Geist', 'normal');
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
          addPdvPageHeader(doc, orgName);
          yPos = MARGIN_PX + 30;
        }

        let xPos = MARGIN_PX;
        lineSegments.forEach((segment) => {
          if (segment.bold) {
            doc.setFont('Geist', 'bold');
          } else if (segment.italic) {
            doc.setFont('Geist', 'italic');
          } else {
            doc.setFont('Geist', 'normal');
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
  let sectionNumber = 1;

  if (advData) {
    // PDV Main Body
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Preliminary Data Valuation (PDV) Report',
      page: doc.getCurrentPageInfo().pageNumber,
    });

    // Section badge + header bar
    yPos = MARGIN_PX + 30;
    drawHeaderBar(doc, yPos, 60);
    yPos += 5;
    yPos = drawSectionBadge(doc, String(sectionNumber), 'Preliminary Data Valuation (PDV) Report', yPos);
    sectionNumber++;

    // Introduction
    addSection(
      'Introduction',
      'This report presents the Preliminary Data Valuation (PDV) for ' +
        orgName +
        ". The PDV methodology provides a comprehensive assessment of the economic value created by your organization's data assets."
    );

    // Purpose
    addSection(
      'Purpose of this Report',
      'The purpose of this report is to quantify the value of data assets accumulated by ' +
        orgName +
        ' over time. This valuation helps stakeholders understand the strategic importance of data in driving business outcomes and competitive advantage.'
    );

    // What is PDV
    addSection(
      'What is Preliminary Data Valuation?',
      'Preliminary Data Valuation (PDV) is a methodology designed to estimate the economic value of data assets. It considers factors such as data collection timeframe, data reliance in business operations, data decay rates, and market conditions to provide a range-based valuation.'
    );

    // Preliminary Data Valuation Q&A
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Questions & Answers',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    yPos = drawSectionBadge(doc, String(sectionNumber), 'Questions & Answers', yPos);
    sectionNumber++;

    advData.qaTable.forEach((qa) => {
      if (yPos > 945) {
        // 250mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }

      doc.setFontSize(11);
      doc.setFont('Geist', 'bold');
      doc.setTextColor(...BRAND_BLUE);
      const questionLines = doc.splitTextToSize(qa.question, 642.6); // 170mm
      doc.text(questionLines, MARGIN_PX, yPos);
      yPos += questionLines.length * 22.7 + 7.6; // 6mm line height + 2mm gap

      doc.setFont('Geist', 'normal');
      doc.setTextColor(...ACCENT_BLUE);
      const answerLines = doc.splitTextToSize(qa.answer, 642.6); // 170mm
      doc.text(answerLines, MARGIN_PX, yPos);
      yPos += answerLines.length * 22.7 + 37.8; // 6mm line height + 10mm gap
    });

    // PDV Results with Chart
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'PDV Valuation Results',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    yPos = drawSectionBadge(doc, String(sectionNumber), 'PDV Valuation Results', yPos);
    sectionNumber++;

    yPos += 37.8; // 10mm

    // Display PDV range
    doc.setFontSize(14);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text('Estimated PDV Range:', MARGIN_PX, yPos);

    yPos += 56.7; // 15mm

    doc.setFontSize(24);
    doc.setTextColor(34, 197, 94); // Green
    doc.text(`$${advData.lowerADV.toLocaleString()}`, CENTER_X_PX, yPos, {
      align: 'center',
    });

    yPos += 37.8; // 10mm
    doc.setFontSize(12);
    doc.setTextColor(...MUTED_BLUE);
    doc.text('to', CENTER_X_PX, yPos, { align: 'center' });

    yPos += 37.8; // 10mm
    doc.setFontSize(24);
    doc.setTextColor(...ACCENT_BLUE);
    doc.text(`$${advData.upperADV.toLocaleString()}`, CENTER_X_PX, yPos, {
      align: 'center',
    });

    yPos += 75.6; // 20mm

    // Generate bar chart with Chart.js
    const canvas = createCanvas(600, 400);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Register bar chart components
      const { BarController, BarElement, CategoryScale, LinearScale } =
        await import('chart.js');
      Chart.register(BarController, BarElement, CategoryScale, LinearScale);

      const barChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: advData.chartData.labels,
          datasets: [
            {
              label: 'PDV Range ($)',
              data: advData.chartData.values,
              backgroundColor: [
                'rgba(34, 197, 94, 0.7)',
                'rgba(59, 130, 246, 0.7)',
              ],
              borderColor: ['rgba(34, 197, 94, 1)', 'rgba(59, 130, 246, 1)'],
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
                  return '$' + value.toLocaleString();
                },
              },
            },
          },
        },
      });

      barChart.update('none');
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const chartImage = canvas.toDataURL('image/png', 1.0);
      doc.addImage(chartImage, 'PNG', 113.4, yPos, 567, 378); // 30mm, 150mm x 100mm

      barChart.destroy();
    }

    yPos += 415.8; // 110mm

    // // Calculation Details (commented out because we don't need this in report)
    // if (yPos > 756) {
    //   // 200mm
    //   doc.addPage();
    //   yPos = MARGIN_PX;
    // }

    // doc.setFontSize(14);
    // doc.setFont('Geist', 'bold');
    // doc.setTextColor(37, 99, 235);
    // doc.text('Calculation Details', MARGIN_PX, yPos);

    // yPos += 45.4; // 12mm
    // doc.setFontSize(10);
    // doc.setFont('Geist', 'normal');
    // doc.setTextColor(0, 0, 0);

    // const details = [
    //   `Years Collecting Data: ${advData.calculationDetails.yearsCollectingData} years`,
    //   `Current Company Value: $${advData.calculationDetails.currentCompanyValue.toLocaleString()}`,
    //   `Data Reliance: ${advData.calculationDetails.dataReliancePercent}%`,
    //   `Data Attributable: ${advData.calculationDetails.dataAttributablePercent}%`,
    //   `Data Decay Rate: ${advData.calculationDetails.dataDecayPercent}%`,
    //   `Lower Bound Discount: ${advData.calculationDetails.lowerBoundDiscountPercent}%`,
    //   `Total Valuation (Sum): $${advData.calculationDetails.totalValuation.toLocaleString()}`,
    //   `Data Reliance Valuation: $${advData.calculationDetails.dataRelianceValuation.toLocaleString()}`,
    // ];

    // details.forEach((detail) => {
    //   doc.text(detail, MARGIN_PX, yPos);
    //   yPos += 26.5; // 7mm
    // });
  } else if (preADVData) {
    // Pre-PDV Main Body (if no PDV data)
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Pre-PDV Assessment',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    drawHeaderBar(doc, yPos, 60);
    yPos += 5;
    yPos = drawSectionBadge(doc, String(sectionNumber), 'Pre-PDV Assessment', yPos);
    sectionNumber++;

    // Add Pre-PDV sections
    addMdSection('Company Overview', preADVData.overview);
    addMdSection('Data Reliance Analysis', preADVData.dataReliance);
    addMdSection('Data Driven', preADVData.dataAttribute);
    addMdSection('Data Uniqueness', preADVData.dataUniqueness);
    addMdSection('Data Scarcity', preADVData.dataScarcity);
    addMdSection('Data Ownership', preADVData.dataOwnership);
    addMdSection('Data Collection Methods', preADVData.dataCollection);

    // Pre-PDV Summary and table
    addSection('Summary', preADVData.summary.summary);

    // Add new page for competitive advantages
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Competitive Advantages',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    yPos = drawSectionBadge(doc, String(sectionNumber), 'Competitive Advantages', yPos);
    sectionNumber++;

    doc.setFontSize(11);
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    preADVData.summary.competitiveAdvantages.forEach((advantage, index) => {
      const text = `${index + 1}. ${advantage}`;
      const lines = doc.splitTextToSize(text, 642.6); // 170mm
      doc.text(lines, 94.5, yPos); // 25mm
      yPos += lines.length * 26.5 + 11.3; // 7mm + 3mm
    });

    yPos += 37.8; // 10mm

    // Data Profile Table - check if entire table fits on current page
    const dpTableHeight = 37.8 + 37.8 + preADVData.summary.dataProfileTable.length * 37.8; // title + header + rows
    if (yPos + dpTableHeight > PAGE_HEIGHT_PX - MARGIN_PX) {
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }

    doc.setFontSize(16);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text('Data Profile & Competitive Moat', MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Table header
    doc.setFillColor(...BRAND_BLUE);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

    doc.setFontSize(10);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...WHITE);
    doc.text('Data Metric', 94.5, yPos + 26.5); // 25mm, 7mm
    doc.text('Estimate', 302.4, yPos + 26.5); // 80mm, 7mm
    doc.text('Strategic Significance', 453.6, yPos + 26.5); // 120mm, 7mm

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    preADVData.summary.dataProfileTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

      doc.setFontSize(9);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 189)[0] ?? '',
        94.5,
        yPos + 26.5
      ); // 50mm
      doc.text(
        doc.splitTextToSize(row.estimate, 132.3)[0] ?? '',
        302.4,
        yPos + 26.5
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? '',
        453.6,
        yPos + 26.5
      ); // 50mm

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - preADVData.summary.dataProfileTable.length * 37.8,
      642.6,
      preADVData.summary.dataProfileTable.length * 37.8
    );
  }

  // Section 2: Supplementary Materials (if enabled)
  if (supplementaryData) {
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Data Metric Comparison',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    drawHeaderBar(doc, yPos, 60);
    yPos += 5;
    yPos = drawSectionBadge(doc, String(sectionNumber), 'Data Metric Comparison', yPos);
    sectionNumber++;

    yPos += 10;

    // Table header
    doc.setFillColor(...BRAND_BLUE);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

    doc.setFont('Geist', 'bold');
    doc.setTextColor(...WHITE);

    if (supplementaryData.competitors?.length) {
      // New 7-column layout: Data Metric + Org + 5 Competitors
      const compColWidth = (642.6 - 120) / 6;
      doc.setFontSize(7);
      doc.text('Data Metric', MARGIN_PX + 5, yPos + 26.5);
      doc.text(orgName.substring(0, 10), MARGIN_PX + 125, yPos + 26.5);
      supplementaryData.competitors.slice(0, 5).forEach((name, i) => {
        doc.text(
          name.substring(0, 10),
          MARGIN_PX + 120 + compColWidth * (i + 1) + 5,
          yPos + 26.5
        );
      });
    } else {
      // Legacy 4-column layout
      doc.setFontSize(9);
      doc.text('Data Metric', 83.2, yPos + 26.5);
      doc.text(orgName.substring(0, 12), 226.8, yPos + 26.5);
      doc.text(supplementaryData.sectorName.substring(0, 12), 378, yPos + 26.5);
      doc.text(
        (supplementaryData.geographyName ?? '').substring(0, 12),
        529.2,
        yPos + 26.5
      );
    }

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    supplementaryData.comparisonTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

      if (supplementaryData.competitors?.length) {
        const compColWidth = (642.6 - 120) / 6;
        doc.setFontSize(6.5);
        doc.text(
          doc.splitTextToSize(row.dataMetric, 110)[0] ?? '',
          MARGIN_PX + 5,
          yPos + 26.5
        );
        doc.text(
          doc.splitTextToSize(row.organizationValue, 77)[0] ?? '',
          MARGIN_PX + 125,
          yPos + 26.5
        );
        const compValues = [
          row.competitor1Value,
          row.competitor2Value,
          row.competitor3Value,
          row.competitor4Value,
          row.competitor5Value,
        ];
        compValues.forEach((val, i) => {
          doc.text(
            doc.splitTextToSize(val ?? '', 77)[0] ?? '',
            MARGIN_PX + 120 + compColWidth * (i + 1) + 5,
            yPos + 26.5
          );
        });
      } else {
        doc.setFontSize(8);
        doc.text(
          doc.splitTextToSize(row.dataMetric, 132.3)[0] ?? '',
          83.2,
          yPos + 26.5
        );
        doc.text(
          doc.splitTextToSize(row.organizationValue, 132.3)[0] ?? '',
          226.8,
          yPos + 26.5
        );
        doc.text(
          doc.splitTextToSize(row.sectorValue ?? '', 132.3)[0] ?? '',
          378,
          yPos + 26.5
        );
        doc.text(
          doc.splitTextToSize(row.geographyValue ?? '', 132.3)[0] ?? '',
          529.2,
          yPos + 26.5
        );
      }

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - supplementaryData.comparisonTable.length * 37.8,
      642.6,
      supplementaryData.comparisonTable.length * 37.8
    );

    // Generate Radar Chart
    try {
      console.log(
        '📊 [PDF-Generator] Starting unified PDF radar chart generation...'
      );
      console.log('📊 [PDF-Generator] Using font family:', chartFontFamily);

      const canvas = createCanvas(600, 600);

      // Get categories from any of the possible field names
      const categories = supplementaryData.radarChartData.categories ??
        supplementaryData.radarChartData.dataMetrics ??
        supplementaryData.radarChartData['data metrics'] ?? [
          'Data Reliance',
          'Data Driven',
          'Data Uniqueness',
          'Data Scarcity',
          'Data Ownership',
        ];

      console.log('📊 [PDF-Generator] Chart categories:', categories);

      // Validate and sanitize chart data values - ensure they're valid numbers
      const sanitizeChartValues = (
        values: number[] | undefined,
        expectedLength: number
      ): number[] => {
        if (!values || !Array.isArray(values) || values.length === 0) {
          console.warn(
            '⚠️ [PDF-Generator] Missing chart values, using defaults'
          );
          return Array(expectedLength).fill(50);
        }
        return values.map((v) => {
          if (typeof v !== 'number' || isNaN(v)) return 50;
          if (v < 0) return 0;
          if (v > 100) return 100;
          return v;
        });
      };

      const orgChartValues = sanitizeChartValues(
        supplementaryData.radarChartData.organizationValues,
        categories.length
      );

      console.log('📊 [PDF-Generator] Organization values:', orgChartValues);

      // Build datasets dynamically based on data format
      const unifiedDatasets: Array<{
        label: string;
        data: number[];
        borderColor: string;
        backgroundColor: string;
        pointBackgroundColor: string;
        pointBorderColor: string;
      }> = [
        {
          label: orgName,
          data: orgChartValues,
          borderColor: 'rgb(37, 99, 235)',
          backgroundColor: 'rgba(37, 99, 235, 0.2)',
          pointBackgroundColor: 'rgb(37, 99, 235)',
          pointBorderColor: '#fff',
        },
      ];

      if (supplementaryData.competitors?.length) {
        const competitorKeys = [
          'competitor1Values',
          'competitor2Values',
          'competitor3Values',
          'competitor4Values',
          'competitor5Values',
        ] as const;
        supplementaryData.competitors.forEach((name, i) => {
          const vals = sanitizeChartValues(
            supplementaryData.radarChartData[competitorKeys[i]!],
            categories.length
          );
          const color = COMPETITOR_COLORS[i]!;
          unifiedDatasets.push({
            label: name,
            data: vals,
            borderColor: color.border,
            backgroundColor: color.bg,
            pointBackgroundColor: color.border,
            pointBorderColor: '#fff',
          });
        });
        console.log(
          '📊 [PDF-Generator] Unified competitor datasets:',
          supplementaryData.competitors
        );
      } else {
        const sectorChartValues = sanitizeChartValues(
          supplementaryData.radarChartData.sectorValues,
          categories.length
        );
        console.log('📊 [PDF-Generator] Sector values:', sectorChartValues);
        unifiedDatasets.push({
          label: supplementaryData.sectorName ?? 'Sector Average',
          data: sectorChartValues,
          borderColor: 'rgb(34, 197, 94)',
          backgroundColor: 'rgba(34, 197, 94, 0.2)',
          pointBackgroundColor: 'rgb(34, 197, 94)',
          pointBorderColor: '#fff',
        });
      }

      // Create chart with animation disabled and explicit font settings for node-canvas
      const chart = new Chart(canvas, {
        type: 'radar',
        data: {
          labels: categories,
          datasets: unifiedDatasets,
        },
        options: {
          responsive: false,
          animation: false, // Completely disable all animations
          plugins: {
            title: {
              display: true,
              text: 'Competitive Position Comparison',
              font: { size: 16, family: chartFontFamily },
            },
            legend: {
              position: 'bottom',
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
      chart.update('none');

      console.log(
        '📊 [PDF-Generator] Unified chart rendered, waiting for completion...'
      );

      // Shorter timeout - chart.js with animation disabled should render immediately
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get image data from canvas with maximum quality
      const chartImage = canvas.toDataURL('image/png', 1.0);

      console.log(
        `📊 [PDF-Generator] Unified chart image generated, length: ${chartImage.length} bytes`
      );
      console.log(
        `📊 [PDF-Generator] Unified chart image prefix: ${chartImage.substring(
          0,
          50
        )}...`
      );

      // Verify the image was generated correctly
      if (!chartImage || chartImage === 'data:,' || chartImage.length < 1000) {
        throw new Error('Failed to generate chart image - canvas may be empty');
      }

      doc.addPage();
      addPdvPageHeader(doc, orgName);
      unifiedTocEntries.push({
        title: 'Radar Chart Analysis',
        page: doc.getCurrentPageInfo().pageNumber,
      });
      yPos = MARGIN_PX + 30;

      yPos = drawSectionBadge(doc, String(sectionNumber), 'Radar Chart Analysis', yPos);
      sectionNumber++;

      // Add image with proper error handling
      try {
        doc.addImage(chartImage, 'PNG', 113.4, yPos, 567, 567); // 30mm, 150mm x 150mm
        console.log(
          '✅ [PDF-Generator] Unified chart image added to PDF successfully'
        );
      } catch (imgError) {
        console.error(
          '❌ [PDF-Generator] Error adding image to PDF:',
          imgError
        );
        // Add text instead if image fails
        doc.setFontSize(11);
        doc.setFont('Geist', 'normal');
        doc.setTextColor(...MUTED_BLUE);
        doc.text(
          'Chart generation failed. Please view data in the comparison table above.',
          113.4,
          yPos
        );
      }

      // Cleanup
      chart.destroy();
      // canvas.remove();
    } catch (error) {
      console.error(
        '❌ [PDF-Generator] Error generating unified radar chart:',
        error
      );
      // Continue with PDF generation even if chart fails
    }

    // Add qualitative analysis
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Qualitative Analysis',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    yPos = drawSectionBadge(doc, String(sectionNumber), 'Qualitative Analysis', yPos);
    sectionNumber++;

    doc.setFontSize(11);
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    // Split long text into paragraphs and render as bullet points
    const unifiedQualParagraphs = supplementaryData.qualitativeComparison
      .split(/\n+/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);
    unifiedQualParagraphs.forEach((para: string) => {
      if (yPos > 1020) {
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }
      doc.setFont('Geist', 'bold');
      doc.text('•', MARGIN_PX, yPos);
      doc.setFont('Geist', 'normal');
      const bulletLines = doc.splitTextToSize(para, CONTENT_WIDTH_PX - 20) as string[];
      bulletLines.forEach((bl: string) => {
        if (yPos > 1058) {
          doc.addPage();
          addPdvPageHeader(doc, orgName);
          yPos = MARGIN_PX + 30;
        }
        doc.text(bl, MARGIN_PX + 15, yPos);
        yPos += 18;
      });
      yPos += 8;
    });
  }

  // Section 3: Appendix with Pre-PDV (if PDV was main)
  if (advData && preADVData) {
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    unifiedTocEntries.push({
      title: 'Appendix: Pre-PDV Assessment',
      page: doc.getCurrentPageInfo().pageNumber,
    });
    yPos = MARGIN_PX + 30;

    drawHeaderBar(doc, yPos, 60);
    yPos += 5;
    yPos = drawSectionBadge(doc, String(sectionNumber), 'Appendix: Pre-PDV Assessment', yPos);
    sectionNumber++;

    // Add Pre-PDV sections
    addSection('Company Overview', preADVData.overview);
    addMdSection('Data Reliance Analysis', preADVData.dataReliance);
    addMdSection('Data Driven', preADVData.dataAttribute);
    addMdSection('Data Uniqueness', preADVData.dataUniqueness);
    addMdSection('Data Scarcity', preADVData.dataScarcity);
    addMdSection('Data Ownership', preADVData.dataOwnership);
    addMdSection('Data Collection Methods', preADVData.dataCollection);

    // Add new page for competitive advantages
    doc.addPage();
    addPdvPageHeader(doc, orgName);
    yPos = MARGIN_PX + 30;

    yPos = drawSectionBadge(doc, String(sectionNumber), 'Competitive Advantages', yPos);
    sectionNumber++;

    doc.setFontSize(11);
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    preADVData.summary.competitiveAdvantages.forEach((advantage, index) => {
      const text = `${index + 1}. ${advantage}`;
      const advLines = doc.splitTextToSize(text, 642.6); // 170mm
      doc.text(advLines, 94.5, yPos); // 25mm
      yPos += advLines.length * 26.5 + 11.3; // 7mm + 3mm
    });

    yPos += 37.8; // 10mm

    // Data Profile Table - check if entire table fits on current page
    const appendixDpTableHeight = 37.8 + 37.8 + preADVData.summary.dataProfileTable.length * 37.8; // title + header + rows
    if (yPos + appendixDpTableHeight > PAGE_HEIGHT_PX - MARGIN_PX) {
      doc.addPage();
      addPdvPageHeader(doc, orgName);
      yPos = MARGIN_PX + 30;
    }

    doc.setFontSize(16);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...BRAND_BLUE);
    doc.text('Data Profile & Competitive Moat', MARGIN_PX, yPos);

    yPos += 37.8; // 10mm

    // Table header
    doc.setFillColor(...BRAND_BLUE);
    doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

    doc.setFontSize(10);
    doc.setFont('Geist', 'bold');
    doc.setTextColor(...WHITE);
    doc.text('Data Metric', 94.5, yPos + 26.5); // 25mm, 7mm
    doc.text('Estimate', 302.4, yPos + 26.5); // 80mm, 7mm
    doc.text('Strategic Significance', 453.6, yPos + 26.5); // 120mm, 7mm

    yPos += 37.8; // 10mm

    // Table rows
    doc.setFont('Geist', 'normal');
    doc.setTextColor(...BRAND_BLUE);

    preADVData.summary.dataProfileTable.forEach((row, index) => {
      if (yPos > 1020.6) {
        // 270mm
        doc.addPage();
        addPdvPageHeader(doc, orgName);
        yPos = MARGIN_PX + 30;
      }

      const bgColor = index % 2 === 0 ? [243, 244, 246] : [255, 255, 255];
      doc.setFillColor(bgColor[0]!, bgColor[1]!, bgColor[2]!);
      doc.rect(MARGIN_PX, yPos, 642.6, 37.8, 'F'); // 170mm x 10mm

      doc.setFontSize(9);
      doc.text(
        doc.splitTextToSize(row.dataMetric, 189)[0] ?? '',
        94.5,
        yPos + 26.5
      ); // 50mm
      doc.text(
        doc.splitTextToSize(row.estimate, 132.3)[0] ?? '',
        302.4,
        yPos + 26.5
      ); // 35mm
      doc.text(
        doc.splitTextToSize(row.strategicSignificance, 189)[0] ?? '',
        453.6,
        yPos + 26.5
      ); // 50mm

      yPos += 37.8; // 10mm
    });

    // Border around table
    doc.setDrawColor(203, 213, 225);
    doc.rect(
      MARGIN_PX,
      yPos - preADVData.summary.dataProfileTable.length * 37.8,
      642.6,
      preADVData.summary.dataProfileTable.length * 37.8
    );

    yPos += 37.8; // 10mm
    // Pre-PDV Summary and table
    addSection('Summary', preADVData.summary.summary);
  }

  // ============ BLUE END PAGE ============
  addBlueEndPage(doc);

  // ============ FILL TOC ON PAGE 2 ============
  doc.setPage(2);
  addPdvPageHeader(doc, orgName);
  drawTocEntries(doc, orgName, unifiedTocEntries);

  // ============ ADD FOOTERS TO ALL PAGES ============
  addPdvFooters(doc);

  return doc.output('blob');
}
