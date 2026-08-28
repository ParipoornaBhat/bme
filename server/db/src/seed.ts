import { db } from "./client.js";
import * as schema from "./schema/index.js";
import { eq, and } from "drizzle-orm";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import { hashPassword } from "better-auth/crypto";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const permissionsToSeed = [
  { key: "users:view", module: "users", description: "View user accounts and profiles" },
  { key: "users:manage", module: "users", description: "Manage users (create, edit, change roles)" },
  { key: "roles:manage", module: "roles", description: "Manage roles and toggle permissions" },
];

const rolesToSeed = [
  { name: "admin", displayName: "Administrator", description: "Full system control", isSystem: true },
  { name: "user", displayName: "Standard User", description: "Default application access", isSystem: true },
];

// BME project team. Seeded for local development only.
const TEAM_PASSWORD = "BmeDev@2026";
const TEAM = [
  { name: "Elvin Edwin Rodrigues", usn: "NNM23CS071", email: "nnm23cs071@nmamit.in" },
  { name: "Paripoorna B",          usn: "NNM23CS124", email: "nnm23cs124@nmamit.in" },
  { name: "Reegan Sujal Pinto",    usn: "NNM23CS149", email: "nnm23cs149@nmamit.in" },
  { name: "Aditi H Nayak",         usn: "NNM23CS293", email: "nnm23cs293@nmamit.in" },
];

async function seed() {
  console.log("🌱 Starting Database Seeding...");

  try {
    console.log("  Seeding permissions...");
    const seededPermissions = [];
    for (const perm of permissionsToSeed) {
      const [existing] = await db
        .select()
        .from(schema.permission)
        .where(eq(schema.permission.key, perm.key))
        .limit(1);

      if (!existing) {
        const [inserted] = await db.insert(schema.permission).values(perm).returning();
        console.log(`    + Created permission: ${perm.key}`);
        seededPermissions.push(inserted);
      } else {
        seededPermissions.push(existing);
      }
    }

    console.log("  Seeding roles...");
    const seededRoles: Record<string, typeof schema.role.$inferSelect> = {};
    for (const roleData of rolesToSeed) {
      const [existing] = await db
        .select()
        .from(schema.role)
        .where(eq(schema.role.name, roleData.name))
        .limit(1);

      if (!existing) {
        const [inserted] = await db.insert(schema.role).values(roleData).returning();
        console.log(`    + Created role: ${roleData.name}`);
        seededRoles[roleData.name] = inserted;
      } else {
        seededRoles[roleData.name] = existing;
      }
    }

    console.log("  Associating permissions with roles...");
    const adminRole = seededRoles["admin"];
    if (adminRole) {
      for (const perm of seededPermissions) {
        const existingRelation = await db.query.rolePermission.findFirst({
          where: (rp, { and, eq }) =>
            and(eq(rp.roleId, adminRole.id), eq(rp.permissionId, perm.id)),
        });

        if (!existingRelation) {
          await db.insert(schema.rolePermission).values({
            roleId: adminRole.id,
            permissionId: perm.id,
          });
          console.log(`    + Assigned ${perm.key} to role ${adminRole.name}`);
        }
      }
    }

    // Ensure the standard user role has no permissions assigned by default
    const userRole = seededRoles["user"];
    const viewUserPerm = seededPermissions.find((p) => p.key === "users:view");
    if (userRole && viewUserPerm) {
      const existingRelation = await db.query.rolePermission.findFirst({
        where: (rp, { and, eq }) =>
          and(eq(rp.roleId, userRole.id), eq(rp.permissionId, viewUserPerm.id)),
      });

      if (existingRelation) {
        await db
          .delete(schema.rolePermission)
          .where(
            and(
              eq(schema.rolePermission.roleId, userRole.id),
              eq(schema.rolePermission.permissionId, viewUserPerm.id)
            )
          );
        console.log(`    - Cleaned up default user permission association: removed ${viewUserPerm.key} from role ${userRole.name}`);
      }
    }

    // The Thunder Stack template seeded admin@thunder.com / user@thunder.com with
    // passwords printed in its own login page. Removed: this database is shared and
    // reachable from anywhere, and a published password is a way in. The four team
    // accounts below are the only credentials.

    console.log("  Seeding BME team accounts...");
    const teamPasswordHash = await hashPassword(TEAM_PASSWORD);

    for (const member of TEAM) {
      const existing = await db.query.user.findFirst({
        where: eq(schema.user.email, member.email),
      });
      if (existing) {
        await db.delete(schema.account).where(eq(schema.account.userId, existing.id));
        await db.delete(schema.userRole).where(eq(schema.userRole.userId, existing.id));
        await db.delete(schema.user).where(eq(schema.user.id, existing.id));
      }

      const memberId = crypto.randomUUID();
      await db.insert(schema.user).values({
        id: memberId,
        name: member.name,
        email: member.email,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.insert(schema.account).values({
        id: crypto.randomUUID(),
        accountId: member.email,
        providerId: "credential",
        userId: memberId,
        password: teamPasswordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Everyone on the team is an admin — it is a 4-person project, not a
      // multi-tenant product. Revisit if the platform is ever demoed externally.
      if (adminRole) {
        await db.insert(schema.userRole).values({
          userId: memberId,
          roleId: adminRole.id,
          isActive: true,
        });
      }
      console.log(`    + ${member.usn}  ${member.email}`);
    }

    console.log("🎉 Database Seeding Completed Successfully!");
    console.log("");
    console.log("  Team sign-in — all four share one password:");
    console.log(`    password: ${TEAM_PASSWORD}`);
    for (const m of TEAM) console.log(`    ${m.email}`);
    console.log("");
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
}

seed();
