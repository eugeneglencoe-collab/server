// ============================================================
//  AutoTube — Backend Remotion
//  Assemblage vidéo (voix + images + sous-titres) → .mp4
//  Déployable gratuitement sur Render.com ou Railway
// ============================================================

const express = require('express');
const cors = require('cors');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS — autorise ton domaine GitHub Pages ───────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || '*',
  /^https:\/\/.*\.github\.io$/,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    const ok = ALLOWED_ORIGINS.some(o =>
      o === '*' || (o instanceof RegExp ? o.test(origin) : o === origin)
    );
    cb(ok ? null : new Error('CORS bloqué'), ok);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50mb' }));

// ── Dossier de sortie temporaire ──────────────────────────
const TMP_DIR = path.join(os.tmpdir(), 'autotube');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Health check ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AutoTube Remotion Backend',
    version: '1.0.0',
    endpoints: ['/health', '/render', '/status/:jobId', '/download/:jobId'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Store en mémoire (jobs en cours) ─────────────────────
const jobs = new Map();

// ── POST /render — Lance l'assemblage ────────────────────
//
//  Body attendu :
//  {
//    jobId: string,           // ID unique côté client
//    audioUrl: string,        // URL du fichier audio (ElevenLabs)
//    imageUrls: string[],     // URLs des images (Replicate)
//    script: string,          // Narration complète (pour sous-titres)
//    title: string,
//    durationSec: number,     // Durée totale en secondes
//    fps?: number,            // défaut 30
//  }
//
app.post('/render', async (req, res) => {
  const { jobId, audioUrl, imageUrls, script, title, durationSec, fps = 30 } = req.body;

  if (!jobId || !audioUrl || !imageUrls?.length) {
    return res.status(400).json({ error: 'jobId, audioUrl et imageUrls sont requis' });
  }

  // Répondre immédiatement — le rendu est asynchrone
  jobs.set(jobId, { status: 'queued', progress: 0, createdAt: Date.now() });
  res.json({ jobId, status: 'queued', message: 'Rendu démarré en arrière-plan' });

  // Lancer le rendu en arrière-plan
  renderVideo({ jobId, audioUrl, imageUrls, script, title, durationSec, fps })
    .catch(err => {
      console.error(`[${jobId}] Erreur rendu :`, err.message);
      jobs.set(jobId, { status: 'error', error: err.message, progress: 0 });
    });
});

// ── GET /status/:jobId — Statut du job ───────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  res.json(job);
});

// ── GET /download/:jobId — Télécharger le .mp4 ───────────
app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  if (job.status !== 'done') return res.status(409).json({ error: `Pas encore prêt (${job.status})` });

  const filePath = path.join(TMP_DIR, `${req.params.jobId}.mp4`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier manquant' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.jobId}.mp4"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── Fonction principale de rendu ─────────────────────────
async function renderVideo({ jobId, audioUrl, imageUrls, script, title, durationSec, fps }) {
  const outputPath = path.join(TMP_DIR, `${jobId}.mp4`);

  try {
    jobs.set(jobId, { status: 'bundling', progress: 5 });

    // 1. Bundle la composition Remotion
    const bundled = await bundle({
      entryPoint: path.resolve('./remotion/index.js'),
      webpackOverride: (config) => config,
    });

    jobs.set(jobId, { status: 'rendering', progress: 20 });

    // 2. Sélectionner la composition
    const composition = await selectComposition({
      serveUrl: bundled,
      id: 'AutoTubeVideo',
      inputProps: { audioUrl, imageUrls, script, title, durationSec, fps },
    });

    // 3. Rendre la vidéo
    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps: { audioUrl, imageUrls, script, title, durationSec, fps },
      onProgress: ({ progress }) => {
        jobs.set(jobId, { status: 'rendering', progress: Math.round(20 + progress * 75) });
      },
    });

    jobs.set(jobId, { status: 'done', progress: 100, outputPath });
    console.log(`[${jobId}] ✓ Vidéo générée : ${outputPath}`);

    // Nettoyage auto après 1h
    setTimeout(() => {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      jobs.delete(jobId);
    }, 60 * 60 * 1000);

  } catch (err) {
    jobs.set(jobId, { status: 'error', error: err.message, progress: 0 });
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`\n🚀 AutoTube Remotion Backend démarré sur http://localhost:${PORT}`);
  console.log(`   Dossier tmp : ${TMP_DIR}\n`);
});
