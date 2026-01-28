import { ConnectionOptions, Queue, Worker } from 'bullmq';

import { env } from './env';
import { ServerClient } from 'postmark';
import {
  processPDVReportJob,
  type PDVReportJobData,
  type PDVReportJobResult,
} from './pdv-report/worker';
import EventEmitter from 'events';

const connection: ConnectionOptions = {
  host: env.REDISHOST,
  port: env.REDISPORT,
  username: env.REDISUSER,
  password: env.REDISPASSWORD,
};

export const createQueue = (name: string) => new Queue(name, { connection });

export const setupQueueProcessor = async (queueName: string) => {
  // QueueScheduler is no longer needed in BullMQ v4+
  // Scheduling functionality is now built into the Queue itself

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
          `https://${job.data.subdomain}.one2b.io/api/send-adv-report/webhook`,
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

// PDV Report Queue processor
export const setupPDVReportProcessor = async (
  pdvQueueName: string,
  emailQueue: Queue,
  emitter: EventEmitter
) => {
  new Worker(
    pdvQueueName,
    async (job) => {
      const jobData = job.data as PDVReportJobData;
      console.log(
        `🔄 Processing PDV report job ${job.id} for ${jobData.orgName}`
      );

      try {
        const result: PDVReportJobResult = await processPDVReportJob(jobData);

        const { db: dbClient } = await import('./db');

        if (result.success && result.emailData) {
          // Schedule email delivery via the existing EmailQueue with 5-minute delay
          const emailJob = await emailQueue.add(
            'Email',
            result.emailData,
            { delay: 300000 }
          );
          console.log(
            `📧 Email job ${emailJob.id} scheduled for report ${jobData.reportId}`
          );

          // Update the report with the email job ID
          await dbClient.report.update({
            where: { id: jobData.reportId },
            data: { bullMQJobId: emailJob.id },
          });
        }

        // Send notification that report generation is complete
        emitter.emit(
          `notificationEvent_${jobData.platformId}_${jobData.organizationId}`,
          {
            notificationTitle: 'PDV Report Generated',
            notificationDescription:
              'Your PDV report has been generated successfully. Email delivery has been scheduled.',
            refLink: '',
            notificationRead: 'false',
            organizationId: jobData.organizationId,
            platformId: jobData.platformId,
          }
        );

        // Create notification in DB
        await dbClient.organizationNotification.create({
          data: {
            notificationTitle: 'PDV Report Generated',
            notificationDescription:
              'Your PDV report has been generated successfully. Email delivery has been scheduled.',
            refLink: '',
            notificationRead: false,
            organizationId: jobData.organizationId,
            platformId: String(jobData.platformId),
          },
        });

        return result;
      } catch (error) {
        console.error(
          `❌ PDV report job ${job.id} failed:`,
          error
        );
        throw error;
      }
    },
    {
      connection,
      concurrency: 2, // Process up to 2 PDV reports at a time
    }
  );
};
