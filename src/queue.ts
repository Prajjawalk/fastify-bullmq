import { ConnectionOptions, Queue, Worker } from 'bullmq';

import { env } from './env';
import { ServerClient } from 'postmark';
import {
  processPDVReportJob,
  type PDVReportJobData,
  type PDVReportJobResult,
} from './pdv-report/worker';
import EventEmitter from 'events';
import { db as prismaDb } from './db';

// Type assertion to bypass dts-cli's outdated TypeScript (4.9.5) not recognizing Prisma 6 types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prismaDb as any;

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
        /**
         * NEW shape — filename only. PDF content is fetched from
         * `Report.pdfReportData` at send time so admin edits during the
         * 48-hour delay window are reflected in the email.
         */
        attachmentName?: string;
        /**
         * LEGACY shape — caller pre-baked the attachment(s) into the
         * job payload. Still supported for non-PDV emails coming through
         * the /add-mailing-job HTTP endpoint.
         */
        attachments?: Array<{
          Name: string;
          Content: string;
          ContentID: string;
          ContentType: string;
        }>;
      };

      try {
        // Resolve attachments. Three sources, in priority order:
        //   1. data.attachments[] — caller passed the full payload
        //      (legacy / non-PDV flows). Use directly.
        //   2. data.attachmentName + data.reportId — new PDV shape:
        //      look up the latest PDF from Report.pdfReportData.
        //   3. data.reportId only (no attachments, no attachmentName) —
        //      this happens for pre-migration PDV jobs that were queued
        //      before attachmentName was added to the payload. Fall back
        //      to a sensible default filename so the PDF still ships.
        let attachments:
          | Array<{
              Name: string;
              Content: string;
              ContentID: string;
              ContentType: string;
            }>
          | undefined;

        if (data.attachments && data.attachments.length > 0) {
          attachments = data.attachments;
        } else if (data.attachmentName || data.reportId) {
          const reportRow = (await (db as any).report.findUnique({
            where: { id: data.reportId },
            select: { pdfReportData: true },
          })) as { pdfReportData: string | null } | null;

          if (!reportRow?.pdfReportData) {
            // No PDF available — fail the job. The processor will mark
            // the report row as DELIVERY_FAILED via the catch block below.
            throw new Error(
              `Report ${data.reportId} has no pdfReportData at send time`
            );
          }

          // Default the filename if the legacy job didn't include one.
          // The subject already contains "PDV Report - <orgName>", so
          // we mirror that pattern for the file the recipient sees.
          const filename =
            data.attachmentName ??
            (data.subject
              ? `${data.subject.replace(/^Your\s+/i, '').replace(/\s+is Ready$/i, '')}.pdf`
              : 'Report.pdf');

          attachments = [
            {
              Name: filename,
              Content: reportRow.pdfReportData,
              ContentID: 'adv-report-pdf',
              ContentType: 'application/pdf',
            },
          ];
          if (!data.attachmentName) {
            console.warn(
              `📎 Email job for report ${data.reportId} had no attachmentName (legacy shape); attaching PDF as "${filename}"`
            );
          }
        }

        const postmarkClient = new ServerClient(env.AUTH_POSTMARK_KEY);
        const result = await postmarkClient.sendEmail({
          From: data.fromEmail,
          To: data.toEmail,
          Subject: data.subject,
          HtmlBody: data.htmlBody,
          TextBody: data.textBody,
          MessageStream: 'outbound',
          Attachments: attachments,
        });

        // Update report with delivery success - directly in DB instead of webhook
        const report = await (db as any).report.update({
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
        await (db as any).organizationNotification.create({
          data: {
            notificationTitle: 'PDV Report Successfully Delivered',
            notificationDescription:
              'PDV report has been delivered to your email',
            refLink: '',
            notificationRead: false,
            organizationId,
            platformId,
          },
        });

        // Send real-time notification via SSE
        emitter.emit(`notificationEvent_${platformId}_${organizationId}`, {
          notificationTitle: 'PDV Report Successfully Delivered',
          notificationDescription:
            'PDV report has been delivered to your email',
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
        await (db as any).report.update({
          where: { id: data.reportId },
          data: {
            deliveryStatus: 'DELIVERY_FAILED',
            emailDeliveryError:
              e instanceof Error ? e.message : 'Postmark delivery failed',
          },
        });

        console.error(
          `❌ Email delivery failed for report ${data.reportId}:`,
          e
        );
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
          // Schedule email delivery via the existing EmailQueue with 48-hour delay
          // 48 hours = 48 * 60 * 60 * 1000 = 172800000 ms
          const emailJob = await emailQueue.add('Email', result.emailData, {
            delay: 172800000,
          });
          console.log(
            `📧 Email job ${emailJob.id} scheduled for report ${jobData.reportId}`
          );

          // Update the report with the email job ID
          await (db as any).report.update({
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
        await (db as any).organizationNotification.create({
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
