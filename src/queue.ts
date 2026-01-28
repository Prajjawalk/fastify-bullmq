import { ConnectionOptions, Queue, Worker } from 'bullmq';

import { env } from './env';
import { ServerClient } from 'postmark';
import {
  processPDVReportJob,
  type PDVReportJobData,
  type PDVReportJobResult,
} from './pdv-report/worker';
import EventEmitter from 'events';
import { db } from './db';

const connection: ConnectionOptions = {
  host: env.REDISHOST,
  port: env.REDISPORT,
  username: env.REDISUSER,
  password: env.REDISPASSWORD,
};

export const createQueue = (name: string) => new Queue(name, { connection });

export const setupQueueProcessor = async (
  queueName: string,
  emitter: EventEmitter
) => {
  // QueueScheduler is no longer needed in BullMQ v4+
  // Scheduling functionality is now built into the Queue itself

  new Worker(
    queueName,
    async (job) => {
      const data = job.data as {
        subdomain: string;
        reportId: string;
        fromEmail: string;
        toEmail: string;
        subject: string;
        htmlBody: string;
        textBody: string;
        attachments?: Array<{
          Name: string;
          Content: string;
          ContentID: string;
          ContentType: string;
        }>;
      };

      try {
        const postmarkClient = new ServerClient(env.AUTH_POSTMARK_KEY);
        const result = await postmarkClient.sendEmail({
          From: data.fromEmail,
          To: data.toEmail,
          Subject: data.subject,
          HtmlBody: data.htmlBody,
          TextBody: data.textBody,
          MessageStream: 'outbound',
          Attachments: data.attachments,
        });

        // Update report with delivery success - directly in DB instead of webhook
        const report = await db.report.update({
          where: { id: data.reportId },
          data: {
            emailId: result.MessageID,
            deliveryStatus: 'DELIVERED',
          },
          include: {
            organisationWorkflow: {
              select: {
                organizationId: true,
              },
            },
          },
        });

        const organizationId =
          report.organisationWorkflow?.organizationId ?? 'undefined';
        const platformId = String(report.platformId);

        // Create notification in DB
        await db.organizationNotification.create({
          data: {
            notificationTitle: 'PDV Report Successfully Delivered',
            notificationDescription: 'PDV report has been delivered to your email',
            refLink: '',
            notificationRead: false,
            organizationId,
            platformId,
          },
        });

        // Send real-time notification via SSE
        emitter.emit(`notificationEvent_${platformId}_${organizationId}`, {
          notificationTitle: 'PDV Report Successfully Delivered',
          notificationDescription: 'PDV report has been delivered to your email',
          refLink: '',
          notificationRead: 'false',
          organizationId,
          platformId,
        });

        console.log(
          `✅ Email delivered for report ${data.reportId}, messageId: ${result.MessageID}`
        );
        return { jobId: job.id, messageId: result.MessageID };
      } catch (e) {
        // Update report with delivery failure - directly in DB instead of webhook
        await db.report.update({
          where: { id: data.reportId },
          data: {
            deliveryStatus: 'DELIVERY_FAILED',
            emailDeliveryError:
              e instanceof Error ? e.message : 'Postmark delivery failed',
          },
        });

        console.error(`❌ Email delivery failed for report ${data.reportId}:`, e);
        throw e; // Re-throw to mark job as failed
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

        if (result.success && result.emailData) {
          // Schedule email delivery via the existing EmailQueue with 5-minute delay
          const emailJob = await emailQueue.add('Email', result.emailData, {
            delay: 300000,
          });
          console.log(
            `📧 Email job ${emailJob.id} scheduled for report ${jobData.reportId}`
          );

          // Update the report with the email job ID
          await db.report.update({
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
        await db.organizationNotification.create({
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
        console.error(`❌ PDV report job ${job.id} failed:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 2, // Process up to 2 PDV reports at a time
    }
  );
};
