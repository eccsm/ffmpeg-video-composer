'use strict';

const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;

const execAsync = promisify(exec);
const app = express();

// ---- Multer config ----
const upload = multer({
  dest: '/tmp/',
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB – biraz arttırdım
  },
});

// ---- Global timeouts ----
app.use((req, res, next) => {
  const timeoutMs = 300000; // 5 dakika
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);
  next();
});

// ---- CORS ----
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ---- Healthcheck ----
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FFmpeg Video Composer',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ---- Yardımcı: temp dosyaları sil ----
async function cleanupFiles(paths = []) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fs.unlink(p);
    } catch (err) {
      // dosya zaten silinmiş olabilir, logla geç
      console.error('Cleanup error for', p, err.message);
    }
  }
}

// ---- /compose endpoint ----
app.post(
  '/compose',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
    { name: 'subtitles', maxCount: 1 }, // ASS veya SRT
  ]),
  async (req, res) => {
    const startTime = Date.now();
    let videoPath;
    let audioPath;
    let subtitlesPath;
    let outputPath;

    try {
      console.log('=== NEW REQUEST ===');
      console.log('Files received:', {
        video: req.files?.video?.[0]?.size || 0,
        audio: req.files?.audio?.[0]?.size || 0,
        subtitles: req.files?.subtitles?.[0]?.size || 0,
      });

      if (!req.files?.video || !req.files?.audio) {
        console.error('Missing files!');
        return res.status(400).json({
          error: 'Missing video or audio file',
          received: Object.keys(req.files || {}),
        });
      }

      videoPath = req.files.video[0].path;
      audioPath = req.files.audio[0].path;
      if (req.files?.subtitles?.[0]) {
        subtitlesPath = req.files.subtitles[0].path;
      }
      outputPath = `/tmp/output_${Date.now()}.mp4`;

      const script = req.body.script || '';
      const quality = (req.body.quality || 'draft').toLowerCase();

      // ---- QUALITY PRESETS ----
      const videoPreset = quality === 'high' ? 'medium' : 'ultrafast';
      const videoCrf = quality === 'high' ? 20 : 28; // 20 = iyi kalite, 28 = hızlı / düşük kalite
      const audioBitrate = quality === 'high' ? '192k' : '128k';

      // ---- FILTER COMPLEX CHAIN ----
      let filterComplex =
        '[0:v]scale=1080:-2,setsar=1:1,boxblur=luma_radius=10:luma_power=1[bg];' +
        '[bg]crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[cv]';

      // currentLabel her adımda son video label'ı gösteriyor
      let currentLabel = '[cv]';

      // 1) Karaoke subtitles (ASS veya SRT)
      if (subtitlesPath) {
        const subsEscaped = subtitlesPath
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "'\\''");

        // subtitles filtresi: ASS içindeki karaoke efektlerini de uygular
        // not: charenc gerekiyorsa :charenc=UTF-8 eklenebilir
        filterComplex += `;${currentLabel}subtitles='${subsEscaped}'[subbed]`;
        currentLabel = '[subbed]';
        console.log('Subtitles filter enabled');
      } else {
        console.log('No subtitles file provided');
      }

      // 2) Script overlay (opsiyonel)
      if (script) {
        const scriptEscaped = script
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "'\\''")
          .replace(/\n/g, '\\n');

        filterComplex +=
          `;${currentLabel}drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
          `text='${scriptEscaped}':x=(w-text_w)/2:y=h-400:fontsize=56:fontcolor=white:` +
          `box=1:boxcolor=black@0.45:boxborderw=20:line_spacing=20[final]`;

        currentLabel = '[final]';
        console.log('Drawtext overlay enabled');
      } else {
        console.log('No script overlay');
      }

      // En son oluşan label bizim asıl videomuz
      const mapVideo = currentLabel;

      // ---- FFMPEG COMMAND ----
      const ffmpegCmd = [
        'ffmpeg',
        '-y',
        `-i "${videoPath}"`,
        `-i "${audioPath}"`,
        `-filter_complex "${filterComplex}"`,
        `-map ${mapVideo}`,
        '-map 1:a?', // audio yoksa hata vermesin
        '-c:v libx264',
        '-preset',
        videoPreset,
        '-crf',
        String(videoCrf),
        '-r',
        '30',
        '-c:a',
        'aac',
        '-b:a',
        audioBitrate,
        '-shortest',
        '-movflags',
        '+faststart',
        `"${outputPath}"`,
      ].join(' ');

      console.log('Starting FFmpeg...');
      console.log('FFmpeg command:\n', ffmpegCmd);

      const { stdout, stderr } = await execAsync(ffmpegCmd, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 240000,
      });

      console.log('FFmpeg completed in', Date.now() - startTime, 'ms');
      if (stdout) console.log('FFmpeg stdout (first 500):', stdout.slice(0, 500));
      if (stderr) console.log('FFmpeg stderr (first 500):', stderr.slice(0, 500));

      const stats = await fs.stat(outputPath);
      console.log('Output size:', stats.size, 'bytes');

      if (!stats.isFile() || stats.size === 0) {
        throw new Error('Output file is empty or missing');
      }

      // ---- RESPONSE ----
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="composed.mp4"',
      );

      const fileStream = require('fs').createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', async () => {
        console.log('File sent successfully');
        await cleanupFiles([videoPath, audioPath, subtitlesPath, outputPath]);
        console.log('Cleanup completed');
      });
    } catch (error) {
      console.error('=== ERROR ===');
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);

      await cleanupFiles([videoPath, audioPath, subtitlesPath, outputPath]);

      res.status(500).json({
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
  },
);

// ---- Server bootstrap & shutdown handling ----
console.log('🟦 Server starting...');
console.log('Node version:', process.version);
console.log('PWD:', process.cwd());
console.log('PORT:', process.env.PORT);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FFmpeg service running on port ${PORT}`);
  console.log('Memory on start:', process.memoryUsage());
});

process.on('SIGTERM', () => {
  console.log('⚠️  Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed, exiting.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('💥 Unhandled rejection:', reason);
});
