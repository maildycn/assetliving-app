const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_BASE_URL = 'https://assetliving-app.onrender.com';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── In-memory file store (served as public URLs for Notion external links) ────
const _files = new Map(); // id → { filename, mimeType, buf }

app.post('/api/files', (req, res) => {
  const { filename, mimeType, data } = req.body;
  if (!data || !filename) return res.status(400).json({ error: 'filename and data required' });

  const id  = crypto.randomBytes(16).toString('hex');
  const buf = Buffer.from(data, 'base64');
  _files.set(id, { filename, mimeType: mimeType || 'application/octet-stream', buf });

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.get('host');
  res.json({ url: `${proto}://${host}/api/files/${id}` });
});

app.get('/api/files/:id', (req, res) => {
  const f = _files.get(req.params.id);
  if (!f) return res.status(404).send('File not found');
  res.setHeader('Content-Type', f.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
  res.send(f.buf);
});

// ── Claude proxy ──────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_KEY not configured' } });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Notion proxy ──────────────────────────────────────────────────────────────
app.post('/api/notion', async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });

  const { method = 'GET', path: notionPath, data } = req.body;
  if (!notionPath) return res.status(400).json({ error: 'path is required' });

  try {
    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    };
    if (data && method !== 'GET') fetchOptions.body = JSON.stringify(data);

    const response = await fetch(`https://api.notion.com/v1/${notionPath}`, fetchOptions);
    const responseData = await response.json();
    res.status(response.status).json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar proxy (Service Account, no extra packages) ───────────────
async function getGoogleToken() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY not configured');

  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || 'Token error');
  return data.access_token;
}

app.post('/api/gcal', async (req, res) => {
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const { summary, description, date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });

  try {
    const token = await getGoogleToken();

    // สร้าง event วันที่สัญญาหมด พร้อม reminder 30/7/1 วัน
    const event = {
      summary: summary || 'สัญญาเช่าหมดอายุ',
      description,
      start: { date },
      end:   { date },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 43200 }, // 30 วัน
          { method: 'popup', minutes: 10080 }, // 7 วัน
          { method: 'popup', minutes: 1440  }, // 1 วัน
          { method: 'email', minutes: 43200 },
          { method: 'email', minutes: 10080 },
        ],
      },
      colorId: '11', // แดง = สำคัญ
    };

    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Calendar error');
    res.json({ ok: true, eventId: data.id, link: data.htmlLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gmail IMAP (app password, read-only) ───────────────────────────────────────
// แทนที่ Gmail REST API + OAuth เดิม (refresh token เป็น "restricted scope" ตาม
// Google — publish ไป production ไม่ได้ถ้าไม่ผ่าน security assessment ทำให้ token
// หมดอายุทุก 7 วันตลอดไปถ้ายังอยู่ใน Testing) ใช้ app password เดียวกับที่ใช้ส่ง
// อีเมลแจ้งเจ้าของอยู่แล้ว (OWNER_NOTIFY_EMAIL_USER/PASSWORD) — app password ไม่หมดอายุ
// ตามรอบแบบนี้ และใช้ได้ทั้ง IMAP/SMTP เพราะผูกกับทั้งบัญชี ไม่ใช่ผูกกับ scope
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');

async function fetchBookingEmails(queryOverride) {
  const user = process.env.OWNER_NOTIFY_EMAIL_USER;
  const pass = process.env.OWNER_NOTIFY_EMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('OWNER_NOTIFY_EMAIL_USER / OWNER_NOTIFY_EMAIL_APP_PASSWORD not configured');

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const emails = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const uids = new Set();
      if (queryOverride) {
        (await client.search({ or: [{ subject: queryOverride }, { body: queryOverride }], since }, { uid: true })).forEach((u) => uids.add(u));
      } else {
        for (const from of ['agoda.com', 'airbnb.com', 'imnoonan2@gmail.com']) {
          (await client.search({ from, since }, { uid: true })).forEach((u) => uids.add(u));
        }
      }

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        emails.push({
          id:      parsed.messageId || `imap-uid-${uid}`,
          from:    parsed.from?.text || '',
          subject: parsed.subject || '',
          body:    parsed.text || (parsed.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return emails;
}

async function notionBookingExists(dbId, notionToken, messageId) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: 'Gmail Message ID', rich_text: { contains: messageId } } }),
  });
  const data = await r.json();
  return (data.results || []).length > 0;
}

// Agoda/Airbnb มักส่งหลายอีเมล (ยืนยัน/แก้ไข/อัปเดตผู้เข้าพัก) สำหรับการจองเดียวกัน — แต่ละฉบับมี Gmail Message ID
// ต่างกัน จึงต้องเช็คซ้ำด้วยหมายเลขการจองด้วย ไม่งั้นจะได้การ์ดซ้ำในเว็บ (พบจริง: booking #2059712417 ซ้ำ 3 ใบ)
async function notionBookingIdExists(dbId, notionToken, bookingId) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: 'หมายเลขการจอง', rich_text: { equals: bookingId } } }),
  });
  const data = await r.json();
  const results = data.results || [];
  return results[0]?.id || null;
}

async function extractBookingWithClaude(emailText, fromAddr, subject) {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_KEY not configured');
  // อีเมลที่ถูก forward ต่อ (ไม่ว่าด้วย filter หรือ manual) จะมี From เป็นคนส่งต่อ ไม่ใช่ agoda/airbnb อีกต่อไป — เผื่อไว้ด้วย subject + เนื้อหา
  const haystack = `${fromAddr} ${subject || ''} ${emailText.slice(0, 500)}`;
  const platform = /agoda/i.test(haystack) ? 'Agoda' : /airbnb/i.test(haystack) ? 'Airbnb' : 'ไม่ทราบ';

  const prompt = `นี่คืออีเมลยืนยันการจองที่พักจาก ${platform} แยกข้อมูลต่อไปนี้แล้วตอบเป็น JSON ล้วนๆ เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON:
{
  "guest_name": ชื่อผู้เข้าพัก (string หรือ null),
  "phone": เบอร์โทรผู้เข้าพัก ถ้ามีในอีเมล (string หรือ null),
  "check_in": วันเช็คอิน รูปแบบ YYYY-MM-DD (string หรือ null),
  "check_out": วันเช็คเอาท์ รูปแบบ YYYY-MM-DD (string หรือ null),
  "room": ชื่อห้องพัก/ทรัพย์สินที่ถูกจอง (string หรือ null),
  "status": "ยืนยันแล้ว" หรือ "ยกเลิก",
  "booking_id": หมายเลขการจอง/อ้างอิง (string หรือ null),
  "base_rate": ราคาห้องพื้นฐาน (base rate / room rate) ก่อนรวมภาษีและค่าธรรมเนียม — ไม่ใช่ยอดสุทธิ/ยอดรวมที่ต้องชำระ ถ้าอีเมลแยกรายการราคาห้องออกจากภาษี/ค่าธรรมเนียมให้ใช้ตัวเลขราคาห้องอย่างเดียว ถ้าอีเมลให้มาแค่ยอดรวมโดยไม่แยก ให้ใช้ยอดรวมนั้นแทน เป็นตัวเลขล้วนไม่มีสัญลักษณ์เงิน (number หรือ null),
  "manage_url": URL เต็มของลิงก์ดู/จัดการการจองนี้โดยตรงในอีเมล (ข้อความลิงก์มักเป็น "ดูรายละเอียดการจอง", "View booking", "Manage booking" หรือคล้ายกัน) ให้คัดลอก URL มาเป๊ะๆ ตามที่ปรากฏ ห้ามแต่งเติมหรือตัดทอน ถ้าไม่เจอให้เป็น null (string หรือ null)
}

กฎสำคัญเรื่องวันที่ (อ่านพลาดบ่อย ต้องระวังเป็นพิเศษ):
- ปีต้องเป็น ค.ศ. (Gregorian) เท่านั้น ถ้าอีเมลเขียนปีแบบ พ.ศ. (เช่น 2569) ให้แปลงเป็น ค.ศ. ก่อนตอบ (ลบ 543: 2569 → 2026) ห้ามตอบปี พ.ศ. ดิบๆ เด็ดขาด
- check_in กับ check_out ต้องอ้างอิงจากคำที่อีเมลระบุไว้ชัดเจน (เช่น "Check-in", "Check-out", "วันเข้าพัก", "วันออก") ห้ามเดาจากตำแหน่งวันที่ในอีเมลเฉยๆ
- check_out ต้องเป็นวันที่หลัง check_in เสมอ ถ้าคำนวณแล้วไม่ใช่ ให้ตรวจทานใหม่ว่าอ่านสลับกันหรือไม่
- ถ้าอีเมลเขียนวันที่แบบกำกวม (เช่น 03/04/2026 ไม่ชัดว่า DD/MM หรือ MM/DD) ให้ยึดรูปแบบที่แพลตฟอร์มนั้นใช้ปกติ (Agoda/Airbnb มักเขียนชื่อเดือนเป็นตัวอักษรเพื่อกันกำกวมอยู่แล้ว เช่น "October 23, 2026" — ใช้ค่านั้นเป็นหลักถ้ามี)

อีเมล:
${emailText.slice(0, 6000)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await r.json();
  const raw = data.content?.[0]?.text || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI did not return JSON: ' + raw.slice(0, 200));
  return { ...JSON.parse(m[0]), platform };
}

// ตรวจความสมเหตุสมผลของวันที่หลังแยกข้อมูล แทนที่จะเชื่อ AI เฉยๆ — แก้ปี พ.ศ. ที่หลุดมาให้อัตโนมัติ, flag ที่เหลือไว้ให้คนตรวจ
function sanityCheckDates(booking) {
  const warnings = [];
  const fixYear = (dateStr, label) => {
    if (!dateStr) return dateStr;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) { warnings.push(`รูปแบบวันที่ ${label} ผิดปกติ: "${dateStr}"`); return dateStr; }
    let year = parseInt(match[1], 10);
    if (year > 2400) {
      year -= 543;
      warnings.push(`${label}: AI อ่านเป็นปี พ.ศ. ${match[1]} ระบบแปลงเป็น ค.ศ. ${year} ให้อัตโนมัติ — โปรดตรวจสอบ`);
      return `${year}-${match[2]}-${match[3]}`;
    }
    return dateStr;
  };

  booking.check_in = fixYear(booking.check_in, 'เช็คอิน');
  booking.check_out = fixYear(booking.check_out, 'เช็คเอาท์');

  const now = new Date();
  const farFuture = new Date(); farFuture.setFullYear(now.getFullYear() + 2);
  const farPast = new Date(); farPast.setFullYear(now.getFullYear() - 1);
  for (const [label, val] of [['เช็คอิน', booking.check_in], ['เช็คเอาท์', booking.check_out]]) {
    if (!val) continue;
    const d = new Date(val);
    if (isNaN(d.getTime())) warnings.push(`วันที่${label} "${val}" แปลงเป็นวันที่จริงไม่ได้`);
    else if (d < farPast || d > farFuture) warnings.push(`วันที่${label} (${val}) ห่างจากวันนี้ผิดปกติ ควรตรวจสอบว่า AI อ่านถูกหรือไม่`);
  }
  if (booking.check_in && booking.check_out) {
    const inD = new Date(booking.check_in), outD = new Date(booking.check_out);
    if (!isNaN(inD.getTime()) && !isNaN(outD.getTime()) && outD <= inD) {
      warnings.push('วันเช็คเอาท์ไม่ได้อยู่หลังวันเช็คอิน — อาจอ่านสลับกันหรือผิด');
    }
  }
  return warnings;
}

// ── แจ้งเจ้าของห้องให้กดยืนยัน/ปฏิเสธการจองทางอีเมล (แทนการโทรถาม) ───────────
function escapeHtmlServer(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ownerToken(pageId, action) {
  return crypto.createHmac('sha256', process.env.OWNER_APPROVAL_SECRET || '').update(`${pageId}:${action}`).digest('hex').slice(0, 24);
}

async function sendOwnerApprovalEmail(pageId, booking) {
  const { OWNER_NOTIFY_EMAIL_USER, OWNER_NOTIFY_EMAIL_APP_PASSWORD, OWNER_EMAIL, OWNER_APPROVAL_SECRET } = process.env;
  if (!OWNER_NOTIFY_EMAIL_USER || !OWNER_NOTIFY_EMAIL_APP_PASSWORD || !OWNER_EMAIL || !OWNER_APPROVAL_SECRET) return; // ยังไม่ตั้งค่า ข้ามไปเงียบๆ

  const approveUrl = `${APP_BASE_URL}/owner-response/${pageId}/approve?token=${ownerToken(pageId, 'approve')}`;
  const rejectUrl  = `${APP_BASE_URL}/owner-response/${pageId}/reject?token=${ownerToken(pageId, 'reject')}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111;">
      <h2>มีคำขอจองใหม่ — ต้องการให้ยืนยันห้องว่าง</h2>
      <p><b>ผู้เข้าพัก:</b> ${escapeHtmlServer(booking.guest_name || '(ไม่ทราบชื่อ)')}</p>
      <p><b>แพลตฟอร์ม:</b> ${escapeHtmlServer(booking.platform || '-')}</p>
      ${booking.room ? `<p><b>ห้อง/ทรัพย์สิน:</b> ${escapeHtmlServer(booking.room)}</p>` : ''}
      <p><b>เช็คอิน:</b> ${escapeHtmlServer(booking.check_in || '-')} &nbsp; <b>เช็คเอาท์:</b> ${escapeHtmlServer(booking.check_out || '-')}</p>
      ${typeof booking.base_rate === 'number' ? `<p><b>Base Rate:</b> ฿${booking.base_rate.toLocaleString()}</p>` : ''}
      <div style="margin-top:24px;">
        <a href="${approveUrl}" style="background:#10b981;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:12px;">✅ ห้องว่าง ยืนยันได้</a>
        <a href="${rejectUrl}" style="background:#ef4444;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">❌ ห้องไม่ว่าง</a>
      </div>
      <p style="margin-top:20px;color:#888;font-size:12px;">คลิกแล้วจะมีหน้ายืนยันอีกครั้งก่อนบันทึกผล — ปุ่มนี้เป็นการยืนยัน/ปฏิเสธกันภายในเท่านั้น ไม่ได้ไปทำรายการใดๆ ใน Agoda ให้อัตโนมัติ</p>
      ${booking.manage_url ? `<p style="margin-top:12px;"><a href="${booking.manage_url}" style="color:#6366f1;">🔗 ไปที่หน้าการจองนี้ใน Agoda</a> (ยืนยัน/ยกเลิกฝั่ง Agoda ต้องทำที่นี่ด้วยตัวเองเสมอ)</p>` : ''}
    </div>`;

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: OWNER_NOTIFY_EMAIL_USER, pass: OWNER_NOTIFY_EMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: OWNER_NOTIFY_EMAIL_USER,
    to: OWNER_EMAIL,
    subject: `คำขอจองใหม่ — ${booking.guest_name || 'ผู้เข้าพัก'} (เช็คอิน ${booking.check_in || '-'})`,
    html,
  });
}

function ownerConfirmPage(id, action, token) {
  const label = action === 'approve' ? 'ยืนยันว่าห้องว่าง' : 'แจ้งว่าห้องไม่ว่าง';
  const color = action === 'approve' ? '#10b981' : '#ef4444';
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ยืนยันคำตอบ</title>
    <style>body{font-family:Arial,sans-serif;background:#0a0c12;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;}
    .box{text-align:center;max-width:360px;} button{padding:14px 28px;border:none;border-radius:8px;background:${color};color:#fff;font-size:16px;font-weight:bold;cursor:pointer;}</style>
    </head><body><div class="box">
    <h2>ต้องการ${label}ใช่หรือไม่?</h2>
    <form method="POST" action="/owner-response/${id}/${action}?token=${encodeURIComponent(token)}">
      <button type="submit">ยืนยัน${label}</button>
    </form>
    </div></body></html>`;
}

function ownerResultPage(approved) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>บันทึกคำตอบแล้ว</title>
    <style>body{font-family:Arial,sans-serif;background:#0a0c12;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}</style>
    </head><body><div style="text-align:center;padding:24px;">
    <div style="font-size:48px;">${approved ? '✅' : '❌'}</div>
    <h2>${approved ? 'ยืนยันห้องว่างแล้ว' : 'บันทึกว่าห้องไม่ว่างแล้ว'}</h2>
    <p style="color:#94a3b8;">ระบบอัปเดตเรียบร้อย ปิดหน้านี้ได้เลย</p>
    </div></body></html>`;
}

app.get('/owner-response/:id/:action', (req, res) => {
  const { id, action } = req.params;
  const { token } = req.query;
  if (!['approve', 'reject'].includes(action)) return res.status(400).send('Invalid action');
  if (!process.env.OWNER_APPROVAL_SECRET || token !== ownerToken(id, action)) return res.status(403).send('ลิงก์ไม่ถูกต้องหรือหมดอายุ');
  res.send(ownerConfirmPage(id, action, token));
});

app.post('/owner-response/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const { token } = req.query;
  if (!['approve', 'reject'].includes(action)) return res.status(400).send('Invalid action');
  if (!process.env.OWNER_APPROVAL_SECRET || token !== ownerToken(id, action)) return res.status(403).send('ลิงก์ไม่ถูกต้องหรือหมดอายุ');

  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { 'สถานะเจ้าของห้อง': { select: { name: action === 'approve' ? 'ยืนยันแล้ว' : 'ปฏิเสธ' } } } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'update failed');
    res.send(ownerResultPage(action === 'approve'));
  } catch (err) {
    res.status(500).send('เกิดข้อผิดพลาด: ' + err.message);
  }
});

async function syncBookings(queryOverride) {
  const notionToken = process.env.NOTION_TOKEN;
  const bookingDb    = process.env.NOTION_BOOKING_DB_ID;
  if (!notionToken || !bookingDb) throw new Error('NOTION_TOKEN / NOTION_BOOKING_DB_ID not configured');

  const summary = { checked: 0, created: 0, skipped: 0, failed: [] };

  const messages = await fetchBookingEmails(queryOverride);
  summary.checked = messages.length;

  for (const m of messages) {
    try {
      if (await notionBookingExists(bookingDb, notionToken, m.id)) { summary.skipped++; continue; }

      const booking = await extractBookingWithClaude(m.body, m.from, m.subject);
      const dateWarnings = sanityCheckDates(booking);

      if (booking.booking_id) {
        const existingId = await notionBookingIdExists(bookingDb, notionToken, booking.booking_id);
        if (existingId) {
          // อีเมลฉบับใหม่แต่หมายเลขการจองซ้ำกับที่มีอยู่แล้ว — ไม่สร้างการ์ดใหม่ แค่ผูก Gmail Message ID นี้ไว้กับใบเดิม
          // กัน sync รอบถัดไปมาประมวลผลอีเมลฉบับนี้ซ้ำอีก
          const pageRes = await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
            headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28' },
          });
          const pageData = await pageRes.json();
          const existingMsgIds = pageData.properties?.['Gmail Message ID']?.rich_text?.[0]?.plain_text || '';
          await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
            body: JSON.stringify({ properties: { 'Gmail Message ID': { rich_text: [{ text: { content: `${existingMsgIds},${m.id}` } }] } } }),
          });
          summary.duplicateBookingId = summary.duplicateBookingId || [];
          summary.duplicateBookingId.push({ id: m.id, booking_id: booking.booking_id, existingPage: existingId });
          summary.skipped++;
          continue;
        }
      }

      const props = {
        'ชื่อผู้เข้าพัก':      { title: [{ text: { content: booking.guest_name || '(ไม่ทราบชื่อ)' } }] },
        'แพลตฟอร์ม':          { select: { name: booking.platform } },
        'สถานะการจอง':        { select: { name: booking.status === 'ยกเลิก' ? 'ยกเลิก' : 'ยืนยันแล้ว' } },
        'Gmail Message ID':  { rich_text: [{ text: { content: m.id } }] },
        'อ่านแล้ว':           { checkbox: false },
        'สถานะเจ้าของห้อง':    { select: { name: 'รอตอบรับ' } },
      };
      if (booking.phone)                   props['เบอร์โทร']         = { phone_number: booking.phone };
      if (booking.room)                    props['ห้อง/ทรัพย์สิน']    = { rich_text: [{ text: { content: booking.room } }] };
      if (booking.booking_id)              props['หมายเลขการจอง']    = { rich_text: [{ text: { content: booking.booking_id } }] };
      if (typeof booking.base_rate === 'number') props['ราคา Base Rate (บาท)'] = { number: booking.base_rate };
      if (booking.manage_url && /^https?:\/\//.test(booking.manage_url)) props['ลิงก์จัดการใน Agoda'] = { url: booking.manage_url };
      if (booking.check_in)                props['วันเช็คอิน']       = { date: { start: booking.check_in } };
      if (booking.check_out)               props['วันเช็คเอาท์']     = { date: { start: booking.check_out } };
      if (dateWarnings.length) {
        props['หมายเหตุ'] = { rich_text: [{ text: { content: '⚠️ ' + dateWarnings.join(' / ') } }] };
        summary.dateWarnings = summary.dateWarnings || [];
        summary.dateWarnings.push({ id: m.id, warnings: dateWarnings });
      }

      const createRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { database_id: bookingDb }, properties: props }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.message || JSON.stringify(createData));
      summary.created++;

      try {
        await sendOwnerApprovalEmail(createData.id, booking);
      } catch (mailErr) {
        console.error('sendOwnerApprovalEmail failed for', m.id, mailErr);
        summary.mailFailed = summary.mailFailed || [];
        summary.mailFailed.push({ id: m.id, error: mailErr.message });
      }
    } catch (err) {
      summary.failed.push({ id: m.id, error: err.message });
    }
  }
  return summary;
}

// endpoint ให้ external cron เรียกเป็นระยะเพื่อ sync การจองใหม่จากอีเมล
app.get('/cron/sync-bookings', async (req, res) => {
  if (!process.env.BOOKING_CRON_SECRET || req.query.key !== process.env.BOOKING_CRON_SECRET) return res.status(403).send('Forbidden');
  try {
    res.json(await syncBookings(req.query.q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bookings API สำหรับหน้าเว็บ (list + badge unread count) ───────────────────
app.get('/api/bookings', async (req, res) => {
  const notionToken = process.env.NOTION_TOKEN;
  const bookingDb    = process.env.NOTION_BOOKING_DB_ID;
  if (!notionToken || !bookingDb) return res.status(500).json({ error: 'NOTION_BOOKING_DB_ID not configured' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${bookingDb}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Notion query failed');

    const bookings = (data.results || []).map((p) => {
      const props = p.properties;
      return {
        id: p.id,
        guest_name: props['ชื่อผู้เข้าพัก']?.title?.[0]?.plain_text || '',
        phone: props['เบอร์โทร']?.phone_number || '',
        platform: props['แพลตฟอร์ม']?.select?.name || '',
        check_in: props['วันเช็คอิน']?.date?.start || '',
        check_out: props['วันเช็คเอาท์']?.date?.start || '',
        room: props['ห้อง/ทรัพย์สิน']?.rich_text?.[0]?.plain_text || '',
        status: props['สถานะการจอง']?.select?.name || '',
        booking_id: props['หมายเลขการจอง']?.rich_text?.[0]?.plain_text || '',
        base_rate: props['ราคา Base Rate (บาท)']?.number ?? null,
        manage_url: props['ลิงก์จัดการใน Agoda']?.url || '',
        owner_status: props['สถานะเจ้าของห้อง']?.select?.name || '',
        notes: props['หมายเหตุ']?.rich_text?.[0]?.plain_text || '',
        read: !!props['อ่านแล้ว']?.checkbox,
        created_time: p.created_time,
      };
    });
    res.json({ bookings, unreadCount: bookings.filter((b) => !b.read).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings/:id/read', async (req, res) => {
  const notionToken = process.env.NOTION_TOKEN;
  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { 'อ่านแล้ว': { checkbox: true } } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'update failed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings/:id/notes', async (req, res) => {
  const notionToken = process.env.NOTION_TOKEN;
  const notes = typeof req.body.notes === 'string' ? req.body.notes : '';
  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { 'หมายเหตุ': { rich_text: notes ? [{ text: { content: notes } }] : [] } } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'update failed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`AssetLiving running on port ${PORT}`));
