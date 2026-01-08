import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { env } from './env';
import { createQueue, setupQueueProcessor } from './queue';
import { FromSchema } from 'json-schema-to-ts';
import EventEmitter from 'events';
import fastifySSE from '@fastify/sse';
import { db } from './db';
import { fetchTranscriptFromFireflies } from './fireflies';
import { MeetingProcessingStatus } from '@prisma/client';

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
    'createdAt',
    'organizationId',
    'platformId',
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

// Helper function to match organizer email to community member, company, or project
async function matchMeetingToEntity(organizerEmail: string) {
  // Try to match to community member
  const communityLead = await db.communityLead.findUnique({
    where: { email: organizerEmail },
  });

  if (communityLead) {
    return { type: 'community', id: communityLead.id };
  }

  // Try to match to company (using companyEmail field)
  const companyLead = await db.communityCompanyLead.findFirst({
    where: { companyEmail: organizerEmail },
  });

  if (companyLead) {
    return { type: 'company', id: companyLead.id };
  }

  // Try to match to project (using companyEmail field - contact email)
  const projectLead = await db.communityProjectLead.findFirst({
    where: { companyEmail: organizerEmail },
  });

  if (projectLead) {
    return { type: 'project', id: projectLead.id };
  }

  return null;
}

const run = async () => {
  const emailQueue = createQueue('EmailQueue');
  await setupQueueProcessor(emailQueue.name);

  const server = fastify({
    bodyLimit: 10485760, // Sets the global body limit to 10 MB
    logger: true,
  });

  const myEmitter = new EventEmitter();

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
    queues: [new BullMQAdapter(emailQueue)],
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
        const job = await emailQueue.add(`Email`, body, { delay: 300000 });

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
        const existing = await db.meetingTranscript.findUnique({
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
        const meetingRecord = await db.meetingTranscript.create({
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
            await db.meetingTranscript.update({
              where: { id: meetingRecord.id },
              data: { processingStatus: MeetingProcessingStatus.PROCESSING },
            });

            // Fetch full transcript from Fireflies
            const transcript = await fetchTranscriptFromFireflies(meetingId);

            // Match to community member, company, or project
            const match = await matchMeetingToEntity(transcript.organizerEmail);

            // Update record with full transcript data
            await db.meetingTranscript.update({
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
                speakers: transcript.speakers ? (transcript.speakers as any) : undefined,
                sentences: transcript.sentences ? (transcript.sentences as any) : undefined,
                summary: transcript.summary ? (transcript.summary as any) : undefined,
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
              `Successfully processed meeting ${meetingId}, matched: ${match ? match.type : 'none'}`
            );
          } catch (error) {
            console.error(
              `Error processing meeting ${meetingId}:`,
              error
            );

            // Update record with error status
            await db.meetingTranscript.update({
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

  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `To populate the queue and demo the UI, run: curl https://${env.RAILWAY_STATIC_URL}/add-job?id=1&email=hello%40world.com`
  );
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
