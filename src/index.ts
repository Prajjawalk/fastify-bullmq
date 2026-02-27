import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { env } from './env';
import {
  createQueue,
  setupQueueProcessor,
  setupPDVReportProcessor,
} from './queue';
import { FromSchema } from 'json-schema-to-ts';
import EventEmitter from 'events';
import fastifySSE from '@fastify/sse';
import { db } from './db';
import { fetchTranscriptFromFireflies } from './fireflies';
import { MeetingProcessingStatus } from '@prisma/client';
import { whatsappService } from './whatsapp';

const email = {
  type: 'object',
  properties: {
    subdomain: { type: 'string' },
    reportId: { type: 'string' },
    fromEmail: { type: 'string' },
    toEmail: { type: 'string' },
    subject: { type: 'string' },
    htmlBody: { type: 'string' },
    textBody: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          Name: { type: 'string' },
          Content: { type: 'string' },
          ContentID: { type: 'string' },
          ContentType: { type: 'string' },
        },
      },
    },
  },
  required: ['fromEmail', 'toEmail', 'subject', 'htmlBody', 'textBody'],
} as const;

const job = {
  type: 'object',
  properties: {
    subdomain: { type: 'string' },
    reportId: { type: 'string' },
    jobId: { type: 'string' },
    fromEmail: { type: 'string' },
    toEmail: { type: 'string' },
    subject: { type: 'string' },
    htmlBody: { type: 'string' },
    textBody: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          Name: { type: 'string' },
          Content: { type: 'string' },
          ContentID: { type: 'string' },
          ContentType: { type: 'string' },
        },
      },
    },
  },
  required: [
    'jobId',
    'fromEmail',
    'toEmail',
    'subject',
    'htmlBody',
    'textBody',
  ],
} as const;

const notification = {
  type: 'object',
  properties: {
    notificationTitle: { type: 'string' },
    notificationDescription: { type: 'string' },
    refLink: { type: 'string' },
    notificationRead: { type: 'string' },
    createdAt: { type: 'string' },
    organizationId: { type: 'string' },
    platformId: { type: 'string' },
  },
  required: [
    'notificationTitle',
    'notificationDescription',
    'notificationRead',
    'organizationId',
    'platformId',
  ],
} as const;

const pdvReportJob = {
  type: 'object',
  properties: {
    reportId: { type: 'string' },
    orgName: { type: 'string' },
    workflowId: { type: 'string' },
    reportType: { type: 'string' },
    userEmail: { type: 'string' },
    platformId: { type: 'string' },
    organizationId: { type: 'string' },
    orgWorkflowId: { type: 'string' },
    subdomain: { type: 'string' },
    enableADV: { type: 'boolean' },
    pdvAnswers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
      },
    },
  },
  required: [
    'reportId',
    'orgName',
    'workflowId',
    'reportType',
    'userEmail',
    'organizationId',
    'orgWorkflowId',
    'subdomain',
    'enableADV',
    'pdvAnswers',
  ],
} as const;

const firefliesWebhook = {
  type: 'object',
  properties: {
    meetingId: { type: 'string' },
    eventType: { type: 'string' },
    clientReferenceId: { type: 'string' },
  },
  required: ['meetingId', 'eventType'],
} as const;

// DocuSign Connect webhook payload type
// Note: The actual payload from DocuSign Connect does NOT include envelopeSummary.
// The envelope status is derived from the top-level "event" field (e.g., "envelope-completed").
interface DocuSignWebhookPayload {
  event: string; // e.g., "envelope-completed", "envelope-sent", "envelope-delivered", "envelope-declined", "envelope-voided"
  apiVersion: string;
  uri: string;
  retryCount: number;
  configurationId: number;
  generatedDateTime: string;
  data: {
    accountId: string;
    userId: string;
    envelopeId: string;
  };
}

// DocuSign status mapping to our enum
const docuSignStatusMap: Record<string, string> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  completed: 'SIGNED',
  declined: 'DECLINED',
  voided: 'VOIDED',
};

// Helper function to match organizer email to community member, company, or project
async function matchMeetingToEntity(organizerEmail: string) {
  // Try to match to community member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const communityLead = await (db as any).communityLead.findUnique({
    where: { email: organizerEmail },
  });

  if (communityLead) {
    return { type: 'community', id: communityLead.id };
  }

  // Try to match to company (using companyEmail field)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const companyLead = await (db as any).communityCompanyLead.findFirst({
    where: { companyEmail: organizerEmail },
  });

  if (companyLead) {
    return { type: 'company', id: companyLead.id };
  }

  // Try to match to project (using companyEmail field - contact email)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectLead = await (db as any).communityProjectLead.findFirst({
    where: { companyEmail: organizerEmail },
  });

  if (projectLead) {
    return { type: 'project', id: projectLead.id };
  }

  return null;
}

// DocuSign webhook handlers for different document types
async function handleAdvisorAgreementSigned(
  envelope: {
    communityLeadId: string;
    recipientEmail: string;
    recipientName: string;
  },
  postmarkClient: import('postmark').ServerClient
) {
  // Update community lead with signed status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).communityLead.update({
    where: { id: envelope.communityLeadId },
    data: {
      advisorAgreementStatus: 'SIGNED',
      advisorAgreedAt: new Date(),
    },
  });

  // Send confirmation email
  const firstName =
    envelope.recipientName.split(' ')[0] ?? envelope.recipientName;

  await postmarkClient.sendEmail({
    From: 'jps@12butterflies.life',
    To: envelope.recipientEmail,
    Subject: 'Advisor Agreement Signed - Welcome to One2b!',
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1E4364;">Welcome to One2b, ${firstName}!</h1>
        <p>Thank you for signing the Advisor Collaboration Agreement. We're excited to have you as part of our advisor network.</p>
        <p>As an advisor, you'll gain access to:</p>
        <ul>
          <li>Exclusive networking opportunities</li>
          <li>Strategic conversations with industry leaders</li>
          <li>Collaborative opportunities across our community</li>
        </ul>
        <p>Our team will be in touch soon with next steps and onboarding information.</p>
        <p>Best regards,<br>The One2b Team</p>
      </div>
    `,
    TextBody: `Welcome to One2b, ${firstName}!\n\nThank you for signing the Advisor Collaboration Agreement. We're excited to have you as part of our advisor network.\n\nOur team will be in touch soon with next steps and onboarding information.\n\nBest regards,\nThe One2b Team`,
    MessageStream: 'outbound',
  });

  console.log(
    `✅ Advisor Agreement signed confirmation sent to: ${envelope.recipientEmail}`
  );
}

async function handleCommunityNdaSigned(
  envelope: {
    communityLeadId: string;
    recipientEmail: string;
    recipientName: string;
  },
  postmarkClient: import('postmark').ServerClient
) {
  // Get community lead with vertical groups
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = await (db as any).communityLead.update({
    where: { id: envelope.communityLeadId },
    data: {
      ndaStatus: 'SIGNED',
      ndaSignedAt: new Date(),
      whatsappAccessGranted: true,
    },
  });

  // Get the primary vertical group's WhatsApp link
  const verticalGroupName = lead.verticalGroups?.[0];
  let whatsappLink = 'https://chat.whatsapp.com/your-default-group'; // Fallback

  if (verticalGroupName) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verticalGroup = await (db as any).verticalGroup.findFirst({
      where: { name: verticalGroupName },
    });
    if (verticalGroup?.whatsappLink) {
      whatsappLink = verticalGroup.whatsappLink;
    }
  }

  // Send WhatsApp access email
  const firstName =
    envelope.recipientName.split(' ')[0] ?? envelope.recipientName;

  await postmarkClient.sendEmail({
    From: 'jps@12butterflies.life',
    To: envelope.recipientEmail,
    Subject: 'NDA Signed - Your One2b Community Access',
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1E4364;">Welcome to the Community, ${firstName}!</h1>
        <p>Thank you for signing the NDA. You now have access to our exclusive community WhatsApp group.</p>
        <p style="margin: 24px 0;">
          <a href="${whatsappLink}" style="background-color: #25D366; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
            Join WhatsApp Group
          </a>
        </p>
        <p><strong>Community Guidelines:</strong></p>
        <ul>
          <li>Be respectful and professional</li>
          <li>Keep discussions confidential as per the NDA</li>
          <li>Share valuable insights and support fellow members</li>
        </ul>
        <p>We're excited to have you as part of our community!</p>
        <p>Best regards,<br>The One2b Team</p>
      </div>
    `,
    TextBody: `Welcome to the Community, ${firstName}!\n\nThank you for signing the NDA. You now have access to our exclusive community WhatsApp group.\n\nJoin here: ${whatsappLink}\n\nWe're excited to have you as part of our community!\n\nBest regards,\nThe One2b Team`,
    MessageStream: 'outbound',
  });

  console.log(
    `✅ Community NDA signed - WhatsApp access sent to: ${envelope.recipientEmail}`
  );
}

async function handleCompanyNdaSigned(
  envelope: {
    companyLeadId: string;
    recipientEmail: string;
    recipientName: string;
  },
  postmarkClient: import('postmark').ServerClient
) {
  // Update company lead with signed status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).communityCompanyLead.update({
    where: { id: envelope.companyLeadId },
    data: {
      ndaStatus: 'SIGNED',
      ndaSignedAt: new Date(),
    },
  });

  // Send next steps email
  const firstName =
    envelope.recipientName.split(' ')[0] ?? envelope.recipientName;

  await postmarkClient.sendEmail({
    From: 'jps@12butterflies.life',
    To: envelope.recipientEmail,
    Subject: 'NDA Signed - Next Steps for Your One2b Partnership',
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1E4364;">Thank You, ${firstName}!</h1>
        <p>We've received your signed NDA. Thank you for taking this step toward our partnership.</p>
        <p><strong>What's Next:</strong></p>
        <ul>
          <li>Our team will review your company profile</li>
          <li>We'll schedule an introductory call within 24-48 hours</li>
          <li>You'll receive tailored recommendations based on your business needs</li>
        </ul>
        <p>In the meantime, feel free to reach out if you have any questions.</p>
        <p>Best regards,<br>The One2b Partnerships Team</p>
      </div>
    `,
    TextBody: `Thank You, ${firstName}!\n\nWe've received your signed NDA. Thank you for taking this step toward our partnership.\n\nWhat's Next:\n- Our team will review your company profile\n- We'll schedule an introductory call within 24-48 hours\n- You'll receive tailored recommendations based on your business needs\n\nIn the meantime, feel free to reach out if you have any questions.\n\nBest regards,\nThe One2b Partnerships Team`,
    MessageStream: 'outbound',
  });

  console.log(
    `✅ Company NDA signed - next steps email sent to: ${envelope.recipientEmail}`
  );
}

const run = async () => {
  // Create emitter first - needed by both queue processors
  const myEmitter = new EventEmitter();

  const emailQueue = createQueue('EmailQueue');
  await setupQueueProcessor(emailQueue.name, myEmitter);

  const pdvReportQueue = createQueue('PDVReportQueue');

  const server = fastify({
    bodyLimit: 10485760, // Sets the global body limit to 10 MB
    logger: true,
  });

  // Setup PDV report worker (needs emailQueue and emitter for post-processing)
  await setupPDVReportProcessor(pdvReportQueue.name, emailQueue, myEmitter);

  // Register plugins
  void server.register(require('@fastify/cookie'));
  await server.register(fastifySSE);
  void server.register(require('@fastify/cors'), {
    origin: ['*'], //TODO: make origin *.one2b.io
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    // Other options like allowedHeaders, exposedHeaders, preflightContinue, optionsSuccessStatus
  });

  // Register BullBoard
  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue), new BullMQAdapter(pdvReportQueue)],
    serverAdapter,
  });
  serverAdapter.setBasePath('/ui');
  void server.register(serverAdapter.registerPlugin(), {
    prefix: '/ui',
  });

  // Create an SSE endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/notification/',
    { sse: true },
    async (request: FastifyRequest, reply: any) => {
      const headers = request.headers;

      try {
        const organisationId = headers['x-organisation-id'];
        const platformId = headers['x-platform-id'];

        //TODO: add server/user authentication as additional security layer

        // Keep connection alive (prevents automatic close)
        reply.sse.keepAlive();

        // Send initial message
        await reply.sse?.send({ data: 'Connected' });

        myEmitter.on(
          `notificationEvent_${platformId}_${organisationId}`,
          async (data) => {
            console.log('Received notification: ', data);
            // Send a message
            await reply.sse?.send({
              event: 'notification',
              data: data,
              retry: 1000,
            });
          }
        );

        // Clean up when connection closes
        reply.sse.onClose(() => {
          console.log('Connection closed');
        });
      } catch (e) {
        console.error('Error in notification stream: ', e);
        // Send with full options
        await reply.sse?.send({
          event: 'error',
          data: { message: e },
          retry: 1000,
        });
      }
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/notification-relay/',
    {
      schema: {
        body: notification,
      },
    },
    async (
      request: FastifyRequest<{ Body: FromSchema<typeof notification> }>,
      _reply: FastifyReply
    ) => {
      try {
        const body = request.body;

        const organisationId = body.organizationId;
        const platformId = body.platformId;

        myEmitter.emit(
          `notificationEvent_${platformId}_${organisationId}`,
          body
        );
      } catch (e) {
        console.error('Error relaying notification: ', e);
      }
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/add-mailing-job',
    {
      schema: {
        body: email,
      },
    },
    async (
      req: FastifyRequest<{ Body: FromSchema<typeof email> }>,
      reply: FastifyReply
    ) => {
      const body = req.body;
      try {
        const job = await emailQueue.add(`Email`, body, { delay: 172800000 });

        reply.send({
          ok: true,
          jobId: job.id,
        });
      } catch (e) {
        reply.send({
          ok: false,
          error: e,
        });
      }
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/update-mailing-job',
    {
      schema: {
        body: job,
      },
    },
    async (
      req: FastifyRequest<{ Body: FromSchema<typeof job> }>,
      reply: FastifyReply
    ) => {
      const {
        jobId,
        fromEmail,
        toEmail,
        subject,
        htmlBody,
        textBody,
        attachments,
      } = req.body;
      try {
        const job = await emailQueue.getJob(jobId);

        if (job) {
          await job.updateData({
            fromEmail,
            toEmail,
            subject,
            htmlBody,
            textBody,
            attachments,
          });

          reply.send({
            ok: true,
          });
        } else {
          reply.send({
            ok: false,
            error: 'Job not found',
          });
        }
      } catch (e) {
        reply.send({
          ok: false,
          error: e,
        });
      }
    }
  );

  // PDV Report generation job endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/add-pdv-report-job',
    {
      schema: {
        body: pdvReportJob,
      },
    },
    async (
      req: FastifyRequest<{ Body: FromSchema<typeof pdvReportJob> }>,
      reply: FastifyReply
    ) => {
      const body = req.body;
      try {
        const job = await pdvReportQueue.add('PDVReport', body);

        console.log(
          `📋 PDV report job ${job.id} queued for ${body.orgName} (report: ${body.reportId})`
        );

        reply.send({
          ok: true,
          jobId: job.id,
        });
      } catch (e) {
        console.error('Error adding PDV report job:', e);
        reply.send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Fireflies webhook endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/fireflies-webhook',
    {
      schema: {
        body: firefliesWebhook,
      },
    },
    async (
      req: FastifyRequest<{ Body: FromSchema<typeof firefliesWebhook> }>,
      reply: FastifyReply
    ) => {
      const { meetingId, eventType, clientReferenceId } = req.body;

      try {
        console.log(
          `Received Fireflies webhook: ${eventType} for meeting ${meetingId}`
        );

        // Only process "Transcription completed" events
        if (eventType !== 'Transcription completed') {
          reply.send({
            ok: true,
            message: 'Event type not processed',
          });
          return;
        }

        // Check if we already have this meeting
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (db as any).meetingTranscript.findUnique({
          where: { firefliesMeetingId: meetingId },
        });

        if (existing) {
          console.log(`Meeting ${meetingId} already exists, skipping`);
          reply.send({
            ok: true,
            message: 'Meeting already processed',
          });
          return;
        }

        // Create initial record with RECEIVED status
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meetingRecord = await (db as any).meetingTranscript.create({
          data: {
            firefliesMeetingId: meetingId,
            clientReferenceId: clientReferenceId ?? undefined,
            title: 'Processing...', // Temporary title
            date: new Date(),
            organizerEmail: 'unknown@email.com', // Temporary
            processingStatus: MeetingProcessingStatus.RECEIVED,
          },
        });

        // Process asynchronously - don't block webhook response
        void (async () => {
          try {
            // Update status to PROCESSING
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (db as any).meetingTranscript.update({
              where: { id: meetingRecord.id },
              data: { processingStatus: MeetingProcessingStatus.PROCESSING },
            });

            // Wait for Fireflies to fully process the transcript (30 seconds)
            console.log(
              `Waiting 30 seconds before fetching transcript for meeting ${meetingId}...`
            );
            await new Promise((resolve) => setTimeout(resolve, 30000));

            // Fetch full transcript from Fireflies
            const transcript = await fetchTranscriptFromFireflies(meetingId);

            // Match to community member, company, or project
            const match = await matchMeetingToEntity(transcript.organizerEmail);

            // Update record with full transcript data
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (db as any).meetingTranscript.update({
              where: { id: meetingRecord.id },
              data: {
                title: transcript.title,
                date: new Date(transcript.date),
                dateString: transcript.dateString ?? undefined,
                duration: transcript.duration ?? undefined,
                meetingLink: transcript.meetingLink ?? undefined,
                transcriptUrl: transcript.transcriptUrl ?? undefined,
                audioUrl: transcript.audioUrl ?? undefined,
                videoUrl: transcript.videoUrl ?? undefined,
                hostEmail: transcript.hostEmail ?? undefined,
                organizerEmail: transcript.organizerEmail,
                calendarType: transcript.calendarType ?? undefined,
                calendarId: transcript.calendarId ?? undefined,
                participants: transcript.participants ?? [],
                firefliesUsers: transcript.firefliesUsers ?? [],
                meetingAttendees: transcript.meetingAttendees
                  ? (transcript.meetingAttendees as any)
                  : undefined,
                meetingAttendance: transcript.meetingAttendance
                  ? (transcript.meetingAttendance as any)
                  : undefined,
                speakers: transcript.speakers
                  ? (transcript.speakers as any)
                  : undefined,
                sentences: transcript.sentences
                  ? (transcript.sentences as any)
                  : undefined,
                summary: transcript.summary
                  ? (transcript.summary as any)
                  : undefined,
                analytics: transcript.analytics
                  ? (transcript.analytics as any)
                  : undefined,
                meetingInfo: transcript.meetingInfo
                  ? (transcript.meetingInfo as any)
                  : undefined,
                privacy: transcript.privacy ?? undefined,
                communityLeadId:
                  match?.type === 'community' ? match.id : undefined,
                companyLeadId: match?.type === 'company' ? match.id : undefined,
                projectLeadId: match?.type === 'project' ? match.id : undefined,
                processingStatus: match
                  ? MeetingProcessingStatus.MATCHED
                  : MeetingProcessingStatus.UNMATCHED,
                processedAt: new Date(),
              },
            });

            console.log(
              `Successfully processed meeting ${meetingId}, matched: ${
                match ? match.type : 'none'
              }`
            );
          } catch (error) {
            console.error(`Error processing meeting ${meetingId}:`, error);

            // Update record with error status
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (db as any).meetingTranscript.update({
              where: { id: meetingRecord.id },
              data: {
                processingStatus: MeetingProcessingStatus.FAILED,
                errorMessage:
                  error instanceof Error ? error.message : 'Unknown error',
                processedAt: new Date(),
              },
            });
          }
        })();

        reply.send({
          ok: true,
          message: 'Webhook received, processing in background',
        });
      } catch (e) {
        console.error('Error handling Fireflies webhook:', e);
        reply.send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // DocuSign OAuth consent endpoint - redirects to DocuSign for initial consent
  // This is a one-time setup required for JWT authentication to work
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/docusign/consent',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!env.DOCUSIGN_INTEGRATION_KEY || !env.DOCUSIGN_OAUTH_BASE_URL) {
          reply.status(500).send({
            ok: false,
            error: 'DocuSign OAuth not configured',
          });
          return;
        }

        // Build the consent URL
        const redirectUri = `https://${env.RAILWAY_STATIC_URL}/docusign/callback`;
        const scopes = 'signature impersonation';

        const consentUrl = new URL('/oauth/auth', env.DOCUSIGN_OAUTH_BASE_URL);
        consentUrl.searchParams.set('response_type', 'code');
        consentUrl.searchParams.set('scope', scopes);
        consentUrl.searchParams.set('client_id', env.DOCUSIGN_INTEGRATION_KEY);
        consentUrl.searchParams.set('redirect_uri', redirectUri);

        console.log(
          `🔐 Redirecting to DocuSign consent: ${consentUrl.toString()}`
        );

        reply.redirect(consentUrl.toString());
      } catch (e) {
        console.error('Error building DocuSign consent URL:', e);
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // DocuSign OAuth callback - handles the redirect after user grants consent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/docusign/callback',
    async (
      req: FastifyRequest<{
        Querystring: {
          code?: string;
          error?: string;
          error_description?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { code, error, error_description } = req.query;

        if (error) {
          console.error(
            `DocuSign OAuth error: ${error} - ${error_description}`
          );
          reply.type('text/html').send(`
            <!DOCTYPE html>
            <html>
            <head><title>DocuSign Consent Failed</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1 style="color: #dc3545;">❌ Consent Failed</h1>
              <p><strong>Error:</strong> ${error}</p>
              <p><strong>Description:</strong> ${
                error_description ?? 'No description provided'
              }</p>
              <p>Please try the consent flow again or check your DocuSign application settings.</p>
              <a href="/docusign/consent" style="display: inline-block; padding: 10px 20px; background: #1E4364; color: white; text-decoration: none; border-radius: 5px;">Try Again</a>
            </body>
            </html>
          `);
          return;
        }

        if (code) {
          // Consent was granted successfully
          // For JWT authentication, we don't need to exchange the code for tokens
          // The consent grant is now stored in DocuSign and JWT auth will work
          console.log('✅ DocuSign consent granted successfully');

          reply.type('text/html').send(`
            <!DOCTYPE html>
            <html>
            <head><title>DocuSign Consent Granted</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1 style="color: #28a745;">✅ Consent Granted Successfully!</h1>
              <p>DocuSign JWT authentication is now authorized.</p>
              <p>Your One2b application can now send documents for e-signature on behalf of the configured user.</p>
              <h3>What's Next?</h3>
              <ul>
                <li>The DocuSign integration is now ready to use</li>
                <li>Advisor Agreements, Community NDAs, and Company NDAs can be sent automatically</li>
                <li>Signatures will be tracked and WhatsApp access will be granted upon NDA completion</li>
              </ul>
              <p style="color: #6c757d; margin-top: 30px;">You can close this window.</p>
            </body>
            </html>
          `);
        } else {
          // No code or error - unexpected state
          reply.type('text/html').send(`
            <!DOCTYPE html>
            <html>
            <head><title>DocuSign Consent</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1 style="color: #ffc107;">⚠️ Unexpected Response</h1>
              <p>No authorization code or error was received from DocuSign.</p>
              <a href="/docusign/consent" style="display: inline-block; padding: 10px 20px; background: #1E4364; color: white; text-decoration: none; border-radius: 5px;">Try Again</a>
            </body>
            </html>
          `);
        }
      } catch (e) {
        console.error('Error handling DocuSign callback:', e);
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // DocuSign Connect webhook endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/docusign-webhook',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.body as DocuSignWebhookPayload;

      try {
        const envelopeId = payload.data?.envelopeId;
        const event = payload.event;

        if (!envelopeId || !event) {
          console.log('DocuSign webhook: Missing envelopeId or event');
          reply.send({ ok: true, message: 'Missing required data' });
          return;
        }

        // Extract status from event field: "envelope-completed" → "completed"
        const status = event.replace(/^envelope-/, '');

        console.log(
          `📩 DocuSign webhook received: envelope ${envelopeId}, event: ${event}, status: ${status}`
        );

        // Map DocuSign status to our enum
        const newStatus = docuSignStatusMap[status] ?? status.toUpperCase();

        // Find the envelope in our database
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const envelope = await (db as any).docuSignEnvelope.findUnique({
          where: { envelopeId },
          include: { communityLead: true, companyLead: true },
        });

        if (!envelope) {
          console.log(
            `DocuSign webhook: Envelope ${envelopeId} not found in DB`
          );
          reply.send({ ok: true, message: 'Envelope not found' });
          return;
        }

        // Update envelope status
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).docuSignEnvelope.update({
          where: { envelopeId },
          data: {
            status: newStatus,
            ...(newStatus === 'SIGNED' && { signedAt: new Date() }),
            ...(newStatus === 'DECLINED' && { declinedAt: new Date() }),
            ...(newStatus === 'VOIDED' && { voidedAt: new Date() }),
            ...(newStatus === 'DELIVERED' && { viewedAt: new Date() }),
          },
        });

        console.log(
          `✅ Updated envelope ${envelopeId} status to: ${newStatus}`
        );

        // Handle completion based on document type
        if (newStatus === 'SIGNED') {
          // Create Postmark client for sending emails
          const { ServerClient } = await import('postmark');
          const postmarkClient = new ServerClient(env.AUTH_POSTMARK_KEY);

          switch (envelope.documentType) {
            case 'ADVISOR_AGREEMENT':
              if (envelope.communityLeadId) {
                await handleAdvisorAgreementSigned(
                  {
                    communityLeadId: envelope.communityLeadId,
                    recipientEmail: envelope.recipientEmail,
                    recipientName: envelope.recipientName,
                  },
                  postmarkClient
                );
              }
              break;

            case 'COMMUNITY_NDA':
              if (envelope.communityLeadId) {
                await handleCommunityNdaSigned(
                  {
                    communityLeadId: envelope.communityLeadId,
                    recipientEmail: envelope.recipientEmail,
                    recipientName: envelope.recipientName,
                  },
                  postmarkClient
                );
              }
              break;

            case 'COMPANY_NDA':
              if (envelope.companyLeadId) {
                await handleCompanyNdaSigned(
                  {
                    companyLeadId: envelope.companyLeadId,
                    recipientEmail: envelope.recipientEmail,
                    recipientName: envelope.recipientName,
                  },
                  postmarkClient
                );
              }
              break;

            default:
              console.log(`Unknown document type: ${envelope.documentType}`);
          }
        }

        reply.send({ ok: true, message: 'Webhook processed successfully' });
      } catch (e) {
        console.error('Error handling DocuSign webhook:', e);
        reply.send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // ─── WhatsApp Integration Routes ─────────────────────────────

  // Connect a WhatsApp session (create socket, begin QR flow)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/whatsapp/connect',
    async (
      req: FastifyRequest<{ Body: { sessionId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { sessionId } = req.body;
        if (!sessionId) {
          reply.status(400).send({ ok: false, error: 'sessionId is required' });
          return;
        }

        await whatsappService.connect(sessionId);
        reply.send({ ok: true, message: 'Connection initiated' });
      } catch (e) {
        console.error('Error connecting WhatsApp:', e);
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Get QR code for session (polling endpoint)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/whatsapp/qr/:sessionId',
    async (
      req: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { sessionId } = req.params;
        const qr = whatsappService.getQRCode(sessionId);
        const status = whatsappService.getSessionStatus(sessionId);

        reply.send({ ok: true, qr, status });
      } catch (e) {
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Disconnect session
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/whatsapp/disconnect',
    async (
      req: FastifyRequest<{ Body: { sessionId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { sessionId } = req.body;
        await whatsappService.disconnect(sessionId);
        reply.send({ ok: true, message: 'Disconnected' });
      } catch (e) {
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Fetch groups for session
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/whatsapp/groups/:sessionId',
    async (
      req: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { sessionId } = req.params;
        const groups = await whatsappService.fetchGroups(sessionId);
        reply.send({ ok: true, groups });
      } catch (e) {
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Start importing a group
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).post(
    '/whatsapp/import',
    async (
      req: FastifyRequest<{
        Body: {
          sessionId: string;
          groupDbId: string;
          whatsappGroupId: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { sessionId, groupDbId, whatsappGroupId } = req.body;

        // Start import in background (don't block response)
        void whatsappService.importGroup(sessionId, groupDbId, whatsappGroupId);

        reply.send({ ok: true, message: 'Import started' });
      } catch (e) {
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  // Get import progress
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).get(
    '/whatsapp/import-status/:groupDbId',
    async (
      req: FastifyRequest<{ Params: { groupDbId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { groupDbId } = req.params;
        const progress = whatsappService.getImportProgress(groupDbId);
        reply.send({ ok: true, progress });
      } catch (e) {
        reply.status(500).send({
          ok: false,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  );

  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `To populate the queue and demo the UI, run: curl https://${env.RAILWAY_STATIC_URL}/add-job?id=1&email=hello%40world.com`
  );
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
