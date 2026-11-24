-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('EXPIRES_IN_3_DAYS', 'EXPIRES_TODAY');

-- CreateTable
CREATE TABLE "reminder_emails" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "access_until" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_emails_user_id_kind_access_until_key" ON "reminder_emails"("user_id", "kind", "access_until");

-- AddForeignKey
ALTER TABLE "reminder_emails" ADD CONSTRAINT "reminder_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
