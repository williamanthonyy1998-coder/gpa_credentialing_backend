import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { Role } from '@prisma/client';
import { audit } from '../lib/audit';

const router = Router();
const managerRoles = [Role.ADMIN, Role.CREDENTIALING_MANAGER];
const inputSchema = z.object({
  name: z.string().min(2), email: z.string().email(), role: z.nativeEnum(Role),
  department: z.string().min(2), jobTitle: z.string().min(2),
  phone: z.string().optional().nullable(), managerId: z.string().optional().nullable(),
  active: z.boolean().optional()
});

function makeTemporaryPassword() {
  // 24 random bytes provide a strong, URL-safe one-time password.
  return `Gpa!${randomBytes(24).toString('base64url')}9`;
}
function makeEmployeeCode() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `GPA-EMP-${yy}${mm}-${randomBytes(3).toString('hex').toUpperCase()}`;
}
async function sendWelcomeEmail(to: string, name: string, employeeCode: string, password: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('Email service is not configured. Set RESEND_API_KEY and EMAIL_FROM in backend .env before creating employees.');
  const loginUrl = process.env.APP_LOGIN_URL || process.env.WEB_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:5173';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Your Credentialing Workspace account',
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#19324a"><h2>Welcome, ${escapeHtml(name)}</h2><p>Your employee account has been created.</p><div style="background:#f3f7fb;padding:18px;border-radius:10px"><p><b>Employee ID:</b> ${employeeCode}</p><p><b>Login email:</b> ${escapeHtml(to)}</p><p><b>Temporary password:</b> ${password}</p></div><p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#087e8b;color:#fff;padding:12px 18px;border-radius:7px;text-decoration:none">Open Credentialing Workspace</a></p><p>For security, sign in and change your password immediately. Do not forward this email.</p></div>`
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Welcome email could not be sent (${response.status}): ${detail.slice(0, 300)}`);
  }
}
function escapeHtml(value: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, c => entities[c]);
}

router.post('/', allowRoles(...managerRoles), async (req: AuthRequest, res, next) => {
  let createdId: string | undefined;
  try {
    const d = inputSchema.parse(req.body);
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
      return res.status(503).json({ error: 'Email service is not configured. Add RESEND_API_KEY and EMAIL_FROM to backend .env before creating an employee.' });
    }
    const email = d.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
    const temporaryPassword = makeTemporaryPassword();
    const employeeCode = makeEmployeeCode();
    const row = await prisma.user.create({ data: {
      name: d.name, email, passwordHash: await bcrypt.hash(temporaryPassword, 12), role: d.role,
      department: d.department, jobTitle: d.jobTitle, employeeCode,
      phone: d.phone || null, managerId: d.managerId || null, active: d.active ?? true
    }});
    createdId = row.id;
    await sendWelcomeEmail(email, d.name, employeeCode, temporaryPassword);
    const { passwordHash, ...safe } = row;
    await audit(req, 'CREATE', 'employees', row.id, undefined, safe);
    res.status(201).json({ ...safe, emailSent: true });
  } catch (e) {
    // Do not leave an account behind when its one-time credentials were not delivered.
    if (createdId) {
      try { await prisma.user.delete({ where: { id: createdId } }); } catch { /* retain original delivery error */ }
    }
    next(e);
  }
});

router.patch('/:id', allowRoles(...managerRoles), async (req: AuthRequest, res, next) => {
  try {
    const d = inputSchema.partial().parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Employee not found' });
    const row = await prisma.user.update({ where: { id: req.params.id }, data: { ...d, email: d.email?.toLowerCase() } });
    const { passwordHash, ...safe } = row;
    await audit(req, 'UPDATE', 'employees', row.id, undefined, safe);
    res.json(safe);
  } catch (e) { next(e); }
});

router.post('/:id/reset-password', allowRoles(...managerRoles), async (req: AuthRequest, res, next) => {
  try {
    const { password } = z.object({ password: z.string().min(12) }).parse(req.body);
    const row = await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
    res.json({ success: true, id: row.id });
  } catch (e) { next(e); }
});
export default router;
