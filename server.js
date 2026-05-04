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

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '11.0.0' });
});

// ── GEMINI — Génération de script SHORTS ─────────────────
app.post('/generate-script', async (req, res) => {
  const { topic, tags, duration, apiKey } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'Clé Gemini manquante' });

  const prompt = `Tu es un expert en création de contenu YouTube Shorts francophone viral.
Génère un script pour un YouTube Short sur : "${topic}"
Niche / Tags : ${(tags||[]).join(', ')}

RÈGLES ABSOLUES :
- La narration doit faire EXACTEMENT 40 à 50 mots (= 15-18 secondes de voix off)
- Structurée en 4 blocs de 10-12 mots chacun, un bloc par image
- Bloc 1 : accroche choc obligatoire ("Tu savais que...", "C'est interdit de...", "Personne ne parle de...")
- Bloc 2 : développement surprenant
- Bloc 3 : fait clé ou twist inattendu
- Bloc 4 : phrase de chute mémorable, max 8 mots, pas de CTA générique
- Ton direct, rythmé, chaque phrase doit donner envie d'entendre la suivante
- JAMAIS de "Abonne-toi" ou "Commente" dans la narration

IMAGES :
- 4 prompts en anglais, style identique sur les 4 pour cohérence visuelle
- Format vertical 9:16, ultra-réaliste ou illustratif selon le sujet
- Chaque prompt commence par "Vertical 9:16, [style défini], " puis la scène précise
- Le style doit être défini une fois et répété : ex. "dramatic cinematic photography" ou "vintage editorial illustration"
- Scène précise, pas abstraite : un lieu, un personnage, une action, une lumière

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après :
{
  "title": "Titre 40 chars max, sans hashtag",
  "description": "2 phrases max + hashtags #Shorts #[niche]",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "40-50 mots, 4 blocs séparés par | pour synchronisation",
  "imagePrompts": ["prompt 1", "prompt 2", "prompt 3", "prompt 4"],
  "thumbnailPrompt": "Vertical 9:16, même style que les images, scène la plus impactante du sujet, texte overlay suggestion"
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

    res.json({
      script,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
    });

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

// ── ASSEMBLAGE VIDÉO + UPLOAD YOUTUBE — v2 (Ken Burns + Sous-titres) ─────────
app.post('/assemble-and-publish', async (req, res) => {
  const { imageUrls, audioUrl, script, tags, ytToken } = req.body;
  if (!imageUrls || !imageUrls.length) return res.status(400).json({ error: 'imageUrls manquantes' });
  if (!audioUrl) return res.status(400).json({ error: 'audioUrl manquant' });
  if (!ytToken)  return res.status(400).json({ error: 'token YouTube manquant' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotube-'));

  try {
    // 1. Télécharger les images avec fallback
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
          console.log(`Image ${i+1} — essai : ${url.slice(0, 60)}…`);
          const imgResp = await fetch(url, { timeout: 90000 });
          if (!imgResp.ok) throw new Error(`Status ${imgResp.status}`);
          imgBuffer = await imgResp.buffer();
          if (imgBuffer.length > 1000) break;
        } catch (e) {
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

    // 4. Générer les clips individuels avec effet Ken Burns
    console.log('Génération Ken Burns par image…');
    const clipPaths = [];
    const fps = 24;

    // Directions Ken Burns alternées pour éviter la monotonie
    const kenBurnsEffects = [
      // Zoom avant centré
      (frames) => `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=${fps}`,
      // Panoramique gauche → droite + léger zoom
      (frames) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,x+1)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=${fps}`,
      // Zoom arrière depuis le haut
      (frames) => `zoompan=z='if(lte(zoom,1.0),1.3,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='0':d=${frames}:s=720x1280:fps=${fps}`,
      // Panoramique droite → gauche
      (frames) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,max(x-1,0))':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=${fps}`,
    ];

    for (let i = 0; i < imagePaths.length; i++) {
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      const frames = Math.ceil(durationPerImage * fps);
      const zoomFilter = kenBurnsEffects[i % kenBurnsEffects.length](frames);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imagePaths[i])
          .inputOptions(['-loop 1'])
          .outputOptions([
            `-t ${durationPerImage.toFixed(3)}`,
            '-c:v libx264',
            '-preset ultrafast',
            '-crf 26',
            '-pix_fmt yuv420p',
            `-r ${fps}`,
            `-vf ${zoomFilter},setsar=1`,
            '-threads 1',
            '-an',
          ])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      clipPaths.push(clipPath);
      console.log(`Clip ${i+1}/${imagePaths.length} Ken Burns ✓`);
    }

    // 5. Concaténer les clips Ken Burns
    console.log('Concaténation des clips…');
    const concatPath = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatPath, clipPaths.map(p => `file '${p}'`).join('\n'));
    const concatVideoPath = path.join(tmpDir, 'concat_video.mp4');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-crf 26',
          '-pix_fmt yuv420p',
          '-an',
          '-threads 1',
        ])
        .output(concatVideoPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 6. Générer le fichier SRT de sous-titres
    // La narration est séparée par "|" (ex: "Bloc 1 | Bloc 2 | Bloc 3 | Bloc 4")
    console.log('Génération des sous-titres…');
    const srtPath = path.join(tmpDir, 'subtitles.srt');
    const narration = script.narration || '';
    const blocks = narration.split('|').map(b => b.trim()).filter(Boolean);

    // Fallback : découper en 4 parts égales si pas de séparateur |
    const subtitleBlocks = blocks.length >= 2 ? blocks : splitIntoChunks(narration, imagePaths.length);

    let srtContent = '';
    let currentTime = 0;
    subtitleBlocks.forEach((block, i) => {
      const startTime = formatSRTTime(currentTime);
      const endTime = formatSRTTime(currentTime + durationPerImage - 0.1);
      srtContent += `${i + 1}\n${startTime} --> ${endTime}\n${block}\n\n`;
      currentTime += durationPerImage;
    });
    fs.writeFileSync(srtPath, srtContent);

    // 7. Assemblage final : vidéo Ken Burns + audio + sous-titres brûlés
    console.log('Assemblage final avec sous-titres…');
    const videoPath = path.join(tmpDir, 'video.mp4');

    // Style sous-titres : blanc, contour noir, centré bas, lisible mobile
    const subtitleStyle = [
      'FontName=Arial',
      'FontSize=18',
      'PrimaryColour=&H00FFFFFF',
      'OutlineColour=&H00000000',
      'BackColour=&H80000000',
      'Bold=1',
      'Outline=2',
      'Shadow=1',
      'Alignment=2',
      'MarginV=60',
    ].join(',');

    // Échapper le chemin SRT pour ffmpeg (espaces et caractères spéciaux)
    const srtPathEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatVideoPath)
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
          `-vf subtitles=${srtPathEscaped}:force_style='${subtitleStyle}'`,
        ])
        .output(videoPath)
        .on('start', () => console.log('ffmpeg final start'))
        .on('progress', (p) => console.log('ffmpeg:', p.percent?.toFixed(0) + '%'))
        .on('end', () => { console.log('ffmpeg final terminé'); resolve(); })
        .on('error', (err) => { console.error('ffmpeg error:', err.message); reject(err); })
        .run();
    });

    const videoSize = fs.statSync(videoPath).size;
    console.log(`Vidéo assemblée (${Math.round(videoSize/1024)}KB)`);

    // 8. Upload YouTube PUBLIC
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

// ── UTILITAIRES ───────────────────────────────────────────

function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 30);
    });
  });
}

// Formater en SRT : HH:MM:SS,mmm
function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// Découper un texte en N morceaux équilibrés
function splitIntoChunks(text, n) {
  const words = text.split(' ');
  const chunkSize = Math.ceil(words.length / n);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(words.slice(i * chunkSize, (i + 1) * chunkSize).join(' '));
  }
  return chunks.filter(Boolean);
}

// ── AGENT IA — Cycle complet d'amélioration ──────────────
const agentHistory = [];

app.post('/agent-run', async (req, res) => {
  const { topic, tags, geminiKey, unrealKey, anthropicKey } = req.body;

  const GEMINI = geminiKey    || process.env.GEMINI_API_KEY;
  const UNREAL = unrealKey    || process.env.UNREAL_SPEECH_API_KEY;
  const CLAUDE = anthropicKey || process.env.ANTHROPIC_API_KEY;

  if (!GEMINI || !UNREAL || !CLAUDE)
    return res.status(400).json({ error: 'Clés API manquantes (Gemini, Unreal Speech, Anthropic)' });

  const iterationId = Date.now();
  const log = [];

  try {
    // Phase 1 — Meilleur prompt connu
    const lastGood = agentHistory
      .filter(h => h.score >= 7)
      .sort((a, b) => b.score - a.score)[0];

    const basePrompt = lastGood
      ? `Améliore ce prompt qui a obtenu ${lastGood.score}/10 : ${lastGood.narrationPrompt}`
      : null;

    log.push('Phase 1 : récupération du meilleur prompt ✓');

    // Phase 2 — Script via Gemini
    log.push('Phase 2 : génération du script…');
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
    if (script.imagePrompts && script.imagePrompts.length > 4) script.imagePrompts = script.imagePrompts.slice(0, 4);
    log.push('Phase 2 : script généré ✓');

    // Phase 3 — Voix via Unreal Speech
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

    // Phase 4 — URLs images Pollinations
    log.push('Phase 4 : génération des URLs images…');
    const imageUrls = script.imagePrompts.map((p, i) =>
      `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=768&height=1344&nologo=true&seed=${iterationId + i}`
    );
    log.push('Phase 4 : URLs images générées ✓');

    // Phase 5 — Télécharge la première image pour analyse
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

    // Phase 6 — Analyse Claude
    log.push('Phase 6 : analyse qualité via Claude…');
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

Note sur 10 selon les critères YouTube Shorts.
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: claudeContent }],
      }),
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) throw new Error(claudeData.error?.message || 'Erreur Claude API');

    const analysisText = claudeData.content?.[0]?.text || '{}';
    const analysis = JSON.parse(analysisText.replace(/```json|```/g, '').trim());
    log.push(`Phase 6 : analyse terminée — score ${analysis.score}/10 ✓`);

    // Phase 7 — Sauvegarde
    const iteration = {
      id: iterationId,
      date: new Date().toISOString(),
      topic, tags, script, audioUrl, imageUrls, analysis,
      score: analysis.score,
      narrationPrompt: script.narration,
      log,
      status: 'pending',
    };

    agentHistory.unshift(iteration);
    if (agentHistory.length > 20) agentHistory.pop();
    log.push('Phase 7 : itération sauvegardée ✓');

    console.log(`Agent cycle terminé — score ${analysis.score}/10`);
    res.json({ success: true, iteration });

  } catch (err) {
    console.error('Agent error:', err.message);
    res.status(500).json({ error: err.message, log });
  }
});

// ── AGENT — Historique ────────────────────────────────────
app.get('/agent-history', (req, res) => {
  res.json({ iterations: agentHistory, total: agentHistory.length });
});

// ── AGENT — Valider/Rejeter ───────────────────────────────
app.post('/agent-validate', (req, res) => {
  const { id, action } = req.body;
  const iter = agentHistory.find(h => h.id === id);
  if (!iter) return res.status(404).json({ error: 'Itération non trouvée' });
  iter.status = action === 'validate' ? 'validated' : 'rejected';
  res.json({ success: true, iteration: iter });
});

// ── UTILITAIRE — Prompt agent ─────────────────────────────
function buildAgentPrompt(topic, tags, basePrompt) {
  const amelioration = basePrompt
    ? `\nUTILISE ce prompt de base et améliore-le : "${basePrompt}"\n`
    : '';

  return `Tu es un expert YouTube Shorts viral francophone.${amelioration}
Génère un script optimisé pour YouTube Shorts sur : "${topic}"
Tags : ${(tags || []).join(', ')}

RÈGLES ABSOLUES :
- Narration 40-50 mots MAX (15-18 secondes), 4 blocs séparés par |
- Accroche percutante dans les 3 premières secondes
- Ton ultra dynamique, direct, engageant
- Pas de CTA générique en fin
- 4 prompts images verticaux 9:16, style identique et cohérent

Réponds UNIQUEMENT en JSON valide :
{
  "title": "Titre 40 chars max, sans hashtag",
  "description": "2 phrases max + hashtags #Shorts (max 200 chars)",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "40-50 mots, 4 blocs séparés par |",
  "imagePrompts": ["Vertical 9:16, [style], scène 1", "Vertical 9:16, [style], scène 2", "Vertical 9:16, [style], scène 3", "Vertical 9:16, [style], scène 4"],
  "thumbnailPrompt": "Vertical 9:16, même style, scène la plus impactante"
}`;
}

// ── QUOTA ────────────────────────────────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  res.json({ used: 0, total: 250000 });
});

app.listen(PORT, () => {
  console.log(`AutoTube backend v11 — Ken Burns + Sous-titres activés — port ${PORT}`);
});
