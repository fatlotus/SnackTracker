import { loadConfig } from '../config.js';
import { createStorageAdapter } from '../db/index.js';

const USAGE =
  'Usage: backfill-roles [--promote-emails=<email1,email2,...> | --promote-emails <email1,email2,...>]';

function parsePromoteEmails(argv: string[]): string[] {
  const emails: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--promote-emails=')) {
      const raw = arg.slice('--promote-emails='.length);
      const parsed = raw
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      if (parsed.length === 0) {
        throw new Error(`--promote-emails requires at least one email.\n${USAGE}`);
      }
      emails.push(...parsed);
    } else if (arg === '--promote-emails') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value for --promote-emails.\n${USAGE}`);
      }
      i += 1;
      const parsed = next
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      if (parsed.length === 0) {
        throw new Error(`--promote-emails requires at least one email.\n${USAGE}`);
      }
      emails.push(...parsed);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return Array.from(new Set(emails));
}

async function main(): Promise<void> {
  const promoteEmails = parsePromoteEmails(process.argv.slice(2));
  const config = loadConfig();
  const storage = createStorageAdapter(config);

  console.log(`[backfill-roles] Initializing storage backend: ${storage.kind}`);
  await storage.init();
  try {
    console.log('[backfill-roles] Schema & legacy owner -> parent migration complete.');

    if (promoteEmails.length > 0) {
      const now = new Date().toISOString();
      for (const email of promoteEmails) {
        const user = await storage.findUserByEmail(email);
        if (!user) {
          console.warn(`[backfill-roles] User not found for email: ${email}`);
          continue;
        }
        const promotedCount = await storage.promoteUserMembershipsToParent({
          userId: user.id,
          now,
        });
        console.log(
          `[backfill-roles] Promoted ${promotedCount} active membership(s) to parent for ${email} (${user.id})`,
        );
      }
    }
  } finally {
    await storage.close();
  }

  console.log('[backfill-roles] Done.');
}

main().catch((err: unknown) => {
  console.error('[backfill-roles] Failed:', err);
  process.exitCode = 1;
});
