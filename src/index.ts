import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { env } from './env';
import { createQueue, setupQueueProcessor } from './queue';
import { FromSchema } from 'json-schema-to-ts';
import EventEmitter from 'events';
import fastifySSE from '@fastify/sse';

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
    origin: ['*'],
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

  // // Define an OPTIONS route for a specific path
  // (server as any).options(
  //   '/notification/',
  //   async (request: FastifyRequest, reply: FastifyReply) => {
  //     // Set appropriate CORS headers for preflight requests
  //     reply.header('Access-Control-Allow-Origin', '*');
  //     reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  //     reply.header(
  //       'Access-Control-Allow-Headers',
  //       'Content-Type, Authorization, x-platform-id, x-organisation-id'
  //     );
  //     reply.header('Access-Control-Max-Age', '86400'); // Cache preflight response for 24 hours

  //     // Send an empty response with a 204 No Content status for successful preflight
  //     reply.code(204).send();
  //   }
  // );

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

        // Keep connection alive (prevents automatic close)
        reply.sse.keepAlive();

        // Send initial message
        await reply.sse?.send({ data: 'Connected' });

        // Check if keepAlive was called
        console.log('Keep alive status:', reply.sse.shouldKeepAlive); // true

        myEmitter.on(
          `notificationEvent_${platformId}_${organisationId}`,
          async (data) => {
            console.log('Received notification: ', data);
            // Send a message
            await reply.sse?.send({
              id: '123',
              event: 'update',
              data: data,
              retry: 1000,
            });
          }
        );

        // Send with full options
        await reply.sse?.send({
          id: '123',
          event: 'update',
          data: { message: 'Hello World' },
          retry: 1000,
        });

        // Clean up when connection closes
        reply.sse.onClose(() => {
          console.log('Connection closed');
        });
      } catch (e) {
        console.error('Error in notification stream: ', e);
        // Send with full options
        await reply.sse?.send({
          id: '123',
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

  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `To populate the queue and demo the UI, run: curl https://${env.RAILWAY_STATIC_URL}/add-job?id=1&email=hello%40world.com`
  );
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
