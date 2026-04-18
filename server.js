const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');

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
  res.json({ status: 'AutoTube backend running ✓', version: '5.0.0', ai: 'Gemini 2.5 Flash + Unreal Speech + Stability AI' });
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Erreur Gemini' });

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

// ── UNREAL SPEECH — Synthèse vocale ──────────────────────
app.post('/generate-voice', async (req, res) => {
  const { text, voiceId, apiKey } = req.body;
  if (!text) return res.status(400).json({ error: 'text manquant' });

  const unrealKey = apiKey || process.env.UNREAL_SPEECH_API_KEY;
  if (!unrealKey) return res.status(400).json({ error: 'Clé Unreal Speech manquante' });

  const voiceMap = {
    'Neutre (Adam)':    'Scarlett',
    'Dynamique (Josh)': 'Dan',
    'Calme (Rachel)':   'Liv',
  };
  const voice = voiceMap[voiceId] || 'Scarlett';

  try {
    const response = await fetch('https://api.v7.unrealspeech.com/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${unrealKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Text: text,
        VoiceId: voice,
        Bitrate: '192k',
        Speed: '0',
        Pitch: '1',
        OutputFormat: 'uri',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || err.error || response.status });
    }

    const data = await response.json();
    res.json({ audioUrl: data.OutputUri });

  } catch (err) {
    console.error('Unreal Speech error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STABILITY AI — Génération d'images ───────────────────
app.post('/generate-image', async (req, res) => {
  const { prompt, apiKey } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt manquant' });

  const stabilityKey = apiKey || process.env.STABILITY_API_KEY;
  if (!stabilityKey) return res.status(400).json({ error: 'Clé Stability AI manquante' });

  try {
    const formData = new FormData();
    formData.append('prompt', `${prompt}, cinematic, high quality, 4k`);
    formData.append('output_format', 'jpeg');
    formData.append('width', '1344');
    formData.append('height', '768');
    formData.append('steps', '30');

    const response = await fetch(
      'https://api.stability.ai/v2beta/stable-image/generate/core',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stabilityKey}`,
          'Accept': 'image/*',
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || err.errors?.[0] || response.status });
    }

    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    res.json({ url: dataUrl });

  } catch (err) {
    console.error('Stability AI error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── QUOTA VOIX ───────────────────────────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  res.json({ used: 0, total: 250000 });
});

app.listen(PORT, () => {
  console.log(`AutoTube backend v5 — Gemini 2.5 Flash + Unreal Speech + Stability AI`);
});
