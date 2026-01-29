import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { db as prismaDb } from '../db';
import { generateUnifiedADVPDFClient } from './pdf-generator';

// Type assertion to bypass dts-cli's outdated TypeScript (4.9.5) not recognizing Prisma 6 types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prismaDb as any;

// Types for job data
export interface PDVReportJobData {
  reportId: string;
  orgName: string;
  workflowId: string;
  reportType: 'PRE_ADV' | 'PDV' | 'SUPPLEMENT';
  userEmail: string;
  platformId: string | null;
  organizationId: string;
  orgWorkflowId: string;
  subdomain: string;
  enableADV: boolean;
  pdvAnswers: Array<{ question: string; answer: string }>;
}

// Helper to call Claude API
async function callClaude(
  client: Anthropic,
  prompt: string,
  options?: { systemPrompt?: string; maxTokens?: number; jsonMode?: boolean }
): Promise<string> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: options?.maxTokens ?? 5000,
    ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  return textBlock && 'text' in textBlock ? textBlock.text : '';
}

// Helper to extract JSON from Claude's response
function extractJSON(text: string): string {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object directly
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    return jsonMatch[0];
  }

  return text;
}

// Helper to extract percentage from text response
function extractPercentageFromText(text: string): number | null {
  // Look for patterns like "75%", "75 percent", "75-80%", etc.
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  if (percentMatch?.[1]) {
    const value = parseFloat(percentMatch[1]);
    if (!isNaN(value) && value >= 0 && value <= 100) {
      return value;
    }
  }
  return null;
}

// Generate Pre-PDV Report data using Claude with sequential prompts and context accumulation
async function generatePrePDVData(
  client: Anthropic,
  orgName: string
): Promise<string> {
  // Accumulated context from previous responses
  let accumulatedContext = '';

  // Prompt 1: Company Overview
  const overviewText = await callClaude(
    client,
    `Provide a professional 5-line overview for ${orgName}. Focus on their business model, industry and sector position, and key operations.`,
    { maxTokens: 300 }
  );
  accumulatedContext += `\n\n--- Company Overview ---\n${overviewText}`;

  // Sequential metric prompts with accumulated context
  // Prompt 2: Data Reliance
  const dataReliance = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data reliance percentage for ${orgName}. Data reliance measures how dependent the company's operations, revenue, and competitive advantage are on data assets.

Provide:
1. A specific percentage estimate (e.g., "75%")
2. Detailed analysis explaining the estimate
3. Key factors that influence this percentage`
  );
  accumulatedContext += `\n\n--- Data Reliance Analysis ---\n${dataReliance}`;

  // Prompt 3: Data Attribute
  const dataAttribute = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data attribute percentage for ${orgName}. Data attribute measures what percentage of the company's business value can be directly attributed to their data assets.

Provide:
1. A specific percentage estimate (e.g., "70%")
2. Detailed analysis explaining the estimate
3. How this relates to their data reliance`
  );
  accumulatedContext += `\n\n--- Data Attribute Analysis ---\n${dataAttribute}`;

  // Prompt 4: Data Uniqueness
  const dataUniqueness = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data uniqueness percentage for ${orgName}. Data uniqueness measures how unique and proprietary the company's data assets are compared to what competitors or the market can access.

Provide:
1. A specific percentage estimate (e.g., "60%")
2. Detailed analysis explaining the estimate
3. What makes their data unique or common`
  );
  accumulatedContext += `\n\n--- Data Uniqueness Analysis ---\n${dataUniqueness}`;

  // Prompt 5: Data Scarcity
  const dataScarcity = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data scarcity percentage for ${orgName}. Data scarcity measures how rare or difficult to replicate the company's data assets are in the market.

Provide:
1. A specific percentage estimate (e.g., "55%")
2. Detailed analysis explaining the estimate
3. Factors that contribute to or reduce scarcity`
  );
  accumulatedContext += `\n\n--- Data Scarcity Analysis ---\n${dataScarcity}`;

  // Prompt 6: Data Ownership
  const dataOwnership = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data ownership percentage for ${orgName}. Data ownership measures what percentage of their data assets they fully own and control, versus data that is licensed, shared, or has usage restrictions.

Provide:
1. A specific percentage estimate (e.g., "80%")
2. Detailed analysis explaining the estimate
3. Ownership structure and any limitations`
  );
  accumulatedContext += `\n\n--- Data Ownership Analysis ---\n${dataOwnership}`;

  // Prompt 7: Sector Reliance
  const sectorReliance = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

What is the typical data reliance percentage for the sector that ${orgName} operates in? Compare ${orgName}'s data reliance to the sector average.

Provide:
1. The sector/industry name
2. Typical sector data reliance percentage
3. How ${orgName} compares to sector average`
  );
  accumulatedContext += `\n\n--- Sector Reliance Analysis ---\n${sectorReliance}`;

  // Prompt 8: Data Collection Analysis (with full context)
  const dataCollection = await callClaude(
    client,
    `Based on the following comprehensive context about ${orgName}:
${accumulatedContext}

Provide a detailed analysis of the data collected by ${orgName}, including:
1. Types of unique data they collect
2. Environmental/ESG data considerations
3. Data collection methods and sources
4. How their data collection supports the metrics analyzed above

Format as a professional paragraph.`
  );
  accumulatedContext += `\n\n--- Data Collection Analysis ---\n${dataCollection}`;

  // Prompt 9: Data Summary with Table (with full context)
  const summaryRaw = await callClaude(
    client,
    `Based on the following comprehensive analysis of ${orgName}:
${accumulatedContext}

Create a powerful and professional data summary for ${orgName} including their competitive advantages.

IMPORTANT: Use the specific percentage values from the analysis above for each metric.

Provide the response in JSON format:
{
  "summary": "Professional summary text synthesizing all the above analysis",
  "competitiveAdvantages": ["advantage 1", "advantage 2", ...],
  "dataProfileTable": [
    {"dataMetric": "Data Reliance", "estimate": "XX%", "strategicSignificance": "significance"},
    {"dataMetric": "Data Scarcity", "estimate": "XX%", "strategicSignificance": "significance"},
    {"dataMetric": "Data Ownership", "estimate": "XX%", "strategicSignificance": "significance"},
    {"dataMetric": "Data Uniqueness", "estimate": "XX%", "strategicSignificance": "significance"}
  ],
  "extractedMetrics": {
    "dataReliancePercent": <number from analysis>,
    "dataAttributePercent": <number from analysis>,
    "dataUniquenessPercent": <number from analysis>,
    "dataScarcityPercent": <number from analysis>,
    "dataOwnershipPercent": <number from analysis>
  }
}

Respond with ONLY the JSON object, no other text.`
  );

  let summaryJson: {
    summary: string;
    competitiveAdvantages: string[];
    dataProfileTable: Array<{
      dataMetric: string;
      estimate: string;
      strategicSignificance: string;
    }>;
    extractedMetrics?: {
      dataReliancePercent?: number;
      dataAttributePercent?: number;
      dataUniquenessPercent?: number;
      dataScarcityPercent?: number;
      dataOwnershipPercent?: number;
    };
  };
  try {
    summaryJson = JSON.parse(extractJSON(summaryRaw));
  } catch {
    summaryJson = {
      summary: '',
      competitiveAdvantages: [],
      dataProfileTable: [],
    };
  }

  // Extract percentages from text responses as fallback
  const extractedMetrics = {
    dataReliancePercent:
      summaryJson.extractedMetrics?.dataReliancePercent ??
      extractPercentageFromText(dataReliance),
    dataAttributePercent:
      summaryJson.extractedMetrics?.dataAttributePercent ??
      extractPercentageFromText(dataAttribute),
    dataUniquenessPercent:
      summaryJson.extractedMetrics?.dataUniquenessPercent ??
      extractPercentageFromText(dataUniqueness),
    dataScarcityPercent:
      summaryJson.extractedMetrics?.dataScarcityPercent ??
      extractPercentageFromText(dataScarcity),
    dataOwnershipPercent:
      summaryJson.extractedMetrics?.dataOwnershipPercent ??
      extractPercentageFromText(dataOwnership),
  };

  const preADVData = {
    overview: overviewText,
    dataReliance: dataReliance ?? '',
    dataAttribute: dataAttribute ?? '',
    dataUniqueness: dataUniqueness ?? '',
    dataScarcity: dataScarcity ?? '',
    dataOwnership: dataOwnership ?? '',
    sectorReliance: sectorReliance ?? '',
    dataCollection,
    summary: summaryJson,
    extractedMetrics,
  };

  return JSON.stringify(preADVData);
}

// Generate Supplementary PDV Report data using Claude
async function generateSupplementaryData(
  client: Anthropic,
  orgName: string,
  preADVDataString?: string
): Promise<string> {
  // Parse preADV data for context
  let preADVContext = '';
  if (preADVDataString) {
    try {
      const preADVData = JSON.parse(preADVDataString) as {
        overview?: string;
        dataReliance?: string;
        dataAttribute?: string;
        dataUniqueness?: string;
        dataScarcity?: string;
        dataOwnership?: string;
        sectorReliance?: string;
        dataCollection?: string;
        extractedMetrics?: PreADVExtractedMetrics;
      };

      preADVContext = `
=== PRE-PDV ANALYSIS CONTEXT ===

Company Overview:
${preADVData.overview ?? 'Not available'}

Data Reliance Analysis:
${preADVData.dataReliance ?? 'Not available'}

Data Attribution Analysis:
${preADVData.dataAttribute ?? 'Not available'}

Data Uniqueness Analysis:
${preADVData.dataUniqueness ?? 'Not available'}

Data Scarcity Analysis:
${preADVData.dataScarcity ?? 'Not available'}

Data Ownership Analysis:
${preADVData.dataOwnership ?? 'Not available'}

Sector Reliance Analysis:
${preADVData.sectorReliance ?? 'Not available'}

Data Collection Analysis:
${preADVData.dataCollection ?? 'Not available'}

Extracted Metrics:
- Data Reliance: ${preADVData.extractedMetrics?.dataReliancePercent ?? 'N/A'}%
- Data Attribution: ${
        preADVData.extractedMetrics?.dataAttributePercent ?? 'N/A'
      }%
- Data Uniqueness: ${
        preADVData.extractedMetrics?.dataUniquenessPercent ?? 'N/A'
      }%
- Data Scarcity: ${preADVData.extractedMetrics?.dataScarcityPercent ?? 'N/A'}%
- Data Ownership: ${preADVData.extractedMetrics?.dataOwnershipPercent ?? 'N/A'}%

=== END PRE-PDV CONTEXT ===
`;
    } catch {
      console.warn('Failed to parse preADVData for supplementary context');
    }
  }

  const comparisonRaw = await callClaude(
    client,
    `${preADVContext}

For ${orgName}, create a comprehensive Data Profile and Competitive Moat comparison with their sector and geography across 5 data metrics - data reliance, data attribution, data uniqueness, data scarcity, and data ownership percentages.

IMPORTANT: Use the metrics from the Pre-PDV Analysis Context above to ensure consistency. The organization values in the comparison should match the extracted metrics.

Provide response in JSON format:
{
  "sectorName": "sector name",
  "geographyName": "geography",
  "comparisonTable": [
    {"dataMetric": "Data Reliance", "organizationValue": "<use extracted metric>%", "sectorValue": "value%", "geographyValue": "value%"},
    {"dataMetric": "Data Attribution", "organizationValue": "<use extracted metric>%", "sectorValue": "value%", "geographyValue": "value%"},
    {"dataMetric": "Data Uniqueness", "organizationValue": "<use extracted metric>%", "sectorValue": "value%", "geographyValue": "value%"},
    {"dataMetric": "Data Scarcity", "organizationValue": "<use extracted metric>%", "sectorValue": "value%", "geographyValue": "value%"},
    {"dataMetric": "Data Ownership", "organizationValue": "<use extracted metric>%", "sectorValue": "value%", "geographyValue": "value%"}
  ],
  "qualitativeComparison": "detailed multiparagraph text analysis of primary data moat including multiple pointers, referencing the Pre-PDV analysis findings",
  "radarChartData": {
    "dataMetrics": ["Data Reliance", "Data Attribution", "Data Uniqueness", "Data Scarcity", "Data Ownership"],
    "organizationValues": [<numeric values matching extracted metrics>],
    "sectorValues": [<numeric sector average values>]
  }
}

Respond with ONLY the JSON object, no other text.`
  );

  let comparisonJson: Record<string, unknown>;
  try {
    comparisonJson = JSON.parse(extractJSON(comparisonRaw));
  } catch {
    comparisonJson = {};
  }

  return JSON.stringify(comparisonJson);
}

// Type for preADVData extracted metrics
interface PreADVExtractedMetrics {
  dataReliancePercent?: number | null;
  dataAttributePercent?: number | null;
  dataUniquenessPercent?: number | null;
  dataScarcityPercent?: number | null;
  dataOwnershipPercent?: number | null;
}

interface PreADVData {
  extractedMetrics?: PreADVExtractedMetrics;
}

// Helper to check if a percentage value is unrealistic (0 or 100)
function isUnrealisticPercent(value: number | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  return value <= 0 || value >= 100;
}

// Generate PDV calculation data using Claude
async function generatePDVCalculation(
  client: Anthropic,
  pdvAnswers: Array<{ question: string; answer: string }>,
  preADVDataString?: string
): Promise<{
  advReportData: string;
  lowerADVRange: string;
  upperADVRange: string;
} | null> {
  if (pdvAnswers.length === 0) return null;

  // Parse preADVData for fallback values
  let preADVMetrics: PreADVExtractedMetrics = {};
  if (preADVDataString) {
    try {
      const preADVData = JSON.parse(preADVDataString) as PreADVData;
      preADVMetrics = preADVData.extractedMetrics ?? {};
    } catch {
      console.warn('Failed to parse preADVData for fallback metrics');
    }
  }

  const getAnswer = (q: string) =>
    pdvAnswers.find((a) => a.question === q)?.answer ?? 'Not provided';

  const extractPrompt = `You are a data extraction expert. Extract structured numerical data from the following user responses.

Questions and Answers:
1. How long has your business been collecting data?
   Answer: ${getAnswer('How long has your business been collecting data?')}

2. What percentage of business is attributable to data?
   Answer: ${getAnswer('What percentage of business is attributable to data?')}

3. What percentage of business is data reliant?
   Answer: ${getAnswer('What percentage of business is data reliant?')}

4. What is the current market value of your business?
   Answer: ${getAnswer('What is the current market value of your business?')}

5. For each year collecting data, what was the company valuation each year?
   Answer: ${getAnswer(
     'For each year collecting data, what was the company valuation each year?'
   )}

Extract and provide the following in JSON format:
{
  "yearsCollectingData": <number of years as integer>,
  "dataAttributablePercent": <percentage as decimal, e.g., 75 for 75%>,
  "dataReliancePercent": <percentage as decimal, e.g., 80 for 80%>,
  "currentCompanyValue": <current market value as number without commas or currency symbols>,
  "yearlyValuations": [<array of company valuations for each year, starting from first year of data collection to present. If not provided by user, calculate: start at 10% of current value, increase by 10% of current value each year until reaching current value, then hold at current value>]
}

Important:
- All percentages should be decimals (e.g., 75 not 0.75)
- All monetary values should be numbers without commas or symbols
- yearlyValuations should be an array with length equal to yearsCollectingData
- Current year is ${new Date().getFullYear()}

Respond with ONLY the JSON object, no other text.`;

  const extractRaw = await callClaude(client, extractPrompt, {
    systemPrompt:
      'You are a data extraction expert. Extract structured numerical data from unstructured text. Always respond with valid JSON only.',
  });

  let extractedData: {
    yearsCollectingData: number;
    dataAttributablePercent: number;
    dataReliancePercent: number;
    currentCompanyValue: number;
    yearlyValuations: number[];
  };

  try {
    extractedData = JSON.parse(extractJSON(extractRaw));
  } catch {
    console.error('Failed to parse PDV extraction response');
    return null;
  }

  // Use preADVData values if extractedData has unrealistic values (0 or 100%)
  const dataReliancePercent = isUnrealisticPercent(
    extractedData.dataReliancePercent
  )
    ? preADVMetrics.dataReliancePercent ?? 50
    : extractedData.dataReliancePercent;

  const dataAttributablePercent = isUnrealisticPercent(
    extractedData.dataAttributablePercent
  )
    ? preADVMetrics.dataAttributePercent ?? 50
    : extractedData.dataAttributablePercent;

  // Get additional metrics from preADVData (these are discounting factors)
  const dataScarcityPercent = preADVMetrics.dataScarcityPercent ?? 50;
  const dataOwnershipPercent = preADVMetrics.dataOwnershipPercent ?? 80;
  const dataUniquenessPercent = preADVMetrics.dataUniquenessPercent ?? 50;

  // Calculate PDV with default parameters
  const dataDecayPercent = 12.5;
  const lowerBoundDiscountPercent = 30;

  const totalValuation = extractedData.yearlyValuations.reduce(
    (sum, val) => sum + val,
    0
  );

  // Step 1: Apply data reliance to get base data valuation
  const dataRelianceValuation = totalValuation * (dataReliancePercent / 100);

  // Step 2: Apply data decay (depreciation over time)
  const dataDecayMultiplier = 1 - dataDecayPercent / 100;
  const afterDecay = dataRelianceValuation * dataDecayMultiplier;

  // Step 3: Apply discounting factors (scarcity, ownership, uniqueness)
  // These factors adjust the valuation based on the quality and control of data assets
  // Higher percentages mean better data quality, so we use them as multipliers
  // We average the three factors to create a combined quality multiplier
  const dataQualityScore =
    (dataScarcityPercent + dataOwnershipPercent + dataUniquenessPercent) / 3;
  const dataQualityMultiplier = dataQualityScore / 100;
  const upperADV = afterDecay * dataQualityMultiplier;

  // Step 4: Apply lower bound discount for conservative estimate
  const lowerDiscountMultiplier = 1 - lowerBoundDiscountPercent / 100;
  const lowerADV = upperADV * lowerDiscountMultiplier;

  const roundedUpperADV = Math.round(upperADV);
  const roundedLowerADV = Math.round(lowerADV);

  const lowerPercent = (
    (roundedLowerADV / extractedData.currentCompanyValue) *
    100
  ).toFixed(1);
  const upperPercent = (
    (roundedUpperADV / extractedData.currentCompanyValue) *
    100
  ).toFixed(1);

  // Build Q&A table
  const qaTable = pdvAnswers.map((a) => ({
    question: a.question,
    answer: a.answer,
  }));

  const advData = {
    lowerADV: roundedLowerADV,
    upperADV: roundedUpperADV,
    chartData: {
      labels: ['Bottom PDV Range', 'Top PDV Range'],
      values: [roundedLowerADV, roundedUpperADV],
      percentages: {
        lower: `${lowerPercent}%`,
        upper: `${upperPercent}%`,
      },
    },
    calculationDetails: {
      totalValuation,
      dataRelianceValuation,
      dataDecayPercent,
      lowerBoundDiscountPercent,
      yearsCollectingData: extractedData.yearsCollectingData,
      dataReliancePercent,
      dataAttributablePercent,
      currentCompanyValue: extractedData.currentCompanyValue,
      // New discounting factors
      dataScarcityPercent,
      dataOwnershipPercent,
      dataUniquenessPercent,
      dataQualityScore,
      // Calculation breakdown
      calculationBreakdown: {
        step1_totalValuation: totalValuation,
        step2_afterDataReliance: dataRelianceValuation,
        step3_afterDataDecay: afterDecay,
        step4_dataQualityMultiplier: dataQualityMultiplier,
        step5_upperADV: roundedUpperADV,
        step6_lowerADV: roundedLowerADV,
      },
      // Source of values (whether from user input or preADV fallback)
      valueSources: {
        dataReliancePercent: isUnrealisticPercent(
          extractedData.dataReliancePercent
        )
          ? 'preADV'
          : 'userInput',
        dataAttributablePercent: isUnrealisticPercent(
          extractedData.dataAttributablePercent
        )
          ? 'preADV'
          : 'userInput',
        dataScarcityPercent: 'preADV',
        dataOwnershipPercent: 'preADV',
        dataUniquenessPercent: 'preADV',
      },
    },
    qaTable,
  };

  return {
    advReportData: JSON.stringify(advData),
    lowerADVRange: `$${(roundedLowerADV / 1000000).toFixed(1)}M`,
    upperADVRange: `$${(roundedUpperADV / 1000000).toFixed(1)}M`,
  };
}

// Main worker function that processes the PDV report job
export interface PDVReportJobResult {
  success: boolean;
  error?: string;
  emailData?: {
    subdomain: string;
    reportId: string;
    fromEmail: string;
    toEmail: string;
    subject: string;
    htmlBody: string;
    textBody: string;
    attachments: Array<{
      Name: string;
      Content: string;
      ContentID: string;
      ContentType: string;
    }>;
  };
}

export async function processPDVReportJob(
  jobData: PDVReportJobData
): Promise<PDVReportJobResult> {
  const {
    reportId,
    orgName,
    enableADV,
    pdvAnswers,
    userEmail,
    subdomain,
    organizationId,
    platformId,
  } = jobData;

  console.log(
    `🚀 Starting PDV report generation for ${orgName} (report: ${reportId})`
  );

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let preADVReportData = '';
  let supplementaryADVReportData = '';
  let advReportData = '';
  let lowerADVRange = '';
  let upperADVRange = '';

  try {
    // Step 1: Generate Pre-PDV Report data
    console.log('📊 Generating Pre-PDV report data...');
    try {
      preADVReportData = await generatePrePDVData(client, orgName);
    } catch (error) {
      console.error('Error generating Pre-PDV report:', error);
    }

    // Step 2: Generate Supplementary PDV Report data (with preADV context for consistency)
    console.log('📈 Generating Supplementary PDV report data...');
    try {
      supplementaryADVReportData = await generateSupplementaryData(
        client,
        orgName,
        preADVReportData
      );
    } catch (error) {
      console.error('Error generating Supplementary report:', error);
    }

    // Step 3: Generate PDV calculation if enabled
    if (enableADV) {
      console.log('🔢 Generating PDV calculation...');
      try {
        // Pass preADVReportData for fallback values when user input is unrealistic
        const pdvResult = await generatePDVCalculation(
          client,
          pdvAnswers,
          preADVReportData
        );
        if (pdvResult) {
          advReportData = pdvResult.advReportData;
          lowerADVRange = pdvResult.lowerADVRange;
          upperADVRange = pdvResult.upperADVRange;
        }
      } catch (error) {
        console.error('Error generating PDV calculation:', error);
      }
    }

    // Step 4: Generate PDF
    console.log('📄 Generating PDF...');
    let pdfReportData: string | null = null;
    try {
      const parsedPreADV = preADVReportData
        ? JSON.parse(preADVReportData)
        : null;
      const parsedSupplementary = supplementaryADVReportData
        ? JSON.parse(supplementaryADVReportData)
        : null;
      const parsedADV = advReportData ? JSON.parse(advReportData) : null;

      const pdfBlob = await generateUnifiedADVPDFClient(
        orgName,
        parsedPreADV,
        parsedSupplementary,
        parsedADV
      );

      const arrayBuffer = await pdfBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      pdfReportData = buffer.toString('base64');
    } catch (error) {
      console.error('Error generating PDF:', error);
    }

    // Step 5: Update the Report in the database
    console.log('💾 Updating report in database...');
    await db.report.update({
      where: { id: reportId },
      data: {
        preADVData: preADVReportData || null,
        supplementADVData: supplementaryADVReportData || null,
        ADVdata: advReportData || null,
        lowerADVRange: lowerADVRange || null,
        upperADVRange: upperADVRange || null,
        pdfReportData: pdfReportData,
      },
    });

    // Step 6: Schedule email via the existing EmailQueue
    // This is done by returning the email data - the caller (queue processor) will handle scheduling
    if (pdfReportData && userEmail) {
      console.log('📧 Scheduling email delivery...');
      const reportTitle = `PDV Report - ${orgName}`;

      // We return the email data so the queue.ts can schedule it in EmailQueue
      return {
        success: true,
        emailData: {
          subdomain,
          reportId,
          fromEmail: 'james@12butterflies.life',
          toEmail: userEmail,
          subject: `Your ${reportTitle} is Ready`,
          htmlBody: generateEmailHTML(reportTitle, orgName),
          textBody: generateEmailText(reportTitle, orgName),
          attachments: [
            {
              Name: `${reportTitle}.pdf`,
              Content: pdfReportData,
              ContentID: 'adv-report-pdf',
              ContentType: 'application/pdf',
            },
          ],
        },
      };
    }

    console.log(`✅ PDV report generation completed for ${orgName}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ PDV report generation failed for ${orgName}:`, error);

    // Update report with error status
    try {
      await db.report.update({
        where: { id: reportId },
        data: {
          deliveryStatus: 'DELIVERY_FAILED',
          emailDeliveryError:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });
    } catch (dbError) {
      console.error('Failed to update report error status:', dbError);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function generateEmailHTML(reportTitle: string, orgName: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #2563eb; color: white; padding: 20px; text-align: center; }
          .content { background-color: #f9fafb; padding: 30px; }
          .button { background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; }
          .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Your PDV Report is Ready</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>Your <strong>${reportTitle}</strong> for ${orgName} has been generated and is attached to this email.</p>
            <p>The report contains a comprehensive assessment of your data assets including:</p>
            <ul>
              <li>Asset Data Valuation (PDV) calculations</li>
              <li>Preliminary Data Valuation questionnaire results</li>
              <li>Competitive analysis and market positioning</li>
              <li>Strategic recommendations</li>
            </ul>
            <p>Please find the complete report in the PDF attachment.</p>
            <p>If you have any questions about your report, please don't hesitate to contact your advisor.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} PDV Reports. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

function generateEmailText(reportTitle: string, orgName: string): string {
  return `
Your ${reportTitle} is Ready

Hello,

Your ${reportTitle} for ${orgName} has been generated and is attached to this email.

The report contains a comprehensive assessment of your data assets including:
- Asset Data Valuation (PDV) calculations
- Preliminary Data Valuation questionnaire results
- Competitive analysis and market positioning
- Strategic recommendations

Please find the complete report in the PDF attachment.

If you have any questions about your report, please don't hesitate to contact your advisor.

© ${new Date().getFullYear()} PDV Reports. All rights reserved.
  `;
}
