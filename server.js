const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

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

// ── Notion file upload proxy ──────────────────────────────────────────────────
app.post('/api/notion-upload', async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });

  const { filename, mimeType, data } = req.body; // data = base64 string
  if (!data || !filename) return res.status(400).json({ error: 'filename and data required' });

  try {
    // Step 1: create file-upload record
    const createRes = await fetch('https://api.notion.com/v1/file-uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const upload = await createRes.json();
    if (!createRes.ok) return res.status(createRes.status).json(upload);

    // Step 2: send file binary (Node 18+ has built-in FormData and Blob)
    const fileBuffer = Buffer.from(data, 'base64');
    const fd = new FormData();
    fd.set('file', new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' }), filename);

    const sendRes = await fetch(`https://api.notion.com/v1/file-uploads/${upload.id}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      body: fd,
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) return res.status(sendRes.status).json(sendData);

    res.json({ upload_id: upload.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`AssetLiving running on port ${PORT}`));
