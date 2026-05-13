exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'NOTION_TOKEN not configured on server' }) };
  }

  try {
    const { method = 'GET', path, data } = JSON.parse(event.body);
    if (!path) {
      return { statusCode: 400, body: JSON.stringify({ error: 'path is required' }) };
    }

    const url = `https://api.notion.com/v1/${path}`;
    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    };
    if (data && method !== 'GET') {
      fetchOptions.body = JSON.stringify(data);
    }

    const res = await fetch(url, fetchOptions);
    const responseData = await res.json();

    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(responseData),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
