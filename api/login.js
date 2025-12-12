// api/login.js
const fetch = require('node-fetch');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Captcha-Rqtoken');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Captcha-Key, X-Captcha-Rqtoken');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { login, password, captcha_key, captcha_rqtoken } = req.body;

    if (!login || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    
    const headers = {
      "Content-Type": "application/json",
      "Origin": "https://discord.com",
      "Referer": "https://discord.com/login",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      "X-Fingerprint": "1449055427177484542.uPo_4AUwKCGfP26zh4-mzEnO6yk",
      "X-Super-Properties": "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImphIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Mi4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTQyLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjQ3OTIxOSwiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbCwiY2xpZW50X2xhdW5jaF9pZCI6IjZhYjNmNmQ4LThlM2MtNDE5OS1hOWE0LWU3Y2M3NGJjODY1ZSIsImxhdW5jaF9zaWduYXR1cmUiOiI3ZjU2ODg0Ni1jNDY3LTQ2MTMtODQ1Ni0yYjg3MjIzNGQyMzEiLCJjbGllbnRfYXBwX3N0YXRlIjoiZm9jdXNlZCJ9"
    };

    if (captcha_key) {
      headers["X-Captcha-Key"] = captcha_key;
    }
    if (captcha_rqtoken) {
      headers["X-Captcha-Rqtoken"] = captcha_rqtoken;
    }

    const discordRes = await fetch("https://discord.com/api/v9/auth/login", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
          login: login,
          password: password,
          undelete: false,
          login_source: null,
          gift_code_sku_id: null
      }),
    });

    const data = await discordRes.json();
    
    const newRqtoken = discordRes.headers.get('x-captcha-rqtoken');
    if (newRqtoken) {
      res.setHeader('X-Captcha-Rqtoken', newRqtoken);
    }
    
    res.status(discordRes.status).json(data);

  } catch (error) {
    console.error('Proxy Function Error:', error);
    res.status(500).json({ message: 'An internal server error occurred.' });
  }
}
