import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const prefix = "visa-compass/marketing/campaigns/";

async function main() {
  const bucket = process.env.AWS_MARKETING_ASSET_BUCKET ?? process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region)
    throw new Error("AWS_REGION and a marketing or primary S3 bucket are required");
  const client = new S3Client({ region });
  const publicRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../customer-web/public",
  );
  const campaigns = await prisma.homepageCampaign.findMany({
    where: { assetKey: null, imageUrl: { startsWith: "/campaigns/" } },
    select: { id: true, imageUrl: true },
  });

  for (const campaign of campaigns) {
    const bytes = await readFile(resolve(publicRoot, campaign.imageUrl.slice(1)));
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const assetKey = `${prefix}campaign_seed_${campaign.id}_${digest}.webp`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: assetKey,
        Body: bytes,
        ContentType: "image/webp",
        ContentLength: bytes.length,
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { sha256: digest, source: "bundled-homepage-seed" },
      }),
    );
    const uploaded = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: assetKey }),
    );
    if (
      Number(uploaded.ContentLength ?? 0) !== bytes.length ||
      uploaded.ContentType !== "image/webp" ||
      uploaded.Metadata?.sha256 !== digest
    )
      throw new Error(`Uploaded campaign asset could not be verified: ${campaign.id}`);
    await prisma.homepageCampaign.update({
      where: { id: campaign.id },
      data: { assetKey },
    });
    process.stdout.write(`Backfilled campaign ${campaign.id}\n`);
  }
  process.stdout.write(`Homepage campaign media ready (${campaigns.length} uploaded).\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
