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

// Default system prompt to ensure clean, professional responses
const DEFAULT_SYSTEM_PROMPT = `You are a professional business analyst providing data valuation reports.

CRITICAL INSTRUCTIONS:
1. NEVER include meta-commentary about your process (e.g., "I'll search for...", "Let me find...", "I notice that...")
2. NEVER mention that information is incomplete, unavailable, or that you need to search
3. Provide DIRECT, FACTUAL responses only - as if you already have all the information
4. If you don't have specific data, provide reasonable industry estimates based on the company's sector
5. Write in a professional, authoritative tone suitable for business reports
6. NEVER include phrases like "Based on my search", "According to my findings", "I found that"
7. Start responses directly with the content - no preambles or explanations of what you're doing`;

// Helper to sanitize Claude responses by removing meta-commentary
function sanitizeResponse(text: string): string {
  // Patterns to remove meta-commentary
  const metaPatterns = [
    /^(I'll|Let me|I need to|I will|I'm going to|First,? I'll|I notice that|I should|I can|Based on my search,?)\s+[^.]*?\.\s*/gi,
    /\b(I'll need to search|I notice that|I found that|Based on my findings|According to my search|My search shows|Let me search|I'm searching)\b[^.]*?\.\s*/gi,
    /\b(appears to be incomplete|information is not available|could not find|unable to locate|no specific information)\b[^.]*?\.\s*/gi,
    /^(Searching|Looking for|Analyzing|Processing|Gathering).*?\.\s*/gim,
  ];

  let cleaned = text;
  for (const pattern of metaPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove any leading/trailing whitespace and normalize spacing
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

// Helper to call Claude API
async function callClaude(
  client: Anthropic,
  prompt: string,
  options?: {
    systemPrompt?: string;
    maxTokens?: number;
    jsonMode?: boolean;
    skipSanitization?: boolean;
    metricName?: string; // For logging purposes
  }
): Promise<string> {
  // Use custom system prompt if provided, otherwise use default
  const systemPrompt = options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const metricName = options?.metricName ?? 'unknown';

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🤖 [Claude API] Starting call for: ${metricName}`);
  console.log(`📝 [Claude API] Prompt length: ${prompt.length} characters`);
  console.log(`⚙️ [Claude API] Max tokens: ${options?.maxTokens ?? 5000}`);
  console.log(
    `🔧 [Claude API] Skip sanitization: ${options?.skipSanitization ?? false}`
  );

  const startTime = Date.now();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: options?.maxTokens ?? 5000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
      },
    ],
  });

  const elapsed = Date.now() - startTime;
  console.log(`⏱️ [Claude API] Response received in ${elapsed}ms`);
  console.log(`📊 [Claude API] Stop reason: ${message.stop_reason}`);
  console.log(`📊 [Claude API] Content blocks: ${message.content.length}`);
  console.log(
    `📊 [Claude API] Usage - Input tokens: ${message.usage.input_tokens}, Output tokens: ${message.usage.output_tokens}`
  );

  // Log all content blocks for debugging
  message.content.forEach((block, index) => {
    console.log(`📦 [Claude API] Block ${index}: type=${block.type}`);
    if (block.type === 'text' && 'text' in block) {
      console.log(
        `📄 [Claude API] Text block length: ${block.text.length} characters`
      );
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      console.log(`🔧 [Claude API] Tool use: ${JSON.stringify(block)}`);
    }
  });

  // IMPORTANT: Concatenate ALL text blocks, not just the first one!
  // When using web_search, Claude returns multiple text blocks spread across the response
  const textBlocks = message.content.filter((block) => block.type === 'text');
  let response = textBlocks
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

  console.log(
    `📊 [Claude API] Found ${textBlocks.length} text blocks, concatenated length: ${response.length} characters`
  );

  console.log(`\n📥 [Claude API] RAW RESPONSE for ${metricName}:`);
  console.log(`${'─'.repeat(60)}`);
  console.log(response);
  console.log(`${'─'.repeat(60)}`);

  // Sanitize response unless explicitly skipped (e.g., for JSON responses)
  if (!options?.skipSanitization && !options?.jsonMode) {
    const originalLength = response.length;
    response = sanitizeResponse(response);
    console.log(
      `🧹 [Claude API] Sanitized response: ${originalLength} → ${response.length} characters`
    );
  }

  console.log(`✅ [Claude API] Completed: ${metricName}`);
  console.log(`${'='.repeat(80)}\n`);

  return response;
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
  console.log(`\n${'█'.repeat(80)}`);
  console.log(
    `🚀 [generatePrePDVData] Starting data generation for: ${orgName}`
  );
  console.log(`${'█'.repeat(80)}\n`);

  // Accumulated context from previous responses
  let accumulatedContext = '';

  // Prompt 1: Company Overview
  console.log('\n📋 [generatePrePDVData] Step 1/9: Company Overview');
  const overviewText = await callClaude(
    client,
    `Provide a professional 5-line overview for ${orgName}. Focus on their business model, industry and sector position, and key operations.`,
    { maxTokens: 300, metricName: 'Company Overview' }
  );
  accumulatedContext += `\n\n--- Company Overview ---\n${overviewText}`;

  // Sequential metric prompts with accumulated context
  // Prompt 2: Data Reliance
  console.log('\n📋 [generatePrePDVData] Step 2/9: Data Reliance');
  const dataReliance = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data reliance percentage for ${orgName}. Data reliance measures how dependent the company's operations, revenue, and competitive advantage are on data assets.

Provide a COMPREHENSIVE response with:
1. **Percentage Estimate**: A specific percentage estimate (e.g., "75%")

2. **Detailed Analysis** (around 1-2 paragraphs):
   - How data drives their core business operations
   - Revenue streams that depend on data
   - Decision-making processes that rely on data
   - Operational dependencies on data infrastructure

3. **Key Factors**: List and explain 5-7 specific factors that influence this percentage for ${orgName}

Format with clear markdown headers (##) for each section.`,
    { maxTokens: 2000, metricName: 'Data Reliance' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Reliance response length: ${dataReliance.length} characters`
  );
  accumulatedContext += `\n\n--- Data Reliance Analysis ---\n${dataReliance}`;

  // Prompt 3: Data Driven
  console.log('\n📋 [generatePrePDVData] Step 3/9: Data Driven');
  const dataAttribute = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data driven percentage for ${orgName}. Data driven measures what percentage of the company's business value can be directly attributed to their data assets.

Provide a COMPREHENSIVE response with:
1. **Percentage Estimate**: A specific percentage estimate (e.g., "70%")

2. **Detailed Analysis** (around 1-2 paragraphs):
   - How data directly contributes to revenue generation
   - Products or services that are data-driven
   - Customer value derived from data capabilities
   - Intellectual property value in data


3. **Relationship to Data Reliance**: Explain how the data attribute percentage relates to their data reliance (${
      extractPercentageFromText(dataReliance) ?? 'previously estimated'
    }%)

4. **Data driven Breakdown**: Break down the data drivers across different business areas

Format with clear markdown headers (##) for each section.`,
    { maxTokens: 2000, metricName: 'Data Driven' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Driven response length: ${dataAttribute.length} characters`
  );
  accumulatedContext += `\n\n--- Data Driven Analysis ---\n${dataAttribute}`;

  // Prompt 4: Data Uniqueness
  console.log('\n📋 [generatePrePDVData] Step 4/9: Data Uniqueness');
  const dataUniqueness = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data uniqueness percentage for ${orgName}. Data uniqueness measures how unique and proprietary the company's data assets are compared to what competitors or the market can access.

Provide a COMPREHENSIVE response with:
1. **Percentage Estimate**: A specific percentage estimate (e.g., "60%")

2. **Detailed Analysis** (around 1-2 paragraphs):
   - Proprietary data sources and collection methods
   - Unique data types that competitors cannot access
   - Data derived from exclusive partnerships or relationships
   - Customer or user-generated unique data

3. **Uniqueness Factors**:
   - What makes their data different from competitors
   - Barriers preventing competitors from replicating this data
   - Time-based advantages in data accumulation

4. **Commonality Assessment**:
   - Data that is similar to industry standards
   - Publicly available data components
   - Shared industry data

Format with clear markdown headers (##) for each section.`,
    { maxTokens: 2000, metricName: 'Data Uniqueness' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Uniqueness response length: ${dataUniqueness.length} characters`
  );
  accumulatedContext += `\n\n--- Data Uniqueness Analysis ---\n${dataUniqueness}`;

  // Prompt 5: Data Scarcity
  console.log('\n📋 [generatePrePDVData] Step 5/9: Data Scarcity');
  const dataScarcity = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data scarcity percentage for ${orgName}. Data scarcity measures how rare or difficult to replicate the company's data assets are in the market.

Provide a COMPREHENSIVE response with:
1. **Percentage Estimate**: A specific percentage estimate (e.g., "55%")

2. **Detailed Analysis** (around 1-2 paragraphs):
   - Data that is inherently rare in the market
   - Time and cost barriers to collecting similar data
   - Regulatory or access barriers that create scarcity

3. **Scarcity Factors**:
   - Market conditions that create data scarcity
   - Technical barriers to data replication
   - Economic factors affecting data availability

4. **Abundance Assessment**:
   - Data that is commonly available
   - Data that can be purchased or licensed
   - Data that competitors can easily obtain

Format with clear markdown headers (##) for each section.`,
    { maxTokens: 2000, metricName: 'Data Scarcity' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Scarcity response length: ${dataScarcity.length} characters`
  );
  accumulatedContext += `\n\n--- Data Scarcity Analysis ---\n${dataScarcity}`;

  // Prompt 6: Data Ownership
  console.log('\n📋 [generatePrePDVData] Step 6/9: Data Ownership');
  const dataOwnership = await callClaude(
    client,
    `Based on the following context about ${orgName}:
${accumulatedContext}

Estimate the data ownership percentage for ${orgName}. Data ownership measures what percentage of their data assets they fully own and control, versus data that is licensed, shared, or has usage restrictions.

Provide a COMPREHENSIVE response with:
1. **Percentage Estimate**: A specific percentage estimate (e.g., "80%")

2. **Detailed Analysis** (around 1-2 paragraphs):
   - Data assets that are fully owned and controlled
   - First-party data collection and ownership
   - Licensed or third-party data dependencies
   - Data partnership arrangements and shared data
   - Legal and contractual ownership considerations
   - Geographic and regulatory ownership implications

3. **Ownership Structure**:
   - Breakdown of owned vs licensed vs shared data
   - Key data licensing agreements or dependencies
   - Strategic importance of proprietary data

4. **Limitations and Risks**:
   - Usage restrictions on certain data
   - Contractual limitations
   - Regulatory constraints on data use
   - Risks from data ownership gaps

Format with clear markdown headers (##) for each section.`,
    { maxTokens: 2000, metricName: 'Data Ownership' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Ownership response length: ${dataOwnership.length} characters`
  );
  accumulatedContext += `\n\n--- Data Ownership Analysis ---\n${dataOwnership}`;

  // Prompt 8: Data Collection Analysis (with full context)
  console.log('\n📋 [generatePrePDVData] Step 8/9: Data Collection');
  const dataCollection = await callClaude(
    client,
    `Based on the following comprehensive context about ${orgName}:
${accumulatedContext}

Provide a detailed analysis of the data collected by ${orgName}, including:
1. Types of unique data they collect
2. Environmental/ESG data considerations
3. Data collection methods and sources
4. How their data collection supports the metrics analyzed above

Format as a professional paragraph.`,
    { metricName: 'Data Collection' }
  );
  console.log(
    `📊 [generatePrePDVData] Data Collection response length: ${dataCollection.length} characters`
  );
  accumulatedContext += `\n\n--- Data Collection Analysis ---\n${dataCollection}`;

  // Prompt 9: Data Summary with Table (with full context)
  console.log('\n📋 [generatePrePDVData] Step 9/9: Data Summary (JSON)');
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

Respond with ONLY the JSON object, no other text.`,
    {
      skipSanitization: true,
      systemPrompt:
        'You are a JSON data formatter. Respond with ONLY valid JSON. No explanatory text, no markdown code blocks, just the raw JSON object.',
      metricName: 'Data Summary JSON',
    }
  );
  console.log(
    `📊 [generatePrePDVData] Summary JSON raw length: ${summaryRaw.length} characters`
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
    const extractedJson = extractJSON(summaryRaw);
    console.log(
      `📋 [generatePrePDVData] Extracted JSON length: ${extractedJson.length} characters`
    );
    console.log(
      `📋 [generatePrePDVData] Extracted JSON preview: ${extractedJson.substring(
        0,
        500
      )}...`
    );
    summaryJson = JSON.parse(extractedJson);
    console.log(`✅ [generatePrePDVData] JSON parsed successfully`);
    console.log(
      `📋 [generatePrePDVData] Summary length: ${
        summaryJson.summary?.length ?? 0
      } characters`
    );
    console.log(
      `📋 [generatePrePDVData] Competitive advantages count: ${
        summaryJson.competitiveAdvantages?.length ?? 0
      }`
    );
    console.log(
      `📋 [generatePrePDVData] Data profile table count: ${
        summaryJson.dataProfileTable?.length ?? 0
      }`
    );
    console.log(
      `📋 [generatePrePDVData] Extracted metrics:`,
      JSON.stringify(summaryJson.extractedMetrics, null, 2)
    );
  } catch (parseError) {
    console.error(
      `❌ [generatePrePDVData] Failed to parse summary JSON:`,
      parseError
    );
    console.error(
      `📋 [generatePrePDVData] Raw summary that failed to parse: ${summaryRaw}`
    );
    summaryJson = {
      summary: '',
      competitiveAdvantages: [],
      dataProfileTable: [],
    };
  }

  // Extract percentages from text responses as fallback
  console.log(
    `\n📊 [generatePrePDVData] Extracting percentages from text responses...`
  );
  console.log(
    `📊 [generatePrePDVData] Data Reliance text extraction: ${extractPercentageFromText(
      dataReliance
    )}`
  );
  console.log(
    `📊 [generatePrePDVData] Data Attribute text extraction: ${extractPercentageFromText(
      dataAttribute
    )}`
  );
  console.log(
    `📊 [generatePrePDVData] Data Uniqueness text extraction: ${extractPercentageFromText(
      dataUniqueness
    )}`
  );
  console.log(
    `📊 [generatePrePDVData] Data Scarcity text extraction: ${extractPercentageFromText(
      dataScarcity
    )}`
  );
  console.log(
    `📊 [generatePrePDVData] Data Ownership text extraction: ${extractPercentageFromText(
      dataOwnership
    )}`
  );

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

  console.log(`\n📊 [generatePrePDVData] FINAL EXTRACTED METRICS:`);
  console.log(JSON.stringify(extractedMetrics, null, 2));

  const preADVData = {
    overview: overviewText,
    dataReliance: dataReliance ?? '',
    dataAttribute: dataAttribute ?? '',
    dataUniqueness: dataUniqueness ?? '',
    dataScarcity: dataScarcity ?? '',
    dataOwnership: dataOwnership ?? '',
    dataCollection,
    summary: summaryJson,
    extractedMetrics,
  };

  console.log(`\n${'█'.repeat(80)}`);
  console.log(
    `✅ [generatePrePDVData] Completed data generation for: ${orgName}`
  );
  console.log(
    `📊 [generatePrePDVData] Overview length: ${overviewText.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Reliance length: ${dataReliance.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Attribute length: ${dataAttribute.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Uniqueness length: ${dataUniqueness.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Scarcity length: ${dataScarcity.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Ownership length: ${dataOwnership.length} chars`
  );
  console.log(
    `📊 [generatePrePDVData] Data Collection length: ${dataCollection.length} chars`
  );
  console.log(`${'█'.repeat(80)}\n`);

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

  console.log(`\n${'█'.repeat(80)}`);
  console.log(
    `🚀 [generateSupplementaryData] Starting supplementary data generation for: ${orgName}`
  );
  console.log(
    `📊 [generateSupplementaryData] PreADV context length: ${preADVContext.length} characters`
  );
  console.log(`${'█'.repeat(80)}\n`);

  const comparisonRaw = await callClaude(
    client,
    `${preADVContext}

For ${orgName}, identify the 5 closest competitors in the same sector and create a comprehensive Data Profile and Competitive Moat comparison across 5 data metrics - data reliance, data attribution, data uniqueness, data scarcity, and data ownership percentages.

IMPORTANT: Use the metrics from the Pre-PDV Analysis Context above to ensure consistency. The organization values in the comparison should match the extracted metrics. Name the 5 closest real competitors in the same sector.

Provide response in JSON format:
{
  "sectorName": "sector name",
  "competitors": ["Competitor 1 Name", "Competitor 2 Name", "Competitor 3 Name", "Competitor 4 Name", "Competitor 5 Name"],
  "comparisonTable": [
    {"dataMetric": "Data Reliance", "organizationValue": "<use extracted metric>%", "competitor1Value": "value%", "competitor2Value": "value%", "competitor3Value": "value%", "competitor4Value": "value%", "competitor5Value": "value%"},
    {"dataMetric": "Data Attribution", "organizationValue": "<use extracted metric>%", "competitor1Value": "value%", "competitor2Value": "value%", "competitor3Value": "value%", "competitor4Value": "value%", "competitor5Value": "value%"},
    {"dataMetric": "Data Uniqueness", "organizationValue": "<use extracted metric>%", "competitor1Value": "value%", "competitor2Value": "value%", "competitor3Value": "value%", "competitor4Value": "value%", "competitor5Value": "value%"},
    {"dataMetric": "Data Scarcity", "organizationValue": "<use extracted metric>%", "competitor1Value": "value%", "competitor2Value": "value%", "competitor3Value": "value%", "competitor4Value": "value%", "competitor5Value": "value%"},
    {"dataMetric": "Data Ownership", "organizationValue": "<use extracted metric>%", "competitor1Value": "value%", "competitor2Value": "value%", "competitor3Value": "value%", "competitor4Value": "value%", "competitor5Value": "value%"}
  ],
  "qualitativeComparison": "detailed multiparagraph text analysis of primary data moat including multiple pointers, referencing the Pre-PDV analysis findings and comparing against the 5 competitors",
  "radarChartData": {
    "dataMetrics": ["Data Reliance", "Data Attribution", "Data Uniqueness", "Data Scarcity", "Data Ownership"],
    "organizationValues": [<numeric values matching extracted metrics>],
    "competitor1Values": [<numeric values for competitor 1>],
    "competitor2Values": [<numeric values for competitor 2>],
    "competitor3Values": [<numeric values for competitor 3>],
    "competitor4Values": [<numeric values for competitor 4>],
    "competitor5Values": [<numeric values for competitor 5>]
  }
}

Respond with ONLY the JSON object, no other text.`,
    {
      skipSanitization: true,
      systemPrompt:
        'You are a JSON data formatter. Respond with ONLY valid JSON. No explanatory text, no markdown code blocks, just the raw JSON object.',
      metricName: 'Supplementary Comparison JSON',
    }
  );

  console.log(
    `📊 [generateSupplementaryData] Comparison JSON raw length: ${comparisonRaw.length} characters`
  );

  let comparisonJson: Record<string, unknown>;
  try {
    const extractedJson = extractJSON(comparisonRaw);
    console.log(
      `📋 [generateSupplementaryData] Extracted JSON length: ${extractedJson.length} characters`
    );
    comparisonJson = JSON.parse(extractedJson);
    console.log(`✅ [generateSupplementaryData] JSON parsed successfully`);
    console.log(
      `📊 [generateSupplementaryData] Sector name: ${comparisonJson.sectorName}`
    );
    console.log(
      `📊 [generateSupplementaryData] Geography: ${comparisonJson.geographyName}`
    );
    console.log(
      `📊 [generateSupplementaryData] Comparison table entries: ${
        (comparisonJson.comparisonTable as unknown[])?.length ?? 0
      }`
    );
    console.log(
      `📊 [generateSupplementaryData] Qualitative comparison length: ${
        (comparisonJson.qualitativeComparison as string)?.length ?? 0
      } chars`
    );
    console.log(
      `📊 [generateSupplementaryData] Radar chart data:`,
      JSON.stringify(comparisonJson.radarChartData, null, 2)
    );
  } catch (parseError) {
    console.error(
      `❌ [generateSupplementaryData] Failed to parse comparison JSON:`,
      parseError
    );
    console.error(
      `📋 [generateSupplementaryData] Raw comparison that failed to parse: ${comparisonRaw}`
    );
    comparisonJson = {};
  }

  console.log(`\n${'█'.repeat(80)}`);
  console.log(
    `✅ [generateSupplementaryData] Completed supplementary data generation`
  );
  console.log(`${'█'.repeat(80)}\n`);

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
    skipSanitization: true,
    systemPrompt:
      'You are a data extraction expert. Extract structured numerical data from unstructured text. Always respond with valid JSON only. No explanatory text.',
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
              <li>Preliminary Data Valuation (PDV) calculations</li>
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
- Preliminary Data Valuation (PDV) calculations
- Preliminary Data Valuation questionnaire results
- Competitive analysis and market positioning
- Strategic recommendations

Please find the complete report in the PDF attachment.

If you have any questions about your report, please don't hesitate to contact your advisor.

© ${new Date().getFullYear()} PDV Reports. All rights reserved.
  `;
}
