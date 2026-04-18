const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    'https://eugeneglencoe-collab.github.io',
    'http://localhost:3000',
    'http://localhost:8080',
  ]
}));

app.use(express.json({ limit: '50mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '6.0.0', ai: 'Gemini 2.5 Flash + Unreal Speech + Stability AI' });
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

  const geminiKey = process.env.GEMINI_API_KEY;

  try {
    // ── Traduction FR → EN via Gemini ────────────────────
    let englishPrompt = prompt;
    if (geminiKey) {
      const transResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Translate this image generation prompt to English. Return ONLY the translated prompt, nothing else:\n\n${prompt}` }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
          }),
        }
      );
      const transData = await transResp.json();
      const translated = transData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (translated) englishPrompt = translated;
    }

    const formData = new FormData();
    formData.append('prompt', `${englishPrompt}, cinematic, high quality, 4k`);
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

// ── ASSEMBLAGE VIDÉO + UPLOAD YOUTUBE ────────────────────
app.post('/assemble-and-publish', async (req, res) => {
  const { images, audioUrl, script, tags, privacy, ytToken } = req.body;
  if (!images || !images.length) return res.status(400).json({ error: 'images manquantes' });
  if (!audioUrl) return res.status(400).json({ error: 'audioUrl manquant' });
  if (!ytToken)  return res.status(400).json({ error: 'token YouTube manquant' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotube-'));

  try {
    // 1. Sauvegarder les images en fichiers JPEG
    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
      const imgPath = path.join(tmpDir, `img_${i}.jpg`);
      fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
      imagePaths.push(imgPath);
    }

    // 2. Télécharger l'audio
    const audioResp = await fetch(audioUrl);
    const audioBuffer = await audioResp.buffer();
    const audioPath = path.join(tmpDir, 'audio.mp3');
    fs.writeFileSync(audioPath, audioBuffer);

    // 3. Créer un fichier texte listant les images pour ffmpeg (concat)
    const concatPath = path.join(tmpDir, 'concat.txt');
    const audioDuration = await getAudioDuration(audioPath);
    const durationPerImage = audioDuration / imagePaths.length;

    const concatContent = imagePaths.map(p =>
      `file '${p}'\nduration ${durationPerImage.toFixed(3)}`
    ).join('\n') + `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(concatPath, concatContent);

    // 4. Assembler avec ffmpeg
    const videoPath = path.join(tmpDir, 'video.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-pix_fmt yuv420p',
          '-shortest',
          '-movflags +faststart',
          '-vf scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2',
        ])
        .output(videoPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 5. Upload sur YouTube en multipart
    const videoBuffer = fs.readFileSync(videoPath);
    const metadata = {
      snippet: {
        title: script.title,
        description: script.description,
        tags: [...(script.tags || []), ...(tags || [])],
        categoryId: '22',
        defaultLanguage: 'fr',
      },
      status: { privacyStatus: privacy || 'private' },
    };

    // Upload en deux étapes : d'abord les métadonnées, puis le fichier
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metaPart = delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata);
    const videoPart = delimiter +
      'Content-Type: video/mp4\r\n\r\n';

    const body = Buffer.concat([
      Buffer.from(metaPart),
      Buffer.from(videoPart),
      videoBuffer,
      Buffer.from(closeDelimiter),
    ]);

    const ytResp = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ytToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
          'Content-Length': body.length,
        },
        body,
      }
    );

    if (!ytResp.ok) {
      const err = await ytResp.json();
      throw new Error(err.error?.message || ytResp.status);
    }

    const ytData = await ytResp.json();
    res.json({ success: true, youtubeId: ytData.id, title: script.title });

  } catch (err) {
    console.error('Assemble/publish error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Nettoyage des fichiers temporaires
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
});

// ── UTILITAIRE — durée audio ──────────────────────────────
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 60);
    });
  });
}

// ── QUOTA VOIX ───────────────────────────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  res.json({ used: 0, total: 250000 });
});

app.listen(PORT, () => {
  console.log(`AutoTube backend v6 — Gemini + Unreal Speech + Stability AI + ffmpeg`);
});
