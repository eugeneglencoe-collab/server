const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AutoTube backend running ✓', version: '13.0.0' });
});

// ── REDDIT — Récupération d'images par sujet ─────────────
const SUBREDDIT_MAP = {
  histoire:    ['HistoryPorn', 'ColorizedHistory', 'Damnthatsinteresting', 'OldSchoolCool'],
  science:     ['Damnthatsinteresting', 'interestingasfuck', 'educationalgifs', 'science'],
  nature:      ['EarthPorn', 'NaturePorn', 'pics', 'wildlife'],
  espace:      ['spaceporn', 'Astronomy', 'space', 'astrophotography'],
  animaux:     ['aww', 'AnimalsBeingBros', 'NatureIsFuckingLit', 'wildlife'],
  technologie: ['Damnthatsinteresting', 'interestingasfuck', 'technology', 'Futurology'],
  sport:       ['sports', 'Damnthatsinteresting', 'interestingasfuck'],
  cuisine:     ['FoodPorn', 'food', 'recipes', 'GifRecipes'],
  voyage:      ['travel', 'CityPorn', 'EarthPorn', 'pics'],
  default:     ['Damnthatsinteresting', 'interestingasfuck', 'pics', 'HistoryPorn'],
};

function getSubredditsForTopic(topic) {
  const t = topic.toLowerCase();
  for (const [key, subs] of Object.entries(SUBREDDIT_MAP)) {
    if (t.includes(key)) return subs;
  }
  return SUBREDDIT_MAP.default;
}

async function fetchRedditImages(topic, count = 4) {
  const subreddits = getSubredditsForTopic(topic);
  const imageUrls  = [];
  const usedUrls   = new Set();
  const searchQuery = encodeURIComponent(topic.split(' ').slice(0, 3).join(' '));

  for (const subreddit of subreddits) {
    if (imageUrls.length >= count) break;
    try {
      const redditUrl = `https://www.reddit.com/r/${subreddit}/search.json?q=${searchQuery}&restrict_sr=1&sort=top&t=year&limit=25`;
      const resp = await fetch(redditUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'AutoTube/1.0 (content creator bot)', 'Accept': 'application/json' },
      });
      if (!resp.ok) continue;

      const data  = await resp.json();
      const posts = data?.data?.children || [];

      for (const post of posts) {
        if (imageUrls.length >= count) break;
        const p = post.data;
        if (p.over_18) continue;
        if (usedUrls.has(p.url)) continue;

        const isImage = /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(p.url);
        let imgUrl = null;
        if (isImage) {
          imgUrl = p.url;
        } else if (p.preview?.images?.[0]?.source?.url) {
          imgUrl = p.preview.images[0].source.url.replace(/&amp;/g, '&');
        }
        if (!imgUrl) continue;

        try {
          const check = await fetch(imgUrl, { method: 'HEAD', timeout: 8000 });
          if (!check.ok) continue;
        } catch { continue; }

        imageUrls.push(imgUrl);
        usedUrls.add(imgUrl);
        console.log(`Reddit image ${imageUrls.length}/${count} — r/${subreddit}`);
      }
    } catch (e) {
      console.log(`Reddit r/${subreddit} — erreur : ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Fallback Picsum
  while (imageUrls.length < count) {
    imageUrls.push(`https://picsum.photos/seed/${Date.now() + imageUrls.length}/768/1344`);
    console.log(`Fallback Picsum pour image ${imageUrls.length}`);
  }

  return imageUrls.slice(0, count);
}

app.post('/fetch-reddit-images', async (req, res) => {
  const { topic, count } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });
  try {
    const imageUrls = await fetchRedditImages(topic, count || 4);
    res.json({ imageUrls });
  } catch (err) {
    console.error('Reddit fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GEMINI — Génération de script SHORTS ─────────────────
app.post('/generate-script', async (req, res) => {
  const { topic, tags, duration, apiKey } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'Clé Gemini manquante' });

  const prompt = `Tu es un expert en création de contenu YouTube Shorts francophone viral, spécialisé dans la maximisation de la rétention d'audience.

Génère un script pour un YouTube Short sur : "${topic}"
Niche / Tags : ${(tags||[]).join(', ')}

RÉTENTION — RÈGLES CRITIQUES :
- La première phrase doit créer une TENSION IMMÉDIATE — une promesse, un mystère, une contradiction choquante
- Chaque bloc doit se terminer sur une micro-tension qui force à rester
- Rythme haché : phrases courtes, maximum 8 mots par phrase, jamais deux longues à la suite
- Vocabulaire 100% français de France métropolitaine : "vachement", "carrément", "c'est dingue", "franchement" — JAMAIS de québécismes
- Zéro mot de remplissage : chaque mot doit justifier sa présence
- Construire vers un twist ou révélation finale surprenante

NARRATION :
- EXACTEMENT 40 à 50 mots
- 4 blocs séparés par | , un bloc par image, 10-12 mots par bloc
- Bloc 1 : accroche choc — fait contre-intuitif ou question rhétorique percutante
- Bloc 2 : développement qui creuse la tension, révèle quelque chose d'inattendu
- Bloc 3 : twist ou fait clé qui renverse ce qu'on croyait savoir
- Bloc 4 : chute mémorable, percutante, max 8 mots — laisse une impression durable
- JAMAIS "Abonne-toi", "Commente", "Partage"

MOTS-CLÉS REDDIT :
- Génère 4 requêtes de recherche en anglais pour trouver des images Reddit en lien avec chaque bloc
- Chaque requête = 2-3 mots précis qui décrivent visuellement le contenu du bloc

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après :
{
  "title": "Titre 40 chars max, accrocheur, crée de la curiosité, sans hashtag",
  "description": "2 phrases percutantes + hashtags #Shorts #[niche]",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "40-50 mots, 4 blocs séparés par | , rythme haché, vocabulaire français de France",
  "imageSearchQueries": ["query bloc 1 en anglais", "query bloc 2", "query bloc 3", "query bloc 4"],
  "thumbnailPrompt": "description visuelle de la scène la plus impactante pour la miniature"
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

    const text   = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean  = text.replace(/```json|```/g, '').trim();
    const script = JSON.parse(clean);

    res.json({
      script,
      usage: {
        input_tokens:  data.usageMetadata?.promptTokenCount     || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
    });
  } catch (err) {
    console.error('Gemini error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── EDGE-TTS — Synthèse vocale (accent français natif) ───
// Voix disponibles FR : fr-FR-HenriNeural (H), fr-FR-DeniseNeural (F)
// fr-FR-HenriNeural = voix masculine française naturelle, ton posé et clair
// fr-FR-DeniseNeural = voix féminine française naturelle, ton vif

const VOICE_MAP = {
  'Masculin (Henri)':  'fr-FR-HenriNeural',
  'Féminin (Denise)':  'fr-FR-DeniseNeural',
  'Masculin (Remy)':   'fr-FR-RemyMultilingualNeural',
  // Fallbacks anciens noms au cas où le frontend envoie encore les anciens
  'Neutre (Adam)':     'fr-FR-HenriNeural',
  'Dynamique (Josh)':  'fr-FR-HenriNeural',
  'Calme (Rachel)':    'fr-FR-DeniseNeural',
};

function generateVoiceEdgeTTS(text, voice, outputPath) {
  return new Promise((resolve, reject) => {
    // edge-tts est installé comme module Python via pip (disponible sur Render)
    // Commande : edge-tts --voice <voice> --text "<text>" --write-media <output>
    const args = [
      '-m', 'edge_tts',
      '--voice', voice,
      '--rate', '+15%',   // +15% = plus dynamique, plus vif
      '--pitch', '+5Hz',  // légèrement plus haut = voix plus présente
      '--text', text,
      '--write-media', outputPath,
    ];

    execFile('python3', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('edge-tts error:', stderr || err.message);
        reject(new Error(`edge-tts : ${stderr || err.message}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

app.post('/generate-voice', async (req, res) => {
  const { text, voiceId } = req.body;
  if (!text) return res.status(400).json({ error: 'text manquant' });

  const voice   = VOICE_MAP[voiceId] || 'fr-FR-HenriNeural';
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'edgetts-'));
  const outPath = path.join(tmpDir, 'voice.mp3');

  try {
    await generateVoiceEdgeTTS(text, voice, outPath);

    // Lire le fichier et le renvoyer en base64 — le frontend le passera au backend /assemble-and-publish
    const audioBuffer = fs.readFileSync(outPath);
    const audioBase64 = audioBuffer.toString('base64');

    res.json({
      audioBase64,
      mimeType: 'audio/mpeg',
      // On renvoie aussi une data URL utilisable directement si besoin
      audioDataUrl: `data:audio/mpeg;base64,${audioBase64}`,
    });
  } catch (err) {
    console.error('generate-voice error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
});

// ── ASSEMBLAGE VIDÉO + UPLOAD YOUTUBE ────────────────────
// audioUrl peut être une URL HTTP ou une data URL base64
app.post('/assemble-and-publish', async (req, res) => {
  const { imageUrls, audioUrl, audioBase64, script, tags, ytToken } = req.body;
  if (!imageUrls || !imageUrls.length) return res.status(400).json({ error: 'imageUrls manquantes' });
  if (!audioUrl && !audioBase64)       return res.status(400).json({ error: 'audio manquant' });
  if (!ytToken)                        return res.status(400).json({ error: 'token YouTube manquant' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotube-'));

  try {
    // 1. Télécharger et recadrer les images en 9:16
    console.log(`Téléchargement de ${imageUrls.length} images…`);
    const imagePaths = [];

    for (let i = 0; i < imageUrls.length; i++) {
      let imgBuffer = null;
      const urlsToTry = [
        imageUrls[i],
        `https://picsum.photos/seed/${Date.now() + i}/768/1344`,
      ];

      for (const url of urlsToTry) {
        try {
          const imgResp = await fetch(url, { timeout: 30000, headers: { 'User-Agent': 'AutoTube/1.0' } });
          if (!imgResp.ok) throw new Error(`Status ${imgResp.status}`);
          imgBuffer = await imgResp.buffer();
          if (imgBuffer.length > 5000) break;
        } catch (e) {
          console.log(`Image ${i+1} échec : ${e.message}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!imgBuffer) throw new Error(`Image ${i+1} impossible à télécharger`);

      const rawPath = path.join(tmpDir, `raw_${i}.jpg`);
      const imgPath = path.join(tmpDir, `img_${i}.jpg`);
      fs.writeFileSync(rawPath, imgBuffer);

      // Recadrage intelligent 9:16
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(rawPath)
          .outputOptions([
            '-vf scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1',
            '-q:v 2',
          ])
          .output(imgPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      imagePaths.push(imgPath);
      console.log(`Image ${i+1}/${imageUrls.length} ✓ recadrée 9:16`);
    }

    // 2. Préparer l'audio (URL HTTP ou base64)
    console.log('Préparation audio…');
    const audioPath = path.join(tmpDir, 'audio.mp3');

    if (audioBase64) {
      // Audio généré par edge-tts, transmis en base64
      fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
      console.log('Audio base64 écrit ✓');
    } else {
      // URL HTTP distante (compatibilité legacy)
      const audioResp = await fetch(audioUrl, { timeout: 30000 });
      if (!audioResp.ok) throw new Error(`Audio inaccessible : ${audioResp.status}`);
      fs.writeFileSync(audioPath, await audioResp.buffer());
      console.log('Audio URL téléchargé ✓');
    }

    // 3. Durée audio → durée par image
    const audioDuration   = await getAudioDuration(audioPath);
    const durationPerImage = audioDuration / imagePaths.length;
    console.log(`Durée audio : ${audioDuration.toFixed(1)}s → ${durationPerImage.toFixed(2)}s/image`);

    // 4. Clips Ken Burns
    console.log('Génération Ken Burns…');
    const clipPaths = [];
    const fps = 24;

    const kenBurnsEffects = [
      (f) => `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
      (f) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,x+1)':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
      (f) => `zoompan=z='if(lte(zoom,1.0),1.3,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='0':d=${f}:s=720x1280:fps=${fps}`,
      (f) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,max(x-1,0))':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
    ];

    for (let i = 0; i < imagePaths.length; i++) {
      const clipPath  = path.join(tmpDir, `clip_${i}.mp4`);
      const frames    = Math.ceil(durationPerImage * fps);
      const zoomFilter = kenBurnsEffects[i % kenBurnsEffects.length](frames);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imagePaths[i])
          .inputOptions(['-loop 1'])
          .outputOptions([
            `-t ${durationPerImage.toFixed(3)}`,
            '-c:v libx264', '-preset ultrafast', '-crf 26',
            '-pix_fmt yuv420p', `-r ${fps}`,
            `-vf ${zoomFilter},setsar=1`,
            '-threads 1', '-an',
          ])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      clipPaths.push(clipPath);
      console.log(`Clip ${i+1}/${imagePaths.length} Ken Burns ✓`);
    }

    // 5. Concaténation des clips
    console.log('Concaténation…');
    const concatPath      = path.join(tmpDir, 'concat.txt');
    const concatVideoPath = path.join(tmpDir, 'concat_video.mp4');
    fs.writeFileSync(concatPath, clipPaths.map(p => `file '${p}'`).join('\n'));

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c:v libx264', '-preset ultrafast', '-crf 26', '-pix_fmt yuv420p', '-an', '-threads 1'])
        .output(concatVideoPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 6. Sous-titres SRT
    console.log('Génération SRT…');
    const srtPath = path.join(tmpDir, 'subtitles.srt');
    const narration = script.narration || '';
    const blocks    = narration.split('|').map(b => b.trim()).filter(Boolean);
    const subtitleBlocks = blocks.length >= 2 ? blocks : splitIntoChunks(narration, imagePaths.length);

    let srtContent = '';
    let currentTime = 0;
    subtitleBlocks.forEach((block, i) => {
      srtContent += `${i + 1}\n${formatSRTTime(currentTime)} --> ${formatSRTTime(currentTime + durationPerImage - 0.1)}\n${block}\n\n`;
      currentTime += durationPerImage;
    });
    fs.writeFileSync(srtPath, srtContent);

    // 7. Assemblage final avec sous-titres
    console.log('Assemblage final…');
    const videoPath = path.join(tmpDir, 'video.mp4');

    const subtitleStyle = [
      'FontName=Arial', 'FontSize=18',
      'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H00000000',
      'BackColour=&H80000000', 'Bold=1', 'Outline=2',
      'Shadow=1', 'Alignment=2', 'MarginV=60',
    ].join(',');

    const srtPathEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatVideoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v libx264', '-preset ultrafast', '-crf 28',
          '-c:a aac', '-b:a 128k', '-pix_fmt yuv420p',
          '-shortest', '-movflags +faststart', '-threads 1',
          `-vf subtitles=${srtPathEscaped}:force_style='${subtitleStyle}'`,
        ])
        .output(videoPath)
        .on('start', () => console.log('ffmpeg final start'))
        .on('progress', p => console.log(`ffmpeg: ${p.percent?.toFixed(0)}%`))
        .on('end', () => { console.log('ffmpeg terminé ✓'); resolve(); })
        .on('error', err => { console.error('ffmpeg error:', err.message); reject(err); })
        .run();
    });

    console.log(`Vidéo assemblée (${Math.round(fs.statSync(videoPath).size / 1024)}KB)`);

    // 8. Upload YouTube
    console.log('Upload YouTube…');
    const videoBuffer = fs.readFileSync(videoPath);
    const metadata = {
      snippet: {
        title:           script.title,
        description:     (script.description || '') + '\n\n#Shorts',
        tags:            ['Shorts', ...(script.tags || []), ...(tags || [])],
        categoryId:      '22',
        defaultLanguage: 'fr',
      },
      status: { privacyStatus: 'public', madeForKids: false },
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
          'Authorization':  `Bearer ${ytToken}`,
          'Content-Type':   `multipart/related; boundary="${boundary}"`,
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

function formatSRTTime(seconds) {
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function splitIntoChunks(text, n) {
  const words     = text.split(' ');
  const chunkSize = Math.ceil(words.length / n);
  const chunks    = [];
  for (let i = 0; i < n; i++) {
    chunks.push(words.slice(i * chunkSize, (i + 1) * chunkSize).join(' '));
  }
  return chunks.filter(Boolean);
}

// ── AGENT IA ──────────────────────────────────────────────
const agentHistory = [];

app.post('/agent-run', async (req, res) => {
  const { topic, tags, geminiKey, anthropicKey } = req.body;

  const GEMINI = geminiKey    || process.env.GEMINI_API_KEY;
  const CLAUDE = anthropicKey || process.env.ANTHROPIC_API_KEY;

  if (!GEMINI || !CLAUDE)
    return res.status(400).json({ error: 'Clés API manquantes (Gemini, Anthropic)' });

  const iterationId = Date.now();
  const log = [];

  try {
    const lastGood   = agentHistory.filter(h => h.score >= 7).sort((a, b) => b.score - a.score)[0];
    const basePrompt = lastGood ? `Améliore ce prompt qui a obtenu ${lastGood.score}/10 : ${lastGood.narrationPrompt}` : null;
    log.push('Phase 1 : récupération du meilleur prompt ✓');

    // Phase 2 — Script
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
    const script = JSON.parse(scriptData.candidates?.[0]?.content?.parts?.[0]?.text.replace(/```json|```/g, '').trim());
    log.push('Phase 2 : script généré ✓');

    // Phase 3 — Voix edge-tts
    log.push('Phase 3 : génération voix edge-tts…');
    const tmpVoiceDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-voice-'));
    const voiceOutPath = path.join(tmpVoiceDir, 'voice.mp3');
    await generateVoiceEdgeTTS(script.narration, 'fr-FR-HenriNeural', voiceOutPath);
    const audioBase64 = fs.readFileSync(voiceOutPath).toString('base64');
    fs.rmSync(tmpVoiceDir, { recursive: true });
    log.push('Phase 3 : voix générée ✓');

    // Phase 4 — Images Reddit
    log.push('Phase 4 : recherche images Reddit…');
    const imageUrls = await fetchRedditImages(topic, 4);
    log.push(`Phase 4 : ${imageUrls.length} images Reddit ✓`);

    // Phase 5 — Frame pour analyse Claude
    log.push('Phase 5 : téléchargement frame…');
    let frameBase64 = null;
    try {
      const frameResp = await fetch(imageUrls[0], { timeout: 30000, headers: { 'User-Agent': 'AutoTube/1.0' } });
      if (frameResp.ok) {
        frameBase64 = (await frameResp.buffer()).toString('base64');
        log.push('Phase 5 : frame extraite ✓');
      }
    } catch (e) {
      log.push('Phase 5 : frame indisponible, analyse texte seule');
    }

    // Phase 6 — Analyse Claude
    log.push('Phase 6 : analyse qualité via Claude…');
    const claudeContent = [];
    if (frameBase64) claudeContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 } });
    claudeContent.push({
      type: 'text',
      text: `Tu es un expert YouTube Shorts. Analyse ce script et note sur 10.
Script : "${script.narration}"
Titre : "${script.title}"
Réponds UNIQUEMENT en JSON valide :
{"score":7,"criteres":{"impact_accroche":8,"rythme_narration":7,"qualite_visuelle":6,"retention_estimee":8,"coherence_yt":7},"points_forts":["point 1"],"ameliorations":["amélioration 1"]}`,
    });

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: claudeContent }] }),
    });
    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) throw new Error(claudeData.error?.message || 'Erreur Claude API');
    const analysis = JSON.parse(claudeData.content?.[0]?.text.replace(/```json|```/g, '').trim() || '{}');
    log.push(`Phase 6 : score ${analysis.score}/10 ✓`);

    // Phase 7 — Sauvegarde
    const iteration = {
      id: iterationId, date: new Date().toISOString(),
      topic, tags, script, audioBase64, imageUrls, analysis,
      score: analysis.score, narrationPrompt: script.narration,
      log, status: 'pending',
    };
    agentHistory.unshift(iteration);
    if (agentHistory.length > 20) agentHistory.pop();
    log.push('Phase 7 : itération sauvegardée ✓');

    res.json({ success: true, iteration });
  } catch (err) {
    console.error('Agent error:', err.message);
    res.status(500).json({ error: err.message, log });
  }
});

app.get('/agent-history', (req, res) => {
  res.json({ iterations: agentHistory, total: agentHistory.length });
});

app.post('/agent-validate', (req, res) => {
  const { id, action } = req.body;
  const iter = agentHistory.find(h => h.id === id);
  if (!iter) return res.status(404).json({ error: 'Itération non trouvée' });
  iter.status = action === 'validate' ? 'validated' : 'rejected';
  res.json({ success: true, iteration: iter });
});

function buildAgentPrompt(topic, tags, basePrompt) {
  const amelioration = basePrompt ? `\nUTILISE ce prompt et améliore-le : "${basePrompt}"\n` : '';
  return `Tu es un expert YouTube Shorts viral francophone.${amelioration}
Génère un script sur : "${topic}" — Tags : ${(tags || []).join(', ')}
RÈGLES : narration 40-50 mots, 4 blocs séparés par |, accroche choc bloc 1, twist bloc 3, chute mémorable bloc 4, vocabulaire français de France, JAMAIS de CTA.
Réponds UNIQUEMENT en JSON valide :
{"title":"Titre 40 chars","description":"2 phrases + #Shorts","tags":["Shorts","tag1"],"narration":"blocs séparés par |","imageSearchQueries":["query1","query2","query3","query4"],"thumbnailPrompt":"scène impactante"}`;
}

app.listen(PORT, () => {
  console.log(`AutoTube backend v13 — edge-tts FR + Reddit + Ken Burns — port ${PORT}`);
});
