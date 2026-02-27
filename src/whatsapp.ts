import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type ConnectionState,
  type MessageUpsertType,
  getContentType,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { db } from './db';
import path from 'path';
import fs from 'fs';

interface GroupInfo {
  id: string;
  name: string;
  description: string | undefined;
  participantCount: number;
  participants: Array<{
    phoneNumber: string;
    pushName?: string;
    isAdmin: boolean;
  }>;
}

interface ImportProgress {
  groupId: string;
  status: 'IMPORTING' | 'COMPLETED' | 'FAILED';
  contactsImported: number;
  messagesImported: number;
  mediaImported: number;
  error?: string;
}

export class WhatsAppService {
  private sockets: Map<string, WASocket> = new Map();
  private qrCodes: Map<string, string> = new Map(); // sessionId → base64 QR
  private importProgress: Map<string, ImportProgress> = new Map();
  private authBasePath: string;

  constructor() {
    this.authBasePath = path.join(process.cwd(), '.whatsapp-auth');
    if (!fs.existsSync(this.authBasePath)) {
      fs.mkdirSync(this.authBasePath, { recursive: true });
    }
  }

  async connect(sessionId: string): Promise<void> {
    // If already connected, skip
    if (this.sockets.has(sessionId)) {
      const existingSock = this.sockets.get(sessionId)!;
      if (existingSock.user) {
        console.log(`WhatsApp session ${sessionId} already connected`);
        return;
      }
    }

    // Update status to QR_PENDING
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).whatsAppSession.update({
      where: { id: sessionId },
      data: { status: 'QR_PENDING' },
    });

    const authPath = path.join(this.authBasePath, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      defaultQueryTimeoutMs: undefined,
    });

    this.sockets.set(sessionId, sock);

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Generate QR code as base64 data URL
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
          });
          this.qrCodes.set(sessionId, qrDataUrl);
          console.log(`📱 QR code generated for session ${sessionId}`);
        } catch (err) {
          console.error('Error generating QR code:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `WhatsApp session ${sessionId} disconnected, statusCode: ${statusCode}, reconnect: ${shouldReconnect}`
        );

        this.sockets.delete(sessionId);
        this.qrCodes.delete(sessionId);

        if (shouldReconnect) {
          // Attempt to reconnect
          setTimeout(() => {
            void this.connect(sessionId);
          }, 3000);
        } else {
          // Logged out - update status
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (db as any).whatsAppSession.update({
            where: { id: sessionId },
            data: { status: 'DISCONNECTED' },
          });

          // Clean up auth files
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true });
          }
        }
      } else if (connection === 'open') {
        console.log(`✅ WhatsApp session ${sessionId} connected`);
        this.qrCodes.delete(sessionId);

        const phoneNumber = sock.user?.id?.split(':')[0] ?? null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).whatsAppSession.update({
          where: { id: sessionId },
          data: {
            status: 'CONNECTED',
            phoneNumber,
            lastConnected: new Date(),
          },
        });
      }
    });
  }

  getQRCode(sessionId: string): string | null {
    return this.qrCodes.get(sessionId) ?? null;
  }

  async disconnect(sessionId: string): Promise<void> {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      await sock.logout();
      this.sockets.delete(sessionId);
      this.qrCodes.delete(sessionId);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).whatsAppSession.update({
      where: { id: sessionId },
      data: { status: 'DISCONNECTED' },
    });

    // Clean up auth files
    const authPath = path.join(this.authBasePath, sessionId);
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true });
    }
  }

  async fetchGroups(sessionId: string): Promise<GroupInfo[]> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error(`Session ${sessionId} not connected`);
    }

    const groups = await sock.groupFetchAllParticipating();
    const groupList: GroupInfo[] = [];

    for (const [jid, metadata] of Object.entries(groups)) {
      groupList.push({
        id: jid,
        name: metadata.subject,
        description: metadata.desc ?? undefined,
        participantCount: metadata.participants.length,
        participants: metadata.participants.map((p) => ({
          phoneNumber: p.id.split('@')[0] ?? p.id,
          pushName: undefined, // Push names not available in metadata
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        })),
      });
    }

    // Save groups to DB
    for (const group of groupList) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).whatsAppGroup.upsert({
        where: {
          sessionId_whatsappGroupId: {
            sessionId,
            whatsappGroupId: group.id,
          },
        },
        create: {
          sessionId,
          whatsappGroupId: group.id,
          name: group.name,
          description: group.description,
          participantCount: group.participantCount,
        },
        update: {
          name: group.name,
          description: group.description,
          participantCount: group.participantCount,
        },
      });
    }

    return groupList;
  }

  async importGroup(
    sessionId: string,
    groupDbId: string,
    whatsappGroupId: string
  ): Promise<void> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error(`Session ${sessionId} not connected`);
    }

    // Initialize progress
    this.importProgress.set(groupDbId, {
      groupId: groupDbId,
      status: 'IMPORTING',
      contactsImported: 0,
      messagesImported: 0,
      mediaImported: 0,
    });

    // Update group status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).whatsAppGroup.update({
      where: { id: groupDbId },
      data: { importStatus: 'IMPORTING' },
    });

    try {
      // 1. Import contacts from group metadata
      const metadata = await sock.groupMetadata(whatsappGroupId);
      let contactsImported = 0;

      for (const participant of metadata.participants) {
        const phoneNumber = participant.id.split('@')[0] ?? participant.id;
        const isAdmin =
          participant.admin === 'admin' || participant.admin === 'superadmin';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).whatsAppContact.upsert({
          where: {
            groupId_phoneNumber: {
              groupId: groupDbId,
              phoneNumber,
            },
          },
          create: {
            groupId: groupDbId,
            phoneNumber,
            isAdmin,
          },
          update: {
            isAdmin,
          },
        });
        contactsImported++;
      }

      this.importProgress.set(groupDbId, {
        ...this.importProgress.get(groupDbId)!,
        contactsImported,
      });

      // 2. Fetch message history for this group
      // Baileys delivers history via messaging-history.set event on initial sync
      // For already-connected sessions, we use fetchMessageHistory
      let messagesImported = 0;
      let mediaImported = 0;

      // Listen for messages that come in from the history sync
      const messageHandler = async ({
        messages,
      }: {
        messages: WAMessage[];
        type: MessageUpsertType;
        requestId?: string;
      }) => {
        for (const msg of messages) {
          if (msg.key.remoteJid !== whatsappGroupId) continue;
          if (!msg.message) continue;

          const contentType = getContentType(msg.message);
          if (!contentType) continue;

          // Determine message type
          let messageType = 'text';
          let content: string | null = null;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgAny = msg.message as any;

          switch (contentType) {
            case 'conversation':
              messageType = 'text';
              content = (msgAny.conversation as string) ?? null;
              break;
            case 'extendedTextMessage':
              messageType = 'text';
              content = (msgAny.extendedTextMessage?.text as string) ?? null;
              break;
            case 'imageMessage':
              messageType = 'image';
              content = (msgAny.imageMessage?.caption as string) ?? null;
              break;
            case 'videoMessage':
              messageType = 'video';
              content = (msgAny.videoMessage?.caption as string) ?? null;
              break;
            case 'documentMessage':
              messageType = 'document';
              content = (msgAny.documentMessage?.fileName as string) ?? null;
              break;
            case 'audioMessage':
              messageType = 'audio';
              break;
            case 'stickerMessage':
              messageType = 'sticker';
              break;
            default:
              messageType = contentType;
          }

          // Find or create contact
          const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
          const senderPhone = senderJid.split('@')[0] ?? senderJid;
          let contactId: string | null = null;

          if (senderPhone) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contact = await (db as any).whatsAppContact.upsert({
              where: {
                groupId_phoneNumber: {
                  groupId: groupDbId,
                  phoneNumber: senderPhone,
                },
              },
              create: {
                groupId: groupDbId,
                phoneNumber: senderPhone,
                pushName: msg.pushName ?? undefined,
              },
              update: {
                ...(msg.pushName ? { pushName: msg.pushName } : {}),
              },
            });
            contactId = contact.id;
          }

          // Calculate timestamp
          const timestamp = msg.messageTimestamp
            ? new Date(
                Number(msg.messageTimestamp) * 1000
              )
            : new Date();

          // Store message
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const savedMsg = await (db as any).whatsAppMessage.create({
            data: {
              groupId: groupDbId,
              contactId,
              whatsappMsgId: msg.key.id ?? `unknown-${Date.now()}`,
              messageType,
              content,
              timestamp,
            },
          });
          messagesImported++;

          // Handle media download
          if (
            ['image', 'video', 'document', 'audio'].includes(messageType) &&
            msg.message
          ) {
            try {
              const mediaMsg = msgAny[contentType];
              const mimeType = (mediaMsg?.mimetype as string) ?? null;
              const fileName = (mediaMsg?.fileName as string) ?? null;
              const fileSize = (mediaMsg?.fileLength as number) ?? null;

              // Store media metadata (S3 upload can be done later)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (db as any).whatsAppMedia.create({
                data: {
                  messageId: savedMsg.id,
                  mediaType: messageType,
                  mimeType,
                  fileName,
                  fileSize,
                },
              });
              mediaImported++;
            } catch (mediaErr) {
              console.error('Error saving media metadata:', mediaErr);
            }
          }

          // Update progress
          this.importProgress.set(groupDbId, {
            groupId: groupDbId,
            status: 'IMPORTING',
            contactsImported,
            messagesImported,
            mediaImported,
          });
        }
      };

      // Subscribe to messages
      sock.ev.on('messages.upsert', messageHandler);

      // Request message history for the group (50 messages)
      // This triggers messaging-history.set and messages.upsert events
      try {
        await sock.fetchMessageHistory(
          50,
          { remoteJid: whatsappGroupId, fromMe: false, id: '' },
          Math.floor(Date.now() / 1000)
        );
      } catch (historyErr) {
        console.log(
          'fetchMessageHistory not available, relying on existing sync:',
          historyErr
        );
      }

      // Wait for messages to arrive (give it 15 seconds)
      await new Promise((resolve) => setTimeout(resolve, 15000));

      // Unsubscribe
      sock.ev.off('messages.upsert', messageHandler);

      // Mark as completed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).whatsAppGroup.update({
        where: { id: groupDbId },
        data: {
          importStatus: 'COMPLETED',
          importedAt: new Date(),
        },
      });

      this.importProgress.set(groupDbId, {
        groupId: groupDbId,
        status: 'COMPLETED',
        contactsImported,
        messagesImported,
        mediaImported,
      });

      console.log(
        `✅ Import completed for group ${groupDbId}: ${contactsImported} contacts, ${messagesImported} messages, ${mediaImported} media`
      );
    } catch (error) {
      console.error(`Error importing group ${groupDbId}:`, error);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).whatsAppGroup.update({
        where: { id: groupDbId },
        data: { importStatus: 'FAILED' },
      });

      this.importProgress.set(groupDbId, {
        groupId: groupDbId,
        status: 'FAILED',
        contactsImported: 0,
        messagesImported: 0,
        mediaImported: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  getImportProgress(groupDbId: string): ImportProgress | null {
    return this.importProgress.get(groupDbId) ?? null;
  }

  getSessionStatus(sessionId: string): string {
    const sock = this.sockets.get(sessionId);
    if (!sock) return 'DISCONNECTED';
    if (sock.user) return 'CONNECTED';
    if (this.qrCodes.has(sessionId)) return 'QR_PENDING';
    return 'DISCONNECTED';
  }
}

// Singleton instance
export const whatsappService = new WhatsAppService();
