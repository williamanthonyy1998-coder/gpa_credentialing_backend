-- Repair User columns expected by Prisma's current User model.
-- Safe to run more than once. Does not delete or rewrite existing user data.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "employeeCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "managerId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_employeeCode_key"
  ON "User" ("employeeCode");
CREATE INDEX IF NOT EXISTS "User_managerId_idx"
  ON "User" ("managerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'User_managerId_fkey'
      AND conrelid = '"User"'::regclass
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_managerId_fkey"
      FOREIGN KEY ("managerId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
