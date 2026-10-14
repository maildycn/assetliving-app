const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
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

// ── Gmail OAuth (user refresh token, read-only) ───────────────────────────────
async function getGmailAccessToken() {
  const clientId     = process.env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('GOOGLE_GMAIL_CLIENT_ID / GOOGLE_GMAIL_CLIENT_SECRET / GOOGLE_GMAIL_REFRESH_TOKEN not configured');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || 'Gmail token error');
  return data.access_token;
}

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// อีเมลจอง Agoda/Airbnb มักเป็น HTML ล้วน ไม่มี text/plain part — ต้อง walk หา part ที่ใช้ได้
function extractEmailBody(payload) {
  let plainBody = '';
  let htmlBody  = '';
  (function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plainBody += decodeBase64Url(part.body.data);
    if (part.mimeType === 'text/html' && part.body?.data) htmlBody += decodeBase64Url(part.body.data);
    (part.parts || []).forEach(walk);
  })(payload);
  return plainBody || htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

async function notionBookingExists(dbId, notionToken, messageId) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: 'Gmail Message ID', rich_text: { equals: messageId } } }),
  });
  const data = await r.json();
  return (data.results || []).length > 0;
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
  "base_rate": ราคาห้องพื้นฐาน (base rate / room rate) ก่อนรวมภาษีและค่าธรรมเนียม — ไม่ใช่ยอดสุทธิ/ยอดรวมที่ต้องชำระ ถ้าอีเมลแยกรายการราคาห้องออกจากภาษี/ค่าธรรมเนียมให้ใช้ตัวเลขราคาห้องอย่างเดียว ถ้าอีเมลให้มาแค่ยอดรวมโดยไม่แยก ให้ใช้ยอดรวมนั้นแทน เป็นตัวเลขล้วนไม่มีสัญลักษณ์เงิน (number หรือ null)
}

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

async function syncBookings(queryOverride) {
  const notionToken = process.env.NOTION_TOKEN;
  const bookingDb    = process.env.NOTION_BOOKING_DB_ID;
  if (!notionToken || !bookingDb) throw new Error('NOTION_TOKEN / NOTION_BOOKING_DB_ID not configured');

  const summary = { checked: 0, created: 0, skipped: 0, failed: [] };

  const accessToken = await getGmailAccessToken();
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?' +
      new URLSearchParams({ q: queryOverride || 'from:(agoda.com OR airbnb.com) newer_than:14d', maxResults: '20' }),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  const messages = listData.messages || [];
  summary.checked = messages.length;

  for (const m of messages) {
    try {
      if (await notionBookingExists(bookingDb, notionToken, m.id)) { summary.skipped++; continue; }

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const msg = await msgRes.json();
      const headers  = msg.payload?.headers || [];
      const fromAddr = headers.find((h) => h.name === 'From')?.value || '';
      const subject  = headers.find((h) => h.name === 'Subject')?.value || '';
      const bodyText = extractEmailBody(msg.payload);

      const booking = await extractBookingWithClaude(bodyText, fromAddr, subject);

      const props = {
        'ชื่อผู้เข้าพัก':      { title: [{ text: { content: booking.guest_name || '(ไม่ทราบชื่อ)' } }] },
        'แพลตฟอร์ม':          { select: { name: booking.platform } },
        'สถานะการจอง':        { select: { name: booking.status === 'ยกเลิก' ? 'ยกเลิก' : 'ยืนยันแล้ว' } },
        'Gmail Message ID':  { rich_text: [{ text: { content: m.id } }] },
        'อ่านแล้ว':           { checkbox: false },
      };
      if (booking.phone)                   props['เบอร์โทร']         = { phone_number: booking.phone };
      if (booking.room)                    props['ห้อง/ทรัพย์สิน']    = { rich_text: [{ text: { content: booking.room } }] };
      if (booking.booking_id)              props['หมายเลขการจอง']    = { rich_text: [{ text: { content: booking.booking_id } }] };
      if (typeof booking.base_rate === 'number') props['ราคา Base Rate (บาท)'] = { number: booking.base_rate };
      if (booking.check_in)                props['วันเช็คอิน']       = { date: { start: booking.check_in } };
      if (booking.check_out)               props['วันเช็คเอาท์']     = { date: { start: booking.check_out } };

      const createRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { database_id: bookingDb }, properties: props }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.message || JSON.stringify(createData));
      summary.created++;
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
