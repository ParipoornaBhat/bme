import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { db } from "../client.js";
import { reviewAccount, reviewScan } from "../schema/index.js";
import { hashPassword, parseReviewAccounts } from "../services/review-accounts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

dotenv.config({ path: path.resolve(repoRoot, ".env") });

async function main() {
  const accounts = parseReviewAccounts(process.env.REVIEW_ACCOUNTS);
  let accountsUpserted = 0;

  for (const acc of accounts) {
    const passwordHash = hashPassword(acc.password);
    await db
      .insert(reviewAccount)
      .values({
        username: acc.username,
        displayName: acc.displayName,
        passwordHash,
        role: acc.role,
      })
      .onConflictDoUpdate({
        target: reviewAccount.username,
        set: {
          displayName: acc.displayName,
          passwordHash,
          role: acc.role,
        },
      });
    accountsUpserted += 1;
  }

  const scanIdsPath = path.join(repoRoot, "data", "review_scan_ids.json");
  let scansUpserted = 0;

  if (fs.existsSync(scanIdsPath)) {
    try {
      const raw = fs.readFileSync(scanIdsPath, "utf8");
      const scanMap = JSON.parse(raw) as Record<string, string>;
      for (const [caseId, driveFileId] of Object.entries(scanMap)) {
        if (typeof driveFileId !== "string" || !driveFileId.trim()) continue;
        await db
          .insert(reviewScan)
          .values({
            caseId,
            driveFileId: driveFileId.trim(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: reviewScan.caseId,
            set: {
              driveFileId: driveFileId.trim(),
              updatedAt: new Date(),
            },
          });
        scansUpserted += 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error loading review scan IDs: ${msg}`);
    }
  }

  console.log(`Review setup complete: upserted ${accountsUpserted} account(s), ${scansUpserted} scan(s).`);
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Review setup failed: ${msg}`);
  process.exit(1);
});
