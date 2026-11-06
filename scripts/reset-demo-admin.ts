import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const password = 'LocalDemo-ChangeThis-2026!';

async function main() {
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { email: 'admin@example.com' },
    data: { passwordHash }
  });
  console.log('admin password reset to documented demo default');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
