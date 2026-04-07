import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
  type ConnectionState,
  type MessageUpsertType,
  getContentType,
  downloadMediaMessage,
  isLidUser,
  isPnUser,
} from '@whiskeysockets/baileys';
import { useEncryptedMultiFileAuthState } from './encrypted-auth-state';
import { encrypt, encryptBuffer } from './crypto';
import { uploadToS3, getS3Url, isS3Configured } from './s3';

/**
 * Extract the sender's JID from a Baileys v7 message key.
 *
 * In v7, the key may contain:
 * - `participant`: the primary ID (could be LID `@lid` format for new accounts,
 *   or PN `@s.whatsapp.net` for legacy accounts)
 * - `participantAlt`: the alternate format (phone number if `participant` is a LID,
 *   or vice versa)
 *
 * For our DB we want the phone number (PN) format whenever possible,
 * because phone numbers are stable across LID rotations and are user-recognisable.
 *
 * Returns the best available JID, preferring PN format. May return a LID
 * if no PN is available — in that case, the lid-mapping store should be
 * consulted asynchronously to resolve the PN.
 */
function getSenderJidFromKey(
  key: WAMessageKey,
  ownJid?: string,
): string | null {
  // Self-sent message — return the connected user's JID
  if (key.fromMe) return ownJid ?? null;

  const remoteJid = key.remoteJid ?? '';
  const isGroup = remoteJid.endsWith('@g.us');

  if (!isGroup) {
    // Direct message: remoteJid is the contact. Prefer PN format.
    if (isPnUser(remoteJid)) return remoteJid;
    if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) {
      return key.remoteJidAlt;
    }
    // Fall back to whatever we have
    return remoteJid || null;
  }

  // Group message: actual sender is in `participant` (or `participantAlt`)
  const participant = key.participant ?? null;
  const participantAlt = key.participantAlt ?? null;

  // Prefer PN format
  if (participant && isPnUser(participant)) return participant;
  if (participantAlt && isPnUser(participantAlt)) return participantAlt;

  // Both might be LIDs — return whichever we have so the caller can try
  // to resolve via the lid-mapping store later
  if (participant && isLidUser(participant)) return participant;
  if (participantAlt && isLidUser(participantAlt)) return participantAlt;

  return participant ?? participantAlt;
}

/**
 * Convert a Baileys numeric field (which can be a number, bigint, or Long
 * protobuf object with {low, high, unsigned}) to a regular Int for Prisma.
 * Returns null for missing or invalid values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIntOrNull(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  // Long protobuf object
  if (typeof value === 'object' && 'low' in value && 'high' in value) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const low = value.low as number;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const high = value.high as number;
    return high * 0x100000000 + (low >>> 0);
  }
  // Try string conversion as last resort
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
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
  private syncTimers: Map<string, NodeJS.Timeout> = new Map(); // sessionId → periodic sync timer
  private authBasePath: string;

  // Track the last DB-persisted auth state size per session, to detect changes
  private lastPersistedSize: Map<string, number> = new Map();
  // Periodic persist timers per session
  private persistTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.authBasePath = path.join(process.cwd(), '.whatsapp-auth');
    if (!fs.existsSync(this.authBasePath)) {
      fs.mkdirSync(this.authBasePath, { recursive: true });
    }
  }

  /**
   * Pack all auth files for a session into a JSON blob and store in
   * `WhatsAppSession.authState`. Files are already encrypted on disk
   * (via useEncryptedMultiFileAuthState), so we just base64-encode the
   * raw bytes — no double encryption needed.
   *
   * Used as a backup so the session can be restored after Railway/
   * container redeploys (which wipe the local filesystem).
   */
  private async persistAuthStateToDb(sessionId: string): Promise<void> {
    const authPath = path.join(this.authBasePath, sessionId);
    if (!fs.existsSync(authPath)) return;

    try {
      const files = fs.readdirSync(authPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob: Record<string, string> = {};
      let totalBytes = 0;
      for (const file of files) {
        const filePath = path.join(authPath, file);
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        const data = fs.readFileSync(filePath);
        blob[file] = data.toString('base64');
        totalBytes += data.length;
      }

      // Skip the write if size hasn't changed (cheap dedup)
      const previousSize = this.lastPersistedSize.get(sessionId);
      if (previousSize === totalBytes) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).whatsAppSession.update({
        where: { id: sessionId },
        data: { authState: blob },
      });

      this.lastPersistedSize.set(sessionId, totalBytes);
      console.log(
        `💾 Persisted auth state to DB for session ${sessionId} (${files.length} files, ${(totalBytes / 1024).toFixed(1)} KB)`,
      );
    } catch (err) {
      console.error(
        `Failed to persist auth state for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Restore auth files from DB to disk. Called on server startup if the
   * local files are missing but the DB has a saved blob.
   * Returns true if files were restored.
   */
  private async restoreAuthStateFromDb(sessionId: string): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = await (db as any).whatsAppSession.findUnique({
        where: { id: sessionId },
        select: { authState: true },
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const blob = session?.authState as Record<string, string> | null;
      if (!blob || typeof blob !== 'object' || Object.keys(blob).length === 0) {
        return false;
      }

      const authPath = path.join(this.authBasePath, sessionId);
      if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
      }

      let restored = 0;
      for (const [filename, base64] of Object.entries(blob)) {
        const filePath = path.join(authPath, filename);
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        restored++;
      }

      console.log(
        `♻️ Restored ${restored} auth file(s) from DB for session ${sessionId}`,
      );
      return true;
    } catch (err) {
      console.error(
        `Failed to restore auth state from DB for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
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
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      defaultQueryTimeoutMs: undefined,
      // Request full history sync from WhatsApp on initial connection.
      // Without this, Baileys only fetches a minimal sync and most history is dropped.
      syncFullHistory: true,
      // Always accept history messages
      shouldSyncHistoryMessage: () => true,
    });

    this.sockets.set(sessionId, sock);

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // ─── History sync: process the full dump Baileys sends after connection ───
    // This event fires (potentially multiple times) during initial sync with the
    // user's chat history. We store ALL messages from ALL groups, even those not
    // yet imported — when a user imports a group later, the historical messages
    // are already there. Groups discovered through history are auto-created with
    // importStatus='PENDING' and populated with metadata when fetchGroups is called.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('messaging-history.set', async (historyData: any) => {
      try {
        const messages = (historyData?.messages ?? []) as WAMessage[];
        const isLatest = historyData?.isLatest as boolean | undefined;

        if (messages.length === 0) return;

        console.log(
          `📥 [history.set] session ${sessionId} received ${messages.length} historical messages (isLatest=${isLatest})`
        );

        // Cache existing groups for this session — we'll auto-create new ones as needed
        const groupCache = new Map<string, string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingGroups = await (db as any).whatsAppGroup.findMany({
          where: { sessionId },
          select: { id: true, whatsappGroupId: true },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const g of existingGroups as any[]) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          groupCache.set(g.whatsappGroupId, g.id);
        }

        let stored = 0;
        let skipped = 0;
        let groupsCreated = 0;

        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;
          if (!msg.message) continue;

          // Only process group messages (skip direct/private chats)
          if (!remoteJid.endsWith('@g.us')) {
            skipped++;
            continue;
          }

          const whatsappMsgId = msg.key.id ?? '';
          if (!whatsappMsgId) continue;

          // Get or create group row in DB (upsert to avoid race conditions
          // when the same group appears multiple times in the history dump)
          let groupDbId = groupCache.get(remoteJid);
          if (!groupDbId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const upsertedGroup = await (db as any).whatsAppGroup.upsert({
                where: {
                  sessionId_whatsappGroupId: {
                    sessionId,
                    whatsappGroupId: remoteJid,
                  },
                },
                create: {
                  sessionId,
                  whatsappGroupId: remoteJid,
                  name: encrypt('Unknown Group') ?? '', // Will be updated when fetchGroups runs
                  importStatus: 'PENDING',
                },
                update: {}, // No-op on conflict — just return the existing row
                select: { id: true },
              });
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              groupDbId = upsertedGroup.id as string;
              if (groupDbId) {
                // Only count as created if it wasn't already in our local cache
                groupsCreated++;
                groupCache.set(remoteJid, groupDbId);
              }
            } catch (err) {
              console.error(
                `Failed to auto-create group ${remoteJid}:`,
                err
              );
              continue;
            }
          }

          if (!groupDbId) continue;

          // Deduplicate
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const existing = await (db as any).whatsAppMessage.findFirst({
            where: { groupId: groupDbId, whatsappMsgId },
          });
          if (existing) {
            skipped++;
            continue;
          }

          try {
            await this.storeMessage(msg, groupDbId, sock);
            stored++;
          } catch (err) {
            console.error('Error storing history message:', err);
          }
        }

        console.log(
          `📥 [history.set] session ${sessionId}: stored ${stored} messages, skipped ${skipped}, created ${groupsCreated} new group(s)`
        );
      } catch (err) {
        console.error('Error processing messaging-history.set event:', err);
      }
    });

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

        // Set up persistent message listener for real-time sync
        void this.setupPersistentListener(sessionId, sock);

        // Set up periodic sync (every 10 minutes)
        this.startPeriodicSync(sessionId);

        // Persist auth state to DB now (for redeploy survival),
        // then schedule periodic persists every 5 minutes
        void this.persistAuthStateToDb(sessionId);
        this.startAuthStatePersist(sessionId);
      }
    });

    // Also persist on every credential update (cheap dedup via lastPersistedSize)
    sock.ev.on('creds.update', () => {
      void this.persistAuthStateToDb(sessionId);
    });
  }

  private startAuthStatePersist(sessionId: string): void {
    const existing = this.persistTimers.get(sessionId);
    if (existing) clearInterval(existing);

    // Persist auth state to DB every 5 minutes as a backup
    const timer = setInterval(
      () => {
        void this.persistAuthStateToDb(sessionId);
      },
      5 * 60 * 1000,
    );
    this.persistTimers.set(sessionId, timer);
  }

  private stopAuthStatePersist(sessionId: string): void {
    const timer = this.persistTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.persistTimers.delete(sessionId);
    }
    this.lastPersistedSize.delete(sessionId);
  }

  getQRCode(sessionId: string): string | null {
    return this.qrCodes.get(sessionId) ?? null;
  }

  async disconnect(sessionId: string): Promise<void> {
    // Stop periodic sync and auth state persist
    const timer = this.syncTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.syncTimers.delete(sessionId);
    }
    this.stopAuthStatePersist(sessionId);

    const sock = this.sockets.get(sessionId);
    if (sock) {
      await sock.logout();
      this.sockets.delete(sessionId);
      this.qrCodes.delete(sessionId);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).whatsAppSession.update({
      where: { id: sessionId },
      data: { status: 'DISCONNECTED', authState: null },
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

    // Save groups to DB (name and description are encrypted at rest)
    for (const group of groupList) {
      const encName = encrypt(group.name) ?? '';
      const encDescription = encrypt(group.description ?? null);
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
          name: encName,
          description: encDescription,
          participantCount: group.participantCount,
        },
        update: {
          name: encName,
          description: encDescription,
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
            const encPushName = msg.pushName ? encrypt(msg.pushName) : undefined;
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
                pushName: encPushName ?? undefined,
              },
              update: {
                ...(encPushName ? { pushName: encPushName } : {}),
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

          // Store message (content is encrypted at rest)
          const encContent = encrypt(content);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const savedMsg = await (db as any).whatsAppMessage.create({
            data: {
              groupId: groupDbId,
              contactId,
              whatsappMsgId: msg.key.id ?? `unknown-${Date.now()}`,
              messageType,
              content: encContent,
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
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              const fileSize = toIntOrNull(mediaMsg?.fileLength);

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

  /**
   * Restore all previously CONNECTED sessions on server startup.
   * Reads sessions from the database and reconnects each one using
   * the persisted Baileys auth state in .whatsapp-auth/{sessionId}/.
   * Sessions whose auth files no longer exist are marked DISCONNECTED.
   */
  async restoreSessions(): Promise<void> {
    try {
      // Restore any session whose auth files still exist on disk —
      // regardless of DB status. This handles two cases:
      // 1. Server restart (DB says CONNECTED but the socket is dead)
      // 2. Auto-reconnect attempt that exited before completing (DB might
      //    say DISCONNECTED but the credentials are still valid)
      // Sessions where the user explicitly logged out have their auth files
      // deleted (see disconnect()), so they won't be restored.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessions = await (db as any).whatsAppSession.findMany({
        select: {
          id: true,
          status: true,
        },
      });

      if (sessions.length === 0) {
        console.log('🔄 No WhatsApp sessions in database to restore');
        return;
      }

      // Filter to sessions whose auth state is available — either on disk
      // or in the DB backup blob (which we restore to disk first)
      const restorable: { id: string; status: string }[] = [];
      for (const s of sessions) {
        const authPath = path.join(this.authBasePath, s.id);
        if (fs.existsSync(authPath)) {
          restorable.push(s);
          continue;
        }

        // No local files — try restoring from DB backup
        const restored = await this.restoreAuthStateFromDb(s.id);
        if (restored) {
          restorable.push(s);
          continue;
        }

        // Neither disk nor DB has auth state
        if (s.status === 'CONNECTED') {
          console.warn(
            `⚠️ Auth files missing for session ${s.id} (no DB backup either), marking as DISCONNECTED`,
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (db as any).whatsAppSession.update({
            where: { id: s.id },
            data: { status: 'DISCONNECTED' },
          });
        }
      }

      if (restorable.length === 0) {
        console.log(
          '🔄 No restorable WhatsApp sessions found (no auth files on disk)',
        );
        return;
      }

      console.log(
        `🔄 Restoring ${restorable.length} WhatsApp session(s) from previous run...`,
      );

      for (const session of restorable) {
        try {
          // Stagger reconnections so we don't hammer WhatsApp servers
          await new Promise((resolve) => setTimeout(resolve, 500));
          void this.connect(session.id);
          console.log(
            `🔄 Reconnect initiated for session ${session.id} (was ${session.status})`,
          );
        } catch (err) {
          console.error(`❌ Failed to restore session ${session.id}:`, err);
        }
      }
    } catch (err) {
      console.error('Error restoring WhatsApp sessions:', err);
    }
  }

  /**
   * Send a reply (quoted message) to a WhatsApp group.
   */
  async sendReply(params: {
    sessionId: string;
    whatsappGroupId: string;
    quotedMessageId: string;
    quotedContent: string;
    quotedSenderPhone: string;
    text: string;
  }): Promise<{ messageId: string | null }> {
    const sock = this.sockets.get(params.sessionId);
    if (!sock?.user) {
      throw new Error(`Session ${params.sessionId} not connected`);
    }

    // Reconstruct the quoted message reference for Baileys
    const senderJid = params.quotedSenderPhone
      ? `${params.quotedSenderPhone}@s.whatsapp.net`
      : params.whatsappGroupId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quoted: any = {
      key: {
        id: params.quotedMessageId,
        remoteJid: params.whatsappGroupId,
        fromMe: false,
        participant: senderJid,
      },
      message: {
        conversation: params.quotedContent || ' ',
      },
    };

    const result = await sock.sendMessage(
      params.whatsappGroupId,
      { text: params.text },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      { quoted },
    );

    return { messageId: result?.key?.id ?? null };
  }

  getSessionStatus(sessionId: string): string {
    const sock = this.sockets.get(sessionId);
    if (!sock) return 'DISCONNECTED';
    if (sock.user) return 'CONNECTED';
    if (this.qrCodes.has(sessionId)) return 'QR_PENDING';
    return 'DISCONNECTED';
  }

  // ─── Persistent Listener (Real-time Sync) ──────────────

  private async setupPersistentListener(
    sessionId: string,
    sock: WASocket
  ): Promise<void> {
    // Get all imported groups for this session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importedGroups = await (db as any).whatsAppGroup.findMany({
      where: {
        sessionId,
        importStatus: 'COMPLETED',
      },
      select: {
        id: true,
        whatsappGroupId: true,
      },
    });

    if (importedGroups.length === 0) {
      console.log(
        `No imported groups for session ${sessionId}, skipping persistent listener`
      );
      return;
    }

    // Build a lookup map: whatsappGroupId → groupDbId
    const groupMap = new Map<string, string>();
    for (const g of importedGroups) {
      groupMap.set(g.whatsappGroupId, g.id);
    }

    console.log(
      `🔄 Setting up persistent listener for ${groupMap.size} groups on session ${sessionId}`
    );

    sock.ev.on('messages.upsert', async ({ messages }: { messages: WAMessage[]; type: MessageUpsertType }) => {
      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const groupDbId = groupMap.get(remoteJid);
        if (!groupDbId) continue; // Not an imported group
        if (!msg.message) continue;

        // Reaction message — store as a reaction, not as a regular message
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        const reactionMessage = (msg.message as any).reactionMessage;
        if (reactionMessage) {
          await this.storeReaction(msg, groupDbId, reactionMessage as {
            key?: { id?: string };
            text?: string;
            senderTimestampMs?: number | { low: number; high: number };
          });
          continue;
        }

        // Deduplicate: check if message already stored
        const whatsappMsgId = msg.key.id ?? '';
        if (!whatsappMsgId) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (db as any).whatsAppMessage.findFirst({
          where: { groupId: groupDbId, whatsappMsgId },
        });
        if (existing) continue;

        try {
          await this.storeMessage(msg, groupDbId, sock);
        } catch (err) {
          console.error('Error storing synced message:', err);
        }
      }
    });
  }

  // ─── Store a reaction ─────────────────────────────────
  private async storeReaction(
    msg: WAMessage,
    groupDbId: string,
    reactionMessage: {
      key?: { id?: string };
      text?: string;
      senderTimestampMs?: number | { low: number; high: number };
    },
  ): Promise<void> {
    try {
      const targetMsgId = reactionMessage.key?.id;
      const emoji = reactionMessage.text ?? '';
      if (!targetMsgId) return;

      // Find the target message in our DB
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const targetMessage = await (db as any).whatsAppMessage.findFirst({
        where: { groupId: groupDbId, whatsappMsgId: targetMsgId },
        select: { id: true },
      });
      if (!targetMessage) return;

      // Reactor JID — use v7-aware extraction (handles LID/PN/alt fields)
      const reactorJid = getSenderJidFromKey(msg.key);
      if (!reactorJid) return;
      const reactorPhone = (reactorJid.split('@')[0] ?? '').split(':')[0] ?? '';
      if (!reactorPhone) return;

      const encReactorPushName = msg.pushName ? encrypt(msg.pushName) : null;

      const tsRaw = reactionMessage.senderTimestampMs ?? msg.messageTimestamp;
      const timestamp = tsRaw
        ? new Date(toIntOrNull(tsRaw) ?? Date.now())
        : new Date();

      // Empty emoji means the user removed their reaction
      if (emoji === '') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).whatsAppReaction
          .deleteMany({
            where: {
              messageId: targetMessage.id as string,
              reactorPhone,
            },
          })
          .catch(() => undefined);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).whatsAppReaction.upsert({
        where: {
          messageId_reactorPhone: {
            messageId: targetMessage.id as string,
            reactorPhone,
          },
        },
        create: {
          messageId: targetMessage.id as string,
          reactorPhone,
          reactorPushName: encReactorPushName,
          emoji,
          timestamp,
        },
        update: {
          emoji,
          timestamp,
          ...(encReactorPushName ? { reactorPushName: encReactorPushName } : {}),
        },
      });
    } catch (err) {
      console.error('Error storing reaction:', err);
    }
  }

  // ─── Store a single message (shared by import & sync) ──

  // Max bytes to inline as encrypted blob (2MB). Larger media gets metadata only.
  private static readonly MAX_INLINE_MEDIA_BYTES = 2 * 1024 * 1024;

  private async storeMessage(
    msg: WAMessage,
    groupDbId: string,
    sock?: WASocket,
  ): Promise<void> {
    const contentType = getContentType(msg.message!);
    if (!contentType) return;

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

    // Find or create contact (uses v7-aware sender extraction)
    // For fromMe messages, use the connected socket's JID. If not yet
    // available (early during history sync), fall back to the session's
    // stored phone number from the DB.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let ownJid = (sock?.user?.id as string | undefined) ?? undefined;
    if (!ownJid && msg.key.fromMe) {
      try {
        // Look up the session's phoneNumber from the DB as a fallback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const grp = await (db as any).whatsAppGroup.findUnique({
          where: { id: groupDbId },
          select: { session: { select: { phoneNumber: true } } },
        });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const ownPhone = grp?.session?.phoneNumber as string | undefined;
        if (ownPhone) ownJid = `${ownPhone}@s.whatsapp.net`;
      } catch {
        // Ignore — will fall through to null senderJid
      }
    }

    let senderJid = getSenderJidFromKey(msg.key, ownJid);

    // Additional fallback: try to extract from contextInfo.participant
    // (sometimes set on history-synced messages)
    if (!senderJid) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const ctxParticipant = msgAny[contentType]?.contextInfo?.participant as
        | string
        | undefined;
      if (ctxParticipant) {
        senderJid = ctxParticipant;
      }
    }

    // If we got a LID and the socket is available, try to resolve to a phone number
    // via the lid-mapping store for a better contact identifier.
    if (senderJid && isLidUser(senderJid) && sock) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const resolved = await (sock as any).signalRepository?.lidMapping?.getPNForLID?.(senderJid);
        if (resolved && typeof resolved === 'string') {
          senderJid = resolved;
        }
      } catch {
        // Ignore lid-mapping resolution failures — fall back to LID
      }
    }

    const senderPhone = senderJid
      ? (senderJid.split('@')[0] ?? '').split(':')[0] ?? ''
      : '';

    if (!senderPhone) {
      // Diagnostic: log the key shape so we can see why extraction failed
      console.warn(
        `⚠️ No sender extracted for message ${msg.key.id}: fromMe=${msg.key.fromMe}, participant=${msg.key.participant}, participantAlt=${msg.key.participantAlt ?? 'none'}, remoteJid=${msg.key.remoteJid}`,
      );
    }

    let contactId: string | null = null;

    if (senderPhone) {
      const encPushName = msg.pushName ? encrypt(msg.pushName) : undefined;
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
          pushName: encPushName ?? undefined,
        },
        update: {
          ...(encPushName ? { pushName: encPushName } : {}),
        },
      });
      contactId = contact.id;
    }

    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : new Date();

    // Extract quoted message reference (for replies)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const contextInfo = msgAny[contentType]?.contextInfo as
      | { stanzaId?: string; participant?: string }
      | undefined;
    const quotedWhatsappMsgId = contextInfo?.stanzaId ?? null;

    let quotedMessageId: string | null = null;
    if (quotedWhatsappMsgId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quoted = await (db as any).whatsAppMessage.findFirst({
        where: { groupId: groupDbId, whatsappMsgId: quotedWhatsappMsgId },
        select: { id: true },
      });
      if (quoted) quotedMessageId = quoted.id as string;
    }

    // Encrypt content at rest
    const encContent = encrypt(content);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedMsg = await (db as any).whatsAppMessage.create({
      data: {
        groupId: groupDbId,
        contactId,
        whatsappMsgId: msg.key.id ?? `unknown-${Date.now()}`,
        messageType,
        content: encContent,
        timestamp,
        quotedMessageId,
      },
    });

    // Handle media — metadata + S3 upload (or inline fallback)
    if (
      ['image', 'video', 'document', 'audio', 'sticker'].includes(messageType) &&
      msg.message
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const mediaMsg = msgAny[contentType];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const mimeType = (mediaMsg?.mimetype as string) ?? null;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const fileName = (mediaMsg?.fileName as string) ?? null;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const fileSize = toIntOrNull(mediaMsg?.fileLength);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const width = toIntOrNull(mediaMsg?.width);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const height = toIntOrNull(mediaMsg?.height);

        // Download media bytes (we'll upload to S3 if configured, fall back to inline)
        let downloadedBuffer: Buffer | null = null;
        if (sock) {
          try {
            const downloaded = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: undefined as never,
                reuploadRequest: sock.updateMediaMessage,
              },
            );
            if (downloaded instanceof Buffer) {
              downloadedBuffer = downloaded;
            }
          } catch (dlErr) {
            console.warn(
              `Could not download media for message ${savedMsg.id as string}:`,
              dlErr instanceof Error ? dlErr.message : dlErr,
            );
          }
        }

        // Choose storage destination: S3 (if configured) or inline
        let s3Key: string | null = null;
        let s3Url: string | null = null;
        let mediaData: Buffer | null = null;

        if (downloadedBuffer) {
          // Encrypt the bytes before any storage
          const encrypted = encryptBuffer(downloadedBuffer);

          if (isS3Configured()) {
            // Upload to S3 — store under whatsapp/{groupDbId}/{messageId}.bin
            try {
              const key = `whatsapp/${groupDbId}/${savedMsg.id as string}.bin`;
              await uploadToS3({
                key,
                body: encrypted,
                contentType: 'application/octet-stream',
              });
              s3Key = key;
              s3Url = getS3Url(key);
            } catch (s3Err) {
              console.error(
                `S3 upload failed for ${savedMsg.id as string}, falling back to inline:`,
                s3Err instanceof Error ? s3Err.message : s3Err,
              );
              // Fall back to inline if file is small enough
              if (encrypted.length <= WhatsAppService.MAX_INLINE_MEDIA_BYTES) {
                mediaData = encrypted;
              }
            }
          } else {
            // No S3 configured — fall back to inline storage for small files
            if (encrypted.length <= WhatsAppService.MAX_INLINE_MEDIA_BYTES) {
              mediaData = encrypted;
            }
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).whatsAppMedia.create({
          data: {
            messageId: savedMsg.id,
            mediaType: messageType,
            mimeType,
            fileName,
            fileSize,
            width,
            height,
            mediaData,
            s3Key,
            s3Url,
          },
        });
      } catch (mediaErr) {
        console.error('Error saving media metadata:', mediaErr);
      }
    }
  }

  // ─── Manual Sync ───────────────────────────────────────

  async syncGroup(
    sessionId: string,
    groupDbId: string,
    whatsappGroupId: string
  ): Promise<{ messagessynced: number; contactsUpdated: number }> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error(`Session ${sessionId} not connected`);
    }

    console.log(`🔄 Manual sync started for group ${groupDbId}`);

    // 1. Sync contacts from group metadata
    const metadata = await sock.groupMetadata(whatsappGroupId);
    let contactsUpdated = 0;

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
      contactsUpdated++;
    }

    // 2. Fetch recent message history
    let messagessynced = 0;

    const syncHandler = async ({
      messages,
    }: {
      messages: WAMessage[];
      type: MessageUpsertType;
    }) => {
      for (const msg of messages) {
        if (msg.key.remoteJid !== whatsappGroupId) continue;
        if (!msg.message) continue;

        const whatsappMsgId = msg.key.id ?? '';
        if (!whatsappMsgId) continue;

        // Deduplicate
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (db as any).whatsAppMessage.findFirst({
          where: { groupId: groupDbId, whatsappMsgId },
        });
        if (existing) continue;

        try {
          await this.storeMessage(msg, groupDbId, sock);
          messagessynced++;
        } catch (err) {
          console.error('Error storing synced message:', err);
        }
      }
    };

    sock.ev.on('messages.upsert', syncHandler);

    try {
      await sock.fetchMessageHistory(
        50,
        { remoteJid: whatsappGroupId, fromMe: false, id: '' },
        Math.floor(Date.now() / 1000)
      );
    } catch (historyErr) {
      console.log('fetchMessageHistory not available:', historyErr);
    }

    // Wait for messages to arrive
    await new Promise((resolve) => setTimeout(resolve, 10000));

    sock.ev.off('messages.upsert', syncHandler);

    // Update lastSyncedAt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).whatsAppGroup.update({
      where: { id: groupDbId },
      data: { lastSyncedAt: new Date() },
    });

    console.log(
      `Sync completed for group ${groupDbId}: ${contactsUpdated} contacts, ${messagessynced} new messages`
    );

    return { messagessynced, contactsUpdated };
  }

  // ─── Periodic Sync ─────────────────────────────────────

  private startPeriodicSync(sessionId: string): void {
    // Clear existing timer if any
    const existing = this.syncTimers.get(sessionId);
    if (existing) clearInterval(existing);

    // Sync every 10 minutes
    const timer = setInterval(() => {
      void this.syncAllImportedGroups(sessionId);
    }, 10 * 60 * 1000);

    this.syncTimers.set(sessionId, timer);
    console.log(`⏰ Periodic sync enabled for session ${sessionId} (every 10 min)`);
  }

  private async syncAllImportedGroups(sessionId: string): Promise<void> {
    const sock = this.sockets.get(sessionId);
    if (!sock?.user) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importedGroups = await (db as any).whatsAppGroup.findMany({
      where: {
        sessionId,
        importStatus: 'COMPLETED',
      },
      select: {
        id: true,
        whatsappGroupId: true,
      },
    });

    if (importedGroups.length === 0) return;

    console.log(
      `⏰ Periodic sync: syncing ${importedGroups.length} groups for session ${sessionId}`
    );

    for (const group of importedGroups) {
      try {
        await this.syncGroup(sessionId, group.id, group.whatsappGroupId);
      } catch (err) {
        console.error(`Error syncing group ${group.id}:`, err);
      }
    }
  }
}

// Singleton instance
export const whatsappService = new WhatsAppService();
