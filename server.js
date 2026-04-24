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
  origin: '*',
}));

app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '10.0.0' });
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
- Les prompts d'images doivent être en français, style cinématique vertical

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
    // 1. Télécharger les images
    console.log(`Téléchargement de ${imageUrls.length} images…`);
    const imagePaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      let imgBuffer = null;

      const urlsToTry = [
        imageUrls[i],
        `https://image.pollinations.ai/prompt/${encodeURIComponent('cinematic vertical shot 9:16 high quality')}?width=768&height=1344&nologo=true&seed=${i}`,
        `https://picsum.photos/768/1344?random=${i}`,
      ];

      for (const url of urlsToTry) {
        try {
          console.log(`Image ${i+1} — essai : ${url.slice(0,60)}…`);
          const imgResp = await fetch(url, { timeout: 90000 });
          if (!imgResp.ok) throw new Error(`Status ${imgResp.status}`);
          imgBuffer = await imgResp.buffer();
          if (imgBuffer.length > 1000) break;
        } catch(e) {
          console.log(`Échec : ${e.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!imgBuffer) throw new Error(`Image ${i+1} impossible à télécharger`);

      const imgPath = path.join(tmpDir, `img_${i}.jpg`);
      fs.writeFileSync(imgPath, imgBuffer);
      imagePaths.push(imgPath);
      console.log(`Image ${i+1}/${imageUrls.length} ✓ (${Math.round(imgBuffer.length/1024)}KB)`);
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

    // 4. Assembler ffmpeg
    console.log('Assemblage ffmpeg…');
    const videoPath = path.join(tmpDir, 'video.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-crf 28',
          '-c:a aac',
          '-b:a 128k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-movflags +faststart',
          '-threads 1',
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

// ═══════════════════════════════════════════════════════════
// ── AGENT IA — AUTO-AMÉLIORATION ──────────────────────────
// ═══════════════════════════════════════════════════════════

// Stockage en mémoire des itérations (persiste tant que Render tourne)
const agentHistory = [];

// ── AGENT — Cycle complet d'amélioration ──────────────────
app.post('/agent-run', async (req, res) => {
  const { topic, tags, geminiKey, unrealKey, anthropicKey } = req.body;

  const GEMINI  = geminiKey    || process.env.GEMINI_API_KEY;
  const UNREAL  = unrealKey    || process.env.UNREAL_SPEECH_API_KEY;
  const CLAUDE  = anthropicKey || process.env.ANTHROPIC_API_KEY;

  if (!GEMINI || !UNREAL || !CLAUDE)
    return res.status(400).json({ error: 'Clés API manquantes (Gemini, Unreal Speech, Anthropic)' });

  const iterationId = Date.now();
  const log = [];

  try {
    // PHASE 1 — Récupère le meilleur prompt connu (ou utilise le défaut)
    const lastGood = agentHistory
      .filter(h => h.score >= 7)
      .sort((a, b) => b.score - a.score)[0];

    const basePrompt = lastGood
      ? `Améliore ce prompt qui a obtenu ${lastGood.score}/10 : ${lastGood.narrationPrompt}`
      : null;

    log.push('Phase 1 : récupération du meilleur prompt connu ✓');

    // PHASE 2 — Génère le script via Gemini
    log.push('Phase 2 : génération du script via Gemini…');
    const scriptResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildAgentPrompt(topic, tags, basePrompt) }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
        }),
      }
    );
    const scriptData = await scriptResp.json();
    if (!scriptResp.ok) throw new Error(scriptData.error?.message || 'Erreur Gemini');
    const scriptText = scriptData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const script = JSON.parse(scriptText.replace(/```json|```/g, '').trim());
    log.push('Phase 2 : script généré ✓');

    // PHASE 3 — Génère la voix via Unreal Speech
    log.push('Phase 3 : génération de la voix…');
    const voiceResp = await fetch('https://api.v7.unrealspeech.com/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UNREAL}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Text: script.narration, VoiceId: 'Scarlett',
        Bitrate: '192k', Speed: '0.1', Pitch: '1', OutputFormat: 'uri',
      }),
    });
    if (!voiceResp.ok) throw new Error('Erreur Unreal Speech');
    const voiceData = await voiceResp.json();
    const audioUrl = voiceData.OutputUri;
    log.push('Phase 3 : voix générée ✓');

    // PHASE 4 — Génère les URLs d'images via Pollinations
    log.push('Phase 4 : génération des images…');
    const imageUrls = script.imagePrompts.map((p, i) =>
      `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=768&height=1344&nologo=true&seed=${iterationId + i}`
    );
    log.push('Phase 4 : URLs images générées ✓');

    // PHASE 5 — Télécharge la première image pour analyse visuelle
    log.push('Phase 5 : téléchargement de la frame pour analyse…');
    let frameBase64 = null;
    try {
      const frameResp = await fetch(imageUrls[0], { timeout: 60000 });
      if (frameResp.ok) {
        const frameBuffer = await frameResp.buffer();
        frameBase64 = frameBuffer.toString('base64');
        log.push('Phase 5 : frame extraite ✓');
      } else {
        log.push('Phase 5 : frame indisponible, analyse texte seule');
      }
    } catch (e) {
      log.push(`Phase 5 : erreur frame (${e.message}), analyse texte seule`);
    }

    // PHASE 6 — Analyse Claude Vision (avec ou sans image)
    log.push('Phase 6 : analyse Claude Vision…');
    const claudeContent = [];

    if (frameBase64) {
      claudeContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 },
      });
    }

    claudeContent.push({
      type: 'text',
      text: `Tu es un expert YouTube Shorts. ${frameBase64 ? 'Analyse cette image et le script ci-dessous.' : 'Analyse ce script pour YouTube Shorts.'}

Script : "${script.narration}"
Titre : "${script.title}"
Prompts images : ${script.imagePrompts.join(' | ')}

Note sur 10 selon ces critères YouTube Shorts.
Réponds UNIQUEMENT en JSON valide :
{
  "score": 7,
  "criteres": {
    "composition_verticale": 8,
    "qualite_visuelle": 7,
    "impact_visuel": 6,
    "lisibilite_mobile": 8,
    "coherence_yt": 7
  },
  "points_forts": ["point 1", "point 2"],
  "ameliorations": ["amélioration 1", "amélioration 2"],
  "prompt_ameliore": "nouveau prompt image amélioré pour YouTube Shorts vertical cinématique"
}`,
    });

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: claudeContent }],
      }),
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) throw new Error(claudeData.error?.message || 'Erreur Claude API');
    const analysisText = claudeData.content?.[0]?.text || '{}';
    const analysis = JSON.parse(analysisText.replace(/```json|```/g, '').trim());
    log.push(`Phase 6 : analyse terminée — score ${analysis.score}/10 ✓`);

    // PHASE 7 — Sauvegarde dans l'historique
    const iteration = {
      id: iterationId,
      date: new Date().toISOString(),
      topic,
      tags,
      script,
      audioUrl,
      imageUrls,
      analysis,
      score: analysis.score,
      narrationPrompt: script.narration,
      log,
      status: 'pending', // 'pending' | 'validated' | 'rejected'
    };

    agentHistory.unshift(iteration);
    if (agentHistory.length > 20) agentHistory.pop(); // garde les 20 dernières

    log.push('Phase 7 : itération sauvegardée ✓');
    console.log(`Agent cycle terminé — itération ${iterationId} — score ${analysis.score}/10`);

    res.json({ success: true, iteration });

  } catch (err) {
    console.error('Agent error:', err.message);
    res.status(500).json({ error: err.message, log });
  }
});

// ── AGENT — Historique des itérations ────────────────────
app.get('/agent-history', (req, res) => {
  res.json({ iterations: agentHistory, total: agentHistory.length });
});

// ── AGENT — Valider ou rejeter une itération ──────────────
app.post('/agent-validate', (req, res) => {
  const { id, action } = req.body; // action: 'validate' | 'reject'
  const iter = agentHistory.find(h => h.id === id);
  if (!iter) return res.status(404).json({ error: 'Itération non trouvée' });
  iter.status = action === 'validate' ? 'validated' : 'rejected';
  console.log(`Itération ${id} → ${iter.status}`);
  res.json({ success: true, iteration: iter });
});

// ── UTILITAIRE — Construit le prompt agent amélioré ───────
function buildAgentPrompt(topic, tags, basePrompt) {
  const amelioration = basePrompt
    ? `\nUTILISE ce prompt de base et améliore-le : "${basePrompt}"\n`
    : '';

  return `Tu es un expert YouTube Shorts viral francophone.${amelioration}
Génère un script optimisé pour YouTube Shorts sur : "${topic}"
Tags : ${(tags || []).join(', ')}

RÈGLES ABSOLUES YouTube Shorts :
- Narration 60-75 mots MAX (25-30 secondes de voix off)
- Accroche percutante dans les 3 premières secondes
- Ton ultra dynamique, direct, engageant
- Call-to-action court en fin ("Abonne-toi", "Commente", "Partage")
- 4 prompts images verticaux 9:16, style cinématique ultra qualitatif
- Première image = impact maximum (effet thumbnail)
- Optimisé pour les standards YouTube Shorts 2024

Réponds UNIQUEMENT en JSON valide :
{
  "title": "Titre accrocheur #Shorts (max 60 chars)",
  "description": "Description avec hashtags #Shorts #tag (max 200 chars)",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "Script 60-75 mots, accroche + corps + CTA",
  "imagePrompts": ["prompt1 9:16 cinematic vertical", "prompt2", "prompt3", "prompt4"],
  "thumbnailPrompt": "prompt thumbnail vertical ultra impactant"
}`;
}

// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`AutoTube backend v10 — Agent IA activé — port ${PORT}`);
});
