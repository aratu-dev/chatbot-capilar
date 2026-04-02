-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "jid" TEXT,
    "nome" TEXT,
    "idade" INTEGER,
    "dorPrincipal" TEXT,
    "intensidade" TEXT,
    "tempoProblema" TEXT,
    "tratamentoAnterior" TEXT,
    "objetivoAtual" TEXT,
    "quimica" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Novo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSession" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "etapa" INTEGER NOT NULL DEFAULT 0,
    "respostas" JSONB,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_phone_key" ON "Lead"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSession_phone_key" ON "LeadSession"("phone");
