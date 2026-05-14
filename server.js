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
  res.json({ status: 'AutoTube backend running ✓', version: '14.0.0' });
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
  const subreddits  = getSubredditsForTopic(topic);
  const imageUrls   = [];
  const usedUrls    = new Set();
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

app.post('/fetch-reddit-video', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 secondes max
    
    const response = await fetch(`https://www.reddit.com/r/KidsAreFuckingStupid/search.json?q=${encodeURIComponent(topic)}&restrict_sr=1&sort=hot&limit=100`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 AutoTube/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Statut ${response.status} - ${text.substring(0, 100)}`);
    }

    const data = await response.json();
    const posts = data.data?.children || [];
    const videoPosts = posts.filter(p => p.data.is_video && p.data.media?.reddit_video?.fallback_url);
    
    if (videoPosts.length === 0) {
      return res.status(404).json({ error: 'Aucune vidéo trouvée sur Reddit. Astuce : utilise un mot-clé très court et en ANGLAIS (ex: "funny dog", "fail compilation", "dashcam")' });
    }
    
    const post = videoPosts[Math.floor(Math.random() * videoPosts.length)].data;
    res.json({
      title: post.title,
      videoUrl: post.media.reddit_video.fallback_url
    });
  } catch (err) {
    console.error('Reddit video fetch error:', err.message);
    res.status(500).json({ error: err.name === 'AbortError' ? 'La recherche Reddit a pris trop de temps (Timeout)' : err.message });
  }
});

// ── GEMINI — Génération de script SHORTS ─────────────────
app.post('/generate-script', async (req, res) => {
  const { topic, tags, duration, apiKey, customPrompt, mode } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic manquant' });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'Clé Gemini manquante' });

  let prompt = '';
  
  if (mode === '2') {
    prompt = `Tu es un expert en création de contenu YouTube Shorts de réaction (react) francophone viral.

Génère un commentaire hilarant ou fascinant pour un YouTube Short. 
Sujet / Titre de la vidéo originale trouvée sur Reddit : "${topic}"
Niche / Tags : ${(tags||[]).join(', ')}

RÉTENTION — RÈGLES CRITIQUES :
- La première phrase doit agir comme un "hook" de réaction (ex: "Attendez de voir ce qu'il se passe à la fin", "Je n'étais pas prêt pour ça").
- Ton très dynamique, amusé ou choqué, comme un vrai streamer ou réacteur YouTube.
- Vocabulaire 100% français de France métropolitaine, moderne, fluide.
- Longueur totale : 40 à 60 mots.
- Ne sépare pas par des blocs, écris juste un seul texte fluide.

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après :
{
  "title": "Titre 40 chars max, accrocheur, crée de la curiosité, sans hashtag",
  "description": "2 phrases percutantes + hashtags #Shorts #[niche]",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "Texte complet du commentaire de 40-60 mots sans séparateurs"
}`;
  } else {
    const defaultRules = `- La première phrase doit créer une TENSION IMMÉDIATE — une promesse, un mystère, une contradiction choquante
- Chaque bloc doit se terminer sur une micro-tension qui force à rester
- Ton fascinant, naturel et immersif : écris comme un excellent conteur sur YouTube qui raconte une histoire captivante.
- Vocabulaire 100% français de France métropolitaine : phrases fluides et bien construites — JAMAIS de québécismes
- Zéro mot de remplissage : chaque mot doit justifier sa présence
- Construire vers un twist ou révélation finale surprenante`;

    const rules = customPrompt || defaultRules;

    prompt = `Tu es un expert en création de contenu YouTube Shorts francophone viral, spécialisé dans la maximisation de la rétention d'audience.

Génère un script pour un YouTube Short sur : "${topic}"
Niche / Tags : ${(tags||[]).join(', ')}

RÉTENTION — RÈGLES CRITIQUES :
${rules}

NARRATION :
- Environ 60 à 80 mots au total pour laisser l'histoire respirer.
- 4 blocs séparés par | , un bloc par image, environ 15-20 mots par bloc.
- Bloc 1 : accroche choc — fait contre-intuitif ou question rhétorique percutante
- Bloc 2 : développement qui creuse la tension, révèle quelque chose d'inattendu
- Bloc 3 : twist ou fait clé qui renverse ce qu'on croyait savoir
- Bloc 4 : chute mémorable, percutante — laisse une impression durable
- JAMAIS "Abonne-toi", "Commente", "Partage"

MOTS-CLÉS REDDIT :
- Génère 4 requêtes de recherche en anglais pour trouver des images Reddit en lien avec chaque bloc
- Chaque requête = 2-3 mots précis qui décrivent visuellement le contenu du bloc de la meilleure façon possible

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après :
{
  "title": "Titre 40 chars max, accrocheur, crée de la curiosité, sans hashtag",
  "description": "2 phrases percutantes + hashtags #Shorts #[niche]",
  "tags": ["Shorts", "tag1", "tag2", "tag3"],
  "narration": "40-50 mots, 4 blocs séparés par | , rythme haché, vocabulaire français de France",
  "imageSearchQueries": ["query bloc 1 en anglais", "query bloc 2", "query bloc 3", "query bloc 4"],
  "thumbnailPrompt": "description visuelle de la scène la plus impactante pour la miniature"
}`;
  }

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

// ── EDGE TTS — Synthèse vocale gratuite ────────────────
app.post('/generate-voice', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text manquant' });

  try {
    const { EdgeTTS } = require('node-edge-tts');
    const tts = new EdgeTTS({ voice: 'fr-FR-HenriNeural', lang: 'fr-FR' });
    const tmpPath = path.join(os.tmpdir(), `edge_tts_${Date.now()}.mp3`);
    
    await tts.ttsPromise(text, tmpPath);
    
    const audioBuffer = fs.readFileSync(tmpPath);
    const audioBase64 = audioBuffer.toString('base64');
    fs.unlinkSync(tmpPath);

    res.json({ audioBase64, mimeType: 'audio/mpeg' });
  } catch (err) {
    console.error('EdgeTTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── QUOTA TTS (Edge TTS est illimité) ──────────────────────
app.get('/elevenlabs-quota', async (req, res) => {
  res.json({ used: 0, total: 999999, reset: null });
});

// ── ASSEMBLAGE VIDÉO + UPLOAD YOUTUBE ────────────────────
app.post('/assemble-and-publish', async (req, res) => {
  const { imageUrls, videoUrl, audioBase64, audioUrl, script, tags, ytToken } = req.body;
  if (!imageUrls?.length && !videoUrl) return res.status(400).json({ error: 'imageUrls ou videoUrl manquants' });
  if (!audioBase64 && !audioUrl)       return res.status(400).json({ error: 'audio manquant' });
  if (!ytToken)                        return res.status(400).json({ error: 'token YouTube manquant' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotube-'));

  try {
    let concatVideoPath;
    let durationPerImage = 0;
    const fps = 24;
    const audioPath = path.join(tmpDir, 'audio.mp3');

    // 1. Préparer l'audio
    console.log('Préparation audio…');
    if (audioBase64) {
      fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
    } else {
      const audioResp = await fetch(audioUrl, { timeout: 30000 });
      fs.writeFileSync(audioPath, await audioResp.buffer());
    }
    const audioDuration = await getAudioDuration(audioPath);

    if (videoUrl) {
      // MODE 2 : Vidéo Reddit
      console.log('Mode 2: Téléchargement vidéo Reddit...');
      const vidResp = await fetch(videoUrl, { timeout: 30000 });
      if (!vidResp.ok) throw new Error('Vidéo Reddit inaccessible');
      concatVideoPath = path.join(tmpDir, 'raw_reddit.mp4');
      fs.writeFileSync(concatVideoPath, await vidResp.buffer());

      // TENTATIVE RÉCUPÉRATION AUDIO REDDIT (souvent séparé)
      try {
        const audioUrlReddit = videoUrl.replace(/DASH_[0-9]+\.mp4/, 'DASH_audio.mp4').split('?')[0];
        console.log(`Tentative téléchargement audio Reddit : ${audioUrlReddit}`);
        const audResp = await fetch(audioUrlReddit, { timeout: 10000 });
        if (audResp.ok) {
          const redditAudioPath = path.join(tmpDir, 'reddit_audio.mp3');
          fs.writeFileSync(redditAudioPath, await audResp.buffer());
          const mergedPath = path.join(tmpDir, 'merged_reddit.mp4');
          console.log('Fusion vidéo + audio Reddit…');
          await new Promise((resolve) => {
            ffmpeg()
              .input(concatVideoPath)
              .input(redditAudioPath)
              .outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0', '-shortest'])
              .output(mergedPath)
              .on('end', () => { concatVideoPath = mergedPath; resolve(); })
              .on('error', (err) => { console.log('Echec fusion audio Reddit:', err.message); resolve(); })
              .run();
          });
        } else {
          console.log('Pas d\'audio séparé trouvé pour cette vidéo Reddit.');
        }
      } catch (e) {
        console.log('Erreur lors de la récupération audio Reddit:', e.message);
      }

      durationPerImage = audioDuration; // 1 bloc logique
    } else {
      // MODE 1 : Images Ken Burns
      console.log(`Mode 1: Téléchargement de ${imageUrls.length} images…`);
      const imagePaths = [];
      for (let i = 0; i < imageUrls.length; i++) {
        let imgBuffer = null;
        for (const url of [imageUrls[i], `https://picsum.photos/seed/${Date.now() + i}/768/1344`]) {
          try {
            const imgResp = await fetch(url, { timeout: 30000, headers: { 'User-Agent': 'AutoTube/1.0' } });
            if (imgResp.ok) { imgBuffer = await imgResp.buffer(); break; }
          } catch (e) {}
        }
        if (!imgBuffer) throw new Error(`Image ${i+1} introuvable`);
        const rawPath = path.join(tmpDir, `raw_${i}.jpg`);
        const imgPath = path.join(tmpDir, `img_${i}.jpg`);
        fs.writeFileSync(rawPath, imgBuffer);
        await new Promise((resolve, reject) => {
          ffmpeg().input(rawPath).outputOptions(['-vf scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1', '-q:v 2']).output(imgPath).on('end', resolve).on('error', reject).run();
        });
        imagePaths.push(imgPath);
      }

      durationPerImage = audioDuration / imagePaths.length;
      console.log(`Génération Ken Burns… (${durationPerImage.toFixed(2)}s/image)`);
      const clipPaths = [];
      const kenBurnsEffects = [
        (f) => `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
        (f) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,x+1)':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
        (f) => `zoompan=z='if(lte(zoom,1.0),1.3,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='0':d=${f}:s=720x1280:fps=${fps}`,
        (f) => `zoompan=z='min(zoom+0.001,1.2)':x='if(gte(zoom,1.2),x,max(x-1,0))':y='ih/2-(ih/zoom/2)':d=${f}:s=720x1280:fps=${fps}`,
      ];

      for (let i = 0; i < imagePaths.length; i++) {
        const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
        const frames = Math.ceil(durationPerImage * fps);
        const zoomFilter = kenBurnsEffects[i % kenBurnsEffects.length](frames);
        await new Promise((resolve, reject) => {
          ffmpeg().input(imagePaths[i]).inputOptions(['-loop 1']).outputOptions([`-t ${durationPerImage.toFixed(3)}`, '-c:v libx264', '-preset ultrafast', '-crf 28', '-pix_fmt yuv420p', `-r ${fps}`, `-vf ${zoomFilter},setsar=1`, '-threads 1', '-an']).output(clipPath).on('end', resolve).on('error', reject).run();
        });
        clipPaths.push(clipPath);
      }

      console.log('Concaténation…');
      const concatPath = path.join(tmpDir, 'concat.txt');
      concatVideoPath = path.join(tmpDir, 'concat_video.mp4');
      fs.writeFileSync(concatPath, clipPaths.map(p => `file '${p}'`).join('\n'));
      await new Promise((resolve, reject) => {
        ffmpeg().input(concatPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c:v libx264', '-preset ultrafast', '-crf 28', '-pix_fmt yuv420p', '-an', '-threads 1']).output(concatVideoPath).on('end', resolve).on('error', reject).run();
      });
    }

    // 2. SRT
    console.log('Génération SRT…');
    const srtPath = path.join(tmpDir, 'subtitles.srt');
    const narration = script.narration || '';
    
    let subtitleBlocks;
    if (videoUrl) {
      subtitleBlocks = splitIntoWordChunks(narration, 5); // 5-6 words per block
    } else {
      const blocks = narration.split('|').map(b => b.trim()).filter(Boolean);
      subtitleBlocks = blocks.length >= 2 ? blocks : splitIntoWordChunks(narration, 5);
    }
    
    const blockDuration = audioDuration / subtitleBlocks.length;
    
    let srtContent = '';
    let currentTime = 0;
    subtitleBlocks.forEach((block, i) => {
      srtContent += `${i + 1}\n${formatSRTTime(currentTime)} --> ${formatSRTTime(currentTime + blockDuration - 0.05)}\n${block}\n\n`;
      currentTime += blockDuration;
    });
    fs.writeFileSync(srtPath, srtContent);

    // 3. Assemblage final
    console.log('Assemblage final (avec son source + musique)…');
    const videoPath = path.join(tmpDir, 'video.mp4');

    const bgmPath = path.join(tmpDir, 'bgm.mp3');
    try {
      const bgmUrl = 'https://freepd.com/music/Lofi%20Hiphop%2002.mp3';
      const bgmResp = await fetch(bgmUrl, { timeout: 15000 });
      if (bgmResp.ok) {
        const buffer = await bgmResp.buffer();
        fs.writeFileSync(bgmPath, buffer);
        console.log(`BGM téléchargé : ${bgmUrl} (${Math.round(buffer.length/1024)}KB)`);
      } else {
        console.log('Erreur téléchargement BGM:', bgmResp.status);
      }
    } catch (e) {
      console.log('Musique non téléchargée, on continue sans', e.message);
    }

    const hasAudio = await hasAudioStream(concatVideoPath);
    console.log(`Vidéo source a de l'audio : ${hasAudio}`);

    const subtitleStyle = [
      'FontName=Arial', 'FontSize=10', 'PrimaryColour=&H0000FFFF', 'OutlineColour=&H00000000',
      'BackColour=&H80000000', 'Bold=1', 'Outline=3', 'Shadow=2', 'Alignment=2', 'MarginV=35', 'MarginL=40', 'MarginR=40',
    ].join(',');
    const srtPathEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((resolve, reject) => {
      let f = ffmpeg().input(concatVideoPath); // input 0
      if (videoUrl) f = f.inputOptions(['-stream_loop -1']); // boucle si vidéo trop courte
      
      let vfFilter = videoUrl 
        ? `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,subtitles=${srtPathEscaped}:force_style='${subtitleStyle}'`
        : `subtitles=${srtPathEscaped}:force_style='${subtitleStyle}'`;

      f.input(audioPath); // input 1
      
      let filterComplex = '';
      let inputs = [];

      // Format commun pour éviter les bugs amix
      const format = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';

      // Voix (toujours présente)
      filterComplex += `[1:a]volume=1.0,${format}[v_voice];`;
      inputs.push('[v_voice]');

      // Son source (Reddit ou images Ken Burns)
      if (hasAudio) {
        filterComplex += `[0:a]volume=0.4,${format}[v_source];`;
        inputs.push('[v_source]');
      }

      // Musique
      const hasBgm = fs.existsSync(bgmPath) && fs.statSync(bgmPath).size > 1000;
      if (hasBgm) {
        f.input(bgmPath).inputOptions(['-stream_loop -1']); // input 2, bouclée
        filterComplex += `[2:a]volume=0.25,${format}[v_bgm];`;
        inputs.push('[v_bgm]');
      }

      filterComplex += `${inputs.join('')}amix=inputs=${inputs.length}:duration=shortest:dropout_transition=3[aout]`;

      let outputOptions = [
        '-c:v libx264', '-preset ultrafast', '-crf 28',
        '-c:a aac', '-b:a 128k', '-pix_fmt yuv420p',
        '-shortest', '-movflags +faststart', '-threads 1',
        `-vf ${vfFilter}`,
        '-filter_complex', filterComplex,
        '-map', '0:v:0',
        '-map', '[aout]'
      ];

      f.outputOptions(outputOptions)
        .output(videoPath)
        .on('start', (cmd) => {
          console.log('FFmpeg final command:', cmd);
        })
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

function splitIntoWordChunks(text, wordsPerChunk = 5) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  return chunks;
}

function hasAudioStream(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return resolve(false);
      const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
      resolve(hasAudio);
    });
  });
}

// ── AGENT IA ──────────────────────────────────────────────
const agentHistory = [];

app.post('/agent-run', async (req, res) => {
  const { topic, tags, geminiKey, elevenKey, anthropicKey } = req.body;

  const GEMINI  = geminiKey    || process.env.GEMINI_API_KEY;
  const ELEVEN  = elevenKey    || process.env.ELEVENLABS_API_KEY;
  const CLAUDE  = anthropicKey || process.env.ANTHROPIC_API_KEY;

  if (!GEMINI || !ELEVEN || !CLAUDE)
    return res.status(400).json({ error: 'Clés API manquantes (Gemini, ElevenLabs, Anthropic)' });

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

    // Phase 3 — Voix Edge TTS
    log.push('Phase 3 : génération voix Edge TTS…');
    const { EdgeTTS } = require('node-edge-tts');
    const tts = new EdgeTTS({ voice: 'fr-FR-HenriNeural', lang: 'fr-FR' });
    const tmpPath = path.join(os.tmpdir(), `edge_tts_agent_${Date.now()}.mp3`);
    await tts.ttsPromise(script.narration, tmpPath);
    const audioBase64 = fs.readFileSync(tmpPath).toString('base64');
    fs.unlinkSync(tmpPath);
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
    } catch { log.push('Phase 5 : frame indisponible'); }

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
  return `Tu es un expert YouTube Shorts viral francophone et un excellent conteur d'histoires.${amelioration}
Génère un script sur : "${topic}" — Tags : ${(tags || []).join(', ')}
RÈGLES : narration fluide et captivante de 60-80 mots, 4 blocs de 15-20 mots séparés par |, accroche choc bloc 1, twist bloc 3, chute mémorable bloc 4, vocabulaire français de France, JAMAIS de CTA.
Réponds UNIQUEMENT en JSON valide :
{"title":"Titre 40 chars","description":"2 phrases + #Shorts","tags":["Shorts","tag1"],"narration":"blocs séparés par |","imageSearchQueries":["query1","query2","query3","query4"],"thumbnailPrompt":"scène impactante"}`;
}

app.listen(PORT, () => {
  console.log(`AutoTube backend v14 — ElevenLabs FR + Reddit + Ken Burns — port ${PORT}`);
});
