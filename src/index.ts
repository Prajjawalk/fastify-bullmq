import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { FastifyInstance } from 'fastify';
import { Server, IncomingMessage, ServerResponse } from 'http';
import { env } from './env';

import { createQueue, setupQueueProcessor } from './queue';
import { FromSchema } from 'json-schema-to-ts';
import { SSEPluginOptions } from '@fastify/sse';
import { FastifyCookieOptions } from '@fastify/cookie';
import EventEmitter from 'events';
import * as jose from 'jose';

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

  const server: FastifyInstance<Server, IncomingMessage, ServerResponse> =
    fastify({
      bodyLimit: 10485760, // Sets the global body limit to 10 MB
      logger: true,
    });

  // Register cookie plugin
  const fastifyCookie = require('@fastify/cookie');
  server.register(fastifyCookie) as FastifyCookieOptions;

  // Register SSE plugin
  await server.register(require('@fastify/sse'));

  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });
  serverAdapter.setBasePath('/');
  server.register(serverAdapter.registerPlugin(), {
    prefix: '/',
    basePath: '/',
  });

  const myEmitter = new EventEmitter();

  // Create an SSE endpoint
  server.get('/notification/', { sse: true }, async (request, reply) => {
    const cookies = request.cookies;
    const sessionToken = cookies['subdomain.sessionToken'];

    const secret = jose.base64url.decode(env.AUTH_SECRET);

    if (!sessionToken) {
      throw new Error();
    }

    const { payload, protectedHeader } = await jose.jwtDecrypt(
      sessionToken,
      secret
    );

    console.log(payload, protectedHeader);

    const organisationId = payload.organisationId;
    const platformId = payload.platformId;
    // Keep connection alive (prevents automatic close)
    reply.sse.keepAlive();

    myEmitter.on(
      `notificationEvent_${platformId}_${organisationId}`,
      async (data) => {
        // Send a message
        await reply.sse.send({ data });
      }
    );

    // Send with full options
    await reply.sse.send({
      id: '123',
      event: 'update',
      data: { message: 'Hello World' },
      retry: 1000,
    });

    // Clean up when connection closes
    reply.sse.onClose(() => {
      console.log('Connection closed');
    });
  });

  server.post<{ Body: FromSchema<typeof notification> }>(
    '/notification-relay/',
    {
      schema: {
        body: notification,
      },
    },
    async (request, reply) => {
      const body = request.body;

      const organisationId = body.organizationId;
      const platformId = body.platformId;

      myEmitter.emit(`notificationEvent_${platformId}_${organisationId}`, body);
    }
  );

  server.post<{ Body: FromSchema<typeof email> }>(
    '/add-mailing-job',
    {
      schema: {
        body: email,
      },
    },
    async (req, reply) => {
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

  server.post<{ Body: FromSchema<typeof job> }>(
    '/update-mailing-job',
    {
      schema: {
        body: job,
      },
    },
    async (req, reply) => {
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
          await job.update({
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
