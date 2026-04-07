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

async function readEncrypted(filePath: string): Promise<unknown | null> {
  try {
    const encrypted = await fs.readFile(filePath);
    const plaintext = decryptBuffer(encrypted);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver);
  } catch (err) {
    // File doesn't exist or decryption failed
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`Failed to read encrypted file ${filePath}:`, err);
    }
    return null;
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
    creds = ((await readEncrypted(credsPath)) as AuthenticationCreds | null) ?? initAuthCreds();
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
              let value = (await readEncrypted(filePath)) as
                | SignalDataTypeMap[T]
                | null;
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
