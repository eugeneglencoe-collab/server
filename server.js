const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: '*', // Autorise tout — évite les erreurs CORS même en cas de crash
}));

app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '9.0.0' });
});

// ── GEMINI — Génération de script SHORTS ─────────────────
app.post('/generate-script', async (req, res) => {
  const { topic, tags, duration, apiKey } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'Clé Gemini manquante' });

  const prompt = `Tu es un expert en création de contenu YouTube Shorts francophone.

Génère un script pour un YouTube SHORT viral sur : "${topic}"
Niche / Tags : ${(tags||[]).join(', ')}

RÈGLES ABSOLUES :
- La narration doit faire EXACTEMENT 60 à 75 mots maximum (= 25-30 secondes de voix off)
- Commence par une accroche choc dans les 3 premières secondes ("Tu savais que...", "Le secret de...", "Arrête tout...")
- Ton dynamique, direct, percutant
- Termine par un call-to-action court ("Abonne-toi", "Commente", "Partage")
- Format vertical 9:16 pensé pour mobile
- Génère UNIQUEMENT 4 prompts d'images (une par 7-8 secondes)
- Les prompts d'images doivent être en anglais, style cinématique vertical

Réponds UNIQUEMENT en JSON valide avec cette structure exacte, sans aucun texte avant ou après :
{
  "title": "Titre accrocheur avec #Shorts (max 60 chars)",
  "description": "Description courte avec hashtags #Shorts #[niche] (max 200 chars)",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "Script de narration 60-75 mots maximum, accrocheur et dynamique",
  "imagePrompts": ["vertical 9:16 cinematic prompt 1", "vertical 9:16 cinematic prompt 2", "vertical 9:16 cinematic prompt 3", "vertical 9:16 cinematic prompt 4"],
  "thumbnailPrompt": "Vertical thumbnail prompt ultra eye-catching for YouTube Shorts"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 4096 },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Erreur Gemini' });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const script = JSON.parse(clean);

    if (script.imagePrompts && script.imagePrompts.length > 4) {
      script.imagePrompts = script.imagePrompts.slice(0, 4);
    }

    res.json({ script, usage: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: data.usageMetadata?.candidatesTokenCount || 0 } });

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
      headers: { 'Authorization': `Bearer ${unrealKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Text: text, VoiceId: voice, Bitrate: '192k',
        Speed: '0.1', Pitch: '1', OutputFormat: 'uri',
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

// ── ASSEMBLAGE VIDÉO + UPLOAD YOUTUBE ────────────────────
app.post('/assemble-and-publish', async (req, res) => {
  const { imageUrls, audioUrl, script, tags, ytToken } = req.body;
  if (!imageUrls || !imageUrls.length) return res.status(400).json({ error: 'imageUrls manquantes' });
  if (!audioUrl) return res.status(400).json({ error: 'audioUrl manquant' });
  if (!ytToken)  return res.status(400).json({ error: 'token YouTube manquant' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotube-'));

  try {
    // 1. Télécharger les images depuis Pollinations
    console.log(`Téléchargement de ${imageUrls.length} images…`);
    const imagePaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imgResp = await fetch(imageUrls[i], { timeout: 30000 });
      if (!imgResp.ok) throw new Error(`Image ${i+1} inaccessible : ${imgResp.status}`);
      const imgBuffer = await imgResp.buffer();
      const imgPath = path.join(tmpDir, `img_${i}.jpg`);
      fs.writeFileSync(imgPath, imgBuffer);
      imagePaths.push(imgPath);
      console.log(`Image ${i+1}/${imageUrls.length} téléchargée (${Math.round(imgBuffer.length/1024)}KB)`);
    }

    // 2. Télécharger l'audio
    console.log('Téléchargement audio…');
    const audioResp = await fetch(audioUrl, { timeout: 30000 });
    if (!audioResp.ok) throw new Error(`Audio inaccessible : ${audioResp.status}`);
    const audioBuffer = await audioResp.buffer();
    const audioPath = path.join(tmpDir, 'audio.mp3');
    fs.writeFileSync(audioPath, audioBuffer);
    console.log(`Audio téléchargé (${Math.round(audioBuffer.length/1024)}KB)`);

    // 3. Durée audio → durée par image
    const audioDuration = await getAudioDuration(audioPath);
    console.log(`Durée audio : ${audioDuration.toFixed(1)}s`);
    const durationPerImage = audioDuration / imagePaths.length;

    const concatPath = path.join(tmpDir, 'concat.txt');
    const concatContent = imagePaths.map(p =>
      `file '${p}'\nduration ${durationPerImage.toFixed(3)}`
    ).join('\n') + `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(concatPath, concatContent);

    // 4. Assembler ffmpeg — optimisé pour 512MB RAM
    console.log('Assemblage ffmpeg…');
    const videoPath = path.join(tmpDir, 'video.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',   // ← Moins de RAM, plus rapide
          '-crf 28',             // ← Qualité légèrement réduite pour économiser RAM
          '-c:a aac',
          '-b:a 128k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-movflags +faststart',
          '-threads 1',          // ← 1 seul thread pour limiter la RAM
          // Format vertical 720x1280 au lieu de 1080x1920 (4x moins de RAM)
          '-vf scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1',
        ])
        .output(videoPath)
        .on('start', (cmd) => console.log('ffmpeg cmd:', cmd))
        .on('progress', (p) => console.log('ffmpeg progress:', p.percent?.toFixed(0)+'%'))
        .on('end', () => { console.log('ffmpeg terminé'); resolve(); })
        .on('error', (err) => { console.error('ffmpeg error:', err.message); reject(err); })
        .run();
    });

    const videoSize = fs.statSync(videoPath).size;
    console.log(`Vidéo assemblée (${Math.round(videoSize/1024)}KB)`);

    // 5. Upload YouTube PUBLIC
    console.log('Upload YouTube…');
    const videoBuffer = fs.readFileSync(videoPath);
    const metadata = {
      snippet: {
        title: script.title,
        description: (script.description || '') + '\n\n#Shorts',
        tags: ['Shorts', ...(script.tags || []), ...(tags || [])],
        categoryId: '22',
        defaultLanguage: 'fr',
      },
      status: {
        privacyStatus: 'public',
        madeForKids: false,
      },
    };

    const boundary = '-------314159265358979323846';
    const body = Buffer.concat([
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(metadata)),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
      videoBuffer,
      Buffer.from(`\r\n--${boundary}--`),
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
    console.log('✓ Publié :', ytData.id);
    res.json({ success: true, youtubeId: ytData.id, title: script.title });

  } catch (err) {
    console.error('Assemble/publish error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
});

// ── UTILITAIRE — durée audio ──────────────────────────────
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 30);
    });
  });
}

// ── QUOTA ────────────────────────────────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  res.json({ used: 0, total: 250000 });
});

app.listen(PORT, () => {
  console.log(`AutoTube backend v9 — optimisé 512MB RAM`);
});
