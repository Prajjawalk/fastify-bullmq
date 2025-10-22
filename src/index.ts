import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { FastifyInstance } from 'fastify';
import { Server, IncomingMessage, ServerResponse } from 'http';
import { env } from './env';

import { createQueue, setupQueueProcessor } from './queue';
import { FromSchema } from 'json-schema-to-ts';

const email = {
  type: 'object',
  properties: {
    fromEmail: { type: 'string' },
    toEmail: { type: 'string' },
    subject: { type: 'string' },
    htmlBody: { type: 'string' },
    textBody: { type: 'string' },
    attachments: {
      type: 'object',
      properties: {
        Name: { type: 'string' },
        Content: { type: 'string' },
        ContentID: { type: 'string' },
        ContentType: { type: 'string' },
      },
    },
  },
  required: ['fromEmail', 'toEmail', 'subject', 'htmlBody', 'textBody'],
} as const;

const job = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    fromEmail: { type: 'string' },
    toEmail: { type: 'string' },
    subject: { type: 'string' },
    htmlBody: { type: 'string' },
    textBody: { type: 'string' },
    attachments: {
      type: 'object',
      properties: {
        Name: { type: 'string' },
        Content: { type: 'string' },
        ContentID: { type: 'string' },
        ContentType: { type: 'string' },
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

const run = async () => {
  const emailQueue = createQueue('EmailQueue');
  await setupQueueProcessor(emailQueue.name);

  const server: FastifyInstance<Server, IncomingMessage, ServerResponse> =
    fastify({
      bodyLimit: 10485760, // Sets the global body limit to 10 MB
    });

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
