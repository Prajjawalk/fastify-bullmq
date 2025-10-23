import { ConnectionOptions, Queue, QueueScheduler, Worker } from 'bullmq';

import { env } from './env';
import { ServerClient } from 'postmark';

const connection: ConnectionOptions = {
  host: env.REDISHOST,
  port: env.REDISPORT,
  username: env.REDISUSER,
  password: env.REDISPASSWORD,
};

export const createQueue = (name: string) => new Queue(name, { connection });

export const setupQueueProcessor = async (queueName: string) => {
  const queueScheduler = new QueueScheduler(queueName, {
    connection,
  });
  await queueScheduler.waitUntilReady();

  new Worker(
    queueName,
    async (job) => {
      try {
        const postmarkClient = new ServerClient(env.AUTH_POSTMARK_KEY);
        const data = job.data;
        const result = await postmarkClient.sendEmail({
          From: data.fromEmail,
          To: data.toEmail,
          Subject: data.subject,
          HtmlBody: data.htmlBody,
          TextBody: data.textBody,
          MessageStream: 'outbound',
          Attachments: data.attachments,
        });

        await fetch(
          `https://${data.subdomain}.one2b.io/api/send-adv-report/webhook`,
          {
            method: 'POST',
            body: JSON.stringify({
              mailId: result.MessageID,
              success: true,
              reportId: data.reportId,
            }),
          }
        );
        return { jobId: job.id, messageId: result.MessageID };
      } catch (e) {
        await fetch(
          `https://${data.subdomain}.one2b.io/api/send-adv-report/webhook`,
          {
            method: 'POST',
            body: JSON.stringify({
              success: false,
              reportId: job.data.reportId,
              error: e,
            }),
          }
        );
      }
    },
    { connection }
  );
};
