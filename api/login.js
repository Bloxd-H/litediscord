// api/login.js
const fetch = require('node-fetch');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Captcha-Rqtoken');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Captcha-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { login, password, captcha_key } = req.body;
    if (!login || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    
    const headers = {
      "Content-Type": "application/json",
      "X-Super-Properties": "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImphIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMy4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIzLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5fQ==",
    };

    if (captcha_key) {
      headers["X-Captcha-Key"] = captcha_key;
    }

    const discordRes = await fetch("https://discord.com/api/v9/auth/login", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ login, password }),
    });

    const data = await discordRes.json();
    
    const rqtoken = discordRes.headers.get('x-captcha-rqtoken');
    if (rqtoken) {
      res.setHeader('X-Captcha-Rqtoken', rqtoken);
    }
    
    res.status(discordRes.status).json(data);

  } catch (error) {
    console.error('Proxy Function Error:', error);
    res.status(500).json({ message: 'An internal server error occurred.' });
  }
}
