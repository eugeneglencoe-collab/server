const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    'https://eugeneglencoe-collab.github.io',
    'http://localhost:3000',
    'http://localhost:8080',
  ]
}));

app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '2.0.0', ai: 'Gemini' });
});

// ── GEMINI — Génération de script ────────────────────────
app.post('/generate-script', async (req, res) => {
  const { topic, tags, duration, apiKey } = req.body;

  if (!topic) return res.status(400).json({ error: 'topic manquant' });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'Clé Gemini manquante' });

  const prompt = `Tu es un expert en création de contenu YouTube francophone.

Génère un script complet pour une vidéo YouTube sur : "${topic}"
Tags/Niche : ${(tags||[]).join(', ')}
Durée cible : ${duration || '5-8 min'}

Réponds UNIQUEMENT en JSON valide avec cette structure exacte, sans aucun texte avant ou après :
{
  "title": "Titre accrocheur (max 60 chars)",
  "description": "Description YouTube complète avec keywords (300-500 chars)",
  "tags": ["tag1", "tag2", "tag3"],
  "narration": "Script complet de narration à lire",
  "imagePrompts": ["prompt image 1", "prompt image 2", "prompt image 3", "prompt image 4", "prompt image 5", "prompt image 6", "prompt image 7", "prompt image 8"],
  "thumbnailPrompt": "Prompt pour la miniature YouTube ultra accrocheur"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2000,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Erreur Gemini' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const script = JSON.parse(clean);

    const usage = {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    };

    res.json({ script, usage });

  } catch (err) {
    console.error('Gemini error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ELEVENLABS — Synthèse vocale ─────────────────────────
app.post('/generate-voice', async (req, res) => {
  const { text, voiceId, apiKey } = req.body;

  if (!text) return res.status(400).json({ error: 'text manquant' });

  const elKey = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!elKey) return res.status(400).json({ error: 'Clé ElevenLabs manquante' });

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || 'pNInz6obpgDQGcFmaJgB'}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const audioBuffer = await response.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);

  } catch (err) {
    console.error('ElevenLabs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── REPLICATE — Génération d'images ──────────────────────
app.post('/generate-image', async (req, res) => {
  const { prompt, apiKey } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt manquant' });

  const repKey = apiKey || process.env.REPLICATE_API_KEY;
  if (!repKey) return res.status(400).json({ error: 'Clé Replicate manquante' });

  try {
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${repKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '39ed52f2319f9b697792cf2c47f2c8f6bfc3b4d63c1f2e5d3a4f5a9a5b5c5d5e',
        input: {
          prompt: `${prompt}, cinematic, high quality, 4k`,
          width: 1280,
          height: 720,
        },
      }),
    });

    const prediction = await createRes.json();
    if (!createRes.ok) return res.status(createRes.status).json({ error: prediction.detail });

    let result = prediction;
    let tries = 0;
    while (result.status !== 'succeeded' && result.status !== 'failed' && tries < 30) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Token ${repKey}` },
      });
      result = await pollRes.json();
      tries++;
    }

    if (result.status === 'failed') return res.status(500).json({ error: 'Replicate failed: ' + result.error });
    if (result.status !== 'succeeded') return res.status(500).json({ error: 'Timeout Replicate' });

    res.json({ url: result.output[0] });

  } catch (err) {
    console.error('Replicate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ELEVENLABS — Quota ───────────────────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  const elKey = req.headers['xi-api-key'] || process.env.ELEVENLABS_API_KEY;
  if (!elKey) return res.status(400).json({ error: 'Clé manquante' });

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': elKey }
    });
    const data = await r.json();
    res.json({
      used: data.subscription.character_count,
      total: data.subscription.character_limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AutoTube backend v2 running on port ${PORT} — AI: Gemini 1.5 Flash`);
});
