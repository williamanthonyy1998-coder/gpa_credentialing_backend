import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { ZodError } from 'zod';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import resourcesRoutes from './routes/resources';
import filesRoutes from './routes/files';
import employeesRoutes from './routes/employees';
import directoryRoutes from './routes/directory';
import credentialsRoutes from './routes/credentials';
import { authenticate } from './middleware/auth';
import { prisma } from './lib/prisma';

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: (process.env.WEB_ORIGIN || 'http://localhost:5173,http://localhost:5174').split(',').map(x => x.trim()),
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: true, legacyHeaders: false }));
app.get('/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok', database: 'connected' }); }
  catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
});
app.use('/api/auth', authRoutes);
app.use('/api/employees', authenticate, employeesRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/documents', authenticate, filesRoutes);
app.use('/api/directory', authenticate, directoryRoutes);
app.use('/api/credentials', authenticate, credentialsRoutes);
app.use('/api', authenticate, resourcesRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
  if (err?.code === 'P2002') return res.status(409).json({ error: 'A record with this unique value already exists' });
  if (err?.code === 'P2003') return res.status(400).json({ error: 'Referenced record does not exist or is still in use' });
  console.error(err);
  return res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err?.message || 'Internal server error') });
});
const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Credentialing API listening on :${port}`));
const shutdown = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
