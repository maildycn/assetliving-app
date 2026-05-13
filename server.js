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

app.listen(PORT, () => console.log(`AssetLiving running on port ${PORT}`));
