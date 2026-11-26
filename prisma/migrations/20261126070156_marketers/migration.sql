-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'PAYABLE', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "commission_amount" INTEGER,
ADD COLUMN     "commission_status" "CommissionStatus",
ADD COLUMN     "discount_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "list_price" INTEGER,
ADD COLUMN     "marketer_code" TEXT,
ADD COLUMN     "marketer_id" TEXT,
ADD COLUMN     "payout_id" TEXT;

-- CreateTable
CREATE TABLE "marketers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "code_secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bank_name" TEXT,
    "bank_account_number" TEXT,
    "bank_account_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "marketer_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketers_user_id_key" ON "marketers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketers_handle_key" ON "marketers"("handle");

-- CreateIndex
CREATE INDEX "payouts_marketer_id_idx" ON "payouts"("marketer_id");

-- CreateIndex
CREATE INDEX "orders_marketer_id_commission_status_idx" ON "orders"("marketer_id", "commission_status");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketer_id_fkey" FOREIGN KEY ("marketer_id") REFERENCES "marketers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketers" ADD CONSTRAINT "marketers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_marketer_id_fkey" FOREIGN KEY ("marketer_id") REFERENCES "marketers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
