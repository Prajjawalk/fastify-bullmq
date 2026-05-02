/**
 * Encrypted Baileys multi-file auth state.
 *
 * Drop-in replacement for `useMultiFileAuthState` that encrypts each file
 * on disk using AES-256-GCM. The on-disk format is:
 *   <encrypted-bytes> (iv + ciphertext + authTag, written as raw binary)
 *
 * Files are stored with a `.enc` extension to make it visually obvious
 * they're encrypted, and to prevent accidental reads by tools expecting
 * Baileys' default JSON format.
 */

import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';
import { encryptBuffer, decryptBuffer } from './crypto';

const FILE_EXT = '.enc.json';

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function fileNameFor(type: string, id: string): string {
  // Sanitize id (signal protocol IDs can contain `:` etc)
  const safeId = id.replace(/\//g, '__').replace(/:/g, '-');
  return `${type}-${safeId}${FILE_EXT}`;
}

/**
 * Result type so the caller can distinguish "not found" (normal first-run)
 * from "corrupt" (key rotated, partial write, etc.) and react accordingly.
 */
type ReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt' };

async function readEncrypted(filePath: string): Promise<ReadResult> {
  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing' };
    }
    console.error(`Failed to read encrypted file ${filePath}:`, err);
    return { status: 'corrupt' };
  }

  try {
    const plaintext = decryptBuffer(encrypted);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
      status: 'ok',
      value: JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver),
    };
  } catch (err) {
    console.error(`Failed to decrypt ${filePath}:`, err);
    return { status: 'corrupt' };
  }
}

/**
 * Delete every file in the auth folder. Used when creds decryption fails —
 * the per-key files (signed prekeys, sender keys, app-state-sync-keys) were
 * encrypted with the same lost key, so leaving them around just causes the
 * same Decipheriv error on every reconnect. Wiping the folder forces a
 * clean QR pairing.
 */
async function wipeAuthFolder(folder: string): Promise<void> {
  try {
    const entries = await fs.readdir(folder);
    await Promise.all(
      entries.map((name) =>
        fs.unlink(path.join(folder, name)).catch(() => undefined),
      ),
    );
    console.warn(
      `🧹 Wiped ${entries.length} corrupted auth file(s) in ${folder} — fresh QR pairing required`,
    );
  } catch (err) {
    console.error(`Failed to wipe auth folder ${folder}:`, err);
  }
}

async function writeEncrypted(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, BufferJSON.replacer);
  const encrypted = encryptBuffer(Buffer.from(json, 'utf8'));
  await fs.writeFile(filePath, encrypted);
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * Returns the encrypted equivalent of `useMultiFileAuthState(folder)`.
 * Backwards compat: if a plaintext `creds.json` exists in the folder
 * (from a previous unencrypted run), it is read once, encrypted, and
 * the plaintext file is deleted.
 */
export async function useEncryptedMultiFileAuthState(
  folder: string,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  await ensureDir(folder);

  const credsPath = path.join(folder, `creds${FILE_EXT}`);

  // Migration: detect legacy plaintext creds.json from old useMultiFileAuthState
  const legacyCredsPath = path.join(folder, 'creds.json');
  let creds: AuthenticationCreds | null = null;

  try {
    await fs.access(legacyCredsPath);
    // Found legacy plaintext file — read, encrypt, then delete
    console.log(`🔐 Migrating legacy plaintext creds in ${folder} to encrypted format`);
    const legacyJson = await fs.readFile(legacyCredsPath, 'utf8');
    creds = JSON.parse(legacyJson, BufferJSON.reviver) as AuthenticationCreds;
    await writeEncrypted(credsPath, creds);
    await removeFile(legacyCredsPath);
  } catch {
    // No legacy file, normal path
  }

  if (!creds) {
    const credsResult = await readEncrypted(credsPath);
    if (credsResult.status === 'corrupt') {
      // Decryption failed — likely the WHATSAPP_ENCRYPTION_KEY changed or
      // the file was partially written. Per-key files in this folder are
      // also encrypted with the lost key, so leaving them around would
      // cause the same Decipheriv error on every reconnect (the symptom
      // is an infinite QR loop). Wipe the whole folder and start fresh.
      console.warn(
        `⚠️  creds${FILE_EXT} in ${folder} could not be decrypted. Wiping the auth folder so a fresh QR pairing can succeed.`,
      );
      await wipeAuthFolder(folder);
      creds = initAuthCreds();
    } else if (credsResult.status === 'ok') {
      creds = credsResult.value as AuthenticationCreds;
    } else {
      creds = initAuthCreds();
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const filePath = path.join(folder, fileNameFor(type, id));
              const result = await readEncrypted(filePath);
              if (result.status === 'corrupt') {
                // Stale file from a prior encryption key. Drop it so
                // Baileys treats this id as missing and re-requests a
                // fresh key from WhatsApp instead of failing forever.
                await removeFile(filePath);
                return;
              }
              if (result.status !== 'ok') return;
              let value = result.value as SignalDataTypeMap[T];
              if (value && type === 'app-state-sync-key') {
                // v7: fromObject is deprecated; use create() for the same effect.
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                value = proto.Message.AppStateSyncKeyData.create(
                  value as proto.Message.IAppStateSyncKeyData,
                ) as unknown as SignalDataTypeMap[T];
              }
              if (value) {
                data[id] = value;
              }
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const categoryData = (data as any)[category] as Record<string, unknown>;
            for (const id in categoryData) {
              const value = categoryData[id];
              const filePath = path.join(folder, fileNameFor(category, id));
              if (value) {
                tasks.push(writeEncrypted(filePath, value));
              } else {
                tasks.push(removeFile(filePath));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeEncrypted(credsPath, creds);
    },
  };
}
